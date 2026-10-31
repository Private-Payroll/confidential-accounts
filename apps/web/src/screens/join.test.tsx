// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { anInvitation, offerAnswer, PUBLIC_ADDRESS, refusedAnswer, type Invitation } from '../adapters/join-offers.test-support.js';
import { untilShown } from '../page-shown.test-support.js';

/*
 * THE JOIN PAGE, /join/:id. The invitation the link carried is held in memory (the router's own store) and real sealed
 * offers are opened by the device's own check; only the service's answer to the read of the offer, the wallet's windows
 * and the sign-in are stood in. Each kind and way is joined in a page test, and the page forgets the link when the person
 * has joined or left.
 */
const wallet = vi.hoisted(() => ({
  signedIn: true, act: vi.fn(), joinByCode: vi.fn(), signIn: vi.fn(),
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  ACCOUNT_ORIGIN: 'https://wallet.example',
  signIn: wallet.signIn,
}));
vi.mock('../adapters/keyring-person.js', () => ({ keyringFor: async () => wallet.signedIn }));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  actOnACompanyInTheWallet: wallet.act,
}));
vi.mock('vaults-web-shared/join-in-the-wallet.js', () => ({ joinByCodeInTheWallet: wallet.joinByCode }));

const { Join } = await import('./join.js');
const { CurrentPageProvider, forgetLink, holdLink, useHeldLink } = await import('../router.js');
const { SessionProvider } = await import('../session.js');
const { VisitorProvider } = await import('../visitor.js');
const { DEFAULT_PREFERENCES } = await import('../preferences.js');
const { VIEWS } = await import('../pages.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const EN = JSON.parse(readFileSync(`${dirname(fileURLToPath(import.meta.url))}/../locales/en.json`, 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });

const asked: string[] = [];
const serve = (answer: () => Response): void => {
  asked.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { asked.push(path); return answer(); }));
};
const signedInNow = vi.fn(async () => {});
const companiesChanged = vi.fn(async () => {});
const session = () => ({
  person: { id: 'u1', name: 'Priya' }, companies: [], company: null, chooseCompany: vi.fn(),
  viewer: { signedIn: true, view: VIEWS.employee, signs: false }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
  choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged,
});

/** The page for `i`, with its link held as the router holds it, drawn for a signed-in person or a visitor. */
function draw(i: Invitation, as: 'member' | 'visitor', hold = true) {
  if (hold) holdLink(`/join/${i.id}`, `#${i.token}`);
  const page = <CurrentPageProvider id="join" params={{ id: i.id }}><Join /></CurrentPageProvider>;
  return render(
    <KitProvider languages={LANGUAGES} pick="en">
      {as === 'member' ? <SessionProvider session={session()}>{page}</SessionProvider> : <VisitorProvider signedInNow={signedInNow}>{page}</VisitorProvider>}
    </KitProvider>,
  );
}
const on = (c: HTMLElement, sel: string): HTMLElement | null => c.querySelector<HTMLElement>(sel);
const shown = (c: HTMLElement, sel: string) => untilShown(() => on(c, sel), sel);
const press = async (c: HTMLElement, action: string): Promise<void> => {
  const b = await shown(c, `[data-action=${action}]:not([disabled])`);
  await act(async () => { fireEvent.click(b); });
};
const heldFor = (id: string): string => {
  function Probe() { return <p data-held={useHeldLink(id) ?? 'nothing'} />; }
  const { container } = render(<Probe />);
  const v = container.querySelector('[data-held]')!.getAttribute('data-held')!;
  return v;
};
const text = (c: HTMLElement): string => c.textContent ?? '';

beforeEach(() => {
  forgetLink(); window.history.replaceState(null, '', '/');
  wallet.signedIn = true; wallet.act.mockReset(); wallet.joinByCode.mockReset(); wallet.signIn.mockReset(); signedInNow.mockClear(); companiesChanged.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the join page opens an invitation and says what it is', () => {
  /* RED WHEN: a page opened without the token held asks the service for anything, or does not say to open the whole link. */
  it('asks for the whole link when none is held, and sends nothing', async () => {
    const i = anInvitation('employee');
    serve(() => offerAnswer(i));
    const { container } = draw(i, 'member', false);
    await shown(container, '[data-join-card=no-token]');
    expect(text(container)).toContain('Open the whole link');
    expect(asked).toEqual([]);
  });

  /* RED WHEN: a visitor is offered Accept, or is not offered the sign-in, or the offer's facts are not shown, or the token is sent. */
  it('shows a visitor the offer with the sign-in, never the accept, and sends no token', async () => {
    const i = anInvitation('employee');
    serve(() => offerAnswer(i));
    const { container } = draw(i, 'visitor');
    await shown(container, '[data-offer-facts]');
    const t = text(container);
    expect(t).toContain('Acme Studio invited you');
    expect(t).toContain('Priya Rao');
    expect(t).toContain('Engineer');
    expect(t).toMatch(/Oct.*2026|2026/u);
    expect(on(container, '[data-action=sign-in]')).not.toBeNull();
    expect(on(container, '[data-action=sign-in]')?.textContent).toBe('Sign in');
    expect(t).toContain('Signing in accepts nothing');
    expect(t).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(on(container, '[data-site]')?.textContent).toBe('Private Vaults');
    expect(on(container, '[data-visitor-join]')?.className).toContain('items-center');
    expect(on(container, '[data-action=accept]')).toBeNull();
    expect(asked).toEqual([`/api/invites/${i.id}/offer`]);
    expect(asked.join()).not.toContain(i.token);
    expect(wallet.act).not.toHaveBeenCalled();
  });

  /* RED WHEN: a long address is not allowed to break, so it is cut off at a narrow width instead of being read whole. */
  it('lets a long address wrap, whole, in its row', async () => {
    const i = anInvitation('vendor', { address: PUBLIC_ADDRESS });
    serve(() => offerAnswer(i));
    const { container } = draw(i, 'member');
    await shown(container, '[data-offer-facts]');
    const span = on(container, '[data-offer-facts] .font-mono') as HTMLElement;
    expect(span.textContent).toBe(PUBLIC_ADDRESS);
    expect(span.className).toContain('break-all');
  });

  /* RED WHEN: pressing Sign in does not start the sign-in, or does not tell the app the person signed in, or hides a refusal. */
  it('signs a visitor in from the page, and shows a refusal of the sign-in', async () => {
    const i = anInvitation('signer');
    serve(() => offerAnswer(i));
    const { container } = draw(i, 'visitor');
    wallet.signIn.mockResolvedValueOnce({ of: 'refused', why: 'declined', retryAfterSeconds: null });
    await press(container, 'sign-in');
    await shown(container, '[data-refusal=declined]');
    wallet.signIn.mockResolvedValueOnce({ of: 'signed-in', person: { id: 'u1' }, firstTime: false });
    await press(container, 'sign-in');
    await act(async () => {});
    expect(wallet.signIn).toHaveBeenCalledTimes(2);
    expect(signedInNow).toHaveBeenCalledTimes(1);
  });

  /* RED WHEN: an expired link is shown in the device's English or with a UTC moment, or without the page's words, its local time and its zone, or a member has no way home. */
  it('says an expired link expired, at a local time with its zone, and offers a way home', async () => {
    const i = anInvitation('employee', { expiresInMs: -3600_000 });
    serve(() => offerAnswer(i));
    const { container } = draw(i, 'member');
    await shown(container, '[data-join-card=closed]');
    const t = text(container);
    expect(t).toContain('This invitation expired at');
    expect(t).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(t).not.toMatch(/could not be opened|Nothing was sent\. Ask whoever invited you for a new link|\d{4}-\d\d-\d\dT/u);
    expect(on(container, '[data-action=go-on]')).not.toBeNull();
  });

  /* RED WHEN: a super admin's or a re-issued invitation is closed without saying what to do, or a re-issue gets the words of a signer invited another way. */
  it('tells a super admin\'s and a re-issued invitation what to do, each in its own words', async () => {
    const a = anInvitation('super-admin');
    serve(() => offerAnswer(a));
    const sa = draw(a, 'member');
    await shown(sa.container, '[data-join-card=closed]');
    expect(text(sa.container)).toContain('Ask whoever invited you to take this to the company\'s super admins');
    cleanup();
    const r = anInvitation('reissue');
    serve(() => offerAnswer(r));
    const re = draw(r, 'member');
    await shown(re.container, '[data-join-card=closed]');
    expect(text(re.container)).toContain('re-issued invitation');
    expect(text(re.container)).not.toContain('private address');
  });

  /* RED WHEN: a closed invitation is shown as offered, or its reason is not in the page's words, or an unreachable service has no way to try again. */
  it('says why an invitation cannot be used', async () => {
    const i = anInvitation('employee');
    serve(() => refusedAnswer(410, 'used'));
    const used = draw(i, 'member');
    await shown(used.container, '[data-join-card=closed]');
    expect(text(used.container)).toContain('already been accepted');
    expect(on(used.container, '[data-action=accept]')).toBeNull();
    cleanup();
    serve(() => { throw new TypeError('network'); });
    const down = draw(i, 'member');
    await shown(down.container, '[data-action=try-again]');
    expect(text(down.container)).toContain('could not be reached');
  });
});

describe('each kind and way is joined from the page', () => {
  /* RED WHEN: a signer's press does not run seat-invited with the offer's four fields, or the page does not say a signer must still be admitted, or keeps the link. */
  it('joins a signer: seat-invited, then the waiting-for-admission words, and the link is forgotten', async () => {
    const i = anInvitation('signer');
    serve(() => offerAnswer(i));
    wallet.act.mockResolvedValue({ of: 'done', steps: 2, relayed: 1 });
    const { container } = draw(i, 'member');
    await shown(container, '[data-way=seat]');
    expect(text(container)).toContain('Approver');
    expect(heldFor(i.id)).toBe(i.token);
    await press(container, 'accept');
    await shown(container, '[data-join-card=done]');
    expect(wallet.act.mock.calls[0]![0]).toMatchObject({ name: 'seat-invited', token: i.token });
    expect(Object.keys(wallet.act.mock.calls[0]![0]).sort()).toEqual(['account', 'company', 'name', 'record', 'token']);
    expect(text(container)).toContain('Finish adding');
    expect(text(container)).toContain('you are waiting');
    expect(on(container, '[data-join-card=done] p, [data-join-card=done] div')?.textContent).not.toContain('accepted the invitation');
    expect(text(container)).toContain('You are not a signer yet');
    expect(text(container)).not.toContain('has taken your seat');
    expect(heldFor(i.id)).toBe('nothing');
    expect(wallet.joinByCode).not.toHaveBeenCalled();
  });

  /* RED WHEN: an employee's press does not run join-by-code, or the page does not tell the person to read out the fingerprint the wallet showed, or shows a payslips link. */
  it('joins an employee by code: join-by-code, the fingerprint is the wallet\'s to show, and no link is offered', async () => {
    const i = anInvitation('employee');
    serve(() => offerAnswer(i));
    wallet.joinByCode.mockResolvedValue({ of: 'done', steps: 1, relayed: 1 });
    const { container } = draw(i, 'member');
    await shown(container, '[data-way=code]');
    expect(text(container)).toContain('shows a fingerprint in its own window');
    await press(container, 'accept');
    await shown(container, '[data-join-card=done]');
    expect(wallet.joinByCode.mock.calls[0]![0]).toMatchObject({ token: i.token });
    expect(wallet.act).not.toHaveBeenCalled();
    expect(text(container)).toContain('Read it out to whoever invited you');
    expect(text(container)).toContain('in its own window while it joined');
    expect(text(container)).toContain('The fingerprint is shown once. If you missed it, tell whoever invited you; they invite you again.');
    expect(text(container)).not.toContain('open the link you were sent again');
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(text(container)).not.toMatch(/payslips|another device|VITE_/iu);
    expect(heldFor(i.id)).toBe('nothing');
  });

  /* RED WHEN: a vendor at a public address does not claim that address, or is told a fingerprint exists for it. */
  it('joins a vendor by claim: claim-by-address with the public address, and no fingerprint', async () => {
    const i = anInvitation('vendor', { address: PUBLIC_ADDRESS });
    serve(() => offerAnswer(i));
    wallet.act.mockResolvedValue({ of: 'done', steps: 1, relayed: 1 });
    const { container } = draw(i, 'member');
    await shown(container, '[data-way=claim]');
    expect(text(container)).toContain(PUBLIC_ADDRESS);
    await press(container, 'accept');
    await shown(container, '[data-join-card=done]');
    expect(wallet.act.mock.calls[0]![0]).toMatchObject({ name: 'claim-by-address', address: PUBLIC_ADDRESS, token: i.token });
    expect(text(container)).toContain('There is no fingerprint to read out');
    expect(wallet.joinByCode).not.toHaveBeenCalled();
    expect(heldFor(i.id)).toBe('nothing');
  });
});

describe('what the page does when the act does not finish', () => {
  /* RED WHEN: a stop is shown as joined, hides the wallet's reason, forgets the link, or cannot be pressed again when pressing again can mend it. */
  it('shows a stop with its words, keeps the link, and goes on when pressed again', async () => {
    const i = anInvitation('employee');
    serve(() => offerAnswer(i));
    wallet.joinByCode.mockResolvedValueOnce({ of: 'stopped', step: 1, steps: 2, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.join-by-code.why.not-taken' });
    const { container } = draw(i, 'member');
    await press(container, 'accept');
    await shown(container, '[data-stopped]');
    expect(text(container)).toContain('step 1 of 2');
    expect(heldFor(i.id)).toBe(i.token);
    expect((on(container, '[data-action=accept]') as HTMLButtonElement).disabled).toBe(false);
    wallet.joinByCode.mockResolvedValueOnce({ of: 'done', steps: 2, relayed: 1 });
    await press(container, 'accept');
    await shown(container, '[data-join-card=done]');
    expect(wallet.joinByCode).toHaveBeenCalledTimes(2);
    expect(heldFor(i.id)).toBe('nothing');
  });

  /* RED WHEN: a claim join that the company did not take is told to read out a fingerprint that was never shown, or a code join loses that sentence. */
  it('tells a claim join and a code join their own words when the company did not take them', async () => {
    const claim = anInvitation('vendor', { address: PUBLIC_ADDRESS });
    serve(() => offerAnswer(claim));
    wallet.act.mockResolvedValueOnce({ of: 'stopped', step: 1, steps: 2, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.claim-by-address.why.not-taken' });
    const first = draw(claim, 'member');
    await press(first.container, 'accept');
    await shown(first.container, '[data-stopped=not-taken]');
    expect(text(first.container)).toContain(EN['join.stopped.notTakenClaim']);
    expect(text(first.container)).not.toMatch(/fingerprint your wallet showed/);
    cleanup();
    const code = anInvitation('employee');
    serve(() => offerAnswer(code));
    wallet.joinByCode.mockResolvedValueOnce({ of: 'stopped', step: 1, steps: 2, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.join-by-code.why.not-taken' });
    const second = draw(code, 'member');
    await press(second.container, 'accept');
    await shown(second.container, '[data-stopped=not-taken]');
    expect(text(second.container)).toContain(EN['join.stopped.notTaken']);
    expect(text(second.container)).toContain('fingerprint your wallet showed');
  });

  /* RED WHEN: a stop after the wallet handed over transactions (sent, or not confirmed) says the proof did not reach the network or that nothing was sent; or a stop that handed over none loses its own words. */
  it('says the proof may already have been sent, and to wait and open the link again, when the wallet handed it over before it stopped', async () => {
    for (const [relayed, unconfirmed, handed] of [[0, 1, true], [1, 0, true], [0, 0, false]] as const) {
      const i = anInvitation('signer');
      serve(() => offerAnswer(i));
      wallet.act.mockResolvedValueOnce({ of: 'stopped', step: 3, steps: 4, relayed, unconfirmed, why: 'relay-refused', refused: 'act.seat-invited.why.not-sent' });
      const { container } = draw(i, 'member');
      await press(container, 'accept');
      await shown(container, '[data-stopped=not-sent]');
      const words = text(container);
      expect(words.includes(EN['join.stopped.sent']!), `${relayed}/${unconfirmed}`).toBe(handed);
      expect(words.includes(EN['join.stopped.notSent']!), `${relayed}/${unconfirmed}`).toBe(!handed);
      cleanup();
    }
    expect(EN['join.stopped.sent']).toMatch(/may already have been sent.*Wait a few minutes and open the link again before you press the button again/);
  });

  /* RED WHEN: the stop for a read the wallet could not make says the company has no place, the stop for the wallet's own seats used up says the company has none, or the stop for a seat closed under other keys says another invitation took it. */
  it('says what the wallet found for no places read, no seat of its own left, and a seat taken by other keys', () => {
    expect(EN['join.stopped.noSlots']).toMatch(/could not read the company's seats just now. Nothing was sent. Press the button again in a minute/);
    expect(EN['join.stopped.noSlots']).not.toMatch(/no free place/);
    expect(EN['join.stopped.noFreeSeat']).toMatch(/This wallet has no seat of its own left/);
    expect(EN['join.stopped.noFreeSeat']).not.toMatch(/company has no free/);
    expect(EN['join.stopped.takenByAnother']).toMatch(/by keys this wallet does not make/);
    expect(EN['join.stopped.takenByAnother']).not.toMatch(/another invitation/);
  });

  /* RED WHEN: after a stop that pressing again cannot mend, the accept button stays live, or is not tied to the words that say why. */
  it('disables the accept button after a stop that pressing again cannot mend, and points it at the reason', async () => {
    const i = anInvitation('signer');
    serve(() => offerAnswer(i));
    wallet.act.mockResolvedValueOnce({ of: 'stopped', step: 1, steps: 2, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.seat-invited.why.already-seated' });
    const { container } = draw(i, 'member');
    await press(container, 'accept');
    await shown(container, '[data-stopped=already-seated]');
    expect(text(container)).toContain('already holds a seat');
    const button = on(container, '[data-action=accept]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.querySelector(`#${button.getAttribute('aria-describedby')}`)?.getAttribute('data-stopped')).toBe('already-seated');
    expect(heldFor(i.id)).toBe(i.token);
  });

  /* RED WHEN: a refusal is swallowed, or shown in words other than the app's own for it. */
  it('shows a refusal of the act and does not swallow it', async () => {
    const i = anInvitation('employee');
    serve(() => offerAnswer(i));
    wallet.signedIn = false;
    const { container } = draw(i, 'member');
    await press(container, 'accept');
    await shown(container, '[data-refusal=not-signed-in]');
    expect(wallet.joinByCode).not.toHaveBeenCalled();
    expect(heldFor(i.id)).toBe(i.token);
  });

  /* RED WHEN: Not now sends anything to the wallet or the service, keeps the link, or does not say the invitation stays open. */
  it('lets the person leave: the link is forgotten and nothing is sent', async () => {
    const i = anInvitation('employee');
    serve(() => offerAnswer(i));
    const { container } = draw(i, 'member');
    await press(container, 'not-now');
    await shown(container, '[data-join-card=not-now]');
    expect(text(container)).toContain('Nothing was sent');
    expect(text(container)).toContain('stays open until it expires');
    expect(asked).toEqual([`/api/invites/${i.id}/offer`]);
    expect(wallet.act).not.toHaveBeenCalled();
    expect(wallet.joinByCode).not.toHaveBeenCalled();
    expect(heldFor(i.id)).toBe('nothing');
  });

  /* RED WHEN: Go on after joining does not refresh the person's companies before leaving the page. */
  it('refreshes the person\'s companies when they go on after joining', async () => {
    const i = anInvitation('signer');
    serve(() => offerAnswer(i));
    wallet.act.mockResolvedValue({ of: 'done', steps: 2, relayed: 1 });
    const { container } = draw(i, 'member');
    await press(container, 'accept');
    await press(container, 'go-on');
    expect(companiesChanged).toHaveBeenCalledTimes(1);
  });
});

describe('the join page\'s words', () => {
  const WORDS = Object.entries(EN).filter(([k]) => k.startsWith('join.'));

  /* RED WHEN: a join word carries an em or en dash, points to a payslips page, tells a person to use another device, or names a build setting. */
  it('has no dash, no payslips page, no other device and no build setting', () => {
    expect(WORDS.length).toBeGreaterThan(50);
    expect(WORDS.filter(([, v]) => /[–—]/u.test(v)).map(([k]) => k)).toEqual([]);
    expect(WORDS.filter(([, v]) => /payslips|another device|other device|VITE_|environment/iu.test(v)).map(([k]) => k)).toEqual([]);
  });

  /* RED WHEN: the page keeps its Coming soon words, which nothing now shows. */
  it('no longer carries the Coming soon words for the page', () => {
    expect(EN['page.join.soon']).toBeUndefined();
  });
});

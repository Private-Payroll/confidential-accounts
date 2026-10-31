// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { invitationLink } from '../../../../src/core/invitation.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';

/*
 * THE INVITE PANEL, DRAWN as the side panel opens it from a page and as the setup wizard's People step draws it, over the real
 * adapter and the real wallet wrapper, with only the call to the wallet stood in for: what each kind sends, what is shown
 * before and after, and what a stop keeps.
 */
vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180'); });
const kr = vi.hoisted(() => ({
  acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0, outcome: { state: 'filed' } } as unknown, steps: [] as { step: number; steps: number }[],
  hold: null as Promise<void> | null, company: null as unknown, reads: 0,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: 'u1' }),
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => ({ companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) }),
  actOnACompanyInTheWallet: async (intent: Record<string, string>, _origin: string, opts?: { onStep?: (at: { step: number; steps: number }) => void }) => {
    kr.acts.push(intent);
    for (const at of kr.steps) opts?.onStep?.(at);
    if (kr.hold !== null) await kr.hold;
    return kr.ended;
  },
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => { kr.reads += 1; return kr.company; },
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  companyNamesFor: async () => new Map(),
}));

const { InvitePeople } = await import('./invite.js');
const { SessionProvider } = await import('../session.js');
const { PanelProvider, RightPanel } = await import('../shell/right-panel.js');
const { CompanyRecordsProvider } = await import('../records/company-records.js');
const { whyOf, WHY } = await import('../adapters/invite.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const HERE = dirname(fileURLToPath(import.meta.url));
const EN = JSON.parse(readFileSync(resolve(HERE, '../locales/en.json'), 'utf8')) as Record<string, string>;
const WALLET_EN = JSON.parse(readFileSync(resolve(HERE, '../../../wallet/src/locales/en.json'), 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const PUBLIC = 'mn_addr_stagenet1egv3hww6lmsahjy3gldaqn778hcpwvhhw8udud6k859906yynmmq8wsdsd';
const PRIVATE = 'mn_shield-addr_stagenet1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyq4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kkcvfvr0u';
const SIGNERS_APPROVALS = (over: Record<string, unknown> = {}) => ({ of: 'read', value: { count: 2, raisedAboveTheAccount: false, vaultsAtThatNumber: [], ...over } });
const company = (approvalsForSigners: unknown = SIGNERS_APPROVALS()) => ({ of: 'open', id: 'c-1', name: 'Northwind', approvalsForSigners });

const session = () => ({
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true },
  chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
});
const inPanel = (node: React.ReactNode) => render(
  <KitProvider languages={LANGUAGES} pick="en">
    <SessionProvider session={session()}><PanelProvider><CompanyRecordsProvider>{node}<RightPanel /></CompanyRecordsProvider></PanelProvider></SessionProvider>
  </KitProvider>,
);
const inWizard = (node: React.ReactNode) => render(
  <KitProvider languages={LANGUAGES} pick="en"><SessionProvider session={session()}>{node}</SessionProvider></KitProvider>,
);
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const type = (field: string, value: string) => fireEvent.change(q(`[data-field=${field}]`)!, { target: { value } });
const pick = (marker: string) => fireEvent.click(q(`[${marker}]`)!);
const press = async (action = 'send-invite') => { fireEvent.click(q(`[data-action=${action}]`)!); await settle(); };
const openPanel = async () => { fireEvent.click(q('[data-action=invite]')!); await settle(); };
const linkShown = (): string => (q('[data-invite=sent] input[readonly]') as HTMLInputElement).value;

beforeEach(() => {
  kr.acts = []; kr.steps = []; kr.hold = null; kr.reads = 0; kr.company = company();
  kr.ended = { of: 'done', steps: 1, relayed: 0, outcome: { state: 'filed' } };
});
afterEach(cleanup);

describe('inviting each kind, through the wallet\'s invite act', () => {
  /* RED WHEN: an employee's details reach the wallet in other fields than the act reads, the pay is not in smallest units, or the link shown is not made from the token sent. */
  it('invites an employee by link, and shows the link to copy', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    type('name', 'Ada'); type('title', 'Engineer'); type('start-date', '2026-11-01'); type('amount', '12.5');
    await press();
    expect(kr.acts).toHaveLength(1);
    const f = kr.acts[0]!;
    expect(f['name']).toBe('invite');
    expect(f).toMatchObject({ kind: 'employee', personName: 'Ada', title: 'Engineer', startDate: '2026-11-01', classification: 'full-time', record: 'c-1', company: 'label-1' });
    expect(f['amount']).toMatch(/^125\d*$/u);
    expect(f['token']).toMatch(/^[0-9a-f]{64}$/u);
    expect(f).not.toHaveProperty('address');
    expect(linkShown()).toBe(invitationLink(window.location.origin, f['token'] as never));
    expect(q('[data-invite-starts]')!.textContent).toContain('2026');
  });

  /* RED WHEN: choosing an address does not send it, or a public address is refused for a person. */
  it('invites an employee by address', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-way=address');
    type('name', 'Ada'); type('start-date', '2026-11-01'); type('amount', '1'); type('address', 'not an address');
    await press();
    expect(kr.acts).toEqual([]);
    expect(q('[data-problem=address]')!.textContent).toBe(EN['invite.problem.bad-address']);
  });

  /* RED WHEN: a vendor's terms do not reach the wallet as the act reads them. */
  it('invites a vendor, one-off and monthly', async () => {
    inPanel(<InvitePeople kind="vendor" />);
    await settle(); await openPanel();
    expect(q('[data-kind=employee]')).toBeNull();
    type('name', 'Acme'); type('start-date', '2026-11-01');
    await press();
    expect(kr.acts[0]).toMatchObject({ kind: 'vendor', personName: 'Acme', terms: 'one-off', startDate: '2026-11-01' });
    pick('data-action=invite-another');
    await settle();
    pick('data-terms=monthly');
    type('name', 'Acme'); type('start-date', '2026-11-01'); type('termsAmount', '3');
    await press();
    expect(kr.acts[1]).toMatchObject({ kind: 'vendor', terms: 'monthly' });
    expect(kr.acts[1]!['termsAmount']).toMatch(/^3\d*$/u);
    expect(kr.acts[1]).not.toHaveProperty('amount');
  });

  /* RED WHEN: a signer is invited without an address, with a scope, or with a role the wallet does not know. */
  it('invites a signer at their private address and sends the role, with no scope', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-kind=signer');
    type('name', 'Sam'); type('address', PRIVATE);
    pick('data-role=initiator');
    await press();
    expect(kr.acts[0]).toMatchObject({ kind: 'signer', personName: 'Sam', role: 'initiator', address: PRIVATE });
    expect(kr.acts[0]).not.toHaveProperty('scope');
    expect(q('[data-invite=sent]')).not.toBeNull();
  });
});

describe('what is shown and refused before anything is sent', () => {
  /* RED WHEN: a super admin can be chosen or sent, or is hidden. */
  it('shows super admin, disabled with its sentence, and sends nothing for it', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    const radio = q('[data-kind=super-admin]') as HTMLButtonElement;
    expect(radio.disabled).toBe(true);
    fireEvent.click(radio);
    expect(q('[data-invite-refused-kind=super-admin]')!.textContent).toBe(EN['invite.kind.superAdmin.why']);
    expect(q('[data-field=name]')).not.toBeNull();
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: limited or accountant can be chosen, a chosen set of vaults can be, or their reasons are missing. */
  it('shows limited, accountant and a chosen set of vaults disabled, with the reason beside them', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-kind=signer');
    for (const role of ['limited', 'accountant']) expect((q(`[data-role=${role}]`) as HTMLButtonElement).disabled, role).toBe(true);
    for (const role of ['admin', 'approver', 'initiator', 'viewer']) expect((q(`[data-role=${role}]`) as HTMLButtonElement).disabled, role).toBe(false);
    expect((q('[data-scope=chosen]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-invite-later=roles]')!.textContent).toBe(EN['invite.role.later']);
    expect(q('[data-invite-later=scope]')!.textContent).toBe(EN['invite.scope.chosen.why']);
  });

  /* RED WHEN: the sentence is missing, shows the account's number when a vault raised it, or is guessed when the number is unreadable. */
  it('says how many approvals adding a signer needs, before the wallet is asked, and nothing when it cannot be read', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-kind=signer');
    expect(q('[data-approvals-needed]')!.textContent).toBe(EN['invite.approvals.account_other']!.replace('{count}', '2'));
    cleanup();
    kr.company = company(SIGNERS_APPROVALS({ count: 3, raisedAboveTheAccount: true, vaultsAtThatNumber: ['aa'.repeat(32)] }));
    inPanel(<InvitePeople />);
    await settle(); await openPanel(); pick('data-kind=signer');
    expect(q('[data-approvals-needed]')!.getAttribute('data-approvals-needed')).toBe('raised');
    cleanup();
    kr.company = company({ of: 'unreadable' });
    inPanel(<InvitePeople />);
    await settle(); await openPanel(); pick('data-kind=signer');
    expect(q('[data-approvals-needed]')).toBeNull();
  });

  /* RED WHEN: a form with a problem reaches the wallet, or the problem is not shown at its field. */
  it('names the first problem at its field and asks the wallet for nothing', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    await press();
    expect(kr.acts).toEqual([]);
    expect(q('[data-problem=name]')!.textContent).toBe(EN['invite.problem.no-name']);
    type('name', 'Ada');
    expect(q('[data-problem=name]')).toBeNull();
  });
});

describe('the wizard\'s People step', () => {
  /* RED WHEN: the step draws no form, offers signers or super admin (the signers have their own step), or does not tell the wizard it changed. */
  it('draws the form in place for employees and vendors, and tells the wizard when an invitation is filed', async () => {
    const changed = vi.fn();
    inWizard(<InvitePeople leadTo={vi.fn()} onChanged={changed} />);
    await settle();
    expect(q('[data-invite=form]')).not.toBeNull();
    expect(q('[data-kind=employee]')).not.toBeNull();
    expect(q('[data-kind=vendor]')).not.toBeNull();
    expect(q('[data-kind=signer]')).toBeNull();
    expect(q('[data-kind=super-admin]')).toBeNull();
    expect(q('[data-action=invite]')).toBeNull();
    type('name', 'Ada'); type('start-date', '2026-11-01'); type('amount', '5');
    await press();
    expect(kr.acts).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(q('[data-invite=sent]')).not.toBeNull();
  });
});

describe('a stop that may have made part of the invitation', () => {
  const stopAt = (refused: string, step = 3) => { kr.ended = { of: 'stopped', step, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused }; };

  /* RED WHEN: the link is not offered after a raise that was not filed, the words are not the page's, the form can still be changed, or the press again makes a new token. */
  it('offers the link, holds the form still and carries on the same invitation on a press again', async () => {
    inPanel(<InvitePeople kind="vendor" />);
    await settle(); await openPanel();
    type('name', 'Acme'); type('start-date', '2026-11-01');
    stopAt('act.invite.why.raised-not-filed');
    await press();
    const token = kr.acts[0]!['token']!;
    expect(q('[data-invite-stopped=raised-not-filed]')!.textContent).toContain(EN['invite.why.raised-not-filed']);
    expect((q('[data-invite=form] input[readonly]') as HTMLInputElement).value).toBe(invitationLink(window.location.origin, token as never));
    expect((q('[data-field=name]') as HTMLInputElement).disabled).toBe(true);
    kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'filed' } };
    await press('invite-press-again');
    expect(kr.acts).toHaveLength(2);
    expect(kr.acts[1]!['token']).toBe(token);
    expect(linkShown()).toBe(invitationLink(window.location.origin, token as never));
  });

  /* RED WHEN: a part-way stop shows a link that does not work yet, or a press again after it makes a new invitation. */
  it('offers no link after a part-way stop, and a press again carries on the same invitation', async () => {
    inPanel(<InvitePeople kind="vendor" />);
    await settle(); await openPanel();
    type('name', 'Acme'); type('start-date', '2026-11-01');
    stopAt('act.invite.why.may-be-sent');
    await press();
    expect(q('[data-invite=form] input[readonly]')).toBeNull();
    expect(q('[data-invite-stopped=may-be-sent]')!.textContent).toContain(EN['invite.why.may-be-sent']);
    await press('invite-press-again');
    expect(kr.acts[1]!['token']).toBe(kr.acts[0]!['token']);
  });

  /*
   * RED WHEN: after the invitation was filed but its record not yet entered in the company's records, or after the wallet could
   * not read whether the invitation is filed, the page says it in other words than its own, offers a link that does not work yet,
   * lets the form be changed, or makes a new invitation on the next press instead of carrying on the same one.
   */
  it.each(['filed-not-entered', 'offer-not-read'])('says %s in its own words, holds the form still and carries on the same invitation on a press again', async (why) => {
    inPanel(<InvitePeople kind="vendor" />);
    await settle(); await openPanel();
    type('name', 'Acme'); type('start-date', '2026-11-01');
    stopAt(`act.invite.why.${why}`);
    await press();
    const token = kr.acts[0]!['token']!;
    expect(whyOf(`act.invite.why.${why}`)).toBe(why);
    expect(q(`[data-invite-stopped=${why}]`)!.textContent).toContain(EN[`invite.why.${why}`]);
    expect(EN[`invite.why.${why}`]).toMatch(/press again/i);
    expect(EN[`invite.why.${why}`]).not.toMatch(/nothing was sent/i);
    expect(q('[data-invite=form] input[readonly]')).toBeNull();
    expect((q('[data-field=name]') as HTMLInputElement).disabled).toBe(true);
    await press('invite-press-again');
    expect(kr.acts).toHaveLength(2);
    expect(kr.acts[1]!['token']).toBe(token);
  });

  /*
   * RED WHEN: a stop whose words say nothing was sent is shown after the wallet handed over transactions (sent or unconfirmed), the page
   * does not say transactions may have been sent, or the company's records are not read again; or a stop that handed over none loses its own words.
   */
  it.each([[1, 0], [0, 1]])('says transactions may have been sent, in place of "nothing was sent", and reads the records again, when %i were sent and %i unconfirmed', async (relayed, unconfirmed) => {
    inPanel(<InvitePeople kind="vendor" />);
    await settle(); await openPanel();
    type('name', 'Acme'); type('start-date', '2026-11-01');
    kr.ended = { of: 'stopped', step: 3, steps: 4, relayed, unconfirmed, why: 'check-failed', refused: 'act.invite.why.own-address' };
    const before = kr.reads;
    await press();
    const shown = q('[data-invite-stopped=own-address]')!.textContent!;
    expect(shown).toContain(EN['invite.sent']);
    expect(shown).not.toContain(EN['invite.why.own-address']);
    expect(EN['invite.why.own-address']).toMatch(/Nothing was sent/);
    expect(kr.reads - before).toBe(1);
  });

  /* RED WHEN: a stop that handed over nothing is told as one that did, loses its own words, or reads the records again. */
  it('keeps a stop\'s own words and reads nothing again when the wallet handed over nothing', async () => {
    inPanel(<InvitePeople kind="vendor" />);
    await settle(); await openPanel();
    type('name', 'Acme'); type('start-date', '2026-11-01');
    kr.ended = { of: 'stopped', step: 3, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.invite.why.own-address' };
    const before = kr.reads;
    await press();
    expect(q('[data-invite-stopped=own-address]')!.textContent).toContain(EN['invite.why.own-address']);
    expect(q('[data-invite-stopped=own-address]')!.textContent).not.toContain(EN['invite.sent']);
    expect(kr.reads - before).toBe(0);
  });

  /* RED WHEN: a refusal that made nothing holds the form still, so the mistake cannot be corrected. */
  it('lets the form be changed after a refusal that made nothing, and a new press makes a new token', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-kind=signer');
    type('name', 'Sam'); type('address', PRIVATE);
    stopAt('act.invite.why.own-address', 1);
    await press();
    expect(q('[data-invite-stopped=own-address]')!.textContent).toContain(EN['invite.why.own-address']);
    expect((q('[data-field=address]') as HTMLInputElement).disabled).toBe(false);
    await press();
    expect(kr.acts[1]!['token']).not.toBe(kr.acts[0]!['token']);
  });
});

describe('the wallet window and its words', () => {
  /* RED WHEN: the wait shows no step, or the button can be pressed twice while the wallet is open. */
  it('shows the wallet\'s step while it is open, and holds the button', async () => {
    kr.steps = [{ step: 2, steps: 4 }];
    let release: () => void = () => {};
    kr.hold = new Promise<void>((r) => { release = r; });
    inPanel(<InvitePeople kind="vendor" />);
    await settle(); await openPanel();
    type('name', 'Acme'); type('start-date', '2026-11-01');
    await press();
    expect(q('[data-invite-working]')!.textContent).toBe(EN['invite.working.step']!.replace('{step}', '2').replace('{steps}', '4'));
    expect((q('[data-action=send-invite]') as HTMLButtonElement).disabled).toBe(true);
    release(); await settle();
    expect(kr.acts).toHaveLength(1);
  });

  /* RED WHEN: a reason the wallet can give has no words on the page, or the page and the wallet name a reason differently. */
  it('has page words for every reason the wallet\'s invite act refuses with', () => {
    const wallet = Object.keys(WALLET_EN).filter((k) => k.startsWith('act.invite.why.'));
    expect(wallet.length).toBeGreaterThan(20);
    for (const key of wallet) {
      const code = whyOf(key);
      expect(code, key).not.toBe(WHY.other);
      expect(EN[`invite.why.${code}`], key).toBeTruthy();
    }
    for (const code of Object.values(WHY)) expect(EN[`invite.why.${code}`], code).toBeTruthy();
  });
});


describe('the panel words, controls and sent state', () => {
  const stopAt = (refused: string, step = 3) => { kr.ended = { of: 'stopped', step, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused }; };
  const PAGE = 'Signers and approvals';

  /* RED WHEN: the sent words say anyone may use a link that only the holder of an address can take up, say the holder where anyone may, or say the holder can take up a link made at a private address, which nothing but the fingerprint check guards. */
  it('says who may use the link, by way, and for a signer', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    type('name', 'Ada'); type('start-date', '2026-11-01'); type('amount', '1');
    await press();
    expect(q('[data-invite-sent]')!.textContent).toContain('Whoever opens it');
    cleanup();
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-way=address');
    type('name', 'Ada'); type('start-date', '2026-11-01'); type('amount', '1'); type('address', PUBLIC);
    await press();
    expect(q('[data-invite-sent]')!.textContent).toContain('holder of the address');
    expect(q('[data-invite-sent]')!.textContent).not.toContain('Whoever opens it');
    expect(q('[data-invite-sent]')!.textContent).not.toContain('nothing checks that');
    cleanup();
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-way=address');
    type('name', 'Ada'); type('start-date', '2026-11-01'); type('amount', '1'); type('address', PRIVATE);
    await press();
    expect(q('[data-invite-sent]')!.textContent).toContain(EN['invite.done.link.privateAddress']!.replace('{name}', 'Ada'));
    expect(q('[data-invite-sent]')!.textContent).not.toContain('holder of the address');
    expect(EN['invite.done.link.privateAddress']).toMatch(/check the fingerprint they read out/);
    cleanup();
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-kind=signer'); type('name', 'Sam'); type('address', PRIVATE);
    await press();
    expect(q('[data-invite-sent]')!.textContent).toContain('holder of the address');
  });

  /* RED WHEN: a signer's sent state does not say the proposal still needs approvals, how many, and where it shows. */
  it('tells the inviter of a signer that the proposal still needs approvals and where it shows', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-kind=signer'); type('name', 'Sam'); type('address', PRIVATE);
    await press();
    expect(q('[data-invite-signer-pending]')!.textContent).toContain(PAGE);
    expect(q('[data-invite=sent] [data-approvals-needed]')!.textContent).toBe(EN['invite.approvals.account_other']!.replace('{count}', '2'));
    cleanup();
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    type('name', 'Ada'); type('start-date', '2026-11-01'); type('amount', '1');
    await press();
    expect(q('[data-invite-signer-pending]')).toBeNull();
  });

  /* RED WHEN: a signer whose proposal may already be raised is told that pressing Invite again raises a new one, or an employee or vendor, or a signer whose offer was never read, loses that sentence. */
  it('tells a signer a closed invitation cannot be raised again, and keeps the new-one sentence for the rest', async () => {
    for (const [why, words] of [['may-be-sent', 'invite.stopped.closingSigner'], ['raised-not-filed', 'invite.stopped.closingSigner'], ['offer-not-read', 'invite.stopped.closing']] as const) {
      cleanup();
      inPanel(<InvitePeople />);
      await settle(); await openPanel();
      pick('data-kind=signer'); type('name', 'Sam'); type('address', PRIVATE);
      stopAt(`act.invite.why.${why}`);
      await press();
      expect(q('[data-invite-closing]')!.textContent, why).toBe(EN[words]);
    }
    expect(EN['invite.stopped.closingSigner']).not.toMatch(/new one/u);
    expect(EN['invite.stopped.closingSigner']).toMatch(/cannot be invited again until it is withdrawn/);
  });

  /* RED WHEN: the sent link is not drawn by the kit's copy control, says nothing of being shown once, or a browser that would not copy leaves no word. */
  it('draws the link in the kit\'s copy control, says it is shown only now, and says when the browser would not copy', async () => {
    inPanel(<InvitePeople kind="vendor" />);
    await settle(); await openPanel();
    type('name', 'Acme'); type('start-date', '2026-11-01');
    await press();
    expect(q('[data-invite=sent] textarea')).toBeNull();
    expect(q('[data-invite-link-once]')!.textContent).toBe(EN['invite.done.linkOnce']);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    fireEvent.click([...document.body.querySelectorAll<HTMLElement>('[data-invite=sent] button')].find((b) => b.textContent === EN['invite.link.copy'])!);
    await settle();
    expect(q('[data-copy-refused]')!.textContent).toBe(EN['invite.link.refused']);
  });

  /* RED WHEN: at a bar of 1 the inviter of a signer is told the proposal waits for approvals (the raise is the approval), or above 1 is told nothing waits. */
  it('tells the inviter of a signer whether anybody else has to approve, by the bar', async () => {
    kr.company = company(SIGNERS_APPROVALS({ count: 1 }));
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-kind=signer'); type('name', 'Sam'); type('address', PRIVATE);
    await press();
    expect(q('[data-invite-signer-pending]')!.getAttribute('data-invite-signer-pending')).toBe('complete');
    expect(q('[data-invite-signer-pending]')!.textContent).toBe(EN['invite.done.signerComplete']!.replace(/\{name\}/g, 'Sam').replace('{page}', PAGE));
    expect(q('[data-invite-signer-pending]')!.textContent).not.toMatch(/waits for approvals/);
    cleanup();
    kr.company = company(SIGNERS_APPROVALS({ count: 2 }));
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-kind=signer'); type('name', 'Sam'); type('address', PRIVATE);
    await press();
    expect(q('[data-invite-signer-pending]')!.getAttribute('data-invite-signer-pending')).toBe('waiting');
    expect(q('[data-invite-signer-pending]')!.textContent).toMatch(/waits for approvals/);
  });

  /* RED WHEN: the address hint or the join page for a claim leaves out that payments to a public address, and their amounts, can be looked up by anyone. */
  it('says at the choice of an address, and at the join, that a public address shows each payment and its amount', () => {
    expect(EN['invite.address.person.hint']).toMatch(/If you give a public address, anyone can look up each payment to it, with the amount/);
    expect(EN['join.way.claim']).toMatch(/anyone can look up each payment and its amount/);
  });

  /* RED WHEN: a held invitation does not say what closing the panel costs, or an invitation that was never held says it. */
  it('says plainly that leaving loses a held invitation', async () => {
    inPanel(<InvitePeople kind="vendor" />);
    await settle(); await openPanel();
    type('name', 'Acme'); type('start-date', '2026-11-01');
    stopAt('act.invite.why.may-be-sent');
    await press();
    expect(q('[data-invite-closing]')!.textContent).toBe(EN['invite.stopped.closing']);
    expect(EN['invite.stopped.closing']).toMatch(/new one/u);
    stopAt('act.invite.why.not-made', 1);
    cleanup();
    inPanel(<InvitePeople kind="vendor" />);
    await settle(); await openPanel();
    type('name', 'Acme'); type('start-date', '2026-11-01');
    await press();
    expect(q('[data-invite-stopped=not-made]')).not.toBeNull();
    expect(q('[data-invite-closing]')).toBeNull();
  });

  /* RED WHEN: the raised-not-filed words promise that the link works before the invitation is filed. */
  it('promises nothing of the link before it is filed', () => {
    expect(EN['invite.why.raised-not-filed']).not.toMatch(/link|yourself/u);
  });

  /* RED WHEN: an unknown refusal says nothing was sent, or drops the token so the next press raises a second proposal. */
  it('keeps the token after a refusal it does not know, and does not say nothing was sent', async () => {
    expect(EN['invite.why.other']).not.toMatch(/nothing was sent/iu);
    inPanel(<InvitePeople kind="vendor" />);
    await settle(); await openPanel();
    type('name', 'Acme'); type('start-date', '2026-11-01');
    stopAt('act.invite.why.nobody-knows');
    await press();
    expect(q('[data-invite-stopped=other]')).not.toBeNull();
    kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'filed' } };
    await press('invite-press-again');
    expect(kr.acts[1]!['token']).toBe(kr.acts[0]!['token']);
  });

  /* RED WHEN: a disabled option gives a statement and no cause or next step. */
  it('gives the cause and the next step for each disabled signer option', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-kind=signer');
    expect(q('[data-invite-later=roles]')!.textContent).toMatch(/Admin, Approver, Initiator or Viewer/u);
    expect(q('[data-invite-later=roles]')!.textContent).toMatch(/cannot be given from here/u);
    expect(q('[data-invite-later=scope]')!.textContent).toMatch(/cannot choose vaults yet/u);
    expect(q('[data-invite-later=scope]')!.textContent).toMatch(/wait before inviting/u);
    expect(EN['invite.problem.role-later']).toMatch(/Admin, Approver, Initiator or Viewer/u);
  });

  /* RED WHEN: a role has no line, or its line is not the one drawn from the seat directory's rule of what each role may file. */
  it('says what each role may do, in the words of the seat directory\'s rule', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-kind=signer');
    for (const role of ['admin', 'approver', 'initiator', 'viewer']) {
      expect(q(`[data-role-says=${role}]`)!.textContent, role).toBe(EN[`invite.role.${role}.says`]);
    }
    expect(EN['invite.role.admin.says']).toMatch(/every kind of company record/u);
    expect(EN['invite.role.approver.says']).toMatch(/proposals/u);
    expect(EN['invite.role.initiator.says']).toMatch(/pay runs, transfers and proposals/u);
    expect(EN['invite.role.viewer.says']).toMatch(/none/u);
  });

  /* RED WHEN: the super admin's reason sits away from its own option, or the disabled options are drawn at half strength. */
  it('puts the super admin reason beside its own option and keeps disabled options legible', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    const field = q('[data-kind=super-admin]')!.closest('[data-slot=field]')!;
    expect(field.querySelector('[data-invite-refused-kind=super-admin]')).not.toBeNull();
    expect(q('[data-kind=super-admin]')!.className).toContain('disabled:opacity-70');
    expect(field.querySelector('label')!.className).toContain('opacity-80');
  });

  /* RED WHEN: the pay field does not say it is monthly, or a phone is not given the decimal keypad on an amount. */
  it('labels the pay as monthly and asks for the decimal keypad on both amounts', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    expect(document.body.textContent).toContain('Monthly pay');
    expect((q('[data-field=amount]') as HTMLInputElement).inputMode).toBe('decimal');
    pick('data-kind=vendor'); pick('data-terms=monthly');
    expect((q('[data-field=termsAmount]') as HTMLInputElement).inputMode).toBe('decimal');
  });

  /* RED WHEN: the waiting line is not a status region, or a problem leaves the focus away from its field. */
  it('announces the wait, and moves to the first field in error', async () => {
    kr.steps = [{ step: 2, steps: 4 }];
    let release: () => void = () => {};
    kr.hold = new Promise<void>((r) => { release = r; });
    inPanel(<InvitePeople kind="vendor" />);
    await settle(); await openPanel();
    type('name', 'Acme'); type('start-date', '2026-11-01');
    await press();
    expect(q('[data-invite-working]')!.getAttribute('role')).toBe('status');
    release(); await settle();
    cleanup();
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    await press();
    expect(document.activeElement).toBe(q('[data-field=name]'));
  });

  /* RED WHEN: the wizard's in-place form stretches to the width of the page. */
  it('keeps the wizard form to a readable width', async () => {
    inWizard(<InvitePeople leadTo={vi.fn()} />);
    await settle();
    expect(q('[data-invite=form]')!.closest('.max-w-xl')).not.toBeNull();
  });

  /* RED WHEN: the sent state does not show the end date, the pay and the address that were filed. */
  it('shows what was filed', async () => {
    inPanel(<InvitePeople />);
    await settle(); await openPanel();
    pick('data-way=address');
    type('name', 'Ada'); type('start-date', '2026-11-01'); type('end-date', '2027-03-31'); type('amount', '12.5'); type('address', PRIVATE);
    await press();
    const text = q('[data-invite=sent]')!.textContent!;
    expect(q('[data-invite-ends]')!.textContent).toContain('2027');
    expect(q('[data-invite-pay]')!.textContent).toContain('12.5');
    expect(q('[data-invite-address]')!.textContent).toContain(PRIVATE);
    expect(text).toContain('Monthly pay');
  });
});

describe('the wallet\'s checks on a signer\'s address, in the words it shows', () => {
  /* RED WHEN: a window claims it refuses any wallet already seated on this company, or that no wallet at the address holds a seat, when it recognises only a seat made by an invitation and an open proposal; or it leaves out that it cannot tell the founding seat's address. */
  it('claims only the seats made by an invitation and the open proposals, and says the founding seat is not told', () => {
    for (const key of ['act.invite.shown.signer-checks', 'act.approve-signer.shown.checks', 'act.approve-signer.check.one-seat']) {
      expect(WALLET_EN[key], key).not.toMatch(/already seated on this company|holds no seat on this company/);
      expect(WALLET_EN[key], key).toMatch(/seat made by an invitation|seated by an earlier invitation/);
      expect(WALLET_EN[key], key).toMatch(/founding seat/);
    }
  });
});


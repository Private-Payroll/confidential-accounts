// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://identity.payroll.example/"}
import { A_PRIVATE_DEPOSIT_IS_ASKED_BY_INTENT } from '../chain/balance-for-page.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '../testing/render.js';
import { IDBFactory } from 'fake-indexeddb';

/*
 * **AN ASK THAT REACHES A LOCKED WALLET IS ONE WINDOW.** The whole wallet is mounted here - session, routes, the
 * locked window, the opened screens - over real storage, in a window opened by a page that re-sends its ask each time
 * the wallet says it is listening. Only the browser's passkey call and its verification are stood in for, because a
 * test runner has no authenticator; the passkey call is also what "a passkey was asked for" means below, and the
 * presses counted are the ones this file makes.
 */

/* The page this wallet is built to answer: a window opened by any other page is answered nothing. */
vi.hoisted(() => { process.env['VITE_APP_ORIGIN'] = 'https://app.payroll.example'; });

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

vi.mock('midnight-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity')>();
  return { ...actual, verifyRegistration: vi.fn(), verifyAssertion: vi.fn() };
});

import { Buffer as PolyfillBuffer } from 'buffer/';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import { usePasskey } from 'midnight-identity/browser';
import { verifyAssertion } from 'midnight-identity';
import type { Passkey } from 'midnight-identity/passkey/verify';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { emptyProfile, grantTo, recordRelease } from 'midnight-identity/profile/model';
import { save } from 'midnight-identity/profile/store';
import { parseAsk } from 'midnight-identity/profile/request';
import { Approve } from './approve.js';
import { chooseSlot } from '../accounts/slot-choice.js';
import { fingerprintOf } from 'midnight-identity/recovery/pieces';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { READY_PING } from 'midnight-identity/profile/channel';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { App } from '../app.js';
import { SessionProvider, useSession } from '../session.js';
import { anAskIsApproved, approveBeforeThePasskey, forgetApprovalBeforeThePasskey } from '../framing.js';
import { ApproveEntry } from './approve-entry.js';
import { forgetOpenWallet, heldWallets, openWallet } from '../accounts/wallets-held.js';
import { savePasskey, saveSecret, saveWalletName } from '../accounts/storage.js';
import { rememberSignIn, signedInWalletHere } from '../lib/signed-in-here.js';

const ASKER = 'https://app.payroll.example';
const mockUsePasskey = vi.mocked(usePasskey);
const mockVerifyAssertion = vi.mocked(verifyAssertion);

const passkeyFixture = (credentialId: string): Passkey => ({
  credentialId, personHandle: 'person-1', publicKeySpki: new Uint8Array([1, 2, 3]), algorithm: -7, signCount: 0,
  provenBySignIn: false, rpId: 'localhost', syncsToACloud: false, backedUpNow: false, transports: [],
});

/** A passkey prompt that the person completes with `credentialId`. */
const passkeyAnswers = (credentialId: string): void => {
  mockUsePasskey.mockResolvedValueOnce({
    credentialId, clientDataJSON: new Uint8Array(), authenticatorData: new Uint8Array(), signature: new Uint8Array(),
    userHandle: 'cGVyc29uLTE',
  } as never);
  mockVerifyAssertion.mockResolvedValueOnce({ passkey: passkeyFixture(credentialId) } as never);
};

const putWallet = async (name: string, credentialId: string | null) => {
  const secret = newSecret();
  const id = await saveSecret(secret);
  saveWalletName(secret, name);
  if (credentialId !== null) savePasskey(passkeyFixture(credentialId), id);
  return { id, secret, fingerprint: toBase64Url(fingerprintOf(secret)) };
};

/* Every ask has its own nonce: this window remembers the asks it has answered, and refuses to answer one twice. */
let asked = 0;
const ask = (kind: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind,
  requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'So the page knows it is you.',
  nonce: `${kind}-${(asked += 1)}`,
  expiresAt: Date.now() + 600_000,
  ...(kind === 'keyring' ? { person: 'person-7' } : {}),
  ...over,
});

/* The page that opened this window: it keeps what the wallet posts, and sends its ask whenever the wallet says it is
 * listening, as the asking side does. */
let posted: unknown[] = [];
let asking: Record<string, unknown> | null = null;
const page = {
  postMessage: (message: unknown) => {
    posted.push(message);
    if ((message as { schema?: unknown }).schema === READY_PING && asking !== null) {
      const sending = asking;
      setTimeout(() => send(sending), 0);
    }
  },
};
const send = (data: unknown): void => {
  const event = new Event('message');
  Object.defineProperties(event, { data: { value: data }, origin: { value: ASKER }, source: { value: page } });
  window.dispatchEvent(event);
};
const answers = (schema: string): unknown[] => posted.filter((m) => {
  const said = m as { schema?: unknown; payload?: { schema?: unknown } };
  return said.schema === schema || said.payload?.schema === schema;
});
const RESPONSE = 'midnight-identity/disclosure-response/v1';
const REFUSED = 'midnight-identity/disclosure-refused/v1';
const KEYRING = 'midnight-identity/keyring-release/v1';

const mount = (theAsk: Record<string, unknown>) => {
  asking = theAsk;
  return render(<SessionProvider><App /></SessionProvider>);
};
const theWindow = async (kind: string): Promise<HTMLButtonElement> => {
  await waitFor(() => expect(document.querySelector(`[data-ask-window="${kind}"]`)).not.toBeNull());
  return document.querySelector('[data-approve-window]') as HTMLButtonElement;
};
const press = (selector: string): void => {
  fireEvent.click(document.querySelector(selector) as HTMLElement);
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockUsePasskey.mockReset();
  mockVerifyAssertion.mockReset();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
  forgetApprovalBeforeThePasskey();
  posted = [];
  asking = null;
  window.location.hash = '#/approve';
  Object.defineProperty(window, 'opener', { configurable: true, value: page });
});

describe('an ask that reaches a locked wallet is one window', () => {
  it('a sign-in shows what it does with Approve and Decline, and one press and one passkey answer it', async () => {
    const only = await putWallet('Everyday', 'cred-a');
    mount(ask('sign-in'));
    const approve = await theWindow('sign-in');
    /* RED WHEN: a locked wallet asked to sign in shows its unlock screen instead of the ask. */
    expect(document.body.textContent).not.toContain('Welcome back.');
    expect(document.querySelector('[data-what-it-does]')?.textContent).toContain(ASKER);
    expect(document.querySelector('[data-warning]')?.textContent).toContain('Nothing can take back what has gone');
    expect(document.querySelector('[data-decline]')).not.toBeNull();
    passkeyAnswers('cred-a');
    fireEvent.click(approve);
    /* RED WHEN: once the passkey opens the wallet, the sign-in waits for another press before it is answered. */
    await waitFor(() => expect(answers(RESPONSE)).toHaveLength(1), { timeout: 5000 });
    expect(mockUsePasskey).toHaveBeenCalledTimes(1);
    /* RED WHEN: the passkey prompt offers every passkey for this site rather than only the opening wallet's. */
    expect(mockUsePasskey.mock.calls[0]![0]).toMatchObject({ allow: ['cred-a'] });
    expect(signedInWalletHere(localStorage, ASKER, heldWallets())).toEqual({ of: 'here', walletId: only.id });
  });

  it('Decline answers declined and asks for no passkey', async () => {
    await putWallet('Everyday', 'cred-a');
    mount(ask('sign-in'));
    await theWindow('sign-in');
    press('[data-decline]');
    /* RED WHEN: Decline in the locked window does not answer the page, or asks for a passkey first. */
    await waitFor(() => expect(answers(REFUSED)).toEqual([{ schema: REFUSED, reason: 'declined' }]));
    expect(mockUsePasskey).not.toHaveBeenCalled();
    expect(document.querySelector('[data-ask-over]')).not.toBeNull();
  });

  it('a cancelled passkey leaves the same window with Approve to press again, and nothing is sent', async () => {
    await putWallet('Everyday', 'cred-a');
    mount(ask('sign-in'));
    const approve = await theWindow('sign-in');
    mockUsePasskey.mockRejectedValueOnce(new Error('the passkey prompt was cancelled.'));
    fireEvent.click(approve);
    await waitFor(() => expect(document.querySelector('[data-passkey-again]')).not.toBeNull());
    /* RED WHEN: a cancelled passkey declines the ask or leaves the window, so the page must ask again. */
    expect(document.querySelector('[data-ask-window="sign-in"]')).not.toBeNull();
    expect((document.querySelector('[data-approve-window]') as HTMLButtonElement).disabled).toBe(false);
    expect(answers(RESPONSE)).toHaveLength(0);
    expect(answers(REFUSED)).toHaveLength(0);
    passkeyAnswers('cred-a');
    press('[data-approve-window]');
    await waitFor(() => expect(answers(RESPONSE)).toHaveLength(1), { timeout: 5000 });
  });

  it('an ask the page changes after the passkey is refused, and the window says it is not what was approved', async () => {
    await putWallet('Everyday', 'cred-a');
    mount(ask('sign-in'));
    const approve = await theWindow('sign-in');
    passkeyAnswers('cred-a');
    asking = { ...asking!, purpose: 'Something the window did not show.' };
    fireEvent.click(approve);
    /* RED WHEN: an ask swapped in after the passkey is shown with its own button as if it were the one approved. */
    await waitFor(() => expect(document.querySelector('[data-not-what-was-approved]')).not.toBeNull(), { timeout: 5000 });
    expect(document.querySelector('[data-sign-in]')).toBeNull();
    /* RED WHEN: the page is left waiting, or answered, instead of told the swapped ask was refused. */
    await waitFor(() => expect(answers(REFUSED)).toEqual([{ schema: REFUSED, reason: 'declined' }]));
    expect(answers(RESPONSE)).toHaveLength(0);
    expect(anAskIsApproved()).toBe(false);
  });

  it('a declined window forgets its approval, so the ask can never be answered later', async () => {
    await putWallet('Everyday', 'cred-a');
    mount(ask('sign-in'));
    const approve = await theWindow('sign-in');
    mockUsePasskey.mockRejectedValueOnce(new Error('the passkey prompt was cancelled.'));
    fireEvent.click(approve);
    await waitFor(() => expect(document.querySelector('[data-passkey-again]')).not.toBeNull());
    expect(anAskIsApproved()).toBe(true);
    press('[data-decline]');
    /* RED WHEN: an approval outlives a Decline in the window. */
    expect(anAskIsApproved()).toBe(false);
  });

  it('a passkey of another wallet opens nothing, and the window says whose passkey to use', async () => {
    const first = await putWallet('Everyday', 'cred-a');
    const second = await putWallet('Work', 'cred-b');
    rememberSignIn(localStorage, ASKER, second.fingerprint, second.id);
    openWallet(first.id);
    forgetOpenWallet();
    mount(ask('keyring'));
    const approve = await theWindow('keyring');
    passkeyAnswers('cred-a');
    fireEvent.click(approve);
    /* RED WHEN: a passkey of a wallet other than the one the window names opens that wallet. */
    await waitFor(() => expect(document.body.textContent).toContain('That passkey opens another wallet held in this browser, not Work'), { timeout: 5000 });
    /* RED WHEN: the window invites pressing again where pressing again cannot work, or hides the list that is the way out. */
    expect(document.querySelector('[data-passkey-again]')).toBeNull();
    expect(document.querySelectorAll('[data-wallet-choice]')).toHaveLength(2);
    expect(document.querySelector('[data-ask-window="keyring"]')).not.toBeNull();
    expect(mockVerifyAssertion).not.toHaveBeenCalled();
    expect(answers(KEYRING)).toHaveLength(0);
  });

  it('a wallet with no passkey on record is not asked for one: any passkey could answer', async () => {
    const secret = newSecret();
    await saveSecret(secret);
    function Opener() {
      const { unlock, error } = useSession();
      return <><button type="button" data-open onClick={() => { void unlock({ onlyTheOpenWallet: true, onlyThatWallet: true }); }}>open</button><p data-error>{error}</p></>;
    }
    render(<SessionProvider><Opener /></SessionProvider>);
    press('[data-open]');
    /* RED WHEN: a wallet with no passkey on record offers the browser an empty list, which any passkey answers. */
    await waitFor(() => expect(document.querySelector('[data-error]')?.textContent).toContain('has no passkey kept in this browser'));
    expect(mockUsePasskey).not.toHaveBeenCalled();
  });
});

describe('the list of wallets appears only at the first sign-in', () => {
  it('a sign-in offers the list; every later ask from that page opens the wallet that answered, with only its passkeys', async () => {
    const first = await putWallet('Everyday', 'cred-a');
    const second = await putWallet('Work', 'cred-b');
    openWallet(first.id);
    forgetOpenWallet();
    mount(ask('sign-in'));
    const approve = await theWindow('sign-in');
    expect(document.querySelectorAll('[data-wallet-choice]')).toHaveLength(2);
    press(`[data-wallet-choice="${second.id}"]`);
    passkeyAnswers('cred-b');
    fireEvent.click(approve);
    await waitFor(() => expect(answers(RESPONSE)).toHaveLength(1), { timeout: 5000 });
    expect(mockUsePasskey.mock.calls[0]![0]).toMatchObject({ allow: ['cred-b'] });

    /* The next window is a fresh load, with the first wallet the one this browser has open. */
    cleanup();
    openWallet(first.id);
    forgetOpenWallet();
    posted = [];
    mount(ask('keyring'));
    const next = await theWindow('keyring');
    /* RED WHEN: a later ask from a page signed in to shows the list of wallets again. */
    expect(document.querySelector('[data-wallets-to-choose]')).toBeNull();
    expect(document.querySelector('[data-opens-wallet]')?.textContent).toContain('Work');
    passkeyAnswers('cred-b');
    fireEvent.click(next);
    /* RED WHEN: the passkey offered for a later ask is not only the passkey of the wallet that signed in. */
    await waitFor(() => expect(mockUsePasskey).toHaveBeenCalledTimes(2));
    expect(mockUsePasskey.mock.calls[1]![0]).toMatchObject({ allow: ['cred-b'] });
    await waitFor(() => expect(answers(KEYRING)).toHaveLength(1), { timeout: 5000 });
  });

  it('a page whose remembered wallet is no longer held here says so, and offers the list', async () => {
    await putWallet('Everyday', 'cred-a');
    rememberSignIn(localStorage, ASKER, 'a-wallet-removed-since', 'f00dfeedf00dfeed');
    mount(ask('keyring'));
    await theWindow('keyring');
    /* RED WHEN: a remembered wallet that is gone is not said plainly, or the list is not offered. */
    expect(document.querySelector('[data-remembered-wallet-gone]')?.textContent).toContain('no longer held here');
    expect(document.querySelectorAll('[data-wallet-choice]')).toHaveLength(1);
  });

  it('a page signed in to before places were kept shows the list once, then remembers the wallet that answers', async () => {
    const first = await putWallet('Everyday', 'cred-a');
    const second = await putWallet('Work', 'cred-b');
    rememberSignIn(localStorage, ASKER, second.fingerprint);
    openWallet(first.id);
    forgetOpenWallet();
    mount(ask('keyring'));
    const approve = await theWindow('keyring');
    /* RED WHEN: a record with no wallet place opens a wallet without letting the person choose. */
    expect(document.querySelectorAll('[data-wallet-choice]')).toHaveLength(2);
    /* RED WHEN: the list's first choice is not the wallet the old record names, which this browser can read before any passkey. */
    expect((document.querySelector(`[data-wallet-choice="${second.id}"]`) as HTMLInputElement).checked).toBe(true);
    press(`[data-wallet-choice="${second.id}"]`);
    passkeyAnswers('cred-b');
    fireEvent.click(approve);
    await waitFor(() => expect(answers(KEYRING)).toHaveLength(1), { timeout: 5000 });
    /* RED WHEN: the wallet that answers is not remembered for the page, so the list comes back next time. */
    expect(signedInWalletHere(localStorage, ASKER, heldWallets())).toEqual({ of: 'here', walletId: second.id });
  });
});

describe('a payment this wallet cannot read', () => {
  it('is refused in the window, before any passkey, with nothing to approve', async () => {
    const handlers: ((event: MessageEvent) => void)[] = [];
    const received: unknown[] = [];
    const asker = { postMessage: (message: unknown) => { received.push(message); } };
    const view = {
      opener: asker,
      addEventListener: (_t: string, h: (e: MessageEvent) => void) => { handlers.push(h); },
      removeEventListener: () => { /* torn down by cleanup */ },
    } as unknown as ChannelWindow;
    await putWallet('Everyday', 'cred-a');
    render(
      <SessionProvider>
        <ApproveEntry
          phase={{ name: 'locked' }} entry={null} view={view} port={localStorage}
          readLabel={async () => ({ of: 'no-account' })}
          readLedger={async () => { throw new Error('no ledger here'); }}
        />
      </SessionProvider>);
    const payment = ask('balance', {
      company: 'co_1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071',
      account: 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8',
      vault: 'aa'.repeat(32), transaction: 'AAAA',
    });
    for (const h of handlers) h({ source: asker, origin: ASKER, data: payment } as unknown as MessageEvent);
    await waitFor(() => expect(document.querySelector('[data-balance-refused]')).not.toBeNull());
    /* RED WHEN: a payment this wallet could not read can still be approved, or the page is not told. */
    expect((document.querySelector('[data-approve-window]') as HTMLButtonElement).disabled).toBe(true);
    expect(received).toContainEqual({ schema: REFUSED, reason: 'unreadable' });
    expect(mockUsePasskey).not.toHaveBeenCalled();
  });
});

describe('what the window shows, and what the opened wallet still refuses', () => {
  it('a window asked to pay for a private deposit the page built refuses it before any passkey, and offers no passkey', async () => {
    const handlers: ((event: MessageEvent) => void)[] = [];
    const asker = { postMessage: () => {} };
    const view = {
      opener: asker,
      addEventListener: (_t: string, h: (e: MessageEvent) => void) => { handlers.push(h); },
      removeEventListener: () => { /* torn down by cleanup */ },
    } as unknown as ChannelWindow;
    const VAULT = 'aa'.repeat(32);
    const TOKEN = '02'.repeat(32);
    const ledger = async () => ({
      Transaction: {
        deserialize: () => ({
          intents: new Map([[1, { actions: [{ address: VAULT, entryPoint: 'deposit' }] }]]),
          guaranteedOffer: { inputs: [], transients: [], outputs: [{ contractAddress: VAULT }] },
          imbalances: (s: number) => new Map(s === 0 ? [[{ tag: 'shielded', raw: TOKEN }, -2500n]] : []),
        }),
      },
    }) as never;
    const CO = 'co_1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071';
    await putWallet('Everyday', 'cred-a');
    render(
      <SessionProvider>
        <ApproveEntry phase={{ name: 'locked' }} entry={null} view={view} port={localStorage}
          readLabel={async () => ({ of: 'carries', label: CO }) as never} readLedger={ledger} />
      </SessionProvider>);
    const payment = ask('balance', {
      company: CO, account: 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8', vault: VAULT, transaction: 'AAAA',
    });
    for (const h of handlers) h({ source: asker, origin: ASKER, data: payment } as unknown as MessageEvent);
    /* RED WHEN: a private deposit the page built, its coin chosen by the page, can be approved and paid: this wallet makes a private deposit whole, asked by intent. */
    await waitFor(() => expect(document.body.textContent).toContain(A_PRIVATE_DEPOSIT_IS_ASKED_BY_INTENT));
    expect(document.querySelector('[data-leaving-amount]')).toBeNull();
    expect(document.querySelector('[data-leaving-token]')?.textContent ?? '').not.toContain(TOKEN);
    expect((document.querySelector('[data-approve-window]') as HTMLButtonElement | null)?.disabled ?? true).toBe(true);
  });

  it('a wallet chosen from the list that did not sign in to the page gives nothing after the passkey, and says why there', async () => {
    const first = await putWallet('Everyday', 'cred-a');
    const second = await putWallet('Work', 'cred-b');
    rememberSignIn(localStorage, ASKER, first.fingerprint);
    mount(ask('keyring'));
    const approve = await theWindow('keyring');
    press(`[data-wallet-choice="${second.id}"]`);
    passkeyAnswers('cred-b');
    fireEvent.click(approve);
    await waitFor(() => expect(document.querySelector('[data-not-this-wallet]')).not.toBeNull(), { timeout: 5000 });
    await new Promise((r) => { setTimeout(r, 300); });
    /* RED WHEN: approving before the passkey lets a wallet that did not sign in to the page give it a key. */
    expect(answers(KEYRING)).toHaveLength(0);
  });
});

describe('a wallet picked from the list is kept for the page', () => {
  it('an ask from a page no sign-in names keeps the wallet picked, and the next window opens it with no list', async () => {
    const first = await putWallet('Everyday', 'cred-a');
    const second = await putWallet('Work', 'cred-b');
    openWallet(first.id);
    forgetOpenWallet();
    mount(ask('keyring'));
    const approve = await theWindow('keyring');
    press(`[data-wallet-choice="${second.id}"]`);
    passkeyAnswers('cred-b');
    fireEvent.click(approve);
    await waitFor(() => expect(answers(KEYRING)).toHaveLength(1), { timeout: 5000 });
    cleanup();
    openWallet(first.id);
    forgetOpenWallet();
    posted = [];
    mount(ask('keyring'));
    await theWindow('keyring');
    /* RED WHEN: the wallet picked for a page is not kept, so the list is offered again on its next ask. */
    expect(document.querySelector('[data-wallets-to-choose]')).toBeNull();
    expect(document.querySelector('[data-opens-wallet]')?.textContent).toContain('Work');
  });

  it('a picked wallet with no passkey here is said in the window, and nothing is switched or asked', async () => {
    const first = await putWallet('Everyday', 'cred-a');
    const second = await putWallet('Work', null);
    openWallet(first.id);
    forgetOpenWallet();
    mount(ask('keyring'));
    const approve = await theWindow('keyring');
    press(`[data-wallet-choice="${second.id}"]`);
    fireEvent.click(approve);
    /* RED WHEN: choosing a wallet that cannot be asked for a passkey replaces the window or fails without a word. */
    await waitFor(() => expect(document.body.textContent).toContain('Work has no passkey kept in this browser'));
    expect(document.querySelector('[data-ask-window="keyring"]')).not.toBeNull();
    expect(document.querySelector('[data-passkey-again]')).toBeNull();
    expect(mockUsePasskey).not.toHaveBeenCalled();
  });

  it('Approve and Decline sit in a bar that stays in sight at the bottom of the window', async () => {
    await putWallet('Everyday', 'cred-a');
    mount(ask('keyring'));
    await theWindow('keyring');
    const bar = document.querySelector('[data-ask-actions]') as HTMLElement;
    /* RED WHEN: the window's buttons scroll out of the frame below its warnings. */
    expect(bar.className.split(' ')).toContain('sticky');
    expect(bar.contains(document.querySelector('[data-approve-window]'))).toBe(true);
    expect(bar.contains(document.querySelector('[data-decline]'))).toBe(true);
    /* RED WHEN: a warning that must be read before Approve sits below the buttons instead of above them. */
    const warning = document.querySelector('[data-warning]') as HTMLElement;
    expect(warning.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('a key approved in the window is given at once only when nothing warns', () => {
  const NOW = 1_755_000_000_000;
  const CO = 'co_1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071';
  const ACCOUNT = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
  const carries = async (account: string) => (account === ACCOUNT ? { of: 'carries', label: CO } : { of: 'no-account' }) as never;
  const secret = newSecret();
  const identity = identityFromSecret(secret);
  const wire = (kind: 'unlock' | 'keyring', nonce: string) => ({
    schema: 'midnight-identity/disclosure-request/v1', kind, requester: { name: 'Payroll', rdns: 'example.payroll' },
    purpose: 'So the page can open your records.', nonce, expiresAt: NOW + 600_000, company: CO, account: ACCOUNT,
    ...(kind === 'keyring' ? { person: 'person-7' } : {}),
  });
  /* The opened wallet's screen, for an ask the window approved, in a window opened by the page. */
  const opened = (data: ReturnType<typeof wire>) => {
    const handlers: ((event: MessageEvent) => void)[] = [];
    const received: unknown[] = [];
    const asker = { postMessage: (message: unknown) => { received.push(message); } };
    const view = {
      opener: asker,
      addEventListener: (_t: string, h: (e: MessageEvent) => void) => { handlers.push(h); },
      removeEventListener: () => { /* torn down by cleanup */ },
    } as unknown as ChannelWindow;
    approveBeforeThePasskey(parseAsk(data, ASKER, NOW));
    render(<Approve identity={identity} secret={secret} port={localStorage} view={view} now={() => NOW} readLabel={carries} embedder={ASKER} />);
    for (const h of handlers) h({ source: asker, origin: ASKER, data } as unknown as MessageEvent);
    const given = () => received.filter((m) => (m as { schema?: unknown }).schema !== READY_PING);
    return { given };
  };
  const keyWentTo = async (origin: string) => {
    await save(localStorage, identity, recordRelease(emptyProfile(NOW), {
      at: NOW - 1000, nonce: 'earlier', recipient: { origin, name: 'Elsewhere', rdns: 'example.elsewhere' },
      company: CO as never, account: ACCOUNT as never,
    }, NOW));
  };

  it('an unlock is given with no press once the account carries the label', async () => {
    const { given } = opened(wire('unlock', 'u-at-once'));
    /* RED WHEN: an unlock approved in the window waits for the screen's own press once the wallet is open. */
    await waitFor(() => expect(given()).toHaveLength(1), { timeout: 5000 });
  });

  it('an unlock is held, with the reason above its button, when another wallet here answered the page\'s sign-in', async () => {
    rememberSignIn(localStorage, ASKER, 'another-wallet-held-here');
    const shown: Element[] = [];
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = function scrolled(this: Element) { shown.push(this); };
    const { given } = opened(wire('unlock', 'u-other'));
    await waitFor(() => expect(document.querySelector('[data-not-this-wallet]')).not.toBeNull());
    /* RED WHEN: the reason an approved ask was held is left far down the screen, out of the person's sight. */
    await waitFor(() => expect(shown).toContain(document.querySelector('[data-not-this-wallet]')));
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    await new Promise((r) => { setTimeout(r, 300); });
    /* RED WHEN: a key is given at once to a page another wallet signed in to. */
    expect(given()).toEqual([]);
  });

  it('an unlock is held, with the warning above its button, when this company\'s key went to another page before', async () => {
    await keyWentTo('https://elsewhere.example');
    const { given } = opened(wire('unlock', 'u-elsewhere'));
    await waitFor(() => expect(document.querySelector('[data-seen-elsewhere]')).not.toBeNull());
    await new Promise((r) => { setTimeout(r, 300); });
    /* RED WHEN: an unlock is given at once though the company's key went to another page before. */
    expect(given()).toEqual([]);
  });

  it('a keyring ask naming a company is held when that company\'s key went to another page before', async () => {
    await keyWentTo('https://elsewhere.example');
    const { given } = opened(wire('keyring', 'k-elsewhere'));
    await waitFor(() => expect(document.querySelector('[data-seen-elsewhere]')).not.toBeNull());
    await new Promise((r) => { setTimeout(r, 300); });
    /* RED WHEN: a keyring ask is answered at once though the company's key went to another page before. */
    expect(given()).toEqual([]);
  });
});

describe('a sign-in approved in the window waits when the address it would give warns', () => {
  it('is held, with the warning above its button, when another site already has the offered address', async () => {
    const NOW = 1_755_000_000_000;
    const secret = newSecret();
    const identity = identityFromSecret(secret);
    /* This page and another site were both given the same account before. */
    const theirs = chooseSlot(emptyProfile(NOW), ASKER).account;
    let profile = grantTo(emptyProfile(NOW), { origin: ASKER, name: 'Payroll', rdns: 'example.payroll' }, theirs, [], NOW - 2000);
    profile = grantTo(profile, { origin: 'https://elsewhere.example', name: 'Elsewhere', rdns: 'example.elsewhere' }, theirs, [], NOW - 1000);
    await save(localStorage, identity, profile);
    const data = {
      schema: 'midnight-identity/disclosure-request/v1', kind: 'sign-in', requester: { name: 'Payroll', rdns: 'example.payroll' },
      purpose: 'So the page knows it is you.', nonce: 's-shared', expiresAt: NOW + 600_000,
    };
    const handlers: ((event: MessageEvent) => void)[] = [];
    const received: unknown[] = [];
    const asker = { postMessage: (message: unknown) => { received.push(message); } };
    const view = {
      opener: asker,
      addEventListener: (_t: string, h: (e: MessageEvent) => void) => { handlers.push(h); },
      removeEventListener: () => { /* torn down by cleanup */ },
    } as unknown as ChannelWindow;
    approveBeforeThePasskey(parseAsk(data, ASKER, NOW));
    render(<Approve identity={identity} secret={secret} port={localStorage} view={view} now={() => NOW} embedder={ASKER} />);
    for (const h of handlers) h({ source: asker, origin: ASKER, data } as unknown as MessageEvent);
    await waitFor(() => expect(document.querySelector('[data-wallet-shared]')).not.toBeNull());
    await new Promise((r) => { setTimeout(r, 300); });
    /* RED WHEN: a sign-in is answered at once with an address another site already has, before the person has seen that. */
    expect(received.filter((m) => (m as { schema?: unknown }).schema !== READY_PING)).toEqual([]);
  });
});

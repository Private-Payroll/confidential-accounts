// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://identity.payroll.example/"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '../testing/render.js';
import { IDBFactory } from 'fake-indexeddb';

/*
 * A PAYING ACTION PAYS FROM ONE ACCOUNT, PICKED ONCE, IN THE WINDOW BEFORE THE PASSKEY. The window lists every wallet
 * here with its accounts by name; the passkey opens the wallet of the account picked; the action pays from that
 * account; and an opened wallet that is not the one picked pays nothing.
 */

const until = (check: () => void): Promise<void> => waitFor(check, { timeout: 15_000 });

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

vi.mock('midnight-identity/profile/act-intents', async (importOriginal) => ({
  ...await importOriginal<typeof import('midnight-identity/profile/act-intents')>(),
  ACT_INTENTS: Object.freeze({
    'private-deposit': { fields: { vault: 'vault' } },
    /* An action whose only cost from the account picked is a call's network fee. */
    'give-vault-keys': { fields: { vault: 'vault' }, calls: [{ method: 'POST', path: '/api/sent', sends: true }] },
  }),
}));

/* The account each run paid from, as the action's own step reads it. */
const paid = vi.hoisted(() => ({ accounts: [] as Array<number | undefined> }));

vi.mock('../actions/registry.js', async () => {
  const pays = {
    title: { key: 'ask.balance.vault', values: { vault: 'pays' } },
    run: async (c: { held: { account?: number }; relay(tx: string): Promise<void> }) => {
      paid.accounts.push(c.held.account);
      await c.relay('dHg1');
    },
  };
  const action = {
    headline: 'ask.act.headline',
    shown: async () => [{ key: 'ask.committee.check', from: 'action' }],
    checks: [{ key: 'ask.committee.check' }],
    check: async () => null,
    steps: () => [pays],
  };
  const acts: Record<string, unknown> = { 'private-deposit': action, 'give-vault-keys': action };
  return { ACTIONS: acts, actionFor: (name: string) => acts[name] ?? null };
});

import { Buffer as PolyfillBuffer } from 'buffer/';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import { usePasskey } from 'midnight-identity/browser';
import { verifyAssertion } from 'midnight-identity';
import type { Passkey } from 'midnight-identity/passkey/verify';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { fingerprintOf } from 'midnight-identity/recovery/pieces';
import {
  ACT_CALLED_SCHEMA, ACT_CALL_SCHEMA, ACT_ENDED_SCHEMA, ACT_RELAYED_SCHEMA, ACT_RELAY_SCHEMA, PROGRESS_SCHEMA, READY_PING,
} from 'midnight-identity/profile/channel';
import { App } from '../app.js';
import { SessionProvider } from '../session.js';
import { forgetApprovalBeforeThePasskey } from '../framing.js';
import { forgetOpenWallet, openWallet } from '../accounts/wallets-held.js';
import { saveSecret, saveWalletName } from '../accounts/storage.js';
import { savePasskey } from '../accounts/passkey-records.js';
import { saveLastUsedWallet, saveSubwalletName } from '../accounts/subwallet-record.js';
import { forgetTheEnd } from '../actions/ended-here.js';
import { Approve } from './approve.js';
import { forgetPayingPick, keepPayingPick, paysFrom } from './paying-pick.js';
import { isPayingAsk } from './approve-slot.js';
import { PaysFromAccount, PaysWhenPicked } from './approve-pays-from.js';
import { parseAsk } from 'midnight-identity/profile/request';
import type { Ask } from 'midnight-identity/profile/request';

const ASKER = 'https://app.payroll.example';
const VAULT = 'c'.repeat(64);
const mockUsePasskey = vi.mocked(usePasskey);
const mockVerifyAssertion = vi.mocked(verifyAssertion);

const passkeyFixture = (credentialId: string): Passkey => ({
  credentialId, personHandle: 'person-1', publicKeySpki: new Uint8Array([1, 2, 3]), algorithm: -7, signCount: 0,
  provenBySignIn: false, rpId: 'localhost', syncsToACloud: false, backedUpNow: false, transports: [],
});
const passkeyAnswers = (credentialId: string): void => {
  mockUsePasskey.mockResolvedValueOnce({
    credentialId, clientDataJSON: new Uint8Array(), authenticatorData: new Uint8Array(), signature: new Uint8Array(),
    userHandle: 'cGVyc29uLTE',
  } as never);
  mockVerifyAssertion.mockResolvedValueOnce({ passkey: passkeyFixture(credentialId) } as never);
};
const putWallet = async (name: string, credentialId: string) => {
  const secret = newSecret();
  const id = await saveSecret(secret);
  saveWalletName(secret, name);
  savePasskey(passkeyFixture(credentialId), id);
  return { id, secret, fingerprint: toBase64Url(fingerprintOf(secret)) };
};

let asked = 0;
const depositAsk = (): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'act',
  requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'To pay into your company\'s vault.',
  nonce: `deposit-${(asked += 1)}`,
  expiresAt: Date.now() + 20 * 60_000,
  progress: PROGRESS_SCHEMA,
  intent: { name: 'private-deposit', vault: VAULT },
});

/* The page that opened this window: it sends its ask when the wallet listens, and sends every transaction handed to it. */
let posted: Record<string, unknown>[] = [];
let asking: Record<string, unknown> | null = null;
const send = (data: unknown): void => {
  const event = new Event('message');
  Object.defineProperties(event, { data: { value: data }, origin: { value: ASKER }, source: { value: page } });
  window.dispatchEvent(event);
};
const page = {
  postMessage: (message: unknown) => {
    const m = message as Record<string, unknown>;
    posted.push(m);
    if (m['schema'] === READY_PING && asking !== null) {
      const sending = asking;
      setTimeout(() => send(sending), 0);
    }
    if (m['schema'] === ACT_RELAY_SCHEMA) {
      setTimeout(() => send({ schema: ACT_RELAYED_SCHEMA, nonce: m['nonce'], n: m['n'], outcome: 'relayed' }), 0);
    }
    if (m['schema'] === ACT_CALL_SCHEMA) {
      setTimeout(() => send({ schema: ACT_CALLED_SCHEMA, nonce: m['nonce'], n: m['n'], outcome: 'answered', status: 200, body: {} }), 0);
    }
  },
};
const of = (schema: string) => posted.filter((m) => m['schema'] === schema);
const press = (selector: string): void => {
  fireEvent.click(document.querySelector(selector) as HTMLElement);
};
/** Presses a button once it can be pressed: an Approve waits for what it approves to be read. */
const pressWhenReady = async (selector: string): Promise<void> => {
  await until(() => expect((document.querySelector(selector) as HTMLButtonElement | null)?.disabled).toBe(false));
  press(selector);
};
const approveInTheWindow = (): Promise<void> => pressWhenReady('[data-approve-window]');

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockUsePasskey.mockReset();
  mockVerifyAssertion.mockReset();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
  forgetApprovalBeforeThePasskey();
  forgetPayingPick();
  forgetTheEnd();
  posted = [];
  asking = null;
  paid.accounts = [];
  window.location.hash = '#/approve';
  Object.defineProperty(window, 'opener', { configurable: true, value: page });
});

/** Two wallets here: Everyday, and Work with its account 3 named Rent and account 7 the one open last. */
const twoWallets = async () => {
  const everyday = await putWallet('Everyday', 'cred-a');
  const work = await putWallet('Work', 'cred-b');
  saveSubwalletName(work.secret, 3, 'Rent');
  saveLastUsedWallet(work.secret, 7);
  openWallet(everyday.id);
  forgetOpenWallet();
  return { everyday, work };
};

describe('the window before the passkey of a paying action', () => {
  it('lists every wallet here with each of its accounts by name, in one list', async () => {
    const { everyday, work } = await twoWallets();
    asking = depositAsk();
    render(<SessionProvider><App /></SessionProvider>);
    await until(() => expect(document.querySelector('[data-ask-window="act"]')).not.toBeNull());
    /* RED WHEN: the window before the passkey does not list the wallets with their accounts, so the account that
     * pays is chosen after the passkey or not at all. */
    expect([...document.querySelectorAll('[data-paying-wallet]')].map((e) => e.textContent)).toEqual(['Everyday', 'Work']);
    expect(document.querySelector(`[data-pays-from="${work.id}:3"]`)?.closest('label')?.textContent).toContain('Rent');
    expect(document.querySelector(`[data-pays-from="${everyday.id}:0"]`)).not.toBeNull();
    /* RED WHEN: a second list of wallets alone is offered beside the accounts, so the person is asked twice. */
    expect(document.querySelector('[data-wallets-to-choose]')).toBeNull();
  });
});

describe('the window before the passkey says what the account picked pays', () => {
  it('a fee-only action says the fee, starts on the account kept for the site, and checks no account', async () => {
    await twoWallets();
    asking = { ...depositAsk(), intent: { name: 'give-vault-keys', vault: VAULT } };
    render(<SessionProvider><App /></SessionProvider>);
    await until(() => expect(document.querySelector('[data-accounts-to-choose]')).not.toBeNull());
    const said = document.body.textContent ?? '';
    /* RED WHEN: the window tells the person the coins of a fee-only action come from the account they pick. */
    expect(said).toContain('If a network fee for what this sends is not covered for you');
    expect(said).not.toContain('The coins come from the account you pick here');
    /* RED WHEN: the fee-only window promises balances once open, which an act that starts at once never shows. */
    expect(said).not.toContain('Balances are shown once the wallet is open');
    /* RED WHEN: a fee-only action's pick starts on a fixed account rather than the one kept for the site. */
    expect(document.querySelector('[data-pays-from-offered]')).not.toBeNull();
    expect([...document.querySelectorAll<HTMLInputElement>('[data-pays-from]')].filter((r) => r.checked)).toEqual([]);
  });

  it('a deposit says the coins, and starts on the main account of the wallet that opens', async () => {
    const { everyday } = await twoWallets();
    asking = depositAsk();
    render(<SessionProvider><App /></SessionProvider>);
    await until(() => expect(document.querySelector('[data-accounts-to-choose]')).not.toBeNull());
    /* RED WHEN: a deposit's window says only a fee is paid, or its pick no longer starts on the main account. */
    expect(document.body.textContent).toContain('The coins come from the account you pick here');
    expect(document.querySelector('[data-pays-from-offered]')).toBeNull();
    expect((document.querySelector(`[data-pays-from="${everyday.id}:0"]`) as HTMLInputElement | null)?.checked).toBe(true);
  });
});

describe('a paying action pays from the account picked before the passkey', () => {
  it('pays from the account picked, not the one open last, and asks no second choice', async () => {
    const { work } = await twoWallets();
    asking = depositAsk();
    render(<SessionProvider><App /></SessionProvider>);
    await until(() => expect(document.querySelector(`[data-pays-from="${work.id}:3"]`)).not.toBeNull());
    press(`[data-pays-from="${work.id}:3"]`);
    passkeyAnswers('cred-b');
    await approveInTheWindow();
    await until(() => expect(document.querySelector('[data-pays-from-account]')).not.toBeNull());
    /* RED WHEN: the opened window offers a second choice of the account that pays. */
    expect(document.querySelector('#approve-subwallet')).toBeNull();
    expect(document.querySelector('[data-pays-from-account]')?.textContent).toContain('Rent');
    await pressWhenReady('[data-approve]');
    await until(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1));
    /* RED WHEN: the action pays from the account open last, or one chosen for the page, rather than the one picked. */
    expect(paid.accounts).toEqual([3]);
    expect(mockUsePasskey).toHaveBeenCalledTimes(1);
  });
});

describe('an opened wallet that is not the one picked pays nothing', () => {
  it('is refused, says what resolves it, and runs nothing', async () => {
    const { everyday, work } = await twoWallets();
    asking = depositAsk();
    /* Everyday's main account is picked in the window, and the passkey prompt is left open. */
    render(<SessionProvider><App /></SessionProvider>);
    await until(() => expect(document.querySelector(`[data-pays-from="${everyday.id}:0"]`)).not.toBeNull());
    press(`[data-pays-from="${everyday.id}:0"]`);
    mockUsePasskey.mockReturnValueOnce(new Promise(() => {}) as never);
    await approveInTheWindow();
    await until(() => expect(mockUsePasskey).toHaveBeenCalledTimes(1));
    cleanup();
    /* The wallet that opens is Work. */
    openWallet(work.id);
    render(<SessionProvider><Approve identity={identityFromSecret(work.secret)} secret={work.secret} /></SessionProvider>);
    await until(() => expect(document.querySelector('[data-pays-from-refused]')).not.toBeNull());
    /* RED WHEN: a wallet other than the one picked is offered to pay, or the refusal does not say what resolves it. */
    expect(document.querySelector('[data-pays-from-refused]')?.getAttribute('data-pays-from-refused')).toBe('another-wallet');
    expect(document.querySelector('[data-pick-again]')).not.toBeNull();
    expect(document.querySelector('[data-approve]')).toBeNull();
    expect(paid.accounts).toEqual([]);
  });

  it('a paying ask reaching a wallet already open lists its accounts, runs nothing until one is picked, then pays from it', async () => {
    const { work } = await twoWallets();
    asking = depositAsk();
    openWallet(work.id);
    render(<SessionProvider><Approve identity={identityFromSecret(work.secret)} secret={work.secret} /></SessionProvider>);
    await until(() => expect(document.querySelector('[data-accounts-in-open-wallet]')).not.toBeNull());
    /* RED WHEN: a paying ask reaching an open wallet runs, or pays from the account open last, before an account is picked. */
    expect(document.querySelector('[data-approve]')).toBeNull();
    expect(document.querySelector('[data-pays-from-account]')).toBeNull();
    expect(document.querySelector('[data-pick-again]')).toBeNull();
    press('[data-pays-from-open="3"]');
    press('[data-pay-from-open]');
    await until(() => expect(document.querySelector('[data-pays-from-account]')).not.toBeNull());
    /* RED WHEN: the account picked in the open wallet is not the one the ask pays from. */
    expect(document.querySelector('[data-pays-from-account]')?.textContent).toContain('Rent');
    expect(document.querySelector('[data-accounts-in-open-wallet]')).toBeNull();
  });

  it('the pick is checked against the opened wallet by its fingerprint, and a pick for another ask is no pick', () => {
    const ask = depositAsk();
    keepPayingPick(ask, { walletId: 'w1', fingerprint: 'fp-1', account: 4 });
    /* RED WHEN: a pick is honoured for a wallet whose fingerprint differs, or for an ask it was not made for. */
    expect(paysFrom(ask, { walletId: 'w1', fingerprint: 'fp-1' })).toEqual({ of: 'picked', account: 4 });
    expect(paysFrom(ask, { walletId: 'w1', fingerprint: 'fp-2' })).toEqual({ of: 'another-wallet' });
    expect(paysFrom(depositAsk(), { walletId: 'w1', fingerprint: 'fp-1' })).toEqual({ of: 'not-picked' });
  });
});

/* A page asking this wallet to pay a deposit it built: a balance ask pays from an account as an action that pays does. */
const balanceAsk = (): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'balance',
  requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'Put money into your company vault.',
  nonce: `balance-${(asked += 1)}`,
  expiresAt: Date.now() + 600_000,
  company: 'co_1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071',
  account: 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8',
  vault: 'aa'.repeat(32),
  transaction: 'AAAA',
});

describe('every ask that pays is picked once, before the passkey', () => {
  it('a balance ask pays as an action that pays does; an ask that pays nothing does not', () => {
    const parsed = (raw: Record<string, unknown>): Ask => parseAsk(raw, ASKER, Date.now());
    /* RED WHEN: an ask that pays is left to the account chosen after the passkey, or one that pays nothing is held to a pick. */
    expect(isPayingAsk(parsed(balanceAsk()))).toBe(true);
    expect(isPayingAsk(parsed(depositAsk()))).toBe(true);
    expect(isPayingAsk({ kind: 'sign-in' } as Ask)).toBe(false);
  });

  it('the window before the passkey of a balance ask lists the accounts, and no list of wallets alone', async () => {
    const { work } = await twoWallets();
    asking = balanceAsk();
    render(<SessionProvider><App /></SessionProvider>);
    await until(() => expect(document.querySelector('[data-ask-window="balance"]')).not.toBeNull());
    /* RED WHEN: a balance ask's account is not picked in the window before the passkey. */
    expect(document.querySelector(`[data-pays-from="${work.id}:3"]`)?.closest('label')?.textContent).toContain('Rent');
    expect(document.querySelector('[data-wallets-to-choose]')).toBeNull();
  });

  it('a balance ask reaching an opened wallet with no pick lists its accounts and pays from the one picked there', async () => {
    const { work } = await twoWallets();
    asking = balanceAsk();
    openWallet(work.id);
    render(<SessionProvider><Approve identity={identityFromSecret(work.secret)} secret={work.secret} /></SessionProvider>);
    await until(() => expect(document.querySelector('[data-accounts-in-open-wallet]')).not.toBeNull());
    /* RED WHEN: a balance ask pays from the account chosen after the passkey, or the account open last. */
    expect(document.querySelector('[data-pays-from-account]')).toBeNull();
    expect(document.querySelector('#approve-subwallet')).toBeNull();
    press('[data-pays-from-open="3"]');
    press('[data-pay-from-open]');
    await until(() => expect(document.querySelector('[data-pays-from-account]')).not.toBeNull());
    expect(document.querySelector('[data-pays-from-account]')?.textContent).toContain('Rent');
  });

  it('a balance ask with an account picked in its wallet names that account and offers no second choice', async () => {
    const { work } = await twoWallets();
    asking = balanceAsk();
    keepPayingPick(parseAsk(asking, ASKER, Date.now()), { walletId: work.id, fingerprint: work.fingerprint, account: 3 });
    openWallet(work.id);
    render(<SessionProvider><Approve identity={identityFromSecret(work.secret)} secret={work.secret} /></SessionProvider>);
    await until(() => expect(document.querySelector('[data-pays-from-account]')).not.toBeNull());
    /* RED WHEN: the opened window of a balance ask names another account, or offers a second choice of it. */
    expect(document.querySelector('[data-pays-from-account]')?.textContent).toContain('Rent');
    expect(document.querySelector('#approve-subwallet')).toBeNull();
    expect(document.querySelector('[data-pays-from-refused]')).toBeNull();
  });

  it('an account another site already has is said beside the account that pays', async () => {
    const { work } = await twoWallets();
    render(<SessionProvider><PaysFromAccount request={parseAsk(depositAsk(), ASKER, Date.now())} how="before" secret={work.secret} account={3} shared={['https://other.example']} /></SessionProvider>);
    /* RED WHEN: paying from an account whose address another site holds is not said before the press. */
    expect(document.querySelector('[data-pays-from-shared]')?.textContent).toContain('https://other.example');
  });

  it('a pick is taken by the one ask it was made for: the same ask again has none', async () => {
    const { work } = await twoWallets();
    /* An ask left unanswered: the opened window waits for its own Approve. */
    asking = depositAsk();
    keepPayingPick(parseAsk(asking, ASKER, Date.now()), { walletId: work.id, fingerprint: work.fingerprint, account: 3 });
    openWallet(work.id);
    render(<SessionProvider><Approve identity={identityFromSecret(work.secret)} secret={work.secret} /></SessionProvider>);
    await until(() => expect(document.querySelector('[data-pays-from-account]')).not.toBeNull());
    cleanup();
    /* The page sends the very same ask, nonce included, to the wallet still open. */
    render(<SessionProvider><Approve identity={identityFromSecret(work.secret)} secret={work.secret} /></SessionProvider>);
    await until(() => expect(document.querySelector('[data-accounts-in-open-wallet]')).not.toBeNull());
    /* RED WHEN: an ask repeated while the wallet is open pays from the earlier pick instead of asking for its own. */
    expect(document.querySelector('[data-pays-from-account]')).toBeNull();
  });

  it('a new ask reaching the same screen is judged afresh, never by the pick of the ask before it', async () => {
    const { work } = await twoWallets();
    openWallet(work.id);
    const first = parseAsk(depositAsk(), ASKER, Date.now());
    keepPayingPick(first, { walletId: work.id, fingerprint: work.fingerprint, account: 3 });
    const shown = (a: Ask) => (
      <SessionProvider>
        <PaysWhenPicked request={a} thisWallet={work.fingerprint} secret={work.secret} onDecline={() => undefined} offered={null} render={(n) => <p data-runs-from={n} />} />
      </SessionProvider>
    );
    const { rerender } = render(shown(first));
    expect(document.querySelector('[data-runs-from]')?.getAttribute('data-runs-from')).toBe('3');
    rerender(shown(parseAsk(depositAsk(), ASKER, Date.now())));
    /* RED WHEN: the screen keeps the first ask's verdict and runs the second ask from the first ask's pick. */
    await until(() => expect(document.querySelector('[data-accounts-in-open-wallet]')).not.toBeNull());
    expect(document.querySelector('[data-runs-from]')).toBeNull();
  });

  it('reading a pick for one ask leaves none for an equal ask that arrives after it', () => {
    const ask = depositAsk();
    keepPayingPick(ask, { walletId: 'w1', fingerprint: 'fp-1', account: 4 });
    expect(paysFrom(ask, { walletId: 'w1', fingerprint: 'fp-1' })).toEqual({ of: 'picked', account: 4 });
    /* RED WHEN: the same ask, delivered again, is paid from the pick an earlier delivery already took. */
    expect(paysFrom({ ...ask }, { walletId: 'w1', fingerprint: 'fp-1' })).toEqual({ of: 'not-picked' });
    expect(paysFrom(ask, { walletId: 'w1', fingerprint: 'fp-1' })).toEqual({ of: 'not-picked' });
  });
});

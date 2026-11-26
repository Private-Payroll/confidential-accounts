import { describe, expect, it, vi, beforeEach } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { recordsKeySignedBy, directoryEntrySignedBy } from 'midnight-identity/profile/records-key';
import { signingPublicKeyOf } from '../../../../src/core/crypto.js';
import type { ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';
import { NO_VIEW_OPENED, stepOverItsCall } from './step-views.test-support.js';
import { pinnedIn } from './seats-the-words-make.test-support.js';

/*
 * **GIVING THE VAULT KEYS IN THE WALLET SIGNS ONLY FOR THE SEAT ITS OWN KEYS MAKE, AND KEEPS WHAT IT OWES BEFORE IT
 * FILES IT.** The company as the wallet read it is stood in for, and the filings the page sends are recorded in turn;
 * the roster the page serves is forged to name another seat for this signer.
 */

const t = vi.hoisted(() => ({
  refusalSeats: [] as unknown[],
  refusal: null as null | { code: string; says: string },
  order: [] as string[],
  filed: 'filed' as unknown,
  reach: null as unknown,
}));
vi.mock('./company-reach.js', async (real) => ({
  ...(await real<typeof import('./company-reach.js')>()),
  companyReachFor: async () => t.reach ?? reach(),
}));
vi.mock('../../../../src/midnight/secret-readers.js', async (real) => ({
  ...(await real<typeof import('../../../../src/midnight/secret-readers.js')>()),
  rosterRefusalOf: (input: { seats: unknown }) => { t.refusalSeats.push(input.seats); return t.refusal; },
}));
vi.mock('../../../../src/core/vault-keys.js', async (real) => ({
  ...(await real<typeof import('../../../../src/core/vault-keys.js')>()),
  rosterVaultKeys: (account: { signers: Array<{ id: string; vaultKeys?: { recordsKey: string } }> }) =>
    account.signers.map((x) => ({ signerId: x.id, userId: null, name: x.id, filingKey: '00', keys: x.vaultKeys === undefined ? null : { recordsKey: x.vaultKeys.recordsKey } })),
}));
vi.mock('../../../../packages/web-shared/src/directory-filed-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/directory-filed-here.js')>()),
  fileTheOwedDirectoryEntry: async (_id: string, owed: { read(): unknown }) => {
    t.order.push(owed.read() === null ? 'filed with nothing owed' : 'filed what was kept');
    return t.filed;
  },
}));
vi.mock('../../../../packages/web-shared/src/roster-filed-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/roster-filed-here.js')>()),
  offerVaultKeysHere: async () => { t.order.push('offered'); },
  foldOffersHere: async () => { t.order.push('folded'); return { folded: [], refused: [] }; },
}));

const { vaultKeysSteps, vaultKeysShown } = await import('./give-vault-keys.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const LEAF = 'aa'.repeat(32);
const SEAT = {
  signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32),
};
const why = (key: string, values?: Readonly<Record<string, string | number>>) => ({ key, ...(values === undefined ? {} : { values }) });
const intent = (fields: Record<string, string> = {}): ActIntent =>
  ({ name: 'create-vault', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT, ...fields } }) as ActIntent;

const ctxWith = (over: Partial<StepContext> & { answers?: Record<string, unknown> } = {}) => {
  const calls: string[] = [];
  let keys = { ...pinnedIn({ accounts: { acc_1: SEAT } } as never, LABEL, ACCOUNT), counter: 1 } as Record<string, unknown>;
  const ctx = stepOverItsCall({
    intent: intent(), asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret, wallet: { drewTheLabel: () => true } },
    at: { step: 1, steps: 3 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a vault is created through calls, never a bare relay'); },
    call: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      const a = over.answers?.[`${method} ${path}`];
      return a === undefined ? { status: 404, body: { error: 'none' } } : { status: 200, body: a };
    },
    tell: () => {},
    keyring: {
      open: () => ({ read: () => structuredClone(keys), metadata: () => ({}), seal: () => { throw new Error('not here'); }, letGo: () => {} }),
      keep: async (change: (k: never) => never) => { keys = change(structuredClone(keys) as never); t.order.push('kept'); },
    },
    ...over,
  }) as unknown as StepContext;
  return { ctx, calls, keysNow: () => keys };
};
const chainWith = (seats: string[] | { key: string }) => ({
  indexer: { indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' },
  holders: async () => (Array.isArray(seats)
    ? { seats, committee: [{ tag: 'schnorr', value: '11'.repeat(32) }], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT, founding: LEAF }
    : seats) as never,
  callState: async () => ({ blockHash: 'b1', accountState: 'AAAA', parameters: 'BBBB' }),
});
const builder = { ownSeat: async () => LEAF } as never;

const reach = (over: Record<string, unknown> = {}) => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: SEAT, leaf: LEAF, companyKey: '11'.repeat(32),
  /* The step's view of the company: this stand-in reads nothing through one. */
  stepView: NO_VIEW_OPENED,
  api: async () => { throw new Error('no call expected'); }, send: async () => ({ status: 404, body: {} }),
  holders: async () => ({ seats: [LEAF, 'bb'.repeat(32)], committee: [], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }),
  judges: { directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null }), filingJudgeFor: () => async () => null, rosterReadsFor: () => ({}) },
  sealed: {}, companyKeys: {} as never,
  roster: async () => ({ id: 'acc_1', signers: [{ id: 's1', status: 'active', leafCommitment: LEAF, vaultKeys: { recordsKey: '5a'.repeat(32) } }] }),
  builder: { companyWide: async () => '00'.repeat(32), bornHeldVault: async () => ({ vault: 'DE'.repeat(32), tx: 'AAAA' }) },
  chain: chainWith([LEAF]),
  ...over,
}) as never;

beforeEach(() => { t.refusalSeats = []; t.refusal = null; t.order = []; t.filed = 'filed'; t.reach = null; });

describe('the vault keys are given for the seat the wallet\'s own keys make', () => {
  it('keeps the owed directory entry before it is filed, then offers and folds the keys, each records key signed for the seat', async () => {
    const steps = vaultKeysSteps({ chain: () => chainWith([LEAF]) as never, builder: () => builder, now: () => 1 }, why, 'act.give-vault-keys');
    const { ctx, keysNow } = ctxWith();
    await steps.steps[0]!.run(ctx);
    await steps.steps[1]!.run(ctx);
    // RED WHEN: the entry is filed before it is kept, so a page that does not file it leaves nothing to file again
    expect(t.order).toEqual(['kept', 'filed what was kept', 'offered', 'folded']);
    const owed = (keysNow()['directoryEntriesOwed'] as Record<string, { signed: { committeeKey: never; entry: never } }>)['acc_1']!;
    const signed = await steps.given(ctx);
    // RED WHEN: the records key or the directory entry is signed for another seat than the one the wallet's own keys make
    expect(signed.signed.statement.seat).toBe(LEAF);
    expect(recordsKeySignedBy(LABEL, ACCOUNT as never, signed.signed.committeeKey as never, signed.signed.statement)).toBe(true);
    expect(directoryEntrySignedBy(LABEL, ACCOUNT as never, owed.signed.committeeKey, owed.signed.entry)).toBe(true);
    expect((owed.signed.entry as { signingKey: string }).signingKey).toBe(signingPublicKeyOf(SEAT.signingSecret as never).toLowerCase());
  });

  it('gives nothing when the roster names another seat for this signer than the wallet\'s own keys make', async () => {
    // RED WHEN: a forged roster naming a seat for this signer gets keys given for it
    const forgedReach = reach({ roster: async () => ({ id: 'acc_1', signers: [{ id: 's1', status: 'active', leafCommitment: 'bb'.repeat(32) }] }) });
    t.reach = forgedReach;
    const steps = vaultKeysSteps({ chain: () => chainWith([LEAF]) as never, builder: () => builder, now: () => 1 }, why, 'act.give-vault-keys');
    const { ctx } = ctxWith();
    const e = await steps.steps[0]!.run(ctx).catch((x) => x);
    expect((e as StepRefused).words.key).toBe('not-your-seat');
    expect(t.order).toEqual([]);
  });
});

/*
 * **A WALLET THAT HAS KEPT NO ACCOUNT FOR THE COMPANY SIGNS NOTHING HERE.** The account is pinned when the company is
 * created in the wallet or when the joining person confirms its fingerprint as they take their seat; giving vault keys
 * never pins one, whatever invitation the saved keys carry.
 */
describe('a wallet that has kept no account for the company', () => {
  const unpinnedKeys = () => {
    let keys = { accounts: { acc_1: SEAT }, counter: 1 } as Record<string, unknown>;
    return {
      open: () => ({ read: () => structuredClone(keys), metadata: () => ({}), seal: () => { throw new Error('not here'); }, letGo: () => {} }),
      keep: async (change: (k: never) => never) => { keys = change(structuredClone(keys) as never); t.order.push('kept'); },
    };
  };

  it('signs nothing and keeps nothing, and never pins the account the page names', async () => {
    t.reach = reach();
    const steps = vaultKeysSteps({ chain: () => chainWith([LEAF]) as never, builder: () => builder, now: () => 1 }, why, 'act.give-vault-keys');
    const keyring = unpinnedKeys();
    const { ctx } = ctxWith({ keyring: keyring as never });
    const e = await steps.steps[0]!.run(ctx).catch((x) => x);
    // RED WHEN: a wallet with no account kept signs a records key, or pins the page's account on a give
    expect((e as StepRefused).words).toEqual({ key: 'account-not-kept' });
    expect(t.order).toEqual([]);
    expect((keyring.open().read() as { pins?: unknown }).pins).toBeUndefined();
  });

  it('is refused, before the company is read, when it pinned the label to another account', async () => {
    t.reach = reach();
    const steps = vaultKeysSteps({ chain: () => chainWith([LEAF]) as never, builder: () => builder, now: () => 1 }, why, 'act.give-vault-keys');
    const elsewhere = pinnedIn({ accounts: { acc_1: SEAT } as never }, LABEL, 'f0'.repeat(32));
    const { ctx } = ctxWith({ keyring: { open: () => ({ read: () => structuredClone(elsewhere) }), keep: async () => { throw new Error('nothing is kept'); } } as never });
    // RED WHEN: a reach handed to the steps skips the pin check, so another account under a pinned label is given keys
    await expect(steps.steps[0]!.run(ctx)).rejects.toMatchObject({ words: { key: 'act.create-vault.why.pinned-elsewhere' } });
    expect(t.order).toEqual([]);
  });

  it('shows no account it would keep before the passkey', () => {
    const shown = vaultKeysShown({ fields: { company: LABEL, account: ACCOUNT } }, 'act.give-vault-keys');
    // RED WHEN: the window still says it may keep the page's account as the company's
    expect(shown.some((l) => l.key === 'act.give-vault-keys.shown.pin')).toBe(false);
  });
});

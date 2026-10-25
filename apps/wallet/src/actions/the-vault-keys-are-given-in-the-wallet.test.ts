import { describe, expect, it, vi, beforeEach } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import {
  INVITATION_REFUSAL, recordsKeySignedBy, directoryEntrySignedBy, seatBlinding, signDirectoryEntry, type SeatOpening,
} from 'midnight-identity/profile/records-key';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { liveLeafReader } from '../chain/seat-leaf.js';
import { signingPublicKeyOf } from '../../../../src/core/crypto.js';
import type { ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';

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
vi.mock('../../../../packages/web-shared/src/vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vault-page-doors.js')>()),
  fileTheOwedDirectoryEntry: async (_api: unknown, _id: string, owed: { read(): unknown }) => {
    t.order.push(owed.read() === null ? 'filed with nothing owed' : 'filed what was kept');
    return t.filed;
  },
}));
vi.mock('../../../../packages/web-shared/src/roster-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/roster-here.js')>()),
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
  let keys = { accounts: { acc_1: SEAT }, counter: 1 } as Record<string, unknown>;
  const ctx = {
    intent: intent(), asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret, wallet: { drewTheLabel: () => true, pinnedFor: () => ({ account: ACCOUNT, created: true }), pin: async () => {} } },
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
  } as unknown as StepContext;
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
  /* A read kept for a later step is handed to it; this one reaches no page, so there is nothing to hand over. */
  stepTo: () => {},
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
 * **A SIGNER WHO JOINED GIVES THEIR VAULT KEYS IN THE SAME WINDOW.** Their wallet has kept no account for the company
 * yet; their saved keys carry the invitation they joined by. The wallet keeps the account only when that invitation
 * checks out against the network's seats and the inviter's own opening, then signs; a page that forges it gets nothing.
 */
describe('a signer who joined, whose wallet has kept no account for the company yet', () => {
  const inviter = identityFromSecret(new Uint8Array(32).fill(9));
  const inviterKey = committeeKeyFor(inviter, LABEL) as { tag: 'schnorr'; value: string };
  const joined = async (signedBy = inviter) => {
    const salt = '7c'.repeat(32);
    const opening: SeatOpening = { publicKey: '2c'.repeat(32), scope: '3d'.repeat(32), blinding: seatBlinding(inviterKey, salt), walletKey: inviterKey, salt };
    const seat = await liveLeafReader(opening);
    return { seat, invitedBy: { committeeKey: inviterKey, opening, statement: signDirectoryEntry(signedBy, LABEL, ACCOUNT as never, new Uint8Array(32).fill(6), '2b'.repeat(32), seat) } };
  };
  const unpinned = (pins: unknown[]) => ({
    identity, secret,
    wallet: { drewTheLabel: () => false, pinnedFor: () => null, pin: async (...a: unknown[]) => { pins.push(a); } },
  });

  it('keeps the account the invitation names, as invited, and signs, when the invitation checks out', async () => {
    const { seat, invitedBy } = await joined();
    t.reach = reach({
      seat: { ...SEAT, invitedBy },
      holders: async () => ({ seats: [LEAF, seat], committee: [inviterKey], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }),
    });
    const pins: unknown[] = [];
    const steps = vaultKeysSteps({ chain: () => chainWith([LEAF, seat]) as never, builder: () => builder, now: () => 1 }, why, 'act.give-vault-keys');
    const { ctx } = ctxWith({ held: unpinned(pins) as never });
    await steps.steps[0]!.run(ctx);
    await steps.steps[1]!.run(ctx);
    // RED WHEN: a joiner's wallet with no account kept refuses to sign, so no joined signer can ever give their vault keys
    expect(t.order).toEqual(['kept', 'filed what was kept', 'offered', 'folded']);
    // RED WHEN: the account is kept as the wallet's own creation, or another account than the invitation names is kept
    expect(pins).toEqual([[LABEL, ACCOUNT, 'invited']]);
    expect((await steps.given(ctx)).signed.statement.seat).toBe(LEAF);
  });

  it('keeps nothing and signs nothing when the invitation is not signed by the seat it names', async () => {
    const { seat, invitedBy } = await joined(identityFromSecret(new Uint8Array(32).fill(13)));
    t.reach = reach({
      seat: { ...SEAT, invitedBy },
      holders: async () => ({ seats: [LEAF, seat], committee: [inviterKey], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }),
    });
    const pins: unknown[] = [];
    const steps = vaultKeysSteps({ chain: () => chainWith([LEAF, seat]) as never, builder: () => builder, now: () => 1 }, why, 'act.give-vault-keys');
    const { ctx } = ctxWith({ held: unpinned(pins) as never });
    const e = await steps.steps[0]!.run(ctx).catch((x) => x);
    // RED WHEN: an invitation its inviter did not sign gets the account kept or the keys signed
    expect((e as StepRefused).words).toEqual({ key: 'records-key-refused', values: { says: INVITATION_REFUSAL['not-signed'] } });
    expect(pins).toEqual([]);
    expect(t.order).toEqual([]);
  });

  it('keeps nothing when the inviter the invitation names holds no seat on the network', async () => {
    const { invitedBy } = await joined();
    t.reach = reach({ seat: { ...SEAT, invitedBy } });
    const pins: unknown[] = [];
    const steps = vaultKeysSteps({ chain: () => chainWith([LEAF]) as never, builder: () => builder, now: () => 1 }, why, 'act.give-vault-keys');
    const { ctx } = ctxWith({ held: unpinned(pins) as never, answers: { 'GET /api/accounts/acc_1/proposals': [] } });
    const e = await steps.steps[0]!.run(ctx).catch((x) => x);
    // RED WHEN: an inviter the network does not seat is believed
    expect((e as StepRefused).words).toEqual({ key: 'records-key-refused', values: { says: INVITATION_REFUSAL['inviter-not-on-account'] } });
    expect(pins).toEqual([]);
  });

  it('shows the account the page names and its fingerprint before the passkey, as the page\'s', () => {
    const shown = vaultKeysShown({ fields: { company: LABEL, account: ACCOUNT } }, 'act.give-vault-keys');
    // RED WHEN: the account a joiner's wallet may keep for good is not shown, with its fingerprint, before the passkey
    expect(shown).toContainEqual({ key: 'act.give-vault-keys.shown.pin', values: { account: ACCOUNT, fingerprint: companyFingerprint(LABEL as never, ACCOUNT as never) }, from: 'page' });
  });
});

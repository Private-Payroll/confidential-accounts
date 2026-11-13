import { describe, expect, it, vi } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';

/*
 * **A ONE-OFF PAYMENT IN THE WALLET FILES THE VAULT'S POOL AGAIN BEFORE IT IS FITTED.** The raise reads the vault's
 * holdings through one door (`deviceVaultHoldings`); the wallet hands it a door that files the pool again from the
 * chain and the vault's records (`vaultNotesHere`), on this seat and the coins this wallet kept, so a pool a seat that
 * left filed past its boundary is filed again here and the payment is not refused for want of a balance read first.
 * The holdings reader and the rebuild stand in here; the doors are the wallet's own.
 */

const t = vi.hoisted(() => ({
  holdings: null as null | Record<string, any>,
  rebuilt: [] as { doors: Record<string, any>; vault: string }[],
  notes: { of: 'filed', notes: [{ nonce: '0a'.repeat(32), token: '9b'.repeat(32), value: 5n }], said: [], leaver: ['a change a seat that left kept is in no pool it filed'] } as unknown,
}));
vi.mock('../../../../packages/web-shared/src/device-vault-holdings.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/device-vault-holdings.js')>()),
  deviceVaultHoldings: (doors: Record<string, any>) => { t.holdings = doors; return { isTheHoldings: true }; },
}));
vi.mock('../../../../packages/web-shared/src/vault-operation.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vault-operation.js')>()),
  vaultNotesHere: async (doors: Record<string, any>, vault: string) => { t.rebuilt.push({ doors, vault }); return t.notes; },
}));

const { raiseDoorsFor } = await import('./one-off-payment.js');

const VAULT = 'd1'.repeat(32);
const COINS = { isTheWalletsCoins: true };
const r = {
  accountId: 'acc_1', label: drawCompanyLabel(), account: 'c0'.repeat(32), leaf: 'aa'.repeat(32), companyKey: '11'.repeat(32),
  seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32) },
  api: async () => null, send: async () => ({ status: 200, body: null }),
  judges: { directoryHereFor: () => async () => ({ dir: { seats: [] } }), filingJudgeFor: () => async () => null, leavesFor: () => async () => [] },
  roster: async () => ({ id: 'acc_1', signers: [] }), companyKeys: { epoch: 0 }, holders: async () => ({ seats: [] }),
  builder: { isTheWalletsBuilder: true }, chain: { indexer: {} },
} as never;
const reach = {
  chain: () => ({}) as never, builder: () => ({}) as never, now: () => 1, pause: async () => {}, secrets: () => ({}) as never,
  kept: () => ({ payments: {} as never, charges: {} as never, coins: COINS as never }),
};
const ctx = { person: 'usr_a', signal: new AbortController().signal } as never;
const pure = { account: {} } as never;

describe('a one-off payment\'s holdings are read with a door that files the vault again', () => {
  it('files the pool again on this seat and the kept coins, and hands back the notes and what a seat that left filed', async () => {
    raiseDoorsFor(ctx, r, reach, { registry: {} } as never, pure);
    /* RED WHEN: a payment's read of the vault has no door to file it again, so it is refused until a balance read comes first. */
    expect(typeof t.holdings?.['fileAgain']).toBe('function');
    const filed = await t.holdings!['fileAgain'](VAULT, async () => true);
    expect(t.rebuilt.map((x) => x.vault)).toEqual([VAULT]);
    /* RED WHEN: the pool is filed again without this seat or without the coins this wallet kept, so a deposit only it knows is lost. */
    expect(typeof t.rebuilt[0]!.doors['seatHere']).toBe('function');
    expect(t.rebuilt[0]!.doors['kept']).toBe(COINS);
    /* RED WHEN: what a seat that left filed is held against a payment the same call's rebuild has already filed again. */
    expect(filed).toEqual({ answer: 'the-newest', said: [], notes: (t.notes as { notes: unknown }).notes });
    t.notes = { of: 'not-filed', notes: [], unexplained: 1, said: ['the vault could not be filed again'], leaver: ['a change a seat that left kept is in no pool it filed'] };
    /* RED WHEN: a re-file that failed is not named, so the payment is refused for a pool that claims too much and not for why. */
    expect(await t.holdings!['fileAgain'](VAULT, async () => true)).toEqual({
      answer: 'the-newest', said: ['a change a seat that left kept is in no pool it filed', 'the vault could not be filed again'], notes: [],
    });
    t.notes = { of: 'not-read', said: ['the chain was not read'] };
    /* RED WHEN: a vault the rebuild could not read is answered with notes, which would be counted as money the vault holds, or not said. */
    expect(await t.holdings!['fileAgain'](VAULT, async () => true)).toEqual({ answer: 'the-newest', said: ['the chain was not read'] });
  });
});

/**
 * **A DEPOSIT'S NONCE, AND THE CHECK THAT ITS COIN IS NEW.** The derivation is
 * pinned against a vector computed by a second implementation (Python's
 * `hmac` and `hashlib`, HKDF written out by hand), not against another call of
 * the same function, so a change to any byte of the domain, the layout or the
 * order of the inputs is red here.
 */
import { describe, it, expect } from 'vitest';
import {
  depositNonceAt, depositNonceKeyFor, vaultOutputHistoryFrom, noVaultOutputHistory,
  whyThisCoinIsNotNew, DepositCoinAlreadyMade, claimNewDepositCoin, lastDepositSlot,
  DEPOSIT_SLOT_ATTEMPTS, type DepositNonceKey, type DepositCoin,
} from './deposit-nonce.js';
import type { DepositJournal } from './vault-ledger.js';
import { toHex } from '../core/crypto.js';
import type { NoteEvents, ServedEvent, VaultTransactions } from './note-index.js';

const ROOT = new Uint8Array(32).map((_, i) => i + 1);
const VAULT = 'ab'.repeat(32);
const GBP = 'aa'.repeat(32);
const key = (root: Uint8Array = ROOT, vault: string = VAULT): DepositNonceKey => depositNonceKeyFor(root, vault);

describe('the key a vault\'s deposit nonces are derived from', () => {
  it('IS THE PINNED VECTOR, and one spelling of the vault is one key', () => {
    expect(toHex(key()), 'RED WHEN: two spellings of one vault derive two keys').toBe(toHex(key(ROOT, 'AB'.repeat(32))));
    expect(
      toHex(depositNonceKeyFor(ROOT, 'AB'.repeat(32))),
      'RED WHEN: the salt, the info or the fold of the vault address changes -- every deposit made before is then found only by its journal',
    ).toBe('3af8de1847ce876b1c8d46fe95fedc486b39b0d96f3d6c3b67ffb9badf0f781c');
  });

  it('differs by vault and by root, and is never the root itself', () => {
    expect(toHex(key()), 'RED WHEN: the root is used as the key, so a nonce key leaks the company key').not.toBe(toHex(ROOT));
    expect(toHex(key(ROOT, 'cd'.repeat(32))), 'RED WHEN: two vaults of one company share their nonces').not.toBe(toHex(key()));
    const other = ROOT.slice(); other[0] = 0xff;
    expect(toHex(key(other)), 'RED WHEN: the root stops being an input').not.toBe(toHex(key()));
  });

  it('REFUSES a root that is not 32 bytes, a root of zeros, and a vault that is not an address', () => {
    expect(() => depositNonceKeyFor(new Uint8Array(31).fill(1), VAULT), 'RED WHEN: a short secret is expanded anyway')
      .toThrow(/32-byte secret/);
    expect(() => depositNonceKeyFor(new Uint8Array(32), VAULT), 'RED WHEN: a secret of zeros, which anybody can derive from, is accepted')
      .toThrow(/all zeros, which is no secret/);
    expect(() => depositNonceKeyFor(ROOT, `0x${VAULT}`), 'RED WHEN: a second spelling of a vault reaches the derivation')
      .toThrow(/sixty-four hex/);
  });
});

describe('the nonce of a deposit at one slot', () => {
  const money = { token: GBP, value: 1_000_000n };

  it('IS THE PINNED VECTOR', () => {
    expect(
      depositNonceAt(key(), money, 3),
      'RED WHEN: the tag, the separator, the token, the 16-byte value or the 8-byte slot is laid out differently',
    ).toBe('02e76f223e74985f31440c1dccece3be5b8a9310ec2e67f729624831638de3cf');
  });

  it('changes with the slot, the value, the token and the key, and with nothing else', () => {
    const at3 = depositNonceAt(key(), money, 3);
    expect(depositNonceAt(key(), money, 3)).toBe(at3);
    expect(depositNonceAt(key(), money, 4), 'RED WHEN: the slot is not an input, so every deposit of one amount shares a nonce').not.toBe(at3);
    expect(depositNonceAt(key(), { ...money, value: 999_999n }, 3),
      'RED WHEN: the value is not an input, so two amounts at one slot make two coins under one nonce').not.toBe(at3);
    expect(depositNonceAt(key(), { ...money, token: 'bb'.repeat(32) }, 3), 'RED WHEN: the token is not an input').not.toBe(at3);
    expect(depositNonceAt(key(ROOT, 'cd'.repeat(32)), money, 3), 'RED WHEN: the key is not an input').not.toBe(at3);
    expect(depositNonceAt(key(), { ...money, token: GBP.toUpperCase() }, 3), 'RED WHEN: two spellings of a token derive two nonces').toBe(at3);
  });

  it('REFUSES a slot that is not a whole number from 1, and an amount the ledger cannot hold', () => {
    for (const v of [0, -1, 1.5, Number.NaN]) {
      expect(() => depositNonceAt(key(), money, v), `RED WHEN: slot ${v} derives a nonce`).toThrow(/whole slot from 1/);
    }
    expect(() => depositNonceAt(key(), { ...money, value: 0n }, 1), 'RED WHEN: a deposit of nothing derives a nonce').toThrow(/positive amount/);
    expect(() => depositNonceAt(key(), { ...money, value: 1n << 128n }, 1), 'RED WHEN: an amount wider than the ledger\'s value derives a nonce').toThrow(/positive amount/);
    expect(() => depositNonceAt(key(), { ...money, token: 'aa' }, 1), 'RED WHEN: a token that is not 32 bytes derives a nonce').toThrow(/sixty-four hex/);
    expect(() => depositNonceAt(new Uint8Array(31) as DepositNonceKey, money, 1), 'RED WHEN: a key of the wrong length derives a nonce').toThrow(/deposit nonce key/);
  });
});

describe('every coin the chain has ever created for a vault', () => {
  const out = (hash: string, commitment: string | undefined, contract: string | undefined): ServedEvent => ({
    transactionHash: hash,
    details: { tag: 'zswapOutput', ...(commitment === undefined ? {} : { commitment }), ...(contract === undefined ? {} : { contract }) },
  });
  const chain = (byTx: Record<string, ServedEvent[]>, list: string[] = Object.keys(byTx)) => {
    const read: string[] = [];
    const transactions: VaultTransactions = { of: async () => list };
    const events: NoteEvents = {
      eventsOf: async (tx) => {
        const hash = 'hash' in tx ? tx.hash : '';
        read.push(hash);
        const e = byTx[hash];
        if (!e) throw new Error(`no transaction ${hash}`);
        return e;
      },
    };
    return { transactions, events, read };
  };

  it('is every output this vault owns across every listed transaction, spent or not, and nothing another contract owns', async () => {
    const c = chain({
      t1: [out('t1', '0x' + '01'.repeat(32), VAULT.toUpperCase()), { transactionHash: 't1', details: { tag: 'zswapInput' } }],
      t2: [out('t2', '02'.repeat(32), VAULT), out('t2', '03'.repeat(32), 'cd'.repeat(32)), out('t2', '04'.repeat(32), undefined)],
    });
    const made = await vaultOutputHistoryFrom(c).everCreated(VAULT);
    expect([...made].sort(), 'RED WHEN: an output of this vault is missed, or another contract\'s or nobody\'s is counted as this vault\'s')
      .toEqual(['01'.repeat(32), '02'.repeat(32)]);
    expect(c.read, 'RED WHEN: a listed transaction is not read').toEqual(['t1', 't2']);
  });

  it('THROWS rather than answering short: an unreadable transaction, an unlistable vault, an output with no commitment', async () => {
    await expect(vaultOutputHistoryFrom(chain({ t1: [] }, ['t1', 't2'])).everCreated(VAULT),
      'RED WHEN: a transaction that cannot be read is skipped, so a coin it made is attempted again').rejects.toThrow(/no transaction t2/);
    const unlistable = { transactions: { of: async () => { throw new Error('the list stopped short'); } }, events: chain({}).events };
    await expect(vaultOutputHistoryFrom(unlistable).everCreated(VAULT), 'RED WHEN: a list that cannot be read answers empty')
      .rejects.toThrow(/stopped short/);
    await expect(vaultOutputHistoryFrom(chain({ t1: [out('t1', undefined, VAULT)] })).everCreated(VAULT),
      'RED WHEN: an output of this vault with no commitment is passed over').rejects.toThrow(/has a hole in it/);
  });

  it('a ledger given none refuses by name, saying what resolves it', async () => {
    await expect(noVaultOutputHistory().everCreated(VAULT)).rejects.toThrow(/Construct the ledger with the vault's output history/);
  });
});

describe('whether a coin is new', () => {
  it('names each place a coin can already be, and says nothing when it is in none', () => {
    const none = { poolHoldsTheNonce: false, heldNow: false, createdBefore: false };
    expect(whyThisCoinIsNotNew(none)).toBeNull();
    expect(String(whyThisCoinIsNotNew({ ...none, createdBefore: true })), 'RED WHEN: a coin the chain already made is let through').toMatch(/already created this exact coin/);
    expect(String(whyThisCoinIsNotNew({ ...none, heldNow: true })), 'RED WHEN: a coin the vault holds now is let through').toMatch(/already holds this exact coin/);
    expect(String(whyThisCoinIsNotNew({ ...none, poolHoldsTheNonce: true })), 'RED WHEN: a nonce the pool holds is let through').toMatch(/pool already holds a note/);
  });

  it('the refusal says nothing moved and what to do', () => {
    const e = new DepositCoinAlreadyMade(3, 'because');
    expect(e.name).toBe('DepositCoinAlreadyMade');
    expect(e.message).toMatch(/no money moved/);
    expect(e.message).toMatch(/read the vault again, and deposit/);
  });
});

describe('the slots a deposit may use, and how far a rebuild walks', () => {
  it('is the vault\'s output count plus the attempts, and nothing else', () => {
    expect(DEPOSIT_SLOT_ATTEMPTS, 'RED WHEN: a deposit may try a different number of slots than the walk covers').toBe(3);
    expect(lastDepositSlot(0), 'RED WHEN: the walk of an empty vault stops before the first deposit\'s slots').toBe(3);
    expect(lastDepositSlot(3_060), 'RED WHEN: the walk bound is not the count plus the attempts').toBe(3_063);
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => lastDepositSlot(bad), `RED WHEN: a count of ${bad} is walked`).toThrow(/whole number of coins/);
    }
  });
});

describe('choosing a deposit\'s coin', () => {
  const GBP_MONEY = { token: GBP, value: 500n };
  const journalOf = (lines: Array<{ slot: number; coin: DepositCoin }>): DepositJournal => ({
    nonceAt: (_vault, money, slot) => depositNonceAt(key(), money, slot),
    claim: async (_vault, money, slot, attemptedAt) => {
      const coin = { nonce: depositNonceAt(key(), money, slot), token: money.token, value: money.value };
      lines.push({ slot, coin });
      return { coin, attemptedAt };
    },
  });
  const nonceAt = (m: typeof GBP_MONEY, slot: number) => depositNonceAt(key(), m, slot);
  const commitment = (c: DepositCoin) => `c-${c.nonce}`;
  const at = (slot: number, money = GBP_MONEY) => ({ nonce: depositNonceAt(key(), money, slot), ...money });

  it('USES THE LOWEST SLOT WHOSE COIN WAS NEVER MADE, WHATEVER ELSE THE VAULT HOLDS, and hands back the coin the journal filed', async () => {
    const lines: Array<{ slot: number; coin: DepositCoin }> = [];
    /* Four outputs of other money: none of them is this money's coin at any slot. */
    const got = await claimNewDepositCoin({
      vault: VAULT, money: GBP_MONEY, journal: journalOf(lines), nonceAt,
      everCreated: new Set(['x', 'y', 'z', 'w']),
      outputCommitmentOf: commitment, heldNow: () => false, poolHoldsTheNonce: () => false,
    });
    expect(got.slot, 'RED WHEN: the slot is taken from the output count rather than from the lowest free slot').toBe(1);
    expect(got.coin, 'RED WHEN: the coin used is not the one the journal filed').toEqual(lines[0]!.coin);
    expect(lines.map((l) => l.slot), 'RED WHEN: more than one line is filed for a coin that is new').toEqual([1]);
  });

  it('OUTPUTS THE INDEXER SERVED AND THE CHAIN LATER DROPS DO NOT PUSH A DEPOSIT PAST THE SLOTS A REBUILD WALKS', async () => {
    /*
     * The measured case: the chain finally holds three coins of this money, at slots 1, 2 and 3; the indexer the
     * device read also served four outputs that the chain later dropped. Under a slot taken from the count read, the
     * deposit went to slot 8 and the rebuild, walking to the final count of four plus three, stopped at 7.
     */
    const lines: Array<{ slot: number; coin: DepositCoin }> = [];
    const real = [1, 2, 3].map((n) => commitment(at(n)));
    const dropped = ['p1', 'p2', 'p3', 'p4'];
    const got = await claimNewDepositCoin({
      vault: VAULT, money: GBP_MONEY, journal: journalOf(lines), nonceAt,
      everCreated: new Set([...real, ...dropped]),
      outputCommitmentOf: commitment, heldNow: () => false, poolHoldsTheNonce: () => false,
    });
    const finalCount = real.length + 1; /* the three the chain kept, and this deposit once it lands */
    expect(got.slot, 'RED WHEN: an output the chain may drop raises the slot').toBe(4);
    expect(got.slot, 'RED WHEN: a deposit can land past the last slot a rebuild of the final chain walks')
      .toBeLessThanOrEqual(lastDepositSlot(finalCount));
    expect(lines.map((l) => l.slot), 'RED WHEN: a line is filed for a slot that was passed over').toEqual([4]);
  });

  it('MOVES TO THE NEXT SLOT when a coin already exists anywhere, and refuses after the last', async () => {
    const lines: Array<{ slot: number; coin: DepositCoin }> = [];
    const made = new Set([commitment(at(1)), commitment(at(2))]);
    const got = await claimNewDepositCoin({
      vault: VAULT, money: GBP_MONEY, journal: journalOf(lines), nonceAt, everCreated: made,
      outputCommitmentOf: commitment, heldNow: (c) => c.nonce === at(4).nonce,
      poolHoldsTheNonce: (n) => n === at(3).nonce,
    });
    expect(got.slot, 'RED WHEN: a coin the chain made, the vault holds or the pool names is used instead of moving on').toBe(5);
    expect(lines.map((l) => l.slot), 'RED WHEN: a line is filed for a slot that was passed over').toEqual([5]);
    const stuck: Array<{ slot: number; coin: DepositCoin }> = [];
    await expect(claimNewDepositCoin({
      vault: VAULT, money: GBP_MONEY, journal: journalOf(stuck), nonceAt, everCreated: new Set(),
      /* Every slot a rebuild of this empty vault walks is taken; the one after it is free and must not be used. */
      outputCommitmentOf: commitment, heldNow: (c) => [1, 2, 3].some((n) => at(n).nonce === c.nonce), poolHoldsTheNonce: () => false,
    }), 'RED WHEN: a deposit tries past the last slot a rebuild walks, or uses a coin the vault holds').rejects.toThrow(DepositCoinAlreadyMade);
    expect(stuck, 'RED WHEN: a line is filed although no slot was free').toEqual([]);
  });

  it('A JOURNAL THAT FILES A DIFFERENT COIN FROM THE ONE DERIVED STOPS THE DEPOSIT BEFORE THE LAST CHECK', async () => {
    const lines: Array<{ slot: number; coin: DepositCoin }> = [];
    let accepted = 0;
    await expect(claimNewDepositCoin({
      vault: VAULT, money: GBP_MONEY, journal: journalOf(lines), everCreated: new Set(),
      nonceAt: (m, slot) => depositNonceAt(key(), m, slot + 1),
      outputCommitmentOf: commitment, heldNow: () => false, poolHoldsTheNonce: () => false,
      accept: () => { accepted += 1; },
    }), 'RED WHEN: the coin used is not compared with the coin the journal filed').rejects.toThrow(/filed a different coin/);
    expect(accepted).toBe(0);
  });

  it('a check that refuses the coin stops the deposit with the line filed and nothing else', async () => {
    const lines: Array<{ slot: number; coin: DepositCoin }> = [];
    await expect(claimNewDepositCoin({
      vault: VAULT, money: GBP_MONEY, journal: journalOf(lines), nonceAt, everCreated: new Set(),
      outputCommitmentOf: commitment, heldNow: () => false, poolHoldsTheNonce: () => false,
      accept: () => { throw new Error('the pool would refuse this note'); },
    }), 'RED WHEN: the last check is skipped').rejects.toThrow(/pool would refuse/);
    expect(lines).toHaveLength(1);
  });
});

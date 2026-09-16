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
  whyThisCoinIsNotNew, DepositCoinAlreadyMade, type DepositNonceKey,
} from './deposit-nonce.js';
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
    ).toBe('b2dffd6dab025e29e8ea3b54e57973d38ccb5567ccc183dddabd84f740e2ca6a');
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

describe('the nonce of the deposit filed at one version', () => {
  const money = { token: GBP, value: 1_000_000n };

  it('IS THE PINNED VECTOR', () => {
    expect(
      depositNonceAt(key(), money, 3),
      'RED WHEN: the tag, the separator, the token, the 16-byte value or the 8-byte version is laid out differently',
    ).toBe('8f51c63653fcfd3739f97c83c34368e00e6afb0de97f280f342ed3703c8dd846');
  });

  it('changes with the version, the value, the token and the key, and with nothing else', () => {
    const at3 = depositNonceAt(key(), money, 3);
    expect(depositNonceAt(key(), money, 3)).toBe(at3);
    expect(depositNonceAt(key(), money, 4), 'RED WHEN: the version is not an input, so every deposit shares a nonce').not.toBe(at3);
    expect(depositNonceAt(key(), { ...money, value: 999_999n }, 3),
      'RED WHEN: the value is not an input, so a version handed out again makes two coins under one nonce').not.toBe(at3);
    expect(depositNonceAt(key(), { ...money, token: 'bb'.repeat(32) }, 3), 'RED WHEN: the token is not an input').not.toBe(at3);
    expect(depositNonceAt(key(ROOT, 'cd'.repeat(32)), money, 3), 'RED WHEN: the key is not an input').not.toBe(at3);
    expect(depositNonceAt(key(), { ...money, token: GBP.toUpperCase() }, 3), 'RED WHEN: two spellings of a token derive two nonces').toBe(at3);
  });

  it('REFUSES a version that is not a whole number from 1, and an amount the ledger cannot hold', () => {
    for (const v of [0, -1, 1.5, Number.NaN]) {
      expect(() => depositNonceAt(key(), money, v), `RED WHEN: version ${v} derives a nonce`).toThrow(/whole version from 1/);
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
    expect(e.message).toMatch(/Find which store is the current one/);
  });
});

/**
 * **A DEPOSIT'S HISTORY CHECK ASKS THE VAULT'S COMPILED CONTRACT, AND THE
 * ANSWER IS THE LEDGER'S.**
 *
 * Before a private deposit, the coin it is about to make is looked up among
 * every coin the chain has ever created for the vault. The chain records each
 * one under the ledger's commitment; the device computes that commitment with
 * the vault's own compiled contract (`compiledOutputCommitment`), which is the
 * function the vault's circuits claim their outputs with. The two are separate
 * implementations - the contract's generated JavaScript and the ledger's
 * WebAssembly - so they are put side by side here on many coins of every kind
 * a vault is made of, and the check is timed on a vault the size of five years
 * of a fifty-person payroll.
 *
 * **WHAT THIS DOES NOT SHOW**: how long a real indexer takes to serve that
 * history. The events here are served from memory.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compiledOutputCommitment } from './rebuild-from-records.js';
import { vaultNoteCommitment, type ServedEvent } from './note-index.js';
import { changeNonceOf, sentNonceOf } from './vault-recovery.js';
import {
  depositNonceAt, depositNonceKeyFor, vaultOutputHistoryFrom, claimNewDepositCoin,
  type DepositCoin,
} from './deposit-nonce.js';
import type { DepositJournal } from './vault-ledger.js';
import { answerVaultAsk } from '../web/vault-worker-entry.js';
import * as vaultModule from '../../contracts/managed-vault/contract/index.js';
import { toHex, fromHex, type Hex } from '../core/crypto.js';

/* A fixed stream of bytes, so a disagreement is reproducible from its index. */
let counter = 0;
const bytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 32) {
    out.set(createHash('sha256').update(`history-check-${counter++}`).digest().subarray(0, Math.min(32, n - at)), at);
  }
  return out;
};
const hex32 = (): Hex => toHex(bytes(32)) as Hex;
const u128 = (bits: number): bigint => {
  const b = bytes(16);
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return bits >= 128 ? v : v & ((1n << BigInt(bits)) - 1n);
};

const MAX_U128 = (1n << 128n) - 1n;
const EDGE_VALUES = [0n, 1n, 2n, 255n, 256n, 65_535n, 1n << 32n, (1n << 53n) + 1n, (1n << 64n) - 1n, 1n << 64n, 1n << 127n, MAX_U128];
const EDGE_TOKENS: Hex[] = ['00'.repeat(32), 'ff'.repeat(32), '01' + '00'.repeat(31), '00'.repeat(31) + '01'] as Hex[];
const EDGE_NONCES: Hex[] = ['00'.repeat(32), 'ff'.repeat(32), '80' + '00'.repeat(31)] as Hex[];

interface Kinded { readonly kind: string; readonly vault: Hex; readonly coin: { nonce: Hex; token: Hex; value: bigint } }

/**
 * Every kind of coin a vault is made of: a deposit (its nonce derived from the
 * company's key), a payment's change and a split's piece (their nonces derived
 * from the spent note's), and coins at the edges of every field - with many
 * vaults, many tokens and every width of amount.
 */
const coinsOfEveryKind = (): Kinded[] => {
  const vaults = [...Array.from({ length: 24 }, hex32), '00'.repeat(32) as Hex, 'ff'.repeat(32) as Hex];
  const tokens = [...EDGE_TOKENS, ...Array.from({ length: 12 }, hex32)];
  const out: Kinded[] = [];
  const pick = <T>(xs: readonly T[], i: number) => xs[i % xs.length]!;
  for (let i = 0; i < 360; i += 1) {
    const vault = pick(vaults, i);
    const token = pick(tokens, i * 7);
    const value = i % 3 === 0 ? pick(EDGE_VALUES, i) : u128(1 + (i % 128)) || 1n;
    const deposit = { nonce: depositNonceAt(depositNonceKeyFor(bytes(32), vault), { token, value: value || 1n }, 1 + (i % 50)), token, value: value || 1n };
    out.push({ kind: 'deposit', vault, coin: deposit });
    out.push({ kind: 'change', vault, coin: { nonce: toHex(changeNonceOf(fromHex(deposit.nonce))) as Hex, token, value: deposit.value > 1n ? deposit.value - 1n : 1n } });
    out.push({ kind: 'piece', vault, coin: { nonce: toHex(sentNonceOf(fromHex(deposit.nonce))) as Hex, token, value: u128(64) || 1n } });
    out.push({ kind: 'random', vault, coin: { nonce: hex32(), token: hex32(), value: u128(128) } });
  }
  for (const vault of vaults.slice(0, 4)) {
    for (const nonce of EDGE_NONCES) for (const token of EDGE_TOKENS) for (const value of EDGE_VALUES) {
      out.push({ kind: 'edge', vault, coin: { nonce, token, value } });
    }
  }
  return out;
};

describe('a deposit\'s history check', () => {
  it('ASKS THE VAULT\'S COMPILED COMMITMENT, AND IT IS THE LEDGER\'S ON EVERY KIND OF COIN A VAULT IS MADE OF', async () => {
    const fast = await compiledOutputCommitment();
    const coins = coinsOfEveryKind();
    const kinds = new Set(coins.map((c) => c.kind));
    expect([...kinds].sort(), 'RED WHEN: a kind of coin drops out of the set compared').toEqual(['change', 'deposit', 'edge', 'piece', 'random']);
    expect(coins.length, 'RED WHEN: the set compared shrinks').toBeGreaterThan(2_000);
    const disagreeing: string[] = [];
    for (const [i, { kind, vault, coin }] of coins.entries()) {
      const ours = fast(coin, vault);
      const ledgers = await vaultNoteCommitment(coin, vault);
      if (ours !== ledgers) disagreeing.push(`${i} ${kind} ${vault} ${coin.nonce} ${coin.token} ${coin.value}`);
    }
    /* RED WHEN: the compiled commitment is asked with another recipient, a field in another place, or another vault's bytes. */
    expect(disagreeing, 'the compiled commitment and the ledger\'s disagree on these coins').toEqual([]);
  }, 60_000);

  it('REFUSES, BEFORE ANYTHING IS BUILT, A COIN THE LEDGER HAS RECORDED UNDER ITS OWN COMMITMENT', async () => {
    const fast = await compiledOutputCommitment();
    const vault = hex32();
    const key = depositNonceKeyFor(bytes(32), vault);
    const money = { token: hex32(), value: 1_000n };
    const coinAt = (slot: number): DepositCoin => ({ nonce: depositNonceAt(key, money, slot), ...money });
    const journal = (slots: number[]): DepositJournal => ({
      nonceAt: (_v, m, slot) => depositNonceAt(key, m, slot),
      claim: async (_v, m, slot, attemptedAt) => { slots.push(slot); return { coin: { nonce: depositNonceAt(key, m, slot), ...m }, attemptedAt }; },
    });
    const ask = {
      vault, money, nonceAt: (m: typeof money, slot: number) => depositNonceAt(key, m, slot),
      outputCommitmentOf: (c: DepositCoin) => fast(c, vault), heldNow: () => false, poolHoldsTheNonce: () => false,
    };
    /* Three coins of this money made, at slots 1, 2 and 3: the chain holds the ledger's commitment of each. */
    const all = new Set(await Promise.all([1, 2, 3].map((s) => vaultNoteCommitment(coinAt(s), vault))));
    const tried: number[] = [];
    let accepted = 0;
    const first = await claimNewDepositCoin({ ...ask, journal: journal(tried), everCreated: all, accept: () => { accepted += 1; } });
    expect(first.slot, 'RED WHEN: the fast check misses a coin the ledger recorded').toBe(4);
    expect(tried, 'RED WHEN: a line is filed for a coin the ledger recorded').toEqual([4]);
    expect(accepted, 'RED WHEN: a recorded coin reaches the step before the build').toBe(1);
    const some = new Set([...await Promise.all([1, 2, 4].map((s) => vaultNoteCommitment(coinAt(s), vault))), 'f1'.repeat(32)]);
    const got = await claimNewDepositCoin({ ...ask, journal: journal([]), everCreated: some });
    expect(got.slot, 'RED WHEN: a recorded coin is used, or a free slot is passed over').toBe(3);
    expect(got.coin).toEqual(coinAt(3));
  });

  it('TAKES MILLISECONDS ON A VAULT THE SIZE OF FIVE YEARS OF A FIFTY-PERSON PAYROLL, WHICH THE LEDGER\'S CODE WOULD NOT', async () => {
    /*
     * Sixty months of fifty payments, each a transaction that pays one person and
     * leaves the vault one change coin, and sixty deposits: 3,060 transactions
     * and 3,060 coins the vault owns, beside 3,000 it does not.
     */
    const vault = hex32();
    const txs: Array<{ hash: Hex; events: ServedEvent[] }> = [];
    const fast = await compiledOutputCommitment();
    const key = depositNonceKeyFor(bytes(32), vault);
    const money = { token: 'aa'.repeat(32) as Hex, value: 5_000_000n };
    for (let month = 0; month < 60; month += 1) {
      /* Every month's deposit is the same amount, so the sixty sit at slots 1 to 60 of this money. */
      const d = { nonce: depositNonceAt(key, money, month + 1), ...money };
      const h = hex32();
      txs.push({ hash: h, events: [{ transactionHash: h, details: { tag: 'zswapOutput', commitment: fast(d, vault), contract: vault, mtIndex: 0n } }] });
      for (let p = 0; p < 50; p += 1) {
        const change = { nonce: hex32(), token: 'aa'.repeat(32) as Hex, value: u128(40) };
        const ph = hex32();
        txs.push({ hash: ph, events: [
          { transactionHash: ph, details: { tag: 'zswapInput' } },
          { transactionHash: ph, details: { tag: 'zswapOutput', commitment: hex32() } },
          { transactionHash: ph, details: { tag: 'zswapOutput', commitment: fast(change, vault), contract: vault, mtIndex: 0n } },
        ] });
      }
    }
    const byHash = new Map(txs.map((t) => [t.hash, t.events]));
    const history = vaultOutputHistoryFrom({
      transactions: { of: async () => txs.map((t) => t.hash) },
      events: { eventsOf: async (tx) => byHash.get(('hash' in tx ? tx.hash : '') as Hex)! },
    });

    /* The device's own path: the worker's `commitments` ask, which a deposit's check is made through. */
    const deps = async () => ({ vault: vaultModule }) as never;
    const workerOutput = async (coin: DepositCoin) => {
      const a = await answerVaultAsk(deps, { id: 1, network: 'undeployed', ask: 'commitments', vault, coin: { nonce: coin.nonce, token: coin.token, value: coin.value.toString() } });
      if (!a.ok || a.ask !== 'commitments') throw new Error('the worker did not answer');
      return a.output;
    };
    const journal: DepositJournal = {
      nonceAt: (_v, m, slot) => depositNonceAt(key, m, slot),
      claim: async (_v, m, slot, attemptedAt) => ({ coin: { nonce: depositNonceAt(key, m, slot), ...m }, attemptedAt }),
    };

    let t = performance.now();
    const everCreated = await history.everCreated(vault);
    const readMs = performance.now() - t;
    expect(everCreated.size).toBe(3_060);
    let asked = 0;
    t = performance.now();
    const claimed = await claimNewDepositCoin({
      vault, money, journal, nonceAt: (m, slot) => depositNonceAt(key, m, slot),
      everCreated, outputCommitmentOf: (c) => { asked += 1; return workerOutput(c); },
      heldNow: () => false, poolHoldsTheNonce: () => false,
    });
    const checkMs = performance.now() - t;
    expect(claimed.slot, 'RED WHEN: a slot below the sixty-first is used although its coin was made').toBe(61);

    /*
     * One candidate through the device's path against one through the ledger's code, on the same coins: both
     * warmed first, then the median of five rounds each, so one pause in either does not decide the comparison.
     */
    const sample = Array.from({ length: 40 }, (_, i) => ({ nonce: depositNonceAt(key, money, i + 1), ...money }));
    const perCandidateUs = async (f: (c: DepositCoin) => Promise<unknown>) => {
      for (const c of sample.slice(0, 5)) await f(c);
      const rounds: number[] = [];
      for (let r = 0; r < 5; r += 1) {
        const at = performance.now();
        for (const c of sample) await f(c);
        rounds.push(((performance.now() - at) / sample.length) * 1000);
      }
      return rounds.sort((a, b) => a - b)[2]!;
    };
    const deviceUs = await perCandidateUs(workerOutput);
    const ledgerUs = await perCandidateUs((c) => vaultNoteCommitment(c, vault));

    console.log(`  five years, fifty people: ${everCreated.size} coins, read from served events in ${readMs.toFixed(1)} ms; `
      + `the deposit's check ${checkMs.toFixed(1)} ms; one candidate ${deviceUs.toFixed(0)} us on the device's path, `
      + `${ledgerUs.toFixed(0)} us through the ledger's code`);
    /* RED WHEN: the device's check is made through the ledger's general code again - twenty or more times slower here. */
    expect(deviceUs, 'the device\'s check costs what the ledger\'s code costs').toBeLessThan(ledgerUs / 4);
    /* RED WHEN: the deposit's check computes a commitment past the slot it uses - a walk of the history rather than of
     * this money's own earlier deposits. */
    expect(asked, 'the deposit\'s check computed more than its own money\'s slots').toBe(61);
  }, 60_000);
});

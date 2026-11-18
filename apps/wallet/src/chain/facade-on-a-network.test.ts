import { describe, expect, it } from 'vitest';
import * as ledger from '@midnightntwrk/ledger-v9';
import { ProtocolVersion, WalletTransaction } from '@midnightntwrk/wallet-sdk';
import { carriedBy } from './carried.js';
import {
  balancedAndGivenBack, balancingCounts, depositShaped, partReading, progressLine, verdicts, withoutTheToken,
  type PartSeen, type Seen,
} from './facade-on-a-network.js';

const TOKEN = 'e16212a8837792e6469c657984e3583d932d578c82b60e732636e5abd73791d2';
const read = (applied: number, highest: number, done: boolean, connected = true) => ({
  isConnected: connected, appliedIndex: applied, highestIndex: highest, isStrictlyComplete: () => done,
});

describe('a part is called read only when it says it has read everything', () => {
  // RED WHEN: a connected part still reading is called read.
  it('a connected part that has not finished is reading', () => {
    expect(partReading(read(5, 10, false))).toBe('reading');
  });
  // RED WHEN: a part that lost its connection is still judged by its last progress.
  it('a part that is not connected is never read, even at the tip', () => {
    expect(partReading(read(10, 10, true, false))).toBe('not connected');
  });
  it('a part that has reported nothing is no answer, and a finished one is read', () => {
    expect(partReading(undefined)).toBe('no answer');
    expect(partReading(read(10, 10, true))).toBe('read');
  });
  it('the progress line names the part, its reading and how far it got', () => {
    expect(progressLine('dust', read(3, 9, false), 61_000)).toBe('dust: reading, event 3 of 9, 61 s');
  });
});

describe('a deposit is shaped as the wallet is asked to pay one', () => {
  // RED WHEN: the shape spends a coin, or creates more or less than one coin of the token.
  it('it asks the wallet for exactly the amount of the one token, and for nothing else', () => {
    const tx = depositShaped(ledger as never, 'preprod', TOKEN, 7n) as { imbalances(s: number): Map<{ tag: string; raw?: string }, bigint> };
    const owed = [...tx.imbalances(0)].filter(([, v]) => v !== 0n).map(([k, v]) => [k.tag, k.raw, v]);
    expect(owed).toEqual([['shielded', TOKEN, -7n]]);
  });
  // RED WHEN: a deposit of nothing is shaped.
  it('a deposit of nothing is refused', () => {
    expect(() => depositShaped(ledger as never, 'preprod', TOKEN, 0n)).toThrow(/positive amount/u);
  });
  it('a token that is not a colour is refused', () => {
    expect(() => depositShaped(ledger as never, 'preprod', 'night', 1n)).toThrow(/not a token colour/u);
  });
});

const part = (over: Partial<PartSeen> = {}): PartSeen => ({ reading: 'read', readInMs: 40_000, failed: null, ...over });
const seen = (over: Partial<Seen> = {}): Seen => ({
  first: { shielded: part(), unshielded: part(), dust: part() },
  onLedger9: true,
  restartedInMs: 5_000,
  asTheWalletPaysToday: { balanced: true, counts: { transactions: 1, offers: 1, coinsSpent: 1, coinsMade: 1, dustSpends: 0, unread: 0 }, gaveBack: null },
  withItsOwnDust: { balanced: true, counts: { transactions: 1, offers: 1, coinsSpent: 1, coinsMade: 1, dustSpends: 1, unread: 0 }, gaveBack: null },
  ...over,
});

describe('the verdicts say what the run showed and nothing more', () => {
  // RED WHEN: a part that never finished is reported as working.
  it('a DUST part that never finished is seen failing, with its own words', () => {
    const lines = verdicts(seen({ first: { shielded: part(), unshielded: part(), dust: part({ reading: 'reading', readInMs: null, failed: 'Wallet.Sync: unknown block hash' }) } }));
    expect(lines).toContain('SEEN FAILING  the DUST part did not finish reading (reading): Wallet.Sync: unknown block hash.');
  });
  // RED WHEN: a part that says read without a time is still called working.
  it('a part read with no time recorded is not called working', () => {
    const lines = verdicts(seen({ first: { shielded: part({ readInMs: null }), unshielded: part(), dust: part() } }));
    expect(lines.find((l) => l.includes('the private (shielded) part'))).toMatch(/^SEEN FAILING/u);
  });
  // RED WHEN: a wallet that never reached ledger 9 is reported as acting for it.
  it('a wallet that never learned the ledger is seen failing', () => {
    expect(verdicts(seen({ onLedger9: false })).find((l) => /ledger/iu.test(l))).toMatch(/^SEEN FAILING/u);
  });
  // RED WHEN: a refused balancing is reported as balanced.
  it('a refused balancing carries the wallet\'s own words', () => {
    const lines = verdicts(seen({ withItsOwnDust: { balanced: false, said: 'Insufficient funds' } }));
    expect(lines).toContain('SEEN FAILING  a deposit balanced with the wallet\'s own DUST paying the fee: Insufficient funds');
  });
  it('a restart that was not tried is said so', () => {
    expect(verdicts(seen({ restartedInMs: null })).find((l) => l.includes('restarted'))).toMatch(/^NOT SEEN/u);
  });
  // RED WHEN: a balancing whose coins were not given back is reported as giving every coin back.
  it('a balancing whose coins were not given back is seen failing, with the failure\'s words', () => {
    const lines = verdicts(seen({ asTheWalletPaysToday: { balanced: true, counts: { transactions: 1, offers: 1, coinsSpent: 1, coinsMade: 1, dustSpends: 0, unread: 0 }, gaveBack: 'revert refused' } }));
    const line = lines.find((l) => l.includes('as the wallet pays one today'));
    expect(line).toMatch(/^SEEN FAILING/u);
    expect(line).toContain('revert refused');
    expect(lines.join('\n')).not.toMatch(/as the wallet pays one today[^\n]*every coin given back/u);
  });
});

describe('a balancing is counted off the ledger\'s own fields', () => {
  // RED WHEN: the counting reads a field the ledger's transaction does not carry, and counts nothing.
  it('a deposit shaped on the real ledger counts one offer, one coin made and nothing spent', () => {
    const shape = depositShaped(ledger as never, 'preprod', TOKEN, 1n);
    expect(balancingCounts([shape])).toEqual({ transactions: 1, offers: 1, coinsSpent: 0, coinsMade: 1, dustSpends: 0, unread: 0 });
  });
  // RED WHEN: a sealed wallet handle, as a recipe hands its transactions back, is counted as a transaction that added nothing.
  it('a wallet handle is counted only once it is opened to the ledger transaction it carries', () => {
    const shape = depositShaped(ledger as never, 'preprod', TOKEN, 1n) as { serialize(): Uint8Array };
    const handle = WalletTransaction.adopt('Unproven', shape as never, ProtocolVersion.MinSupportedVersion);
    expect(balancingCounts([handle]).unread).toBe(1);
    expect(balancingCounts([carriedBy(handle)])).toMatchObject({ unread: 0, offers: 1, coinsMade: 1 });
  });
  // RED WHEN: a balancing whose additions could not be read is called working.
  it('a balancing whose additions could not be read is not seen working', () => {
    const lines = verdicts(seen({ asTheWalletPaysToday: { balanced: true, counts: { transactions: 1, offers: 0, coinsSpent: 0, coinsMade: 0, dustSpends: 0, unread: 1 }, gaveBack: null } }));
    expect(lines.find((l) => l.includes('as the wallet pays one today'))).toMatch(/^NOT SEEN.*could not be read/u);
  });
  it('nothing to count counts nothing', () => {
    expect(balancingCounts([])).toEqual({ transactions: 0, offers: 0, coinsSpent: 0, coinsMade: 0, dustSpends: 0, unread: 0 });
  });
  // RED WHEN: a balancing with the wallet's own DUST that spent no DUST is called working.
  it('a balancing meant to pay with DUST that spent none is not seen working', () => {
    const lines = verdicts(seen({ withItsOwnDust: { balanced: true, counts: { transactions: 1, offers: 1, coinsSpent: 1, coinsMade: 1, dustSpends: 0, unread: 0 }, gaveBack: null } }));
    expect(lines.find((l) => l.includes('own DUST'))).toMatch(/^NOT SEEN.*no DUST was spent/u);
  });
});

describe('a balancing is given back however it went', () => {
  const facade = (revert: () => Promise<unknown>, balance: () => Promise<string> = async () => 'recipe') => ({
    adoptTransaction: () => 'handle', balanceUnprovenTransaction: balance, revert,
  });
  const shape = { serialize: () => new Uint8Array([1]) };
  // RED WHEN: a give-back that failed is reported as every coin given back.
  it('a failed give-back is carried with its words', async () => {
    const b = await balancedAndGivenBack(facade(async () => { throw new Error('revert refused'); }), shape, ['shielded'], () => [], (e) => String((e as Error).message));
    expect(b).toMatchObject({ balanced: true, gaveBack: 'revert refused' });
  });
  it('a refused balancing gives nothing back and carries the refusal', async () => {
    let reverted = false;
    const b = await balancedAndGivenBack(facade(async () => { reverted = true; }, async () => { throw new Error('Insufficient funds'); }), shape, ['dust'], () => [], (e) => String((e as Error).message));
    expect(b).toEqual({ balanced: false, said: 'Insufficient funds' });
    expect(reverted).toBe(false);
  });
});

describe('the project token never reaches a line', () => {
  // RED WHEN: a token left anywhere in a line is printed.
  it('every place the token sits in a line is taken out', () => {
    const line = 'RPC-CORE: disconnected from wss://rpc.example/?project_id=preprodSECRET42: 1006 (and again preprodSECRET42)';
    expect(withoutTheToken(line, 'preprodSECRET42')).toBe('RPC-CORE: disconnected from wss://rpc.example/?project_id=<project token>: 1006 (and again <project token>)');
  });
  it('with no token known, a line is left as it is', () => {
    expect(withoutTheToken('nothing here', '')).toBe('nothing here');
  });
});

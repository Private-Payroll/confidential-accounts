/**
 * The service holds no company's money, so the wallet it balances a company's transaction with adds
 * nothing of its own: a transaction short of shielded or public coins in any of its parts is refused
 * before anything is sent, and only one that needs nothing but its fee goes on to the fee payer.
 */
import { describe, expect, it } from 'vitest';
import { NothingWasSent } from '../core/jobs.js';
import { CoinlessCustomer } from './coinless-customer.js';

const BOUND = { serialize: () => new Uint8Array([1]) };
const customer = new CoinlessCustomer({ coinPublicKey: 'aa'.repeat(32), encryptionPublicKey: 'bb'.repeat(32) });
const ttl = new Date(Date.now() + 60_000);

/** A transaction whose parts are short by `short`, keyed by part; part 0 is the guaranteed part. */
const transaction = (short: Record<number, Array<[string, bigint]>>) => {
  const parts = Object.keys(short).map(Number).filter((n) => n !== 0);
  return {
    intents: new Map(parts.map((n) => [n, {}])),
    imbalances: (part: number) => new Map((short[part] ?? []).map(([tag, amount]) => [{ tag }, amount])),
    bind: () => BOUND,
    serialize: () => new Uint8Array([2]),
  };
};

describe('a company transaction balanced by the service', () => {
  it('goes on when it needs nothing but its fee', async () => {
    await expect(customer.balanceOwnLegs(transaction({ 0: [['dust', -5n]] }), ttl)).resolves.toBe(BOUND);
  });

  it('is refused when it needs public coins the service does not hold', async () => {
    await expect(customer.balanceOwnLegs(transaction({ 0: [['unshielded', -1n]] }), ttl))
      .rejects.toThrow(NothingWasSent);
  });

  it('is refused when it needs shielded coins the service does not hold', async () => {
    await expect(customer.balanceOwnLegs(transaction({ 0: [['shielded', 3n]] }), ttl))
      .rejects.toThrow(/needs coins from the company/);
  });

  it('is refused when only a later part of it is short', async () => {
    await expect(customer.balanceOwnLegs(transaction({ 0: [], 2: [['unshielded', -7n]] }), ttl))
      .rejects.toThrow(NothingWasSent);
  });

  it('is refused, with nothing sent, when it cannot be read', async () => {
    await expect(customer.balanceOwnLegs({ serialize: () => new Uint8Array() }, ttl))
      .rejects.toThrow(/could not be read/);
  });
});

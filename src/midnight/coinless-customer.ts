import { NothingWasSent } from '../core/jobs.js';
import type { CustomerWallet } from './providers.js';

/**
 * **THE COMPANY'S SIDE OF A TRANSACTION THAT MOVES NO COINS, HELD BY NOBODY.**
 *
 * Every transaction this service builds for a company's account - opening it,
 * raising and approving a round, changing its signers - calls a contract that
 * has no circuit that receives or sends a coin, so the company has nothing to
 * put in. The fee payer adds the network fee; nothing else is owed. This used
 * to be one machine's wallet, handed in for every company at once, which put
 * every company's coin legs - had there ever been any - in one wallet this
 * machine held. A company's money now comes from its own signer's wallet, on
 * their own device, with the one request that needs it: a deposit.
 *
 * **SO THIS BALANCES NOTHING AND HOLDS NOTHING.** It binds a transaction whose
 * shielded and unshielded legs already balance, and refuses one that would need
 * a coin, before anything is booked. The two public keys midnight's call builder
 * asks for are made fresh from randomness nobody keeps: no path this service
 * pays for creates a coin, and a coin made to them could never be spent.
 */
export interface CoinlessKeys {
  readonly coinPublicKey: string;
  readonly encryptionPublicKey: string;
}

interface Balancable {
  intents?: Map<number, unknown>;
  imbalances(segment: number): Map<{ tag: string }, bigint>;
  bind(): unknown;
}

const NEEDS_A_COIN =
  'this transaction needs coins from the company, and this service holds none for any company: '
  + 'a company\'s money is put in by its own signer\'s wallet, on their own device. Nothing was sent.';

export class CoinlessCustomer implements CustomerWallet {
  constructor(private readonly keys: CoinlessKeys) {}

  coinPublicKey(): string { return this.keys.coinPublicKey; }

  encryptionPublicKey(): string { return this.keys.encryptionPublicKey; }

  async balanceOwnLegs(tx: unknown, _ttl: Date): Promise<unknown> {
    const t = tx as Balancable;
    if (typeof t?.imbalances !== 'function' || typeof t.bind !== 'function') {
      throw new NothingWasSent('this transaction could not be read, so nothing was balanced. Nothing was sent.');
    }
    const segments = [0, ...(t.intents instanceof Map ? t.intents.keys() : [])];
    for (const segment of segments) {
      for (const [token, amount] of t.imbalances(segment)) {
        if ((token.tag === 'shielded' || token.tag === 'unshielded') && amount !== 0n) {
          throw new NothingWasSent(NEEDS_A_COIN);
        }
      }
    }
    return t.bind();
  }

  /** Nothing is ever booked, so there is nothing to let go. */
  async release(_booking: unknown): Promise<void> { /* nothing booked */ }
}

/** Keys for the builder, from randomness that is dropped as soon as they exist. */
export async function coinlessCustomer(): Promise<CoinlessCustomer> {
  const l: any = await import('@midnightntwrk/ledger-v9');
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keys = l.ZswapSecretKeys.fromSeed(seed);
  const out = new CoinlessCustomer({
    coinPublicKey: String(keys.coinPublicKey),
    encryptionPublicKey: String(keys.encryptionPublicKey),
  });
  seed.fill(0);
  try { keys.clear?.(); } catch { /* nothing to clear */ }
  return out;
}

/**
 * **WHERE THE MONEY IN A DEPOSIT COMES FROM, KEPT APART FROM WHAT THE VAULT
 * DOES WITH IT.**
 *
 * A deposit has two halves. The first is the SOURCE: what the company brings,
 * and how it becomes what the vault takes. The second is the vault's own
 * deposit step (`depositIntoCompanyVault`): it checks the vault and the chain,
 * chooses and records the coin on this device, builds and proves the deposit
 * in the vault worker, sends it, and records it once the chain holds it.
 *
 * A source is given two things to do and nothing else:
 *
 *   · `money` says what the vault receives from what the company chose to
 *     bring, or refuses before anything is chosen, filed or built;
 *   · `payIn` is handed the proven deposit and returns it finished, with the
 *     company's money in it. It sees the proven transaction, the company and
 *     the vault, and never the coin's nonce, the vault's secrets or the
 *     unproven transaction, because the vault's step never gives it them.
 *
 * **ONE SOURCE IS BUILT: A PRIVATE TOKEN THE COMPANY ALREADY HOLDS, PAID IN BY
 * THE SIGNER'S OWN WALLET** (`privateTokenFromTheWallet`). Another source is
 * another value of this interface, passed to `depositFromSource`; neither this
 * file's source nor the vault's step changes for it. A source whose money
 * reaches the vault as a public token ends in the vault's public deposit, which
 * is a different step of the vault's, and `endsIn` is where it will say so.
 */
import type { Hex } from '../core/crypto.js';
import { assets, ledgerFormOf, ledgerTokenOf, type AssetId, type AssetRegistry } from '../core/assets.js';
import type { DepositMoney } from '../midnight/deposit-nonce.js';
import { depositIntoCompanyVault, type DepositDoors } from './vault-operation.js';

/** What the vault's deposit step hands a source to pay in: the proven deposit, and nothing else of it. */
export interface DepositAsk {
  readonly company: Hex;
  readonly vault: Hex;
  /** The proven deposit, base64. */
  readonly transaction: string;
}

/** What a source hands back: the deposit finished with the company's money in it, base64. */
export interface PaidIn {
  readonly transaction: string;
  readonly leaves: readonly unknown[];
}

/** What the company chose to bring: an asset, and an amount in its smallest unit. */
export interface Brought {
  readonly code: AssetId;
  readonly value: bigint;
}

export interface DepositSource {
  /** The vault's step this source ends in. Every source built so far ends in the private deposit. */
  readonly endsIn: 'private-deposit';
  /** What the vault receives from what the company brought. Throws, before anything is chosen, when this source cannot bring it. */
  readonly money: (brought: Brought) => DepositMoney;
  /** Puts the company's money into the proven deposit and returns it finished. */
  readonly payIn: (ask: DepositAsk) => Promise<PaidIn>;
}

/**
 * **A PRIVATE TOKEN THE COMPANY ALREADY HOLDS, PAID IN BY THE SIGNER'S OWN
 * WALLET.** The vault receives the asset's private token, unchanged, and the
 * wallet adds the coins of that token the deposit needs. `pay` is the ask to
 * the wallet; it is given exactly what the vault's step hands this source.
 */
export function privateTokenFromTheWallet(
  pay: (ask: DepositAsk) => Promise<PaidIn>, registry: AssetRegistry = assets,
): DepositSource {
  return {
    endsIn: 'private-deposit',
    money: ({ code, value }) => {
      if (ledgerFormOf(registry.require(code), 'shielded').of !== 'token') {
        throw new Error(`${code} has no private form on Midnight, so it cannot go into a vault from your wallet's `
          + 'private balance. Nothing was chosen or sent. Choose an asset that can be held privately.');
      }
      return { token: ledgerTokenOf(code, 'shielded', registry) as Hex, value };
    },
    payIn: ({ company, vault, transaction }) => pay({ company, vault, transaction }),
  };
}

/**
 * **A DEPOSIT FROM ONE SOURCE, THROUGH THE VAULT'S ONE PRIVATE DEPOSIT STEP.**
 * The amount and the source's refusal are both asked before the vault's step
 * runs, so a deposit that cannot be brought chooses, files and builds nothing.
 */
export async function depositFromSource(
  doors: Omit<DepositDoors, 'pay'>, vault: Hex, source: DepositSource, brought: Brought,
): ReturnType<typeof depositIntoCompanyVault> {
  if (brought.value <= 0n) throw new Error('an amount of nothing is not a deposit.');
  if (source.endsIn !== 'private-deposit') {
    throw new Error('this page cannot make this kind of deposit, so nothing was chosen or sent.');
  }
  const money = source.money(brought);
  return depositIntoCompanyVault({ ...doors, pay: (ask) => source.payIn(ask) }, vault, money);
}

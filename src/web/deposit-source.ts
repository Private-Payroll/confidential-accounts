/**
 * **WHERE THE MONEY IN A DEPOSIT COMES FROM, KEPT APART FROM WHAT THE VAULT
 * DOES WITH IT.**
 *
 * A deposit has two halves. The first is the SOURCE: what the company brings,
 * and how it becomes what the vault takes. The second is one of the vault's two
 * deposit steps, and `endsIn` names which:
 *
 *   · `'private-deposit'` (`depositIntoCompanyVault`): checks the vault and the
 *     chain, chooses and records the coin on this device, builds and proves the
 *     deposit in the vault worker, sends it, and records it once the chain holds
 *     it;
 *   · `'public-deposit'` (`depositPubliclyIntoCompanyVault`): checks the vault
 *     and the chain, builds and proves the vault's public deposit of one token
 *     and one amount in the vault worker, and sends it. No coin is chosen and
 *     nothing is recorded on this device: the chain's public balance of the
 *     vault is the only record of public money.
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
 * **TWO SOURCES ARE BUILT, BOTH PAID IN BY THE SIGNER'S OWN WALLET:** a private
 * token the company already holds (`privateTokenFromTheWallet`), and a public
 * token the company already holds, put in as it is (`publicTokenFromTheWallet`).
 * Another source is another value of this interface, passed to
 * `depositFromSource`; neither the sources nor the vault's steps change for it.
 */
import type { Hex } from '../core/crypto.js';
import { assets, ledgerFormOf, ledgerTokenOf, type AssetId, type AssetRegistry } from '../core/assets.js';
import type { DepositMoney } from '../midnight/deposit-nonce.js';
import {
  depositIntoCompanyVault, depositPubliclyIntoCompanyVault, type DepositDoors, type PublicDepositMoney,
} from './vault-operation.js';

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

/** A source whose money reaches the vault as a private coin, through the vault's private deposit. */
export interface PrivateDepositSource {
  readonly endsIn: 'private-deposit';
  /** What the vault receives from what the company brought. Throws, before anything is chosen, when this source cannot bring it. */
  readonly money: (brought: Brought) => DepositMoney;
  /** Puts the company's money into the proven deposit and returns it finished. */
  readonly payIn: (ask: DepositAsk) => Promise<PaidIn>;
}

/** A source whose money reaches the vault as a public token, through the vault's public deposit. */
export interface PublicDepositSource {
  readonly endsIn: 'public-deposit';
  /** What the vault receives from what the company brought. Throws, before anything is built, when this source cannot bring it. */
  readonly money: (brought: Brought) => PublicDepositMoney;
  /** Puts the company's public money into the proven deposit and returns it finished. */
  readonly payIn: (ask: DepositAsk) => Promise<PaidIn>;
}

/** The vault's step a source ends in is named by `endsIn`, and each step takes the money its own way. */
export type DepositSource = PrivateDepositSource | PublicDepositSource;

/**
 * **A PRIVATE TOKEN THE COMPANY ALREADY HOLDS, PAID IN BY THE SIGNER'S OWN
 * WALLET.** The vault receives the asset's private token, unchanged, and the
 * wallet adds the coins of that token the deposit needs. `pay` is the ask to
 * the wallet; it is given exactly what the vault's step hands this source.
 */
export function privateTokenFromTheWallet(
  pay: (ask: DepositAsk) => Promise<PaidIn>, registry: AssetRegistry = assets,
): PrivateDepositSource {
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
 * **A PUBLIC TOKEN THE COMPANY ALREADY HOLDS, PUT IN AS IT IS, PAID IN BY THE
 * SIGNER'S OWN WALLET.** The vault receives the asset's public token, unchanged,
 * and the wallet spends that token from its public balance. What goes in, from
 * where and into which vault can be read by anyone reading the chain; the
 * wallet says so before it pays. `pay` is the ask to the wallet; it is given
 * exactly what the vault's step hands this source.
 */
export function publicTokenFromTheWallet(
  pay: (ask: DepositAsk) => Promise<PaidIn>, registry: AssetRegistry = assets,
): PublicDepositSource {
  return {
    endsIn: 'public-deposit',
    money: ({ code, value }) => {
      if (ledgerFormOf(registry.require(code), 'unshielded').of !== 'token') {
        throw new Error(`${code} has no public form on Midnight, so it cannot go into a vault from your wallet's `
          + 'public balance. Nothing was built or sent. Put it in privately instead.');
      }
      return { token: ledgerTokenOf(code, 'unshielded', registry) as Hex, value };
    },
    payIn: ({ company, vault, transaction }) => pay({ company, vault, transaction }),
  };
}

/** How money goes into a vault from the signer's wallet: privately, as a private token, or publicly, as a public one. */
export type DepositKind = 'private' | 'public';

/**
 * **HOW AN ASSET GOES IN, GIVEN THE WAY A PERSON ASKED FOR.** An asset with only
 * one form on Midnight goes in only that way, whatever was asked; `whyNotOther`
 * says why the other way is closed, in the asset's own words, or is `null` when
 * both are open.
 */
export function depositKindFor(
  code: string, asked: DepositKind, registry: AssetRegistry = assets,
): { goesIn: DepositKind; whyNot: Record<DepositKind, string | null> } {
  const found = registry.enabled().find((a) => a.code === code);
  const whyNot = (kind: DepositKind): string | null => {
    if (found === undefined) return null;
    const answer = ledgerFormOf(found, kind === 'private' ? 'shielded' : 'unshielded');
    return answer.of === 'token' ? null : answer.why;
  };
  const both = { private: whyNot('private'), public: whyNot('public') };
  const other: DepositKind = asked === 'private' ? 'public' : 'private';
  return { goesIn: both[asked] === null ? asked : other, whyNot: both };
}

/** The page's source for the way an asset goes in, paid in by the signer's own wallet through `pay`. */
export function sourceFor(
  kind: DepositKind, pay: (ask: DepositAsk) => Promise<PaidIn>, registry: AssetRegistry = assets,
): DepositSource {
  return kind === 'public' ? publicTokenFromTheWallet(pay, registry) : privateTokenFromTheWallet(pay, registry);
}

/**
 * **A DEPOSIT FROM ONE SOURCE, THROUGH THE VAULT'S STEP THAT SOURCE ENDS IN.**
 * The amount and the source's refusal are both asked before the vault's step
 * runs, so a deposit that cannot be brought chooses, files and builds nothing.
 */
export async function depositFromSource(
  doors: Omit<DepositDoors, 'pay'>, vault: Hex, source: PrivateDepositSource, brought: Brought,
): ReturnType<typeof depositIntoCompanyVault>;
export async function depositFromSource(
  doors: Omit<DepositDoors, 'pay'>, vault: Hex, source: PublicDepositSource, brought: Brought,
): ReturnType<typeof depositPubliclyIntoCompanyVault>;
export async function depositFromSource(
  doors: Omit<DepositDoors, 'pay'>, vault: Hex, source: DepositSource, brought: Brought,
): Promise<Awaited<ReturnType<typeof depositIntoCompanyVault>> | Awaited<ReturnType<typeof depositPubliclyIntoCompanyVault>>>;
export async function depositFromSource(
  doors: Omit<DepositDoors, 'pay'>, vault: Hex, source: DepositSource, brought: Brought,
): Promise<Awaited<ReturnType<typeof depositIntoCompanyVault>> | Awaited<ReturnType<typeof depositPubliclyIntoCompanyVault>>> {
  if (brought.value <= 0n) throw new Error('an amount of nothing is not a deposit.');
  if (source.endsIn === 'public-deposit') {
    const money = source.money(brought);
    return depositPubliclyIntoCompanyVault({ ...doors, pay: (ask) => source.payIn(ask) }, vault, money);
  }
  if (source.endsIn !== 'private-deposit') {
    throw new Error('this page cannot make this kind of deposit, so nothing was chosen or sent.');
  }
  const money = source.money(brought);
  return depositIntoCompanyVault({ ...doors, pay: (ask) => source.payIn(ask) }, vault, money);
}

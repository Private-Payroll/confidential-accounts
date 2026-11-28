/**
 * **WHETHER MONEY MAY GO IN OR OUT OF A VAULT, AS THIS DEVICE READS IT**: the
 * answer a screen calls (`vaultFundableHere`), and the same answer for a step
 * that goes on to refuse in its own words (`fundableOrThrow`). A deposit asks
 * `takesDepositsOrThrow`, which also refuses a vault carrying its own retired
 * mark: a vault adopted again still pays out, and takes no deposit.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { VaultNotReadHere, VaultNotTheCompanys } from './vault-start-stops.js';
import { type ChainHereDoors, type VaultChainView } from './vault-doors.js';
import {
  CIRCUITS_UNSAID,
  NOT_PINNED_WHY,
  NO_VAULT_YET,
  type VaultStandingHere,
  vaultStandingHere
} from './vault-read-here.js';
const NOT_STARTED_WHY =
  "this vault has not been started: its first secret is not set, or not every signer's sealed copy is written.";
const RETIRED_WHY =
  'this vault has been retired, so it takes no more money: the vault itself refuses a deposit once it is retired, even ' +
  "after it is adopted again. Nothing was sent and no money moved. Put the money into another of your company's vaults.";

/**
 * **WHETHER MONEY MAY GO IN OR OUT OF A VAULT, AS THIS DEVICE READS IT.** One
 * answer, every state a page can show, each with its sentence. `fundable`:
 * adopted by the company's account as the person's own wallet reads it, every
 * circuit of it and of that account the one this app was built with, pinned to
 * that account and started, all of it from the chain at the wallet's indexer
 * and never from the company's service. `not-on-chain`: that indexer
 * holds no state for the address. `not-adopted`: the account has not adopted
 * it. `unreadable`: the wallet or the indexer could not be read, or the read
 * of the vault cannot be relied on (its ledger is not this build's, or its
 * state could not be read as a vault's). `not-this-build`: a circuit of the
 * vault, or of the company's account it pays out on, is not the one this app
 * was built with (`contract` says which, `circuit` names it when one could be
 * named), so it could accept proofs this app never made. `pinned-elsewhere`:
 * pinned to another account. `not-started`: its first secret or a signer's
 * sealed copy is missing.
 */
type VaultFundableHere =
  | { readonly of: 'fundable'; readonly view: VaultChainView }
  | { readonly of: 'not-on-chain'; readonly why: string }
  | { readonly of: 'not-adopted'; readonly why: string }
  | { readonly of: 'unreadable'; readonly why: string }
  | {
      readonly of: 'not-this-build';
      readonly why: string;
      readonly contract: 'vault' | 'account';
      readonly circuit: string | null;
      readonly view: VaultChainView;
    }
  | { readonly of: 'pinned-elsewhere'; readonly why: string; readonly view: VaultChainView }
  | { readonly of: 'not-started'; readonly why: string; readonly view: VaultChainView };

/** The verdict on one read; the only place that says whether a vault may take or pay out money. */
function fundableFrom(standing: VaultStandingHere, forADoor = false): VaultFundableHere {
  if (!standing.onChain) return { of: 'not-on-chain', why: standing.view.why ?? NO_VAULT_YET };
  if (standing.unread !== null)
    return { of: 'unreadable', why: forADoor ? standing.unread.refuses : standing.unread.says };
  const circuits =
    standing.circuits === undefined
      ? { contract: 'vault' as const, circuit: null, why: CIRCUITS_UNSAID("the vault's") }
      : standing.circuits;
  if (circuits !== null) {
    return {
      of: 'not-this-build',
      why: circuits.why,
      contract: circuits.contract,
      circuit: circuits.circuit,
      view: standing.view
    };
  }
  if (!standing.pinned) return { of: 'pinned-elsewhere', why: NOT_PINNED_WHY, view: standing.view };
  if (!standing.started) return { of: 'not-started', why: NOT_STARTED_WHY, view: standing.view };
  return { of: 'fundable', view: standing.view };
}

/** A vault that carries its own retired mark: it still pays out what it holds, and takes no deposit. */
type ClosedToDeposits = { readonly of: 'retired'; readonly why: string; readonly view: VaultChainView };

/**
 * The answer, for a step that goes on to refuse in its own words: a vault in
 * any state but the readable ones is an answer, and a read that fails, or a
 * wallet that cannot say, throws `VaultNotReadHere` or `VaultNotTheCompanys`.
 */
export async function fundableOrThrow(doors: ChainHereDoors, vault: Hex, forADoor = true): Promise<VaultFundableHere> {
  return fundableFrom(await vaultStandingHere(doors, vault, true), forADoor);
}

/**
 * **WHETHER A DEPOSIT MAY GO INTO A VAULT**, for a step that goes on to refuse in its own words: `fundableOrThrow`'s
 * answer from the same one read, except that a vault whose own ledger carries its retired mark is `retired`, whatever
 * the company's account says of it now. Throws as `fundableOrThrow` does.
 */
export async function takesDepositsOrThrow(
  doors: ChainHereDoors,
  vault: Hex
): Promise<VaultFundableHere | ClosedToDeposits> {
  const standing = await vaultStandingHere(doors, vault, true);
  if (standing.onChain && standing.unread === null && standing.retired)
    return { of: 'retired', why: RETIRED_WHY, view: standing.view };
  return fundableFrom(standing, true);
}

/**
 * **THE ONE ANSWER A SCREEN CALLS** for whether money may go in or out of a
 * vault (`VaultFundableHere`). It does not throw for a vault that is not on the
 * chain, not adopted, unreadable, not this build's, pinned elsewhere or not
 * started; each is a state. Read on this device from the chain at the wallet's indexer and the
 * person's own wallet; the company's service is not asked.
 */
export async function vaultFundableHere(doors: ChainHereDoors, vault: Hex): Promise<VaultFundableHere> {
  try {
    return await fundableOrThrow(doors, vault, false);
  } catch (e) {
    if (e instanceof VaultNotTheCompanys) {
      return { of: e.kind === 'not-adopted' ? 'not-adopted' : 'unreadable', why: e.message };
    }
    if (e instanceof VaultNotReadHere) return { of: 'unreadable', why: e.message };
    throw e;
  }
}

import type { AccountAddress } from 'midnight-identity/profile/company-label';
import type { AccountHolders } from 'midnight-identity/profile/records-key';
import type { BuiltOnHereDoors, ChainHereDoors, VaultAsTheWalletRead, VaultChainView, VaultOnChainDoors } from './vault-doors.js';
import { type CircuitNotThisBuilds, VaultNotReadHere, VaultNotTheCompanys, VaultStartOwed } from './vault-start-stops.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { PayoutChainOnTheWire, VaultBuilderClient } from './vault-worker-client.js';

/**
 * **THE VAULT IS ONE THE COMPANY'S ACCOUNT ADOPTED, AS THE CHAIN SHOWS IT, AND
 * NEVER AS THE SERVICE SAYS.** Read by the signer's own wallet for this step:
 * the vault is in the set of vaults the company's account itself has adopted.
 * Answers who holds the account, as read, for the step to go on with.
 */
export async function theVaultAsItsSignersHoldIt(doors: VaultOnChainDoors, vault: Hex): Promise<AccountHolders> {
  let read: VaultAsTheWalletRead;
  try {
    read = await doors.onChain(vault);
  } catch (e) {
    throw new VaultNotTheCompanys(vault, `your wallet could not say who holds this vault's company (${(e as Error)?.message ?? e}).`, 'wallet-silent');
  }
  if (!read.holders.adoptedVaults.includes(String(vault).toLowerCase())) {
    throw new VaultNotTheCompanys(vault, 'this vault is not one your company\'s account has adopted, as your own wallet read the '
      + 'chain, so nothing is put into or paid from it.', 'not-adopted');
  }
  return read.holders;
}

/**
 * **THE VAULT AS THE CHAIN HOLDS IT, READ ON THIS DEVICE**: its state, its
 * notes, every coin ever made for it, the account it is pinned to and whether
 * it is started, read by this device's vault worker at the indexer the
 * person's own wallet names. With `account`, the worker also says whether that
 * account's circuits are this app's.
 *
 * Nothing of it is the service's answer; when the wallet names no indexer
 * nothing is read, and a read that fails is a `VaultNotReadHere`.
 *
 */
export async function readHere(
  doors: Pick<ChainHereDoors, 'builder' | 'indexer'>, vault: Hex, account?: AccountAddress,
): Promise<Awaited<ReturnType<VaultBuilderClient['vaultOnChain']>>> {
  const indexer = await theWalletsIndexer(doors, vault);
  let read: Awaited<ReturnType<VaultBuilderClient['vaultOnChain']>>;
  try {
    read = await doors.builder.vaultOnChain(
      account === undefined ? { vault, indexer } : { vault, account: String(account).toLowerCase(), indexer });
  } catch (e) {
    throw new VaultNotReadHere(vault, `this device could not read the vault from the chain (${(e as Error)?.message ?? e}).`, { cause: e });
  }
  return read;
}

/** The indexer the person's own wallet reads the chain through, or a refusal by name: nothing is read anywhere else. */
export async function theWalletsIndexer(
  doors: Pick<ChainHereDoors, 'indexer'>, vault: Hex,
): Promise<{ readonly indexerUri: string; readonly indexerWsUri: string }> {
  const indexer = await doors.indexer();
  if (indexer === null) {
    throw new VaultNotReadHere(vault, 'your wallet did not say which indexer it reads the chain through, so this device '
      + 'cannot read the vault itself. Unlock your wallet for this company again, then try again.');
  }
  return indexer;
}

/**
 * **WHAT A STEP OUT OF THE VAULT IS BUILT ON, READ ON THIS DEVICE AT ONE
 * BLOCK**: the vault's state, the commitment tree, the ledger's parameters and
 * the state of the account the vault is pinned to, read by this device's vault
 * worker at the indexer the person's own wallet names. The account is the one
 * this device holds for the company, never one an answer names.
 */
export async function chainAtOneBlockHere(
  doors: BuiltOnHereDoors, vault: Hex,
): Promise<PayoutChainOnTheWire & { readonly account: Hex }> {
  const indexer = await theWalletsIndexer(doors, vault);
  let chain: (PayoutChainOnTheWire & { readonly account: Hex }) | null;
  try {
    chain = await oneBlockOrNotYet(doors, vault, indexer);
  } catch (e) {
    throw new VaultNotReadHere(vault, `this device could not read the chain at one block (${(e as Error)?.message ?? e}).`);
  }
  if (chain === null) {
    throw new VaultNotReadHere(vault, 'the chain your wallet reads does not hold this vault and your company\'s account '
      + 'at one block yet. Try again shortly.');
  }
  return chain;
}

/**
 * Both contracts at one block, read by the vault worker at `indexer`, or null when the chain there does not hold the
 * vault and the company's account yet. A read that fails throws the worker's own error, unwrapped.
 */
export async function oneBlockOrNotYet(
  doors: Pick<BuiltOnHereDoors, 'account' | 'builder'>, vault: Hex,
  indexer: { readonly indexerUri: string; readonly indexerWsUri: string },
): Promise<(PayoutChainOnTheWire & { readonly account: Hex }) | null> {
  const account = String(doors.account).toLowerCase() as Hex;
  const chain = await doors.builder.chainAtOneBlock({ vault, account, indexer });
  return chain === null ? null : { ...chain, account };
}

export const NO_VAULT_YET = 'the chain shows no vault at this address yet.';

/** The vault's state, notes and every coin ever made for it, as one read on this device found them; nothing of who holds it. */
export function notesOfARead(vault: Hex, read: Awaited<ReturnType<VaultBuilderClient['vaultOnChain']>>): VaultChainView {
  if (!read.onChain) return { vault, onChain: false, why: NO_VAULT_YET };
  return {
    vault, onChain: true, state: read.state,
    ...(read.notes === undefined ? {} : { notes: read.notes as Hex[] }),
    ...(read.nonceCommitment === undefined ? {} : { nonceCommitment: read.nonceCommitment }),
    ...(read.splitJournal === undefined ? {} : { splitJournal: read.splitJournal }),
    notesFromThisBuild: read.notesFromThisBuild,
    ...(read.notesWhy === undefined ? {} : { notesWhy: read.notesWhy }),
    everCreated: read.everCreated,
  };
}

/**
 * **THE VAULT AS ITS START READS IT, ON THIS DEVICE**: its notes and every coin
 * ever made for it, as this device's worker and the person's own wallet read
 * them. Whether it is started is not asked: this is the read a start is carried
 * on from. It reads the company's account too, and whether the circuits of
 * the vault and the account are the ones this app was built with. `refusal`
 * says why the start goes no further from this read (the read cannot be relied
 * on, a circuit is not this app's or the read did not say, or the vault is not
 * pinned to the company's account), and is null when it can.
 */
export async function theVaultReadForItsStart(
  doors: ChainHereDoors, vault: Hex,
): Promise<{ readonly view: VaultChainView; readonly refusal: string | null }> {
  try {
    const standing = await vaultStandingHere(doors, vault, true);
    return { view: standing.view, refusal: startRefusalFrom(standing) };
  } catch (e) {
    if (e instanceof VaultNotReadHere || e instanceof VaultNotTheCompanys) throw new VaultStartOwed(vault, (e as Error).message);
    throw e;
  }
}

export const NOT_PINNED_WHY = 'this vault is not pinned to your company\'s account, or its state is not a vault\'s, as the chain shows it, so '
  + 'money in it would be paid out on somebody else\'s approvals; no money goes in or out of it.';
const ACCOUNT_UNREAD_WHY = 'this vault\'s state could not be read as a vault\'s, so which account it is pinned to and whether it is started '
  + 'are not known; no money goes in or out of it.';

/** One read of a vault on this device, before any verdict on whether money may go in or out. */
export type VaultStandingHere =
  | { readonly onChain: false; readonly view: VaultChainView }
  | {
    readonly onChain: true;
    readonly view: VaultChainView;
    /**
     * Why the read cannot be relied on (the account or the start flag could not be read, or the ledger is not this build's), or
     * null when it can: `says` is the answer's sentence, `refuses` the words the doors that move money and the start give.
     */
    readonly unread: { readonly says: string; readonly refuses: string } | null;
    readonly pinned: boolean;
    readonly started: boolean;
    /**
     * Read for money and for a start: the first circuit of the vault or of the company's account that is not the one
     * this app was built with, or null when every one is. A read that did not say counts as not this app's.
     */
    readonly circuits?: CircuitNotThisBuilds | null;
  };

export const CIRCUITS_UNSAID = (whose: string) => `this device's read did not say whether ${whose} circuits are the ones this app was `
  + 'built with, so no money goes in or out of this vault.';
const CIRCUITS_CHANGED = ' If the company\'s super admins moved it to a newer build, it stays refused on this device until this '
  + 'device runs that build.';

/** The first contract whose circuits are not this app's, the vault before the account, or null. */
export function circuitsOfARead(read: Extract<Awaited<ReturnType<VaultBuilderClient['vaultOnChain']>>, { onChain: true }>): CircuitNotThisBuilds | null {
  if (read.circuits === undefined) return { contract: 'vault', circuit: null, why: CIRCUITS_UNSAID('the vault\'s') };
  if (read.circuits !== null) return { contract: 'vault', circuit: read.circuits.circuit, why: read.circuits.why + CIRCUITS_CHANGED };
  if (read.accountCircuits === undefined) return { contract: 'account', circuit: null, why: CIRCUITS_UNSAID('the company\'s account\'s') };
  if (read.accountCircuits !== null) {
    return { contract: 'account', circuit: read.accountCircuits.circuit, why: read.accountCircuits.why + CIRCUITS_CHANGED };
  }
  return null;
}

/**
 * **THE ONE READ OF A VAULT ON THIS DEVICE**: its notes, whether it is pinned to
 * the company's account the person's own wallet reads, and whether it is
 * started, with no verdict. Who holds the vault or the account is never read
 * here: which keys hold each contract is the super admins' own choice, and a
 * change of them left half done stops no payment and no deposit. The wallet is
 * asked only whether the account adopted the vault. A read that fails, or a
 * wallet that cannot say, throws `VaultNotReadHere` or `VaultNotTheCompanys`. `withCircuits` also reads the
 * company's account and whether the circuits of both are this app's: money and
 * a start read them, a rebuild reads neither.
 */
export async function vaultStandingHere(doors: ChainHereDoors, vault: Hex, withCircuits = false): Promise<VaultStandingHere> {
  const read = await readHere(doors, vault, withCircuits ? doors.account : undefined);
  if (!read.onChain) return { onChain: false, view: notesOfARead(vault, read) };
  /* The worker reports no account when the vault's state could not be read as a vault's; that is not a vault pinned elsewhere. */
  const layout = 'this vault is not laid out the way this version of the product reads one, so what it holds and whether it is started '
    + `are not known; no money goes in or out of it${read.notesWhy === undefined ? '' : ` (${read.notesWhy})`}.`;
  const unread = read.account === null
    ? { says: ACCOUNT_UNREAD_WHY, refuses: NOT_PINNED_WHY }
    : !read.notesFromThisBuild ? { says: layout, refuses: layout } : null;
  /* A read that cannot be relied on is judged before the wallet is asked whether the account adopted the vault. */
  if (unread === null) await theVaultAsItsSignersHoldIt(doors, vault);
  /* A vault pays out on the approvals of the account it is pinned to; a state that names none is not a vault's. */
  const pinned = read.account !== null && read.account.toLowerCase() === String(doors.account).toLowerCase();
  return {
    onChain: true, view: notesOfARead(vault, read), unread, pinned, started: read.started,
    ...(withCircuits ? { circuits: circuitsOfARead(read) } : {}),
  };
}

/** Why a start goes no further from this read: the same read and order as the answer, judged for the start, which does not ask whether it is started. */
function startRefusalFrom(standing: VaultStandingHere): string | null {
  if (!standing.onChain) return null;
  if (standing.unread !== null) return standing.unread.refuses;
  const circuits = standing.circuits === undefined ? { why: CIRCUITS_UNSAID('the vault\'s') } : standing.circuits;
  if (circuits !== null) return circuits.why;
  return standing.pinned ? null : NOT_PINNED_WHY;
}

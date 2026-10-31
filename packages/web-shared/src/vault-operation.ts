/**
 * **CREATING A COMPANY'S VAULT (WHICH ALSO OPENS ITS POOL), PUTTING MONEY IN IT
 * AND PAYING SOMEBODY OUT OF IT, FROM A SIGNER'S OWN DEVICE.**
 *
 * Each of the three is one operation a person starts with one press. Everything
 * it touches is handed in, so the same order runs in a test against the ledger's
 * own objects. The file also holds the public forms of a deposit and a payment
 * (`depositPubliclyIntoCompanyVault`, `payPubliclyFromCompanyVault`) and the
 * rebuilding of a vault's notes from the chain (`vaultNotesHere`).
 *
 * ── CREATING A VAULT IS ONE OPERATION WITH NO SUCCESS STATE UNTIL THE END ──
 *
 *   1. the committee the vault is born held by is the one holding the
 *      company's account, at its threshold, as this signer's own wallet reads
 *      it off the chain: the super admins, whoever they are. No signer's key
 *      is asked for it, and a committee no contract may be held by builds no
 *      vault;
 *   2. the vault is built here held by that committee from its first
 *      transaction: there is no temporary key and no hand-over;
 *   3. the deploy is sent;
 *   4. as soon as the chain has the vault, this device reads it as it was born,
 *      from the deploy its address was made from, and refuses it unless it was
 *      held by the committee at counter 0, ran this build's circuits and wrote
 *      nothing;
 *   5. the vault is STARTED, each step raised only once the chain shows the one
 *      before:
 *        a. the company's account adopts it: the adoption round is raised,
 *           approved by this signer and carried out;
 *        b. its note pool and nonce secret are filed through the company's
 *           records route, and the secret is READ BACK and opened here;
 *        c. the first secret run is raised from what was read back, approved
 *           by this signer, and the secret set under it;
 *        d. every signer's sealed copy of the secret is written into the vault.
 *      The operation ends `started` when the chain shows every copy written.
 *      The adoption and the first secret run are each written down as a
 *      proposal of the company's, sealed and signed by this seat, in the same
 *      request as their raise (`proposedAndWrittenDown`), and one the chain
 *      holds with no record is written down on the next press, so the company's
 *      proposals hold a record of each; the record of the run carries nothing
 *      the vault's secret is made of. A seat whose role may not raise a
 *      proposal sets up no vault.
 *
 * **ANYTHING SHORT OF THE END IS A FAILURE THAT NAMES THE VAULT**
 * (`VaultStartOwed`, or `VaultNotTheCompanys` for a vault not born held),
 * or, for a company whose rounds need more approvals than this signer's, the
 * named state `awaiting-approvals`, saying which round waits for how many.
 * Running the operation again for that vault carries on from what the chain
 * shows, and every step already on the chain is passed over. The vault itself
 * takes no money until the end, and the service carries none into it either.
 *
 * ── A DEPOSIT ──
 *
 * The coin is chosen and recorded on this device (`deposit-on-device.ts`). The
 * call is built and proved in the vault worker, with the ledger parameters the
 * chain holds now, read from the same route a payment out is built on. The
 * person's own wallet adds the coin and signs, and the service adds the network
 * fee and sends it. The vault's note pool records the new note only once the
 * chain holds it, with the transaction that made it.
 *
 * ── A PRIVATE PAYMENT OUT ──
 *
 * The pool is opened here, with this signer's own key, and the note to spend is
 * chosen here; nothing that opens a note leaves this device. The note's place
 * in the chain's commitment tree is read from the events of the transaction
 * that created it; the payment is written into the vault's payment journal
 * BEFORE anything is proved; the payment is built and proved here against one
 * block's view of the vault and the account; the service adds the network fee
 * and sends it; and the pool is advanced - the note gone, its change added with
 * the transaction that made it - only once the chain shows both.
 */
import { refuseLeavingAVaultShort, type ApproverRoster } from '../../../src/core/vault-approvers.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { Committee } from '../../../src/midnight/vault-committee.js';
import { MOST_READER_NAME, MOST_SECRET_READERS, whyNotInstallable, type FirstSecretShown } from 'midnight-identity/profile/request';
import type { DepositMoney } from '../../../src/midnight/deposit-nonce.js';
import {
  SealedNotePool, assertNoSignerWouldLoseAccess, isALostPoolRace, openPool, passedOverAbove, sealPool,
  type FiledPoolVersion, type PassedOverVersion, type PoolSigner, type SealedPool,
} from '../../../src/midnight/vault-pool.js';
import { afterDeposit } from '../../../src/midnight/vault-note-deposit.js';
import type { Note } from '../../../src/midnight/vault-notes.js';
import { PaymentJournalInStore, attemptKey, attemptsFromJournalVersions } from '../../../src/midnight/vault-journal.js';
import { coinsFileRead, coinsFileText, type CoinKept, type CoinsFileCompany, type CoinsKeptHere } from './vault-coins-kept-here.js';
import { STEP_LIMITS } from '../../../src/midnight/payment-plan.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import type { EventOnTheWire, NoteOnTheWire } from './vault-builder.js';
import { openNonceSecrets, recordsKeypairFrom, refileNonceSecret, type NonceSecretReader } from '../../../src/midnight/company-nonce-secret.js';
import { openSecretCopy, sealSecretCopy } from '../../../src/midnight/sealed-secret-copy.js';
import {
  READER_REFUSAL, readerRefusalOf, type DirectoryAsBelieved, type ReaderRefusalCode, type SeatsAsTheWalletRead,
} from '../../../src/midnight/secret-readers.js';
import type { RosterVaultKeys } from '../../../src/core/vault-keys.js';
import { fromHex, signingPublicKeyOf, toHex, type Sealed } from '../../../src/core/crypto.js';
import { sealingWith, type KeysHeld } from '../../../src/core/company-key.js';
import { DEVICE_RAISE_VERSION } from '../../../src/core/device-raise.js';
import {
  ADOPT_VAULT, newProposalId, proposalFilingRefusal, sealGovernanceProposal, sealVaultSecretProposal, signProposalFiling,
} from '../../../src/core/proposal-filing.js';
import { proposalEntry } from '../../../src/midnight/record-manifest.js';
import { mayFile } from '../../../src/midnight/seat-directory.js';
import { kindAsked, listedHere, seatNotBelievedHere, type DirectoryRead } from './vault-page-doors.js';
import { believedFilerHere } from './round-opened-here.js';
import { fileVaultInfoHere, VaultInfoChanged, VaultInfoRefused, type VaultInfoRecords } from './vault-info-here.js';
import { vaultInfoTidied } from '../../../src/midnight/vault-info-record.js';
import type { GovernedCallService } from './governed-call-on-device.js';
import type { RecordsEntered } from './record-entered-here.js';
import type { Role, SealedProposal } from '../../../src/core/types.js';
import { NO_ASSET } from '../../../src/core/assets.js';
import type { GovernedCallOrder, OpenedRound, SignerMaterial } from './governed-call-builder.js';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import {
  fileThePoolTheChainHolds,
  depositCoinOnThisDevice, fileTheChainsSecretAsTheNewest, startVaultNonceSecretAgainOnThisDevice,
  startVaultNonceSecretOnThisDevice, type DeviceRecords, type DeviceSigner,
} from './deposit-on-device.js';
import type {
  CreatingTransactionAnswer, PayoutChainOnTheWire, SecretRunOnTheWire, StartStandingOnTheWire,
  VaultBuilderClient,
} from './vault-worker-client.js';
import { VaultAskFailed } from './vault-worker-client.js';
import { ReadRanOutOfTime, SERVICE_READ_BOUND_MS, SERVICE_READ_BOUND_SECONDS } from './read-bound.js';
import type { Kept, KeptOnThisDevice } from './in-flight-on-this-device.js';
import type { AccountHolders } from 'midnight-identity/profile/records-key';

/**
 * **A VAULT'S COMPANY ACCOUNT, AS THE SIGNER'S OWN WALLET READ IT OFF THE CHAIN
 * FOR THIS STEP**: who holds the account and which vaults it has adopted.
 * Asked afresh every time, with no press; never what the service reports.
 */
export interface VaultAsTheWalletRead {
  readonly holders: AccountHolders;
}

/** Where a step reads its vault's company account from the person's own wallet. */
interface VaultOnChainDoors {
  readonly onChain: (vault: Hex) => Promise<VaultAsTheWalletRead>;
}

/** A vault that is not one its company's account adopted as the chain shows it. Nothing is set up, put in or paid from it. */
export class VaultNotTheCompanys extends Error {
  /**
   * `'not-adopted'`: the wallet read the account and the vault is not among the vaults it adopted. `'wallet-silent'`: the
   * wallet could not say who holds the company, so nothing is known. `'other'`: a vault that was not set up as the company's.
   */
  constructor(readonly vault: Hex, why: string, readonly kind: 'not-adopted' | 'wallet-silent' | 'other' = 'other') {
    super(`${why} Nothing was sent.`);
    this.name = 'VaultNotTheCompanys';
  }
}

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

/** Where a step reads the vault itself: through this device's vault worker, at the indexer the person's own wallet names. */
interface ChainHereDoors extends VaultOnChainDoors {
  /** The company's account, which a vault must be pinned to for money to go in or out of it. */
  readonly account: AccountAddress;
  readonly builder: Pick<VaultBuilderClient, 'vaultOnChain'>;
  /**
   * The indexer the person's own wallet reads the chain through, exactly as
   * the wallet said it; null when the wallet said none.
   */
  readonly indexer: () => Promise<{ readonly indexerUri: string; readonly indexerWsUri: string } | null>;
}

/** The vault could not be read on this device, and the service is not asked in its place. Nothing was sent. */
export class VaultNotReadHere extends Error {
  constructor(readonly vault: Hex, why: string, options?: ErrorOptions) {
    super(`${why} The company's service is not asked in its place. Nothing was sent.`, options);
    this.name = 'VaultNotReadHere';
  }
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
async function readHere(
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
async function theWalletsIndexer(
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
 * Where a step out of or into the vault reads what it is built on and judged
 * by: this device's vault worker, at the indexer the person's own wallet names,
 * for the company's account as this device holds it.
 */
export interface BuiltOnHereDoors {
  readonly account: AccountAddress;
  readonly builder: Pick<VaultBuilderClient, 'chainAtOneBlock' | 'eventsOf' | 'createdBy'>;
  readonly indexer: ChainHereDoors['indexer'];
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
async function oneBlockOrNotYet(
  doors: Pick<BuiltOnHereDoors, 'account' | 'builder'>, vault: Hex,
  indexer: { readonly indexerUri: string; readonly indexerWsUri: string },
): Promise<(PayoutChainOnTheWire & { readonly account: Hex }) | null> {
  const account = String(doors.account).toLowerCase() as Hex;
  const chain = await doors.builder.chainAtOneBlock({ vault, account, indexer });
  return chain === null ? null : { ...chain, account };
}

/** Every zswap event the chain holds for one transaction, read on this device at the indexer the wallet names. */
async function eventsHere(
  doors: Pick<BuiltOnHereDoors, 'builder' | 'indexer'>, vault: Hex, transactionHash: string,
): Promise<EventOnTheWire[]> {
  return doors.builder.eventsOf({ transactionHash, indexer: await theWalletsIndexer(doors, vault) });
}

const NO_VAULT_YET = 'the chain shows no vault at this address yet.';

/** The vault's state, notes and every coin ever made for it, as one read on this device found them; nothing of who holds it. */
function notesOfARead(vault: Hex, read: Awaited<ReturnType<VaultBuilderClient['vaultOnChain']>>): VaultChainView {
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
 * **THE VAULT'S NOTES AS THE CHAIN HOLDS THEM, READ ON THIS DEVICE**, for a
 * step that only asks whether a note it sent or spent has landed: the same read
 * as `vaultStandingHere`, without asking the wallet who holds the vault.
 */
async function notesAsThisDeviceReadsThem(
  doors: Pick<ChainHereDoors, 'builder' | 'indexer'>, vault: Hex,
): Promise<VaultChainView> {
  return notesOfARead(vault, await readHere(doors, vault));
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
async function theVaultReadForItsStart(
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

const NOT_PINNED_WHY = 'this vault is not pinned to your company\'s account, or its state is not a vault\'s, as the chain shows it, so '
  + 'money in it would be paid out on somebody else\'s approvals; no money goes in or out of it.';
const ACCOUNT_UNREAD_WHY = 'this vault\'s state could not be read as a vault\'s, so which account it is pinned to and whether it is started '
  + 'are not known; no money goes in or out of it.';
const NOT_STARTED_WHY = 'this vault has not been started: its first secret is not set, or not every signer\'s sealed copy is written.';

/** One read of a vault on this device, before any verdict on whether money may go in or out. */
type VaultStandingHere =
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

/** Which contract's circuit is not this app's, the circuit when one is named, and why. */
interface CircuitNotThisBuilds {
  readonly contract: 'vault' | 'account';
  readonly circuit: string | null;
  readonly why: string;
}

const CIRCUITS_UNSAID = (whose: string) => `this device's read did not say whether ${whose} circuits are the ones this app was `
  + 'built with, so no money goes in or out of this vault.';
const CIRCUITS_CHANGED = ' If the company\'s super admins moved it to a newer build, it stays refused on this device until this '
  + 'device runs that build.';

/** The first contract whose circuits are not this app's, the vault before the account, or null. */
function circuitsOfARead(read: Extract<Awaited<ReturnType<VaultBuilderClient['vaultOnChain']>>, { onChain: true }>): CircuitNotThisBuilds | null {
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
async function vaultStandingHere(doors: ChainHereDoors, vault: Hex, withCircuits = false): Promise<VaultStandingHere> {
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
export type VaultFundableHere =
  | { readonly of: 'fundable'; readonly view: VaultChainView }
  | { readonly of: 'not-on-chain'; readonly why: string }
  | { readonly of: 'not-adopted'; readonly why: string }
  | { readonly of: 'unreadable'; readonly why: string }
  | {
    readonly of: 'not-this-build'; readonly why: string; readonly contract: 'vault' | 'account';
    readonly circuit: string | null; readonly view: VaultChainView;
  }
  | { readonly of: 'pinned-elsewhere'; readonly why: string; readonly view: VaultChainView }
  | { readonly of: 'not-started'; readonly why: string; readonly view: VaultChainView };

/** The verdict on one read; the only place that says whether a vault may take or pay out money. */
function fundableFrom(standing: VaultStandingHere, forADoor = false): VaultFundableHere {
  if (!standing.onChain) return { of: 'not-on-chain', why: standing.view.why ?? NO_VAULT_YET };
  if (standing.unread !== null) return { of: 'unreadable', why: forADoor ? standing.unread.refuses : standing.unread.says };
  const circuits = standing.circuits === undefined
    ? { contract: 'vault' as const, circuit: null, why: CIRCUITS_UNSAID('the vault\'s') } : standing.circuits;
  if (circuits !== null) {
    return { of: 'not-this-build', why: circuits.why, contract: circuits.contract, circuit: circuits.circuit, view: standing.view };
  }
  if (!standing.pinned) return { of: 'pinned-elsewhere', why: NOT_PINNED_WHY, view: standing.view };
  if (!standing.started) return { of: 'not-started', why: NOT_STARTED_WHY, view: standing.view };
  return { of: 'fundable', view: standing.view };
}

/**
 * The answer, for a step that goes on to refuse in its own words: a vault in
 * any state but the readable ones is an answer, and a read that fails, or a
 * wallet that cannot say, throws `VaultNotReadHere` or `VaultNotTheCompanys`.
 */
async function fundableOrThrow(doors: ChainHereDoors, vault: Hex, forADoor = true): Promise<VaultFundableHere> {
  return fundableFrom(await vaultStandingHere(doors, vault, true), forADoor);
}

/** Why a start goes no further from this read: the same read and order as the answer, judged for the start, which does not ask whether it is started. */
function startRefusalFrom(standing: VaultStandingHere): string | null {
  if (!standing.onChain) return null;
  if (standing.unread !== null) return standing.unread.refuses;
  const circuits = standing.circuits === undefined ? { why: CIRCUITS_UNSAID('the vault\'s') } : standing.circuits;
  if (circuits !== null) return circuits.why;
  return standing.pinned ? null : NOT_PINNED_WHY;
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

/** What the chain holds for one vault, as this device read it (`vaultStandingHere`); nothing of who holds it. */
export interface VaultChainView {
  readonly vault: Hex;
  readonly onChain: boolean;
  /** Base64 of the vault's contract state. */
  readonly state?: string;
  readonly notes?: readonly Hex[];
  readonly everCreated?: readonly string[];
  /** The vault's secret's commitment and its split journal (nullifier, masked amount), read only with `notes`. */
  readonly nonceCommitment?: string;
  readonly splitJournal?: ReadonlyArray<readonly [string, string]>;
  /** Why the chain shows no vault at the address; only when `onChain` is false. */
  readonly why?: string;
  /** `true` only when the notes were read off a ledger of the shape this build's vault has. */
  readonly notesFromThisBuild?: boolean;
  readonly notesWhy?: string;
}

/**
 * What the company's service answers for one vault's chain route: the service's own read, shown only, never an answer to
 * whether money may go in or out (`vaultFundableHere` is that).
 */
export interface ServedVaultChain {
  readonly vault: Hex;
  readonly onChain: boolean;
  readonly state?: string;
  readonly notes?: readonly Hex[];
  readonly everCreated?: readonly string[];
  readonly authority?: {
    readonly committee: readonly { tag: string; value: string }[];
    readonly threshold: number;
    readonly counter: string;
    readonly shape: string;
  } | null;
  readonly committee?: Committee | null;
  /** Whether the vault is held by the same keys, at the same threshold, as the company's account: shown, never a gate on money. */
  readonly heldByCommittee?: boolean;
  /** Base64 of the deploy the vault's address was made from, as the service kept it when it sent it. */
  readonly deployed?: string | null;
  /** Whether the service reads the vault's first secret as set with every sealed copy written. */
  readonly started?: boolean;
  readonly notesFromThisBuild?: boolean;
  readonly notesWhy?: string;
}

/** What the service answered for one step of a vault's start it sent. */
interface StartStepSent { readonly txRef: string; readonly transactionHash?: string | null }

export interface VaultKeysView {
  readonly committee: Committee | null;
  readonly why: string | null;
  /** Every signer's records key the service holds, this device's included. */
  readonly readers: readonly Hex[];
}

/** The routes in `src/server/company-vaults.ts`, as the page calls them. */
export interface VaultService {
  keys(): Promise<VaultKeysView>;
  deploy(tx: string): Promise<{ vault: Hex; txRef: string }>;
  handover(vault: Hex, tx: string): Promise<{ txRef: string }>;
  chain(vault: Hex): Promise<ServedVaultChain>;
  deposit(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
  /**
   * Sends a public deposit into the vault, with the network fee paid for it.
   * `money` is what the page asked the vault to receive, and the service
   * refuses a deposit that is anything else.
   */
  depositPublicly?(vault: Hex, tx: string, money: { token: Hex; amount: string }): Promise<{ txRef: string; transactionHash: string | null }>;
  /**
   * One block's view of the vault and the company's account, as the service
   * reads it. Nothing on the page reads it: a vault's start, a deposit and a
   * payment read their block on this device (`chainAtOneBlockHere`).
   */
  payoutState(vault: Hex): Promise<{
    vault: Hex; account: Hex; blockHash: string;
    vaultState: string; zswapState: string; parameters: string; accountState: string;
  }>;
  payout(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
  /** Sends a merge of the vault's own notes, with the network fee paid for it. It moves nothing out of the vault. */
  merge(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
  /** Sends a public payment out of the vault, with the network fee paid for it. */
  payoutPublicly(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
  /**
   * **A STEP OF THE VAULT'S START ON THE COMPANY'S ACCOUNT**, proved on this
   * device: the adoption round or the first secret run approved, or the
   * adoption carried out. Each is raised with its record instead
   * (`VaultStartProposals`).
   */
  startAccountCall?(vault: Hex, body: { tx: string; step: 'adoption' | 'secret-run'; call: 'approve' | 'adopt' }): Promise<StartStepSent>;
  /** The vault's first secret set under its approved run. */
  startSecret?(vault: Hex, tx: string): Promise<StartStepSent>;
  /** One signer's sealed copy of the secret written, by its place in the approved tree. */
  startCopy?(vault: Hex, tx: string, place: number): Promise<StartStepSent>;
}

export type VaultStage =
  | 'checking the committee' | 'building the vault' | 'sending the vault'
  | 'waiting for the chain'
  | 'filing the name' | 'adopting the vault' | 'reading the secret back' | 'setting the secret' | 'writing the sealed copies'
  | 'waiting for approvals'
  | 'opening the pool' | 'checking the vault' | 'choosing the coin' | 'building the deposit'
  | 'asking your wallet' | 'sending the deposit' | 'recording the deposit'
  | 'choosing the notes' | 'reading the chain' | 'writing the payment down' | 'building the payment'
  | 'sending the payment' | 'waiting for the payment' | 'recording the payment'
  | 'writing the merge down' | 'building the merge' | 'sending the merge' | 'waiting for the merge' | 'recording the merge'
  | 'done';

export interface Pacing {
  readonly sleep: (ms: number) => Promise<void>;
  /** How long to keep asking the chain for one thing to appear. */
  readonly waitMs?: number;
  readonly everyMs?: number;
  readonly progress?: (stage: VaultStage) => void;
}

const sentNothing = (e: unknown): boolean => (e as { nothingWasSent?: unknown })?.nothingWasSent === true;

/** Asks `ask` every `everyMs` until it answers something, for at most `waitMs`; null when it never did. */
export async function until<T>(
  pacing: Pacing, ask: () => Promise<T | null>,
): Promise<T | null> {
  const every = pacing.everyMs ?? 6_000;
  const tries = Math.max(1, Math.ceil((pacing.waitMs ?? 10 * 60_000) / every));
  for (let i = 0; i < tries; i += 1) {
    const got = await ask();
    if (got !== null) return got;
    await pacing.sleep(every);
  }
  return null;
}

export interface CreateVaultDoors extends PoolDoors {
  /**
   * The address of the company's account, which the new vault is pinned to. Its
   * own type: a company's label, or another vault's address, does not build here.
   */
  readonly account: AccountAddress;
  readonly service: VaultService;
  readonly builder: VaultBuilderClient;
  /** This signer's own three, from the keyring this device opened: the account's rounds are proved with them. */
  readonly material: SignerMaterial;
  /** What every key the vault's secret is sealed to is checked against, before this device raises or approves it. */
  readonly secretReaders: SecretReaderSources;
  /**
   * The company as this device counts it for the vault check
   * (`approverRosterFrom`), before it raises, approves or carries out the
   * adoption, with each vault's name to say it by.
   */
  readonly approvers: () => Promise<ApproverRoster>;
  readonly vaultName: (vault: Hex) => string;
  /** The time now, in milliseconds. */
  readonly clock?: () => number;
  /** Where the vault's adoption and first secret run are written down as the company's proposals, and raised. */
  readonly proposals: VaultStartProposals;
  /**
   * Where the vault's name and description are filed, right after the deploy,
   * when the press gives them: the company's records through the one check.
   * The seat, keys and entry are the ones the proposals are filed with.
   */
  readonly vaultInfo?: VaultInfoRecords;
}

/** What a new vault is called and what it is for, as the person creating it gives them. */
export interface VaultInfoGiven {
  readonly name: string;
  readonly description: string;
}

/**
 * **WHERE A NEW VAULT'S TWO PROPOSALS ARE WRITTEN DOWN AND RAISED**: the
 * company's proposals as the service keeps them, believed only through the
 * company's directory as this device reads it (`listedHere`); the account's
 * call state a raise is built on; the company's keys the record is sealed
 * under; and the one call that enters what this seat files in the company's
 * records.
 */
export interface VaultStartProposals {
  /** The company's id at the service, which its proposals are kept under. */
  readonly accountId: string;
  readonly service: Required<Pick<GovernedCallService, 'callState' | 'file' | 'send' | 'sealedProposals'>>;
  readonly directory: DirectoryRead;
  /** The company's keys, as this device holds them: each record is sealed under the one in force. */
  readonly companyKeys: KeysHeld;
  /** This seat's filing key: what the company's directory names the seat by, and what signs each record and relay. */
  readonly signingSecret: Hex;
  readonly entered: RecordsEntered;
  /** Asks the service to write the vault's adoption down as carried out, for this seat; it checks the adoption and the chain itself. */
  readonly carried?: (proposalId: string, body: { readonly vault: string; readonly filer: string }) => Promise<unknown>;
}

/**
 * **WHAT A SECRET'S READERS ARE CHECKED AGAINST**, none of it the service's
 * word alone: the company's label, the seats the account holds and the
 * account the vault is pinned to as this signer's own wallet read them off the
 * chain, the roster this device opened, whose every records key carries its
 * signer's wallet's signature, and the company's directory as this device
 * believes it, whose entries this device opened for each seat's opening. No
 * committee is read.
 */
export interface SecretReaderSources {
  readonly company: CompanyLabel;
  /**
   * Who holds the company's account and `vault`, asked of this signer's own
   * wallet afresh every time a set of readers is checked, so no check rests on
   * a read made before a wait; null when the wallet read nothing. With
   * `firstSecret`, the same wallet screen also shows the person the vault and
   * every key its first secret will be sealed to, named as the roster names
   * them: a confirmation shown to the person, not a lock, because the approval
   * is proved with the seat's key this device holds and the chain asks for
   * nothing from the wallet.
   */
  readonly read: (vault: Hex, firstSecret?: FirstSecretShown) => Promise<SeatsAsTheWalletRead | null>;
  readonly roster: () => Promise<readonly RosterVaultKeys[]>;
  /** The company's directory as this device believes it, read afresh for each check: each reader's seat's opening. */
  readonly directory: () => Promise<DirectoryAsBelieved>;
}

/** Where the press ended: the vault started, or a round of its start waiting for other signers' approvals. */
export type VaultCreated = (
  | { readonly vault: Hex; readonly state: 'started' }
  | {
    readonly vault: Hex; readonly state: 'awaiting-approvals';
    /** Which round waits, its identity, and how many approvals it has and needs. */
    readonly awaiting: {
      readonly round: 'adoption' | 'first-secret'; readonly proposal: Hex;
      readonly approvals: number; readonly needed: number;
    };
  }
) & {
  /**
   * What this press could not leave in the company's records, each said in a
   * sentence: the vault's name and description when they were given and not
   * filed, and each of the vault's two setup proposals the chain holds and that
   * was not written down. The start carries on without them, since nothing it
   * does reads those records.
   */
  readonly said?: readonly string[];
  /**
   * The kind of each thing in `said`, once each, in the order they were first
   * said: what a page words in its own language instead of showing the
   * English in `said`.
   */
  readonly saidCodes?: readonly SaidCode[];
};

/** The kinds of thing a press can leave unsaid in the company's records and still carry on. */
export const SAID = {
  proposalNotWrittenDown: 'proposal-not-written-down',
  nameNotFiled: 'vault-name-not-filed',
  nameGivenBefore: 'vault-name-given-before',
} as const;
export type SaidCode = (typeof SAID)[keyof typeof SAID];

/** Why no vault was built, before anything was sent: what a page words, with what resolves each. */
export const NOT_BUILT = {
  seatUnknown: 'seat-unknown',
  seatNotBelieved: 'seat-not-believed',
  seatMayNotRaise: 'seat-may-not-raise',
  committeeUnread: 'committee-unread',
  committeeNotInstallable: 'committee-not-installable',
  pageOutOfDate: 'page-out-of-date',
} as const;
export type NotBuiltCode = (typeof NOT_BUILT)[keyof typeof NOT_BUILT];

/**
 * **NO VAULT WAS BUILT, AND NOTHING WAS SENT.** Thrown by `createCompanyVault`
 * for a press it refuses before building: its `code` is the kind of refusal.
 */
export class VaultNotBuilt extends Error {
  constructor(readonly code: NotBuiltCode, why: string) {
    super(why);
    this.name = 'VaultNotBuilt';
  }
}

/**
 * **THE KINDS OF STOP A START CAN MAKE BESIDE THE CHECK OF WHO ITS SECRET IS SEALED TO.**
 * The first four cannot be cleared by pressing again; the last is the wallet's
 * own ask for the first secret failing.
 */
export const START_STOP = {
  adoptionStale: 'adoption-stale', tooFewApprovers: 'too-few-approvers', anotherSecret: 'another-secret',
  readersCannotOpen: 'readers-cannot-open', readBackOnly: 'read-back-only', walletNotAnswered: 'wallet-not-answered',
} as const;
export type StartStopCode = ReaderRefusalCode | (typeof START_STOP)[keyof typeof START_STOP];

/**
 * **WHICH READ ON THIS DEVICE A START STOPPED AT.** The chain at one block could not be read, or where the start
 * stands could not be worked out from it. Pressing again can clear either. Carried with the stop so it says which
 * read failed, never what was read.
 */
export const START_READ_STOP = { chainUnread: 'chain-unread', standingUnread: 'standing-unread' } as const;
export type StartReadStopCode = (typeof START_READ_STOP)[keyof typeof START_READ_STOP];

/**
 * **THE VAULT WAS SENT AND ITS START IS NOT FINISHED.**
 * Names the vault and the step; the vault takes no money until it is started,
 * and running `createCompanyVault` again for it carries on from what the chain
 * shows. It holds nothing.
 */
export class VaultStartOwed extends Error {
  /**
   * When the start stopped for a reason of its own: what kind of thing stopped it; or, as a `START_READ_STOP`, which
   * read on this device failed. Absent where pressing again is all that is left and no read is to name.
   */
  readonly stoppedAt?: StartStopCode | StartReadStopCode;
  constructor(readonly vault: Hex, why: string, stoppedAt?: StartStopCode | StartReadStopCode) {
    super(`Setting up this vault did not finish: ${why} `
      + 'This app puts no money into it until it is set up. Finish setting it up to carry on.');
    this.name = 'VaultStartOwed';
    if (stoppedAt !== undefined) this.stoppedAt = stoppedAt;
  }
}

/**
 * **THE COMMITTEE A NEW VAULT IS BORN HELD BY**: the very committee, at the
 * very threshold, that holds the company's account as this signer's own wallet
 * reads it off the chain - the super admins, whoever they are. Neither the
 * service's word nor the signers' keys are asked: a key no signer holds is as
 * good as any. Refused only when the chain's committee is one a contract may
 * not be held by.
 */
async function theCommitteeAVaultIsBornHeldBy(doors: CreateVaultDoors): Promise<Committee> {
  let holders: AccountHolders;
  try {
    /* Read before the vault exists, so the wallet is asked about the account the vault will be pinned to. */
    holders = (await doors.onChain(doors.account as string as Hex)).holders;
  } catch (e) {
    throw new VaultNotBuilt(NOT_BUILT.committeeUnread, `your wallet could not say who holds your company's account (${(e as Error)?.message ?? e}), so no vault was built.`);
  }
  const committee: Committee = {
    committee: holders.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: holders.threshold,
  };
  const notInstallable = whyNotInstallable(committee);
  if (notInstallable !== null) throw new VaultNotBuilt(NOT_BUILT.committeeNotInstallable, `no vault was built: ${notInstallable}`);
  return committee;
}

/**
 * **THE VAULT AS IT WAS BORN, READ ON THIS DEVICE BEFORE IT IS ADOPTED OR ITS
 * SET-UP IS CARRIED ON**: the chain shows it, and the deploy its
 * address was made from was held by the company's committee at counter 0, ran
 * this build's circuits and wrote nothing. Every later change needs the
 * committee's signatures, so this one read is enough. Both chain reads, the
 * vault's notes and how it was deployed, are asked inside one wait: a read that
 * ran out of time is asked again, and a wait in which every read ran out stops
 * as a chain this device could not read.
 */
async function readBornHeld(doors: CreateVaultDoors, vault: Hex): Promise<void> {
  doors.progress?.('waiting for the chain');
  let deployedWith: BornHeldReadWith | undefined;
  const asDeployed = await untilReadHere(doors, async () => {
    let v: VaultChainView;
    try {
      v = await notesAsThisDeviceReadsThem(doors, vault);
    } catch (e) {
      if (ranOutOfTime(e)) return RAN_OUT;
      throw new VaultStartOwed(vault, `the chain could not be read for it on this device (${(e as Error)?.message ?? e}).`, START_READ_STOP.chainUnread);
    }
    if (!v.onChain) return null;
    deployedWith ??= await bornHeldReadWith(doors, vault);
    try {
      return await doors.builder.vaultAsDeployed!({ vault, account: doors.account, ...deployedWith });
    } catch (e) {
      if (ranOutOfTime(e)) return RAN_OUT;
      throw e;
    }
  });
  if (asDeployed === RAN_OUT) throw new VaultStartOwed(vault, `it was sent, and ${NOT_READ_IN_TIME}`, START_READ_STOP.chainUnread);
  if (asDeployed === null) throw new VaultStartOwed(vault, 'it was sent and the chain has not shown it yet.');
  if (asDeployed.refusal !== null) {
    throw new VaultNotTheCompanys(vault, `${asDeployed.refusal.replace(/ Nothing was sent\.$/u, '')} This vault is not set up and no money `
      + 'is put into it; create a new vault.');
  }
}

type BornHeldReadWith = { readonly indexer: { readonly indexerUri: string; readonly indexerWsUri: string }; readonly holders: Committee };

/** The indexer and committee a vault's deploy is read against, once the chain shows the vault; refuses before any read of the deploy when this device has no reader for it, or the indexer or the committee cannot be named. */
async function bornHeldReadWith(
  doors: CreateVaultDoors, vault: Hex,
): Promise<BornHeldReadWith> {
  if (doors.builder.vaultAsDeployed === undefined) {
    throw new VaultNotTheCompanys(vault, 'this device cannot read how this vault was created, so it is not set up from here and '
      + 'no money is put into it. Reload the page and try again; if it still cannot be read, create a new vault.');
  }
  const indexer = await doors.indexer();
  if (indexer === null) {
    throw new VaultStartOwed(vault, 'your wallet did not say which indexer it reads the chain through, so this device cannot '
      + 'read how the vault was created.');
  }
  const holders = await theCommitteeAVaultIsBornHeldBy(doors).catch((e: unknown) => {
    if (e instanceof VaultNotBuilt) {
      throw new VaultStartOwed(vault, 'your wallet could not say which committee holds your company\'s account, so this device cannot '
        + 'read how the vault was created.');
    }
    throw e;
  });
  return { indexer, holders };
}

/**
 * **CREATING A VAULT, BORN HELD.** The vault is deployed held by the company's
 * committee at its threshold from its first transaction: there is no temporary
 * key, no hand-over, and nothing to forget. Then it is read as it was born and
 * started. With `resume`, a vault already sent is read as it was born and its
 * start carried on.
 *
 * With `info`, the vault's name and description are checked before anything is
 * built, and filed once this device has read the vault as born held by the
 * company (`fileVaultInfoHere`), never before, by a seat that may file them;
 * when they are not filed, the vault is still created and why is said. On a
 * resume they are filed only if the vault has none yet.
 */
export async function createCompanyVault(
  doors: CreateVaultDoors, resume?: Hex, info?: VaultInfoGiven,
): Promise<VaultCreated> {
  let tidied: VaultInfoGiven | undefined;
  if (info !== undefined) {
    try {
      tidied = vaultInfoTidied(info);
    } catch (e) {
      throw new VaultInfoRefused(`No vault was built: ${(e as Error).message} Nothing was sent.`, { cause: e });
    }
  }
  let vault = resume;
  if (vault === undefined) {
    doors.progress?.('checking the committee');
    /* Refused before the deploy, so a seat that could not raise the vault's adoption spends no fee on a vault it cannot start. */
    const may = await seatMayRaise(doors);
    if (may !== null) throw new VaultNotBuilt(may.code, `No vault was built: ${may.says} Nothing was sent.`);
    const holders = await theCommitteeAVaultIsBornHeldBy(doors);
    if (doors.builder.bornHeldVault === undefined) {
      throw new VaultNotBuilt(NOT_BUILT.pageOutOfDate, 'this page cannot build a vault held by the company from the start. Reload it to get the current version.');
    }
    doors.progress?.('building the vault');
    const built = await doors.builder.bornHeldVault({ account: doors.account, holders });
    doors.progress?.('sending the vault');
    try {
      vault = (await doors.service.deploy(built.tx)).vault;
    } catch (e) {
      if (sentNothing(e)) throw e;
      throw new VaultStartOwed(built.vault as Hex, `the vault may have been sent (${(e as Error)?.message ?? e}).`);
    }
    /* The vault carried on is the one this device built and sent, never another address the service answers with. */
    if (String(vault).toLowerCase() !== String(built.vault).toLowerCase()) {
      throw new VaultStartOwed(built.vault as Hex, 'the service answered with another vault than the one this device sent, so '
        + 'nothing is carried on with that one.');
    }
  }
  const sentVault: Hex = vault;
  try {
    await readBornHeld(doors, sentVault);
    if (tidied !== undefined) doors.progress?.('filing the name');
    const notNamed = tidied === undefined ? null : await vaultInfoFiledOnceItIsTheCompanys(doors, sentVault, tidied);
    const done = await startCompanyVault(doors, sentVault);
    if (notNamed === null) return done;
    return { ...done, said: [notNamed.says, ...(done.said ?? [])], saidCodes: [notNamed.code, ...(done.saidCodes ?? []).filter((c) => c !== notNamed.code)] };
  } catch (e) {
    /* The vault exists from here on: whatever else fails names it, so the page offers to carry it on and never to create another. */
    if (e instanceof VaultStartOwed || e instanceof VaultNotTheCompanys) throw e;
    throw new VaultStartOwed(sentVault, (e as Error)?.message ?? String(e));
  }
}

/**
 * Files a new vault's name and description, as `fileVaultInfoHere` does, with
 * the seat, keys and entry its proposals are filed with. Never throws: a name
 * not filed is said, and the vault's creation carries on.
 */
async function vaultInfoFiledOnceItIsTheCompanys(
  doors: CreateVaultDoors, vault: Hex, info: VaultInfoGiven,
): Promise<{ readonly says: string; readonly code: SaidCode } | null> {
  const notFiled = (why: string): { readonly says: string; readonly code: SaidCode } => ({
    says: `This vault was created without its name and description: ${why} An admin names it later.`, code: SAID.nameNotFiled,
  });
  if (doors.vaultInfo === undefined) return notFiled('this page cannot file them. Reload it to get the current version.');
  const p = doors.proposals;
  try {
    await fileVaultInfoHere(
      { accountId: p.accountId, companyKeys: p.companyKeys, signingSecret: p.signingSecret, directory: p.directory, entered: p.entered, records: doors.vaultInfo },
      { vault, name: info.name, description: info.description, over: null },
    );
    return null;
  } catch (e) {
    if (e instanceof VaultInfoChanged) {
      return { says: 'This vault already has a name, given before this press, so the one given here was not filed.', code: SAID.nameGivenBefore };
    }
    const why = String((e as Error)?.message ?? e).replace(/^This vault's name was not filed: /u, '')
      .replace(/\s*Nothing was filed\.\s*$/u, '').replace(/([^.])$/u, '$1.');
    return notFiled(why);
  }
}

/* ------------------------------------------------------------ starting a vault */

const ZERO_HEX = '00'.repeat(32);
const randomHex = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

/** One block's view of the vault and the company's account, read on this device at the indexer the person's own wallet names. */
type ChainAtTheStart = Awaited<ReturnType<typeof chainAtOneBlockHere>>;

/** What a read on this device answers when it ran out of time: not shown yet, and asked again. */
const RAN_OUT: unique symbol = Symbol('the read ran out of time');

/** A read that did not answer within SERVICE_READ_BOUND_MS, on its own or as the cause of a vault not read here. */
const ranOutOfTime = (e: unknown): boolean =>
  e instanceof ReadRanOutOfTime || (e instanceof VaultNotReadHere && e.cause instanceof ReadRanOutOfTime);

/** What a wait says when every read in it ran out of time: the chain was never read, so nothing is said of what it holds. */
const NOT_READ_IN_TIME = `this device could not read the chain in time: no read answered within ${SERVICE_READ_BOUND_SECONDS} seconds.`;

/**
 * Where a vault's start stands now, read off both contracts at one block on this device, with the chain it was read at;
 * null only while the chain the wallet reads does not hold the vault and the account yet, and `RAN_OUT` when the read
 * of the block did not answer within SERVICE_READ_BOUND_MS, which a later read can clear. Anything else that stops the
 * read - a wallet that names no indexer, a read that fails, a standing the worker cannot work out - is the start not
 * finished at once, naming the vault and why: waiting would not change it.
 */
async function standingIfRead(
  doors: CreateVaultDoors, vault: Hex, secret?: SecretReadBack, window?: { opensAt: bigint; closesAt: bigint },
) {
  const indexer = await doors.indexer();
  if (indexer === null) {
    throw new VaultStartOwed(vault, 'your wallet did not say which indexer it reads the chain through, so this device cannot '
      + 'read where its start stands.');
  }
  let chain: ChainAtTheStart | null;
  try {
    chain = await oneBlockOrNotYet(doors, vault, indexer);
  } catch (e) {
    if (e instanceof ReadRanOutOfTime) return RAN_OUT;
    throw new VaultStartOwed(vault, `this device could not read the chain at one block (${(e as Error)?.message ?? e}).`, START_READ_STOP.chainUnread);
  }
  if (chain === null) return null;
  const now = BigInt(Math.floor((doors.clock?.() ?? Date.now()) / 1000));
  let read: Awaited<ReturnType<VaultBuilderClient['startStanding']>>;
  try {
    read = await doors.builder.startStanding({
      vault, account: chain.account, accountState: chain.accountState, vaultState: chain.vaultState, now: now.toString(),
      ...(secret === undefined ? {} : { secret: secret.secret, readers: secret.readers }),
      ...(window === undefined ? {} : { window: { opensAt: window.opensAt.toString(), closesAt: window.closesAt.toString() } }),
    });
  } catch (e) {
    throw new VaultStartOwed(vault, `where its start stands could not be worked out on this device (${(e as Error)?.message ?? e}).`, START_READ_STOP.standingUnread);
  }
  return { chain, now, standing: read.standing, run: read.run };
}

type StartStanding = Exclude<NonNullable<Awaited<ReturnType<typeof standingIfRead>>>, typeof RAN_OUT>;

/**
 * `until` for a read on this device: a read that ran out of time is asked again, and is counted as the
 * SERVICE_READ_BOUND_MS it waited and the pause after it, so a wait whose every read runs out of time ends within
 * `waitMs`. Answers `RAN_OUT` when the wait ended and every read in it ran out, so the chain was never read.
 */
async function untilReadHere<T>(pacing: Pacing, ask: () => Promise<T | null | typeof RAN_OUT>): Promise<T | null | typeof RAN_OUT> {
  const every = pacing.everyMs ?? 6_000;
  const tries = Math.max(1, Math.ceil((pacing.waitMs ?? 10 * 60_000) / every));
  const aReadThatRanOut = Math.ceil((SERVICE_READ_BOUND_MS + every) / every);
  let everyReadRanOut = true;
  for (let counted = 0; counted < tries;) {
    const got = await ask();
    if (got !== null && got !== RAN_OUT) return got;
    if (got === null) everyReadRanOut = false;
    counted += got === RAN_OUT ? aReadThatRanOut : 1;
    await pacing.sleep(every);
  }
  return everyReadRanOut ? RAN_OUT : null;
}

/**
 * Where a vault's start stands now, waiting only while the chain the wallet reads does not hold the vault and the
 * account at all, or its read of the block ran out of time; a wait that runs out is the start not finished, naming
 * the vault. An indexer that holds both but has not yet caught up with this person's last send answers at once with
 * the older state: only `untilTheChainShows`, after a send, waits for what was sent.
 */
async function standingNow(
  doors: CreateVaultDoors, vault: Hex, secret?: SecretReadBack, window?: { opensAt: bigint; closesAt: bigint },
): Promise<StartStanding> {
  const got = await untilReadHere(doors, () => standingIfRead(doors, vault, secret, window));
  if (got === RAN_OUT) throw new VaultStartOwed(vault, NOT_READ_IN_TIME, START_READ_STOP.chainUnread);
  if (got === null) throw new VaultStartOwed(vault, 'the chain your wallet reads has not shown it and your company\'s account yet.');
  return got;
}

/** The service's doors for a start, or the refusal that names what this page is missing. */
const startDoorsOf = (doors: CreateVaultDoors, vault: Hex) => {
  const { startAccountCall, startSecret, startCopy } = doors.service;
  if (startAccountCall === undefined || startSecret === undefined || startCopy === undefined) {
    throw new VaultStartOwed(vault, 'this page cannot send the steps that start a vault. Reload it to get the current version.');
  }
  return {
    accountCall: startAccountCall.bind(doors.service), secret: startSecret.bind(doors.service), copy: startCopy.bind(doors.service),
  };
};

/** Sends one step; a refusal or an answer lost on the way is the start not finished, naming why. */
async function sent(vault: Hex, what: string, send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (e) {
    const why = (e as Error)?.message ?? String(e);
    throw new VaultStartOwed(vault, sentNothing(e)
      ? `${what} was not sent (${why}).`
      : `${what} may have been sent and the answer was lost (${why}). Wait a minute before creating it again.`);
  }
}

/** Asks the chain until `seen` says yes; a wait that runs out is the start not finished, naming what was sent. */
async function untilTheChainShows(
  doors: CreateVaultDoors, vault: Hex, what: string,
  seen: (now: StartStanding) => boolean, secret?: SecretReadBack,
): Promise<StartStanding> {
  const got = await untilReadHere(doors, async () => {
    const now = await standingIfRead(doors, vault, secret);
    return now === null || now === RAN_OUT ? now : seen(now) ? now : null;
  });
  if (got === RAN_OUT) throw new VaultStartOwed(vault, `${what} was sent, and ${NOT_READ_IN_TIME}`, START_READ_STOP.chainUnread);
  if (got === null) throw new VaultStartOwed(vault, `${what} was sent and the chain has not shown it yet.`);
  return got;
}

/** The account's call state, from one block's view of both contracts. */
const callChainOf = (chain: ChainAtTheStart) =>
  ({ blockHash: chain.blockHash, accountState: chain.accountState, parameters: chain.parameters });

/** The account's half of a raise that moves no money: no asset, no amount, no payments, a blinding nobody keeps. */
const nothingMoves = (asset: string, salt: string) => ({
  assetId: asset, assetBlinding: randomHex(), proposalSalt: salt, changeAmount: '0', changeBatchDigest: ZERO_HEX,
});

/** Builds one of the start's approvals or its adoption on the account here and sends it. */
async function accountStep(
  doors: CreateVaultDoors, vault: Hex, chain: ChainAtTheStart,
  step: 'adoption' | 'secret-run', order: GovernedCallOrder & { readonly circuit: 'approve' | 'adopt' }, opened: OpenedRound, what: string,
): Promise<'sent' | 'already-approved'> {
  let tx: string;
  try {
    ({ tx } = await doors.builder.governedCall({ account: chain.account, order, material: doors.material, chain: callChainOf(chain), opened }));
  } catch (e) {
    const why = (e as Error)?.message ?? String(e);
    /* The account refuses a second approval from one signer. The raise counted as the raiser's approval, so this one is already in. */
    if (order.circuit === 'approve' && /you have already approved this proposal/u.test(why)) return 'already-approved';
    throw new VaultStartOwed(vault, `${what} could not be built on this device (${why}). Nothing was sent.`);
  }
  await sent(vault, what, () => startDoorsOf(doors, vault).accountCall(vault, { tx, step, call: order.circuit }));
  return 'sent';
}

/**
 * Why this seat may not raise a proposal of the company's, as a kind and a
 * sentence, or null: its entry in
 * the company's directory as this device reads it, a seat this device believes
 * by the one rule every reader judges a filing by (`seatNotBelievedHere`), with a
 * role that may file one (`mayFile`). A record filed by any other seat is believed by
 * no device, so its raise is refused here before anything is sent.
 */
async function seatMayRaise(doors: CreateVaultDoors): Promise<SeatRefusal | null> {
  const here = await doors.proposals.directory();
  return seatRefusalIn(doors.proposals, here);
}

interface SeatRefusal { readonly code: NotBuiltCode; readonly says: string }

const seatMayRaiseIn = (p: Pick<VaultStartProposals, 'signingSecret'>, here: Awaited<ReturnType<DirectoryRead>>): string | null =>
  seatRefusalIn(p, here)?.says ?? null;

const seatRefusalIn = (p: Pick<VaultStartProposals, 'signingSecret'>, here: Awaited<ReturnType<DirectoryRead>>): SeatRefusal | null => {
  const me = signingPublicKeyOf(p.signingSecret).toLowerCase();
  const mine = here.dir.seats.find((x) => x.signingKey.toLowerCase() === me);
  if (mine === undefined) {
    return { code: NOT_BUILT.seatUnknown, says: 'the company\'s directory, as this device reads it, holds no seat under your keys.' };
  }
  const off = seatNotBelievedHere(here, mine);
  if (off !== null) return { code: NOT_BUILT.seatNotBelieved, says: `your seat is not one this device believes: ${off}.` };
  if (!mayFile(mine).includes('proposal')) {
    return {
      code: NOT_BUILT.seatMayNotRaise,
      says: 'your seat\'s role on this company may not raise proposals, and setting up a vault raises two. A signer whose role '
        + 'may raise proposals sets it up.',
    };
  }
  return null;
};

/** One of the two proposals a vault's start raises: its identity on the chain, and its record as this device seals it. */
interface StartRound {
  readonly what: string;
  /** The proposal by name, as a sentence says it after "the vault's": "adoption". */
  readonly called: string;
  readonly chainId: string;
  readonly digest: string;
  readonly salt: string;
  /** The vault the identity is made for, given only for the first secret run, whose one leaf pays a zero amount of no asset. */
  readonly named?: string;
  readonly seal: (key: Hex) => Sealed;
}

/**
 * **THE VAULT'S ADOPTION THE CHAIN CARRIED OUT, WRITTEN DOWN AS CARRIED OUT**:
 * each record of it the company's proposals still hold open, asked of the
 * service by this seat once this device's own read of the chain shows the vault
 * adopted (the service checks it is that vault's adoption and reads the chain
 * again before it writes anything). Null when done or
 * nothing is open; otherwise a sentence of why, and the start carries on.
 */
async function carriedOutWrittenDown(doors: CreateVaultDoors, vault: Hex, round: StartRound): Promise<string | null> {
  const p = doors.proposals;
  if (p.carried === undefined) return null;
  const filer = signingPublicKeyOf(p.signingSecret).toLowerCase();
  const chainId = round.chainId.toLowerCase();
  try {
    const open = (await p.service.sealedProposals(p.accountId))
      .filter((r) => r.accountId === p.accountId && String(r.chainId).toLowerCase() === chainId && (r.status === 'open' || r.status === 'approved'));
    for (const r of open) await p.carried(r.id, { vault, filer });
    return null;
  } catch (e) {
    return `The vault's ${round.called} is carried out on the chain, and the company's proposals still show it open: `
      + `${String((e as Error)?.message ?? e).replace(/\.$/u, '')}. Setting the vault up carries on; pressing again writes it down.`;
  }
}

/**
 * **A START'S PROPOSAL WRITTEN DOWN AS THE COMPANY'S, AND RAISED WITH IT.**
 * Run on every pass, keyed by the proposal's identity on the chain: the record
 * the company's proposals already hold for it, read only through the company's
 * directory as this device believes it (`listedHere`), or none, in which case
 * this seat seals and signs one. With `raise`, the chain does not hold the
 * proposal yet: the call is built on the account's call state and sent with
 * the record in one request, written down first and then relayed
 * (`submitProvenCall`), or sent again under the record already there. Without
 * it the chain holds it, and only the record is written down. What this seat
 * filed is then entered in the company's records. A record served under the
 * identity that this company could not have written down for this proposal -
 * its filing signature does not hold, or it is over another payload - is
 * refused by name and neither entered nor raised under, whatever key it names.
 *
 * The approvals, the adoption and the secret read nothing written here: they
 * are made from the chain. So once the raise is sent, or with none to send,
 * nothing here stops the start: a record the service will not give or keep,
 * one this device cannot seal while the company's key is being changed, one
 * not entered, or another seat's record that seat has not entered yet, is
 * returned as a sentence for the press to say, and written down or entered on
 * a later press. Null when the record is written down and believed.
 */
async function proposedAndWrittenDown(
  doors: CreateVaultDoors, vault: Hex, round: StartRound,
  raise?: { readonly order: GovernedCallOrder; readonly opened: OpenedRound },
): Promise<string | null> {
  const p = doors.proposals;
  const own = signingPublicKeyOf(p.signingSecret).toLowerCase();
  const notWrittenDown = (why: string): string => `The vault's ${round.called} is on the chain and is not written down in the `
    + `company's records yet: ${why}. Setting the vault up carries on; pressing again writes it down.`;
  const chainId = round.chainId.toLowerCase();
  let found: SealedProposal | undefined;
  let may: string | null;
  try {
    const [served, here] = await Promise.all([p.service.sealedProposals(p.accountId), p.directory(kindAsked('proposal'))]);
    found = listedHere(here, 'proposal', served, 'proposal')
      .find((r) => r.accountId === p.accountId && String(r.chainId).toLowerCase() === chainId);
    may = seatMayRaiseIn(p, here);
  } catch (e) {
    if (raise === undefined) return notWrittenDown(`the company's proposals could not be read (${(e as Error)?.message ?? e})`);
    throw new VaultStartOwed(vault, `the company's proposals could not be read, so ${round.what} was not sent (${(e as Error)?.message ?? e}).`);
  }
  /*
   * A record served under this proposal's identity is acted on only if it is one the company could have written down
   * for this very proposal: signed by the seat it names, for this company, over this proposal's payload. Anything else
   * is not entered or sent under, whoever it names as its filer.
   */
  if (found !== undefined && (proposalFilingRefusal(p.accountId, found) !== null
    || String(found.digest).toLowerCase() !== round.digest.toLowerCase())) {
    throw new VaultStartOwed(vault, `the company's proposals hold a record, ${found.id}, under the identity of the vault's ${round.called} `
      + 'that is not a record of it this company could have written down, so it is neither entered nor raised under. Nothing was sent.');
  }
  if (raise !== undefined && may !== null) throw new VaultStartOwed(vault, `${may} Nothing was sent.`);
  if (found === undefined && may !== null) return notWrittenDown(may.replace(/\.$/u, ''));
  let tx: string | undefined;
  if (raise !== undefined) {
    tx = (await buildOrOwe(vault, round.what, async () => {
      const chain = await p.service.callState(p.accountId);
      return doors.builder.governedCall({ account: chain.account, order: raise.order, material: doors.material, chain, opened: raise.opened });
    })).tx;
  }
  let entry: ReturnType<typeof proposalEntry> | null = null;
  if (found !== undefined) {
    const id = found.id;
    if (tx !== undefined) {
      const body = { tx, version: DEVICE_RAISE_VERSION, filer: own };
      await sent(vault, round.what, () => p.service.send(id, body));
    }
    if (found.filedBy?.publicKey.toLowerCase() === own) {
      entry = proposalEntry(p.accountId, found);
    } else {
      /* Another seat's record is entered only by that seat's device; until then no device believes it, which is said. */
      try {
        await believedFilerHere({ directory: p.directory }, p.accountId, found);
        return null;
      } catch {
        return notWrittenDown(`the record of it was written down by another signer, and is believed once that signer's device enters it`);
      }
    }
  } else {
    const filed = (): { readonly filing: ReturnType<typeof signProposalFiling>; readonly body: Parameters<VaultStartProposals['service']['file']>[1] } => {
      const sealing = sealingWith(p.companyKeys, 0);
      const filing = signProposalFiling(p.accountId, {
        id: newProposalId(), digest: round.digest.toLowerCase() as Hex, chainId: chainId as Hex,
        keyEpoch: sealing.epoch, createdAt: new Date().toISOString(), sealed: round.seal(sealing.key),
      }, p.signingSecret);
      return {
        filing,
        body: {
          proposal: filing, salt: round.salt.toLowerCase(), ...(round.named === undefined ? {} : { vault: round.named.toLowerCase() }),
          ...(tx === undefined ? {} : { tx, version: DEVICE_RAISE_VERSION }),
        },
      };
    };
    let made: ReturnType<typeof filed>;
    if (tx === undefined) {
      /* The chain holds it already: a record that cannot be sealed or kept now is written down on the next press. */
      try {
        made = filed();
        await p.service.file(p.accountId, made.body);
      } catch (e) {
        return notWrittenDown(`${(e as Error)?.message ?? e}`.replace(/\.$/u, ''));
      }
    } else {
      try {
        made = filed();
      } catch (e) {
        throw new VaultStartOwed(vault, `${round.what} could not be sealed on this device (${(e as Error)?.message ?? e}). Nothing was sent.`);
      }
      await sent(vault, round.what, () => p.service.file(p.accountId, made.body));
    }
    entry = proposalEntry(p.accountId, made.filing);
  }
  if (entry === null) return null;
  try {
    await p.entered.enter([entry]);
    return null;
  } catch (e) {
    /* Written down: entered on the next press, which finds it here again. */
    return notWrittenDown(`it is written down and was not entered in the company's records (${(e as Error)?.message ?? e})`);
  }
}

/** A new vault's adoption, as its record is sealed: a governance proposal for no vault, naming the vault it adopts. */
const adoptionRound = (doors: CreateVaultDoors, vault: Hex, a: StartStandingOnTheWire['adoption'], summary: string): StartRound => ({
  what: 'raising its adoption', called: 'adoption', chainId: a.proposal, digest: a.payload, salt: a.salt,
  seal: (key) => sealGovernanceProposal({
    accountId: doors.proposals.accountId, viewingKey: key, kind: ADOPT_VAULT, summary, noVault: a.named as Hex,
    body: { vault }, change: { asset: NO_ASSET, amount: 0n, batchDigest: ZERO_HEX as Hex, salt: a.salt as Hex },
    proposedBy: doors.me.signerId,
  }),
});

/**
 * A new vault's first secret run, as its record is sealed: its root, payee
 * count and window, never the secret, the nonce or a copy of the secret
 * (`sealVaultSecretProposal` takes none of them).
 */
const secretRunRound = (
  doors: CreateVaultDoors, vault: Hex, run: SecretRunOnTheWire,
  round: { readonly proposal: string; readonly payload: string; readonly named: string; readonly salt: string; readonly opensAt: string; readonly closesAt: string },
  summary: string,
): StartRound => ({
  what: 'raising its first secret', called: 'first secret run', chainId: round.proposal, digest: round.payload, salt: round.salt, named: round.named,
  seal: (key) => sealVaultSecretProposal({
    accountId: doors.proposals.accountId, viewingKey: key, summary,
    run: { vault, root: run.root as Hex, payees: String(run.payees), opensAt: String(round.opensAt), closesAt: String(round.closesAt) },
    change: { asset: run.asset, amount: 0n, batchDigest: ZERO_HEX as Hex, salt: round.salt as Hex },
    proposedBy: doors.me.signerId,
  }),
});

/**
 * Refuses a start, before anything is raised, for a vault or a company account whose circuits are not the ones this
 * app was built with, or whose read does not say: the account would otherwise adopt a vault this app then never starts.
 * The read is the vault worker's at the wallet's indexer, with the account named; who holds either is not asked. A read
 * that runs out of time is asked again within the wait.
 */
async function refuseCircuitsNotThisBuilds(doors: CreateVaultDoors, vault: Hex): Promise<void> {
  const read = await untilReadHere(doors, async () => {
    try {
      return await readHere(doors, vault, doors.account);
    } catch (e) {
      if (ranOutOfTime(e)) return RAN_OUT;
      if (e instanceof VaultNotReadHere) throw new VaultStartOwed(vault, (e as Error).message, START_READ_STOP.chainUnread);
      throw e;
    }
  });
  if (read === RAN_OUT) throw new VaultStartOwed(vault, `${NOT_READ_IN_TIME} Nothing was sent.`, START_READ_STOP.chainUnread);
  if (read === null) throw new VaultStartOwed(vault, `${NO_VAULT_YET} Nothing was sent.`);
  if (!read.onChain) throw new VaultStartOwed(vault, `${NO_VAULT_YET} Nothing was sent.`);
  const circuits = circuitsOfARead(read);
  if (circuits !== null) throw new VaultStartOwed(vault, `${circuits.why} Nothing was sent.`);
}

/**
 * **STEP 5: THE VAULT STARTED, FROM WHAT THE CHAIN SHOWS.** Each step is raised
 * only once the chain shows the one before, and a step the chain already shows
 * is passed over, so this runs again from wherever a press stopped.
 */
async function startCompanyVault(doors: CreateVaultDoors, vault: Hex): Promise<VaultCreated> {
  const noAsset = NO_ASSET;

  /* ---- a. the company's account adopts the vault ---- */
  doors.progress?.('adopting the vault');
  await refuseCircuitsNotThisBuilds(doors, vault);
  let at = await standingNow(doors, vault);
  /* What this press could not leave written down of the two setup proposals, said with whatever the press comes to; every sentence here is of that one kind. */
  const said: string[] = [];
  const sayIt = (sentence: string | null): void => { if (sentence !== null && !said.includes(sentence)) said.push(sentence); };
  const saying = (): { readonly said?: readonly string[]; readonly saidCodes?: readonly SaidCode[] } =>
    (said.length === 0 ? {} : { said: [...said], saidCodes: [SAID.proposalNotWrittenDown] });
  const adoption = adoptionRound(doors, vault, at.standing.adoption, 'Add a new vault to the company');
  /* Whatever the chain shows, the adoption it holds is written down and entered. */
  if (at.standing.adopted || at.standing.adoption.open) sayIt(await proposedAndWrittenDown(doors, vault, adoption));
  if (!at.standing.adopted) {
    const a = at.standing.adoption;
    const governance = { kind: 'adopt-vault', vault } as const;
    const opened: OpenedRound = {
      chainId: a.proposal, digest: a.payload, vault: a.named, salt: a.salt,
      summary: 'Add a new vault to the company', governance,
    };
    if (a.stale) {
      throw new VaultStartOwed(vault, 'a signer was removed or replaced after its adoption was raised, so the chain will '
        + 'not carry that round out. This app cannot withdraw it: the signer who raised it can withdraw it on the chain and it '
        + 'can then be raised again, or a new vault can be created instead. This one holds nothing.', START_STOP.adoptionStale);
    }
    /* No adoption this device raises, approves or carries out leaves the new vault, or any other, unable to pay. */
    try {
      refuseLeavingAVaultShort(await doors.approvers(), { kind: 'adopt', vault }, doors.vaultName);
    } catch (e) {
      throw new VaultStartOwed(vault, `${(e as Error).message.replace(/ Nothing was approved\.$/u, '')} Nothing was sent.`, START_STOP.tooFewApprovers);
    }
    if (!a.open) {
      sayIt(await proposedAndWrittenDown(doors, vault, adoption, {
        order: { circuit: 'propose', adoption: governance, half: nothingMoves(noAsset, a.salt), proposal: a.proposal },
        opened: { ...opened, half: { assetId: noAsset, changeAmount: '0', changeBatchDigest: ZERO_HEX } },
      }));
      at = await untilTheChainShows(doors, vault, 'raising its adoption', (n) => n.standing.adoption.open || n.standing.adopted);
    }
    if (!at.standing.adopted && at.standing.adoption.approvals < at.standing.adoption.needed) {
      const before = at.standing.adoption.approvals;
      const approved = await accountStep(doors, vault, at.chain, 'adoption',
        { circuit: 'approve', proposal: a.proposal, of: { governance, proposalSalt: a.salt } }, opened, 'approving its adoption');
      if (approved === 'sent') {
        at = await untilTheChainShows(doors, vault, 'approving its adoption',
          (n) => n.standing.adopted || n.standing.adoption.approvals > before);
      }
    }
    if (!at.standing.adopted) {
      const now = at.standing.adoption;
      if (now.approvals < now.needed) {
        doors.progress?.('waiting for approvals');
        return { vault, state: 'awaiting-approvals', awaiting: { round: 'adoption', proposal: a.proposal as Hex, approvals: now.approvals, needed: now.needed }, ...saying() };
      }
      await accountStep(doors, vault, at.chain, 'adoption',
        { circuit: 'adopt', vault, proposal: a.proposal, proposalSalt: a.salt }, opened, 'adopting it');
      await untilTheChainShows(doors, vault, 'adopting it', (n) => n.standing.adopted);
    }
  }
  sayIt(await carriedOutWrittenDown(doors, vault, adoption));

  /* ---- b. the pool and the nonce secret: made here, or read back and held to the chain ---- */
  /* From here on the vault must be one the account itself has adopted, as the wallet reads it: never the service's row. */
  await asTheWalletReadIt(doors, vault);
  const checked = (filedTo: readonly Hex[]) => everyReaderChecksOut(doors, vault, filedTo);
  let secret = await openCompanyVaultPool(doors, vault, checked,
    (secret, state) => doors.builder.secretIsTheVaults({ vault, state, secret }));
  doors.progress?.('setting the secret');
  at = await standingNow(doors, vault, secret);
  const first = at.standing.secret;
  if (!secret.madeHere && first !== undefined && !first.set && !first.another && !openNow(first.run)) {
    /*
     * **A SECRET READ BACK THAT NOTHING ON THE CHAIN VOUCHES FOR IS REPLACED,
     * NEVER USED.** The vault has taken no secret and no open run of its
     * signers commits to this one, so whoever filed it - a device that stopped,
     * or a service that chose it - it binds the vault to nothing. A fresh one is
     * made here and the run is raised from that.
     */
    secret = await startTheSecretAgain(doors, vault, secret.filed, checked);
    at = await standingNow(doors, vault, secret);
  }
  const { readers } = await doors.service.keys();
  const missing = readers.filter((r) => !secret.readers.some((k) => k.toLowerCase() === r.toLowerCase()));
  if (missing.length > 0) {
    throw new VaultStartOwed(vault, `${missing.length} signer(s) cannot open the vault's filed secret, so their sealed `
      + 'copies would be missing. Nothing was sent.', START_STOP.readersCannotOpen);
  }

  /*
   * ---- c. the first secret run, and the secret set ----
   * Raised only from a secret made in this press. A secret read back is used
   * only when the chain holds it already, or an open run of the signers commits
   * to it: the run's identity is made from the secret, the keys it is sealed to
   * and its window, so a secret that finds that run with the same keys is the
   * one it was raised with. Before a run is raised and before a secret is set,
   * the records must still hold it as their newest version.
   */
  const run = at.run;
  if (run === undefined || at.standing.secret === undefined) throw new VaultStartOwed(vault, 'its first secret run could not be made.');
  if (at.standing.secret.another) {
    throw new VaultStartOwed(vault, 'it already holds a secret other than the one the company\'s records hold, so its '
      + 'first secret is not set again. Nothing was sent.', START_STOP.anotherSecret);
  }
  {
    /* A first secret run the chain holds in its window for this secret is written down and entered, whatever else it shows. */
    const held = at.standing.secret.run;
    if (held !== null && held.inWindow) sayIt(await proposedAndWrittenDown(doors, vault, secretRunRound(doors, vault, run, held, 'Finish setting up a new vault')));
  }
  if (!at.standing.secret.set) {
    thisSignersCopyOpens(doors, vault, secret, run, readers);
    await everyReaderChecksOut(doors, vault, run.copies.map((c) => String(c.reader)));
    let found = at.standing.secret.run;
    if (found === null || !found.inWindow) {
      if (!secret.madeHere) {
        throw new VaultStartOwed(vault, 'its first secret run would be raised with a secret read back from the company\'s '
          + 'records, which nothing on the chain vouches for. Nothing was sent.', START_STOP.readBackOnly);
      }
      const now = at.now;
      const window = { opensAt: now - 600n, closesAt: now + 14n * 24n * 3_600n };
      const fresh = await standingNow(doors, vault, secret, window);
      const raise = fresh.standing.secret?.raise;
      if (raise === undefined) throw new VaultStartOwed(vault, 'its first secret run could not be made.');
      await stillTheNewestFiled(doors, vault, secret, 'its first secret run');
      /* The secret goes only to the call built here (`made`); the record is sealed from the run's public parts. */
      sayIt(await proposedAndWrittenDown(doors, vault, secretRunRound(doors, vault, run, raise, 'Finish setting up a new vault'), {
        order: {
          circuit: 'propose',
          run: { root: run.root, payees: run.payees, opensAt: raise.opensAt, closesAt: raise.closesAt, vault, required: '0' },
          half: nothingMoves(run.asset, raise.salt), proposal: raise.proposal,
        },
        opened: {
          chainId: raise.proposal, digest: raise.payload, vault: raise.named, salt: raise.salt,
          summary: 'Finish setting up a new vault',
          half: { assetId: run.asset, changeAmount: '0', changeBatchDigest: ZERO_HEX },
          made: { kind: 'vault-secret', vault, secret: secret.secret, readers: [...secret.readers], opensAt: raise.opensAt, closesAt: raise.closesAt },
        },
      }));
      at = await untilTheChainShows(doors, vault, 'raising its first secret',
        (n) => n.standing.secret?.run?.proposal === raise.proposal || n.standing.secret?.set === true, secret);
      found = at.standing.secret!.run;
    }
    if (!at.standing.secret!.set && found !== null && found.approvals < found.needed) {
      const before = found.approvals;
      const approved = await accountStep(doors, vault, at.chain, 'secret-run', { circuit: 'approve', proposal: found.proposal }, {
        chainId: found.proposal, digest: found.payload, vault: found.named, salt: found.salt,
        summary: 'Finish setting up a new vault',
        /* The run this device made from the secret it set: its payload is worked out again where the approval is built. */
        made: { kind: 'vault-secret', vault, secret: secret.secret, readers: [...secret.readers], opensAt: found.opensAt, closesAt: found.closesAt },
      }, 'approving its first secret');
      if (approved === 'sent') {
        const p = found.proposal;
        at = await untilTheChainShows(doors, vault, 'approving its first secret',
          (n) => n.standing.secret?.set === true || (n.standing.secret?.run?.proposal === p && n.standing.secret.run.approvals > before), secret);
        found = at.standing.secret!.run;
      }
    }
    if (!at.standing.secret!.set) {
      if (found === null) throw new VaultStartOwed(vault, 'its first secret run is not on the chain.');
      if (found.approvals < found.needed) {
        doors.progress?.('waiting for approvals');
        return { vault, state: 'awaiting-approvals', awaiting: { round: 'first-secret', proposal: found.proposal as Hex, approvals: found.approvals, needed: found.needed }, ...saying() };
      }
      await stillTheNewestFiled(doors, vault, secret, 'its first secret');
      /* Read afresh right before the secret is set, not only before the run was raised: a signer may have left since. */
      await everyReaderChecksOut(doors, vault, run.copies.map((c) => String(c.reader)));
      const { tx } = await buildOrOwe(vault, 'setting its first secret', () => doors.builder.setNonceSecret({
        vault, account: at.chain.account, run, secret: secret.secret, proposal: found!.proposal, opensAt: found!.opensAt, closesAt: found!.closesAt,
        chain: {
          blockHash: at.chain.blockHash, vaultState: at.chain.vaultState, zswapState: at.chain.zswapState,
          parameters: at.chain.parameters, accountState: at.chain.accountState,
        },
      }));
      await sent(vault, 'setting its first secret', () => startDoorsOf(doors, vault).secret(vault, tx));
      at = await untilTheChainShows(doors, vault, 'setting its first secret', (n) => n.standing.secret?.set === true, secret);
    }
  }
  /* The chain wins: the records' newest version is made the one whose secret the vault now holds. */
  if (await theChainWins(doors, vault, at.chain.vaultState) === 'none-names-it') {
    throw new VaultStartOwed(vault, 'the vault holds a secret that no version of the company\'s records you can open holds, '
      + 'so no money can be put in or paid out with it. Nothing was sent.');
  }
  if (!at.standing.secret!.rootIsThisRuns) {
    throw new VaultStartOwed(vault, 'the sealed copies its signers approved are not the ones made from the company\'s '
      + 'filed secret now. Nothing was sent.');
  }

  /* ---- d. every signer's sealed copy written ---- */
  doors.progress?.('writing the sealed copies');
  for (let place = 0; place < run.copies.length; place += 1) {
    if (at.standing.secret!.written[place] === true) continue;
    const { tx } = await buildOrOwe(vault, 'writing a sealed copy of its secret', () => doors.builder.writeSecretCopy({
      vault, run, place, state: at.chain.vaultState, parameters: at.chain.parameters,
    }));
    await sent(vault, 'writing a sealed copy of its secret', () => startDoorsOf(doors, vault).copy(vault, tx, place));
    at = await untilTheChainShows(doors, vault, 'writing a sealed copy of its secret',
      (n) => n.standing.secret?.written[place] === true, secret);
  }
  if (at.standing.secret?.started !== true) {
    at = await untilTheChainShows(doors, vault, 'the last sealed copy', (n) => n.standing.secret?.started === true, secret);
  }
  await doors.secretKeptHere?.drop(vault);
  doors.progress?.('done');
  return { vault, state: 'started', ...saying() };
}

/**
 * **THIS SIGNER'S OWN COPY OF THE SECRET OPENS WITH THIS SIGNER'S OWN KEY,
 * BEFORE THIS DEVICE RAISES OR APPROVES THE RUN THAT SETS IT.** The sealed
 * copies a vault keeps are sealed to the records keys the company's service
 * lists. This device derives its own records key from the company key its
 * wallet released, refuses when the service's list does not hold it, seals its
 * own copy from the secret it read back, and refuses unless the copy the run
 * would write for it is that one and opens with its own key to that secret.
 * Nothing is raised or approved when it refuses.
 */
function thisSignersCopyOpens(
  doors: CreateVaultDoors, vault: Hex, secret: SecretReadBack, run: SecretRunOnTheWire, readers: readonly Hex[],
): void {
  const mine = recordsKeypairFrom(doors.me.companyKey);
  const me = mine.publicKey.toLowerCase();
  if (!readers.some((r) => String(r).toLowerCase() === me)) {
    throw new VaultStartOwed(vault, 'the list of signers\' keys the company\'s service holds does not have the key '
      + 'your own recovery words give, so you could not read this vault\'s secret back from the chain. Nothing was approved.');
  }
  const own = sealSecretCopy({ vault, secret: secret.secret, reader: me as Hex }).map((p) => toHex(p));
  const copy = run.copies.find((c) => String(c.reader).toLowerCase() === me);
  let opens = false;
  if (copy !== undefined && copy.parts.length === own.length && copy.parts.every((p, i) => String(p).toLowerCase() === own[i])) {
    try {
      opens = openSecretCopy({ vault, parts: copy.parts.map((p) => fromHex(p)), reader: mine }) === secret.secret.toLowerCase();
    } catch {
      opens = false;
    }
  }
  if (!opens) {
    throw new VaultStartOwed(vault, 'the copy of its secret the vault would keep for you does not open with the key your '
      + 'own recovery words give. Nothing was approved.');
  }
}

/**
 * **EVERY KEY THE RUN SEALS A COPY TO, CHECKED BEFORE THIS DEVICE RAISES OR
 * APPROVES IT** (`readerRefusalOf`): signed by its signer's own wallet with the
 * wallet key their seat's opening proves for that seat, one per signer seated now,
 * none missing and none extra, and the vault pinned to the company's account,
 * as the same wallet read the vault. It runs on the
 * keys the service names, before a nonce secret is filed and wrapped to them,
 * and on the keys the run itself holds, before it is raised or approved, not a
 * list beside it; each time with a read of its own.
 *
 * The wallet's screen for that read also shows the person the vault and every
 * key the secret will be sealed to, each named as the roster names it. That is
 * a confirmation for the person to see, not a check the chain enforces: this
 * device proves the approval with the seat's key it holds.
 */
async function everyReaderChecksOut(doors: CreateVaultDoors, vault: Hex, readers: readonly string[]): Promise<void> {
  const sources = doors.secretReaders;
  let roster: readonly RosterVaultKeys[];
  try {
    roster = await sources.roster();
  } catch (e) {
    throw new VaultStartOwed(vault, `who its secret is sealed to could not be checked (${(e as Error)?.message ?? e}). Nothing was approved.`);
  }
  const named = new Map(roster.flatMap((e) => (e.keys === null ? [] : [[e.keys.recordsKey.toLowerCase(), e.name] as const])));
  const keys = [...new Set(readers.map((r) => r.toLowerCase()))];
  /*
   * Shown only when the wallet can take the list: with no reader, or more than one run can seal, the wallet would refuse
   * the whole ask and the person would be told their wallet said nothing; asked plainly instead, the reader check below
   * names what is wrong with the readers.
   */
  const firstSecret: FirstSecretShown | undefined = keys.length === 0 || keys.length > MOST_SECRET_READERS ? undefined : {
    readers: keys.map((key) => {
      const name = named.get(key);
      return name === undefined || name === '' ? { key } : { key, name: name.slice(0, MOST_READER_NAME) };
    }),
  };
  /* Asked afresh for this check alone: who holds the account and this vault, as this signer's own wallet reads them now. */
  let seats: SeatsAsTheWalletRead | null;
  try {
    seats = await sources.read(vault, firstSecret);
  } catch (e) {
    throw new VaultStartOwed(vault, `your wallet did not say who holds the company and this vault (${(e as Error)?.message ?? e}). `
      + 'Nothing was approved.', START_STOP.walletNotAnswered);
  }
  let directory: DirectoryAsBelieved;
  try {
    directory = await sources.directory();
  } catch (e) {
    throw new VaultStartOwed(vault, `whose seat each reader holds could not be checked (${(e as Error)?.message ?? e}). Nothing was approved.`, READER_REFUSAL.directoryUnread);
  }
  const refused = readerRefusalOf({
    company: sources.company, readers, roster, seats, vault, account: doors.account, directory,
  });
  if (refused !== null) throw new VaultStartOwed(vault, refused.says, refused.code);
}

/**
 * **THE CHAIN WINS** (`fileTheChainsSecretAsTheNewest`), over the vault's state
 * as one block showed it: the records' newest nonce secret is made the one the
 * vault's own commitment names. What follows still checks the secret it
 * builds from against that commitment, so a vault no filed version names is
 * refused there.
 */
async function theChainWins(
  doors: PoolDoors & { readonly builder: Pick<VaultBuilderClient, 'secretIsTheVaults'> }, vault: Hex, state: string,
): Promise<'the-newest' | 'filed-again' | 'none-names-it'> {
  return fileTheChainsSecretAsTheNewest({
    vault, me: doors.me, records: doors.records,
    secretIsTheVaults: (secret) => doors.builder.secretIsTheVaults({ vault, state, secret }),
  });
}

/** The start's own form of the check: a vault that fails it is a start not finished, naming why. */
async function asTheWalletReadIt(doors: CreateVaultDoors, vault: Hex): Promise<AccountHolders> {
  try {
    return await theVaultAsItsSignersHoldIt(doors, vault);
  } catch (e) {
    const stoppedAt = e instanceof VaultNotTheCompanys ? READER_REFUSAL.walletReadNothing : undefined;
    throw new VaultStartOwed(vault, (e as Error)?.message ?? String(e), stoppedAt);
  }
}

/** Builds one of the vault's own start calls here, or says the start is not finished and nothing was sent. */
async function buildOrOwe(vault: Hex, what: string, build: () => Promise<{ tx: string }>): Promise<{ tx: string }> {
  try {
    return await build();
  } catch (e) {
    throw new VaultStartOwed(vault, `${what} could not be built on this device (${(e as Error)?.message ?? e}). Nothing was sent.`);
  }
}

/** The run a start is made under, as the worker made it: the page reads only what it hands back. */
export type { SecretRunOnTheWire, StartStandingOnTheWire };

export interface PoolDoors extends Pacing {
  readonly service: VaultService;
  /** The company's account and the vault, as the signer's own wallet reads them for each step. */
  readonly account: AccountAddress;
  readonly onChain: VaultOnChainDoors['onChain'];
  /** The vault is read on this device, by its vault worker, at the indexer the person's own wallet names. */
  readonly builder: Pick<VaultBuilderClient, 'vaultOnChain'>;
  readonly indexer: ChainHereDoors['indexer'];
  readonly me: DeviceSigner;
  /** This device's own records key, so it is not wrapped to twice. */
  readonly myRecordsKey: Hex;
  readonly signers: () => Promise<readonly PoolSigner[]>;
  readonly records: DeviceRecords;
  /** The deposit coins this device has believed, kept sealed in this browser (`vault-coins-kept-here.ts`); absent, none are kept. */
  readonly kept?: CoinsKeptHere;
  /**
   * A new vault's secret as this device kept it in its own store before the
   * company's records were asked to file it, and dropped once the vault has
   * started: so a secret the service did not file is filed again rather than
   * made anew, and one made here is known as made here when it is read back.
   * Absent where the device keeps none.
   */
  readonly secretKeptHere?: SecretKeptHere;
}

/** Where a device keeps a new vault's secret, sealed as it is filed, from before it is filed until the vault has started. */
export interface SecretKeptHere {
  keep(vault: Hex, filed: SealedPool): Promise<void>;
  held(vault: Hex): Promise<SealedPool | null>;
  drop(vault: Hex): Promise<void>;
}

/** The vault's nonce secret as this device holds it: made in this press, or read back from the company's records. */
interface SecretReadBack {
  /** The secret deposits are made under now. */
  readonly secret: Hex;
  /** Every records key the version is wrapped to. */
  readonly readers: readonly Hex[];
  readonly epoch: number;
  /** The version filed, as this device made it or read it. */
  readonly filed: SealedPool;
  /** Made on this device in this press, so nothing but this device vouches for it; false when read back. */
  readonly madeHere: boolean;
}

const openedHere = (doors: Pick<PoolDoors, 'me'>, vault: Hex, filed: SealedPool, madeHere: boolean): SecretReadBack => {
  const opened = openNonceSecrets(filed, vault, recordsKeypairFrom(doors.me.companyKey));
  return { secret: opened.secrets[opened.secrets.length - 1]! as Hex, readers: [...opened.readers] as Hex[], epoch: opened.epoch, filed, madeHere };
};

/**
 * **THE VAULT'S NONCE SECRET, READ BACK FROM THE COMPANY'S RECORDS ROUTE AND
 * OPENED HERE WITH THIS SIGNER'S OWN RECORDS KEY.** Whoever keeps the records
 * can file a secret of their own wrapped to every signer, so a caller uses what
 * this returns only once the chain vouches for it: the vault's own commitment,
 * or an open run of its signers made from it.
 */
async function readTheSecretBack(doors: Pick<PoolDoors, 'me' | 'records' | 'secretKeptHere'>, vault: Hex): Promise<SecretReadBack> {
  const back = await doors.records('nonce-secret').get(vault);
  if (back === null) {
    throw new Error('the company\'s records hold no nonce secret for this vault, so nothing is built from one. File it '
      + 'first: creating the vault again does.');
  }
  const read = openedHere(doors, vault, back, false);
  const kept = await doors.secretKeptHere?.held(vault) ?? null;
  return kept !== null && openedHere(doors, vault, kept, true).secret.toLowerCase() === read.secret.toLowerCase()
    ? { ...read, madeHere: true } : read;
}

/**
 * **THE RECORDS STILL HOLD THIS SECRET AS THEIR NEWEST VERSION**, asked right
 * before a run is raised from it and right before it is set. Another device
 * may have replaced a secret it could not vouch for in the meantime; a secret
 * set on the chain that the records no longer hold as their newest would leave
 * every deposit refused. Nothing read here is built on: it is only compared.
 */
async function stillTheNewestFiled(doors: CreateVaultDoors, vault: Hex, secret: SecretReadBack, what: string): Promise<void> {
  let newest: string | null = null;
  try {
    const filed = await doors.records('nonce-secret').get(vault);
    if (filed !== null) {
      const opened = openNonceSecrets(filed, vault, recordsKeypairFrom(doors.me.companyKey));
      newest = opened.secrets[opened.secrets.length - 1] ?? null;
    }
  } catch {
    newest = null;
  }
  if (newest === null || newest.toLowerCase() !== secret.secret.toLowerCase()) {
    throw new VaultStartOwed(vault, `the company's records no longer hold the secret this device was about to use, so ${what} `
      + 'was not sent: another device may have set a fresh one up meanwhile. Finish setting it up again.');
  }
}

/** A run open on the account now, inside its window: the only kind a secret read back may be approved under. */
const openNow = (run: { readonly open: boolean; readonly inWindow: boolean } | null): boolean =>
  run !== null && run.open && run.inWindow;

/**
 * **A FRESH FIRST SECRET, MADE HERE IN PLACE OF ONE NOTHING VOUCHES FOR**, filed
 * as the next version after the one read back, once every key it would be
 * wrapped to checks out, and handed back as made here.
 */
async function startTheSecretAgain(
  doors: CreateVaultDoors, vault: Hex, filed: SealedPool, beforeFiling: (readers: readonly Hex[]) => Promise<void>,
): Promise<SecretReadBack> {
  const { view, refusal } = await theVaultReadForItsStart(doors, vault);
  if (refusal !== null) throw new VaultStartOwed(vault, refusal);
  const { readers } = await doors.service.keys();
  await beforeFiling(readers);
  const others: NonceSecretReader[] = readers
    .filter((k) => k.toLowerCase() !== doors.myRecordsKey.toLowerCase())
    .map((publicKey) => ({ publicKey }));
  try {
    const made = await startVaultNonceSecretAgainOnThisDevice(vault, doors.me, others, doors.records, new Set(view.everCreated ?? []), filed);
    return openedHere(doors, vault, made, true);
  } catch (e) {
    throw new VaultStartOwed(vault, `a fresh secret could not be filed for it (${(e as Error)?.message ?? e}).`);
  }
}

/**
 * **THE VAULT'S NOTE POOL AND NONCE SECRET, FILED THROUGH THE COMPANY'S RECORDS
 * ROUTE**. Only for a vault pinned to the company's account, as this device
 * reads it, that the chain has never paid into. Each half is skipped when it is already filed, so it can be run again.
 * A secret made here is handed back as made here, opened from the record this
 * device made; one already filed is read back and handed back as that.
 * `beforeFiling` is handed the keys a new nonce secret would be wrapped to,
 * before anything is wrapped, and stops the filing by throwing; there is no
 * filing without it.
 */
/*
 * **WHAT THE CHAIN SHOWS OF A VAULT'S SECRET, BEFORE ANY IS MADE OR FILED.** A vault's nonce commitment is zero until
 * its first secret is set; once it is not, a fresh secret could never be the vault's, and the only one worth filing is
 * one the chain shows (`secretIsTheVaults`). A read that carries no commitment says nothing either way.
 */
const theChainHoldsASecret = (view: VaultChainView): boolean =>
  typeof view.nonceCommitment === 'string' && /[1-9a-f]/iu.test(view.nonceCommitment);

const CHAIN_HOLDS_ANOTHER_SECRET = 'the chain already holds a secret for this vault, and neither the company\'s records '
  + 'nor this wallet hold one the chain shows, so no fresh secret was made: it could never be the vault\'s. Nothing was '
  + 'filed. Finish setting it up on the device whose wallet made it, where that secret is kept.';

/** Whether the chain shows this secret; a secret that does not open, or a read that fails, is not the chain's. */
const theChainsOrNot = async (shows: (secret: Hex, state: string) => Promise<boolean>, secret: Hex | null, state: string): Promise<boolean> =>
  secret !== null && await shows(secret, state).catch(() => false);

/** The newest secret a sealed record of this vault's secret opens to here, or none when it does not open. */
const newestSecretIn = (doors: Pick<PoolDoors, 'me'>, vault: Hex, rec: SealedPool | null): Hex | null => {
  if (rec === null) return null;
  try {
    return openedHere(doors, vault, rec, false).secret;
  } catch {
    return null;
  }
};

/** The version a secret is filed again at: one after the newest the records list. */
const nextVersionOf = async (store: ReturnType<PoolDoors['records']>, vault: Hex, rec: SealedPool, by: Uint8Array): Promise<number> => {
  const all = await store.versions(vault);
  const own = openNonceSecrets(rec, vault, recordsKeypairFrom(by)).version;
  return Math.max(all.length === 0 ? 0 : all[all.length - 1]!.version, own) + 1;
};

export async function openCompanyVaultPool(
  doors: PoolDoors, vault: Hex, beforeFiling: (readers: readonly Hex[]) => Promise<void>,
  chainsSecret?: (secret: Hex, state: string) => Promise<boolean>,
): Promise<SecretReadBack> {
  doors.progress?.('opening the pool');
  const { view, refusal } = await theVaultReadForItsStart(doors, vault);

  if (!view.onChain || refusal !== null) {
    throw new Error(refusal ?? view.why ?? 'the chain does not show this vault yet, so its pool is not opened.');
  }
  const everCreated = new Set(view.everCreated ?? []);
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);




  const store = doors.records('nonce-secret');
  const filedNow = await store.get(vault);
  const secretOwed = filedNow === null;
  const kept = await doors.secretKeptHere?.held(vault) ?? null;
  const chainHolds = theChainHoldsASecret(view);
  const keptIsTheChains = kept !== null && chainHolds && chainsSecret !== undefined && view.state !== undefined
    && await theChainsOrNot(chainsSecret, newestSecretIn(doors, vault, kept), view.state);
  if (chainHolds && !keptIsTheChains && secretOwed) {
    throw new VaultStartOwed(vault, CHAIN_HOLDS_ANOTHER_SECRET);
  }
  const keptHere = keptIsTheChains || (secretOwed && !chainHolds) ? kept : null;
  const readers = secretOwed && keptHere === null ? (await doors.service.keys()).readers : [];
  if (secretOwed && keptHere === null) await beforeFiling(readers);
  if (await doors.records('pool').get(vault) === null) {
    if ((view.notes ?? []).length > 0 || everCreated.size > 0) {
      throw new Error('the chain has already put money in this vault and it has no pool, so a new empty pool '
        + 'would record nothing of it. Nothing is filed; rebuild the pool from the company\'s records instead.');
    }
    await pool.create(vault, { notes: [] });
  }
  if (keptHere !== null) {
    const opened = openedHere(doors, vault, keptHere, true);
    if (filedNow === null) {
      await store.put(vault, keptHere);
    } else if (newestSecretIn(doors, vault, filedNow)?.toLowerCase() !== opened.secret.toLowerCase()) {
      await store.put(vault, refileNonceSecret(keptHere, vault, recordsKeypairFrom(doors.me.companyKey), await nextVersionOf(store, vault, keptHere, doors.me.companyKey)));
    }
    return opened;
  }
  if (secretOwed) {
    const others: NonceSecretReader[] = readers
      .filter((k) => k.toLowerCase() !== doors.myRecordsKey.toLowerCase())
      .map((publicKey) => ({ publicKey }));
    const made = await startVaultNonceSecretOnThisDevice(vault, doors.me, others, doors.records, everCreated);
    return openedHere(doors, vault, made, true);
  }
  doors.progress?.('reading the secret back');
  return readTheSecretBack(doors, vault);
}

/**
 * **HOW THE LEDGER THIS PAGE BUILDS WITH BEGINS THE BYTES OF ITS PARAMETERS,
 * VERSION INCLUDED.** Parameters of any other version are ones the vault worker
 * cannot read, so a deposit refuses them before a coin is chosen or its journal
 * line filed. A test pins this against the installed ledger.
 */
export const LEDGER_PARAMETERS_HEADER = 'midnight:ledger-parameters[v8]:';

export interface DepositDoors extends PoolDoors {
  /** The company's label, and the account that carries it: the wallet reads one off the other before it pays. */
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  readonly builder: VaultBuilderClient;
  readonly pay: (ask: { company: CompanyLabel; account: AccountAddress; vault: VaultAddress; transaction: string }) =>
    Promise<{ transaction: string; leaves: readonly unknown[] }>;
  readonly indexer: ChainHereDoors['indexer'];
  /** Where this device keeps a deposit it has sent until the chain holds it or it can no longer land. */
  readonly inFlight: DepositsInFlight;
  /** The time now, in milliseconds. */
  readonly clock?: () => number;
}

/**
 * **A DEPOSIT THIS DEVICE HAS HANDED OVER TO BE SENT AND HAS NOT YET SEEN
 * LAND.** Kept on this device, and only here, sealed under the signer's own
 * key: it names the coin, so it never leaves it and is never kept readable.
 */
export interface DepositInFlight {
  readonly coin: { readonly nonce: Hex; readonly token: Hex; readonly value: string };
  /**
   * When this was written, in milliseconds. It is written after the deposit is
   * built and before the wallet is asked, so the transaction's own time to live
   * ends no later than this plus `DEPOSIT_TIME_TO_LIVE_MS`.
   */
  readonly recordedAt: number;
  /** The service's reference for the send, once it has one. */
  readonly txRef: string;
  /** The transaction's hash, once the service has named it. */
  readonly transactionHash: string | null;
}

/**
 * One deposit in flight per vault on this device: a second is refused until
 * the first is settled, and a deposit's record is changed or forgotten only
 * under the claim it was kept with.
 */
export type DepositsInFlight = KeptOnThisDevice<DepositInFlight>;

/**
 * **HOW LONG A DEPOSIT CAN TAKE TO LAND, AT MOST.** The call is built with a
 * time to live of one hour from when it is built (`ttlOneHour` in
 * `@midnight-ntwrk/midnight-js-contracts`), and the ledger refuses a
 * transaction whose time to live is behind the block it would go in. A quarter
 * of an hour more covers a block clock and this device's clock disagreeing.
 * Past this, a deposit the chain does not hold never will.
 */
export const DEPOSIT_TIME_TO_LIVE_MS = 75 * 60_000;

/** **THE DEPOSIT MAY HAVE BEEN SENT AND THE VAULT DOES NOT HOLD IT YET.** The money may have moved. */
export class DepositNotYetSeen extends Error {
  constructor(readonly vault: Hex, readonly txRef: string) {
    super(`${txRef === '' ? 'the deposit may have been sent' : `the deposit was sent (${txRef})`} and has not reached `
      + 'the vault yet. It may still arrive; if it does not, no money moved. Do not put the same money in again to '
      + 'replace it: if both arrive, the vault holds both. In a minute or two, press "Check my last deposit" in this '
      + 'browser to add it to the vault\'s record once it arrives.');
    this.name = 'DepositNotYetSeen';
  }
}

/**
 * **THE DEPOSIT IS IN THE VAULT AND IS NOT IN ITS RECORD YET.** Either the
 * transaction that made it cannot be read yet, or the vault's notes and its
 * history were read a moment apart. The money is the vault's. Nothing is
 * recorded until it can be; the next deposit from this browser, or a check of
 * the last one, asks again.
 */
export class DepositLandedNotYetRecorded extends Error {
  constructor(readonly vault: Hex, readonly txRef: string) {
    super(`the deposit${txRef === '' ? '' : ` (${txRef})`} is in the vault. This page could not yet read the transfer `
      + 'that brought it in, so it is not in the vault\'s record and cannot be used for a payment yet. In a minute or '
      + 'two, press "Check my last deposit" in this browser to add it. Do not put the same money in again.');
    this.name = 'DepositLandedNotYetRecorded';
  }
}

/**
 * **AN EARLIER DEPOSIT FROM THIS BROWSER HAS NOT ARRIVED AND CAN STILL ARRIVE.**
 * No coin is chosen for a second one: made now, it could be the same coin, and
 * the chain would refuse it after its fee.
 */
export class DepositStillInFlight extends Error {
  constructor(readonly vault: Hex, readonly txRef: string, readonly until: number) {
    const at = new Date(until).toLocaleString();
    super(`an earlier deposit into this vault from this browser${txRef === '' ? '' : ` (${txRef})`} has not reached the `
      + `vault yet, and can still arrive until ${at}. Nothing new was prepared or sent. Try again after ${at}: if the `
      + 'earlier deposit has arrived by then, it is recorded first; if it has not, it never will, and your new deposit '
      + 'goes ahead.');
    this.name = 'DepositStillInFlight';
  }
}

/**
 * **ANOTHER TAB OF THIS BROWSER STARTED A DEPOSIT INTO THIS VAULT A MOMENT
 * AGO.** Only one is kept on its way per vault, so this one stops before the
 * wallet is asked.
 */
export class DepositStartedElsewhere extends Error {
  constructor(readonly vault: Hex) {
    super('another deposit into this vault started in another tab or window of this browser a moment ago, so this one '
      + 'stopped before your wallet was asked. Nothing was sent and no money moved. Wait a minute and try again: this '
      + 'page then tells you if that deposit is still on its way.');
    this.name = 'DepositStartedElsewhere';
  }
}

/**
 * **THE DEPOSIT WAS NOT SENT, AFTER THE WALLET HAD FINISHED IT.** No money
 * moved. The wallet set coins aside when it finished the transaction; only the
 * wallet lets them go, once that transaction can no longer be sent.
 */
export class DepositNotSent extends Error {
  constructor(readonly vault: Hex, why: string) {
    super(`the deposit was not sent, so no money moved (${why}). You can put money in again now. Your wallet may show `
      + 'part of its balance as held for this deposit until the transaction it finished can no longer be sent, about '
      + 'an hour after it was prepared; only your wallet can release that hold.');
    this.name = 'DepositNotSent';
  }
}

const inFlightCoin = (d: DepositInFlight) => ({ nonce: d.coin.nonce, token: d.coin.token, value: BigInt(d.coin.value) });

/**
 * `not-yet` carries `listed` when the vault's history was read in full and no
 * transaction on it carries the output: the chain has not made it, or the
 * indexer has not caught up. Without it, something could not be read.
 */
type CreatingTransactionFound =
  | { state: 'found'; createdIn: Hex } | { state: 'not-yet'; listed?: 'none' } | { state: 'unknown'; why: string; listed?: 'none' };

/**
 * **WHICH TRANSACTION CREATED AN OUTPUT OF THIS VAULT, AS THE CHAIN SAYS, OR
 * WHY IT CANNOT BE SAID.**
 *
 * Asked first of the transaction the service named, by its hash, when it named
 * one; then, when that does not answer, of the vault's own history by the
 * output's commitment, which needs nothing from the send at all. Either way
 * the events must carry exactly one output with this commitment, owned by this
 * vault, and be one transaction's: that is judged in the vault worker, because
 * judging it loads the ledger, which this page does not carry. So a lookup
 * proposes a transaction and never decides one. `not-yet` is a chain or a
 * worker that cannot answer yet, and asking again may answer it.
 */
async function creatingTransactionOfOutput(
  doors: { readonly builder: Pick<VaultBuilderClient, 'creatingTransaction' | 'eventsOf' | 'createdBy'>; readonly indexer: ChainHereDoors['indexer'] },
  vault: Hex, output: string, transactionHash: string | null,
  /** What the output is, as a refusal names it. */
  what = 'this deposit',
): Promise<CreatingTransactionFound> {
  const judge = async (hash: string, events: EventOnTheWire[]): Promise<CreatingTransactionFound> => {
    if (events.length === 0) return { state: 'not-yet' };
    let judged: CreatingTransactionAnswer;
    try {
      judged = await doors.builder.creatingTransaction({ vault, commitment: output, transactionHash: hash, events });
    } catch {
      return { state: 'not-yet' };
    }
    if (judged.state === 'found') return { state: 'found', createdIn: judged.createdIn as Hex };
    if (judged.state === 'refused') return { state: 'unknown', why: `the transfer this page was given does not show ${what}` };
    return { state: 'not-yet' };
  };
  const indexer = await theWalletsIndexer(doors, vault);
  const named = transactionHash === null ? null : transactionHash.toLowerCase();
  let byName: CreatingTransactionFound | null = null;
  if (named !== null && HEX64.test(named)) {
    try {
      byName = await judge(named, await doors.builder.eventsOf({ transactionHash: named, indexer }));
    } catch {
      byName = { state: 'not-yet' };
    }
    if (byName.state === 'found') return byName;
  }
  let byOutput: CreatingTransactionFound;
  try {
    const found = await doors.builder.createdBy({ vault, commitment: output, indexer });
    byOutput = found === null ? { state: 'not-yet', listed: 'none' } : await judge(String(found.transactionHash).toLowerCase(), found.events);
  } catch {
    byOutput = { state: 'not-yet' };
  }
  if (byOutput.state === 'found' || byOutput.state === 'unknown') return byOutput;
  /* The history could not be read in full: ask again. */
  if (byOutput.listed !== 'none') return byOutput;
  /* The history, read in full, has no transaction that carries it: what the named one said stands, if it said anything. */
  return byName?.state === 'unknown' ? { ...byName, listed: 'none' } : byOutput;
}

/** What a deposit left in the vault's record, once the chain holds it. */
export interface DepositRecorded {
  readonly note: { nonce: Hex; token: Hex; value: bigint; createdIn?: Hex };
  /**
   * Present when the note is recorded without the transaction that created
   * it: the money is the vault's, and it cannot be paid out until that
   * transaction is named. Says why.
   */
  readonly notYetSpendable?: string;
}

/** Forgotten as in flight. A failure to forget is not a failure of the deposit: the next look finds it settled again. */
const letGo = async (doors: DepositDoors, vault: Hex, claim: string): Promise<void> => {
  await doors.inFlight.forget(vault, claim).catch(() => { /* the next look settles it again, and finds nothing to do */ });
};

/**
 * **RECORDS A DEPOSIT THE VAULT'S NOTES HOLD, ONCE, AND FORGETS IT AS IN
 * FLIGHT.** Only ever called once the vault's notes hold this coin. A pool that
 * already holds its nonce has it recorded already, by this browser or another
 * signer's. `giveUp` is for a deposit whose own time to live has passed: the
 * note is in the vault for good, so if the transaction that made it still
 * cannot be read, it is recorded without it rather than kept waiting for ever.
 */
async function recordLandedDeposit(
  doors: DepositDoors, vault: Hex, d: Kept<DepositInFlight>, output: string,
  how: { readonly waiting: boolean; readonly giveUp: boolean },
): Promise<DepositRecorded> {
  const coin = inFlightCoin(d);
  let found = await creatingTransactionOfOutput(doors, vault, output, d.transactionHash);
  if (found.state === 'not-yet' && how.waiting) {
    found = (await until(doors, async () => {
      const again = await creatingTransactionOfOutput(doors, vault, output, d.transactionHash);
      return again.state === 'not-yet' ? null : again;
    })) ?? found;
  }
  if (found.state === 'not-yet') {
    /* The vault holds the note and its transaction is not readable yet: nothing is written, and asking again answers it. */
    if (!how.giveUp) throw new DepositLandedNotYetRecorded(vault, d.txRef);
    found = { state: 'unknown', why: 'this page could not read the transfer that brought it in' };
  }
  const note = { ...coin, ...(found.state === 'found' ? { createdIn: found.createdIn } : {}) };
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  const ATTEMPTS = 5;
  for (let attempt = 1; ; attempt += 1) {
    const now = await pool.load(vault);
    if (now.notes.some((n) => n.nonce.toLowerCase() === coin.nonce.toLowerCase())) break;
    try {
      await pool.save(vault, { notes: afterDeposit(now, note).notes }, now.readAt);
      break;
    } catch (cause) {
      if (!isALostPoolRace(cause) || attempt === ATTEMPTS) throw cause;
    }
  }
  /*
   * The coin is kept on this device before its record of the deposit on its way is let go, so a rebuild here finds
   * it even when the company's service withholds the journal and the pool. A keep that fails loses nothing filed.
   */
  try {
    await doors.kept?.keep(vault, [coin]);
  } catch {
    /* The deposit is recorded in the vault's pool; only this device's own extra copy of its coin is missing. */
  }
  await letGo(doors, vault, d.claim);
  return { note, ...(found.state === 'unknown' ? { notYetSpendable: found.why } : {}) };
}

/**
 * **WHAT BECAME OF A DEPOSIT KEPT ON ITS WAY AND NOT YET SEEN ARRIVE.**
 *
 *   · the chain made its coin and the vault's record already holds its nonce
 *     (recorded here or by another signer): nothing to record, and it is
 *     forgotten. A record naming the nonce, with the chain showing no such
 *     coin made, releases nothing: a record alone is not the chain's word;
 *   · the vault's notes hold its coin: the note is recorded, under the
 *     transaction the chain says created it; once its time to live has
 *     passed, without that transaction if it still cannot be read;
 *   · the chain made it, the vault's notes do not hold it, and a believed
 *     version of the vault's record once named it: it landed and has since
 *     left the vault (recorded, then spent or merged), so it is forgotten;
 *   · the chain made it and no record ever named it: it has arrived and is
 *     not recorded yet, so it is kept (`DepositLandedNotYetRecorded`);
 *   · its time to live has passed and the chain never made it: it never will,
 *     and it is forgotten;
 *   · otherwise it can still arrive, and `DepositStillInFlight` says so.
 *
 * Nothing is recorded that the vault's notes do not hold. With `files` false (a
 * check on the page, which signs nothing) a deposit the vault holds is not
 * recorded: it is said to be owed its record and kept, for a signer's wallet to
 * record.
 */
export async function settleDepositInFlight(
  doors: DepositDoors, vault: Hex, view?: VaultChainView, files = true,
): Promise<{ state: 'none' | 'never-landed' | 'already-recorded' | 'landed-owed-its-record' | 'landed-and-since-spent' } | ({ state: 'recorded' } & DepositRecorded)> {
  const d = await doors.inFlight.get(vault);
  if (d === null) return { state: 'none' };
  const seen = view ?? await notesAsThisDeviceReadsThem(doors, vault);
  const { output, held } = await doors.builder.commitments({ vault, coin: d.coin });
  const bare = (h: string) => h.toLowerCase().replace(/^0x/u, '');
  const made = (seen.everCreated ?? []).some((c) => bare(c) === bare(output));
  const holds = (notes: readonly string[] | undefined) => (notes ?? []).some((n) => n.toLowerCase() === held.toLowerCase());
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  if (made && (await pool.load(vault)).notes.some((n) => n.nonce.toLowerCase() === d.coin.nonce.toLowerCase())) {
    await letGo(doors, vault, d.claim);
    return { state: 'already-recorded' };
  }
  const until = d.recordedAt + DEPOSIT_TIME_TO_LIVE_MS;
  const past = (doors.clock ?? Date.now)() > until;
  const landed = async (): Promise<{ state: 'recorded' | 'landed-owed-its-record' } & Partial<DepositRecorded>> => {
    if (!files) return { state: 'landed-owed-its-record' };
    return { state: 'recorded', ...await recordLandedDeposit(doors, vault, d, output, { waiting: false, giveUp: past }) };
  };
  if (holds(seen.notes)) return await landed() as never;
  if (made) {
    /*
     * Made and not held: it landed, and either it has since left the vault (a signer recorded it, and a payment or a
     * merge spent it) or the read saw it made before it saw it held. Only a believed version of the vault's record
     * that ever named its nonce says the first, so only then is the claim let go: the deposit cannot be sent again.
     */
    let named = false;
    for (const v of await doors.records('pool').versions(vault)) {
      if (v.neverEntered === true) continue;
      try {
        const page = openPool(v.sealed, doors.me.signerId, doors.me.wrappingSecret, { record: 'pool' }) as { notes?: Array<{ nonce?: string }> };
        if ((page.notes ?? []).some((n) => String(n.nonce).toLowerCase() === d.coin.nonce.toLowerCase())) { named = true; break; }
      } catch {
        /* a version this signer cannot open names nothing it can read */
      }
    }
    if (!named) throw new DepositLandedNotYetRecorded(vault, d.txRef);
    await letGo(doors, vault, d.claim);
    return { state: 'landed-and-since-spent' };
  }
  if (past) {
    await letGo(doors, vault, d.claim);
    return { state: 'never-landed' };
  }
  throw new DepositStillInFlight(vault, d.txRef, until);
}

/**
 * **THE CHAIN'S LEDGER PARAMETERS NOW, FOR A DEPOSIT INTO THIS VAULT, OR A
 * REFUSAL THAT NAMES ONLY A DEPOSIT'S OWN REASONS.** Read from the one block's
 * view a payment out is built on. Bytes that are not the parameters of the
 * ledger version this page builds with are refused.
 */
async function chainParametersForADeposit(doors: BuiltOnHereDoors, vault: Hex): Promise<string> {
  const notRead = () => new Error('the chain\'s current parameters could not be read for this vault, so no '
    + 'coin was chosen and nothing was built or sent. Try again shortly.');
  let at: Awaited<ReturnType<typeof chainAtOneBlockHere>>;
  try {
    at = await chainAtOneBlockHere(doors, vault);
  } catch {
    throw notRead();
  }
  const answeredWrongly = (why: string) => new Error('the chain your wallet reads answered with something other than '
    + `this vault's current parameters (${why}), so no coin was chosen and nothing was built or sent. Try again; if `
    + 'this happens again, the indexer your wallet names needs attention.');
  if (typeof at.parameters !== 'string' || at.parameters.length === 0) {
    throw answeredWrongly('the answer was not this vault\'s parameters');
  }
  let header: string;
  try {
    header = atob(at.parameters.slice(0, 44));
  } catch {
    throw answeredWrongly('the answer was not ledger parameters');
  }
  if (!header.startsWith(LEDGER_PARAMETERS_HEADER.slice(0, LEDGER_PARAMETERS_HEADER.indexOf('[v') + 2))) {
    throw answeredWrongly('the answer was not ledger parameters');
  }
  if (!header.startsWith(LEDGER_PARAMETERS_HEADER)) {
    throw new Error('the network is running a different ledger version from the one this page builds deposits with, '
      + 'so no coin was chosen, nothing was built or sent, and no money has moved. Reload the page; if this stays, '
      + 'deposits cannot be made from this page until it matches the network again.');
  }
  return at.parameters;
}
/**
 * Puts a private deposit into the vault: refuses unless the vault is fundable, settles an earlier deposit kept on its
 * way in `doors.inFlight` first, keeps the coin before it is paid, and from the send on says the deposit may have landed
 * on every failure but one the send marks as having sent nothing. The wallet runs it whole, and its send marks none:
 * no page's word that nothing left is believed.
 */
export async function depositIntoCompanyVault(
  doors: DepositDoors, vault: Hex, money: DepositMoney,
): Promise<{
  txRef: string; transactionHash: string | null;
  /** What became of an earlier deposit kept on its way in `doors.inFlight`, settled before this one chose its coin. */
  earlier?: Awaited<ReturnType<typeof settleDepositInFlight>>;
} & DepositRecorded> {
  /* Read on this device: the vault must be one the company's account adopted, as this signer's own wallet reads the chain. */
  doors.progress?.('checking the vault');
  const answer = await fundableOrThrow(doors, vault);
  /* Asked before a coin is chosen or the wallet is asked, so a deposit into a vault not yet started books nothing. */
  if (answer.of !== 'fundable') throw new Error(answer.why);
  const view = answer.view;
  if (view.state === undefined) throw new Error('the chain does not show this vault\'s state, so no money goes in.');
  /*
   * **AN EARLIER DEPOSIT FROM THIS DEVICE IS SETTLED FIRST.** Recorded if it has
   * landed, forgotten if it never can; while it still can, no coin is chosen
   * for this one, because it could be the same coin. It needs nothing of the
   * chain's parameters, so it is settled even when this deposit is refused
   * for them below.
   */
  const earlier = await settleDepositInFlight(doors, vault, view);
  /*
   * **THE CHAIN'S PARAMETERS NOW, READ BEFORE A COIN IS CHOSEN**, from the one
   * block's view a payment out is built on, so if the chain cannot be read no
   * coin is chosen or recorded. The deposit is built with these and never with
   * the ledger's starting parameters. Bytes that are not the parameters of the
   * ledger version this page builds with are refused here too, before a coin
   * is chosen or its journal line filed.
   *
   * The block is read through the route a payment out also reads. Its own
   * refusals are worded for a payment, so none of its words reach this
   * deposit's refusal: only this deposit's own reasons do.
   */
  const parameters = await chainParametersForADeposit(doors, vault);
  const notes = new Set((view.notes ?? []).map((n) => n.toLowerCase()));
  const commitments = (coin: { nonce: Hex; token: Hex; value: bigint }) => doors.builder.commitments({
    vault, coin: { nonce: coin.nonce, token: coin.token, value: coin.value.toString() },
  });
  /* The records' newest secret is the vault's own, filed again from an earlier version when it is not. */
  await theChainWins(doors, vault, view.state);
  doors.progress?.('choosing the coin');
  const { coin } = await depositCoinOnThisDevice({
    vault, money, me: doors.me, signers: doors.signers, records: doors.records,
    chain: {
      everCreated: new Set(view.everCreated ?? []),
      outputCommitmentOf: async (c) => (await commitments(c)).output,
      heldNow: async (c) => notes.has((await commitments(c)).held.toLowerCase()),
      /* The same state the deposit is built against below: a state that lies about the commitment is refused by the chain. */
      secretIsTheVaults: (secret) => doors.builder.secretIsTheVaults({ vault, state: view.state!, secret }),
    },
  });
  doors.progress?.('building the deposit');
  const built = await doors.builder.deposit({
    vault, coin: { nonce: coin.nonce, token: coin.token, value: coin.value.toString() }, state: view.state, parameters,
  });
  /*
   * **WORKED OUT BEFORE THE WALLET IS ASKED, AND THIS MAY NOT MOVE BELOW THE
   * SEND.** What the chain will show for this coin is read off the vault worker
   * now, while a failure means nothing was paid; after the send, a worker that
   * stopped would read as a failure of a deposit that may have been sent.
   */
  const { output, held } = await commitments(coin);
  /*
   * **KEPT ON THIS DEVICE BEFORE THE WALLET IS ASKED, AND THIS MAY NOT MOVE
   * BELOW THE SEND.** From the send on, the money may move whatever happens to
   * this page, and this is what the next deposit from here looks for first.
   */
  const coinOnTheWire = { nonce: coin.nonce, token: coin.token, value: coin.value.toString() };
  const first: DepositInFlight = { coin: coinOnTheWire, recordedAt: (doors.clock ?? Date.now)(), txRef: '', transactionHash: null };
  /* Kept only where nothing is: another tab's deposit into this vault, kept since this one settled, stops this one here. */
  const claim = await doors.inFlight.claim(vault, first);
  if (claim === null) throw new DepositStartedElsewhere(vault);
  let inFlight: Kept<DepositInFlight> = { ...first, claim };
  doors.progress?.('asking your wallet');
  let paid: { transaction: string; leaves: readonly unknown[] };
  try {
    paid = await doors.pay({ company: doors.company, account: doors.account, vault: vault as VaultAddress, transaction: built.tx });
  } catch (e) {
    await letGo(doors, vault, claim);
    throw e;
  }
  doors.progress?.('sending the deposit');
  let sent: { txRef: string; transactionHash: string | null };
  try {
    sent = await doors.service.deposit(vault, paid.transaction);
  } catch (e) {
    if (!sentNothing(e)) throw new DepositNotYetSeen(vault, '');
    await letGo(doors, vault, claim);
    throw new DepositNotSent(vault, (e as Error)?.message ?? String(e));
  }
  inFlight = { ...inFlight, txRef: sent.txRef, transactionHash: sent.transactionHash };
  await doors.inFlight.update(vault, claim, { coin: inFlight.coin, recordedAt: inFlight.recordedAt, txRef: sent.txRef, transactionHash: sent.transactionHash })
    .catch(() => { /* the record kept before still names the coin, and the chain is asked by its commitment */ });
  doors.progress?.('recording the deposit');
  const seen = await until(doors, async () => {
    /* The deposit is sent: a read that fails now is asked again, and never reported as nothing sent. */
    const v = await notesAsThisDeviceReadsThem(doors, vault).catch(() => null);
    return (v?.notes ?? []).some((n) => n.toLowerCase() === held.toLowerCase()) ? true : null;
  });
  if (!seen) throw new DepositNotYetSeen(vault, sent.txRef);
  const recorded = await recordLandedDeposit(doors, vault, inFlight, output, { waiting: true, giveUp: false });
  doors.progress?.('done');
  return { txRef: sent.txRef, transactionHash: sent.transactionHash, ...recorded, ...(earlier.state === 'none' ? {} : { earlier }) };
}

/* ----------------------------------------------------------- a public deposit */

/** What the vault receives in a public deposit: one public token, and an amount of it in its smallest unit. */
export interface PublicDepositMoney {
  readonly token: Hex;
  readonly value: bigint;
}

/**
 * **A PUBLIC DEPOSIT MAY HAVE BEEN SENT, AND THIS PAGE HAS NOT SEEN IT ARRIVE.** The
 * money may have moved. Raised for every failure after the service began
 * sending, and when the chain at the wallet's indexer has not shown the deposit
 * by the end of the wait or cannot be looked at, so no screen reads it as a
 * deposit that did not happen. `cause`, when given, is why this page could not
 * see it, and is named for support.
 */
export class PublicDepositNotYetSeen extends Error {
  constructor(readonly vault: Hex, readonly until: number, cause?: unknown) {
    super('the public deposit may have been sent, and this page was not told whether it arrived. Do not put the same '
      + `money in again before ${new Date(until).toLocaleTimeString()}. If it has not arrived by then, it never will. `
      + 'Open your wallet: if its public balance has dropped by this amount and you spent nothing else from it, the '
      + 'vault has it. "Check my last deposit" finds only private deposits, so it cannot tell you about this one.'
      + (cause === undefined ? '' : ` Details for support: ${(cause as Error)?.message ?? String(cause)}`),
      cause === undefined ? undefined : { cause });
    this.name = 'PublicDepositNotYetSeen';
  }
}

/**
 * Whether a failed look for a landed public deposit may come right if it is asked again: the read ran out of time,
 * the vault worker stopped or was too slow, or the indexer could not be read (`NoteIndexUnreadable`, which is also
 * what a transaction not yet indexed looks like). Anything else - the wallet naming no indexer, the indexer refusing
 * the question, bytes the worker cannot read or that carry no identifier - answers the same way every time.
 */
const aLookThatMayClear = (e: unknown): boolean => {
  if (e instanceof ReadRanOutOfTime) return true;
  if (!(e instanceof VaultAskFailed)) return false;
  if (e.reason === 'took-too-long' || e.reason === 'stopped') return true;
  return e.reason === 'answered' && e.workerName === 'NoteIndexUnreadable';
};

export interface PublicDepositDoors extends Pacing {
  readonly service: VaultService;
  readonly builder: VaultBuilderClient;
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  readonly onChain: VaultOnChainDoors['onChain'];
  readonly indexer: ChainHereDoors['indexer'];
  readonly pay: DepositDoors['pay'];
  /** The time now, in milliseconds. */
  readonly clock?: () => number;
}

const HEX32_TOKEN = /^[0-9a-f]{64}$/u;

/**
 * **A PUBLIC TOKEN PUT INTO THE COMPANY'S VAULT AS IT IS.**
 *
 * The vault's public deposit takes one token and one amount; the chain adds them
 * to the vault's public balance, which anyone can read. So, unlike a private
 * deposit, **NOTHING IS CHOSEN, KEPT OR RECORDED ON THIS DEVICE**: there is no
 * coin, no nonce, no journal line and no note, and a vault that holds only
 * public money needs no record of its own to be paid out of.
 *
 *   1. the vault, read on this device, must be adopted by the company's account,
 *      pinned to it and started, with every circuit of it and of the account this
 *      app's, as for a private deposit; the chain's parameters are read the same way;
 *   2. the deposit is built and proved in the vault worker, which refuses one
 *      that would ask for anything but this token and this amount;
 *   3. the signer's own wallet pays the public amount and signs, after showing
 *      the token, the amount, and that both are public;
 *   4. the wallet's answer must name exactly this token and this amount leaving
 *      it, or nothing is sent;
 *   5. the service adds the network fee and sends it, and refuses one that is
 *      not exactly this vault's public deposit of this token and this amount;
 *   6. this device waits until the chain at the wallet's indexer shows the very
 *      transaction the wallet signed, applied in full and calling this vault's
 *      public deposit, and only then says it is done. It returns the chain's hash
 *      of that transaction, never the service's.
 *
 * **WHY NOTHING IS KEPT ON THIS DEVICE.** A private deposit is kept here
 * until the chain holds it because its coin was chosen here and its note must
 * be recorded, and a second deposit must not choose the same coin. A public
 * deposit has none of those: if this page closes during the wait there is
 * nothing on this device to finish, and the wallet's public balance and the
 * chain say whether it arrived.
 */
export async function depositPubliclyIntoCompanyVault(
  doors: PublicDepositDoors, vault: Hex, money: PublicDepositMoney,
): Promise<{ txRef: string; transactionHash: string; token: Hex; value: bigint }> {
  /* The token as the asset's row names it: 64 lowercase hex characters, compared and sent as it is. */
  if (typeof money.token !== 'string' || !HEX32_TOKEN.test(money.token)) {
    throw new Error('this is not a public token a vault can hold, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  if (typeof money.value !== 'bigint' || money.value <= 0n) throw new Error('an amount of nothing is not a deposit.');
  if (typeof doors.service.depositPublicly !== 'function') {
    throw new Error('this page cannot send a public deposit, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  doors.progress?.('checking the vault');
  const answer = await fundableOrThrow(doors, vault);
  /* Asked before the wallet is, so a deposit into a vault not yet started asks the wallet for nothing. */
  if (answer.of !== 'fundable') throw new Error(answer.why);
  const view = answer.view;
  if (view.state === undefined) throw new Error('the chain does not show this vault\'s state, so no money goes in.');
  const parameters = await chainParametersForADeposit(doors, vault);
  if (typeof doors.builder.publicDeposit !== 'function') {
    throw new Error('this page cannot build a public deposit, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  /* A deposit this page could not watch arrive would end with nobody able to say it did, so it is not started. */
  if (typeof doors.builder.publicDepositLanded !== 'function') {
    throw new Error('this page cannot watch the chain for a public deposit, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  doors.progress?.('building the deposit');
  const built = await doors.builder.publicDeposit({
    vault, token: money.token, amount: money.value.toString(), state: view.state, parameters,
  });
  doors.progress?.('asking your wallet');
  const paid = await doors.pay({ company: doors.company, account: doors.account, vault: vault as VaultAddress, transaction: built.tx });
  /*
   * **WHAT THE WALLET SAYS LEFT IT MUST BE WHAT WAS ASKED.** The wallet reads the
   * amount from the transaction, not from this page; an answer naming anything
   * else is not sent. What it booked is let go when the transaction can no
   * longer be sent.
   */
  const leaves = Array.isArray(paid?.leaves) ? paid.leaves as readonly { token?: unknown; amount?: unknown; kind?: unknown }[] : [];
  if (leaves.length !== 1 || leaves[0]?.kind !== 'unshielded'
    || String(leaves[0]?.token).toLowerCase() !== money.token || String(leaves[0]?.amount) !== money.value.toString()) {
    throw new Error('your wallet prepared a payment for something other than this public deposit, so this page did not '
      + 'send it and no money moved. You can put money in again now.');
  }
  doors.progress?.('sending the deposit');
  /* The deposit is built to live an hour, and no longer than this, clocks disagreeing included. */
  const livesUntil = (doors.clock ?? Date.now)() + DEPOSIT_TIME_TO_LIVE_MS;
  let sent: { txRef: string; transactionHash: string | null };
  try {
    sent = await doors.service.depositPublicly(vault, paid.transaction, { token: money.token, amount: money.value.toString() });
  } catch (e) {
    if (!sentNothing(e)) throw new PublicDepositNotYetSeen(vault, livesUntil);
    const at = new Date(livesUntil).toLocaleTimeString();
    throw new Error(`the public deposit was not sent, so no money has moved yet. Your wallet already signed it, and `
      + `until ${at} anyone can still send it. If they do, the money goes into this vault and nowhere else. Do not put `
      + `the same money in again before ${at}, or the vault may receive it twice. The service said: `
      + `${(e as Error)?.message ?? String(e)}`);
  }
  /*
   * **DONE ONLY WHEN THE CHAIN SHOWS IT.** The service's answer, its hash included, is its own word. The deposit is
   * looked for at the indexer the wallet names, by the identifiers of the very transaction the wallet signed, which the
   * service's fee does not change: applied in full, and calling this vault's public deposit. Another deposit of the
   * same token and amount is another transaction and is never taken for this one. A read that may come right if asked
   * again keeps the wait going; one that cannot ends it at once. Either way the person is told the deposit may have
   * been sent, with the last reason the page could not see it.
   */
  doors.progress?.('waiting for the chain');
  let lastFailure: unknown;
  const seen = await until<{ readonly found: { readonly transactionHash: string } } | { readonly cannot: unknown }>(doors, async () => {
    try {
      const found = await doors.builder.publicDepositLanded!({ vault, transaction: paid.transaction, indexer: await theWalletsIndexer(doors, vault) });
      return found === null ? null : { found };
    } catch (e) {
      lastFailure = e;
      return aLookThatMayClear(e) ? null : { cannot: e };
    }
  });
  if (seen === null) throw new PublicDepositNotYetSeen(vault, livesUntil, lastFailure);
  if (!('found' in seen)) throw new PublicDepositNotYetSeen(vault, livesUntil, seen.cannot);
  doors.progress?.('done');
  return { txRef: sent.txRef, transactionHash: seen.found.transactionHash, token: money.token, value: money.value };
}

/* ------------------------------------------------------------ a payment out */

/**
 * **A PRIVATE PAYMENT THIS DEVICE HAS HANDED OVER TO BE SENT AND HAS NOT YET
 * RECORDED.** Kept on this device, sealed under the signer's own key, from
 * just before the send until the vault's record shows it. It keeps the one
 * thing nothing else can give back: the coin the payment returns to the vault,
 * read when the payment was built. Without it, a payment that landed while
 * this page was not watching leaves change nobody can name.
 */
export interface PaymentInFlight {
  /** The note the payment spends first. */
  readonly spent: { readonly nonce: Hex; readonly token: Hex; readonly value: string };
  /** Every further note it spends, in place order; absent or empty when it spends one. */
  readonly further?: ReadonlyArray<{ readonly nonce: Hex; readonly token: Hex; readonly value: string }>;
  readonly amount: string;
  /** What the payment gives back to the vault, or `null` when it spends the note exactly; a merge's one coin. */
  readonly change: NoteOnTheWire | null;
  /** A merge of the vault's own notes, which sends nothing out; absent on a payment. */
  readonly merge?: true;
  /** When this was written, in milliseconds: after the payment was built and before it was sent. */
  readonly recordedAt: number;
  readonly txRef: string;
  readonly transactionHash: string | null;
}

/** One payment in flight per vault on this device, changed or forgotten only under the claim it was kept with. */
export type PaymentsInFlight = KeptOnThisDevice<PaymentInFlight>;

export interface PayoutDoors extends PoolDoors {
  readonly builder: VaultBuilderClient;
  readonly indexer: ChainHereDoors['indexer'];
  readonly now?: () => Date;
  /** Where this device keeps a payment it has sent until the vault's record shows it. */
  readonly inFlight: PaymentsInFlight;
  /** This device's own seat as its believed directory holds it: a rebuild on the way to a payment files only what its role may file. */
  readonly seatHere: RebuildDoors['seatHere'];
}

/**
 * **AN EARLIER PAYMENT OUT OF THIS VAULT FROM THIS BROWSER IS NOT IN THE
 * VAULT'S RECORD YET, AND CAN STILL BE.** No note is chosen for another: the
 * vault's record does not yet say which notes are left.
 */
export class PaymentStillInFlight extends Error {
  constructor(readonly vault: Hex, readonly txRef: string, readonly until: number, why?: string) {
    const at = new Date(until).toLocaleString();
    super(`an earlier payment out of this vault from this browser${txRef === '' ? '' : ` (${txRef})`} is not in the `
      + `vault's record yet${why === undefined ? '' : ` (${why})`}, so no other payment is made from here until it is. `
      + `Nothing new was prepared or sent. Try again in a minute: once the chain shows it, it is recorded first. If `
      + `the chain has not shown it by ${at}, it never will, and after then payments go ahead as soon as this vault's `
      + 'history can be read.');
    this.name = 'PaymentStillInFlight';
  }
}

/**
 * **ANOTHER TAB OF THIS BROWSER STARTED A PAYMENT OUT OF THIS VAULT A MOMENT
 * AGO.** This one stops before it is sent.
 */
export class PaymentStartedElsewhere extends Error {
  constructor(readonly vault: Hex) {
    super('another payment out of this vault started in another tab or window of this browser a moment ago, so this one '
      + 'was not sent. No money moved. When the other one has finished, open the run again, and pay this person only if '
      + 'it still shows them unpaid.');
    this.name = 'PaymentStartedElsewhere';
  }
}

/**
 * **THE PAYMENT MAY HAVE BEEN SENT, AND THIS DEVICE HAS NOT SEEN IT LAND.** The
 * money may have moved. Raised for every failure after the service began
 * sending, whatever it was, so no screen reads it as a payment that did not
 * happen.
 */
export class PaymentNotYetSeen extends Error {
  constructor(readonly vault: Hex, readonly txRef: string, why?: string) {
    super(`the payment may have been sent${txRef === '' ? '' : ` (${txRef})`} and this device has not seen it land`
      + `${why === undefined ? '' : ` (${why})`}, so it may still land. Do not pay this person again: open the run `
      + 'later, and it shows them paid once the chain does. This browser keeps a locked record of the payment, and the '
      + 'next payment out of this vault from here, or "Check my last deposit" on the vault, adds it to the vault\'s '
      + 'record once the chain shows it. Until then, no other payment leaves this vault from this browser.');
    this.name = 'PaymentNotYetSeen';
  }
}

/**
 * **THE PAYMENT LANDED, AND THE VAULT'S RECORD WAS NOT WRITTEN.** The person is
 * paid. The sealed note of the payment is kept, and the next look from this
 * browser writes the record.
 */
export class PaymentLandedUnrecorded extends Error {
  constructor(readonly vault: Hex, readonly transactionHash: string, why: string) {
    super(`the payment landed${transactionHash === '' ? '' : ` (${transactionHash})`} and the vault's record could not `
      + `be written (${why}). The person is paid: do not pay them again. This browser keeps a locked record of the `
      + 'payment, and the next payment out of this vault from here, or "Check my last deposit" on the vault, writes '
      + 'the record.');
    this.name = 'PaymentLandedUnrecorded';
  }
}

/**
 * **A TRANSACTION UNDER THIS PAYMENT'S NAME IS ON THE CHAIN, AND IT IS NOT THE
 * PAYMENT THIS DEVICE BUILT.** Nothing is recorded from it, and waiting will not
 * change what it says.
 */
export class PaymentNotAsBuilt extends Error {
  constructor(readonly vault: Hex, readonly transactionHash: string, why: string) {
    super(`the chain holds a transaction under this payment's name${transactionHash === '' ? '' : ` (${transactionHash})`} that is not the payment this `
      + `device built: ${why}. The vault's record is not changed for it now. Do not pay this person again until the `
      + 'run shows whether they were paid. If the vault\'s record still holds the note it spent once the chain no '
      + 'longer does, the record has to be rebuilt from the company\'s records before this device spends that note.');
    this.name = 'PaymentNotAsBuilt';
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;

/** A note as the page's vault worker is handed one: its value written as whole digits. */
export const wireOf = (n: Note): NoteOnTheWire => ({
  nonce: n.nonce, token: n.token, value: n.value.toString(),
  ...(n.createdIn === undefined ? {} : { createdIn: n.createdIn }),
});
type NoteAsHex = { readonly nonce: Hex; readonly token: Hex; readonly value: string; readonly createdIn?: Hex };
const noteOf = (wire: NoteOnTheWire): Note => {
  const n = wire as unknown as NoteAsHex;
  return {
    nonce: n.nonce, token: n.token, value: BigInt(n.value),
    ...(n.createdIn === undefined ? {} : { createdIn: n.createdIn }),
  };
};

/** What a payment kept on this device left, once it is settled. */
export type PaymentSettled =
  | { readonly state: 'none' | 'already-recorded' | 'never-landed' | 'spent-elsewhere' | 'not-matched' | 'overtaken' }
  | { readonly state: 'recorded'; readonly createdIn: Hex | null };

/**
 * **THE VAULT'S RECORD ADVANCED FOR ONE PAYMENT: EVERY NOTE IT SPENT GONE, AND
 * ITS CHANGE ADDED UNDER THE TRANSACTION THAT MADE IT.** Against the record as
 * it stands at each attempt, so a note another writer added meanwhile is kept.
 * A record that no longer holds the first note has already been written for
 * this payment; one that holds some of its notes and not others is refused by
 * the pool's own rule rather than half-applied.
 */
async function recordPayment(
  doors: PayoutDoors, vault: Hex, spent: Hex, further: readonly Hex[], amount: string, change: NoteOnTheWire | null,
  createdIn: Hex | null,
): Promise<void> {
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  const ATTEMPTS = 5;
  for (let attempt = 1; ; attempt += 1) {
    const now = await pool.load(vault);
    /* Written already only when the record holds none of the notes it spent; some and not others is refused below. */
    const spentHere = [spent, ...further].map(lowerOf);
    if (!now.notes.some((n) => spentHere.includes(n.nonce.toLowerCase()))) return;
    const next = await doors.builder.afterPayment({
      notes: now.notes.map(wireOf), spent, ...(further.length === 0 ? {} : { further }), amount, change, createdIn,
    });
    try {
      await pool.save(vault, { notes: next.map(noteOf) }, now.readAt);
      return;
    } catch (cause) {
      if (!isALostPoolRace(cause) || attempt === ATTEMPTS) throw cause;
    }
  }
}

const lowerOf = (h: string): string => h.toLowerCase();
const coinOnTheWire = (c: { readonly nonce: Hex; readonly token: Hex; readonly value: bigint }): NoteOnTheWire =>
  ({ nonce: c.nonce, token: c.token, value: c.value.toString() });

/**
 * **A STEP WRITTEN IN THE VAULT'S PAYMENT JOURNAL THAT SPENT A NOTE THIS
 * PAYMENT SPENDS, AND LANDED.** A note is spent once, so when another step -
 * a merge above all, which needs no approval and may be made by any holder of
 * the vault's secret - spent it and its coin is on the chain, this payment can
 * never land. That is known as soon as the step's coin is seen, not when this
 * payment's time to live runs out.
 *
 * Only a step its own line can name is believed: its coin is worked out from
 * the line with the vault's secret, and it counts only when the chain holds
 * that coin, holds none of the notes the line names, and does not hold this
 * payment's own change. A line identical to this payment's is this payment.
 * For a payment that kept no change, and so left no coin of its own to look
 * for, a line counts only when the first note it names is one this payment
 * spends: a coin names the note it was made from, so that coin on the chain
 * says this payment's note went into another step, and this payment cannot
 * have landed.
 */
async function overtakenBy(
  doors: PayoutDoors, vault: Hex, p: PaymentInFlight, onChain: ReadonlySet<string>, until: number,
): Promise<{
  readonly spent: Hex; readonly further: readonly Hex[]; readonly amount: string; readonly kept: NoteOnTheWire; readonly createdIn: Hex;
} | null> {
  const mine = [p.spent, ...(p.further ?? [])].map((n) => lowerOf(n.nonce));
  const asCoin = (n: { readonly nonce: Hex; readonly token: Hex; readonly value: string }) =>
    ({ nonce: n.nonce, token: n.token, value: BigInt(n.value) });
  const thisPayment = attemptKey({
    spent: asCoin(p.spent), ...(p.further === undefined || p.further.length === 0 ? {} : { further: p.further.map(asCoin) }),
    amount: BigInt(p.amount), ...(p.merge === true ? { merge: true } : {}),
  });
  const heldOf = async (coin: NoteOnTheWire): Promise<string> => lowerOf((await doors.builder.commitments({ vault, coin })).held);
  /*
   * **THIS PAYMENT'S OWN CHANGE ON THE CHAIN SAYS IT LANDED**, whatever any other line says: a coin's commitment
   * names the first note it was made from and what it holds, not every note beside it, so another step's coin is
   * believed only while this payment's own change is absent.
   */
  if (p.change !== null && onChain.has(await heldOf(p.change))) return null;
  const journal = new PaymentJournalInStore(doors.records('payment-journal'), vault,
    { id: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  const { attempts } = await journal.open();
  let secret: string | null = null;
  for (const a of attempts) {
    const notes = [a.spent, ...(a.further ?? [])];
    if (!notes.some((n) => mine.includes(lowerOf(n.nonce)))) continue;
    /* With no change of its own on the chain to weigh it against, only a coin made from this payment's own note says so. */
    if (p.change === null && !mine.includes(lowerOf(a.spent.nonce))) continue;
    const step = {
      spent: a.spent, ...(a.further === undefined || a.further.length === 0 ? {} : { further: a.further }),
      amount: a.amount, ...(a.step === 'merge' ? { merge: true } : {}),
    };
    /* A line identical to this payment's is this payment: the same notes and amount make the same change. */
    if (attemptKey(step) === thisPayment) continue;
    /* A step that landed spent every note it names: one the chain still holds says this line is not the one that landed. */
    let allGone = true;
    for (const n of notes) if (onChain.has(await heldOf(coinOnTheWire(n)))) allGone = false;
    if (!allGone) continue;
    secret ??= (await readTheSecretBack(doors, vault)).secret;
    let kept: NoteOnTheWire | null;
    try {
      kept = await doors.builder.stepKept({
        vault, secret,
        step: {
          spent: coinOnTheWire(a.spent), ...(a.further === undefined ? {} : { further: a.further.map(coinOnTheWire) }),
          amount: a.amount.toString(), ...(a.step === 'merge' ? { merge: true } : {}),
        },
      });
    } catch {
      /* A line no step could have made proves nothing about this payment. */
      continue;
    }
    if (kept === null) continue;
    const { held, output } = await doors.builder.commitments({ vault, coin: kept });
    if (!onChain.has(lowerOf(held))) continue;
    const found = await creatingTransactionOfOutput(doors, vault, output, null, 'the coin of the step that spent this payment\'s note');
    if (found.state !== 'found') {
      throw new PaymentStillInFlight(vault, p.txRef, until,
        'a step that spent the note it would spend has landed, and the transfer that made that step\'s coin cannot be read yet');
    }
    return {
      spent: a.spent.nonce, further: (a.further ?? []).map((n) => n.nonce), amount: a.amount.toString(), kept, createdIn: found.createdIn,
    };
  }
  return null;
}

/**
 * **WHEN ANOTHER STEP SPENT A NOTE THIS ONE SPENDS AND LANDED, THAT STEP IS
 * RECORDED AS THE CHAIN HOLDS IT**: every note it spent gone, its coin added
 * under the transaction that made it. Asked of a step on its way wherever it
 * is settled - when this browser looks again, and when a step whose send named
 * no transaction is found by its note leaving the vault - so a step another
 * holder made is never recorded as this one. `true` when it was.
 */
async function recordedIfOvertaken(
  doors: PayoutDoors, vault: Hex, p: PaymentInFlight, onChain: ReadonlySet<string>, until: number,
): Promise<boolean> {
  const overtaken = await overtakenBy(doors, vault, p, onChain, until);
  if (overtaken === null) return false;
  await recordPayment(doors, vault, overtaken.spent as Hex, overtaken.further as Hex[], overtaken.amount, overtaken.kept, overtaken.createdIn);
  return true;
}

/**
 * **WHAT BECAME OF A PAYMENT THIS BROWSER SENT AND HAS NOT YET RECORDED.**
 *
 *   · the vault's record no longer holds the note it spent (this browser or
 *     another signer recorded it): nothing to record, and it is forgotten;
 *   · the chain still holds that note: nothing spent it yet. Once the
 *     payment's own time to live has passed it never will, and it is
 *     forgotten; until then `PaymentStillInFlight`;
 *   · the chain no longer holds that note and the payment left no change: the
 *     note is taken out of the record, and nothing is added;
 *   · the chain no longer holds that note and the transaction that made the
 *     payment's change can be read: the note goes and the change is added
 *     under that transaction, found by the change's own commitment when the
 *     send named none. It is the vault's coin whichever payment made it: two
 *     payments of one amount out of one note make the same change;
 *   · the chain no longer holds that note because another step the vault's
 *     payment journal names spent it - a merge made while this payment was on
 *     its way - and that step's coin is on the chain: this payment can never
 *     land. The step is written into the record as the chain holds it, this
 *     payment is forgotten at once, and the person can be paid again from the
 *     record as it now stands;
 *   · the chain no longer holds that note and, once the time to live has
 *     passed, the vault's history, read in full, holds no such change: this
 *     payment never landed and something else spent the note. It is
 *     forgotten, and the record is left for whoever made that payment.
 *
 * Nothing is recorded that the chain does not show.
 */
export async function settlePaymentInFlight(doors: PayoutDoors, vault: Hex, view?: VaultChainView): Promise<PaymentSettled> {
  const p = await doors.inFlight.get(vault);
  if (p === null) return { state: 'none' };
  const forget = () => doors.inFlight.forget(vault, p.claim).catch(() => { /* the next look settles it again */ });
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  if (!(await pool.load(vault)).notes.some((n) => n.nonce.toLowerCase() === p.spent.nonce.toLowerCase())) {
    await forget();
    return { state: 'already-recorded' };
  }
  const seen = view ?? await notesAsThisDeviceReadsThem(doors, vault);
  const until = p.recordedAt + DEPOSIT_TIME_TO_LIVE_MS;
  const past = (doors.now ?? (() => new Date()))().getTime() > until;
  /* Only a view that read the vault's notes can say the note it spent has left. */
  if (seen.onChain !== true || !Array.isArray(seen.notes)) {
    throw new PaymentStillInFlight(vault, p.txRef, until, 'the vault\'s notes could not be read just now');
  }
  const { held } = await doors.builder.commitments({ vault, coin: p.spent });
  if (seen.notes.some((n) => n.toLowerCase() === held.toLowerCase())) {
    if (past) {
      await forget();
      return { state: 'never-landed' };
    }
    throw new PaymentStillInFlight(vault, p.txRef, until);
  }
  if (await recordedIfOvertaken(doors, vault, p, new Set(seen.notes.map(lowerOf)), until)) {
    await forget();
    return { state: 'overtaken' };
  }
  if (p.change === null) {
    /* A payment that kept no change landed only when every note it spent has left: they leave in one transaction. */
    for (const n of p.further ?? []) {
      const { held: heldFurther } = await doors.builder.commitments({ vault, coin: n });
      if (!seen.notes.some((x) => x.toLowerCase() === heldFurther.toLowerCase())) continue;
      if (past) {
        await forget();
        return { state: 'never-landed' };
      }
      throw new PaymentStillInFlight(vault, p.txRef, until, 'a note it spends is still held on the chain');
    }
    await recordPayment(doors, vault, p.spent.nonce, (p.further ?? []).map((n) => n.nonce), p.amount, null, null);
    await forget();
    return { state: 'recorded', createdIn: null };
  }
  const { output, held: heldChange } = await doors.builder.commitments({ vault, coin: p.change });
  const found = await creatingTransactionOfOutput(doors, vault, output, p.transactionHash, 'this payment\'s change');
  if (found.state === 'found') {
    await recordPayment(doors, vault, p.spent.nonce, (p.further ?? []).map((n) => n.nonce), p.amount, p.change, found.createdIn);
    await forget();
    return { state: 'recorded', createdIn: found.createdIn };
  }
  /*
   * The vault's history listing no transaction for the change is believed only
   * when this device's own read of the chain holds that change nowhere either.
   */
  const bareHex = (h: string) => h.toLowerCase().replace(/^0x/u, '');
  const changeOnChain = (seen.notes ?? []).some((n) => bareHex(n) === bareHex(heldChange))
    || (seen.everCreated ?? []).some((c) => bareHex(c) === bareHex(output));
  if (found.listed === 'none' && past && !changeOnChain) {
    await forget();
    return { state: 'spent-elsewhere' };
  }
  /*
   * **A CHANGE THE CHAIN SHOWS AND THE VAULT WORKER WILL NOT NAME, PAST ITS
   * TIME TO LIVE.** Waiting will not change it. It is let go, so payments go
   * on; the vault's record still holds the note it spent, which the chain no
   * longer does, and a payment that would spend that note says the record has
   * to be rebuilt from the company's records, which names the change again.
   */
  if (found.state === 'unknown' && past) {
    await forget();
    return { state: 'not-matched' };
  }
  throw new PaymentStillInFlight(vault, p.txRef, until, found.state === 'unknown' ? found.why
    : 'the chain no longer holds the note it spent, and the transfer that made its change cannot be read yet');
}

/**
 * **HOW A STEP OUT OF THE VAULT IS SPOKEN OF**: the refusals once it may have
 * been sent, and the stages a person watches. A payment pays a person; a merge
 * pays nobody and only reshapes the vault's own notes, so neither borrows the
 * other's words.
 */
interface StepWords {
  readonly what: string;
  readonly writing: VaultStage;
  readonly building: VaultStage;
  readonly sending: VaultStage;
  readonly waiting: VaultStage;
  readonly recording: VaultStage;
  notYetSeen(vault: Hex, txRef: string, why?: string): Error;
  landedUnrecorded(vault: Hex, transactionHash: string, why: string): Error;
  notAsBuilt(vault: Hex, transactionHash: string, why: string): Error;
}

const A_PAYMENT: StepWords = {
  what: 'this payment',
  writing: 'writing the payment down', building: 'building the payment', sending: 'sending the payment',
  waiting: 'waiting for the payment', recording: 'recording the payment',
  notYetSeen: (vault, txRef, why) => new PaymentNotYetSeen(vault, txRef, why),
  landedUnrecorded: (vault, hash, why) => new PaymentLandedUnrecorded(vault, hash, why),
  notAsBuilt: (vault, hash, why) => new PaymentNotAsBuilt(vault, hash, why),
};

const A_MERGE: StepWords = {
  what: 'this merge',
  writing: 'writing the merge down', building: 'building the merge', sending: 'sending the merge',
  waiting: 'waiting for the merge', recording: 'recording the merge',
  notYetSeen: (vault, txRef, why) => new MergeNotYetSeen(vault, txRef, why),
  landedUnrecorded: (vault, hash, why) => new MergeLandedUnrecorded(vault, hash, why),
  notAsBuilt: (vault, hash, why) => new MergeNotAsBuilt(vault, hash, why),
};

/**
 * **A MERGE OF THE VAULT'S NOTES MAY HAVE BEEN SENT, AND THIS DEVICE HAS NOT
 * SEEN IT LAND.** A merge moves nothing out of the vault: whatever happens, the
 * money stays the vault's. Until the chain shows it, no other step leaves the
 * vault from this browser.
 */
export class MergeNotYetSeen extends Error {
  constructor(readonly vault: Hex, readonly txRef: string, why?: string) {
    super(`the merge of this vault's notes may have been sent${txRef === '' ? '' : ` (${txRef})`} and this device has `
      + `not seen it land${why === undefined ? '' : ` (${why})`}. Nothing left the vault either way. This browser keeps `
      + 'a locked record of it, and the next payment out of this vault from here adds it to the vault\'s record once '
      + 'the chain shows it. Until then, no other payment leaves this vault from this browser.');
    this.name = 'MergeNotYetSeen';
  }
}

/** **THE MERGE LANDED, AND THE VAULT'S RECORD WAS NOT WRITTEN.** The next look from this browser writes it. */
export class MergeLandedUnrecorded extends Error {
  constructor(readonly vault: Hex, readonly transactionHash: string, why: string) {
    super(`the merge of this vault's notes landed${transactionHash === '' ? '' : ` (${transactionHash})`} and the `
      + `vault's record could not be written (${why}). Nothing left the vault. This browser keeps a locked record of `
      + 'it, and the next payment out of this vault from here writes the record.');
    this.name = 'MergeLandedUnrecorded';
  }
}

/** **A TRANSACTION UNDER THIS MERGE'S NAME IS ON THE CHAIN, AND IT IS NOT THE MERGE THIS DEVICE BUILT.** */
export class MergeNotAsBuilt extends Error {
  constructor(readonly vault: Hex, readonly transactionHash: string, why: string) {
    super(`the chain holds a transaction under this merge's name${transactionHash === '' ? '' : ` (${transactionHash})`} `
      + `that is not the merge this device built: ${why}. The vault's record is not changed for it now. If the `
      + 'vault\'s record still holds the notes it spent once the chain no longer does, the record has to be rebuilt '
      + 'from the company\'s records before this device spends them.');
    this.name = 'MergeNotAsBuilt';
  }
}

/**
 * **THE VAULT'S NOTES MOVED UNDER A STEP BEFORE IT WAS SENT.** A note it would
 * spend has left the chain, or the record no longer holds it as named: another
 * step landed first. Nothing was written down or sent, and the step is planned
 * again from the record as it now stands.
 */
export class NotesMovedUnderAStep extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotesMovedUnderAStep';
  }
}

/**
 * **A STEP SENT AND OVERTAKEN: ANOTHER STEP SPENT A NOTE IT SPENDS, AND LANDED
 * FIRST.** A note is spent once, so this step can never land and nothing left
 * the vault for it. The step that did land is recorded as the chain holds it,
 * this one is forgotten, and it is planned again from the record as it now
 * stands.
 */
export class StepOvertaken extends NotesMovedUnderAStep {
  constructor(readonly vault: Hex, what: string) {
    super(`${what} did not land: another step out of this vault spent a note it spends and landed first, and that step `
      + `is recorded as the chain holds it. Nothing left the vault for ${what}. Plan it again from the record as it is now.`);
    this.name = 'StepOvertaken';
  }
}

/** The commitment the vault holds for one of its notes, as its worker works it out. */
const heldOfANote = async (doors: Pick<PayoutDoors, 'builder'>, vault: Hex, n: NoteOnTheWire): Promise<string> =>
  (await doors.builder.commitments({ vault, coin: { nonce: n.nonce, token: n.token, value: n.value } })).held.toLowerCase();

/**
 * **WHAT A REBUILD OF A VAULT'S NOTES NEEDS**: the vault read on this device at
 * the wallet's indexer, this signer's keys and the company's records through
 * the one check every reader uses, the worker that rebuilds, and the coins this
 * device keeps. Every payment's and deposit's doors carry all of it.
 */
export interface RebuildDoors extends ChainHereDoors {
  readonly builder: Pick<VaultBuilderClient, 'vaultOnChain' | 'commitments' | 'creatingTransaction' | 'eventsOf' | 'createdBy'>
    & Partial<Pick<VaultBuilderClient, 'vaultRebuilt'>>;
  readonly me: DeviceSigner;
  readonly records: DeviceRecords;
  readonly signers: () => Promise<readonly PoolSigner[]>;
  readonly kept?: CoinsKeptHere;
  /**
   * This device's own seat as its believed directory holds it (`seatHereIn`), or null when the directory holds no seat
   * of this device's that it believes. The rebuild files a vault record only where that seat's role may file it
   * (`mayFile`); a seat this device cannot name files nothing, and what was found is returned in memory. Left out, the
   * rebuild is a read: it files nothing at all, whoever's seat it is, and says that what it found is owed a filing (the
   * page's read of a vault's private money, which signs nothing). A seat action in the wallet passes it to file.
   */
  readonly seatHere?: () => Promise<{ readonly role: Role | null; readonly retired: unknown } | null>;
}

/**
 * This device's own seat in the directory it believes, found by the key it files with, or null when it holds none
 * or holds one this device does not believe (`seatNotBelievedHere`: not attested by its own wallet, retired, or not on
 * the chain now) - the one rule every reader of a seat keeps.
 */
export const seatHereIn = async (
  directory: DirectoryRead, signingSecret: Hex,
): Promise<{ readonly role: Role | null; readonly retired: unknown } | null> => {
  const me = signingPublicKeyOf(signingSecret).toLowerCase();
  const here = await directory();
  const mine = here.dir.seats.find((x) => x.signingKey.toLowerCase() === me);
  return mine === undefined || seatNotBelievedHere(here, mine) !== null ? null : mine;
};

type VaultRecordKind = 'pool' | 'deposit-journal' | 'payment-journal';

/** The vault records this device's seat may file: none for a seat it cannot name, a retired one, or a role that files none. */
async function filableHere(doors: RebuildDoors, said: string[]): Promise<ReadonlySet<VaultRecordKind>> {
  if (doors.seatHere === undefined) return new Set();
  let seat: { readonly role: Role | null; readonly retired: unknown } | null = null;
  try {
    seat = await doors.seatHere();
  } catch (e) {
    said.push(`this device's own seat was not read from the company's directory: ${failedSaying(e)}`);
  }
  if (seat === null || seat.retired !== null) return new Set();
  const kinds = mayFile(seat);
  return new Set((['pool', 'deposit-journal', 'payment-journal'] as const).filter((k) => kinds.includes(k)));
}

/**
 * The vault's notes as this device rebuilt them. `as-filed`: the record already
 * held every note the vault holds, and is what the vault's steps are planned
 * from. `filed`: a new version was filed holding them. `not-filed`: the notes
 * found are in `notes` and nothing was filed (this seat may not file, or the
 * record could not be read or written); a step is never planned from them.
 * `not-read`: the vault could not be read. `said` is every record withheld or
 * not believed, every line not read and every note not named, in words.
 * `leaver` is the part of it a leaving seat's filings left: what the chain
 * contradicts in them, which a balance read shows as its answer.
 */
export type NotesHere = (
  | { readonly of: 'as-filed' | 'filed' | 'not-filed'; readonly notes: readonly Note[]; readonly unexplained: number; readonly said: readonly string[] }
  | { readonly of: 'not-read'; readonly said: readonly string[] }
) & { readonly leaver?: readonly string[] };

const REBUILD_ATTEMPTS = 5;
/*
 * A vault whose chain notes the slow path already left unnamed this page session, keyed by the vault and those
 * notes, so a note nobody's records name (a stranger's deposit) does not send every open down the slow path again.
 */
const UNNAMED_THIS_SESSION = new Set<string>();

const sameNote = (a: Note, b: Note): boolean =>
  a.nonce.toLowerCase() === b.nonce.toLowerCase() && a.token.toLowerCase() === b.token.toLowerCase() && a.value === b.value;
const noteText = (n: Note): string => `${n.nonce.toLowerCase()}:${n.token.toLowerCase()}:${n.value}:${n.createdIn ?? ''}`;
const coinWire = (c: { readonly nonce: string; readonly token: string; readonly value: bigint | string }) =>
  ({ nonce: String(c.nonce).toLowerCase(), token: c.token, value: String(c.value) });
const failedSaying = (e: unknown): string => (e as Error)?.message ?? String(e);

/**
 * **THE ONE REBUILD OF A VAULT'S NOTES ON A SIGNER'S DEVICE: EVERY NOTE THE
 * VAULT HOLDS, REACHED FROM THIS DEVICE AND FILED SO EVERY SIGNER'S DEVICE
 * REACHES IT.**
 *
 * Read the vault at the wallet's indexer (or take `view`, read just before by
 * the caller), file again what a leaving seat's versions the chain vouches for
 * (`fileThePoolTheChainHolds`), and compare the record with the chain. When
 * they agree and every signer can open the vault's records, that is the
 * answer. Otherwise, in this order:
 *
 * 1. The newest pool, both journals' newest versions, the nonce secret (or this
 *    signer's sealed copy of it on the chain) and the coins this device keeps
 *    are reconciled with the chain and its split journal in the vault worker.
 *    Every record is read through the one check; one withheld or not believed
 *    is said and the rest are still read, and nothing withheld is read as empty.
 * 2. Only when a chain note is still unnamed: every filed version of the three
 *    records (never one a device passes over) and the walk over the company's
 *    own amounts. A note the slow path cannot name is remembered for the page
 *    session.
 * 3. The notes are what the chain holds: every note of the record the chain
 *    still holds, every note the rebuild names (with its creating transaction),
 *    and a note the chain no longer holds only until a second read shows it made
 *    and spent - a note held but not in the history yet is the indexer behind.
 * 4. Filed as the next version only when that changes anything, the record
 *    was believed and this device's seat may file it (`seatHere`, `mayFile`);
 *    a lost race reads the chain and the records again. The newest pool and
 *    journals are filed again, unchanged, sealed to every signer the directory
 *    seats, when one of them cannot open them, by a seat that may file them. A
 *    seat that may not file files nothing, the leaving seat's versions
 *    included, and returns what it found in memory.
 *
 * It never throws: what it cannot do is returned and said, so a payment or a
 * deposit it runs inside goes on from the record as filed.
 */
export async function vaultNotesHere(doors: RebuildDoors, vault: Hex, view?: VaultChainView): Promise<NotesHere> {
  const said: string[] = [];
  const leaver: string[] = [];
  try {
    for (let attempt = 1; ; attempt += 1) {
      const done = await rebuiltOnce(doors, vault, attempt === 1 ? view : undefined, said, leaver);
      if (done !== 'lost-a-race') return { ...done, leaver };
      if (attempt === REBUILD_ATTEMPTS) {
        said.push(`another device filed this vault's record first on all ${REBUILD_ATTEMPTS} attempts, so nothing was filed from here`);
        return { of: 'not-read', said, leaver };
      }
    }
  } catch (e) {
    said.push(failedSaying(e));
    return { of: 'not-read', said, leaver };
  }
}

async function rebuiltOnce(
  doors: RebuildDoors, vault: Hex, given: VaultChainView | undefined, said: string[], leaver: string[],
): Promise<NotesHere | 'lost-a-race'> {
  let view = given;
  if (view === undefined) {
    const standing = await vaultStandingHere(doors, vault);
    if (!standing.onChain) return { of: 'not-read', said: [...said, standing.view.why ?? NO_VAULT_YET] };
    if (standing.unread !== null) return { of: 'not-read', said: [...said, standing.unread.says] };
    if (!standing.pinned) return { of: 'not-read', said: [...said, NOT_PINNED_WHY] };
    view = standing.view;
  }
  if (view.onChain !== true || !Array.isArray(view.notes)) {
    return { of: 'not-read', said: [...said, view.notesWhy ?? 'the chain was read and did not say which notes this vault holds'] };
  }
  const chainNotes = view.notes.map((n) => n.toLowerCase());
  const onChain = new Set(chainNotes);
  const heldOf = new Map<string, string>();
  const held = async (n: { readonly nonce: string; readonly token: string; readonly value: bigint | string }): Promise<string> => {
    const key = `${n.nonce.toLowerCase()}:${n.token.toLowerCase()}:${n.value}`;
    if (!heldOf.has(key)) heldOf.set(key, (await doors.builder.commitments({ vault, coin: coinWire(n) })).held.toLowerCase());
    return heldOf.get(key)!;
  };

  /* What this seat may file, asked once, before anything is filed: a seat that may not file files nothing. */
  const filable = await filableHere(doors, said);
  const notFiledBecause = doors.seatHere === undefined
    ? 'a read files nothing, so what was found is not filed from here; it is owed a filing by a seat action in a signer\'s wallet'
    : 'this device\'s seat may not file this vault\'s records (its role files none, or this device does not believe '
      + 'the seat), so what was found is not filed from this device';

  /* A leaving seat's versions the chain vouches for are filed again first, as every read of this vault does, by a seat that may file them. */
  if (filable.size < 3) said.push(`${notFiledBecause}; what a seat that left filed is not filed again from here`);
  else try {
    const filedAgain = await fileThePoolTheChainHolds({
      vault, me: doors.me, records: doors.records, signers: doors.signers, held: async (n) => onChain.has(await held(n)),
    });
    said.push(...filedAgain.said);
    leaver.push(...filedAgain.said);
  } catch (e) {
    said.push(`what a seat that left filed could not be checked against the chain: ${failedSaying(e)}`);
  }

  const pool = new SealedNotePool(doors.records('pool'), { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  let loaded: Awaited<ReturnType<SealedNotePool['load']>> | null = null;
  try {
    loaded = await pool.load(vault);
  } catch (e) {
    said.push(`this vault's record of its notes was not read: ${failedSaying(e)}`);
  }
  const poolNotes: readonly Note[] = loaded?.notes ?? [];
  const recorded = new Set<string>();
  for (const n of poolNotes) recorded.add(await held(n));
  const unnamed = chainNotes.filter((c) => !recorded.has(c));
  const notHeld = poolNotes.filter((n) => !onChain.has(heldOf.get(`${n.nonce.toLowerCase()}:${n.token.toLowerCase()}:${n.value}`)!));
  const readers = await readersMissing(doors, vault, said);

  if (loaded !== null && unnamed.length === 0 && notHeld.length === 0) {
    if (readers.length > 0) await sealedToEverySigner(doors, vault, pool, loaded, readers, filable, said);
    return { of: 'as-filed', notes: poolNotes, unexplained: 0, said };
  }
  if (doors.builder.vaultRebuilt === undefined) {
    said.push('this page cannot rebuild the vault\'s notes; reload it to use the current build');
    return { of: 'not-filed', notes: poolNotes, unexplained: unnamed.length, said };
  }

  if (view.nonceCommitment === undefined || view.splitJournal === undefined) {
    said.push('the read of the chain did not give the vault\'s secret commitment and split journal, so its notes are not rebuilt; '
      + 'a journal not read is not an empty one');
    return { of: 'not-read', said };
  }

  /* ---- 1: the newest of each record, the secrets, the coins kept here ---- */
  const opener = recordsKeypairFrom(doors.me.companyKey);
  let secrets: string[] = [];
  try {
    const filed = await doors.records('nonce-secret').get(vault);
    if (filed === null) said.push('the company\'s records hold no nonce secret for this vault');
    else secrets = [...openNonceSecrets(filed, vault, opener).secrets];
  } catch (e) {
    said.push(`the vault's nonce secret was not read from the company's records: ${failedSaying(e)}`);
  }
  const newestOf = async (record: 'deposit-journal' | 'payment-journal'): Promise<FiledPoolVersion[]> => {
    try {
      const rec = await doors.records(record).get(vault);
      return rec === null ? [] : [{ version: rec.version, sealed: rec }];
    } catch (e) {
      said.push(`this vault's ${record === 'deposit-journal' ? 'deposit' : 'payment'} journal was not read: ${failedSaying(e)}`);
      return [];
    }
  };
  const journals = async (deposits: readonly (FiledPoolVersion | PassedOverVersion)[], payments: readonly (FiledPoolVersion | PassedOverVersion)[]) => {
    const read = attemptsFromJournalVersions({
      deposits, payments, opener: { id: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret },
    });
    for (const u of read.unread) said.push(`version ${u.version} of this vault's ${u.record === 'deposit-journal' ? 'deposit' : 'payment'} journal: ${u.why}`);
    if (read.deposits.length > 0 && doors.kept !== undefined) {
      try {
        /* Kept on this device only where the chain made the coin, as a coin handed over is. */
        const made = new Set((view!.everCreated ?? []).map((c) => c.toLowerCase().replace(/^0x/u, '')));
        const chainMade: typeof read.deposits[number][] = [];
        for (const c of read.deposits) {
          if (made.has((await doors.builder.commitments({ vault, coin: coinWire(c) })).output.toLowerCase().replace(/^0x/u, ''))) chainMade.push(c);
        }
        await doors.kept.keep(vault, chainMade);
      } catch (e) {
        said.push(failedSaying(e));
      }
    }
    return read;
  };
  let kept: readonly CoinKept[] = [];
  try {
    kept = (await doors.kept?.coins(vault)) ?? [];
  } catch (e) {
    said.push(`the coins this device keeps for this vault were not read: ${failedSaying(e)}`);
  }
  const newest = await journals(await newestOf('deposit-journal'), await newestOf('payment-journal'));
  const stepWire = (a: { spent: Note | { nonce: string; token: string; value: bigint }; further?: readonly { nonce: string; token: string; value: bigint }[]; amount: bigint; merge?: boolean }) => ({
    spent: coinWire(a.spent), amount: a.amount.toString(),
    ...(a.further === undefined || a.further.length === 0 ? {} : { further: a.further.map(coinWire) }),
    ...(a.merge === true ? { merge: true } : {}),
  });
  const asked = {
    vault, ...(view.state === undefined ? {} : { state: view.state }),
    chain: {
      notes: chainNotes, everCreated: view.everCreated ?? [],
      ...(view.nonceCommitment === undefined ? {} : { nonceCommitment: view.nonceCommitment }),
      ...(view.splitJournal === undefined ? {} : { splitJournal: view.splitJournal }),
    },
    secrets,
    versions: loaded === null ? [] : [{ version: loaded.readAt.version, notes: poolNotes.map(coinWire) }],
    attempted: { deposits: newest.deposits.map(coinWire), payments: newest.payments.map(stepWire) },
    named: kept,
  };
  let rebuilt = await doors.builder.vaultRebuilt({ ...asked, ...(secrets.length === 0 ? { copyFor: opener.publicKey } : {}) });
  if (secrets.length === 0 && rebuilt.copy !== null) {
    /* No secret from the records: this signer's own sealed copy of it on the chain, opened only here. */
    try {
      secrets = [openSecretCopy({ vault, parts: rebuilt.copy.map((p) => fromHex(p)), reader: opener })];
      rebuilt = await doors.builder.vaultRebuilt({ ...asked, secrets });
    } catch (e) {
      said.push(`this signer's sealed copy of the vault's secret on the chain does not open: ${failedSaying(e)}`);
    }
  }

  /* ---- 2: every version and the walk, only for a note still unnamed ---- */
  const unnamedKey = `${vault}:${[...rebuilt.unexplained].sort().join(',')}`;
  if (rebuilt.unexplained.length > 0 && !UNNAMED_THIS_SESSION.has(unnamedKey)) {
    const every = async (record: 'pool' | 'deposit-journal' | 'payment-journal'): Promise<FiledPoolVersion[]> => {
      try {
        return (await doors.records(record).versions(vault)).filter((v): v is FiledPoolVersion => v.neverEntered !== true);
      } catch (e) {
        said.push(`every version of this vault's ${record} was not read: ${failedSaying(e)}`);
        return [];
      }
    };
    const versions: Array<{ version: number; notes: ReturnType<typeof coinWire>[] }> = [];
    for (const v of await every('pool')) {
      try {
        const page = openPool(v.sealed, doors.me.signerId, doors.me.wrappingSecret, { record: 'pool' }) as { notes?: unknown };
        if (Array.isArray(page.notes)) versions.push({ version: v.version, notes: (page.notes as Note[]).map(coinWire) });
      } catch (e) {
        said.push(`version ${v.version} of this vault's pool does not open for this signer: ${failedSaying(e)}`);
      }
    }
    if (loaded !== null && !versions.some((v) => v.version === loaded!.readAt.version)) versions.push(asked.versions[0]!);
    const all = await journals(await every('deposit-journal'), await every('payment-journal'));
    const amounts = new Map<string, { token: string; value: string }>();
    for (const c of [...all.deposits.map(coinWire), ...versions.flatMap((v) => v.notes), ...kept]) amounts.set(`${c.token}:${c.value}`, { token: c.token, value: c.value });
    rebuilt = await doors.builder.vaultRebuilt({
      ...asked, secrets, versions,
      attempted: { deposits: all.deposits.map(coinWire), payments: all.payments.map(stepWire) },
      walk: { deposited: [...amounts.values()], paid: all.payments.filter((p) => p.merge !== true).map((p) => ({ token: p.spent.token, amount: p.amount.toString() })) },
    });
    /* Remembered under the key it is checked by: the notes the fast pass left unnamed. */
    if (rebuilt.unexplained.length > 0) UNNAMED_THIS_SESSION.add(unnamedKey);
  }
  said.push(...rebuilt.said);
  if (rebuilt.unexplained.length > 0) {
    said.push(`the chain holds ${rebuilt.unexplained.length} note(s) for this vault that no record this device can read names. They are `
      + 'the vault\'s and stay on the chain; they are named once a record that names them can be read here');
  }

  /* ---- 3: the notes the chain holds ---- */
  const rebuiltHeld = new Map(rebuilt.held.map((h) => [h.nonce.toLowerCase(), h]));
  const next: Note[] = [];
  let again: Set<string> | 'keep-every-note' | null = null;
  for (const n of poolNotes) {
    const h = rebuiltHeld.get(n.nonce.toLowerCase());
    if (h !== undefined && sameNote(n, { nonce: h.nonce, token: h.token, value: BigInt(h.value) } as Note)) {
      next.push(n);
      continue;
    }
    if (onChain.has(await held(n))) { next.push(n); continue; }
    /* Made and spent only when the history shows it made and a second read, after that history, still shows it gone. */
    const { output } = await doors.builder.commitments({ vault, coin: coinWire(n) });
    const made = (view.everCreated ?? []).some((c) => c.toLowerCase().replace(/^0x/u, '') === output.toLowerCase().replace(/^0x/u, ''));
    if (made && again === null) {
      /* A second read that fails or holds no notes confirms nothing: every pool note is then kept. */
      try {
        const read = await readHere(doors, vault);
        again = read.onChain && Array.isArray(read.notes) ? new Set(read.notes.map((x) => x.toLowerCase())) : 'keep-every-note';
      } catch {
        again = 'keep-every-note';
      }
    }
    if (!made || again === 'keep-every-note' || again!.has(await held(n))) next.push(n);
  }
  for (const h of rebuilt.held) {
    if (next.some((n) => n.nonce.toLowerCase() === h.nonce.toLowerCase())) continue;
    const found = await creatingTransactionOfOutput(doors, vault, h.output, null, 'a note this vault holds');
    next.push({
      nonce: h.nonce, token: h.token, value: BigInt(h.value),
      ...(found.state === 'found' ? { createdIn: found.createdIn } : {}),
    } as Note);
  }

  /* ---- 4: filed only when it changes anything ---- */
  const before = new Set(poolNotes.map(noteText));
  const changed = next.length !== poolNotes.length || next.some((n) => !before.has(noteText(n)));
  if (!changed) {
    if (loaded !== null && readers.length > 0) await sealedToEverySigner(doors, vault, pool, loaded, readers, filable, said);
    return { of: loaded === null ? 'not-filed' : 'as-filed', notes: poolNotes, unexplained: rebuilt.unexplained.length, said };
  }
  if (loaded === null) {
    said.push('the notes found are not filed, because this vault\'s record of its notes could not be read to build on');
    return { of: 'not-filed', notes: next, unexplained: rebuilt.unexplained.length, said };
  }
  if (!filable.has('pool')) {
    said.push(notFiledBecause);
    return { of: 'not-filed', notes: next, unexplained: rebuilt.unexplained.length, said };
  }
  try {
    await pool.save(vault, { notes: next }, loaded.readAt);
  } catch (e) {
    if (isALostPoolRace(e)) return 'lost-a-race';
    said.push(`the notes found were not filed: ${failedSaying(e)}`);
    return { of: 'not-filed', notes: next, unexplained: rebuilt.unexplained.length, said };
  }
  if (readers.length > 0) await sealedToEverySigner(doors, vault, null, null, readers, filable, said);
  return { of: 'filed', notes: next, unexplained: rebuilt.unexplained.length, said };
}

/**
 * Which of the vault's records - the pool and the two journals, each as the
 * one check gives its newest version - a signer the directory seats cannot
 * open, because it was last filed before they were seated.
 */
async function readersMissing(doors: RebuildDoors, vault: Hex, said: string[]): Promise<Array<'pool' | 'deposit-journal' | 'payment-journal'>> {
  let ids: string[];
  try {
    ids = (await doors.signers()).map((x) => x.id);
  } catch (e) {
    said.push(`who the company's signers are was not read, so no record was sealed to more of them: ${failedSaying(e)}`);
    return [];
  }
  const out: Array<'pool' | 'deposit-journal' | 'payment-journal'> = [];
  for (const record of ['pool', 'deposit-journal', 'payment-journal'] as const) {
    try {
      const rec = await doors.records(record).get(vault);
      if (rec !== null && ids.some((id) => !rec.wrapped.some((w) => w.signerId === id))) out.push(record);
    } catch {
      /* A record not read is said where it is read for its notes. */
    }
  }
  return out;
}

/**
 * **THE NEWEST POOL AND JOURNALS, FILED AGAIN UNCHANGED, SEALED TO EVERY SIGNER
 * THE DIRECTORY SEATS**, so a signer seated after their last version opens
 * them. Only a seat that reads them and may file does it; a refusal is said.
 * `pool` and `loaded` are given only when the pool itself still needs it.
 */
async function sealedToEverySigner(
  doors: RebuildDoors, vault: Hex, pool: SealedNotePool | null, loaded: Awaited<ReturnType<SealedNotePool['load']>> | null,
  records: ReadonlyArray<VaultRecordKind>, filable: ReadonlySet<VaultRecordKind>, said: string[],
): Promise<void> {
  for (const record of records) {
    if (!filable.has(record)) {
      said.push(`this vault's ${record} is not filed again for a signer who cannot open it yet: `
        + (doors.seatHere === undefined ? 'a read files nothing, and a seat action in a signer\'s wallet owes it' : 'this device\'s seat may not file it'));
      continue;
    }
    try {
      if (record === 'pool') {
        if (pool !== null && loaded !== null) await pool.save(vault, { notes: loaded.notes }, loaded.readAt);
        continue;
      }
      const store = doors.records(record);
      const rec = await store.get(vault);
      if (rec === null) continue;
      const page = openPool(rec, doors.me.signerId, doors.me.wrappingSecret, {
        record, unlabelled: store.unlabelledRecordsFiled === true ? 'accept' : 'refuse',
      });
      const to = await doors.signers();
      assertNoSignerWouldLoseAccess(rec.wrapped.map((w) => w.signerId), to.map((x) => x.id), `this vault's ${record}`);
      passedOverAbove(store, vault, record, rec.version);
      await store.put(vault, sealPool(vault, page, to, rec.version + 1, record));
    } catch (e) {
      if (isALostPoolRace(e)) continue;
      said.push(`this vault's ${record} was not filed again for a signer who cannot open it yet: ${failedSaying(e)}`);
    }
  }
}

/**
 * **THE COINS THIS DEVICE KEEPS FOR A VAULT, AS A FILE FOR ANOTHER SIGNER**
 * (`coinsFileText`), sealed for the company's signers: the signer saves it and
 * hands it over themselves; nothing is sent to the company's service.
 */
export async function coinsToHandOverHere(doors: Pick<RebuildDoors, 'kept'>, vault: Hex, company: CoinsFileCompany): Promise<string> {
  return coinsFileText(vault, (await doors.kept?.coins(vault)) ?? [], company);
}

/**
 * **COINS ANOTHER SIGNER HANDED OVER AS A FILE**, opened with the company's
 * key (a file sealed for another company opens nothing), kept on this device only
 * where the chain, read at the wallet's indexer, made each one for this vault:
 * a coin the chain never made - a forged or mistyped one - is refused and kept
 * nowhere. Kept coins are then read by every rebuild of the vault's notes.
 */
export async function coinsHandedOverHere(
  doors: RebuildDoors, vault: Hex, text: string, company: CoinsFileCompany,
): Promise<{ readonly kept: number; readonly refused: number }> {
  const coins = coinsFileRead(text, vault, company);
  if (doors.kept === undefined) throw new Error('this device keeps no coins, so the file was not taken. Nothing was kept.');
  const read = await readHere(doors, vault);
  if (!read.onChain) throw new Error(`the chain, as this device read it, does not show this vault, so no coin was kept. ${NO_VAULT_YET}`);
  const made = new Set(read.everCreated.map((c) => c.toLowerCase().replace(/^0x/u, '')));
  const taken: CoinKept[] = [];
  for (const c of coins) {
    const { output } = await doors.builder.commitments({ vault, coin: c });
    if (made.has(output.toLowerCase().replace(/^0x/u, ''))) taken.push(c);
  }
  await doors.kept.keep(vault, taken);
  return { kept: taken.length, refused: coins.length - taken.length };
}

/**
 * **THE VAULT OPENED FOR A STEP OUT OF IT, ON THIS DEVICE**: pinned to the
 * company's account as the chain shows it, money allowed out, any earlier step
 * from this browser settled first, then every note the vault holds brought into
 * its record (`vaultNotesHere`), and its pool as the company's records then hold
 * it. Who holds the vault is not asked: no payment waits on the super admins.
 */
async function openedForAStepOut(
  doors: PayoutDoors, vault: Hex,
): Promise<{ readonly view: VaultChainView; readonly pool: Awaited<ReturnType<SealedNotePool['load']>> }> {
  doors.progress?.('opening the pool');
  const answer = await fundableOrThrow(doors, vault);
  if (answer.of === 'not-on-chain') {
    throw new Error('the chain, as this device read it, does not show this vault, so its record is not opened here and '
      + `nothing is paid out of it. Nothing was sent. Reason: ${answer.why}`);
  }
  /*
   * **WHETHER MONEY MAY GO OUT NOW, ASKED BEFORE ANYTHING ELSE.** The vault
   * pinned to the company's account and started, said here before the pool is
   * opened, a line is written or two minutes are spent proving a payment that
   * could not be sent.
   */
  if (answer.of !== 'fundable') {
    throw new Error('No payment can be made out of this vault yet, so none was prepared or recorded. Nothing was '
      + `sent. Reason: ${answer.why}`);
  }
  const view = answer.view;
  /*
   * **AN EARLIER STEP FROM THIS BROWSER IS SETTLED FIRST.** Recorded if it has
   * landed, forgotten if it never can; while it still can, no note is chosen,
   * because the record does not yet say which notes are left.
   */
  await settlePaymentInFlight(doors, vault, view);
  /*
   * **THEN EVERY NOTE THE VAULT HOLDS IS BROUGHT INTO ITS RECORD**, a note
   * another signer's device deposited or a step that took a note left behind,
   * filed as the next version when it changes anything. It is advisory here:
   * whatever it cannot do it says and returns, and the step is planned only from
   * the record as filed.
   */
  await vaultNotesHere(doors, vault, view);
  const pool = await new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers).load(vault);
  return { view, pool };
}

/**
 * **THE NOTES A STEP NAMES, EXACTLY AS THIS VAULT'S RECORD HOLDS THEM**, in the
 * order named, or a refusal: a note the record does not hold, or holds as
 * another coin, is never spent on a caller's word, and nothing is chosen in
 * its place.
 */
function exactlyTheNotesNamed(
  pool: { readonly notes: readonly Note[] }, named: readonly NoteOnTheWire[], what: string,
): NoteOnTheWire[] {
  if (new Set(named.map((n) => lowerOf(n.nonce))).size !== named.length) {
    throw new Error(`${what} names one note twice, and a note is spent once. Nothing was sent.`);
  }
  return named.map((n) => {
    const held = pool.notes.find((x) => lowerOf(x.nonce) === lowerOf(n.nonce));
    if (held === undefined || lowerOf(held.token) !== lowerOf(n.token) || held.value.toString() !== n.value) {
      throw new NotesMovedUnderAStep(`${what} names a note this vault's record does not hold as named, so nothing was built: the record `
        + 'has moved since the step was planned. Plan it again from the record as it is now. Nothing was sent.');
    }
    return wireOf(held);
  });
}

/**
 * **WHAT A STEP OUT OF THE VAULT IS BUILT ON, READ ON THIS DEVICE**: every note
 * it spends recorded with the transaction that created it and still held on
 * the chain as this device read it; the events that file each one; one block's
 * view of the vault and the account; and the vault's secret, opened from the
 * company's records and checked against the vault. Every fact is read here, at
 * the indexer the person's own wallet names. Nothing is written down yet.
 */
async function readyToSpend(
  doors: PayoutDoors, vault: Hex, view: VaultChainView, notes: readonly NoteOnTheWire[], what: string,
): Promise<{
  readonly withEvents: ReadonlyArray<{ readonly note: NoteOnTheWire; readonly events: EventOnTheWire[] }>;
  readonly chain: PayoutChainOnTheWire & { readonly account: Hex };
  readonly secret: string;
}> {
  if (notes.some((n) => n.createdIn === undefined)) {
    throw new Error(`a note of this vault's that ${what} would spend does not record which transaction created it, so `
      + 'its place in the chain cannot be read and it cannot be spent yet. It is still the vault\'s. Nothing was sent.');
  }
  /*
   * **A NOTE THE CHAIN NO LONGER HOLDS IS NOT SPENT AGAIN.** It means a step
   * that spent it landed and this record does not show it yet - another device
   * still writing it down, a tab closed while it waited, or the vault's notes
   * merged under this step. The vault's own check would refuse the build
   * anyway; stopping here, before anything is written down, says which case it
   * is, and nothing is left waiting on a note that has gone.
   */
  const onChainNow = new Set((view.notes ?? []).map((n) => n.toLowerCase()));
  for (const n of notes) {
    if (!onChainNow.has(await heldOfANote(doors, vault, n))) {
      throw new NotesMovedUnderAStep(`the chain no longer holds a note this vault's record would spend for ${what}: a step `
        + 'that spent it has landed that this record does not show yet. Nothing was sent. If another signer is paying '
        + `from this vault right now, try again in a minute. Otherwise ${what}, and any other that would `
        + 'spend that note, waits until the vault\'s record is rebuilt from the company\'s records.');
    }
  }

  doors.progress?.('reading the chain');
  const withEvents: Array<{ note: NoteOnTheWire; events: EventOnTheWire[] }> = [];
  for (const n of notes) withEvents.push({ note: n, events: await eventsHere(doors, vault, n.createdIn!) });
  const chain = await chainAtOneBlockHere(doors, vault);

  /*
   * **THE VAULT'S SECRET, OPENED HERE BEFORE ANYTHING IS WRITTEN DOWN.** The
   * vault names every coin a step makes with it, and refuses one that is not
   * the secret it holds; a record this device cannot open stops the step
   * before a line is written.
   */
  await theChainWins(doors, vault, view.state!);
  const { secret } = await readTheSecretBack(doors, vault);
  if (!(await doors.builder.secretIsTheVaults({ vault, state: view.state!, secret }))) {
    throw new Error('the secret the company\'s records hold for this vault is not the one the vault holds on the chain, so '
      + 'nothing was built from it. Nothing was sent; contact support.');
  }
  return { withEvents, chain, secret };
}

/**
 * **WRITTEN DOWN BEFORE ANYTHING IS PROVED, AND THIS MAY NOT MOVE BELOW THE
 * SEND.** The notes, what leaves and whether it is a merge fix the whole of the
 * coin the step keeps; a journal that refuses stops the step with nothing
 * spent. The line is the one format every step is journalled in.
 */
async function writtenDown(
  doors: PayoutDoors, vault: Hex, notes: readonly NoteOnTheWire[], step: 'payment' | 'merge', amount: string,
): Promise<void> {
  const journal = new PaymentJournalInStore(doors.records('payment-journal'), vault,
    { id: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  const [first, ...further] = notes as unknown as NoteAsHex[];
  if (first === undefined) throw new Error('a step that spends no note is not written down. Nothing was sent.');
  await journal.record(vault, {
    spent: { nonce: first.nonce, token: first.token, value: BigInt(first.value) },
    ...(further.length === 0 ? {} : {
      further: further.map((n) => ({ nonce: n.nonce, token: n.token, value: BigInt(n.value) })),
    }),
    step,
    amount: BigInt(amount),
    attemptedAt: new Date().toISOString(),
  });
}

/**
 * **ONE BUILT STEP OUT OF THE VAULT, KEPT, SENT, WATCHED AND RECORDED.** Kept on
 * this device before it is sent; sent through `send`; from then on every
 * failure says the step may have landed. It is confirmed only by its own
 * transaction's events, read on this device - or, when the send named none, by
 * the coin it kept, or by its first note leaving the vault - and the vault's
 * record is advanced on those and nothing else.
 */
async function sendAStepOut(doors: PayoutDoors, vault: Hex, s: {
  readonly notes: readonly NoteOnTheWire[];
  readonly amount: string;
  /** The one coin the step keeps, as the build read it, or `null` when it keeps none. */
  readonly kept: NoteOnTheWire | null;
  readonly merge: boolean;
  readonly tx: string;
  readonly send: (vault: Hex, tx: string) => Promise<{ txRef: string; transactionHash: string | null }>;
  readonly words: StepWords;
}): Promise<{ readonly txRef: string; readonly hash: string | null; readonly createdIn: Hex | null }> {
  const [note, ...further] = s.notes as unknown as NoteAsHex[];
  if (note === undefined) throw new Error('a step that spends no note is not sent. Nothing was sent.');
  /*
   * **KEPT ON THIS DEVICE BEFORE IT IS SENT, AND THIS MAY NOT MOVE BELOW THE
   * SEND.** The coin kept is known only from the build, and from the send on the
   * step may land whatever happens to this page; this is what lets the record
   * be written once it does.
   */
  const first: PaymentInFlight = {
    spent: { nonce: note.nonce, token: note.token, value: note.value },
    ...(further.length === 0 ? {} : { further: further.map((n) => ({ nonce: n.nonce, token: n.token, value: n.value })) }),
    ...(s.merge ? { merge: true as const } : {}),
    amount: s.amount, change: s.kept, recordedAt: (doors.now ?? (() => new Date()))().getTime(), txRef: '', transactionHash: null,
  };
  const claim = await doors.inFlight.claim(vault, first);
  if (claim === null) throw new PaymentStartedElsewhere(vault);

  doors.progress?.(s.words.sending);
  let sent: { txRef: string; transactionHash: string | null };
  let sendFailed: string | undefined;
  try {
    sent = await s.send(vault, s.tx);
  } catch (e) {
    if (sentNothing(e)) {
      await doors.inFlight.forget(vault, claim).catch(() => { /* the next step settles it, and finds it never landed */ });
      throw e;
    }
    sendFailed = (e as Error)?.message ?? String(e);
    sent = { txRef: '', transactionHash: null };
  }

  /* ---- from here the money may have moved, and every failure says so ---- */
  try {
    await doors.inFlight.update(vault, claim, { ...first, txRef: sent.txRef, transactionHash: sent.transactionHash })
      .catch(() => { /* the record kept before still names the coin kept, and the chain is asked by its commitment */ });
    const named = sent.transactionHash === null ? null : sent.transactionHash.toLowerCase();
    const hash = named !== null && HEX64.test(named) ? named : null;
    doors.progress?.(s.words.waiting);
    /*
     * **WITHOUT A NAME FROM THE SEND, THE STEP IS FOUND BY WHAT IT LEFT.** The
     * coin it kept by that coin's own commitment, in this vault's history; a
     * step that kept none, by its note leaving the vault - once no other step
     * the journal names is the one that spent it. Either way its own events,
     * once found, are judged exactly as a named transaction's are.
     */
    const heldSpent = hash === null && s.kept === null ? await heldOfANote(doors, vault, s.notes[0]!) : null;
    /* Every note it spends leaves in the one transaction, so a step whose other notes are still held has not landed. */
    const heldFurther = heldSpent === null ? [] : await Promise.all(s.notes.slice(1).map((n) => heldOfANote(doors, vault, n)));
    const keptOutput = hash === null && s.kept !== null
      ? (await doors.builder.commitments({ vault, coin: s.kept })).output : null;
    let unchecked: string | undefined;
    const confirmed = await until(doors, async () => {
      if (hash === null && heldSpent !== null) {
        /* Only a view that read the vault's notes can say the note has left: an unreadable one says nothing. */
        const now = await notesAsThisDeviceReadsThem(doors, vault).catch(() => null);
        if (now === null || now.onChain !== true || !Array.isArray(now.notes)) return null;
        if (now.notes.some((n) => n.toLowerCase() === heldSpent)) return null;
        if (heldFurther.some((h) => now.notes!.some((n) => n.toLowerCase() === h))) return null;
        /* The note left: by this step, or by another the journal names that landed first - asked as settling asks it. */
        try {
          const onChain = new Set<string>(now.notes.map((n: string) => lowerOf(n)));
          const inFlight = { ...first, txRef: sent.txRef, transactionHash: sent.transactionHash };
          if (await recordedIfOvertaken(doors, vault, inFlight, onChain, first.recordedAt + DEPOSIT_TIME_TO_LIVE_MS)) {
            return { state: 'overtaken' as const };
          }
        } catch (e) {
          /* The step that spent it landed and its coin's transfer cannot be read yet: ask again. */
          if (e instanceof PaymentStillInFlight) return null;
          throw e;
        }
        return { state: 'landed' as const, createdIn: null };
      }
      let own: { transactionHash: string; events: EventOnTheWire[] } | null;
      try {
        own = hash !== null
          ? { transactionHash: hash, events: await eventsHere(doors, vault, hash) }
          : await doors.builder.createdBy({ vault, commitment: keptOutput!, indexer: await theWalletsIndexer(doors, vault) });
      } catch {
        /* The indexer does not hold it yet, or could not be asked: ask again. */
        return null;
      }
      if (own === null) return null;
      let answer: Awaited<ReturnType<typeof doors.builder.confirmPayment>>;
      try {
        answer = await doors.builder.confirmPayment({
          vault, transactionHash: String(own.transactionHash).toLowerCase(), change: s.kept, events: own.events,
          ...(s.merge ? { merge: true as const } : {}),
        });
      } catch (e) {
        /* The check could not be made this time; the next look asks again, of a new worker if this one stopped. */
        unchecked = whyAfterTheSend(e);
        return null;
      }
      return answer.state === 'not-yet' ? null : answer;
    });
    if (confirmed === null) {
      throw s.words.notYetSeen(vault, sent.txRef,
        sendFailed ?? (hash === null ? 'the service could not name the transaction it sent' : unchecked));
    }
    if (confirmed.state === 'overtaken') {
      await doors.inFlight.forget(vault, claim).catch(() => { /* the next look finds its note gone from the record and forgets it */ });
      throw new StepOvertaken(vault, s.words.what);
    }
    if (confirmed.state === 'not-as-built') throw s.words.notAsBuilt(vault, hash ?? '', confirmed.why);
    const createdIn = confirmed.createdIn === null ? null : confirmed.createdIn as Hex;

    doors.progress?.(s.words.recording);
    try {
      await recordPayment(doors, vault, note.nonce, further.map((n) => n.nonce), s.amount, s.kept, createdIn);
    } catch (cause) {
      throw s.words.landedUnrecorded(vault, createdIn ?? '', (cause as Error)?.message ?? String(cause));
    }
    await doors.inFlight.forget(vault, claim).catch(() => { /* the next step finds it recorded and forgets it */ });
    doors.progress?.('done');
    return { txRef: sent.txRef, hash, createdIn };
  } catch (e) {
    if (e instanceof PaymentNotYetSeen || e instanceof PaymentNotAsBuilt || e instanceof PaymentLandedUnrecorded
      || e instanceof MergeNotYetSeen || e instanceof MergeNotAsBuilt || e instanceof MergeLandedUnrecorded
      || e instanceof StepOvertaken) throw e;
    throw s.words.notYetSeen(vault, sent.txRef, whyAfterTheSend(e));
  }
}

/**
 * What a failure after a step was sent is called in the notice that the step
 * may have been sent. A failed ask of the vault worker is named by its reason
 * alone: its own sentence tells the person to try again, which a notice that
 * must stop a second payment may never say.
 */
const whyAfterTheSend = (e: unknown): string => (e instanceof VaultAskFailed
  ? `this page's check of it did not finish (${e.reason}${e.reason === 'answered' && e.workerName !== undefined ? `, ${e.workerName}` : ''})`
  : (e as Error)?.message ?? String(e));

/**
 * **ONE PERSON PAID PRIVATELY OUT OF THE COMPANY'S VAULT, AGAINST A ROUND THE
 * COMPANY APPROVED.** `order` and `payment` are the proposal's, as this device
 * made them from the company's records (`privatePaymentsHere`); everything that
 * opens a note stays on this device.
 *
 * **THE NOTES ARE THE PLAN'S WHEN IT NAMES THEM.** `notes`, when given, are the
 * notes the run's plan names for this payment, in place order: exactly those
 * are spent, as the vault's record holds them, and nothing is chosen again.
 * Without them the payment's notes are chosen by the one function every
 * payment chooses by.
 *
 * **THE POOL IS ADVANCED ONLY ON THIS PAYMENT'S OWN EVENTS.** Two payments out of
 * one note for one amount make the same change coin, so what the vault holds
 * cannot say which of them landed; the transaction the service sent can. The
 * change is recorded under that transaction, and under nothing else.
 */
export async function payPrivatelyFromCompanyVault(
  doors: PayoutDoors,
  input: {
    readonly order: PrivatePaymentOrderOnTheWire; readonly payment: PrivatePaymentOnTheWire;
    readonly notes?: readonly NoteOnTheWire[];
  },
): Promise<{
  txRef: string; transactionHash: string; spent: Hex; change: NoteOnTheWire | null;
  /**
   * `its-own-transaction` when the transaction the service named was read and
   * judged to pay a person; `by-what-it-left` when the send named none and the
   * payment was found by its change, or by its note leaving the vault. The
   * vault's record is right either way, but another payment of the same amount
   * out of the same note leaves exactly the same, so only the run, read from
   * the company's account, says whether this person was paid.
   */
  seenAs: 'its-own-transaction' | 'by-what-it-left';
}> {
  const { order, payment } = input;
  const vault = order.vault.toLowerCase() as Hex;
  if (payment.kind !== 'shielded') {
    throw new Error('this payment is not a private one, so it is not paid privately. Nothing was sent.');
  }
  if (payment.paid === true) {
    throw new Error('the company\'s account already records this person paid for this run. Nothing was sent.');
  }
  const seconds = BigInt(Math.floor((doors.now ?? (() => new Date()))().getTime() / 1000));
  if (seconds < BigInt(order.opensAt) || seconds >= BigInt(order.closesAt)) {
    throw new Error('this run can be paid only inside the window its signers approved, and it is not open now. '
      + 'Nothing was sent.');
  }
  const { view, pool } = await openedForAStepOut(doors, vault);

  doors.progress?.('choosing the notes');
  /* In place order: the first is the note the vault is offered, the rest go in the payment's further place. */
  const chosen = input.notes !== undefined
    ? exactlyTheNotesNamed(pool, input.notes, A_PAYMENT.what)
    : await doors.builder.notesForPayment({ notes: pool.notes.map(wireOf), token: payment.token, amount: payment.amount });
  const [note, ...further] = chosen;
  if (note === undefined) throw new Error('no note was chosen for this payment, so nothing was built. Nothing was sent.');
  const { withEvents, chain, secret } = await readyToSpend(doors, vault, view, chosen, A_PAYMENT.what);

  doors.progress?.(A_PAYMENT.writing);
  await writtenDown(doors, vault, chosen, 'payment', payment.amount);

  doors.progress?.(A_PAYMENT.building);
  const { payments: _all, ...round } = order;
  const built = await doors.builder.payout({
    vault, account: chain.account, order: round, payment, note, events: withEvents[0]!.events, secret,
    ...(further.length === 0 ? {} : { further: withEvents.slice(1) }),
    chain: {
      blockHash: chain.blockHash, vaultState: chain.vaultState, zswapState: chain.zswapState,
      parameters: chain.parameters, accountState: chain.accountState,
    },
  });
  if (built.spent !== note.nonce) {
    throw new Error('the payment built spends a different note from the one chosen, so it was not sent. Nothing was sent.');
  }
  const sent = await sendAStepOut(doors, vault, {
    notes: chosen, amount: payment.amount, kept: built.change, merge: false, tx: built.tx,
    send: (v, tx) => doors.service.payout(v, tx), words: A_PAYMENT,
  });
  /* A transaction found by what the payment left may be another payment's, so it is not named as this one's. */
  return {
    txRef: sent.txRef, transactionHash: sent.hash === null ? '' : sent.createdIn ?? '', spent: note.nonce as Hex,
    change: built.change, seenAs: sent.hash === null ? 'by-what-it-left' : 'its-own-transaction',
  };
}

/**
 * **THE VAULT'S OWN NOTES MERGED INTO ONE, SENT FROM THIS DEVICE.** `notes` are
 * the two to four notes the run's plan names for the merge, in place order:
 * exactly those are spent, as the vault's record holds them, and the one coin
 * the vault keeps is worth all of them. A merge sends nothing out of the vault
 * and needs no approval; it is written down before it is built, built on what
 * this device read at the indexer the wallet names, relayed by the service as
 * a payment is, and the vault's record is advanced by the coin it kept only
 * once its own transaction shows it.
 */
export async function mergeNotesInCompanyVault(
  doors: PayoutDoors,
  input: { readonly vault: Hex; readonly notes: readonly NoteOnTheWire[] },
): Promise<{
  txRef: string; transactionHash: string; spent: readonly Hex[]; kept: NoteOnTheWire;
  /** As a payment's: `by-what-it-left` when the send named no transaction and the merge was found by the coin it kept. */
  seenAs: 'its-own-transaction' | 'by-what-it-left';
}> {
  const vault = input.vault.toLowerCase() as Hex;
  if (input.notes.length < 2 || input.notes.length > STEP_LIMITS.mergeNotes) {
    throw new Error(`a merge takes two to ${STEP_LIMITS.mergeNotes} notes, so nothing was built. Nothing was sent.`);
  }
  const { view, pool } = await openedForAStepOut(doors, vault);
  const notes = exactlyTheNotesNamed(pool, input.notes, A_MERGE.what);
  if (notes.some((n) => lowerOf(n.token) !== lowerOf(notes[0]!.token))) {
    throw new Error('a merge combines notes of one token, and these are of more than one. Nothing was sent.');
  }
  const { withEvents, chain, secret } = await readyToSpend(doors, vault, view, notes, A_MERGE.what);

  doors.progress?.(A_MERGE.writing);
  await writtenDown(doors, vault, notes, 'merge', '0');

  doors.progress?.(A_MERGE.building);
  const built = await doors.builder.mergeNotes({
    vault, notes: withEvents, secret,
    chain: {
      blockHash: chain.blockHash, vaultState: chain.vaultState, zswapState: chain.zswapState,
      parameters: chain.parameters, accountState: chain.accountState,
    },
  });
  if (built.spent.length !== notes.length || built.spent.some((n, i) => lowerOf(n) !== lowerOf(notes[i]!.nonce))) {
    throw new Error('the merge built spends other notes than the ones named, so it was not sent. Nothing was sent.');
  }
  const sent = await sendAStepOut(doors, vault, {
    notes, amount: '0', kept: built.kept, merge: true, tx: built.tx,
    send: (v, tx) => doors.service.merge(v, tx), words: A_MERGE,
  });
  return {
    txRef: sent.txRef, transactionHash: sent.hash === null ? '' : sent.createdIn ?? '',
    spent: notes.map((n) => n.nonce as Hex), kept: built.kept, seenAs: sent.hash === null ? 'by-what-it-left' : 'its-own-transaction',
  };
}

/**
 * **A PUBLIC PAYMENT MAY HAVE BEEN SENT, AND THIS DEVICE HAS NOT SEEN IT
 * RECORDED.** The money may have moved. Raised for every failure after the
 * service began sending, so no screen reads it as a payment that did not
 * happen. A public payment spends no note and changes no record on this
 * device, so there is nothing here to rebuild.
 */
export class PublicPaymentNotYetSeen extends Error {
  constructor(readonly vault: Hex, readonly txRef: string, why?: string) {
    super(`the payment may have been sent${txRef === '' ? '' : ` (${txRef})`} and this device has not seen it land`
      + `${why === undefined ? '' : ` (${why})`}, so it may still land. Do not pay this person again: open the run `
      + 'later, and it shows them paid once the chain does.');
    this.name = 'PublicPaymentNotYetSeen';
  }
}

export interface PublicPayoutDoors extends Pacing {
  readonly service: VaultService;
  readonly builder: VaultBuilderClient;
  readonly account: AccountAddress;
  readonly onChain: VaultOnChainDoors['onChain'];
  readonly indexer: ChainHereDoors['indexer'];
  readonly now?: () => Date;
  /**
   * Whether the company's account records this payment as made, asked again
   * after it is sent: `true` once it does, `false` while it does not, `null`
   * when this deployment cannot say.
   */
  readonly paidYet: () => Promise<boolean | null>;
}

/**
 * **ONE PERSON PAID PUBLICLY OUT OF THE COMPANY'S VAULT, AGAINST A ROUND THE
 * COMPANY APPROVED.** `order` and `payment` are what the service rebuilt from
 * that round, and the payment is a public one: it is refused here unless the
 * leg names it public, and the builder refuses its address unless it decodes
 * as a public one.
 *
 * **NOTHING ON THIS DEVICE CHANGES.** No note is chosen or spent and nothing is
 * written to the vault's record. The payment is done when the company's account
 * records it, which is the same record that refuses paying this person twice.
 */
export async function payPubliclyFromCompanyVault(
  doors: PublicPayoutDoors,
  input: { readonly order: PrivatePaymentOrderOnTheWire; readonly payment: PrivatePaymentOnTheWire },
): Promise<{ txRef: string }> {
  const { order, payment } = input;
  const vault = order.vault.toLowerCase() as Hex;
  if (payment.kind !== 'unshielded') {
    throw new Error('this payment is not a public one, so it is not paid publicly. Nothing was sent.');
  }
  if (payment.paid === true) {
    throw new Error('the company\'s account already records this person paid for this run. Nothing was sent.');
  }
  const seconds = BigInt(Math.floor((doors.now ?? (() => new Date()))().getTime() / 1000));
  if (seconds < BigInt(order.opensAt) || seconds >= BigInt(order.closesAt)) {
    throw new Error('this run can be paid only inside the window its signers approved, and it is not open now. '
      + 'Nothing was sent.');
  }
  doors.progress?.('reading the chain');
  const answer = await fundableOrThrow(doors, vault);
  if (answer.of === 'not-on-chain') {
    throw new Error('the chain, as this device read it, does not show this vault, so nothing is paid out of it. Nothing was '
      + `sent. Reason: ${answer.why}`);
  }
  if (answer.of !== 'fundable') {
    throw new Error('No payment can be made out of this vault yet, so none was prepared or recorded. Nothing was '
      + `sent. Reason: ${answer.why}`);
  }
  const chain = await chainAtOneBlockHere(doors, vault);

  doors.progress?.('building the payment');
  const { payments: _all, ...round } = order;
  const built = await doors.builder.payoutPublicly({
    vault, account: chain.account, order: round, payment,
    chain: {
      blockHash: chain.blockHash, vaultState: chain.vaultState, zswapState: chain.zswapState,
      parameters: chain.parameters, accountState: chain.accountState,
    },
  });

  doors.progress?.('sending the payment');
  let sent: { txRef: string; transactionHash: string | null };
  try {
    sent = await doors.service.payoutPublicly(vault, built.tx);
  } catch (e) {
    if (sentNothing(e)) throw e;
    throw new PublicPaymentNotYetSeen(vault, '', (e as Error)?.message ?? String(e));
  }

  /* ---- from here the money may have moved, and every failure says so ---- */
  try {
    doors.progress?.('waiting for the payment');
    const recorded = await until(doors, async () => ((await doors.paidYet().catch(() => null)) === true ? true : null));
    if (recorded === null) throw new PublicPaymentNotYetSeen(vault, sent.txRef);
    doors.progress?.('done');
    return { txRef: sent.txRef };
  } catch (e) {
    if (e instanceof PublicPaymentNotYetSeen) throw e;
    throw new PublicPaymentNotYetSeen(vault, sent.txRef, (e as Error)?.message ?? String(e));
  }
}

/* --------------------------------------------- what this browser last sent */

/** What checking a vault's deposits from this browser found, each part said on the screen. */
export interface WhatThisBrowserDeposited {
  readonly deposit:
    | Awaited<ReturnType<typeof settleDepositInFlight>>
    | { readonly state: 'still-on-its-way'; readonly until: number }
    | { readonly state: 'landed-not-recorded' }
    /* For a check that files nothing and keeps no deposit of its own: the newest deposit filed for the vault has not reached it. */
    | { readonly state: 'journalled-not-seen' };
  /** Notes in the vault's record that did not name the transaction that made them, and now do. */
  readonly named: number;
  /** Notes in the vault's record that still do not, because the chain cannot say yet. */
  readonly unnamed: number;
  /** For a check that files nothing: notes the chain can name and that are left for a signer's wallet to name. */
  readonly toName?: number;
  /** The deposit the check judged, as the check read it; absent when it found none to judge. */
  readonly checked?: DepositChecked;
}

/**
 * **WHICH DEPOSIT A CHECK JUDGED, AND WHAT IT WAS**, read by the check itself: one this browser kept on its way, or the
 * newest one the vault's deposit journal names, which any signer's wallet may have filed. Its private token and how much
 * of it, in the token's smallest units.
 */
interface DepositChecked {
  readonly from: 'this-browser' | 'the-vaults-journal';
  readonly token: string;
  readonly value: bigint;
}

/** A coin's value as the wire carries it, a whole number in decimal, or null when it is not one. */
const valueOnTheWire = (value: unknown): bigint | null =>
  (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,38})$/u.test(value) ? BigInt(value) : typeof value === 'bigint' && value >= 0n ? value : null);

/** The deposit a check judged, from its coin, or nothing when the coin carries no token or no whole value. */
const checkedOf = (from: DepositChecked['from'], coin: { readonly token?: unknown; readonly value?: unknown } | null): { checked?: DepositChecked } => {
  const value = coin === null ? null : valueOnTheWire(coin.value);
  return coin === null || typeof coin.token !== 'string' || value === null ? {} : { checked: { from, token: coin.token, value } };
};

/** What checking a vault from this browser found: its deposits, and the payment this browser kept on its way. */
export interface WhatThisBrowserSent extends WhatThisBrowserDeposited {
  readonly payment: PaymentSettled | { readonly state: 'still-on-its-way'; readonly until: number };
}

/** The vault as this device reads it for a check; a vault the chain does not show has nothing to check. */
async function theVaultForACheck(doors: DepositDoors, vault: Hex): Promise<VaultChainView> {
  const view = await notesAsThisDeviceReadsThem(doors, vault);
  if (!view.onChain) throw new Error(view.why ?? 'the chain does not show this vault, so there is nothing to check yet.');
  return view;
}

/**
 * A deposit this browser kept on its way, settled as the next deposit would
 * settle it: recorded once the vault holds it, under the transaction that made
 * it, found by its own output when the send named none. One still on its way,
 * or in the vault and not yet readable, is said as such rather than refused.
 * Says too which deposit it judged and what it was (`checked`).
 */
async function depositSettledForACheck(
  doors: DepositDoors, vault: Hex, view: VaultChainView, files = true,
): Promise<Pick<WhatThisBrowserDeposited, 'deposit' | 'checked'>> {
  /* The coin this browser kept, read before settling it lets it go, so the check can say what it judged. */
  const kept = await doors.inFlight.get(vault);
  const ofThisBrowser = checkedOf('this-browser', kept === null ? null : kept.coin);
  try {
    const settled = await settleDepositInFlight(doors, vault, view, files);
    /* A deposit this browser kept from before deposits moved into the wallet is said owed once, and then let go: the journal still names it. */
    if (!files && settled.state === 'landed-owed-its-record') {
      const d = await doors.inFlight.get(vault);
      if (d !== null) await letGo(doors, vault, d.claim);
    }
    if (settled.state === 'none' && !files) return newestJournalledDepositForARead(doors, vault, view);
    return { deposit: settled, ...(settled.state === 'none' ? {} : ofThisBrowser) };
  } catch (e) {
    if (e instanceof DepositStillInFlight) return { deposit: { state: 'still-on-its-way', until: e.until }, ...ofThisBrowser };
    if (e instanceof DepositLandedNotYetRecorded) return { deposit: { state: 'landed-not-recorded' }, ...ofThisBrowser };
    throw e;
  }
}

/**
 * **THE NEWEST DEPOSIT FILED FOR THE VAULT, AS A READ JUDGES IT**, for a check that keeps no deposit of its own (the
 * wallet keeps the deposits it makes): the last coin the vault's deposit journal names, which is filed before its
 * deposit is sent, against the chain and the vault's record. In the record with its coin made: recorded. Held by the
 * vault and not in the record: owed its record. Made and no longer held: it landed and has since left the vault. Not
 * made: it has not reached the vault, and may still. A journal this signer cannot open, or none, is nothing to say.
 */
async function newestJournalledDepositForARead(
  doors: DepositDoors, vault: Hex, view: VaultChainView,
): Promise<Pick<WhatThisBrowserDeposited, 'deposit' | 'checked'>> {
  const none = { deposit: { state: 'none' as const } };
  const rec = await doors.records('deposit-journal').get(vault);
  if (rec === null) return none;
  let coins: Array<{ nonce?: unknown; token?: unknown; value?: unknown }>;
  try {
    coins = (openPool(rec, doors.me.signerId, doors.me.wrappingSecret, { record: 'deposit-journal' }) as { notes?: typeof coins }).notes ?? [];
  } catch {
    return none;
  }
  const last = coins[coins.length - 1];
  if (last === undefined || typeof last.nonce !== 'string' || typeof last.token !== 'string') return none;
  const coin = { nonce: last.nonce, token: last.token, value: String(last.value) };
  const judged = (deposit: WhatThisBrowserDeposited['deposit']) => ({ deposit, ...checkedOf('the-vaults-journal', coin) });
  const { output, held } = await doors.builder.commitments({ vault, coin });
  const bare = (h: string) => h.toLowerCase().replace(/^0x/u, '');
  const made = (view.everCreated ?? []).some((c) => bare(c) === bare(output));
  const holds = (view.notes ?? []).some((n) => n.toLowerCase() === held.toLowerCase());
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  const listed = (await pool.load(vault)).notes.some((n) => n.nonce.toLowerCase() === coin.nonce.toLowerCase());
  if (made && listed) return judged({ state: 'already-recorded' });
  if (holds) return judged({ state: 'landed-owed-its-record' });
  if (made) return judged({ state: 'landed-and-since-spent' });
  return judged({ state: 'journalled-not-seen' });
}

/**
 * Every note in the vault's record that does not name the transaction that
 * made it, looked for in the vault's history by its own output, and named once
 * the vault worker has judged that transaction's events to show exactly this
 * note, made for this vault. A note that cannot be named stays as it is, the
 * vault's, and unspendable until it can be. With `files` false nothing is
 * named: the notes the chain can name are counted in `toName`.
 */
async function notesNamedForACheck(
  doors: DepositDoors, vault: Hex, files = true,
): Promise<{ named: number; unnamed: number; toName?: number }> {
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  let named = 0;
  let unnamed = 0;
  let toName = 0;
  for (const n of (await pool.load(vault)).notes.filter((x) => x.createdIn === undefined)) {
    const { output } = await doors.builder.commitments({ vault, coin: { nonce: n.nonce, token: n.token, value: n.value.toString() } });
    const found = await creatingTransactionOfOutput(doors, vault, output, null);
    if (found.state !== 'found') {
      unnamed += 1;
      continue;
    }
    if (!files) {
      toName += 1;
      continue;
    }
    const same = (x: Note) => x.nonce.toLowerCase() === n.nonce.toLowerCase() && x.token.toLowerCase() === n.token.toLowerCase()
      && x.value === n.value;
    const ATTEMPTS = 5;
    for (let attempt = 1; ; attempt += 1) {
      const now = await pool.load(vault);
      const current = now.notes.find(same);
      if (current === undefined || current.createdIn !== undefined) break;
      try {
        await pool.save(vault, { notes: now.notes.map((x) => (same(x) ? { ...x, createdIn: found.createdIn } : x)) }, now.readAt);
        named += 1;
        break;
      } catch (cause) {
        if (!isALostPoolRace(cause) || attempt === ATTEMPTS) throw cause;
      }
    }
  }
  return files ? { named, unnamed } : { named, unnamed, toName };
}

/**
 * **EVERYTHING THIS BROWSER SENT TO ONE VAULT AND DID NOT SEE FINISH, LOOKED
 * FOR ON THE CHAIN AND RECORDED, WITHOUT SENDING ANYTHING NEW.** In order: a
 * deposit kept on its way is settled (`depositSettledForACheck`); a payment
 * kept on its way is settled, as the next payment would; every note in the
 * vault's record that does not name the transaction that made it is named
 * where the chain can say (`notesNamedForACheck`).
 *
 * Nothing is built, proved or sent, and nothing leaves this device but the
 * commitments the chain already published.
 */
export async function checkWhatThisBrowserSent(
  doors: DepositDoors & { readonly payments: PaymentsInFlight }, vault: Hex,
): Promise<WhatThisBrowserSent> {
  const view = await theVaultForACheck(doors, vault);
  const deposit = await depositSettledForACheck(doors, vault, view);
  let payment: WhatThisBrowserSent['payment'];
  try {
    payment = await settlePaymentInFlight({
      /* Settling rebuilds nothing, so it names no seat to file a rebuild under. */
      ...doors, inFlight: doors.payments, seatHere: async () => null,
      ...(doors.clock === undefined ? {} : { now: () => new Date(doors.clock!()) }),
    }, vault, view);
  } catch (e) {
    if (e instanceof PaymentStillInFlight) payment = { state: 'still-on-its-way', until: e.until };
    else throw e;
  }
  return { ...deposit, payment, ...await notesNamedForACheck(doors, vault) };
}

/**
 * **WHAT THIS BROWSER DEPOSITED INTO ONE VAULT AND DID NOT SEE FINISH, LOOKED
 * FOR ON THE CHAIN AND RECORDED, WITHOUT SENDING ANYTHING NEW: DEPOSITS ONLY.**
 * The same deposit settled and the same notes named as
 * `checkWhatThisBrowserSent`, for a page that makes deposits and no payments:
 * it takes only a deposit's doors, and no payment this browser kept is read or
 * settled. Nothing is built, proved or sent. With `files: false` (the page's
 * check, which signs nothing) nothing is recorded or named either: what is owed
 * is said. A deposit kept in this store that is owed its record is said once
 * and let go; with none kept, the newest deposit the vault's journal names is
 * judged instead (`newestJournalledDepositForARead`). Which of the two was
 * judged, and its token and value as the check read them, is `checked`.
 */
export async function checkWhatThisBrowserDeposited(
  doors: DepositDoors, vault: Hex, how: { readonly files?: false } = {},
): Promise<WhatThisBrowserDeposited> {
  const files = how.files !== false;
  const view = await theVaultForACheck(doors, vault);
  const deposit = await depositSettledForACheck(doors, vault, view, files);
  return { ...deposit, ...await notesNamedForACheck(doors, vault, files) };
}

/**
 * What a check found, in the words the vault screen shows. Only what is true of
 * this check is said; a check of deposits alone carries no payment, and says
 * nothing of one.
 */
export function sayWhatTheCheckFound(found: WhatThisBrowserDeposited & { readonly payment?: WhatThisBrowserSent['payment'] }): string {
  const said: string[] = [];
  const d = found.deposit;
  if (d.state === 'none') said.push('This browser has no deposit into this vault waiting to be seen.');
  if (d.state === 'already-recorded') {
    said.push(found.checked?.from === 'the-vaults-journal' ? 'The newest deposit filed for this vault is in the vault\'s record.'
      : 'Your last deposit from this browser is in the vault\'s record.');
  }
  if (d.state === 'never-landed') {
    said.push('Your last deposit from this browser never reached the vault, and now it never will. No money moved.');
  }
  if (d.state === 'recorded') {
    said.push(d.notYetSpendable === undefined
      ? 'Your last deposit from this browser has reached the vault and is now in its record.'
      : `Your last deposit from this browser has reached the vault and is now in its record. It cannot be used for a `
        + `payment yet: ${d.notYetSpendable}.`);
  }
  if (d.state === 'still-on-its-way') {
    said.push(`Your last deposit from this browser has not reached the vault yet. If it has not arrived by `
      + `${new Date(d.until).toLocaleString()}, it never will and no money moved. Do not put the same money in again.`);
  }
  if (d.state === 'journalled-not-seen') {
    said.push('The newest deposit filed for this vault has not reached the vault yet. It may still arrive. Do not put the same '
      + 'money in again.');
  }
  if (d.state === 'landed-and-since-spent') {
    said.push('The deposit reached the vault, and the vault has since paid it out or combined it.');
  }
  if (d.state === 'landed-owed-its-record') {
    said.push('The deposit is in the vault, and not yet in its record. The vault\'s deposit journal names it, so it is not '
      + 'lost; a check here files nothing. Do not put the same money in again.');
  }
  if (d.state === 'landed-not-recorded') {
    said.push('Your last deposit from this browser is in the vault, and this page cannot yet read the transfer that '
      + 'brought it in. Check again in a minute.');
  }
  const p = found.payment;
  if (p?.state === 'recorded') {
    said.push('Money from a payment this browser sent has left the vault, and the vault\'s record now shows it. Open the '
      + 'run to see who was paid.');
  }
  if (p?.state === 'never-landed') {
    said.push('A payment this browser sent never left the vault, and now it never will. No money moved. The run shows '
      + 'whether the person is still owed.');
  }
  if (p?.state === 'spent-elsewhere') {
    said.push('A payment this browser sent never left the vault, because another payment used the same money. The '
      + 'person it was for was not paid by it. The run shows whether they are still owed.');
  }
  if (p?.state === 'overtaken') {
    said.push('A payment this browser sent never left the vault, because the vault\'s money was combined into one amount '
      + 'before it landed. Nobody was paid by it. The vault\'s record now shows the money as it is, and the person can '
      + 'be paid again from it.');
  }
  if (p?.state === 'not-matched') {
    said.push('A payment this browser sent cannot be matched to what the chain shows. The run shows whether the person '
      + 'was paid. The vault\'s record has to be rebuilt from the company\'s records before the money it used is paid '
      + 'out again.');
  }
  if (p?.state === 'still-on-its-way') {
    said.push(`A payment this browser sent is not in the vault's record yet. If the chain has not shown it by `
      + `${new Date(p.until).toLocaleString()}, it never will. Until then, no other payment leaves this vault from this `
      + 'browser. Check again in a minute.');
  }
  if (found.named > 0) {
    said.push(found.named === 1
      ? 'One amount in the vault can now be used for payments.'
      : `${found.named} amounts in the vault can now be used for payments.`);
  }
  if ((found.toName ?? 0) > 0) {
    said.push(found.toName === 1
      ? 'One amount in the vault can be used for payments once a signer\'s wallet next files this vault\'s records.'
      : `${found.toName} amounts in the vault can be used for payments once a signer's wallet next files this vault's records.`);
  }
  if (found.unnamed > 0) {
    said.push(found.unnamed === 1
      ? 'One amount in the vault still cannot be used for a payment, because the chain cannot yet say which transfer '
        + 'brought it in. Check again later.'
      : `${found.unnamed} amounts in the vault still cannot be used for a payment, because the chain cannot yet say which `
        + 'transfers brought them in. Check again later.');
  }
  return said.join(' ');
}

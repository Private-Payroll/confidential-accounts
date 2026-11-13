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
 *      proposals hold a record of each; the record of the run carries every
 *      reader's copy of the secret sealed to that reader alone, never the
 *      secret. A raise written down that has not reached the chain is sent
 *      again under its record while it may still land; once the chain's time is
 *      past its deadline, this device's own adoption record is withdrawn and
 *      raised afresh, and a dead secret run record, whoever wrote it, is passed
 *      over and the run raised over a new window. A seat whose role may not
 *      raise a proposal sets up no vault. Once the chain shows the vault adopted,
 *      or started under its first secret, the record of that proposal is
 *      written down as carried out (`carriedOutWrittenDown`, `secretWrittenDown`).
 *
 *   Another signer approves either round, and carries it out once the chain
 *   counts its bar, with the same checks and without filing anything
 *   (`approveStartRoundHere`, `carryStartRoundHere`).
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
 * that created it; the payment is built and proved here against one block's
 * view of the vault and the account, and written into the vault's payment
 * journal once built and BEFORE it is sent; the service adds the network fee
 * and sends it; and the pool is advanced - the note gone, its change added with
 * the transaction that made it - only once the chain shows both.
 */
import { refuseLeavingAVaultShort, type SeatRights } from '../../../src/core/vault-approvers.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { Committee } from '../../../src/midnight/vault-committee.js';
import { whyNotInstallable } from 'midnight-identity/profile/request';
import type { DepositMoney } from '../../../src/midnight/deposit-nonce.js';
import {
  SealedNotePool, assertNoSignerWouldLoseAccess, isALostPoolRace, openPool, passedOverAbove, sealPool, type FiledPoolVersion, type PassedOverVersion, type PoolSigner,
} from '../../../src/midnight/vault-pool.js';
import { afterDeposit } from '../../../src/midnight/vault-note-deposit.js';
import type { Note } from '../../../src/midnight/vault-notes.js';
import type { VaultCallOnChain } from '../../../src/midnight/note-index.js';
import {
  PaymentJournalInStore, attemptKey, attemptsFromJournalVersions, noteKey, stepOfLine,
} from '../../../src/midnight/vault-journal.js';
import { coinsFileRead, coinsFileText, type CoinKept, type CoinsFileCompany, type CoinsKeptHere } from './vault-coins-kept-here.js';
import { STEP_LIMITS } from '../../../src/midnight/payment-plan.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import type { EventOnTheWire, NoteOnTheWire, TransactionRead } from './vault-builder.js';
import { PUBLIC_DEPOSIT_ENTRY } from './public-deposit-call.js';
import { openNonceSecrets, recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { ownCopyOpened } from '../../../src/midnight/sealed-secret-copy.js';
import { signingPublicKeyOf } from '../../../src/core/crypto.js';
import { mayFile } from '../../../src/midnight/seat-directory.js';
import { seatNotBelievedHere, type DirectoryRead } from './vault-page-doors.js';
import { fileVaultInfoHere, VaultInfoChanged, VaultInfoRefused } from './vault-info-filed-here.js';
import { vaultInfoTidied } from '../../../src/midnight/vault-info-record.js';
import { handedOver, type HandOver } from './hand-over.js';
import { versionsBelievedOf } from './http-sealed-pool-store.js';
import type { Role } from '../../../src/core/types.js';
import { NO_ASSET } from '../../../src/core/assets.js';
import type { OpenedRound } from './governed-call-builder.js';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import {
  fileThePoolTheChainHolds, depositCoinOnThisDevice, VaultSecretBeingChanged, type DeviceRecords, type DeviceSigner,
} from './deposit-on-device.js';
import type {
  CreatingTransactionAnswer, PayoutChainOnTheWire, SecretRunOnTheWire, StartStandingOnTheWire, VaultBuilderClient,
} from './vault-worker-client.js';
import { VaultAskFailed, type VaultRebuildAsked, type VaultRebuilt } from './vault-worker-client.js';
import { ReadRanOutOfTime } from './read-bound.js';
import type { Kept, KeptOnThisDevice } from './in-flight-on-this-device.js';
import { endedIfItThrows, letGo, neverHandedOver } from './deposit-line-ended.js';
import type { AccountHolders } from 'midnight-identity/profile/records-key';
import type { VaultService } from './vault-service.js';
import { NOT_BUILT, type NotBuiltCode, SAID, STALE_ADOPTION, START_READ_STOP, START_STOP, type SaidCode, type VaultCreated, VaultNotReadHere, VaultNotTheCompanys, VaultStartOwed, sentNothing } from './vault-start-stops.js';
import { type BuiltOnHereDoors, type ChainHereDoors, type CreateVaultDoors, type Pacing, type PoolDoors, type VaultChainView, type VaultOnChainDoors, type VaultStage, until } from './vault-doors.js';
import { CIRCUITS_UNSAID, NOT_PINNED_WHY, NO_VAULT_YET, type VaultStandingHere, chainAtOneBlockHere, circuitsOfARead, notesOfARead, readHere, theWalletsIndexer, vaultStandingHere } from './vault-read-here.js';
import { theChainWins } from './vault-pool-opened.js';
import { removalsOnTheChainHere } from './removals-on-the-chain.js';
import { whenTheSecretWasSetHere } from './who-holds-the-vaults-secret.js';
import { keptOnTheChainUnder, secretsToTry, theSecretToSpend } from './vault-secret-to-spend.js';
import { NOT_READ_IN_TIME, RAN_OUT, type SeatRefusal, ZERO_HEX, accountStep, adoptionRound, approvedHere, carriedOutWrittenDown, nothingMoves, proposedAndWrittenDown, seatRefusalIn, standingNow, untilReadHere, untilTheChainShows } from './vault-start-steps.js';
import { secretStartedHere } from './vault-secret-run.js';
export type { ServedVaultChain, VaultKeysView, VaultService } from './vault-service.js';
export { VaultNotTheCompanys, VaultNotReadHere, SAID, NOT_BUILT, START_STOP, START_READ_STOP, VaultStartOwed } from './vault-start-stops.js';
export type { VaultCreated, SaidCode, NotBuiltCode, StartStopCode, StartReadStopCode } from './vault-start-stops.js';
export { until } from './vault-doors.js';
export type { VaultAsTheWalletRead, BuiltOnHereDoors, VaultChainView, VaultStage, Pacing, CreateVaultDoors, VaultStartProposals, SecretReaderSources, PoolDoors, SecretKeptHere, RunKept } from './vault-doors.js';
export { theVaultAsItsSignersHoldIt, chainAtOneBlockHere } from './vault-read-here.js';
export { openCompanyVaultPool } from './vault-pool-opened.js';
export { StartRoundRefused, startRoundOpenedHere, approveStartRoundHere, carryStartRoundHere, finishedSecretRunHere } from './vault-start-round.js';
export { raiseASecretRunHere } from './vault-secret-run.js';
export type { StartRoundKind, StartRoundNamed } from './vault-start-round.js';

/** A time written into a sentence a person reads: the moment a deposit or a payment still on its way can no longer land, in this browser's own language and zone. */
const timeShown = (ms: number): string => new Date(ms).toLocaleString();

/** Every zswap event the chain holds for one transaction, read on this device at the indexer the wallet names. */
async function eventsHere(
  doors: Pick<BuiltOnHereDoors, 'builder' | 'indexer'>, vault: Hex, transactionHash: string,
): Promise<EventOnTheWire[]> {
  return doors.builder.eventsOf({ transactionHash, indexer: await theWalletsIndexer(doors, vault) });
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
const NOT_STARTED_WHY = 'this vault has not been started: its first secret is not set, or not every signer\'s sealed copy is written.';

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

/** What a new vault is called and what it is for, as the person creating it gives them. */
export interface VaultInfoGiven {
  readonly name: string;
  readonly description: string;
}

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
 * committee's signatures, so this one read is enough; a vault adopted again
 * (`doors.again`) is read as held by the committee the company holds now, since
 * a change of super admins since moved it. Both chain reads, the
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
      return await doors.builder.vaultAsDeployed!({ vault, account: doors.account, ...deployedWith, ...(doors.again === undefined ? {} : { again: true }) });
    } catch (e) {
      if (ranOutOfTime(e)) return RAN_OUT;
      throw e;
    }
  });
  if (asDeployed === RAN_OUT) throw new VaultStartOwed(vault, `it was sent, and ${NOT_READ_IN_TIME}`, START_READ_STOP.chainUnread);
  if (asDeployed === null) throw new VaultStartOwed(vault, 'it was sent and the chain has not shown it yet.');
  if (asDeployed.refusal !== null) {
    const why = asDeployed.refusal.replace(/ Nothing was sent\.$/u, '');
    throw new VaultNotTheCompanys(vault, doors.again !== undefined ? why : `${why} This vault is not set up and no money is put into it; create a new vault.`);
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

/** A read that did not answer within SERVICE_READ_BOUND_MS, on its own or as the cause of a vault not read here. */
const ranOutOfTime = (e: unknown): boolean =>
  e instanceof ReadRanOutOfTime || (e instanceof VaultNotReadHere && e.cause instanceof ReadRanOutOfTime);

/**
 * What a step sent straight to the chain is named by: nothing, since no service answered for it. The step is then
 * found on the chain as one whose answer from the service was lost: by the coin it kept, or, for a payment that keeps
 * no change, by its own transaction.
 */
const NAMED_BY_NOTHING: { readonly txRef: string; readonly transactionHash: string | null } = Object.freeze({ txRef: '', transactionHash: null });

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
      throw new VaultStartOwed(vault, STALE_ADOPTION, START_STOP.adoptionStale);
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
        heldNow: async () => { const n = await standingNow(doors, vault); return n.standing.adopted || n.standing.adoption.open; },
      }));
      at = await untilTheChainShows(doors, vault, 'raising its adoption', (n) => n.standing.adoption.open || n.standing.adopted);
    }
    /* The raise counted as its raiser's approval when the raiser may approve, so this seat approves only when the chain does not count it yet. */
    if (!at.standing.adopted && at.standing.adoption.approvals < at.standing.adoption.needed
      && !approvedHere(vault, at.standing.adoption, 'its adoption')) {
      await accountStep(doors, vault, at.chain, 'adoption',
        { circuit: 'approve', proposal: a.proposal, of: { governance, proposalSalt: a.salt } }, opened, 'approving its adoption');
      at = await untilTheChainShows(doors, vault, 'approving its adoption',
        (n) => n.standing.adopted || n.standing.adoption.approvedHere === true);
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

  /* ---- b to d. the pool, the nonce secret, its first run set and every sealed copy written ---- */
  const awaiting = await secretStartedHere(doors, vault, sayIt);
  if (awaiting !== null) return { vault, state: 'awaiting-approvals', awaiting, ...saying() };
  doors.progress?.('done');
  return { vault, state: 'started', ...saying() };
}

/** The run a start is made under, as the worker made it: the page reads only what it hands back. */
export type { SecretRunOnTheWire, StartStandingOnTheWire };

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
   * ends before `depositLandsBy` of this.
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
 * transaction whose time to live is behind the block it would go in. The
 * quarter of an hour more is room for the time from filing its coin in the
 * vault's deposit journal to building it. `depositIntoCompanyVault` reads the
 * built transaction's own time to live and sends nothing that could land after
 * this window, counted from either its journal line or its record here.
 * Past this, a deposit the chain does not hold never will.
 */
export const DEPOSIT_TIME_TO_LIVE_MS = 75 * 60_000;

/**
 * How far apart two devices' clocks may be when one judges a deposit another
 * filed in the vault's deposit journal. The line's time is the filing device's;
 * a reader whose clock runs ahead would otherwise call a deposit over while it
 * can still land.
 */
export const DEPOSIT_CLOCKS_MAY_DIFFER_MS = 5 * 60_000;

/**
 * **WHEN A PUBLIC DEPOSIT CAN NO LONGER LAND**, on this device's clock: its own time to live (`until`, read from the
 * transaction the wallet signed) and the margin for a device clock ahead of the chain's. Before this the same money is
 * not put in again, and only after it is a deposit the chain does not show said never to have landed.
 */
export const publicDepositCannotLandAfter = (until: number): number => until + DEPOSIT_CLOCKS_MAY_DIFFER_MS;

/** When a deposit can no longer land, counted from this device's own time for it (when it was kept on its way). */
const depositLandsBy = (from: number): number => from + DEPOSIT_TIME_TO_LIVE_MS;

/**
 * **THE ONE WINDOW BOTH JUDGES OF A PRIVATE DEPOSIT SAY "NEVER LANDED" AFTER**: the window and the margin for clocks
 * that differ, counted from a time no earlier than the deposit's journal line. The record kept on its way is taken
 * after its line is filed, so a deposit settled as never landed from that record is past its line's window too, and
 * no check of the journal then reports it as still on its way.
 */
const depositCannotLandAfter = (from: number): number => depositLandsBy(from) + DEPOSIT_CLOCKS_MAY_DIFFER_MS;

/**
 * When a deposit the vault's deposit journal names can no longer land, counted
 * from the time its line was filed, which is before the deposit was built (a
 * build that ends later than the window allows is never sent). A line with no
 * readable time is past it: nothing can say when it began.
 */
export const journalledDepositLandsBy = (attemptedAt: unknown): number => {
  const at = typeof attemptedAt === 'string' ? Date.parse(attemptedAt) : Number.NaN;
  return Number.isFinite(at) ? depositCannotLandAfter(at) : Number.NEGATIVE_INFINITY;
};

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
    const at = timeShown(until);
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
      + 'part of its balance as held for this deposit until the transaction it finished can no longer be sent; only '
      + 'your wallet can release that hold.');
    this.name = 'DepositNotSent';
  }
}

/**
 * **THE DEPOSIT COULD LAND AFTER EVERY CHECK SAYS IT NEVER WILL, SO IT WAS NOT
 * SENT.** Every reader counts a deposit's window from its journal line or its
 * record here; a built transaction whose own time to live ends later, or whose
 * time to live cannot be read, is stopped before the wallet is asked.
 */
export class DepositMayOutliveItsWindow extends Error {
  constructor(readonly vault: Hex) {
    super('the deposit was not sent and no money moved: the transaction built for it could still have arrived after '
      + 'this page would say it never will. Your wallet was not asked to pay. You can put money in again now.');
    this.name = 'DepositMayOutliveItsWindow';
  }
}

/**
 * **THE WALLET HANDED BACK A PRIVATE DEPOSIT OTHER THAN THE ONE THIS DEVICE
 * BUILT, SO IT WAS NOT SENT.** No money moved: the wallet runs the whole private
 * deposit and hands what it finished to nobody else. Its own hold on its coins is
 * as for any deposit that was not sent. A public deposit refused for the same
 * reason is `PublicDepositNotAsBuilt`.
 */
export class DepositNotAsBuilt extends DepositNotSent {
  constructor(vault: Hex, why: string) {
    super(vault, `your wallet handed back a deposit other than the one this device built: ${why}`);
    this.name = 'DepositNotAsBuilt';
  }
}

/** What a deposit this device built puts into the vault: a private deposit's coin, by the commitment the ledger records for it, or a public deposit's token and amount. */
export type DepositAsBuilt =
  | { readonly vault: Hex; readonly coin: string }
  | { readonly vault: Hex; readonly token: Hex; readonly amount: bigint };

const bareOf = (v: string): string => v.toLowerCase().replace(/^0x/u, '');
const callKey = (c: { address: string; entryPoint: string; segments: readonly number[] }): string =>
  `${bareOf(c.address)}|${c.entryPoint}|${[...c.segments].join(',')}`;
const sameList = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
};

/**
 * **WHY THE TRANSACTION THE WALLET HANDED BACK IS NOT THE DEPOSIT THIS DEVICE
 * BUILT**, or null when it is. Both are read from their own bytes on this device
 * (`readTransaction`), and nothing the wallet says beside the transaction is
 * believed. It must make exactly the contract calls the device built, every one
 * to this vault; create for a contract exactly what was built (a private
 * deposit's one coin, as an output to this vault, once; a public deposit none),
 * and no coin for a contract that it spends again inside itself; and take in
 * public money exactly as built (a private deposit none; a public deposit this
 * token and this amount, once, into this vault's public deposit, in one part
 * of the transaction, as `readPublicDepositCall` reads the call). Whatever the
 * wallet adds to pay for it (its own coins, its change, the fee) is not judged
 * here. Anything that cannot be read is refused, so a deposit is only ever
 * stopped by this, never let through.
 */
export function whyNotTheDepositBuilt(
  finished: TransactionRead | null, built: TransactionRead | null, asBuilt: DepositAsBuilt,
): string | null {
  if (finished === null || built === null) return 'it could not be read on this device.';
  const vault = bareOf(asBuilt.vault);
  if (built.calls.length === 0 || built.calls.some((c) => bareOf(c.address) !== vault)) {
    return 'the deposit this device built could not be read as a call to this vault.';
  }
  if (!sameList(finished.calls.map(callKey), built.calls.map(callKey))) {
    return 'it does not make the calls to the vault this device built.';
  }
  const made = finished.coinsForContracts;
  const takes = finished.publicTakes;
  if (made === undefined || made === null || takes === undefined || takes === null) {
    return 'what it pays into the vault could not be read on this device.';
  }
  /* A coin made and spent inside the transaction is never held by its contract, so it can be no deposit's coin. */
  if (made.some((c) => c.madeAndSpent === true)) return 'it makes a private coin for a contract and spends it again at once.';
  const coins = made;
  if ('coin' in asBuilt) {
    const own = bareOf(asBuilt.coin);
    if (coins.length !== 1 || coins[0]!.contract !== vault || bareOf(coins[0]!.commitment) !== own) {
      return 'it does not create the one coin this device built for this vault, exactly once.';
    }
    if (takes.length !== 0) return 'it takes public money into a contract, and this private deposit takes none.';
    return null;
  }
  if (coins.length !== 0) return 'it creates a private coin for a contract, and this public deposit creates none.';
  /* What the one public deposit call asks for is read by `readPublicDepositCall`; compared here with what was built. */
  const deposits = finished.publicDeposits;
  if (deposits === undefined) return 'what it pays into the vault could not be read on this device.';
  const deposit = deposits[0];
  if (deposits.length === 1 && deposit !== undefined && 'refused' in deposit && deposit.refused === 'split') {
    return 'its call is split across two parts of the transaction, so the chain could apply one part and refuse the other.';
  }
  if (takes.length !== 1 || deposits.length !== 1 || deposit === undefined || 'refused' in deposit || bareOf(deposit.vault) !== vault
    || bareOf(deposit.colour) !== bareOf(asBuilt.token) || deposit.amount !== asBuilt.amount.toString()) {
    return 'it does not put exactly this token and amount into this vault\'s public deposit, once.';
  }
  return null;
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
 * **WHERE A DEPOSIT'S COIN STANDS, AS THE CHAIN AND THE VAULT'S RECORD SHOW IT.**
 * The one judge of whether a private deposit landed, for the deposit this device
 * kept on its way and for every deposit the vault's deposit journal names:
 *
 *   · `recorded`: the chain made its coin and the vault's record holds its
 *     nonce. A record naming the nonce with no such coin made is not the
 *     chain's word, so it is not this;
 *   · `held`: the vault's notes hold its coin and its record does not;
 *   · `spent`: the chain made it, the vault no longer holds it, and a believed
 *     version of the vault's record once named it: it landed and has since left;
 *   · `made-unnamed`: the chain made it and no record ever named it: it has
 *     arrived, or the read saw it made before it saw it held;
 *   · `unseen`: the chain has not made it.
 *
 * It reads the chain as `view` holds it and the vault's record; it files nothing.
 */
async function depositAsTheChainShows(
  doors: DepositDoors, vault: Hex, coin: { readonly nonce: string; readonly token: string; readonly value: string }, view: VaultChainView,
): Promise<{ readonly is: 'recorded' | 'held' | 'spent' | 'made-unnamed' | 'unseen'; readonly output: string }> {
  const { output, held } = await doors.builder.commitments({ vault, coin: coin as { nonce: Hex; token: Hex; value: string } });
  const bare = (h: string) => h.toLowerCase().replace(/^0x/u, '');
  const made = (view.everCreated ?? []).some((c) => bare(c) === bare(output));
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  const nonce = coin.nonce.toLowerCase();
  if (made && (await pool.load(vault)).notes.some((n) => n.nonce.toLowerCase() === nonce)) return { is: 'recorded', output };
  if ((view.notes ?? []).some((n) => n.toLowerCase() === held.toLowerCase())) return { is: 'held', output };
  if (!made) return { is: 'unseen', output };
  for (const v of await doors.records('pool').versions(vault)) {
    if (v.neverEntered === true) continue;
    try {
      const page = openPool(v.sealed, doors.me.signerId, doors.me.wrappingSecret, { record: 'pool' }) as { notes?: Array<{ nonce?: string }> };
      if ((page.notes ?? []).some((n) => String(n.nonce).toLowerCase() === nonce)) return { is: 'spent', output };
    } catch {
      /* a version this signer cannot open names nothing it can read */
    }
  }
  return { is: 'made-unnamed', output };
}

/**
 * **WHAT BECAME OF A DEPOSIT KEPT ON ITS WAY AND NOT YET SEEN ARRIVE**, as
 * `depositAsTheChainShows` judges its coin:
 *
 *   · recorded: nothing to record, and it is forgotten;
 *   · held: the note is recorded, under the transaction the chain says created
 *     it; once it can no longer land, without that transaction if it still
 *     cannot be read;
 *   · spent: it landed and has since left the vault, so it is forgotten;
 *   · made and never named: it is kept (`DepositLandedNotYetRecorded`);
 *   · unseen past `depositCannotLandAfter` of when it was kept, the same window
 *     its journal line is judged by: it never will land, and it is forgotten;
 *   · otherwise it can still arrive, and `DepositStillInFlight` says until when.
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
  const { is, output } = await depositAsTheChainShows(doors, vault, d.coin, seen);
  const until = depositCannotLandAfter(d.recordedAt);
  const past = (doors.clock ?? Date.now)() > until;
  if (is === 'recorded' || is === 'spent') {
    await letGo(doors, vault, d.claim);
    return { state: is === 'recorded' ? 'already-recorded' : 'landed-and-since-spent' };
  }
  if (is === 'held') {
    if (!files) return { state: 'landed-owed-its-record' };
    return { state: 'recorded', ...await recordLandedDeposit(doors, vault, d, output, { waiting: false, giveUp: past }) };
  }
  if (is === 'made-unnamed') throw new DepositLandedNotYetRecorded(vault, d.txRef);
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
 * way in `doors.inFlight` first, keeps the coin before it is paid, sends nothing the wallet hands back that is not the
 * deposit built here (`whyNotTheDepositBuilt`), and from the send on says the deposit may have landed on every failure
 * but one the send marks as having sent nothing. The wallet runs it whole, and its send marks none: no page's word that
 * nothing left is believed.
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
  /* Taken before the coin is filed in the vault's deposit journal, so no later than the line's own time. */
  const choosing = (doors.clock ?? Date.now)();
  const removals = await removalsOnTheChainHere(doors, vault);
  const { coin } = await depositCoinOnThisDevice({
    vault, money, me: doors.me, signers: doors.signers, records: doors.records,
    chain: {
      everCreated: new Set(view.everCreated ?? []),
      outputCommitmentOf: async (c) => (await commitments(c)).output,
      heldNow: async (c) => notes.has((await commitments(c)).held.toLowerCase()),
      /* The same state the deposit is built against below: a state that lies about the commitment is refused by the chain. */
      secretIsTheVaults: (secret) => doors.builder.secretIsTheVaults({ vault, state: view.state!, secret }),
      removals,
      secretSet: () => whenTheSecretWasSetHere(doors, vault, (view.nonceCommitment ?? '') as Hex),
    },
  });
  doors.progress?.('building the deposit');
  const built = await endedIfItThrows(doors, vault, coin.nonce, () => doors.builder.deposit({
    vault, coin: { nonce: coin.nonce, token: coin.token, value: coin.value.toString() }, state: view.state!, parameters,
  }));
  /*
   * **WORKED OUT BEFORE THE WALLET IS ASKED, AND THIS MAY NOT MOVE BELOW THE
   * SEND.** What the chain will show for this coin is read off the vault worker
   * now, while a failure means nothing was paid; after the send, a worker that
   * stopped would read as a failure of a deposit that may have been sent.
   */
  const { output, held } = await endedIfItThrows(doors, vault, coin.nonce, () => commitments(coin));
  /*
   * Every reader counts this deposit's window from its journal line (filed after `choosing`, so its window ends no
   * earlier than the one counted here) or from its record here (`recordedAt`), and adds the margin for clocks that
   * differ. The built transaction's own earliest time to live, read from its bytes, must end inside both windows
   * without that margin, however long the build took, or a reader whose clock runs ahead could say it never landed
   * while it still can. One whose time to live cannot be read is not sent either. Stopped here, before the wallet is
   * asked; the line is marked ended, and money can be put in again at once.
   */
  const recordedAt = (doors.clock ?? Date.now)();
  const read = typeof doors.builder.readTransaction === 'function'
    ? await doors.builder.readTransaction({ transaction: built.tx }).catch(() => null) : null;
  const endsBy = read?.timeToLive ?? null;
  if (endsBy === null || endsBy > depositLandsBy(choosing) || endsBy > depositLandsBy(recordedAt)) {
    throw await neverHandedOver(doors, vault, coin.nonce, new DepositMayOutliveItsWindow(vault));
  }
  /*
   * **KEPT ON THIS DEVICE BEFORE THE WALLET IS ASKED, AND THIS MAY NOT MOVE
   * BELOW THE SEND.** From the send on, the money may move whatever happens to
   * this page, and this is what the next deposit from here looks for first.
   */
  const coinOnTheWire = { nonce: coin.nonce, token: coin.token, value: coin.value.toString() };
  const first: DepositInFlight = { coin: coinOnTheWire, recordedAt, txRef: '', transactionHash: null };
  /* Kept only where nothing is: another tab's deposit into this vault, kept since this one settled, stops this one here. */
  const claim = await endedIfItThrows(doors, vault, coin.nonce, () => doors.inFlight.claim(vault, first));
  if (claim === null) {
    throw await neverHandedOver(doors, vault, coin.nonce, new DepositStartedElsewhere(vault));
  }
  let inFlight: Kept<DepositInFlight> = { ...first, claim };
  doors.progress?.('asking your wallet');
  let paid: { transaction: string; leaves: readonly unknown[] };
  try {
    paid = await doors.pay({ company: doors.company, account: doors.account, vault: vault as VaultAddress, transaction: built.tx });
  } catch (e) {
    throw await neverHandedOver(doors, vault, coin.nonce, e instanceof Error ? e : new Error(String(e)), claim);
  }
  /* The wallet balanced, proved and signed the deposit out of this device's sight: it is sent only if it still puts in exactly the coin built here. */
  const handedBack = typeof doors.builder.readTransaction === 'function'
    ? await doors.builder.readTransaction({ transaction: paid.transaction }).catch(() => null) : null;
  const notAsBuilt = whyNotTheDepositBuilt(handedBack, read, { vault, coin: output });
  if (notAsBuilt !== null) {
    throw await neverHandedOver(doors, vault, coin.nonce, new DepositNotAsBuilt(vault, notAsBuilt), claim);
  }
  /* A removal counted while the deposit was built and paid for refuses it here, before it is sent. */
  const countNow = await removalsOnTheChainHere(doors, vault).catch((e: unknown) => e as Error);
  if (countNow !== removals) {
    throw await neverHandedOver(doors, vault, coin.nonce, countNow instanceof Error
      ? new Error(`${countNow.message.replace(/ Try again\.$/u, '')} Nothing was sent.`) : new VaultSecretBeingChanged(vault), claim);
  }
  doors.progress?.('sending the deposit');
  let sent: { txRef: string; transactionHash: string | null };
  try {
    sent = await doors.service.deposit(vault, paid.transaction);
  } catch (e) {
    if (!sentNothing(e)) throw new DepositNotYetSeen(vault, '');
    /* Handed to the service: its word that nothing left is not this device's own, so the journal line is not marked. */
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
 * **THE SERVICE DID NOT SEND THIS PUBLIC DEPOSIT, AND THE WALLET HAS SIGNED IT.** No money has moved, but the signed
 * transaction can still land until `publicDepositCannotLandAfter(until)`, `until` being its own time to live, and if it
 * does, the money goes into this vault. So the same money must not be put in again before then. `refusal` is the
 * service's own answer.
 */
export class PublicDepositSignedNotSent extends Error {
  constructor(readonly vault: Hex, readonly until: number, refusal: unknown) {
    const at = new Date(publicDepositCannotLandAfter(until)).toLocaleTimeString();
    super(`the public deposit was not sent, so no money has moved yet. Your wallet already signed it, and `
      + `until ${at} anyone can still send it. If they do, the money goes into this vault and nowhere else. Do not put `
      + `the same money in again before ${at}, or the vault may receive it twice. The service said: `
      + `${(refusal as Error)?.message ?? String(refusal)}`);
    this.name = 'PublicDepositSignedNotSent';
  }
}

/**
 * **THE WALLET SIGNED A PUBLIC DEPOSIT OTHER THAN THE ONE THIS DEVICE BUILT, AND
 * THIS PAGE DID NOT SEND IT.** The page cannot say no money moved: the wallet
 * holds what it signed and can send it itself until it can no longer land
 * (`publicDepositCannotLandAfter(until)`), so, as for any signed public deposit
 * this page did not send, the money is not put in again before then.
 */
export class PublicDepositNotAsBuilt extends PublicDepositSignedNotSent {
  constructor(vault: Hex, until: number, why: string) {
    super(vault, until, why);
    const at = new Date(publicDepositCannotLandAfter(until)).toLocaleTimeString();
    this.message = `this page did not send the public deposit, because your wallet handed back a deposit other than `
      + `the one this device built: ${why} Your wallet already signed what it handed back, and until ${at} anyone `
      + `holding it, your wallet included, can still send it. Do not put money in again before ${at}. If your wallet's `
      + 'public balance has not dropped by then, no money moved.';
    this.name = 'PublicDepositNotAsBuilt';
  }
}

/**
 * **THE CHAIN TOOK THIS PUBLIC DEPOSIT AND REFUSED IT.** The part of the transaction that carries the vault's public
 * deposit failed, so nothing went into the vault, and the chain will not apply the same transaction again: the money
 * can be put in again at once. Raised only on the chain's own result for that part, read at the wallet's indexer.
 */
export class PublicDepositRefused extends Error {
  constructor(readonly vault: Hex, readonly transactionHash: string) {
    super(`the chain refused this public deposit (${transactionHash}), so nothing went into the vault and it will not `
      + 'be tried again. You can put money in again now.');
    this.name = 'PublicDepositRefused';
  }
}

/**
 * **THIS PUBLIC DEPOSIT CAN NO LONGER LAND, AND THE CHAIN DOES NOT SHOW IT.** Raised only when the wallet's indexer
 * answered cleanly that it holds no such transaction, after the deposit's own time to live (`until`) and the margin for
 * clocks that differ have both passed. Nothing went into the vault, and the money can be put in again.
 */
export class PublicDepositNeverLanded extends Error {
  constructor(readonly vault: Hex, readonly until: number) {
    super(`the public deposit did not reach the chain before ${new Date(until).toLocaleTimeString()}, when it stopped `
      + 'being valid, so it never will and nothing went into the vault. You can put money in again now.');
    this.name = 'PublicDepositNeverLanded';
  }
}

/**
 * **A PUBLIC DEPOSIT MAY HAVE BEEN SENT, AND THIS PAGE HAS NOT SEEN IT ARRIVE.** The
 * money may have moved. Raised for every failure after the service began
 * sending, and when the chain at the wallet's indexer has not shown the deposit
 * by the end of the wait or cannot be looked at, so no screen reads it as a
 * deposit that did not happen. `until` is the deposit's own time to live, read
 * from the transaction the wallet signed; the time it names is
 * `publicDepositCannotLandAfter(until)`. `cause`, when given, is why this page
 * could not see it, and is named for support.
 */
export class PublicDepositNotYetSeen extends Error {
  constructor(readonly vault: Hex, readonly until: number, cause?: unknown) {
    super('the public deposit may have been sent, and this page was not told whether it arrived. Do not put the same '
      + `money in again before ${new Date(publicDepositCannotLandAfter(until)).toLocaleTimeString()}. If it has not arrived by then, it never will. `
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
 *   5. the transaction the wallet signed is read on this device: its
 *      identifiers, its earliest time to live, and what it puts into the vault,
 *      which must be exactly the call built here, taking this token and this
 *      amount once (`whyNotTheDepositBuilt`). One this device cannot read, that
 *      is not the deposit built, or that can no longer land, is not sent;
 *   6. the service is handed the transaction and nothing else; it adds the
 *      network fee and sends it, and refuses one that is not exactly one
 *      public token, a positive amount of it, into this vault;
 *   7. this device waits until the chain at the wallet's indexer shows the very
 *      transaction the wallet signed with the part carrying this vault's public
 *      deposit applied, and only then says it is done. It returns the chain's
 *      hash of that transaction, never the service's. A deposit whose part the
 *      chain refused ends at once with nothing paid in, and one the indexer
 *      still does not hold once its time to live and the margin for clocks
 *      have passed never landed.
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
  /* A deposit this page could not read or watch arrive would end with nobody able to say it did, so it is not started. */
  if (typeof doors.builder.vaultCallOnChain !== 'function' || typeof doors.builder.readTransaction !== 'function') {
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
  /*
   * **WHEN IT CAN NO LONGER LAND, READ FROM WHAT THE WALLET SIGNED.** Every intent's time to live is checked by the
   * chain, so the earliest is the deposit's; the fee the service merges in can only end it sooner. A transaction this
   * device cannot read, or that names nothing to look for it by, could never be followed to the chain, and one already
   * past its time could never land: neither is sent.
   */
  const read = await doors.builder.readTransaction!({ transaction: paid.transaction });
  if (read === null || read.timeToLive === null || read.identifiers.length === 0) {
    throw new Error('this page could not read the public deposit your wallet signed, so it did not send it and no '
      + 'money moved. You can put money in again now.');
  }
  const livesUntil = read.timeToLive;
  if ((doors.clock ?? Date.now)() >= livesUntil) {
    throw new Error(`the public deposit your wallet signed stopped being valid at ${new Date(livesUntil).toLocaleTimeString()}, `
      + 'so this page did not send it and no money moved. You can put money in again now.');
  }
  /*
   * The wallet's own account of what it paid (`leaves`) is its word; the transaction it signed is what lands. One that
   * is not the deposit built here is not sent, and, being signed, is said to be still sendable until it can no longer land.
   */
  const builtRead = await doors.builder.readTransaction!({ transaction: built.tx }).catch(() => null);
  const notAsBuilt = whyNotTheDepositBuilt(read, builtRead, { vault, token: money.token, amount: money.value });
  if (notAsBuilt !== null) throw new PublicDepositNotAsBuilt(vault, livesUntil, notAsBuilt);
  doors.progress?.('sending the deposit');
  let sent: { txRef: string; transactionHash: string | null };
  try {
    sent = await doors.service.depositPublicly(vault, paid.transaction);
  } catch (e) {
    if (!sentNothing(e)) throw new PublicDepositNotYetSeen(vault, livesUntil);
    throw new PublicDepositSignedNotSent(vault, livesUntil, e);
  }
  /*
   * **DONE ONLY WHEN THE CHAIN SHOWS IT.** The service's answer, its hash included, is its own word. The deposit is
   * looked for at the indexer the wallet names, by the identifiers of the very transaction the wallet signed, which the
   * service's fee does not change, and judged by the part of it that carries this vault's public deposit
   * (`vaultCallOnChain`). Another deposit of the same token and amount is another transaction and is never taken for
   * this one. A part the chain refused ends the wait at once: nothing went in. A read that may come right if asked again
   * keeps the wait going; one that cannot, or an answer that cannot say whether the deposit took effect, ends it at once
   * as may have been sent. Only a clean answer that the indexer holds no such transaction, once the deposit's own time
   * and the margin for clocks have passed, says it never landed.
   */
  doors.progress?.('waiting for the chain');
  const clock = doors.clock ?? Date.now;
  let lastFailure: unknown;
  type Look = { readonly found: VaultCallOnChain } | { readonly cannot: unknown } | { readonly never: true };
  const seen = await until<Look>(doors, async () => {
    try {
      const found = await doors.builder.vaultCallOnChain!({
        vault, entryPoints: [PUBLIC_DEPOSIT_ENTRY], transaction: paid.transaction, indexer: await theWalletsIndexer(doors, vault),
      });
      if (found.of !== 'not-seen') return { found };
      return clock() > publicDepositCannotLandAfter(livesUntil) ? { never: true } : null;
    } catch (e) {
      lastFailure = e;
      return aLookThatMayClear(e) ? null : { cannot: e };
    }
  });
  if (seen === null) throw new PublicDepositNotYetSeen(vault, livesUntil, lastFailure);
  if ('never' in seen) throw new PublicDepositNeverLanded(vault, livesUntil);
  if ('cannot' in seen) throw new PublicDepositNotYetSeen(vault, livesUntil, seen.cannot);
  if (seen.found.of === 'refused') throw new PublicDepositRefused(vault, seen.found.transactionHash);
  if (seen.found.of !== 'landed') {
    throw new PublicDepositNotYetSeen(vault, livesUntil, new Error(seen.found.of === 'not-known' ? seen.found.why : seen.found.of));
  }
  doors.progress?.('done');
  return { txRef: sent.txRef, transactionHash: seen.found.transactionHash, token: money.token, value: money.value };
}

/* ------------------------------------------------------------ a payment out */

/**
 * **A PRIVATE PAYMENT THIS DEVICE HAS HANDED OVER TO BE SENT AND HAS NOT YET
 * RECORDED.** Kept on this device, sealed under the signer's own key, from
 * just before the send until the vault's record shows it. It keeps what
 * nothing else can give back: the coin the payment returns to the vault, read
 * when the payment was built, or, for a payment that returns none, its own
 * transaction's identifiers, by which alone the chain says it landed. Without
 * them, a payment that landed while this page was not watching leaves nothing
 * anyone can name it by.
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
  /**
   * For a payment that keeps no change, read before the send from the transaction handed over to be sent: every
   * identifier the chain can be asked about it by (binding it and merging a fee into it leave each one as it was).
   * Absent on a step that keeps a coin. A payment that keeps no coin and whose record lacks them cannot name its own
   * transaction, so it is never recorded as landed.
   */
  readonly identifiers?: readonly string[];
  /** The same transaction's earliest time to live, in milliseconds since the epoch: after it, it can no longer land. */
  readonly timeToLive?: number;
  /** The same transaction (base64), from which the worker reads its identifiers and its call to the vault again. */
  readonly transaction?: string;
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
 * vault's record does not yet say which notes are left. `unread` when it is
 * held because something on the chain could not be read: then it stays held
 * until the chain can be read, whatever the time, and the words never name a
 * time after which it is let go.
 */
export class PaymentStillInFlight extends Error {
  readonly unread: boolean;
  constructor(
    readonly vault: Hex, readonly txRef: string, readonly until: number, why?: string,
    held: { readonly unread?: boolean } = {},
  ) {
    const at = timeShown(until);
    super(`an earlier payment out of this vault from this browser${txRef === '' ? '' : ` (${txRef})`} is not in the `
      + `vault's record yet${why === undefined ? '' : ` (${why})`}, so no other payment is made from here until it is. `
      + `Nothing new was prepared or sent. Try again in a minute: once the chain shows it, it is recorded first. `
      + (held.unread === true
        ? 'The chain could not be read just now. This payment stays held, and no other payment leaves this vault from '
          + 'here, until it can be.'
        : `If the chain has not shown it by ${at}, it never will, and after then payments go ahead as soon as this `
          + 'vault\'s history can be read.'));
    this.name = 'PaymentStillInFlight';
    this.unread = held.unread === true;
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

/**
 * **A PAYMENT THE CHAIN REFUSED.** Its own transaction is on the chain, and the
 * part of it that carries this vault's payout did not take effect, so no money
 * left the vault by it. It is let go at once.
 */
export class PaymentRefusedOnChain extends Error {
  constructor(readonly vault: Hex, readonly transactionHash: string) {
    super(`the chain refused the payment${transactionHash === '' ? '' : ` (${transactionHash})`}, so no money left the `
      + 'vault by it and nobody was paid by it. The run shows whether this person is still owed: open it again before '
      + 'paying them.');
    this.name = 'PaymentRefusedOnChain';
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

/** The one circuit of the vault a payment out of it calls. */
const A_PAYOUT: readonly string[] = ['payout'];

/**
 * **UNTIL WHEN A PAYMENT ON ITS WAY CAN STILL LAND.** Never before
 * `DEPOSIT_TIME_TO_LIVE_MS` after it was kept; for a record that kept its own
 * transaction's time to live, never before that time plus the one margin for
 * clocks that differ (`DEPOSIT_CLOCKS_MAY_DIFFER_MS`).
 */
const paymentLandsBy = (p: PaymentInFlight): number => {
  const kept = p.recordedAt + DEPOSIT_TIME_TO_LIVE_MS;
  return typeof p.timeToLive === 'number' && Number.isFinite(p.timeToLive)
    ? Math.max(kept, p.timeToLive + DEPOSIT_CLOCKS_MAY_DIFFER_MS) : kept;
};

/**
 * What the chain says of a payment's own transaction: `vaultCallOnChain`'s
 * answer, or `unnamed` when the record names no transaction of its own, or
 * `cannot` when the chain could not be asked, which says nothing about whether
 * it landed.
 */
type OwnPaymentSeen = VaultCallOnChain | { readonly of: 'unnamed' } | { readonly of: 'cannot'; readonly why: string };

/**
 * **A PAYMENT'S OWN TRANSACTION, LOOKED FOR ON THE CHAIN.** Asked in the worker
 * at the wallet's indexer by the identifiers of the transaction the record
 * kept, and judged by the part of it that carries this vault's payout
 * (`vaultCallOnChain`). A hash the service answered with is never asked for.
 */
async function ownPaymentOnChain(doors: PayoutDoors, vault: Hex, p: PaymentInFlight): Promise<OwnPaymentSeen> {
  if (!Array.isArray(p.identifiers) || p.identifiers.length === 0 || typeof p.transaction !== 'string') return { of: 'unnamed' };
  if (typeof doors.builder.vaultCallOnChain !== 'function') {
    return { of: 'cannot', why: 'this page cannot ask the chain about a payment by its own transaction' };
  }
  try {
    return await doors.builder.vaultCallOnChain({
      vault, entryPoints: [...A_PAYOUT], transaction: p.transaction, indexer: await theWalletsIndexer(doors, vault),
    });
  } catch (e) {
    return { of: 'cannot', why: whyAfterTheSend(e) };
  }
}

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
 * for, a line whose first note is one this payment spends counts at once: a
 * coin names the note it was made from, so that coin on the chain says this
 * payment's note went into another step, and this payment cannot have landed.
 * A line that names this payment's note only beside its first counts only once
 * this payment is established as not landed (`notLanded`: its own transaction
 * refused, or unseen past its window): that coin names the other note, which
 * another step may have spent, so until then it cannot say this payment did
 * not land, and a payment that paid never reads as payable again.
 */
async function overtakenBy(
  doors: PayoutDoors, vault: Hex, p: PaymentInFlight, onChain: ReadonlySet<string>, until: number, notLanded: boolean, state?: string,
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
  let secrets: Hex[] | null = null;
  for (const a of attempts) {
    const notes = [a.spent, ...(a.further ?? [])];
    if (!notes.some((n) => mine.includes(lowerOf(n.nonce)))) continue;
    /*
     * With no change of its own on the chain to weigh it against, only a coin made from this payment's own note says
     * so, until this payment is established as not landed.
     */
    if (p.change === null && !notLanded && !mine.includes(lowerOf(a.spent.nonce))) continue;
    /* A line identical to this payment's is this payment: the same notes and amount make the same change. */
    if (attemptKey(stepOfLine(a)) === thisPayment) continue;
    /* A step that landed spent every note it names: one the chain still holds says this line is not the one that landed. */
    let allGone = true;
    for (const n of notes) if (onChain.has(await heldOf(coinOnTheWire(n)))) allGone = false;
    if (!allGone) continue;
    /* Under every secret the vault may have held when the step was made, the records' and this signer's copy on the chain. */
    secrets ??= await secretsToTry(doors, vault, state);
    const made = await keptOnTheChainUnder(doors, vault, secrets, {
      spent: coinOnTheWire(a.spent), ...(a.further === undefined ? {} : { further: a.further.map(coinOnTheWire) }),
      amount: a.amount.toString(), ...(a.step === 'merge' ? { merge: true } : {}),
    }, onChain);
    if (made === null) continue;
    const { kept, output } = made;
    const found = await creatingTransactionOfOutput(doors, vault, output, null, 'the coin of the step that spent this payment\'s note');
    if (found.state !== 'found') {
      throw new PaymentStillInFlight(vault, p.txRef, until,
        'a step that spent the note it would spend has landed, and the transfer that made that step\'s coin cannot be read yet',
        { unread: true });
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
 * is settled - when this browser looks again, and while a payment that kept no
 * change is watched for and its own transaction is not seen yet - so a step
 * another holder made is never recorded as this one. `notLanded` as
 * `overtakenBy` takes it. `true` when it was.
 */
async function recordedIfOvertaken(
  doors: PayoutDoors, vault: Hex, p: PaymentInFlight, onChain: ReadonlySet<string>, until: number, notLanded: boolean, state?: string,
): Promise<boolean> {
  const overtaken = await overtakenBy(doors, vault, p, onChain, until, notLanded, state);
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
 *     payment's window (`paymentLandsBy`) has passed it never will, and it is
 *     forgotten; until then `PaymentStillInFlight`;
 *   · the chain no longer holds that note and the payment left no change: it
 *     landed only when the chain shows its own transaction, by the identifiers
 *     it kept, take effect in the part that carries this vault's payout. Then
 *     its notes are taken out of the record and nothing is added. Its notes
 *     leaving is never enough: another step may have spent them. Refused, or
 *     unseen on a clean look past its window, it never landed: a step the
 *     journal names that spent its note, first or beside another, is written
 *     into the record as below, and otherwise it is forgotten and the next
 *     open's rebuild files the coin of whatever spent the note. Unseen inside
 *     its window, or when the chain could not be asked, `PaymentStillInFlight`.
 *     A record that names no transaction of its own, or whose transaction the
 *     chain answers about in a way this cannot read, is let go as
 *     `not-matched` once its window has passed;
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
  const until = paymentLandsBy(p);
  const past = (doors.now ?? (() => new Date()))().getTime() > until;
  /* Only a view that read the vault's notes can say the note it spent has left. */
  if (seen.onChain !== true || !Array.isArray(seen.notes)) {
    throw new PaymentStillInFlight(vault, p.txRef, until, 'the vault\'s notes could not be read just now', { unread: true });
  }
  const { held } = await doors.builder.commitments({ vault, coin: p.spent });
  if (seen.notes.some((n) => n.toLowerCase() === held.toLowerCase())) {
    if (past) {
      await forget();
      return { state: 'never-landed' };
    }
    throw new PaymentStillInFlight(vault, p.txRef, until);
  }
  const onChain = new Set(seen.notes.map(lowerOf));
  if (await recordedIfOvertaken(doors, vault, p, onChain, until, false, seen.state)) {
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
    /* **ONLY ITS OWN TRANSACTION SAYS IT LANDED.** */
    const own = await ownPaymentOnChain(doors, vault, p);
    if (own.of === 'landed') {
      await recordPayment(doors, vault, p.spent.nonce, (p.further ?? []).map((n) => n.nonce), p.amount, null, null);
      await forget();
      return { state: 'recorded', createdIn: null };
    }
    /* An indexer that could not be asked is not an answer: never landed only on a clean look past the window. */
    const notLanded = own.of === 'refused' || (own.of === 'not-seen' && past);
    if (notLanded) {
      if (await recordedIfOvertaken(doors, vault, p, onChain, until, true, seen.state)) {
        await forget();
        return { state: 'overtaken' };
      }
      await forget();
      return { state: 'never-landed' };
    }
    if ((own.of === 'unnamed' || own.of === 'not-known') && past) {
      await forget();
      return { state: 'not-matched' };
    }
    throw new PaymentStillInFlight(vault, p.txRef, until, own.of === 'cannot' || own.of === 'not-known' ? own.why
      : own.of === 'unnamed' ? 'this browser\'s record of it does not name its own transaction, and the chain no longer holds the note it spent'
        : 'the chain has not shown its own transaction yet', { unread: own.of === 'cannot' });
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
  /* Only an answer the time can settle names the time: one still waiting on a read, or on a change the chain holds, does not. */
  throw new PaymentStillInFlight(vault, p.txRef, until, found.state === 'unknown' ? found.why
    : 'the chain no longer holds the note it spent, and the transfer that made its change cannot be read yet',
  { unread: found.state !== 'unknown' && (found.listed !== 'none' || changeOnChain) });
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
 * This device's own seat in the directory it believes, with its role, its retirement and the rights the directory
 * believes it holds, found by the key it files with, or null when it holds none
 * or holds one this device does not believe (`seatNotBelievedHere`: not attested by its own wallet, retired, or not on
 * the chain now) - the one rule every reader of a seat keeps.
 */
export const seatHereIn = async (
  directory: DirectoryRead, signingSecret: Hex,
): Promise<{ readonly role: Role | null; readonly retired: unknown; readonly rights?: SeatRights } | null> => {
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
 * `unsealed` is, as codes, every way a record was left not sealed to every
 * signer the directory seats: the words in `said` are for a person, and
 * nothing reads them to decide anything.
 */
export const NOT_SEALED = Object.freeze({
  signersNotRead: 'signers-not-read',
  notFiledHere: 'not-filed-here',
  notFiledFailed: 'not-filed-failed',
} as const);
export type NotSealed = typeof NOT_SEALED[keyof typeof NOT_SEALED];

export type NotesHere = (
  | { readonly of: 'as-filed' | 'filed' | 'not-filed'; readonly notes: readonly Note[]; readonly unexplained: number; readonly said: readonly string[] }
  | { readonly of: 'not-read'; readonly said: readonly string[] }
) & { readonly leaver?: readonly string[]; readonly unsealed?: readonly NotSealed[] };

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
 * **THE REBUILD, READ AGAIN WITH THIS SIGNER'S OWN SEALED COPY WHEN IT HOLDS A SECRET THE RECORDS DO NOT.** The copy of
 * the secret the vault holds now is read off the chain's state already in hand (no call to the service) and opened
 * only here. When it is not among the records' secrets (they gave none, a change of secret is not filed yet, or the
 * copy holds a secret that is not the vault's), the rebuild is made again with it as `copySecret`: the worker names
 * with it first, and walks back from it to every earlier one, only when it is the secret the vault holds now, and says
 * so when it is not. A copy that does not open is said and left out.
 */
async function rebuiltWithOwnCopy(
  me: DeviceSigner, rebuild: (input: VaultRebuildAsked) => Promise<VaultRebuilt>, vault: Hex,
  asked: Omit<VaultRebuildAsked, 'copyFor' | 'copySecret'>, secrets: readonly string[], said: string[],
): Promise<{ readonly rebuilt: VaultRebuilt; readonly copySecret?: string }> {
  const reader = recordsKeypairFrom(me.companyKey).publicKey;
  const rebuilt = await rebuild({ ...asked, copyFor: reader });
  if (rebuilt.copy === null) return { rebuilt };
  const own = ownCopyOpened(me.companyKey, vault, [{ reader, parts: rebuilt.copy }]);
  if (own === null) said.push('this signer\'s sealed copy of the vault\'s secret on the chain does not open with this signer\'s records key');
  if (own === null || secrets.includes(own)) return { rebuilt };
  return { rebuilt: await rebuild({ ...asked, copySecret: own }), copySecret: own };
}

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
 * 1. The newest pool, both journals' newest versions, the nonce secrets (with
 *    this signer's sealed copy on the chain of the one the vault holds now,
 *    first when the records hold no secret or not that one, and every earlier
 *    secret the vault links to it) and the coins this device keeps are
 *    reconciled with the chain and its split journal in the vault worker.
 *    Every record is read through the one check; one withheld or not believed
 *    is said and the rest are still read, and nothing withheld is read as empty.
 * 2. Only when a chain note is still unnamed: every filed version of the three
 *    records (never one a device passes over; one the company's records do not
 *    believe is said and left out, where the store lists them, `versionsBelieved`),
 *    each journal's newest version read above among them, and the walk over the company's
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
  const unsealed: NotSealed[] = [];
  try {
    for (let attempt = 1; ; attempt += 1) {
      const done = await rebuiltOnce(doors, vault, attempt === 1 ? view : undefined, said, leaver, unsealed);
      if (done !== 'lost-a-race') return { ...done, leaver, unsealed };
      if (attempt === REBUILD_ATTEMPTS) {
        said.push(`another device filed this vault's record first on all ${REBUILD_ATTEMPTS} attempts, so nothing was filed from here`);
        return { of: 'not-read', said, leaver, unsealed };
      }
    }
  } catch (e) {
    said.push(failedSaying(e));
    return { of: 'not-read', said, leaver, unsealed };
  }
}

async function rebuiltOnce(
  doors: RebuildDoors, vault: Hex, given: VaultChainView | undefined, said: string[], leaver: string[], unsealed: NotSealed[],
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
    const key = noteKey(n);
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
  const notHeld = poolNotes.filter((n) => !onChain.has(heldOf.get(noteKey(n))!));
  const readers = await readersMissing(doors, vault, said, unsealed);

  if (loaded !== null && unnamed.length === 0 && notHeld.length === 0) {
    if (readers.length > 0) await sealedToEverySigner(doors, vault, pool, loaded, readers, filable, said, unsealed);
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
  let secrets: string[] = [];
  try {
    const filed = await doors.records('nonce-secret').get(vault);
    if (filed === null) said.push('the company\'s records hold no nonce secret for this vault');
    else secrets = [...openNonceSecrets(filed, vault, recordsKeypairFrom(doors.me.companyKey)).secrets];
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
  const newestRead = { deposits: await newestOf('deposit-journal'), payments: await newestOf('payment-journal') };
  const newest = await journals(newestRead.deposits, newestRead.payments);
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
  const first = await rebuiltWithOwnCopy(doors.me, (i) => doors.builder.vaultRebuilt!(i), vault, asked, secrets, said);
  let rebuilt = first.rebuilt;

  /* ---- 2: every version and the walk, only for a note still unnamed ---- */
  const unnamedKey = `${vault}:${[...rebuilt.unexplained].sort().join(',')}`;
  if (rebuilt.unexplained.length > 0 && !UNNAMED_THIS_SESSION.has(unnamedKey)) {
    const every = async (record: 'pool' | 'deposit-journal' | 'payment-journal'): Promise<FiledPoolVersion[]> => {
      try {
        /* A version the company's records do not believe is said and left out; every other version is still read. */
        const listed = await versionsBelievedOf(doors.records(record), vault);
        for (const r of listed.refused) said.push(`version ${r.version} of this vault's ${record} is not believed, because ${r.why}, so it is left out and every other version is read`);
        return listed.versions.filter((v): v is FiledPoolVersion => v.neverEntered !== true);
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
    /* Each journal's newest version read above is kept even when every version could not be listed, as the pool's is. */
    const withNewest = (all: FiledPoolVersion[], read: FiledPoolVersion[]) => [...all, ...read.filter((n) => !all.some((v) => v.version === n.version))];
    const all = await journals(withNewest(await every('deposit-journal'), newestRead.deposits), withNewest(await every('payment-journal'), newestRead.payments));
    const amounts = new Map<string, { token: string; value: string }>();
    for (const c of [...all.deposits.map(coinWire), ...versions.flatMap((v) => v.notes), ...kept]) amounts.set(`${c.token}:${c.value}`, { token: c.token, value: c.value });
    rebuilt = await doors.builder.vaultRebuilt({
      ...asked, secrets, versions, ...(first.copySecret === undefined ? {} : { copySecret: first.copySecret }),
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
    if (loaded !== null && readers.length > 0) await sealedToEverySigner(doors, vault, pool, loaded, readers, filable, said, unsealed);
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
  if (readers.length > 0) await sealedToEverySigner(doors, vault, null, null, readers, filable, said, unsealed);
  return { of: 'filed', notes: next, unexplained: rebuilt.unexplained.length, said };
}

/**
 * Which of the vault's records - the pool and the two journals, each as the
 * one check gives its newest version - a signer the directory seats cannot
 * open, because it was last filed before they were seated. When the signers
 * cannot be read, that is said and coded in `unsealed`.
 */
async function readersMissing(doors: RebuildDoors, vault: Hex, said: string[], unsealed: NotSealed[]): Promise<Array<'pool' | 'deposit-journal' | 'payment-journal'>> {
  let ids: string[];
  try {
    ids = (await doors.signers()).map((x) => x.id);
  } catch (e) {
    said.push(`who the company's signers are was not read, so no record was sealed to more of them: ${failedSaying(e)}`);
    unsealed.push(NOT_SEALED.signersNotRead);
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
 * them. Only a seat that reads them and may file does it; a refusal is said, and
 * coded in `unsealed`.
 * `pool` and `loaded` are given only when the pool itself still needs it.
 */
async function sealedToEverySigner(
  doors: RebuildDoors, vault: Hex, pool: SealedNotePool | null, loaded: Awaited<ReturnType<SealedNotePool['load']>> | null,
  records: ReadonlyArray<VaultRecordKind>, filable: ReadonlySet<VaultRecordKind>, said: string[], unsealed: NotSealed[],
): Promise<void> {
  for (const record of records) {
    if (!filable.has(record)) {
      said.push(`this vault's ${record} is not filed again for a signer who cannot open it yet: `
        + (doors.seatHere === undefined ? 'a read files nothing, and a seat action in a signer\'s wallet owes it' : 'this device\'s seat may not file it'));
      unsealed.push(NOT_SEALED.notFiledHere);
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
      unsealed.push(NOT_SEALED.notFiledFailed);
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
   * the secret it holds: the one it holds now is taken from the records or
   * this signer's copy on the chain, and none stops the step before a line is
   * written. Nothing is filed on the way.
   */
  const secret = await theSecretToSpend(doors, vault, view.state!);
  return { withEvents, chain, secret };
}

/**
 * **WRITTEN DOWN ONCE THE STEP IS BUILT AND CHECKED, AND THIS MAY NOT MOVE BELOW
 * THE SEND.** The notes, what leaves and whether it is a merge fix the whole of
 * the coin the step keeps; a journal that refuses stops the step with nothing
 * spent. A build the account refuses (a run short of its approvals, a held
 * run) or one that spends other notes than chosen writes no line, so the
 * journal never names a step that was never sent. The line is the one format
 * every step is journalled in.
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
 * failure says the step may have landed. A step that keeps a coin is confirmed
 * only by its own transaction's events, read on this device - or, when the
 * send named none, by the coin it kept. A payment that keeps no coin is
 * confirmed only by the chain showing its own transaction, by the identifiers
 * read from it before the send, take effect in the part that carries this
 * vault's payout; never by its notes leaving, and never by a hash the service
 * named. The vault's record is advanced on those and nothing else.
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
   * **A PAYMENT THAT KEEPS NO COIN IS KNOWN ON THE CHAIN ONLY BY ITS OWN
   * TRANSACTION**, so it is not sent unless that transaction names itself: at
   * least one identifier, a time to live, and exactly one payout of this vault.
   */
  const byItsOwn = s.kept === null && !s.merge;
  let named: Pick<PaymentInFlight, 'identifiers' | 'timeToLive' | 'transaction'> = {};
  if (byItsOwn) {
    const read = typeof doors.builder.readTransaction === 'function' && typeof doors.builder.vaultCallOnChain === 'function'
      ? await doors.builder.readTransaction({ transaction: s.tx }).catch(() => null) : null;
    const bare = (h: string) => lowerOf(h).replace(/^0x/u, '');
    const payouts = read === null ? [] : read.calls.filter((c) => bare(c.address) === bare(vault) && A_PAYOUT.includes(c.entryPoint));
    if (read === null || read.identifiers.length === 0 || read.timeToLive === null || payouts.length !== 1) {
      throw new Error('this page could not read the payment it built well enough to find it on the chain afterwards, so '
        + 'it did not send it. Nothing was sent and nobody was paid by it. Reload the page and pay again.');
    }
    named = { identifiers: [...read.identifiers], timeToLive: read.timeToLive, transaction: s.tx };
  }
  /*
   * **KEPT ON THIS DEVICE BEFORE IT IS SENT, AND THIS MAY NOT MOVE BELOW THE
   * SEND.** The coin kept, and a payment's own transaction, are known only from
   * the build, and from the send on the step may land whatever happens to this
   * page; this is what lets the record be written once it does.
   */
  const first: PaymentInFlight = {
    spent: { nonce: note.nonce, token: note.token, value: note.value },
    ...(further.length === 0 ? {} : { further: further.map((n) => ({ nonce: n.nonce, token: n.token, value: n.value })) }),
    ...(s.merge ? { merge: true as const } : {}),
    amount: s.amount, change: s.kept, recordedAt: (doors.now ?? (() => new Date()))().getTime(), txRef: '', transactionHash: null,
    ...named,
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
    const inFlight: PaymentInFlight = { ...first, txRef: sent.txRef, transactionHash: sent.transactionHash };
    await doors.inFlight.update(vault, claim, inFlight)
      .catch(() => { /* the record kept before still names the coin kept, or the payment's own transaction */ });
    const answered = sent.transactionHash === null ? null : sent.transactionHash.toLowerCase();
    const hash = answered !== null && HEX64.test(answered) ? answered : null;
    doors.progress?.(s.words.waiting);
    /*
     * **WITHOUT A NAME FROM THE SEND, A STEP THAT KEPT A COIN IS FOUND BY IT**,
     * by that coin's own commitment, in this vault's history, and its own
     * events, once found, are judged exactly as a named transaction's are.
     */
    const heldSpent = byItsOwn ? await heldOfANote(doors, vault, s.notes[0]!) : null;
    const keptOutput = hash === null && s.kept !== null
      ? (await doors.builder.commitments({ vault, coin: s.kept })).output : null;
    let unchecked: string | undefined;
    const confirmed = await until(doors, async () => {
      if (byItsOwn) {
        const own = await ownPaymentOnChain(doors, vault, inFlight);
        if (own.of === 'landed') return { state: 'landed' as const, createdIn: own.transactionHash };
        if (own.of === 'refused') return { state: 'refused' as const, transactionHash: own.transactionHash };
        if (own.of === 'cannot' || own.of === 'not-known') unchecked = own.why;
        /*
         * Not seen yet. Its note leaving says nothing of this payment, but a step the journal names that spent it
         * first and landed says this one never can - asked as settling asks it. Only a view that read the vault's
         * notes can say the note has left: an unreadable one says nothing.
         */
        const now = await notesAsThisDeviceReadsThem(doors, vault).catch(() => null);
        if (now === null || now.onChain !== true || !Array.isArray(now.notes)) return null;
        if (now.notes.some((n) => n.toLowerCase() === heldSpent)) return null;
        try {
          const onChain = new Set<string>(now.notes.map((n: string) => lowerOf(n)));
          if (await recordedIfOvertaken(doors, vault, inFlight, onChain, paymentLandsBy(first), false, now.state)) {
            return { state: 'overtaken' as const };
          }
        } catch (e) {
          /* The step that spent it landed and its coin's transfer cannot be read yet: ask again. */
          if (e instanceof PaymentStillInFlight) return null;
          throw e;
        }
        return null;
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
        sendFailed ?? (byItsOwn || hash !== null ? unchecked : 'the service could not name the transaction it sent'));
    }
    if (confirmed.state === 'refused') {
      await doors.inFlight.forget(vault, claim).catch(() => { /* the next step settles it, and finds it refused */ });
      throw new PaymentRefusedOnChain(vault, confirmed.transactionHash);
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
    return { txRef: sent.txRef, hash: byItsOwn ? createdIn : hash, createdIn };
  } catch (e) {
    if (e instanceof PaymentNotYetSeen || e instanceof PaymentNotAsBuilt || e instanceof PaymentLandedUnrecorded
      || e instanceof MergeNotYetSeen || e instanceof MergeNotAsBuilt || e instanceof MergeLandedUnrecorded
      || e instanceof StepOvertaken || e instanceof PaymentRefusedOnChain) throw e;
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
 * **THE POOL IS ADVANCED ONLY ON THIS PAYMENT'S OWN TRANSACTION.** Two payments
 * out of one note for one amount make the same change coin, so what the vault
 * holds cannot say which of them landed; the transaction's own events can. The
 * change is recorded under that transaction, and under nothing else. A payment
 * that keeps no change is recorded only once the chain shows its own
 * transaction, by the identifiers read from it before the send, take effect.
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
   * judged to pay a person, or, for a payment that kept no change, when the
   * chain showed its own transaction take effect; `by-what-it-left` when the
   * send named none and the payment was found by its change. The vault's record
   * is right either way, but another payment of the same amount out of the same
   * note leaves exactly the same change, so only the run, read from the
   * company's account, says whether this person was paid.
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

  doors.progress?.(A_PAYMENT.writing);
  await writtenDown(doors, vault, chosen, 'payment', payment.amount);
  const sent = await sendAStepOut(doors, vault, {
    notes: chosen, amount: payment.amount, kept: built.change, merge: false, tx: built.tx,
    send: (v, tx) => handedOver(doors.handOver, {
      tx, call: { kind: 'payout', contract: v, circuit: 'payout', account: doors.account },
      viaService: () => doors.service.payout(v, tx), after: async () => NAMED_BY_NOTHING,
    }), words: A_PAYMENT,
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
 * and needs no approval; it is built on what this device read at the indexer
 * the wallet names, written down once built and before it is sent, relayed by the service as
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

  doors.progress?.(A_MERGE.writing);
  await writtenDown(doors, vault, notes, 'merge', '0');
  const sent = await sendAStepOut(doors, vault, {
    notes, amount: '0', kept: built.kept, merge: true, tx: built.tx,
    send: (v, tx) => handedOver(doors.handOver, {
      tx, call: { kind: 'merge', contract: v, circuit: 'merge', account: doors.account },
      viaService: () => doors.service.merge(v, tx), after: async () => NAMED_BY_NOTHING,
    }), words: A_MERGE,
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
  /** Where the payout goes: through the service (the default), or straight to the chain from the person's wallet. */
  readonly handOver?: HandOver;
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
    const tx = built.tx;
    sent = await handedOver(doors.handOver, {
      tx, call: { kind: 'public-payout', contract: vault, circuit: 'payoutUnshielded', account: doors.account },
      viaService: () => doors.service.payoutPublicly(vault, tx), after: async () => NAMED_BY_NOTHING,
    });
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
    /*
     * For a check that files nothing and keeps no deposit of its own, the newest deposit filed for the vault: not reached
     * it and can still until `until`; past that and never reached it; or in the vault and named by no record yet.
     */
    | { readonly state: 'journalled-not-seen'; readonly until: number }
    | { readonly state: 'journalled-never-landed' }
    | { readonly state: 'journalled-not-recorded' };
  /**
   * For a check that files nothing: every other deposit the vault's deposit journal names that can still land and is
   * not in the vault's record, oldest first. Empty when there is none.
   */
  readonly alsoJournalled?: readonly JournalledDeposit[];
  /** Notes in the vault's record that did not name the transaction that made them, and now do. */
  readonly named: number;
  /** Notes in the vault's record that still do not, because the chain cannot say yet. */
  readonly unnamed: number;
  /** For a check that files nothing: notes the chain can name and that are left for a signer's wallet to name. */
  readonly toName?: number;
  /** The deposit the check judged, as the check read it; absent when it found none to judge. */
  readonly checked?: DepositChecked;
}

/** One more deposit the vault's deposit journal names, as the check found it, and the coin it carries. */
export interface JournalledDeposit {
  readonly state: 'journalled-not-seen' | 'landed-owed-its-record' | 'journalled-not-recorded';
  /** When it can no longer land. */
  readonly until: number;
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
interface WhatThisBrowserSent extends WhatThisBrowserDeposited {
  /** `unread` on a payment held because the chain could not be read: no time lets it go. */
  readonly payment: PaymentSettled | { readonly state: 'still-on-its-way'; readonly until: number; readonly unread?: true };
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
 * Says too which deposit it judged and what it was (`checked`). A check that
 * files nothing also reads the vault's deposit journal (`journalledForARead`):
 * its newest deposit when this browser keeps none, and every other one that can
 * still land.
 */
async function depositSettledForACheck(
  doors: DepositDoors, vault: Hex, view: VaultChainView, files = true,
): Promise<Pick<WhatThisBrowserDeposited, 'deposit' | 'checked' | 'alsoJournalled'>> {
  /* The coin this browser kept, read before settling it lets it go, so the check can say what it judged. */
  const kept = await doors.inFlight.get(vault);
  const ofThisBrowser = checkedOf('this-browser', kept === null ? null : kept.coin);
  const journal = files ? null : await journalledForARead(doors, vault, view, kept === null ? null : kept.coin.nonce);
  /* With a deposit of its own judged first, the journal's newest is one more to say, after the older ones. */
  const also = journal === null ? {} : { alsoJournalled: journal.also };
  const alsoWithNewest = journal === null ? {} : { alsoJournalled: [...journal.also, ...journal.newestAsAlso] };
  try {
    const settled = await settleDepositInFlight(doors, vault, view, files);
    /* A deposit this browser kept from before deposits moved into the wallet is said owed once, and then let go: the journal still names it. */
    if (!files && settled.state === 'landed-owed-its-record') {
      const d = await doors.inFlight.get(vault);
      if (d !== null) await letGo(doors, vault, d.claim);
    }
    if (settled.state === 'none' && journal !== null) return { ...journal.newest, ...also };
    return { deposit: settled, ...(settled.state === 'none' ? {} : ofThisBrowser), ...alsoWithNewest };
  } catch (e) {
    if (e instanceof DepositStillInFlight) return { deposit: { state: 'still-on-its-way', until: e.until }, ...ofThisBrowser, ...alsoWithNewest };
    if (e instanceof DepositLandedNotYetRecorded) return { deposit: { state: 'landed-not-recorded' }, ...ofThisBrowser, ...alsoWithNewest };
    throw e;
  }
}

/**
 * **THE DEPOSITS THE VAULT'S DEPOSIT JOURNAL NAMES, AS A READ JUDGES THEM**, for a check that files nothing (the
 * wallet keeps the deposits it makes, and files each coin in the journal before its deposit is sent). Each coin is
 * judged by `depositAsTheChainShows`, against the chain and the vault's record:
 *
 *   · `newest`: the last line not marked ended (a deposit never handed over to be sent), whatever its age, so a deposit that landed and is owed its record is never missed. In
 *     the record: recorded. Held and not in the record: owed its record. Gone after a record named it: landed and since
 *     left. Made and never named: in the vault and not yet recorded. Not made: on its way until
 *     `journalledDepositLandsBy` of its line, and past that, never landed;
 *   · `also`: every other line that can still land, oldest first, that is not on its way from this browser
 *     (`keptHere`) and not yet in the vault's record;
 *   · `newestAsAlso`: the newest line said the same way, for a check that judged a deposit of this browser's first. A line past its window is dropped before anything is read for
 *     it: it can no longer land, and judging it would cost a read for every deposit the vault ever took.
 *
 * A journal this signer cannot open, or none, is nothing to say.
 */
async function journalledForARead(
  doors: DepositDoors, vault: Hex, view: VaultChainView, keptHere: string | null,
): Promise<{
  newest: Pick<WhatThisBrowserDeposited, 'deposit' | 'checked'>; also: readonly JournalledDeposit[]; newestAsAlso: readonly JournalledDeposit[];
}> {
  const none = { newest: { deposit: { state: 'none' as const } }, also: [], newestAsAlso: [] };
  const rec = await doors.records('deposit-journal').get(vault);
  if (rec === null) return none;
  let lines: Array<{ nonce?: unknown; token?: unknown; value?: unknown; attemptedAt?: unknown; ended?: unknown }>;
  try {
    lines = (openPool(rec, doors.me.signerId, doors.me.wrappingSecret, { record: 'deposit-journal' }) as { notes?: typeof lines }).notes ?? [];
  } catch {
    return none;
  }
  /* A line its own device marked ended was never handed over to be sent: it cannot land, and is not read as on its way. */
  lines = lines.filter((l) => l?.ended !== true);
  const now = (doors.clock ?? Date.now)();
  const coinOf = (l: (typeof lines)[number]) => (typeof l.nonce === 'string' && typeof l.token === 'string'
    ? { nonce: l.nonce, token: l.token, value: String(l.value) } : null);
  const last = lines[lines.length - 1];
  const newestCoin = last === undefined ? null : coinOf(last);
  let newest: Pick<WhatThisBrowserDeposited, 'deposit' | 'checked'> = none.newest;
  let newestAsAlso: JournalledDeposit[] = [];
  if (newestCoin !== null && (keptHere === null || keptHere.toLowerCase() !== newestCoin.nonce.toLowerCase())) {
    const until = journalledDepositLandsBy(last!.attemptedAt);
    const { is } = await depositAsTheChainShows(doors, vault, newestCoin, view);
    const deposit: WhatThisBrowserDeposited['deposit'] = is === 'recorded' ? { state: 'already-recorded' }
      : is === 'held' ? { state: 'landed-owed-its-record' }
      : is === 'spent' ? { state: 'landed-and-since-spent' }
      : is === 'made-unnamed' ? { state: 'journalled-not-recorded' }
      : now < until ? { state: 'journalled-not-seen', until } : { state: 'journalled-never-landed' };
    newest = { deposit, ...checkedOf('the-vaults-journal', newestCoin) };
    const state = deposit.state === 'journalled-not-seen' || deposit.state === 'journalled-not-recorded'
      || (deposit.state === 'landed-owed-its-record' && now < until) ? deposit.state : null;
    if (state !== null) newestAsAlso = [{ state, until, ...newest.checked === undefined ? {} : { checked: newest.checked } }];
  }
  const also: JournalledDeposit[] = [];
  const judged = new Set<string>(newestCoin === null ? [] : [newestCoin.nonce.toLowerCase()]);
  if (keptHere !== null) judged.add(keptHere.toLowerCase());
  for (const line of lines.slice(0, -1)) {
    const coin = coinOf(line);
    const until = journalledDepositLandsBy(line.attemptedAt);
    if (coin === null || !(now < until) || judged.has(coin.nonce.toLowerCase())) continue;
    judged.add(coin.nonce.toLowerCase());
    const { is } = await depositAsTheChainShows(doors, vault, coin, view);
    const state = is === 'unseen' ? 'journalled-not-seen' as const : is === 'held' ? 'landed-owed-its-record' as const
      : is === 'made-unnamed' ? 'journalled-not-recorded' as const : null;
    if (state !== null) also.push({ state, until, ...checkedOf('the-vaults-journal', coin) });
  }
  return { newest, also, newestAsAlso };
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
    if (e instanceof PaymentStillInFlight) payment = { state: 'still-on-its-way', until: e.until, ...(e.unread ? { unread: true as const } : {}) };
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
 * judged instead (`journalledForARead`), and every other journalled deposit
 * that can still land and is not in the vault's record is said too
 * (`alsoJournalled`). Which deposit was judged, and its token and value as the
 * check read them, is `checked`.
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
      + `${timeShown(d.until)}, it never will and no money moved. Do not put the same money in again.`);
  }
  if (d.state === 'journalled-not-seen') {
    said.push(`The newest deposit filed for this vault has not reached the vault yet. If it was sent, it can still arrive `
      + `until ${timeShown(d.until)}. If it has not arrived by then, it never will and no money moved. Do `
      + 'not put the same money in again.');
  }
  if (d.state === 'journalled-never-landed') {
    said.push('The newest deposit filed for this vault never reached the vault, and now it never will. No money moved.');
  }
  if (d.state === 'journalled-not-recorded') {
    said.push('The newest deposit filed for this vault is in the vault, and not yet in its record. Check again in a minute. '
      + 'Do not put the same money in again.');
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
  for (const e of found.alsoJournalled ?? []) {
    said.push(e.state === 'journalled-not-seen'
      ? `An earlier deposit filed for this vault has not reached the vault yet. If it was sent, it can still arrive until `
        + `${timeShown(e.until)}. If it has not arrived by then, it never will and no money moved.`
      : 'An earlier deposit filed for this vault is in the vault, and not yet in its record. It is not lost. Do not put '
        + 'the same money in again.');
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
    said.push(p.unread === true
      ? 'A payment this browser sent is not in the vault\'s record yet. The chain could not be read just now. This '
        + 'payment stays held, and no other payment leaves this vault from this browser, until it can be. Check again in '
        + 'a minute.'
      : `A payment this browser sent is not in the vault's record yet. If the chain has not shown it by `
        + `${timeShown(p.until)}, it never will. Until then, no other payment leaves this vault from this `
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

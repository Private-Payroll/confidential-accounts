import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHolders } from 'midnight-identity/profile/records-key';
import type { ApproverRoster } from '../../../src/core/vault-approvers.js';
import type { CoinsKeptHere } from './vault-coins-kept-here.js';
import type { DeviceRecords, DeviceSigner } from './deposit-on-device.js';
import type { DirectoryAsBelieved, SeatsAsTheWalletRead } from '../../../src/midnight/secret-readers.js';
import type { DirectoryRead } from './vault-page-doors.js';
import type { FirstSecretRunParts } from '../../../src/midnight/vault-start.js';
import type { FirstSecretShown } from 'midnight-identity/profile/request';
import type { GovernedCallService } from './governed-call-on-device.js';
import type { HandOver } from './hand-over.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { KeysHeld } from '../../../src/core/company-key.js';
import type { PoolSigner, SealedPool } from '../../../src/midnight/vault-pool.js';
import type { RecordsEntered } from './record-entered-here.js';
import type { RosterVaultKeys } from '../../../src/core/vault-keys.js';
import type { SignerMaterial } from './governed-call-builder.js';
import type { SecretRunOnTheWire, VaultBuilderClient } from './vault-worker-client.js';
import type { VaultInfoRecords } from './vault-info-here.js';
import type { VaultService } from './vault-service.js';

/**
 * **A VAULT'S COMPANY ACCOUNT, AS THE SIGNER'S OWN WALLET READ IT OFF THE CHAIN
 * FOR THIS STEP**: who holds the account and which vaults it has adopted.
 * Asked afresh every time, with no press; never what the service reports.
 */
export interface VaultAsTheWalletRead {
  readonly holders: AccountHolders;
}

/** Where a step reads its vault's company account from the person's own wallet. */
export interface VaultOnChainDoors {
  readonly onChain: (vault: Hex) => Promise<VaultAsTheWalletRead>;
}

/** Where a step reads the vault itself: through this device's vault worker, at the indexer the person's own wallet names. */
export interface ChainHereDoors extends VaultOnChainDoors {
  /** The company's account, which a vault must be pinned to for money to go in or out of it. */
  readonly account: AccountAddress;
  readonly builder: Pick<VaultBuilderClient, 'vaultOnChain'>;
  /**
   * The indexer the person's own wallet reads the chain through, exactly as
   * the wallet said it; null when the wallet said none.
   */
  readonly indexer: () => Promise<{ readonly indexerUri: string; readonly indexerWsUri: string } | null>;
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
  /**
   * The chain's time, in milliseconds: the newest block's at the indexer the person's own wallet names. What says a
   * raise of the vault's adoption or first secret run, written down before, can no longer reach the chain, so its
   * record is withdrawn and the proposal raised afresh. A page without it never takes a raise for dead.
   */
  readonly chainTime?: () => Promise<number>;
  /** Where the vault's adoption and first secret run are written down as the company's proposals, and raised. */
  readonly proposals: VaultStartProposals;
  /**
   * Where the vault's name and description are filed, right after the deploy,
   * when the press gives them: the company's records through the one check.
   * The seat, keys and entry are the ones the proposals are filed with.
   */
  readonly vaultInfo?: VaultInfoRecords;
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
  /** `cancel` withdraws a record whose raise can no longer reach the chain, before another is raised in its place. */
  readonly service: Required<Pick<GovernedCallService, 'callState' | 'file' | 'send' | 'sealedProposals'>> & Pick<GovernedCallService, 'cancel'>;
  readonly directory: DirectoryRead;
  /** The company's keys, as this device holds them: each record is sealed under the one in force. */
  readonly companyKeys: KeysHeld;
  /** This seat's filing key: what the company's directory names the seat by, and what signs each record and relay. */
  readonly signingSecret: Hex;
  readonly entered: RecordsEntered;
  /**
   * Asks the service to write the vault's adoption, or with `run` its first secret run, down as carried out, for this
   * seat; it checks the proposal and the chain itself. `run` is the run's public parts, given only once its secret is set.
   */
  readonly carried?: (proposalId: string, body: { readonly vault: string; readonly filer: string; readonly run?: FirstSecretRunParts }) => Promise<unknown>;
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

export interface PoolDoors extends Pacing {
  readonly service: VaultService;
  /** Where each finished call goes: through the service (the default), or straight to the chain from the person's wallet. */
  readonly handOver?: HandOver;
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

/**
 * Where a device keeps a new vault's secret, sealed as it is filed, from before it is filed until the vault has started;
 * and, in a signer's wallet, each secret run's public copies tree (`RunKept`, never the secret), kept before the run
 * is raised or approved, so the copies can be written from that wallet whatever the service holds.
 */
export interface SecretKeptHere {
  keep(vault: Hex, filed: SealedPool): Promise<void>;
  held(vault: Hex): Promise<SealedPool | null>;
  drop(vault: Hex): Promise<void>;
  keepRun?(vault: Hex, run: RunKept): Promise<void>;
  runHeld?(vault: Hex, commitment: Hex): Promise<RunKept | null>;
  /** Every run of that commitment this wallet kept, oldest first: who each sealed the secret to. */
  runsHeld?(vault: Hex, commitment: Hex): Promise<readonly RunKept[]>;
}

/** A secret run's copies tree as a wallet keeps it: the vault, the commitment it sets, the commitment it replaces, and every sealed copy with its path. */
export type RunKept = Pick<SecretRunOnTheWire, 'vault' | 'commitment' | 'copies' | 'previous'>;

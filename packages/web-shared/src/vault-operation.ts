/**
 * **CREATING A COMPANY'S VAULT, OPENING ITS POOL, PUTTING MONEY IN IT AND
 * PAYING SOMEBODY OUT OF IT, FROM A SIGNER'S OWN DEVICE.**
 *
 * Each of the four is one operation a person starts with one press. Everything
 * it touches is handed in, so the same order runs in a test against the ledger's
 * own objects.
 *
 * ── CREATING A VAULT IS ONE OPERATION WITH NO SUCCESS STATE UNTIL THE END ──
 *
 *   1. the company's committee must already be complete: every signer's wallet
 *      has given its committee key. No committee, no deploy;
 *   2. the vault is built here with a temporary key made here, and the key is
 *      kept on this device BEFORE the deploy is sent, so an answer lost on the
 *      way does not lose the key;
 *   3. the deploy is sent;
 *   4. as soon as the chain has the vault, the handover to the committee is
 *      built against the counter the chain reports, signed with the temporary
 *      key, and sent - and sent again, rebuilt, if it does not land;
 *   5. once the chain says the committee holds the vault, the temporary key is
 *      forgotten and the vault is STARTED, each step raised only once the chain
 *      shows the one before:
 *        a. the company's account adopts it: the adoption round is raised,
 *           approved by this signer and carried out;
 *        b. its note pool and nonce secret are filed through the company's
 *           records route, and the secret is READ BACK and opened here;
 *        c. the first secret run is raised from what was read back, approved
 *           by this signer, and the secret set under it;
 *        d. every signer's sealed copy of the secret is written into the vault.
 *      The operation ends `started` when the chain shows every copy written.
 *
 * **ANYTHING SHORT OF THE END IS A FAILURE THAT NAMES THE VAULT**
 * (`VaultHandoverOwed` before the handover has landed, `VaultStartOwed` after),
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
import type { Hex } from '../../../src/core/crypto.js';
import type { Committee } from '../../../src/midnight/vault-committee.js';
import type { DepositMoney } from '../../../src/midnight/deposit-nonce.js';
import { SealedNotePool, isALostPoolRace, type PoolSigner, type SealedPool } from '../../../src/midnight/vault-pool.js';
import { afterDeposit } from '../../../src/midnight/vault-note-deposit.js';
import type { Note } from '../../../src/midnight/vault-notes.js';
import { PaymentJournalInStore } from '../../../src/midnight/vault-journal.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import type { EventOnTheWire, NoteOnTheWire } from './vault-builder.js';
import { openNonceSecrets, recordsKeypairFrom, type NonceSecretReader } from '../../../src/midnight/company-nonce-secret.js';
import { openSecretCopy, sealSecretCopy } from '../../../src/midnight/sealed-secret-copy.js';
import {
  READER_REFUSAL, readerRefusalOf, type ReaderRefusalCode, type SeatsAsTheWalletRead,
} from '../../../src/midnight/secret-readers.js';
import type { RosterVaultKeys } from '../../../src/core/vault-keys.js';
import { fromHex, toHex } from '../../../src/core/crypto.js';
import { NO_ASSET } from '../../../src/core/assets.js';
import type { GovernedCallOrder, OpenedRound, SignerMaterial } from './governed-call-builder.js';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import {
  depositCoinOnThisDevice, fileTheChainsSecretAsTheNewest, startVaultNonceSecretAgainOnThisDevice,
  startVaultNonceSecretOnThisDevice, type DeviceRecords, type DeviceSigner,
} from './deposit-on-device.js';
import type {
  CreatingTransactionAnswer, SecretRunOnTheWire, SigningKeyOnTheWire, StartStandingOnTheWire, VaultBuilderClient,
} from './vault-worker-client.js';
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
  constructor(readonly vault: Hex, why: string) {
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
    throw new VaultNotTheCompanys(vault, `your wallet could not say who holds this vault's company (${(e as Error)?.message ?? e}).`);
  }
  if (!read.holders.adoptedVaults.includes(String(vault).toLowerCase())) {
    throw new VaultNotTheCompanys(vault, 'this vault is not one your company\'s account has adopted, as your own wallet read the '
      + 'chain, so nothing is put into or paid from it.');
  }
  return read.holders;
}

/** What the service says the chain holds for one vault. */
export interface VaultChainView {
  readonly vault: Hex;
  readonly onChain: boolean;
  /** Base64 of the vault's contract state. */
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
  readonly heldByCommittee?: boolean;
  /**
   * Whether money may go in now: the vault held by the committee AND the
   * company account held by it too, since a vault pays out on the account's
   * approval.
   */
  readonly fundable?: boolean;
  readonly why?: string | null;
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
  chain(vault: Hex): Promise<VaultChainView>;
  deposit(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
  /**
   * Sends a public deposit into the vault, with the network fee paid for it.
   * `money` is what the page asked the vault to receive, and the service
   * refuses a deposit that is anything else.
   */
  depositPublicly?(vault: Hex, tx: string, money: { token: Hex; amount: string }): Promise<{ txRef: string; transactionHash: string | null }>;
  /**
   * One block's view of the vault and the company's account, for a payment out
   * to be built on. A deposit reads the ledger parameters from it too.
   */
  payoutState(vault: Hex): Promise<{
    vault: Hex; account: Hex; blockHash: string;
    vaultState: string; zswapState: string; parameters: string; accountState: string;
  }>;
  /** The chain's events for one transaction. */
  events(vault: Hex, transactionHash: string): Promise<{ events: EventOnTheWire[] }>;
  /**
   * The transaction in this vault's own history whose events carry an output
   * with this commitment, owned by this vault, and those events; `null` while
   * no transaction the chain lists does.
   */
  createdBy(vault: Hex, commitment: string): Promise<{ transactionHash: string; events: EventOnTheWire[] } | null>;
  payout(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
  /** Sends a public payment out of the vault, with the network fee paid for it. */
  payoutPublicly(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
  /**
   * **A STEP OF THE VAULT'S START ON THE COMPANY'S ACCOUNT**, proved on this
   * device: the adoption round or the first secret run raised or approved, or
   * the adoption carried out. Creating a vault needs these three.
   */
  startAccountCall?(vault: Hex, body: { tx: string; step: 'adoption' | 'secret-run'; call: 'propose' | 'approve' | 'adopt' }): Promise<StartStepSent>;
  /** The vault's first secret set under its approved run. */
  startSecret?(vault: Hex, tx: string): Promise<StartStepSent>;
  /** One signer's sealed copy of the secret written, by its place in the approved tree. */
  startCopy?(vault: Hex, tx: string, place: number): Promise<StartStepSent>;
}

/** Where this device keeps a vault's temporary key until the handover has landed. */
export interface TemporaryKeys {
  put(vault: Hex, key: SigningKeyOnTheWire): Promise<void>;
  get(vault: Hex): Promise<SigningKeyOnTheWire | null>;
  forget(vault: Hex): Promise<void>;
}

export type VaultStage =
  | 'checking the committee' | 'building the vault' | 'sending the vault'
  | 'waiting for the chain' | 'handing the vault to the committee' | 'waiting for the handover'
  | 'adopting the vault' | 'reading the secret back' | 'setting the secret' | 'writing the sealed copies'
  | 'waiting for approvals'
  | 'opening the pool' | 'choosing the coin' | 'building the deposit'
  | 'asking your wallet' | 'sending the deposit' | 'recording the deposit'
  | 'choosing the note' | 'reading the chain' | 'writing the payment down' | 'building the payment'
  | 'sending the payment' | 'waiting for the payment' | 'recording the payment' | 'done';

export interface Pacing {
  readonly sleep: (ms: number) => Promise<void>;
  /** How long to keep asking the chain for one thing to appear. */
  readonly waitMs?: number;
  readonly everyMs?: number;
  readonly progress?: (stage: VaultStage) => void;
}

/**
 * **THE HANDOVER HAS NOT LANDED.** Names the vault; the service will take no
 * money into it; running `createCompanyVault` again with `resume` finishes it.
 */
export class VaultHandoverOwed extends Error {
  constructor(readonly vault: Hex, why: string) {
    super(`the vault ${vault} was deployed and is not yet held by the company's committee: ${why} `
      + 'No money can be put into it until it is. Try again to finish handing it over.');
    this.name = 'VaultHandoverOwed';
  }
}

const sentNothing = (e: unknown): boolean => (e as { nothingWasSent?: unknown })?.nothingWasSent === true;

async function until<T>(
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
  readonly keys: TemporaryKeys;
  /** This signer's own three, from the keyring this device opened: the account's rounds are proved with them. */
  readonly material: SignerMaterial;
  /** What every key the vault's secret is sealed to is checked against, before this device raises or approves it. */
  readonly secretReaders: SecretReaderSources;
  /** The time now, in milliseconds. */
  readonly clock?: () => number;
}

/**
 * **WHAT A SECRET'S READERS ARE CHECKED AGAINST**, none of it the service's
 * word alone: the company's label and this signer's committee key as their own
 * wallet gave them, who holds the account and the vault as their own wallet
 * read them off the chain, and the roster this device opened, whose every
 * records key carries its signer's wallet's signature.
 */
export interface SecretReaderSources {
  readonly company: CompanyLabel;
  readonly committeeKey: { readonly tag: string; readonly value: string };
  /**
   * Who holds the company's account and `vault`, asked of this signer's own
   * wallet afresh every time a set of readers is checked, so no check rests on
   * a read made before a wait; null when the wallet read nothing.
   */
  readonly read: (vault: Hex) => Promise<SeatsAsTheWalletRead | null>;
  readonly roster: () => Promise<readonly RosterVaultKeys[]>;
}

/** Where the press ended: the vault started, or a round of its start waiting for other signers' approvals. */
export type VaultCreated =
  | { readonly vault: Hex; readonly state: 'started' }
  | {
    readonly vault: Hex; readonly state: 'awaiting-approvals';
    /** Which round waits, its identity, and how many approvals it has and needs. */
    readonly awaiting: {
      readonly round: 'adoption' | 'first-secret'; readonly proposal: Hex;
      readonly approvals: number; readonly needed: number;
    };
  };

/**
 * **THE VAULT WAS HANDED TO THE COMMITTEE AND ITS START IS NOT FINISHED.**
 * Names the vault and the step; the vault takes no money until it is started,
 * and running `createCompanyVault` again for it carries on from what the chain
 * shows. It holds nothing.
 */
export class VaultStartOwed extends Error {
  /** When the start stopped at the check of who its secret is sealed to: what kind of thing stopped it. */
  readonly stoppedAt?: ReaderRefusalCode;
  constructor(readonly vault: Hex, why: string, stoppedAt?: ReaderRefusalCode) {
    super(`Setting up this vault did not finish: ${why} `
      + 'This app puts no money into it until it is set up. Finish setting it up to carry on.');
    this.name = 'VaultStartOwed';
    if (stoppedAt !== undefined) this.stoppedAt = stoppedAt;
  }
}

/**
 * **STEPS 1 TO 5.** With `resume`, starts at step 4 for a vault this device
 * deployed and has not yet seen handed over, or at step 5 for one the
 * committee already holds.
 */
export async function createCompanyVault(
  doors: CreateVaultDoors, resume?: Hex,
): Promise<VaultCreated> {
  let vault = resume;
  if (vault === undefined) {
    doors.progress?.('checking the committee');
    const { committee, why } = await doors.service.keys();
    if (committee === null) throw new Error(why ?? 'this company has no committee yet, so no vault is created.');
    doors.progress?.('building the vault');
    const built = await doors.builder.deploy(doors.account);
    await doors.keys.put(built.vault as Hex, built.temporaryKey);
    doors.progress?.('sending the vault');
    try {
      vault = (await doors.service.deploy(built.tx)).vault;
    } catch (e) {
      if (sentNothing(e)) await doors.keys.forget(built.vault as Hex);
      else throw new VaultHandoverOwed(built.vault as Hex, `the deploy may have been sent (${(e as Error)?.message ?? e}).`);
      throw e;
    }
    /* The vault carried on is the one this device built and sent, never another address the service answers with. */
    if (String(vault).toLowerCase() !== String(built.vault).toLowerCase()) {
      throw new VaultHandoverOwed(built.vault as Hex, 'the service answered with another vault than the one this device sent, so '
        + 'nothing is carried on with that one.');
    }
  }
  await finishHandover(doors, vault);
  return startCompanyVault(doors, vault);
}

/**
 * **A READ OF THE CHAIN FOR A VAULT ALREADY SENT.** One that throws is the
 * vault not finished, naming it, and never a failure that loses which vault
 * was sent: the vault exists, or may, whatever the read said.
 */
async function chainOf(doors: CreateVaultDoors, vault: Hex): Promise<Awaited<ReturnType<VaultService['chain']>>> {
  try {
    return await doors.service.chain(vault);
  } catch (e) {
    throw new VaultHandoverOwed(vault, `the chain could not be read (${(e as Error)?.message ?? e}).`);
  }
}

async function finishHandover(doors: CreateVaultDoors, vault: Hex): Promise<{ vault: Hex; state: 'held-by-committee' }> {
  const HANDOVER_TRIES = 3;
  for (let attempt = 1; attempt <= HANDOVER_TRIES; attempt += 1) {
    doors.progress?.('waiting for the chain');
    const view = await until(doors, async () => {
      const v = await chainOf(doors, vault);
      return v.onChain ? v : null;
    });
    if (view === null) throw new VaultHandoverOwed(vault, 'the chain has not shown the vault yet.');
    if (view.heldByCommittee === true) {
      await doors.keys.forget(vault);
      return { vault, state: 'held-by-committee' };
    }
    const authority = view.authority;
    if (!authority || authority.shape !== 'one-key' || !view.committee) {
      throw new VaultHandoverOwed(vault, view.why ?? 'the chain shows an authority this device cannot hand over.');
    }
    const key = await doors.keys.get(vault);
    if (key === null) {
      throw new VaultHandoverOwed(vault,
        'the temporary key it was deployed with is not on this device, so only the device that deployed it '
        + 'can hand it over. It holds nothing; if that device is gone, create a new vault.');
    }
    doors.progress?.('handing the vault to the committee');
    const built = await doors.builder.handover({
      vault, counter: BigInt(authority.counter), temporaryKey: key, to: view.committee,
    });
    try {
      await doors.service.handover(vault, built.tx);
    } catch (e) {
      if (!sentNothing(e) || attempt === HANDOVER_TRIES) {
        throw new VaultHandoverOwed(vault, (e as Error)?.message ?? String(e));
      }
      continue;
    }
    doors.progress?.('waiting for the handover');
    const held = await until(doors, async () => ((await chainOf(doors, vault)).heldByCommittee === true ? true : null));
    if (held) {
      await doors.keys.forget(vault);
      return { vault, state: 'held-by-committee' };
    }
  }
  throw new VaultHandoverOwed(vault, 'the handover was sent and the chain has not shown it.');
}

/* ------------------------------------------------------------ starting a vault */

const ZERO_HEX = '00'.repeat(32);
const randomHex = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Where a vault's start stands now, read off both contracts at one block, with the chain it was read at. */
async function standingNow(
  doors: CreateVaultDoors, vault: Hex, secret?: SecretReadBack, window?: { opensAt: bigint; closesAt: bigint },
) {
  let chain: Awaited<ReturnType<VaultService['payoutState']>>;
  try {
    chain = await doors.service.payoutState(vault);
  } catch (e) {
    throw new VaultStartOwed(vault, `the chain could not be read for it (${(e as Error)?.message ?? e}).`);
  }
  const now = BigInt(Math.floor((doors.clock?.() ?? Date.now()) / 1000));
  const read = await doors.builder.startStanding({
    vault, account: chain.account, accountState: chain.accountState, vaultState: chain.vaultState, now: now.toString(),
    ...(secret === undefined ? {} : { secret: secret.secret, readers: secret.readers }),
    ...(window === undefined ? {} : { window: { opensAt: window.opensAt.toString(), closesAt: window.closesAt.toString() } }),
  });
  return { chain, now, standing: read.standing, run: read.run };
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
  seen: (now: Awaited<ReturnType<typeof standingNow>>) => boolean, secret?: SecretReadBack,
): Promise<Awaited<ReturnType<typeof standingNow>>> {
  const got = await until(doors, async () => {
    const now = await standingNow(doors, vault, secret);
    return seen(now) ? now : null;
  });
  if (got === null) throw new VaultStartOwed(vault, `${what} was sent and the chain has not shown it yet.`);
  return got;
}

/** The account's call state, from one block's view of both contracts. */
const callChainOf = (chain: Awaited<ReturnType<VaultService['payoutState']>>) =>
  ({ blockHash: chain.blockHash, accountState: chain.accountState, parameters: chain.parameters });

/** The account's half of a raise that moves no money: no asset, no amount, no payments, a blinding nobody keeps. */
const nothingMoves = (asset: string, salt: string) => ({
  assetId: asset, assetBlinding: randomHex(), proposalSalt: salt, changeAmount: '0', changeBatchDigest: ZERO_HEX,
});

/** Builds one of the start's calls on the account here and sends it. */
async function accountStep(
  doors: CreateVaultDoors, vault: Hex, chain: Awaited<ReturnType<VaultService['payoutState']>>,
  step: 'adoption' | 'secret-run', order: GovernedCallOrder, opened: OpenedRound, what: string,
): Promise<'sent' | 'already-approved'> {
  let tx: string;
  try {
    ({ tx } = await doors.builder.governedCall({ account: chain.account, order, material: doors.material, chain: callChainOf(chain), opened }));
  } catch (e) {
    const why = (e as Error)?.message ?? String(e);
    /* The account's own refusal of a second approval from this signer: this signer's approval is already counted. */
    if (order.circuit === 'approve' && /you have already approved this proposal/u.test(why)) return 'already-approved';
    throw new VaultStartOwed(vault, `${what} could not be built on this device (${why}). Nothing was sent.`);
  }
  await sent(vault, what, () => startDoorsOf(doors, vault).accountCall(vault, { tx, step, call: order.circuit as 'propose' | 'approve' | 'adopt' }));
  return 'sent';
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
  let at = await standingNow(doors, vault);
  if (!at.standing.adopted) {
    const a = at.standing.adoption;
    const governance = { kind: 'adopt-vault', vault } as const;
    const opened: OpenedRound = {
      chainId: a.proposal, digest: a.payload, vault: a.named, salt: a.salt,
      summary: 'Add a new vault to the company', governance,
    };
    if (a.stale) {
      throw new VaultStartOwed(vault, 'a signer left the company after its adoption was raised, so that round can no '
        + 'longer be carried out. Create a new vault instead; this one holds nothing.');
    }
    if (!a.open) {
      await accountStep(doors, vault, at.chain, 'adoption', {
        circuit: 'propose', adoption: governance, half: nothingMoves(noAsset, a.salt), proposal: a.proposal,
      }, { ...opened, half: { assetId: noAsset, changeAmount: '0', changeBatchDigest: ZERO_HEX } }, 'raising its adoption');
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
        return { vault, state: 'awaiting-approvals', awaiting: { round: 'adoption', proposal: a.proposal as Hex, approvals: now.approvals, needed: now.needed } };
      }
      await accountStep(doors, vault, at.chain, 'adoption',
        { circuit: 'adopt', vault, proposal: a.proposal, proposalSalt: a.salt }, opened, 'adopting it');
      await untilTheChainShows(doors, vault, 'adopting it', (n) => n.standing.adopted);
    }
  }

  /* ---- b. the pool and the nonce secret: made here, or read back and held to the chain ---- */
  /* From here on the vault must be one the account itself has adopted, as the wallet reads it: never the service's row. */
  await asTheWalletReadIt(doors, vault);
  const checked = (filedTo: readonly Hex[]) => everyReaderChecksOut(doors, vault, filedTo);
  let secret = await openCompanyVaultPool(doors, vault, checked);
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
      + 'copies would be missing. Nothing was sent.');
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
      + 'first secret is not set again. Nothing was sent.');
  }
  if (!at.standing.secret.set) {
    thisSignersCopyOpens(doors, vault, secret, run, readers);
    await everyReaderChecksOut(doors, vault, run.copies.map((c) => String(c.reader)));
    let found = at.standing.secret.run;
    if (found === null || !found.inWindow) {
      if (!secret.madeHere) {
        throw new VaultStartOwed(vault, 'its first secret run would be raised with a secret read back from the company\'s '
          + 'records, which nothing on the chain vouches for. Nothing was sent.');
      }
      const now = at.now;
      const window = { opensAt: now - 600n, closesAt: now + 14n * 24n * 3_600n };
      const fresh = await standingNow(doors, vault, secret, window);
      const raise = fresh.standing.secret?.raise;
      if (raise === undefined) throw new VaultStartOwed(vault, 'its first secret run could not be made.');
      await stillTheNewestFiled(doors, vault, secret, 'its first secret run');
      await accountStep(doors, vault, fresh.chain, 'secret-run', {
        circuit: 'propose',
        run: { root: run.root, payees: run.payees, opensAt: raise.opensAt, closesAt: raise.closesAt, vault, required: '0' },
        half: nothingMoves(run.asset, raise.salt), proposal: raise.proposal,
      }, {
        chainId: raise.proposal, digest: raise.payload, vault: raise.named, salt: raise.salt,
        summary: 'Finish setting up a new vault',
        half: { assetId: run.asset, changeAmount: '0', changeBatchDigest: ZERO_HEX },
      }, 'raising its first secret');
      at = await untilTheChainShows(doors, vault, 'raising its first secret',
        (n) => n.standing.secret?.run?.proposal === raise.proposal || n.standing.secret?.set === true, secret);
      found = at.standing.secret!.run;
    }
    if (!at.standing.secret!.set && found !== null && found.approvals < found.needed) {
      const before = found.approvals;
      const approved = await accountStep(doors, vault, at.chain, 'secret-run', { circuit: 'approve', proposal: found.proposal }, {
        chainId: found.proposal, digest: found.payload, vault: found.named, salt: found.salt,
        summary: 'Finish setting up a new vault',
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
        return { vault, state: 'awaiting-approvals', awaiting: { round: 'first-secret', proposal: found.proposal as Hex, approvals: found.approvals, needed: found.needed } };
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
  doors.progress?.('done');
  return { vault, state: 'started' };
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
 * APPROVES IT** (`secret-readers.ts`): signed by its signer's own wallet with a
 * key the chain lists on the company's committee, one per signer seated now,
 * none missing and none extra, and the vault held by that committee and pinned
 * to the company's account, as the same wallet read the vault. It runs on the
 * keys the service names, before a nonce secret is filed and wrapped to them,
 * and on the keys the run itself holds, before it is raised or approved, not a
 * list beside it; each time with a read of its own.
 */
async function everyReaderChecksOut(doors: CreateVaultDoors, vault: Hex, readers: readonly string[]): Promise<void> {
  const sources = doors.secretReaders;
  /* Asked afresh for this check alone: who holds the account and this vault, as this signer's own wallet reads them now. */
  let seats: SeatsAsTheWalletRead | null;
  try {
    seats = await sources.read(vault);
  } catch (e) {
    throw new VaultStartOwed(vault, `your wallet did not say who holds the company and this vault (${(e as Error)?.message ?? e}). `
      + 'Nothing was approved.', READER_REFUSAL.walletReadNothing);
  }
  let roster: readonly RosterVaultKeys[];
  try {
    roster = await sources.roster();
  } catch (e) {
    throw new VaultStartOwed(vault, `who its secret is sealed to could not be checked (${(e as Error)?.message ?? e}). Nothing was approved.`);
  }
  const refused = readerRefusalOf({
    company: sources.company, readers, roster, seats, mine: sources.committeeKey, vault, account: doors.account,
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
  readonly me: DeviceSigner;
  /** This device's own records key, so it is not wrapped to twice. */
  readonly myRecordsKey: Hex;
  readonly signers: () => Promise<readonly PoolSigner[]>;
  readonly records: DeviceRecords;
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
async function readTheSecretBack(doors: Pick<PoolDoors, 'me' | 'records'>, vault: Hex): Promise<SecretReadBack> {
  const back = await doors.records('nonce-secret').get(vault);
  if (back === null) {
    throw new Error('the company\'s records hold no nonce secret for this vault, so nothing is built from one. File it '
      + 'first: creating the vault again does.');
  }
  return openedHere(doors, vault, back, false);
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
  const view = await doors.service.chain(vault);
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
 * ROUTE**. Only for a vault its committee holds and the chain has never paid
 * into. Each half is skipped when it is already filed, so it can be run again.
 * A secret made here is handed back as made here, opened from the record this
 * device made; one already filed is read back and handed back as that.
 * `beforeFiling` is handed the keys a new nonce secret would be wrapped to,
 * before anything is wrapped, and stops the filing by throwing; there is no
 * filing without it.
 */
export async function openCompanyVaultPool(
  doors: PoolDoors, vault: Hex, beforeFiling: (readers: readonly Hex[]) => Promise<void>,
): Promise<SecretReadBack> {
  doors.progress?.('opening the pool');
  const view = await doors.service.chain(vault);
  if (!view.onChain || view.heldByCommittee !== true) {
    throw new Error(view.why ?? 'this vault is not held by the company\'s committee yet, so its pool is not opened.');
  }
  const everCreated = new Set(view.everCreated ?? []);
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  /*
   * The keys a new nonce secret would be wrapped to are checked before either half is filed: the service files
   * nothing for an account its own committee does not hold, and that check says so in words a person can act on.
   */
  const secretOwed = await doors.records('nonce-secret').get(vault) === null;
  const readers = secretOwed ? (await doors.service.keys()).readers : [];
  if (secretOwed) await beforeFiling(readers);
  if (await doors.records('pool').get(vault) === null) {
    if ((view.notes ?? []).length > 0 || everCreated.size > 0) {
      throw new Error('the chain has already put money in this vault and it has no pool, so a new empty pool '
        + 'would record nothing of it. Nothing is filed; rebuild the pool from the company\'s records instead.');
    }
    await pool.create(vault, { notes: [] });
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
  doors: { readonly service: VaultService; readonly builder: VaultBuilderClient },
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
  const named = transactionHash === null ? null : transactionHash.toLowerCase();
  let byName: CreatingTransactionFound | null = null;
  if (named !== null && HEX64.test(named)) {
    try {
      byName = await judge(named, (await doors.service.events(vault, named)).events);
    } catch {
      byName = { state: 'not-yet' };
    }
    if (byName.state === 'found') return byName;
  }
  let byOutput: CreatingTransactionFound;
  try {
    const found = await doors.service.createdBy(vault, output);
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
  await letGo(doors, vault, d.claim);
  return { note, ...(found.state === 'unknown' ? { notYetSpendable: found.why } : {}) };
}

/**
 * **WHAT BECAME OF A DEPOSIT THIS BROWSER SENT AND HAS NOT YET SEEN ARRIVE.**
 *
 *   · the vault's record already holds its nonce (this browser or another
 *     signer recorded it): nothing to record, and it is forgotten;
 *   · the vault's notes hold its coin: the note is recorded, under the
 *     transaction the chain says created it; once its time to live has
 *     passed, without that transaction if it still cannot be read;
 *   · the chain made it and the vault's notes, read a moment apart, do not
 *     show it: it has arrived and is not recorded yet, so it is kept;
 *   · its time to live has passed and the chain never made it: it never will,
 *     and it is forgotten;
 *   · otherwise it can still arrive, and `DepositStillInFlight` says so.
 *
 * Nothing is recorded that the vault's notes do not hold.
 */
export async function settleDepositInFlight(
  doors: DepositDoors, vault: Hex, view?: VaultChainView,
): Promise<{ state: 'none' | 'never-landed' | 'already-recorded' } | ({ state: 'recorded' } & DepositRecorded)> {
  const d = await doors.inFlight.get(vault);
  if (d === null) return { state: 'none' };
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  if ((await pool.load(vault)).notes.some((n) => n.nonce.toLowerCase() === d.coin.nonce.toLowerCase())) {
    await letGo(doors, vault, d.claim);
    return { state: 'already-recorded' };
  }
  const seen = view ?? await doors.service.chain(vault);
  const { output, held } = await doors.builder.commitments({ vault, coin: d.coin });
  const until = d.recordedAt + DEPOSIT_TIME_TO_LIVE_MS;
  const past = (doors.clock ?? Date.now)() > until;
  if ((seen.notes ?? []).some((n) => n.toLowerCase() === held.toLowerCase())) {
    return { state: 'recorded', ...await recordLandedDeposit(doors, vault, d, output, { waiting: false, giveUp: past }) };
  }
  const bare = (h: string) => h.toLowerCase().replace(/^0x/u, '');
  if ((seen.everCreated ?? []).some((c) => bare(c) === bare(output))) {
    throw new DepositLandedNotYetRecorded(vault, d.txRef);
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
async function chainParametersForADeposit(doors: { readonly service: VaultService }, vault: Hex): Promise<string> {
  const notRead = () => new Error('the chain\'s current parameters could not be read for this vault, so no '
    + 'coin was chosen and nothing was built or sent. Try again shortly.');
  let at: Awaited<ReturnType<VaultService['payoutState']>>;
  try {
    at = await doors.service.payoutState(vault);
  } catch {
    throw notRead();
  }
  const answeredWrongly = (why: string) => new Error('the service answered with something other than this vault\'s '
    + `current parameters (${why}), so no coin was chosen and nothing was built or sent. Try again; if this happens `
    + 'again, the service needs attention.');
  if (String(at?.vault).toLowerCase() !== vault.toLowerCase() || typeof at.parameters !== 'string' || at.parameters.length === 0) {
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

export async function depositIntoCompanyVault(
  doors: DepositDoors, vault: Hex, money: DepositMoney,
): Promise<{
  txRef: string; transactionHash: string | null;
  /** What became of an earlier deposit from this browser, settled before this one chose its coin. */
  earlier?: Awaited<ReturnType<typeof settleDepositInFlight>>;
} & DepositRecorded> {
  const view = await doors.service.chain(vault);
  if (!view.onChain || view.heldByCommittee !== true || view.state === undefined) {
    throw new Error(view.why ?? 'this vault is not held by the company\'s committee, so no money goes in.');
  }
  /* Asked before a coin is chosen or the wallet is asked, so a deposit the service will refuse books nothing. */
  if (view.fundable !== true) {
    throw new Error(view.why ?? 'this company\'s account is not held by its committee yet, so no money goes in.');
  }
  /* The vault is one the company's account adopted, as this signer's own wallet reads the chain. */
  await theVaultAsItsSignersHoldIt(doors, vault);
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
  const { output, held } = await commitments(coin);
  const seen = await until(doors, async () => {
    const v = await doors.service.chain(vault);
    return (v.notes ?? []).some((n) => n.toLowerCase() === held.toLowerCase()) ? true : null;
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
 * **A PUBLIC DEPOSIT MAY HAVE BEEN SENT, AND THIS PAGE WAS NOT TOLD IT WAS.** The
 * money may have moved. Raised for every failure after the service began
 * sending, so no screen reads it as a deposit that did not happen.
 */
export class PublicDepositNotYetSeen extends Error {
  constructor(readonly vault: Hex, readonly until: number) {
    super('the public deposit may have been sent, and this page was not told whether it arrived. Do not put the same '
      + `money in again before ${new Date(until).toLocaleTimeString()}. If it has not arrived by then, it never will. `
      + 'Open your wallet: if its public balance has dropped by this amount and you spent nothing else from it, the '
      + 'vault has it. "Check my last deposit" finds only private deposits, so it cannot tell you about this one.');
    this.name = 'PublicDepositNotYetSeen';
  }
}

export interface PublicDepositDoors extends Pacing {
  readonly service: VaultService;
  readonly builder: VaultBuilderClient;
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  readonly onChain: VaultOnChainDoors['onChain'];
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
 *   1. the vault and the company's account must be held by the committee, as
 *      for a private deposit, and the chain's parameters are read the same way;
 *   2. the deposit is built and proved in the vault worker, which refuses one
 *      that would ask for anything but this token and this amount;
 *   3. the signer's own wallet pays the public amount and signs, after showing
 *      the token, the amount, and that both are public;
 *   4. the wallet's answer must name exactly this token and this amount leaving
 *      it, or nothing is sent;
 *   5. the service adds the network fee and sends it, and refuses one that is
 *      not exactly this vault's public deposit of this token and this amount.
 *
 * **WHY NOTHING FOLLOWS IT UP ON THIS DEVICE.** A private deposit is kept here
 * until the chain holds it because its coin was chosen here and its note must
 * be recorded, and a second deposit must not choose the same coin. A public
 * deposit has none of those: the service answers once the chain has taken it,
 * and if that answer is lost there is nothing on this device to finish. The
 * wallet's public balance and the chain say whether it arrived.
 */
export async function depositPubliclyIntoCompanyVault(
  doors: PublicDepositDoors, vault: Hex, money: PublicDepositMoney,
): Promise<{ txRef: string; transactionHash: string | null; token: Hex; value: bigint }> {
  /* The token as the asset's row names it: 64 lowercase hex characters, compared and sent as it is. */
  if (typeof money.token !== 'string' || !HEX32_TOKEN.test(money.token)) {
    throw new Error('this is not a public token a vault can hold, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  if (typeof money.value !== 'bigint' || money.value <= 0n) throw new Error('an amount of nothing is not a deposit.');
  if (typeof doors.service.depositPublicly !== 'function') {
    throw new Error('this page cannot send a public deposit, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  const view = await doors.service.chain(vault);
  if (!view.onChain || view.heldByCommittee !== true || view.state === undefined) {
    throw new Error(view.why ?? 'this vault is not held by the company\'s committee, so no money goes in.');
  }
  /* Asked before the wallet is, so a deposit the service will refuse asks the wallet for nothing. */
  if (view.fundable !== true) {
    throw new Error(view.why ?? 'this company\'s account is not held by its committee yet, so no money goes in.');
  }
  await theVaultAsItsSignersHoldIt(doors, vault);
  const parameters = await chainParametersForADeposit(doors, vault);
  if (typeof doors.builder.publicDeposit !== 'function') {
    throw new Error('this page cannot build a public deposit, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
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
  const until = (doors.clock ?? Date.now)() + DEPOSIT_TIME_TO_LIVE_MS;
  let sent: { txRef: string; transactionHash: string | null };
  try {
    sent = await doors.service.depositPublicly(vault, paid.transaction, { token: money.token, amount: money.value.toString() });
  } catch (e) {
    if (!sentNothing(e)) throw new PublicDepositNotYetSeen(vault, until);
    const at = new Date(until).toLocaleTimeString();
    throw new Error(`the public deposit was not sent, so no money has moved yet. Your wallet already signed it, and `
      + `until ${at} anyone can still send it. If they do, the money goes into this vault and nowhere else. Do not put `
      + `the same money in again before ${at}, or the vault may receive it twice. The service said: `
      + `${(e as Error)?.message ?? String(e)}`);
  }
  doors.progress?.('done');
  return { txRef: sent.txRef, transactionHash: sent.transactionHash, token: money.token, value: money.value };
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
  readonly spent: { readonly nonce: Hex; readonly token: Hex; readonly value: string };
  readonly amount: string;
  /** What the payment gives back to the vault, or `null` when it spends the note exactly. */
  readonly change: NoteOnTheWire | null;
  /** When this was written, in milliseconds: after the payment was built and before it was sent. */
  readonly recordedAt: number;
  readonly txRef: string;
  readonly transactionHash: string | null;
}

/** One payment in flight per vault on this device, changed or forgotten only under the claim it was kept with. */
export type PaymentsInFlight = KeptOnThisDevice<PaymentInFlight>;

export interface PayoutDoors extends PoolDoors {
  readonly builder: VaultBuilderClient;
  readonly now?: () => Date;
  /** Where this device keeps a payment it has sent until the vault's record shows it. */
  readonly inFlight: PaymentsInFlight;
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
  | { readonly state: 'none' | 'already-recorded' | 'never-landed' | 'spent-elsewhere' | 'not-matched' }
  | { readonly state: 'recorded'; readonly createdIn: Hex | null };

/**
 * **THE VAULT'S RECORD ADVANCED FOR ONE PAYMENT: THE NOTE IT SPENT GONE, AND
 * ITS CHANGE ADDED UNDER THE TRANSACTION THAT MADE IT.** Against the record as
 * it stands at each attempt, so a note another writer added meanwhile is kept.
 */
async function recordPayment(
  doors: PayoutDoors, vault: Hex, spent: Hex, amount: string, change: NoteOnTheWire | null, createdIn: Hex | null,
): Promise<void> {
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  const ATTEMPTS = 5;
  for (let attempt = 1; ; attempt += 1) {
    const now = await pool.load(vault);
    if (!now.notes.some((n) => n.nonce.toLowerCase() === spent.toLowerCase())) return;
    const next = await doors.builder.afterPayment({ notes: now.notes.map(wireOf), spent, amount, change, createdIn });
    try {
      await pool.save(vault, { notes: next.map(noteOf) }, now.readAt);
      return;
    } catch (cause) {
      if (!isALostPoolRace(cause) || attempt === ATTEMPTS) throw cause;
    }
  }
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
  const seen = view ?? await doors.service.chain(vault);
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
  if (p.change === null) {
    await recordPayment(doors, vault, p.spent.nonce, p.amount, null, null);
    await forget();
    return { state: 'recorded', createdIn: null };
  }
  const { output } = await doors.builder.commitments({ vault, coin: p.change });
  const found = await creatingTransactionOfOutput(doors, vault, output, p.transactionHash, 'this payment\'s change');
  if (found.state === 'found') {
    await recordPayment(doors, vault, p.spent.nonce, p.amount, p.change, found.createdIn);
    await forget();
    return { state: 'recorded', createdIn: found.createdIn };
  }
  if (found.listed === 'none' && past) {
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
 * **ONE PERSON PAID PRIVATELY OUT OF THE COMPANY'S VAULT, AGAINST A ROUND THE
 * COMPANY APPROVED.** `order` and `payment` are what the service rebuilt from
 * that round; everything that opens a note stays on this device.
 *
 * **THE POOL IS ADVANCED ONLY ON THIS PAYMENT'S OWN EVENTS.** Two payments out of
 * one note for one amount make the same change coin, so what the vault holds
 * cannot say which of them landed; the transaction the service sent can. The
 * change is recorded under that transaction, and under nothing else.
 */
export async function payPrivatelyFromCompanyVault(
  doors: PayoutDoors,
  input: { readonly order: PrivatePaymentOrderOnTheWire; readonly payment: PrivatePaymentOnTheWire },
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
  doors.progress?.('opening the pool');
  const view = await doors.service.chain(vault);
  if (!view.onChain || view.heldByCommittee !== true) {
    throw new Error('this service does not read this vault as held by the company\'s committee, so its record is not '
      + `opened here and nothing is paid out of it. Nothing was sent.${view.why ? ` The service says: ${view.why}` : ''} `
      + 'Where the cause is that a signer joined or left, or the threshold changed, since the vault was handed over, '
      + 'the signers who hold it now sign the change in Settings, and payments out of it are made again once the chain '
      + 'shows it.');
  }
  /*
   * **AND THE WHOLE QUESTION THE SERVICE ASKS BEFORE IT SENDS, NOT HALF OF IT.**
   * The committee holding the vault is what opening the record waits on; the
   * service also refuses a payment out while the company's account is not
   * held by its committee, and it says so here, before the pool is opened, a
   * line is written or two minutes are spent proving a payment it would not
   * send.
   */
  if (view.fundable !== true) {
    throw new Error('No payment can be made out of this vault yet, so none was prepared or recorded. Nothing was '
      + `sent.${view.why ? ` Reason: ${view.why}` : ''}`);
  }
  /* The vault the service named is one the company's account adopted, as this signer's own wallet reads the chain. */
  await theVaultAsItsSignersHoldIt(doors, vault);
  /*
   * **AN EARLIER PAYMENT FROM THIS BROWSER IS SETTLED FIRST.** Recorded if it
   * has landed, forgotten if it never can; while it still can, no note is
   * chosen, because the record does not yet say which notes are left.
   */
  await settlePaymentInFlight(doors, vault, view);
  const me = { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret };
  const pool = new SealedNotePool(doors.records('pool'), me, doors.signers);
  const loaded = await pool.load(vault);

  doors.progress?.('choosing the note');
  const note = await doors.builder.chooseNote({
    notes: loaded.notes.map(wireOf), token: payment.token, amount: payment.amount,
  });
  if (note.createdIn === undefined) {
    throw new Error(`the vault's note that covers this payment does not record which transaction created it, so `
      + 'its place in the chain cannot be read and it cannot be spent yet. It is still the vault\'s. Nothing was sent.');
  }
  const heldOf = async (n: NoteOnTheWire) => (await doors.builder.commitments({
    vault, coin: { nonce: n.nonce, token: n.token, value: n.value },
  })).held.toLowerCase();
  /*
   * **A NOTE THE CHAIN NO LONGER HOLDS IS NOT SPENT AGAIN.** It means a payment
   * from it landed and this record does not show it yet - another device still
   * writing it down, or a tab closed while it waited. The vault's own check
   * would refuse the build anyway; stopping here says which case it is.
   */
  if (!new Set((view.notes ?? []).map((n) => n.toLowerCase())).has(await heldOf(note))) {
    throw new Error('the chain no longer holds the note this vault\'s record would spend for this payment: a payment '
      + 'from it has landed that this record does not show yet. Nothing was sent. If another signer is paying '
      + 'from this vault right now, try again in a minute. Otherwise this payment, and any other that would '
      + 'spend that note, waits until the vault\'s record is rebuilt from the company\'s records.');
  }

  doors.progress?.('reading the chain');
  const { events } = await doors.service.events(vault, note.createdIn);
  const chain = await doors.service.payoutState(vault);
  if (chain.vault.toLowerCase() !== vault) {
    throw new Error('the chain was read for a different vault, so nothing was built. Nothing was sent.');
  }

  /*
   * **THE VAULT'S SECRET, OPENED HERE BEFORE ANYTHING IS WRITTEN DOWN.** The
   * vault names the payee's coin and the change with it, and refuses one that
   * is not the secret it holds; a record this device cannot open stops the
   * payment before a line is written.
   */
  await theChainWins(doors, vault, chain.vaultState);
  const { secret } = await readTheSecretBack(doors, vault);
  if (!(await doors.builder.secretIsTheVaults({ vault, state: chain.vaultState, secret }))) {
    throw new Error('the secret the company\'s records hold for this vault is not the one the vault holds on the chain, so '
      + 'nothing was built from it. Nothing was sent; contact support.');
  }

  /*
   * **WRITTEN DOWN BEFORE ANYTHING IS PROVED, AND THIS MAY NOT MOVE BELOW THE
   * SEND.** The note and the amount fix the whole of the change; a journal that
   * refuses stops the payment with nothing spent.
   */
  doors.progress?.('writing the payment down');
  const journal = new PaymentJournalInStore(doors.records('payment-journal'), vault,
    { id: me.signerId, wrappingSecret: me.wrappingSecret }, doors.signers);
  const spending = note as unknown as NoteAsHex;
  await journal.record(vault, {
    spent: { nonce: spending.nonce, token: spending.token, value: BigInt(spending.value) },
    amount: BigInt(payment.amount),
    attemptedAt: new Date().toISOString(),
  });

  doors.progress?.('building the payment');
  const { payments: _all, ...round } = order;
  const built = await doors.builder.payout({
    vault, account: chain.account, order: round, payment, note, events, secret,
    chain: {
      blockHash: chain.blockHash, vaultState: chain.vaultState, zswapState: chain.zswapState,
      parameters: chain.parameters, accountState: chain.accountState,
    },
  });
  if (built.spent !== note.nonce) {
    throw new Error('the payment built spends a different note from the one chosen, so it was not sent. Nothing was sent.');
  }

  /*
   * **KEPT ON THIS DEVICE BEFORE IT IS SENT, AND THIS MAY NOT MOVE BELOW THE
   * SEND.** The change is known only from the build, and from the send on the
   * payment may land whatever happens to this page; this is what lets the
   * record be written once it does.
   */
  const first: PaymentInFlight = {
    spent: { nonce: spending.nonce, token: spending.token, value: spending.value }, amount: payment.amount,
    change: built.change, recordedAt: (doors.now ?? (() => new Date()))().getTime(), txRef: '', transactionHash: null,
  };
  const claim = await doors.inFlight.claim(vault, first);
  if (claim === null) throw new PaymentStartedElsewhere(vault);

  doors.progress?.('sending the payment');
  let sent: { txRef: string; transactionHash: string | null };
  let sendFailed: string | undefined;
  try {
    sent = await doors.service.payout(vault, built.tx);
  } catch (e) {
    if (sentNothing(e)) {
      await doors.inFlight.forget(vault, claim).catch(() => { /* the next payment settles it, and finds it never landed */ });
      throw e;
    }
    sendFailed = (e as Error)?.message ?? String(e);
    sent = { txRef: '', transactionHash: null };
  }

  /* ---- from here the money may have moved, and every failure says so ---- */
  try {
    await doors.inFlight.update(vault, claim, { ...first, txRef: sent.txRef, transactionHash: sent.transactionHash })
      .catch(() => { /* the record kept before still names the change, and the chain is asked by its commitment */ });
    const named = sent.transactionHash === null ? null : sent.transactionHash.toLowerCase();
    const hash = named !== null && HEX64.test(named) ? named : null;
    doors.progress?.('waiting for the payment');
    /*
     * **WITHOUT A NAME FROM THE SEND, THE PAYMENT IS FOUND BY WHAT IT LEFT.**
     * Its change by the change's own commitment, in this vault's history; a
     * payment that spent its note exactly, by the note leaving the vault.
     * Either way its own events, once found, are judged exactly as a named
     * transaction's are.
     */
    const heldSpent = hash === null && built.change === null ? await heldOf(note) : null;
    const changeOutput = hash === null && built.change !== null
      ? (await doors.builder.commitments({ vault, coin: built.change })).output : null;
    const confirmed = await until(doors, async () => {
      if (hash === null && heldSpent !== null) {
        /* Only a view that read the vault's notes can say the note has left: an unreadable one says nothing. */
        const now = await doors.service.chain(vault).catch(() => null);
        if (now === null || now.onChain !== true || !Array.isArray(now.notes)) return null;
        if (now.notes.some((n) => n.toLowerCase() === heldSpent)) return null;
        return { state: 'landed' as const, createdIn: null };
      }
      let own: { transactionHash: string; events: EventOnTheWire[] } | null;
      try {
        own = hash !== null
          ? { transactionHash: hash, events: (await doors.service.events(vault, hash)).events }
          : await doors.service.createdBy(vault, changeOutput!);
      } catch {
        /* The indexer does not hold it yet, or could not be asked: ask again. */
        return null;
      }
      if (own === null) return null;
      const answer = await doors.builder.confirmPayment({
        vault, transactionHash: String(own.transactionHash).toLowerCase(), change: built.change, events: own.events,
      });
      return answer.state === 'not-yet' ? null : answer;
    });
    if (confirmed === null) {
      throw new PaymentNotYetSeen(vault, sent.txRef,
        sendFailed ?? (hash === null ? 'the service could not name the transaction it sent' : undefined));
    }
    if (confirmed.state === 'not-as-built') throw new PaymentNotAsBuilt(vault, hash ?? '', confirmed.why);
    const createdIn = confirmed.createdIn === null ? null : confirmed.createdIn as Hex;

    doors.progress?.('recording the payment');
    try {
      await recordPayment(doors, vault, note.nonce as Hex, payment.amount, built.change, createdIn);
    } catch (cause) {
      throw new PaymentLandedUnrecorded(vault, createdIn ?? '', (cause as Error)?.message ?? String(cause));
    }
    await doors.inFlight.forget(vault, claim).catch(() => { /* the next payment finds it recorded and forgets it */ });
    doors.progress?.('done');
    /* A transaction found by what the payment left may be another payment's, so it is not named as this one's. */
    return {
      txRef: sent.txRef, transactionHash: hash === null ? '' : createdIn ?? '', spent: note.nonce as Hex, change: built.change,
      seenAs: hash === null ? 'by-what-it-left' : 'its-own-transaction',
    };
  } catch (e) {
    if (e instanceof PaymentNotYetSeen || e instanceof PaymentNotAsBuilt || e instanceof PaymentLandedUnrecorded) throw e;
    throw new PaymentNotYetSeen(vault, sent.txRef, (e as Error)?.message ?? String(e));
  }
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
  const view = await doors.service.chain(vault);
  if (!view.onChain || view.heldByCommittee !== true) {
    throw new Error('this service does not read this vault as held by the company\'s committee, so nothing is paid '
      + `out of it. Nothing was sent.${view.why ? ` The service says: ${view.why}` : ''}`);
  }
  if (view.fundable !== true) {
    throw new Error('No payment can be made out of this vault yet, so none was prepared or recorded. Nothing was '
      + `sent.${view.why ? ` Reason: ${view.why}` : ''}`);
  }
  await theVaultAsItsSignersHoldIt(doors, vault);
  const chain = await doors.service.payoutState(vault);
  if (chain.vault.toLowerCase() !== vault) {
    throw new Error('the chain was read for a different vault, so nothing was built. Nothing was sent.');
  }

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

/** What checking a vault from this browser found, each part said on the screen. */
export interface WhatThisBrowserSent {
  readonly deposit:
    | Awaited<ReturnType<typeof settleDepositInFlight>>
    | { readonly state: 'still-on-its-way'; readonly until: number }
    | { readonly state: 'landed-not-recorded' };
  readonly payment: PaymentSettled | { readonly state: 'still-on-its-way'; readonly until: number };
  /** Notes in the vault's record that did not name the transaction that made them, and now do. */
  readonly named: number;
  /** Notes in the vault's record that still do not, because the chain cannot say yet. */
  readonly unnamed: number;
}

/**
 * **EVERYTHING THIS BROWSER SENT TO ONE VAULT AND DID NOT SEE FINISH, LOOKED
 * FOR ON THE CHAIN AND RECORDED, WITHOUT SENDING ANYTHING NEW.**
 *
 *   1. a deposit kept on its way is settled, as the next deposit would settle
 *      it: recorded once the vault holds it, under the transaction that made
 *      it, found by its own output when the send named none;
 *   2. a payment kept on its way is settled, as the next payment would;
 *   3. every note in the vault's record that does not name the transaction
 *      that made it is looked for in the vault's history by its own output,
 *      and named once the vault worker has judged that transaction's events
 *      to show exactly this note, made for this vault. A note that cannot be
 *      named stays as it is, the vault's, and unspendable until it can be.
 *
 * Nothing is built, proved or sent, and nothing leaves this device but the
 * commitments the chain already published.
 */
export async function checkWhatThisBrowserSent(
  doors: DepositDoors & { readonly payments: PaymentsInFlight }, vault: Hex,
): Promise<WhatThisBrowserSent> {
  const view = await doors.service.chain(vault);
  if (!view.onChain) throw new Error(view.why ?? 'the chain does not show this vault, so there is nothing to check yet.');
  let deposit: WhatThisBrowserSent['deposit'];
  try {
    deposit = await settleDepositInFlight(doors, vault, view);
  } catch (e) {
    if (e instanceof DepositStillInFlight) deposit = { state: 'still-on-its-way', until: e.until };
    else if (e instanceof DepositLandedNotYetRecorded) deposit = { state: 'landed-not-recorded' };
    else throw e;
  }
  let payment: WhatThisBrowserSent['payment'];
  try {
    payment = await settlePaymentInFlight({
      ...doors, inFlight: doors.payments,
      ...(doors.clock === undefined ? {} : { now: () => new Date(doors.clock!()) }),
    }, vault, view);
  } catch (e) {
    if (e instanceof PaymentStillInFlight) payment = { state: 'still-on-its-way', until: e.until };
    else throw e;
  }
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  let named = 0;
  let unnamed = 0;
  for (const n of (await pool.load(vault)).notes.filter((x) => x.createdIn === undefined)) {
    const { output } = await doors.builder.commitments({ vault, coin: { nonce: n.nonce, token: n.token, value: n.value.toString() } });
    const found = await creatingTransactionOfOutput(doors, vault, output, null);
    if (found.state !== 'found') {
      unnamed += 1;
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
  return { deposit, payment, named, unnamed };
}

/** What a check found, in the words the vault screen shows. Only what is true of this check is said. */
export function sayWhatTheCheckFound(found: WhatThisBrowserSent): string {
  const said: string[] = [];
  const d = found.deposit;
  if (d.state === 'none') said.push('This browser has no deposit into this vault waiting to be seen.');
  if (d.state === 'already-recorded') said.push('Your last deposit from this browser is in the vault\'s record.');
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
  if (d.state === 'landed-not-recorded') {
    said.push('Your last deposit from this browser is in the vault, and this page cannot yet read the transfer that '
      + 'brought it in. Check again in a minute.');
  }
  const p = found.payment;
  if (p.state === 'recorded') {
    said.push('Money from a payment this browser sent has left the vault, and the vault\'s record now shows it. Open the '
      + 'run to see who was paid.');
  }
  if (p.state === 'never-landed') {
    said.push('A payment this browser sent never left the vault, and now it never will. No money moved. The run shows '
      + 'whether the person is still owed.');
  }
  if (p.state === 'spent-elsewhere') {
    said.push('A payment this browser sent never left the vault, because another payment used the same money. The '
      + 'person it was for was not paid by it. The run shows whether they are still owed.');
  }
  if (p.state === 'not-matched') {
    said.push('A payment this browser sent cannot be matched to what the chain shows. The run shows whether the person '
      + 'was paid. The vault\'s record has to be rebuilt from the company\'s records before the money it used is paid '
      + 'out again.');
  }
  if (p.state === 'still-on-its-way') {
    said.push(`A payment this browser sent is not in the vault's record yet. If the chain has not shown it by `
      + `${new Date(p.until).toLocaleString()}, it never will. Until then, no other payment leaves this vault from this `
      + 'browser. Check again in a minute.');
  }
  if (found.named > 0) {
    said.push(found.named === 1
      ? 'One amount in the vault can now be used for payments.'
      : `${found.named} amounts in the vault can now be used for payments.`);
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

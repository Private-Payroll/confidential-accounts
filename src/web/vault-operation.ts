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
 *   5. the operation ends when the chain says the committee holds the vault,
 *      and only then. The temporary key is then forgotten.
 *
 * **ANYTHING SHORT OF STEP 5 IS A FAILURE THAT NAMES THE VAULT** (`VaultHandoverOwed`),
 * and running the operation again for that vault picks up at step 4. The
 * service refuses any deposit into the vault until step 5 is true on the chain.
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
import type { Hex } from '../core/crypto.js';
import type { Committee } from '../midnight/vault-committee.js';
import type { DepositMoney } from '../midnight/deposit-nonce.js';
import { SealedNotePool, isALostPoolRace, type PoolSigner } from '../midnight/vault-pool.js';
import { afterDeposit } from '../midnight/vault-note-deposit.js';
import type { Note } from '../midnight/vault-notes.js';
import { PaymentJournalInStore } from '../midnight/vault-journal.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../midnight/private-payment-wire.js';
import type { EventOnTheWire, NoteOnTheWire } from './vault-builder.js';
import type { NonceSecretReader } from '../midnight/company-nonce-secret.js';
import {
  depositCoinOnThisDevice, startVaultNonceSecretOnThisDevice,
  type DeviceRecords, type DeviceSigner,
} from './deposit-on-device.js';
import type { CreatingTransactionAnswer, SigningKeyOnTheWire, VaultBuilderClient } from './vault-worker-client.js';
import type { Kept, KeptOnThisDevice } from './in-flight-on-this-device.js';

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

export interface CreateVaultDoors extends Pacing {
  readonly account: Hex;
  readonly service: VaultService;
  readonly builder: VaultBuilderClient;
  readonly keys: TemporaryKeys;
}

/**
 * **STEPS 1 TO 5.** With `resume`, starts at step 4 for a vault this device
 * deployed and has not yet seen handed over.
 */
export async function createCompanyVault(
  doors: CreateVaultDoors, resume?: Hex,
): Promise<{ vault: Hex; state: 'held-by-committee' }> {
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
  }
  return finishHandover(doors, vault);
}

async function finishHandover(doors: CreateVaultDoors, vault: Hex): Promise<{ vault: Hex; state: 'held-by-committee' }> {
  const HANDOVER_TRIES = 3;
  for (let attempt = 1; attempt <= HANDOVER_TRIES; attempt += 1) {
    doors.progress?.('waiting for the chain');
    const view = await until(doors, async () => {
      const v = await doors.service.chain(vault);
      return v.onChain ? v : null;
    });
    if (view === null) throw new VaultHandoverOwed(vault, 'the chain has not shown the vault yet.');
    if (view.heldByCommittee === true) {
      await doors.keys.forget(vault);
      doors.progress?.('done');
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
    const held = await until(doors, async () => ((await doors.service.chain(vault)).heldByCommittee === true ? true : null));
    if (held) {
      await doors.keys.forget(vault);
      doors.progress?.('done');
      return { vault, state: 'held-by-committee' };
    }
  }
  throw new VaultHandoverOwed(vault, 'the handover was sent and the chain has not shown it.');
}

export interface PoolDoors extends Pacing {
  readonly service: VaultService;
  readonly me: DeviceSigner;
  /** This device's own records key, so it is not wrapped to twice. */
  readonly myRecordsKey: Hex;
  readonly signers: () => Promise<readonly PoolSigner[]>;
  readonly records: DeviceRecords;
}

/**
 * **THE VAULT'S NOTE POOL AND NONCE SECRET, FILED THROUGH THE COMPANY'S RECORDS
 * ROUTE.** Only for a vault its committee holds and the chain has never paid
 * into. Each half is skipped when it is already filed, so it can be run again.
 */
export async function openCompanyVaultPool(doors: PoolDoors, vault: Hex): Promise<void> {
  doors.progress?.('opening the pool');
  const view = await doors.service.chain(vault);
  if (!view.onChain || view.heldByCommittee !== true) {
    throw new Error(view.why ?? 'this vault is not held by the company\'s committee yet, so its pool is not opened.');
  }
  const everCreated = new Set(view.everCreated ?? []);
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  if (await doors.records('pool').get(vault) === null) {
    if ((view.notes ?? []).length > 0 || everCreated.size > 0) {
      throw new Error('the chain has already put money in this vault and it has no pool, so a new empty pool '
        + 'would record nothing of it. Nothing is filed; rebuild the pool from the company\'s records instead.');
    }
    await pool.create(vault, { notes: [] });
  }
  if (await doors.records('nonce-secret').get(vault) === null) {
    const { readers } = await doors.service.keys();
    const others: NonceSecretReader[] = readers
      .filter((k) => k.toLowerCase() !== doors.myRecordsKey.toLowerCase())
      .map((publicKey) => ({ publicKey }));
    await startVaultNonceSecretOnThisDevice(vault, doors.me, others, doors.records, everCreated);
  }
  doors.progress?.('done');
}

/**
 * **HOW THE LEDGER THIS PAGE BUILDS WITH BEGINS THE BYTES OF ITS PARAMETERS,
 * VERSION INCLUDED.** Parameters of any other version are ones the vault worker
 * cannot read, so a deposit refuses them before a coin is chosen or its journal
 * line filed. A test pins this against the installed ledger.
 */
export const LEDGER_PARAMETERS_HEADER = 'midnight:ledger-parameters[v8]:';

export interface DepositDoors extends PoolDoors {
  readonly company: Hex;
  readonly builder: VaultBuilderClient;
  readonly pay: (ask: { company: Hex; vault: Hex; transaction: string }) =>
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
  doors.progress?.('choosing the coin');
  const { coin } = await depositCoinOnThisDevice({
    vault, money, me: doors.me, signers: doors.signers, records: doors.records,
    chain: {
      everCreated: new Set(view.everCreated ?? []),
      outputCommitmentOf: async (c) => (await commitments(c)).output,
      heldNow: async (c) => notes.has((await commitments(c)).held.toLowerCase()),
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
    paid = await doors.pay({ company: doors.company, vault, transaction: built.tx });
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
  readonly company: Hex;
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
  const parameters = await chainParametersForADeposit(doors, vault);
  if (typeof doors.builder.publicDeposit !== 'function') {
    throw new Error('this page cannot build a public deposit, so nothing was built or sent. No money moved. Reload the page and try again; if it happens again, the service needs attention.');
  }
  doors.progress?.('building the deposit');
  const built = await doors.builder.publicDeposit({
    vault, token: money.token, amount: money.value.toString(), state: view.state, parameters,
  });
  doors.progress?.('asking your wallet');
  const paid = await doors.pay({ company: doors.company, vault, transaction: built.tx });
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

const wireOf = (n: Note): NoteOnTheWire => ({
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
    vault, account: chain.account, order: round, payment, note, events,
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

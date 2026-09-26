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
   * One block's view of the vault and the company's account, for a payment out
   * to be built on. A deposit reads the ledger parameters from it too.
   */
  payoutState(vault: Hex): Promise<{
    vault: Hex; account: Hex; blockHash: string;
    vaultState: string; zswapState: string; parameters: string; accountState: string;
  }>;
  /** The chain's events for one transaction. */
  events(vault: Hex, transactionHash: string): Promise<{ events: EventOnTheWire[] }>;
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

/** How the ledger begins the bytes of its parameters, whatever their version. */
const LEDGER_PARAMETERS_HEADER = 'midnight:ledger-parameters[v';

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
 * LAND.** Kept on this device, and only here: it names the coin, so it never
 * leaves it.
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

/** One deposit in flight per vault on this device: a second is refused until the first is settled. */
export interface DepositsInFlight {
  get(vault: Hex): Promise<DepositInFlight | null>;
  put(vault: Hex, deposit: DepositInFlight): Promise<void>;
  forget(vault: Hex): Promise<void>;
}

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
      + 'replace it: if both arrive, the vault holds both. It is added to the vault\'s record the next time money is '
      + 'put into this vault from this browser.');
    this.name = 'DepositNotYetSeen';
  }
}

/**
 * **THE DEPOSIT IS IN THE VAULT AND IS NOT IN ITS RECORD YET.** Either the
 * transaction that made it cannot be read yet, or the vault's notes and its
 * history were read a moment apart. The money is the vault's. Nothing is
 * recorded until it can be, and the next deposit from this browser asks again.
 */
export class DepositLandedNotYetRecorded extends Error {
  constructor(readonly vault: Hex, readonly txRef: string) {
    super(`the deposit${txRef === '' ? '' : ` (${txRef})`} is in the vault. This page could not yet read the transfer `
      + 'that brought it in, so it is not in the vault\'s record and cannot be used for a payment yet. It is added the '
      + 'next time money is put into this vault from this browser. Do not put the same money in again.');
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
 * **WHICH TRANSACTION CREATED A DEPOSIT'S NOTE, AS THE CHAIN SAYS, OR WHY IT
 * CANNOT BE SAID.** Asked of the transaction the service named, by its hash;
 * its events must carry exactly one output with this coin's commitment, owned
 * by this vault. `not-yet` is an indexer that does not hold the transaction
 * yet, and asking again answers it.
 *
 * The events are read here and judged in the vault worker, because judging
 * them loads the ledger, which this page does not carry. A worker that cannot
 * answer is `not-yet`, as an unreadable answer always was.
 */
async function creatingTransactionOfDeposit(
  doors: DepositDoors, vault: Hex, output: string, transactionHash: string | null,
): Promise<{ state: 'found'; createdIn: Hex } | { state: 'not-yet' } | { state: 'unknown'; why: string }> {
  const hash = transactionHash === null ? null : transactionHash.toLowerCase();
  if (hash === null || !HEX64.test(hash)) {
    return { state: 'unknown', why: 'this page could not find out which transfer brought it in' };
  }
  let events: EventOnTheWire[];
  try {
    events = (await doors.service.events(vault, hash)).events;
  } catch {
    return { state: 'not-yet' };
  }
  if (events.length === 0) return { state: 'not-yet' };
  let judged: CreatingTransactionAnswer;
  try {
    judged = await doors.builder.creatingTransaction({ vault, commitment: output, transactionHash: hash, events });
  } catch {
    return { state: 'not-yet' };
  }
  if (judged.state === 'found') return { state: 'found', createdIn: judged.createdIn as Hex };
  if (judged.state === 'refused') {
    return { state: 'unknown', why: 'the transfer this page was given does not show this deposit' };
  }
  return { state: 'not-yet' };
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
const letGo = async (doors: DepositDoors, vault: Hex): Promise<void> => {
  await doors.inFlight.forget(vault).catch(() => { /* the next deposit settles it again, and finds nothing to do */ });
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
  doors: DepositDoors, vault: Hex, d: DepositInFlight, output: string,
  how: { readonly waiting: boolean; readonly giveUp: boolean },
): Promise<DepositRecorded> {
  const coin = inFlightCoin(d);
  let found = await creatingTransactionOfDeposit(doors, vault, output, d.transactionHash);
  if (found.state === 'not-yet' && how.waiting) {
    found = (await until(doors, async () => {
      const again = await creatingTransactionOfDeposit(doors, vault, output, d.transactionHash);
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
  await letGo(doors, vault);
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
    await letGo(doors, vault);
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
    await letGo(doors, vault);
    return { state: 'never-landed' };
  }
  throw new DepositStillInFlight(vault, d.txRef, until);
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
   * **THE CHAIN'S PARAMETERS NOW, READ BEFORE A COIN IS CHOSEN**, from the one
   * block's view a payment out is built on, so if the chain cannot be read no
   * coin is chosen or recorded. The deposit is built with these and never with
   * the ledger's starting parameters. Bytes that do not begin the way the
   * ledger writes its parameters are refused here too, before a coin is chosen.
   */
  let parameters: string;
  try {
    const at = await doors.service.payoutState(vault);
    if (String(at.vault).toLowerCase() !== vault.toLowerCase() || typeof at.parameters !== 'string' || at.parameters.length === 0) {
      throw new Error('the answer was not this vault\'s parameters');
    }
    if (!atob(at.parameters.slice(0, 40)).startsWith(LEDGER_PARAMETERS_HEADER)) {
      throw new Error('the answer was not ledger parameters');
    }
    parameters = at.parameters;
  } catch (cause) {
    throw new Error('the chain\'s current parameters could not be read for this vault, so no coin was chosen and '
      + `nothing was built or sent (${(cause as Error)?.message ?? String(cause)}). Try again shortly.`);
  }
  /*
   * **AN EARLIER DEPOSIT FROM THIS DEVICE IS SETTLED FIRST.** Recorded if it has
   * landed, forgotten if it never can; while it still can, no coin is chosen
   * for this one, because it could be the same coin.
   */
  const earlier = await settleDepositInFlight(doors, vault, view);
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
  let inFlight: DepositInFlight = { coin: coinOnTheWire, recordedAt: (doors.clock ?? Date.now)(), txRef: '', transactionHash: null };
  await doors.inFlight.put(vault, inFlight);
  doors.progress?.('asking your wallet');
  let paid: { transaction: string; leaves: readonly unknown[] };
  try {
    paid = await doors.pay({ company: doors.company, vault, transaction: built.tx });
  } catch (e) {
    await letGo(doors, vault);
    throw e;
  }
  doors.progress?.('sending the deposit');
  let sent: { txRef: string; transactionHash: string | null };
  try {
    sent = await doors.service.deposit(vault, paid.transaction);
  } catch (e) {
    if (!sentNothing(e)) throw new DepositNotYetSeen(vault, '');
    await letGo(doors, vault);
    throw new DepositNotSent(vault, (e as Error)?.message ?? String(e));
  }
  inFlight = { ...inFlight, txRef: sent.txRef, transactionHash: sent.transactionHash };
  await doors.inFlight.put(vault, inFlight).catch(() => { /* the earlier line still names the coin, and the chain is asked by it */ });
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

/* ------------------------------------------------------------ a payment out */

export interface PayoutDoors extends PoolDoors {
  readonly builder: VaultBuilderClient;
  readonly now?: () => Date;
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
      + `${why === undefined ? '' : ` (${why})`}, so it may still land. This device has not changed the vault's `
      + 'record for it and will not do so later; its payment journal names the note it spends. Do not pay this '
      + 'person again: open the run later, and it shows them paid once the chain does. If it does, a payment that '
      + 'would spend the same note is refused on this device until the vault\'s record is rebuilt from the '
      + 'company\'s records.');
    this.name = 'PaymentNotYetSeen';
  }
}

/**
 * **THE PAYMENT LANDED, AND THE VAULT'S RECORD WAS NOT WRITTEN.** The person is
 * paid. A payment that would spend the same note is refused on this device until
 * the vault's record is rebuilt from the company's records.
 */
export class PaymentLandedUnrecorded extends Error {
  constructor(readonly vault: Hex, readonly transactionHash: string, why: string) {
    super(`the payment landed (${transactionHash}) and the vault's record could not be written (${why}). The person `
      + 'is paid: do not pay them again. A payment that would spend the same note is refused on this device until '
      + 'the vault\'s record is rebuilt from the company\'s records.');
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
    super(`the chain holds a transaction under this payment's name (${transactionHash}) that is not the payment this `
      + `device built: ${why}. The vault's record is not changed. Do not pay this person again until the run shows `
      + 'whether they were paid; the vault\'s record has to be rebuilt from the company\'s records before this device '
      + 'spends that note.');
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
): Promise<{ txRef: string; transactionHash: string; spent: Hex; change: NoteOnTheWire | null }> {
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

  doors.progress?.('sending the payment');
  let sent: { txRef: string; transactionHash: string | null };
  try {
    sent = await doors.service.payout(vault, built.tx);
  } catch (e) {
    if (sentNothing(e)) throw e;
    throw new PaymentNotYetSeen(vault, '', (e as Error)?.message ?? String(e));
  }

  /* ---- from here the money may have moved, and every failure says so ---- */
  try {
    const hash = sent.transactionHash === null ? null : sent.transactionHash.toLowerCase();
    if (hash === null || !HEX64.test(hash)) {
      throw new PaymentNotYetSeen(vault, sent.txRef, 'the service could not name the transaction it sent');
    }
    doors.progress?.('waiting for the payment');
    const confirmed = await until(doors, async () => {
      let own: { events: EventOnTheWire[] };
      try {
        own = await doors.service.events(vault, hash);
      } catch {
        /* The indexer does not hold it yet, or could not be asked: ask again. */
        return null;
      }
      const answer = await doors.builder.confirmPayment({ vault, transactionHash: hash, change: built.change, events: own.events });
      return answer.state === 'not-yet' ? null : answer;
    });
    if (confirmed === null) throw new PaymentNotYetSeen(vault, sent.txRef);
    if (confirmed.state === 'not-as-built') throw new PaymentNotAsBuilt(vault, hash, confirmed.why);
    const createdIn = confirmed.createdIn;

    doors.progress?.('recording the payment');
    try {
      const ATTEMPTS = 5;
      for (let attempt = 1; ; attempt += 1) {
        const now = await pool.load(vault);
        const next = await doors.builder.afterPayment({
          notes: now.notes.map(wireOf), spent: note.nonce, amount: payment.amount, change: built.change, createdIn,
        });
        try {
          await pool.save(vault, { notes: next.map(noteOf) }, now.readAt);
          break;
        } catch (cause) {
          if (!isALostPoolRace(cause) || attempt === ATTEMPTS) throw cause;
        }
      }
    } catch (cause) {
      throw new PaymentLandedUnrecorded(vault, createdIn, (cause as Error)?.message ?? String(cause));
    }
    doors.progress?.('done');
    return { txRef: sent.txRef, transactionHash: createdIn, spent: note.nonce as Hex, change: built.change };
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

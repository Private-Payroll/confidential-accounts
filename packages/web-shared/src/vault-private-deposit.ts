/**
 * **A PRIVATE DEPOSIT INTO A COMPANY'S VAULT, FROM A SIGNER'S OWN DEVICE**
 * (`depositIntoCompanyVault`), and the settling of one kept on its way
 * (`settleDepositInFlight`).
 *
 * The coin is chosen and recorded on this device (`deposit-on-device.ts`). The
 * call is built and proved in the vault worker, with the ledger parameters the
 * chain holds now, read from the same route a payment out is built on. The
 * person's own wallet adds the coin and signs, and the service adds the network
 * fee and sends it. The vault's note pool records the new note only once the
 * chain holds it, with the transaction that made it.
 */
import type { Hex } from '../../../src/core/crypto.js';
import type { DepositMoney } from '../../../src/midnight/deposit-nonce.js';
import { SealedNotePool, isALostPoolRace, openPool } from '../../../src/midnight/vault-pool.js';
import { afterDeposit } from '../../../src/midnight/vault-note-deposit.js';
import type { TransactionRead } from './vault-builder.js';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import { depositCoinOnThisDevice, VaultSecretBeingChanged } from './deposit-on-device.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import type { Kept, KeptOnThisDevice } from './in-flight-on-this-device.js';
import { endedIfItThrows, letGo, neverHandedOver } from './deposit-line-ended.js';
import { sentNothing } from './vault-start-stops.js';
import { type BuiltOnHereDoors, type ChainHereDoors, type PoolDoors, type VaultChainView, until } from './vault-doors.js';
import { chainAtOneBlockHere } from './vault-read-here.js';
import { theChainWins } from './vault-pool-opened.js';
import { removalsOnTheChainHere } from './removals-on-the-chain.js';
import { whenTheSecretWasSetHere } from './who-holds-the-vaults-secret.js';
import { creatingTransactionOfOutput, notesAsThisDeviceReadsThem, timeShown } from './vault-step-reads.js';
import { fundableOrThrow } from './vault-fundable-here.js';

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
type DepositAsBuilt =
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

/** What a deposit left in the vault's record, once the chain holds it. */
interface DepositRecorded {
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
export async function depositAsTheChainShows(
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
export async function chainParametersForADeposit(doors: BuiltOnHereDoors, vault: Hex): Promise<string> {
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
 * The coin for a private deposit, chosen and kept on this device against the vault as `view` holds it, with the count of
 * removals it was chosen under and the moment the choosing began.
 */
async function theCoinChosenHere(
  doors: DepositDoors, vault: Hex, money: DepositMoney, { view, state }: { readonly view: VaultChainView; readonly state: string },
  commitments: (coin: { nonce: Hex; token: Hex; value: bigint }) => ReturnType<DepositDoors['builder']['commitments']>,
) {
  const notes = new Set((view.notes ?? []).map((n) => n.toLowerCase()));
  /* The records' newest secret is the vault's own, filed again from an earlier version when it is not. */
  await theChainWins(doors, vault, state);
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
      /* The same state the deposit is built against: a state that lies about the commitment is refused by the chain. */
      secretIsTheVaults: (secret) => doors.builder.secretIsTheVaults({ vault, state, secret }),
      removals,
      secretSet: () => whenTheSecretWasSetHere(doors, vault, (view.nonceCommitment ?? '') as Hex),
    },
  });
  return { coin, removals, choosing };
}

/**
 * The deposit the wallet paid for, handed to the service to send. A failure is a deposit that may have been sent, unless
 * the service marks it as having sent nothing; then its journal line is let go and the deposit is said not to be sent.
 */
async function sentToTheService(
  doors: DepositDoors, vault: Hex, transaction: string, claim: NonNullable<Awaited<ReturnType<DepositDoors['inFlight']['claim']>>>,
): Promise<{ txRef: string; transactionHash: string | null }> {
  doors.progress?.('sending the deposit');
  try {
    return await doors.service.deposit(vault, transaction);
  } catch (e) {
    if (!sentNothing(e)) throw new DepositNotYetSeen(vault, '');
    /* Handed to the service: its word that nothing left is not this device's own, so the journal line is not marked. */
    await letGo(doors, vault, claim);
    throw new DepositNotSent(vault, (e as Error)?.message ?? String(e));
  }
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
  const commitments = (coin: { nonce: Hex; token: Hex; value: bigint }) => doors.builder.commitments({
    vault, coin: { nonce: coin.nonce, token: coin.token, value: coin.value.toString() },
  });
  const { coin, removals, choosing } = await theCoinChosenHere(doors, vault, money, { view, state: view.state }, commitments);
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
  const sent = await sentToTheService(doors, vault, paid.transaction, claim);
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

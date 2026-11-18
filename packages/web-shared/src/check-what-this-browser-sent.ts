/**
 * **WHAT THIS BROWSER LAST SENT, CHECKED AGAINST THE CHAIN**: the deposits and
 * payments it keeps on their way, settled where they can be, and what the check
 * found, said in words (`checkWhatThisBrowserSent`,
 * `checkWhatThisBrowserDeposited`, `sayWhatTheCheckFound`).
 */
import type { Hex } from '../../../src/core/crypto.js';
import { SealedNotePool, isALostPoolRace, openPool } from '../../../src/midnight/vault-pool.js';
import type { Note } from '../../../src/midnight/vault-notes.js';
import { letGo } from './deposit-line-ended.js';
import { type VaultChainView } from './vault-doors.js';
import { creatingTransactionOfOutput, notesAsThisDeviceReadsThem, timeShown } from './vault-step-reads.js';
import { depositAsTheChainShows, type DepositDoors, DepositLandedNotYetRecorded, DepositStillInFlight, journalledDepositLandsBy, settleDepositInFlight } from './vault-private-deposit.js';
import { type PaymentSettled, type PaymentsInFlight, PaymentStillInFlight } from './vault-payment-in-flight.js';
import { settlePaymentInFlight } from './vault-payment-settled.js';

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
  return [...depositSaid(found), ...paymentSaid(found.payment), ...notesSaid(found)].join(' ');
}

/** What a check found of this browser's deposits, a sentence each. */
function depositSaid(found: WhatThisBrowserDeposited): string[] {
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
  return said;
}

/** What a check found of a payment this browser sent, a sentence each; nothing when the check carried none. */
function paymentSaid(p: WhatThisBrowserSent['payment'] | undefined): string[] {
  const said: string[] = [];
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
  return said;
}

/** What a check found of the vault's amounts, a sentence each: those now usable, those owed a filing and those not yet named. */
function notesSaid(found: WhatThisBrowserDeposited): string[] {
  const said: string[] = [];
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
  return said;
}

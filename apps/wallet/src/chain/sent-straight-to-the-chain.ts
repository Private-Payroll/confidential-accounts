/**
 * **A CALL SENT WITHOUT OUR SERVICE SUBMITTING IT: ITS FEE PAID BY OUR FEE SPONSORSHIP, OR BY THE PERSON'S OWN DUST
 * WHEN SPONSORSHIP CANNOT PAY, AND SUBMITTED BY THE PERSON'S WALLET OR THE COMPANY'S OWN SERVICE.**
 *
 * Every action that sends a call without our service hands the finished call here. The call is read back from
 * what was proven and held to what it must be - one call to the company's account with no coin spent or made and
 * no public money moved, or a vault's call - its start, or a payment, merge or public payment of its own coins -
 * held to the service's own check of it - before anything is added. The sponsorship is asked first and what it
 * hands back is held to being the call with only a DUST fee added; when it cannot pay, the wallet adds only a DUST
 * fee of its own, checks that what it added is only that fee, and signs. The finished call then goes to the
 * network from the wallet, or to the company's own service; when that service cannot be reached, the wallet reads
 * the chain for the very call it finished and, finding it absent, hands that same call to the network itself, so
 * one call can land only once. Anything refused before that hand-over is undone, and nothing is paid.
 */
import type {
  BalancingRecipe, FinalizedTx, SignSegment, UnboundTransactionRecipe, UnboundTx, WalletFacade,
} from '@midnightntwrk/wallet-sdk';
import { ourServiceTookNothing, serviceNotReached, type ChainCall } from '../../../../packages/web-shared/src/hand-over.js';
import { isVaultCallKind, movesNothing, vaultCallRefusal } from '../../../../src/wiring/vault-call-checks.js';
import { registryPutRefusal } from '../../../../src/wiring/registry-call-checks.js';
import {
  base64FromBytes, bytesFromBase64, untilItHasReadTheChain, whyThePaymentFailed, type BalanceDoors, type LedgerForBalancing,
} from './balance-for-page.js';
import { carriedBy, NOT_ON_THIS_WALLETS_LEDGER, readOnThisWalletsLedger } from './carried.js';

/**
 * The person's own wallet, as it pays a call's fee and sends it: the SDK's own facade, its dust part started, in the
 * SDK's own types so the type checker holds every call to the facade's real signature.
 */
export type OwnWalletFacade = Pick<WalletFacade,
  'dust' | 'state' | 'adoptTransaction' | 'balanceUnboundTransaction' | 'estimateTransactionFee' | 'signRecipe' | 'finalizeRecipe'
  | 'submitTransaction' | 'revert'>;

/** What paying a call's fee asks of this wallet. */
export interface OwnWalletDoors {
  readonly ledger: () => Promise<LedgerForBalancing>;
  readonly facade: () => Promise<OwnWalletFacade>;
  readonly signSegment: () => SignSegment;
  readonly stop?: () => Promise<void>;
  /**
   * Whether a transaction carrying any of these identifiers is on the chain, read from the wallet's own indexer and
   * never from a service; it throws when the chain cannot be read. Absent, a call that may have reached a service
   * that did not answer is never sent again.
   */
  readonly landed?: (identifiers: readonly string[]) => Promise<boolean>;
}

/**
 * **THE PERSON'S OWN WALLET AS A CALL SENT STRAIGHT TO THE CHAIN PAYS WITH IT**: the wallet that pays
 * a page's deposit, with its DUST part started too, since the fee is paid in
 * DUST. Its keys never leave this wallet.
 */
export const ownWalletFrom = (doors: BalanceDoors): OwnWalletDoors => ({
  ledger: doors.ledger, signSegment: doors.signSegment, ...(doors.stop === undefined ? {} : { stop: doors.stop }),
  facade: async () => {
    const f = await doors.facade();
    await f.dust.start(doors.dustKeys());
    return f;
  },
});

/** How long the fee the wallet adds holds good, as the wallet pays for a page's call. */
export const FEE_TTL_MS = 20 * 60_000;

export const said = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\.\s*$/u, '');
const bare = (a: unknown): string => String(a).toLowerCase().replace(/^0x/u, '');
const entryPointName = (e: unknown): string => (e instanceof Uint8Array ? new TextDecoder().decode(e) : String(e));

interface CallLike { readonly address?: unknown; readonly entryPoint?: unknown }
interface OfferLike { readonly inputs?: readonly unknown[]; readonly outputs?: readonly unknown[]; readonly transients?: readonly unknown[] }
interface IntentLike {
  readonly actions?: readonly unknown[];
  readonly guaranteedUnshieldedOffer?: OfferLike | null;
  readonly fallibleUnshieldedOffer?: OfferLike | null;
  readonly dustActions?: { readonly spends?: readonly unknown[]; readonly registrations?: readonly unknown[] } | null;
  /** The intent's deadline, which the chain holds it to. */
  readonly ttl?: unknown;
}
interface TxLike {
  readonly intents?: Map<number, IntentLike> | null;
  readonly guaranteedOffer?: OfferLike | null;
  readonly fallibleOffer?: Map<number, OfferLike> | null;
  imbalances?(segment: number): Map<{ readonly tag: string; readonly raw?: unknown }, bigint>;
  identifiers?(): readonly unknown[];
}

/*
 * An offer is empty only when it is absent, or every list it is read by is there and empty: a list missing (a field
 * renamed in the ledger) is never read as empty, so the call is refused rather than paid for unread.
 */
const SHIELDED_LISTS = ['inputs', 'outputs', 'transients'] as const;
const PUBLIC_LISTS = ['inputs', 'outputs'] as const;
const empty = (o: OfferLike | null | undefined, lists: readonly string[]): boolean =>
  o === undefined || o === null || lists.every((k) => {
    const list = (o as Record<string, unknown>)[k];
    return Array.isArray(list) && list.length === 0;
  });
const noShieldedOffer = (t: TxLike): boolean => empty(t.guaranteedOffer, SHIELDED_LISTS)
  && (t.fallibleOffer === undefined || t.fallibleOffer === null || [...t.fallibleOffer.values()].every((o) => empty(o, SHIELDED_LISTS)));
const noPublicOffer = (i: IntentLike): boolean => empty(i.guaranteedUnshieldedOffer, PUBLIC_LISTS) && empty(i.fallibleUnshieldedOffer, PUBLIC_LISTS);
/** True when every field the checks read is a field of the transaction and of each of its parts, set or not. */
const readable = (t: TxLike): boolean => 'guaranteedOffer' in t && 'fallibleOffer' in t && t.intents instanceof Map
  && [...t.intents.values()].every((i) => typeof i === 'object' && i !== null && 'actions' in i && 'guaranteedUnshieldedOffer' in i
    && 'fallibleUnshieldedOffer' in i && 'dustActions' in i
    && (i.dustActions === undefined || i.dustActions === null || (Array.isArray(i.dustActions.spends) && Array.isArray(i.dustActions.registrations))));

/**
 * **WHY THIS IS NOT ONE CALL TO `circuit` ON THE CONTRACT AT `account` (THE
 * COMPANY'S ACCOUNT UNLESS `to` NAMES ANOTHER) THAT MOVES NO COIN, OR NULL WHEN IT IS**: read off the proven call before the wallet adds
 * anything to it. Refused: a call to another contract or another circuit, more
 * than one call, a coin spent or made, public money in or out, DUST already
 * spent or registered, and a token owed or left over that is not the fee.
 */
export function notOneCallRefusal(tx: unknown, account: string, circuit: string, to = 'the company\'s account'): string | null {
  const t = tx as TxLike | null;
  if (t === null || typeof t !== 'object' || !(t.intents instanceof Map) || !readable(t)) return 'what this wallet built is not a transaction it can read';
  const calls: CallLike[] = [];
  for (const intent of t.intents.values()) {
    for (const a of intent.actions ?? []) calls.push(a as CallLike);
    if (!noPublicOffer(intent)) return 'it moves public money';
    const d = intent.dustActions;
    if (d !== undefined && d !== null && ((d.spends?.length ?? 0) > 0 || (d.registrations?.length ?? 0) > 0)) return 'it already spends or registers DUST';
  }
  if (calls.length !== 1) return `it makes ${calls.length} calls, and this step makes one`;
  const [call] = calls;
  if (call!.entryPoint === undefined || call!.address === undefined || bare(call!.address) !== bare(account)) return `it calls another contract than ${to}`;
  if (entryPointName(call!.entryPoint) !== circuit) return `it calls "${entryPointName(call!.entryPoint)}", and this step calls "${circuit}"`;
  if (!noShieldedOffer(t)) return 'it spends or makes a coin';
  if (typeof t.imbalances !== 'function') return 'what this wallet built is not a transaction it can read';
  for (const segment of [0, ...t.intents.keys()]) {
    for (const [token, imbalance] of t.imbalances(segment)) {
      if (token.tag !== 'dust' && imbalance !== 0n) return 'it owes or leaves over money that is not its fee';
    }
  }
  return null;
}

/** Which part of a balancing recipe holds the transaction the wallet adopted, and what a change to it changes. */
export interface AdoptedAs { readonly part: 'baseTransaction' | 'originalTransaction'; readonly itself: string }
const A_CALL: AdoptedAs = { part: 'baseTransaction', itself: 'the call itself' };

/**
 * **WHY WHAT THE WALLET ADDS TO PAY THE FEE IS MORE THAN THE FEE, OR NULL WHEN IT IS NOT**: the adopted transaction
 * is left as it was, and what is added spends DUST and does nothing else - no call, no coin, no public money, no DUST
 * registered. With `shown`, the DUST it spends is read, and is no more than the fee the person confirmed.
 */
export function addedMoreThanTheFeeRefusal(recipe: unknown, adopted: unknown, as: AdoptedAs, shown?: bigint): string | null {
  const r = recipe as Partial<Record<AdoptedAs['part'] | 'balancingTransaction', unknown>> | null;
  if (r === null || typeof r !== 'object') return 'this wallet could not read what it was about to add';
  if (r[as.part] !== adopted) return `this wallet was about to change ${as.itself}`;
  const added = dustTheFeeSpends(r.balancingTransaction);
  if ('refused' in added) return added.refused;
  if (shown === undefined) return null;
  if (added.fee === null) return 'this wallet could not read the fee it was about to pay';
  return added.fee > shown ? 'this wallet was about to pay more than the fee you confirmed' : null;
}

/** `addedMoreThanTheFeeRefusal` for a call: the call is left as it was, and no fee was shown to hold the DUST to. */
export function moreThanTheFeeRefusal(recipe: unknown, call: unknown): string | null {
  return addedMoreThanTheFeeRefusal(recipe, call, A_CALL);
}

/**
 * **WHAT A TRANSACTION THE WALLET ADDS TO PAY A FEE SPENDS**: its refusal when it does anything but spend DUST (a call,
 * a coin, public money, a DUST registration) or spends none; otherwise the DUST its spends pay, summed, or null when
 * a spend's fee cannot be read.
 */
export function dustTheFeeSpends(balancing: unknown): { readonly refused: string } | { readonly fee: bigint | null } {
  const fee = carriedBy(balancing) as TxLike | null | undefined;
  if (fee === undefined || fee === null) return { refused: 'this wallet added nothing to pay the fee' };
  if (typeof fee !== 'object' || !readable(fee)) return { refused: 'this wallet could not read what it was about to add' };
  if (!noShieldedOffer(fee)) return { refused: 'this wallet was about to spend or make a coin as well as the fee' };
  let spends = 0;
  let total: bigint | null = 0n;
  for (const intent of fee.intents?.values() ?? []) {
    if ((intent.actions?.length ?? 0) > 0) return { refused: 'this wallet was about to make a call as well as pay the fee' };
    if (!noPublicOffer(intent)) return { refused: 'this wallet was about to move public money as well as pay the fee' };
    if ((intent.dustActions?.registrations?.length ?? 0) > 0) return { refused: 'this wallet was about to register DUST as well as pay the fee' };
    for (const spend of intent.dustActions?.spends ?? []) {
      spends += 1;
      const paid = (spend as { readonly vFee?: unknown } | null)?.vFee;
      total = total === null || typeof paid !== 'bigint' ? null : total + paid;
    }
  }
  return spends > 0 ? { fee: total } : { refused: 'this wallet added nothing to pay the fee' };
}

/*
 * Whether two parts of a transaction are the same, byte for byte: by the bytes the ledger writes them as, or, for a
 * part the ledger writes no bytes for (a contract call, a public offer, DUST actions), by its full written form,
 * which carries every field and the proof. Both absent is the same; a part that can be written neither way is never
 * the same as anything.
 */
const sameContent = (a: unknown, b: unknown): boolean => {
  if (a === undefined || a === null || b === undefined || b === null) return (a ?? null) === (b ?? null);
  const bytesOf = (x: unknown): Uint8Array | null => {
    const f = (x as { serialize?: unknown }).serialize;
    if (typeof f !== 'function') return null;
    const out = (f as () => unknown).call(x);
    return out instanceof Uint8Array ? out : null;
  };
  const ba = bytesOf(a);
  const bb = bytesOf(b);
  if (ba !== null || bb !== null) return ba !== null && bb !== null && ba.length === bb.length && ba.every((v, i) => v === bb[i]);
  const textOf = (x: unknown): string | null => {
    const f = (x as { toString?: unknown }).toString;
    return typeof f === 'function' && f !== Object.prototype.toString ? String((f as (compact?: boolean) => unknown).call(x, false)) : null;
  };
  const ta = textOf(a);
  return ta !== null && ta === textOf(b);
};

/**
 * **WHY WHAT THE FEE SPONSORSHIP HANDED BACK IS MORE THAN THE CALL WITH ITS FEE, OR NULL WHEN IT IS NOT.** Every
 * segment the call had is there, and each of its calls (proof included), its public offers, its DUST actions and its
 * deadline (`ttl`) are the same byte for byte (`sameContent`), as are the transaction's coins; every segment added
 * only spends DUST, and at least one does; and nothing owes or leaves over any token but DUST beyond what the call
 * itself did. Every identifier the call carries is still carried, so the call is bound as it was proven and the
 * wallet can look for it on the chain by what it holds. The sponsorship is our service, so the wallet trusts none of
 * it: it submits nothing that fails this.
 */
export function onlyTheFeeAddedRefusal(call: unknown, back: unknown): string | null {
  const c = call as TxLike;
  const b = back as TxLike | null;
  if (b === null || typeof b !== 'object' || !(b.intents instanceof Map) || !readable(b)) return 'it is not a transaction this wallet can read';
  if (!(c.intents instanceof Map) || typeof c.imbalances !== 'function' || typeof b.imbalances !== 'function') return 'it is not a transaction this wallet can read';
  if (typeof c.identifiers !== 'function' || typeof b.identifiers !== 'function') return 'it is not a transaction this wallet can read';
  const carried = new Set(b.identifiers().map(String));
  if (!c.identifiers().map(String).every((id) => carried.has(id))) return 'it changes how the call is bound';
  if (!sameContent(c.guaranteedOffer, b.guaranteedOffer)) return 'it changes the coins the call spends or makes';
  const mineFallible = [...(c.fallibleOffer?.entries() ?? [])];
  if (mineFallible.length !== (b.fallibleOffer?.size ?? 0)
    || mineFallible.some(([k, o]) => !sameContent(o, b.fallibleOffer?.get(k)))) return 'it changes the coins the call spends or makes';
  for (const [segment, mine] of c.intents) {
    const theirs = b.intents.get(segment);
    if (theirs === undefined) return 'it drops part of the call';
    const mineCalls = mine.actions ?? [];
    const theirCalls = theirs.actions ?? [];
    if (mineCalls.length !== theirCalls.length || mineCalls.some((a, i) => !sameContent(a, theirCalls[i]))) return 'it changes the call itself';
    if (!sameContent(mine.guaranteedUnshieldedOffer, theirs.guaranteedUnshieldedOffer)
      || !sameContent(mine.fallibleUnshieldedOffer, theirs.fallibleUnshieldedOffer)) return 'it changes the public money the call moves';
    if (!sameContent(mine.dustActions, theirs.dustActions)) return 'it changes the call itself';
    const ttl = (i: IntentLike): number | null => (i.ttl instanceof Date ? i.ttl.getTime() : null);
    if (ttl(mine) !== ttl(theirs)) return 'it changes the deadline the call was built with';
  }
  let spends = 0;
  for (const [segment, added] of b.intents) {
    if (c.intents.has(segment)) continue;
    if ((added.actions?.length ?? 0) > 0) return 'it makes a call as well as paying the fee';
    if (!noPublicOffer(added)) return 'it moves public money as well as paying the fee';
    if ((added.dustActions?.registrations?.length ?? 0) > 0) return 'it registers DUST as well as paying the fee';
    spends += added.dustActions?.spends?.length ?? 0;
  }
  if (spends === 0) return 'it adds nothing to pay the fee';
  const owed = (t: TxLike, segment: number): string => [...(t.intents!.has(segment) || segment === 0 ? t.imbalances!(segment) : new Map())]
    .filter(([token, n]) => token.tag !== 'dust' && n !== 0n).map(([token, n]) => `${token.tag}:${String(token.raw)}=${n}`).sort().join(';');
  for (const segment of new Set([0, ...c.intents.keys(), ...b.intents.keys()])) {
    if (owed(c, segment) !== owed(b, segment)) return 'it owes or leaves over money that is not its fee';
  }
  return null;
}

/**
 * How a call's fee is paid and where it goes, beside the person's own wallet: our fee sponsorship, which hands the
 * call back finished with only its fee added (absent when this act cannot ask it); whoever submits the finished
 * call, written out as base64 (absent, the person's own wallet hands it to the network); the person's own choice to
 * pay from their own wallet, which leaves the sponsorship unasked; the offer that asks the person before their own
 * DUST pays; and what to tell when the person's own DUST paid instead of the sponsorship, and when whoever submits
 * could not be reached and the wallet handed the call to the network itself. The sponsorship answers the finished call and,
 * when it holds a turn for it, how to tell it this wallet is done with that call. `handedOver` is told the moment
 * the call leaves this wallet, once per call, so the action can count a send the page never saw.
 */
export interface FeeAndSubmit {
  readonly sponsor?: (tx: string, expected: ChainCall) => Promise<{ readonly tx: string; readonly done?: () => Promise<void> }>;
  readonly submit?: (finished: string) => Promise<void>;
  readonly ownDustPaid?: () => void;
  readonly unreached?: () => void;
  readonly handedOver?: () => void;
  /** The person chose to pay this call's fee from their own wallet: the sponsorship is never asked, and the choice is their yes. */
  readonly ownWalletChosen?: boolean;
  /**
   * Asks the person, with the fee worked out, whether their own DUST pays it; `sponsorSaid` is the sponsorship's
   * refusal in its words, or null when it was down, unreached or not asked. Their yes is the only way their DUST pays
   * without their own choice: absent, nothing is paid from it and nothing is sent.
   */
  readonly offer?: (fee: bigint, sponsorSaid: string | null) => Promise<boolean>;
}

/**
 * Whether the sponsorship refused the call itself, by its own checks (`callRefused`), not only the payment: a call
 * that must not go is never offered another way to pay for it.
 */
const theCallWasRefused = (e: unknown): boolean => {
  const x = e as { callRefused?: unknown; body?: { callRefused?: unknown } | null } | null;
  return x?.callRefused === true || x?.body?.callRefused === true;
};

/** A send the wallet refused before handing anything to the network: nothing was paid and nothing was sent. */
export class FeeRefused extends Error {
  readonly nothingWasSent = true as const;
  constructor(message: string) { super(message); this.name = 'FeeRefused'; }
}

/** What one send tells its step: whether the call was handed over, and whether the wallet had too little DUST to pay for it. */
export interface Handed { over: boolean; noDust?: boolean }

/** Why the person's own DUST paid no fee and nothing was sent. */
export type OwnFeeUnpaid = 'declined' | 'too-little-dust' | 'not-paid';

/** The parts of the wallet's facade every payment from the person's own DUST uses. */
type PayingFacade = Pick<WalletFacade, 'dust' | 'state' | 'signRecipe' | 'finalizeRecipe'>;

/**
 * One payment of a fee from the person's own DUST, as the kind of transaction asks it: how the transaction is adopted
 * and balanced, the deadline the fee is added with, the fee shown to the person first (absent, nobody is asked),
 * whether a refusal gives back what was booked, and what sends the finished transaction.
 */
export interface OwnDustPayment<F extends PayingFacade, H, R extends BalancingRecipe, T> {
  /** The paying account's facade with its DUST part started. */
  readonly facade: () => Promise<F>;
  readonly signSegment: () => SignSegment;
  readonly stillWanted: () => boolean;
  /** Set as the transaction is handed over, and `noDust` when the wallet holds too little DUST to pay. */
  readonly handed: Handed;
  /** Told the moment the transaction is handed over: from then on it may have been sent. */
  readonly handedOver?: () => void;
  readonly refused: (why: OwnFeeUnpaid, message: string) => FeeRefused;
  readonly adopt: (facade: F) => H;
  /** The refusal when the transaction cannot be adopted; absent, it is refused as the fee not added. */
  readonly unadopted?: string;
  readonly adoptedAs: AdoptedAs;
  /** The deadline the fee is added with: read once, and again once the person confirms the fee. */
  readonly ttl: (handle: H) => Date;
  readonly balance: (facade: F, handle: H, options: { readonly ttl: Date; readonly tokenKindsToBalance: ['dust'] }) => Promise<R>;
  /** The fee worked out and shown to the person, who must confirm it before anything is added. */
  readonly confirm?: {
    readonly estimate: (facade: F, handle: H, ttl: Date) => Promise<bigint>;
    readonly asked: (fee: bigint) => Promise<boolean>;
  };
  /** Gives back what the fee booked when the send is refused before it is handed over; absent, nothing is given back. */
  readonly giveBack?: (facade: F, recipe: R) => Promise<void>;
  /** What was signed and what was to be sent, in a refusal's words. */
  readonly names: { readonly signed: string; readonly sent: string };
  /** Readies the finished transaction's send; what it returns runs once the transaction is handed over. */
  readonly sender: (facade: F, finished: FinalizedTx) => () => Promise<T>;
}

/**
 * **A FEE PAID FROM THE PERSON'S OWN DUST, AND THE TRANSACTION HANDED OVER.** The facade is opened and its DUST read
 * up to date on this ledger; the transaction is adopted; with `confirm`, the fee is worked out and shown, and the
 * deadline read again once the person confirms it; the fee is added with DUST only and held to
 * `addedMoreThanTheFeeRefusal`; then it is signed and finished, and handed over while still wanted. A refusal before
 * the hand-over is `p.refused`, nothing sent; what fails after it is thrown as it is.
 */
export async function paidFromOwnDust<F extends PayingFacade, H, R extends BalancingRecipe, T>(p: OwnDustPayment<F, H, R, T>): Promise<T> {
  const refused = (why: OwnFeeUnpaid, what: string): FeeRefused => p.refused(why, `${what}, so it paid nothing and sent nothing`);
  const tooLittleDust = (): FeeRefused => {
    p.handed.noDust = true;
    return refused('too-little-dust', 'your wallet holds too little DUST to pay the network fee');
  };
  /* Nothing is booked when balancing throws: the wallet's DUST is changed only once a fee is added whole. */
  const notAdded = (e: unknown): FeeRefused =>
    whyThePaymentFailed(e) === 'not-enough' ? tooLittleDust() : refused('not-paid', `this wallet could not add the fee (${said(e)})`);
  let facade: F;
  try {
    facade = await p.facade();
  } catch (e) {
    throw refused('not-paid', `this wallet could not open its DUST to pay the fee (${said(e)})`);
  }
  await dustReadOnThisLedger(facade, p.stillWanted);
  let handle: H;
  try {
    handle = p.adopt(facade);
  } catch (e) {
    throw p.unadopted === undefined ? notAdded(e) : refused('not-paid', p.unadopted);
  }
  let ttl = p.ttl(handle);
  let shown: bigint | undefined;
  if (p.confirm !== undefined) {
    try {
      shown = await p.confirm.estimate(facade, handle, ttl);
    } catch (e) {
      throw whyThePaymentFailed(e) === 'not-enough' ? tooLittleDust() : refused('not-paid', `this wallet could not work out the fee (${said(e)})`);
    }
    if (!await p.confirm.asked(shown)) throw p.refused('declined', 'you chose not to pay the fee from your own DUST, so this wallet paid nothing and sent nothing');
    /* The person may take a while to answer: the deadline is read again from the time they confirmed. */
    ttl = p.ttl(handle);
  }
  let recipe: R;
  try {
    recipe = await p.balance(facade, handle, { ttl, tokenKindsToBalance: ['dust'] });
  } catch (e) {
    throw notAdded(e);
  }
  try {
    const more = addedMoreThanTheFeeRefusal(recipe, handle, p.adoptedAs, shown);
    if (more !== null) throw refused('not-paid', more);
    let send: () => Promise<T>;
    try {
      send = p.sender(facade, await facade.finalizeRecipe(await facade.signRecipe(recipe, p.signSegment())));
    } catch (e) {
      /* A send earlier in the same window was handed over: what fails now is thrown as it is. */
      if (p.handed.over) throw e;
      throw refused('not-paid', `this wallet could not sign or finish ${p.names.signed} (${said(e)})`);
    }
    if (!p.stillWanted()) throw refused('not-paid', `the window was stopped before the ${p.names.sent} was sent`);
    p.handed.over = true;
    p.handedOver?.();
    return await send();
  } catch (e) {
    if (p.handed.over) throw e;
    /* The refusal is what is told: a give-back that fails does not change that nothing was sent. */
    if (p.giveBack !== undefined) await p.giveBack(facade, recipe).catch(() => undefined);
    throw e;
  }
}

/**
 * **ONE CALL, ITS FEE ONLY PAID, AND HANDED OVER**: the proven call read and held
 * to `notWhatIsSentRefusal`. With `way.sponsor`, and unless the person chose
 * their own wallet (`way.ownWalletChosen`), the sponsorship is asked first;
 * what it hands back is held to `onlyTheFeeAddedRefusal` and refused whole if it
 * fails, never paid again from the person's DUST, and the sponsorship is told
 * the wallet is done with it whether it was sent or not. A refusal of the call
 * itself by the sponsorship's checks is final. When the sponsorship refuses
 * only to pay, is down (`ourServiceTookNothing`), could not be reached
 * (`serviceNotReached`: it never submits, so nothing of the call is out), or
 * there is none, the fee is paid from the wallet's own DUST by
 * `paidFromOwnDust` only on the person's own choice or their yes to
 * `way.offer`, shown the fee and what the sponsorship said: held to what
 * `moreThanTheFeeRefusal` allows, signed and finished. The finished call goes to
 * `way.submit`, or from the wallet to the network; a `way.submit` that could not
 * be reached is gone around by `submittedOrStraight`. Anything that fails before the
 * hand-over is undone and refused as `FeeRefused`, marked as nothing sent;
 * nothing is paid. `handed.over` is set, and `way.handedOver` told, the moment
 * the call is handed over, and nothing after it is ever sent again.
 */
export async function sentFromTheOwnWallet(
  o: OwnWalletDoors, tx: string, expected: ChainCall,
  now: () => number, stillWanted: () => boolean, handed: Handed, way: FeeAndSubmit = {},
): Promise<void> {
  let ledger: LedgerForBalancing;
  try {
    ledger = await o.ledger();
  } catch (e) {
    throw new FeeRefused(`this wallet could not load the ledger to read the call (${said(e)}), so it paid nothing and sent nothing`);
  }
  let call: unknown;
  try {
    call = ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', bytesFromBase64(tx));
  } catch {
    throw new FeeRefused('this wallet could not read the call it built, so it paid nothing and sent nothing');
  }
  const notOne = notWhatIsSentRefusal(call, expected);
  if (notOne !== null) throw new FeeRefused(`the call is not the one this step sends: ${notOne}. This wallet paid nothing and sent nothing`);
  let sponsorSaid: string | null = null;
  if (way.sponsor !== undefined && way.ownWalletChosen !== true) {
    let back: { readonly tx: string; readonly done?: () => Promise<void> } | null;
    try {
      back = await way.sponsor(tx, expected);
    } catch (e) {
      if (theCallWasRefused(e)) {
        throw new FeeRefused(`fee sponsorship refused this call itself (${said(e)}), so nothing was paid or sent. What it says is what resolves it`);
      }
      if (!ourServiceTookNothing(e) && !serviceNotReached(e)) sponsorSaid = said(e);
      back = null;
    }
    if (back !== null) {
      try {
        await sentAsSponsored(o, ledger, call, back.tx, stillWanted, handed, way);
      } finally {
        await back.done?.().catch(() => undefined);
      }
      return;
    }
  }
  if (way.ownWalletChosen !== true && way.offer === undefined) {
    throw new FeeRefused(`${sponsorSaid === null ? '' : `fee sponsorship refused this call (${sponsorSaid}), and `}`
      + 'nobody could be asked whether to pay the fee from their own DUST, so nothing was paid or sent');
  }
  const offer = way.offer;
  /* Told only once the call has gone, so the window never says the person's DUST paid for a call it did not send. */
  const ownDust = way.sponsor !== undefined && way.ownWalletChosen !== true;
  await paidFromOwnDust<OwnWalletFacade, UnboundTx, UnboundTransactionRecipe, void>({
    facade: () => o.facade(), signSegment: () => o.signSegment(), stillWanted, handed, handedOver: () => way.handedOver?.(),
    refused: (_why, message) => new FeeRefused(message),
    adopt: (facade) => facade.adoptTransaction(bytesFromBase64(tx), 'Unbound'),
    adoptedAs: A_CALL,
    ttl: () => new Date(now() + FEE_TTL_MS),
    ...(offer === undefined ? {} : {
      confirm: { estimate: (facade, handle, ttl) => facade.estimateTransactionFee(handle, { ttl }), asked: (fee) => offer(fee, sponsorSaid) },
    }),
    balance: (facade, handle, options) => facade.balanceUnboundTransaction(handle, options),
    giveBack: (facade, recipe) => facade.revert(recipe),
    names: { signed: 'the call', sent: 'call' },
    sender: (facade, finished) => {
      const written = way.submit === undefined ? null : base64FromBytes(finished.serialize());
      return async () => {
        if (written !== null) await submittedOrStraight(o, way, written, finished, async () => { await facade.submitTransaction(finished); });
        else await facade.submitTransaction(finished);
        if (ownDust) way.ownDustPaid?.();
      };
    },
  });
}

/**
 * Whether the very call this wallet finished is on the chain: looked for by every identifier the ledger gives it,
 * which a transaction carrying it keeps whatever fee was merged in beside it. It throws, so nothing is sent again,
 * when the call names no identifier or this wallet cannot read the chain.
 */
export async function onTheChainAlready(o: Pick<OwnWalletDoors, 'landed'>, finished: unknown): Promise<boolean> {
  const tx = carriedBy(finished);
  const ids = (tx as { identifiers?: () => readonly unknown[] } | null)?.identifiers;
  const identifiers = typeof ids === 'function' ? ids.call(tx).map(String) : [];
  if (identifiers.length === 0) throw new Error('the call names no identifier this wallet can look for on the chain');
  if (o.landed === undefined) throw new Error('this wallet cannot read the chain here');
  return o.landed(identifiers);
}

/** `onTheChainAlready` for a proven call as it was handed over, read from its bytes with this wallet's own ledger. */
export async function provenOnTheChainAlready(o: Pick<OwnWalletDoors, 'landed' | 'ledger'>, tx: string): Promise<boolean> {
  const ledger = await o.ledger();
  return onTheChainAlready(o, ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', bytesFromBase64(tx)));
}

/*
 * The finished call handed to `way.submit`. When that service could not be reached, the chain is read for this very
 * call first: found, nothing more is sent; absent, or provably never handed over, the same finished call goes from
 * the wallet to the network, which takes it at most once. A send that then fails is read for once more, as the first
 * may have landed meanwhile. A service that answered, in any way, is never gone around.
 */
async function submittedOrStraight(
  o: OwnWalletDoors, way: FeeAndSubmit, written: string, finished: unknown, straight: () => Promise<void>,
): Promise<void> {
  try {
    await way.submit!(written);
    return;
  } catch (e) {
    if (!serviceNotReached(e)) throw e;
    const read = async (): Promise<boolean> => {
      try {
        return await onTheChainAlready(o, finished);
      } catch (x) {
        throw new Error(`${said(e)}, and ${said(x)}, so this wallet sent nothing more. `
          + 'Do not send it again: open it later, and it will say where it stands on the chain.');
      }
    };
    if (e.nothingWasSent !== true && await read()) return;
    try {
      await straight();
    } catch (x) {
      if (await read().catch(() => false)) return;
      throw x;
    }
    way.unreached?.();
  }
}

/*
 * The call the sponsorship handed back, read as finished and held to `onlyTheFeeAddedRefusal`, then handed to
 * `way.submit` or from the wallet to the network. Nothing here pays anything of the person's.
 */
async function sentAsSponsored(
  o: OwnWalletDoors, ledger: LedgerForBalancing, call: unknown, back: string, stillWanted: () => boolean, handed: Handed, way: FeeAndSubmit,
): Promise<void> {
  let finished: unknown;
  try {
    const read = ledger.Transaction as unknown as { deserialize(s: 'signature', p: 'proof', b: 'binding', raw: Uint8Array): unknown };
    finished = read.deserialize('signature', 'proof', 'binding', bytesFromBase64(back));
  } catch {
    throw new FeeRefused('the fee sponsorship handed back a call this wallet cannot read, so it sent nothing');
  }
  const more = onlyTheFeeAddedRefusal(call, finished);
  if (more !== null) throw new FeeRefused(`what the fee sponsorship handed back is not the call with only its fee: ${more}. This wallet sent nothing`);
  if (way.submit !== undefined) {
    if (!stillWanted()) throw new FeeRefused('the window was stopped before the call was sent, so nothing was sent');
    handed.over = true;
    way.handedOver?.();
    await submittedOrStraight(o, way, back, finished, async () => {
      const f = await o.facade();
      await f.submitTransaction(f.adoptTransaction(bytesFromBase64(back), 'Finalized'));
    });
    return;
  }
  let facade: OwnWalletFacade;
  try {
    facade = await o.facade();
  } catch (e) {
    throw new FeeRefused(`this wallet could not open to send the call (${said(e)}), so it sent nothing`);
  }
  if (!stillWanted()) throw new FeeRefused('the window was stopped before the call was sent, so nothing was sent');
  handed.over = true;
  way.handedOver?.();
  await facade.submitTransaction(facade.adoptTransaction(bytesFromBase64(back), 'Finalized'));
}

/** Why the call owes or leaves over a token that is not its DUST fee, or null when it does not. */
function owesMoreThanItsFee(tx: unknown): string | null {
  const t = tx as TxLike;
  if (typeof t.imbalances !== 'function' || !(t.intents instanceof Map)) return 'what this wallet built is not a transaction it can read';
  for (const segment of [0, ...t.intents.keys()]) {
    for (const [token, imbalance] of t.imbalances(segment)) {
      if (token.tag !== 'dust' && imbalance !== 0n) return 'it owes or leaves over money that is not its fee';
    }
  }
  return null;
}

/**
 * Why the proven call is not what `expected` says is sent, or null when it is: one call to the company's account
 * moving nothing (`notOneCallRefusal`), one `put` to a private registry (`registryPutRefusal`, the fee route's own
 * check), or the same check the service holds a vault's call to before it relays it (`vaultCallRefusal`, one table for both), so the chain path sends nothing the service's shape checks would refuse.
 * A call that moves no coin is also held to owing nothing but its fee. A payout, a merge and a public payout move only
 * the vault's own coins: the wallet still adds DUST alone, held to `moreThanTheFeeRefusal`, so none of the person's own
 * money goes in.
 */
export function notWhatIsSentRefusal(tx: unknown, expected: ChainCall): string | null {
  if (expected.kind === 'account-call') return notOneCallRefusal(tx, expected.contract, expected.circuit);
  if (expected.kind === 'registry-put') return registryPutRefusal(tx, expected.contract) ?? owesMoreThanItsFee(tx);
  if (!isVaultCallKind(expected.kind)) return 'it is not a kind of call this wallet sends';
  const refused = vaultCallRefusal(expected.kind, tx, { vault: expected.contract, account: expected.account });
  return refused ?? (movesNothing(expected.kind) ? owesMoreThanItsFee(tx) : null);
}

/**
 * The hand-over's way for one window, for a call our service does not submit: each call's fee paid and the call
 * handed over by `sentFromTheOwnWallet`, the wallet opened for that call and stopped after it. A refusal before
 * the call was handed over carries `nothingWasSent`.
 */
export const straightFromTheOwnWallet = (
  own: () => OwnWalletDoors, now: () => number, stillWanted: () => boolean, handed: Handed = { over: false }, way: FeeAndSubmit = {},
) => async (tx: string, expected: ChainCall): Promise<void> => {
  const o = own();
  try {
    await sentFromTheOwnWallet(o, tx, expected, now, stillWanted, handed, way);
  } finally {
    await o.stop?.().catch(() => undefined);
  }
};

/**
 * The wallet's DUST read up to date on this wallet's ledger, or the fee refused. A part that crossed the fork while it
 * was read was read at the fork, so it is read again once the facade is on this ledger.
 */
export async function dustReadOnThisLedger(facade: Pick<OwnWalletFacade, 'dust' | 'state'>, stillWanted: (() => boolean) | undefined): Promise<void> {
  const readUp = async (): Promise<void> => {
    try {
      await untilItHasReadTheChain([facade.dust], { stillWanted });
    } catch (e) {
      throw new FeeRefused(`this wallet could not read its DUST up to date (${said(e)}), so it paid nothing and sent nothing`);
    }
  };
  await readUp();
  if (!await readOnThisWalletsLedger(facade, readUp)) throw new FeeRefused(NOT_ON_THIS_WALLETS_LEDGER);
}

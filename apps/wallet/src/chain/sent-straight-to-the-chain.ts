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
import type { SignSegment } from '@midnightntwrk/wallet-sdk-facade';
import { ourServiceTookNothing, serviceNotReached, type ChainCall } from '../../../../packages/web-shared/src/hand-over.js';
import {
  refusalForMerge, refusalForPayout, refusalForPublicPayout, refusalForSecretCopy, refusalForSetNonceSecret,
} from '../../../../src/wiring/vault-submission.js';
import {
  base64FromBytes, bytesFromBase64, untilItHasReadTheChain, whyThePaymentFailed, type BalanceDoors, type LedgerForBalancing, type WalletPartForBalancing,
} from './balance-for-page.js';

/** The person's own wallet, as it pays a call's fee and sends it: the SDK's own facade, its dust part started. */
export interface OwnWalletFacade {
  readonly dust?: WalletPartForBalancing;
  balanceUnboundTransaction(
    tx: never, keys: { shieldedSecretKeys: unknown; dustSecretKey: unknown }, options: { ttl: Date; tokenKindsToBalance: 'dust'[] },
  ): Promise<unknown>;
  signRecipe(recipe: never, signSegment: SignSegment): Promise<unknown>;
  finalizeRecipe(recipe: never): Promise<unknown>;
  submitTransaction(tx: never): Promise<unknown>;
  revert(recipe: never): Promise<void>;
}

/** What paying a call's fee asks of this wallet. */
export interface OwnWalletDoors {
  readonly ledger: () => Promise<LedgerForBalancing>;
  readonly facade: () => Promise<OwnWalletFacade>;
  readonly keys: () => { shieldedSecretKeys: unknown; dustSecretKey: unknown };
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
  ledger: doors.ledger, keys: doors.keys, signSegment: doors.signSegment, ...(doors.stop === undefined ? {} : { stop: doors.stop }),
  facade: async () => {
    const f = (await doors.facade()) as unknown as OwnWalletFacade & { readonly dust: { start(key: unknown): Promise<void> } };
    await f.dust.start(doors.keys().dustSecretKey);
    return f;
  },
});

/** How long the fee the wallet adds holds good, as the wallet pays for a page's call. */
const FEE_TTL_MS = 20 * 60_000;

const said = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\.\s*$/u, '');
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

/**
 * **WHY WHAT THE WALLET ADDS TO PAY THE FEE IS MORE THAN THE FEE, OR NULL WHEN
 * IT IS NOT**: the call is left as it was, and what is added spends DUST and
 * does nothing else - no call, no coin, no public money, no DUST registered.
 */
export function moreThanTheFeeRefusal(recipe: unknown, call: unknown): string | null {
  const r = recipe as { readonly baseTransaction?: unknown; readonly balancingTransaction?: TxLike | null } | null;
  if (r === null || typeof r !== 'object') return 'this wallet could not read what it was about to add';
  if (r.baseTransaction !== call) return 'this wallet was about to change the call itself';
  const fee = r.balancingTransaction;
  if (fee === undefined || fee === null) return 'this wallet added nothing to pay the fee';
  if (typeof fee !== 'object' || !readable(fee)) return 'this wallet could not read what it was about to add';
  if (!noShieldedOffer(fee)) return 'this wallet was about to spend or make a coin as well as the fee';
  let spends = 0;
  for (const intent of fee.intents?.values() ?? []) {
    if ((intent.actions?.length ?? 0) > 0) return 'this wallet was about to make a call as well as pay the fee';
    if (!noPublicOffer(intent)) return 'this wallet was about to move public money as well as pay the fee';
    if ((intent.dustActions?.registrations?.length ?? 0) > 0) return 'this wallet was about to register DUST as well as pay the fee';
    spends += intent.dustActions?.spends?.length ?? 0;
  }
  return spends > 0 ? null : 'this wallet added nothing to pay the fee';
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
 * call, written out as base64 (absent, the person's own wallet hands it to the network); and what to tell when the
 * person's own DUST paid because sponsorship was down or could not be reached, and when whoever submits could not
 * be reached and the wallet handed the call to the network itself. The sponsorship answers the finished call and,
 * when it holds a turn for it, how to tell it this wallet is done with that call. `handedOver` is told the moment
 * the call leaves this wallet, once per call, so the action can count a send the page never saw.
 */
export interface FeeAndSubmit {
  readonly sponsor?: (tx: string, expected: ChainCall) => Promise<{ readonly tx: string; readonly done?: () => Promise<void> }>;
  readonly submit?: (finished: string) => Promise<void>;
  readonly ownDustPaid?: () => void;
  readonly unreached?: () => void;
  readonly handedOver?: () => void;
}

/** A send the wallet refused before handing anything to the network: nothing was paid and nothing was sent. */
export class FeeRefused extends Error {
  readonly nothingWasSent = true as const;
  constructor(message: string) { super(message); this.name = 'FeeRefused'; }
}

/** What one send tells its step: whether the call was handed over, and whether the wallet had too little DUST to pay for it. */
export interface Handed { over: boolean; noDust?: boolean }

/**
 * **ONE CALL, ITS FEE ONLY PAID, AND HANDED OVER**: the proven call read and held
 * to `notWhatIsSentRefusal`. With `way.sponsor`, the sponsorship is asked first;
 * what it hands back is held to `onlyTheFeeAddedRefusal` and refused whole if it
 * fails, never paid again from the person's DUST, and the sponsorship is told
 * the wallet is done with it whether it was sent or not. A refusal from the
 * sponsorship is the answer, in its words; only when the sponsorship is down
 * (`ourServiceTookNothing`), could not be reached (`serviceNotReached`: it never
 * submits, so nothing of the call is out), or there is none, is the wallet's
 * DUST read up to date, the fee added and
 * held to `moreThanTheFeeRefusal`, signed and finished. The finished call goes to
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
  if (way.sponsor !== undefined) {
    let back: { readonly tx: string; readonly done?: () => Promise<void> } | null;
    try {
      back = await way.sponsor(tx, expected);
    } catch (e) {
      if (!ourServiceTookNothing(e) && !serviceNotReached(e)) {
        throw new FeeRefused(`fee sponsorship refused this call (${said(e)}), so nothing was paid or sent. What it says is what resolves it`);
      }
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
  /* Told only once the call has gone, so the window never says the person's DUST paid for a call it did not send. */
  const ownDust = way.sponsor !== undefined;
  let facade: OwnWalletFacade;
  try {
    facade = await o.facade();
  } catch (e) {
    throw new FeeRefused(`this wallet could not open its DUST to pay the fee (${said(e)}), so it paid nothing and sent nothing`);
  }
  try {
    await untilItHasReadTheChain([facade.dust], { stillWanted });
  } catch (e) {
    throw new FeeRefused(`this wallet could not read its DUST up to date (${said(e)}), so it paid nothing and sent nothing`);
  }
  let recipe: unknown;
  try {
    recipe = await facade.balanceUnboundTransaction(call as never, o.keys(), { ttl: new Date(now() + FEE_TTL_MS), tokenKindsToBalance: ['dust'] });
  } catch (e) {
    /* Nothing is booked when balancing throws: the wallet's DUST is changed only once a fee is added whole. */
    if (whyThePaymentFailed(e) === 'not-enough') {
      handed.noDust = true;
      throw new FeeRefused('your wallet holds too little DUST to pay the network fee, so it paid nothing and sent nothing');
    }
    throw new FeeRefused(`this wallet could not add the fee (${said(e)}), so it paid nothing and sent nothing`);
  }
  try {
    const more = moreThanTheFeeRefusal(recipe, call);
    if (more !== null) throw new FeeRefused(`${more}, so it paid nothing and sent nothing`);
    const signed = await facade.signRecipe(recipe as never, o.signSegment());
    const finished = await facade.finalizeRecipe(signed as never);
    const written = way.submit === undefined ? null : base64FromBytes((finished as { serialize(): Uint8Array }).serialize());
    if (!stillWanted()) throw new FeeRefused('the window was stopped before the call was sent, so this wallet paid nothing and sent nothing');
    handed.over = true;
    way.handedOver?.();
    if (written !== null) await submittedOrStraight(o, way, written, finished, async () => { await facade.submitTransaction(finished as never); });
    else await facade.submitTransaction(finished as never);
    if (ownDust) way.ownDustPaid?.();
  } catch (e) {
    if (handed.over) throw e;
    await facade.revert(recipe as never).catch(() => undefined);
    if (e instanceof FeeRefused) throw e;
    throw new FeeRefused(`this wallet could not sign or finish the call (${said(e)}), so it paid nothing and sent nothing`);
  }
}

/**
 * Whether the very call this wallet finished is on the chain: looked for by every identifier the ledger gives it,
 * which a transaction carrying it keeps whatever fee was merged in beside it. It throws, so nothing is sent again,
 * when the call names no identifier or this wallet cannot read the chain.
 */
export async function onTheChainAlready(o: Pick<OwnWalletDoors, 'landed'>, finished: unknown): Promise<boolean> {
  const ids = (finished as { identifiers?: () => readonly unknown[] } | null)?.identifiers;
  const identifiers = typeof ids === 'function' ? ids.call(finished).map(String) : [];
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
    await submittedOrStraight(o, way, back, finished, async () => { await (await o.facade()).submitTransaction(finished as never); });
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
  await facade.submitTransaction(finished as never);
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
 * moving nothing (`notOneCallRefusal`), or the same check the service holds a vault's call to before it relays it
 * (`refusalForSetNonceSecret`, `refusalForSecretCopy`, `refusalForPayout`, `refusalForMerge`,
 * `refusalForPublicPayout`), so the chain path sends nothing the service's shape checks would refuse. A payout, a
 * merge and a public payout move only the vault's own coins: the wallet still adds DUST alone, held to
 * `moreThanTheFeeRefusal`, so none of the person's own money goes in.
 */
export function notWhatIsSentRefusal(tx: unknown, expected: ChainCall): string | null {
  const vaultCall = (check: (account: string) => string | null): string | null =>
    (expected.account === undefined ? 'it names no account for the vault it calls' : check(expected.account));
  switch (expected.kind) {
    case 'account-call': return notOneCallRefusal(tx, expected.contract, expected.circuit);
    case 'vault-secret': return vaultCall((account) => refusalForSetNonceSecret(tx, { vault: expected.contract, account })) ?? owesMoreThanItsFee(tx);
    case 'vault-copy': return refusalForSecretCopy(tx, { vault: expected.contract }) ?? owesMoreThanItsFee(tx);
    case 'payout': return vaultCall((account) => refusalForPayout(tx, { vault: expected.contract, account }));
    case 'merge': return refusalForMerge(tx, { vault: expected.contract });
    case 'public-payout': return vaultCall((account) => refusalForPublicPayout(tx, { vault: expected.contract, account }));
    default: return 'it is not a kind of call this wallet sends';
  }
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

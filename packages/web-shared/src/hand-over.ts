/**
 * Where a call this device proved goes once it is finished: to our service, which pays its fee and submits it; to
 * the service the company hosts itself, at the address the company chose, which submits it; or straight to the
 * chain from the person's own wallet. On the last two ways the fee is paid by our fee sponsorship, which only adds
 * it, or by the person's own DUST when sponsorship cannot pay. Everything up to this point - reading the chain,
 * opening the proposal, building and proving the call - is the same every way; only the hand-over differs. On every
 * way but ours, our service is still told what it keeps (the proposal's record, filed without the call), and it
 * believes what happened only from its own read of the chain.
 */

import type { VaultCallKind } from '../../../src/wiring/vault-call-checks.js';

/**
 * Which way a finished call goes: through our service, through the company's own service at its address, or
 * straight to the chain.
 */
type HandOverWay = 'service' | 'chain' | 'company-service';

/**
 * What a call sent straight to the chain must be, checked by the wallet before it pays anything, as the service
 * checks what it relays: one call to the company's account; a vault's first secret set with the account's approval
 * of it, or one sealed copy of it written; a vault's retire asking the account to retire it; one public token taken off
 * a vault's list before its retire; and a payout, a merge or a public payout of the vault's own coins. The vault calls
 * are `VaultCallKind`, the one table the service and the wallet both check them by.
 */
type ChainCallKind = 'account-call' | VaultCallKind;

export interface ChainCall {
  readonly kind: ChainCallKind;
  /** The contract the call is made to: the company's account, or the vault. */
  readonly contract: string;
  readonly circuit: string;
  /** For a call on a vault, the company's account the vault is pinned to. */
  readonly account?: string;
}

export interface HandOver {
  readonly path: HandOverWay;
  /** On the company's own service, its address, as the company chose it. */
  readonly at?: string;
  /**
   * Set when no call may be handed over this way: what refuses it, and what resolves it. Every hand-over then
   * refuses before anything is sent; an action that hands nothing over is not stopped by it.
   */
  readonly refused?: string;
  /**
   * Sends a finished call, its fee only paid (by our fee sponsorship, or the person's own DUST when it cannot pay):
   * from the person's own wallet, or to the company's own service. Absent where neither is reached.
   */
  readonly toChain?: (tx: string, call: ChainCall) => Promise<void>;
  /**
   * On our service's way: the way straight to the chain, taken when our service answers that it took nothing because
   * it could not (`ourServiceTookNothing`), or when it could not be reached at all (`ServiceNotReached`), and what to
   * tell when it is taken. When the call went out and no answer came back, it is taken only after `landed` has read
   * the chain and not found the call there; a call our service answered for in any other way is never sent again.
   */
  readonly fallback?: {
    readonly toChain: (tx: string, call: ChainCall) => Promise<void>;
    /**
     * Tells the window the call went straight to the chain, because the service could not take it or could not be
     * reached; told only once the call has gone.
     */
    readonly fellBack: (why?: 'unreached') => void;
    /** Whether a call of this hand-over has gone straight to the chain instead of through our service. */
    readonly taken: () => boolean;
    /**
     * Whether this very call is already on the chain, read by the wallet itself, never by the service. It throws when
     * the chain cannot be read; absent where this device cannot read it, and then a call that may have reached the
     * service is never sent again.
     */
    readonly landed?: (tx: string, call: ChainCall) => Promise<boolean>;
  };
}

/** The hand-over every action uses unless it is told otherwise. */
export const THROUGH_THE_SERVICE: HandOver = Object.freeze({ path: 'service' as const });

/**
 * Whether our service answered that it took nothing because it could not: it says nothing was sent, and either it
 * was unavailable (502, 503, 504) or its fee sponsorship could not pay (`fee-not-paid`). A refusal of the call
 * itself, or anything that cannot say nothing was sent, is not: the call is then never sent another way.
 */
export const ourServiceTookNothing = (e: unknown): boolean => {
  const x = e as { nothingWasSent?: unknown; status?: unknown; code?: unknown } | null;
  if (x === null || typeof x !== 'object' || x.nothingWasSent !== true) return false;
  return x.status === 502 || x.status === 503 || x.status === 504 || x.code === 'fee-not-paid' || serviceNotReached(e);
};

/**
 * The company's service could not be reached: no answer came back at all, as when the connection was refused, the
 * name did not resolve, or the connection dropped or ran out of time. `nothingWasSent` is true only when the call
 * carried nothing to hand over; when it carried a transaction, the transaction may have reached the service, and
 * whether it did is read from the chain, never assumed.
 */
export class ServiceNotReached extends Error {
  readonly unreached = true as const;
  readonly nothingWasSent: boolean;
  constructor(message: string, nothingWasSent: boolean) {
    super(message);
    this.name = 'ServiceNotReached';
    this.nothingWasSent = nothingWasSent;
  }
}

/** Whether an error says the service could not be reached; read by its mark, so it holds across the page and the wallet. */
export const serviceNotReached = (e: unknown): e is { readonly unreached: true; readonly nothingWasSent: boolean; readonly message: string } =>
  e !== null && typeof e === 'object' && (e as { unreached?: unknown }).unreached === true;

/** Refused before anything was paid or sent. */
export class NotHandedOver extends Error {
  readonly nothingWasSent = true as const;
  constructor(message: string) { super(message); this.name = 'NotHandedOver'; }
}

interface HandOverStep<T> {
  readonly tx: string;
  readonly call: ChainCall;
  /** The service's route, which keeps its record and sends the call in one answer. */
  readonly viaService: () => Promise<T>;
  /** On the chain path, what the service keeps before the call goes: a record filed without the call. */
  readonly before?: () => Promise<unknown>;
  /** On the chain path, the answer once the call has gone: the service's record, read against the chain. */
  readonly after: () => Promise<T>;
}

/**
 * Hands a finished call over the way `over` names, and returns what our service then says. On the chain path the
 * call is checked and sent by the person's wallet, and on the company's own service it is checked and sent to that
 * address; a failure before it leaves this device carries `nothingWasSent`, so the action can say nothing was sent,
 * and a failure of our service's record once it was sent is `SentStraightNotRecorded`, never said as not sent. On
 * our service's way with a fallback, a call our service answered it took nothing of because it could not
 * (`ourServiceTookNothing`), or that never reached it, goes straight to the chain instead, and the fallback is told.
 * A call that went out with no answer back is first looked for on the chain: found, it is not sent again; not found,
 * it goes straight to the chain, where the ledger takes one call only once. Any other failure is the answer, so a
 * call the service answered for is never sent again.
 */
export async function handedOver<T>(over: HandOver | undefined, step: HandOverStep<T>): Promise<T> {
  if (over?.refused !== undefined) throw new NotHandedOver(over.refused);
  if (over === undefined || over.path === 'service') {
    const fallback = over?.fallback;
    if (fallback === undefined) return step.viaService();
    try {
      return await step.viaService();
    } catch (e) {
      if (ourServiceTookNothing(e)) {
        const why = serviceNotReached(e) ? 'unreached' as const : undefined;
        return sentAnotherWay(fallback.toChain, 'chain', step, () => fallback.fellBack(why));
      }
      if (!serviceNotReached(e) || fallback.landed === undefined) throw e;
      return sentUnlessLanded(fallback, e, step);
    }
  }
  if (over.toChain === undefined) {
    throw new NotHandedOver(over.path === 'chain'
      ? 'this device reaches no wallet to send the call straight to the chain. Nothing was sent.'
      : 'this device cannot send the call to the company\'s own service. Nothing was sent.');
  }
  return sentAnotherWay(over.toChain, over.path === 'chain' ? 'chain' : 'company-service', step);
}

const MAY_HAVE_REACHED = 'the call may have reached the company\'s service, which did not answer';

/*
 * A call that went out to our service with no answer back: read from the chain whether it is there. There, it is
 * not sent again and our service's record of it is read; not there, it goes straight to the chain. Should that send
 * fail, the chain is read once more, since the first may have landed meanwhile and the ledger then refuses the second.
 */
async function sentUnlessLanded<T>(
  fallback: NonNullable<HandOver['fallback']>, unanswered: { readonly message: string }, step: HandOverStep<T>,
): Promise<T> {
  const landed = fallback.landed!;
  const onChain = async (): Promise<boolean> => {
    try {
      return await landed(step.tx, step.call);
    } catch (e) {
      throw new SentStraightNotRecorded(`${MAY_HAVE_REACHED}, and this wallet could not read the chain to see whether it is there: `
        + `${(e as Error)?.message ?? String(e)}`, 'unclear');
    }
  };
  if (await onChain()) return recordedOnChain(step);
  try {
    if (step.before !== undefined) await step.before();
  } catch (e) {
    throw new SentStraightNotRecorded(`${MAY_HAVE_REACHED}, and the record it keeps could not be filed, so this wallet sent `
      + `nothing more: ${(e as Error)?.message ?? String(e)}`, 'unclear');
  }
  try {
    await fallback.toChain(step.tx, step.call);
  } catch (e) {
    if (await onChain().catch(() => false)) return recordedOnChain(step);
    if ((e as { nothingWasSent?: unknown } | null)?.nothingWasSent === true) {
      throw new SentStraightNotRecorded(`${MAY_HAVE_REACHED} (${unanswered.message}), and this wallet could not send it straight `
        + `to the chain: ${(e as Error)?.message ?? String(e)}`, 'unclear');
    }
    throw e;
  }
  fallback.fellBack('unreached');
  try {
    return await step.after();
  } catch (e) {
    throw new SentStraightNotRecorded((e as Error)?.message ?? String(e), 'chain');
  }
}

/* The call is on the chain already: our service's record of it is read, and if it cannot be, it is never said as not sent. */
async function recordedOnChain<T>(step: HandOverStep<T>): Promise<T> {
  try {
    return await step.after();
  } catch (e) {
    throw new SentStraightNotRecorded((e as Error)?.message ?? String(e), 'on-chain');
  }
}

/*
 * The record kept, the call handed over, and our service's answer read; once handed over, never said as not sent.
 * `sent` is told only once the call has gone, so the window never says a call went a way it did not.
 */
async function sentAnotherWay<T>(
  toChain: (tx: string, call: ChainCall) => Promise<void>, how: 'chain' | 'company-service', step: HandOverStep<T>,
  sent?: () => void,
): Promise<T> {
  if (step.before !== undefined) await step.before();
  await toChain(step.tx, step.call);
  sent?.();
  try {
    return await step.after();
  } catch (e) {
    throw new SentStraightNotRecorded((e as Error)?.message ?? String(e), how);
  }
}

/**
 * A call sent straight to the chain, handed to the company's own service, found already on the chain, or that may
 * have reached a service that did not answer, after which our service's record could not be read or written, or
 * nothing more could be done. The call may have been sent: it is never said as not sent, so it is not sent again.
 */
export class SentStraightNotRecorded extends Error {
  readonly nothingWasSent = false as const;
  constructor(said: string, how: 'chain' | 'company-service' | 'on-chain' | 'unclear' = 'chain') {
    const why = said.replace(/\s*Nothing was [a-z ]+\.?/giu, '').replace(/\.\s*$/u, '');
    super(`${how === 'unclear' ? `${why}. ` : `${how === 'chain'
      ? 'the call was sent straight to the chain, and the company\'s service'
      : how === 'on-chain'
        ? 'the call is on the chain, and the company\'s service'
        : 'the call was handed to the company\'s own service, and the service that keeps the company\'s records'} `
      + `could not say where it stands (${why}). `}`
      + 'Do not send it again: open it later, and it will say where it stands on the chain.');
    this.name = 'SentStraightNotRecorded';
  }
}

/**
 * Whether our service did not submit this hand-over's calls: it goes another way, or a call of it fell back to the
 * chain. Our service then keeps what it would have kept on its own way only when it is told.
 */
export const notThroughOurService = (over: HandOver | undefined): boolean =>
  over !== undefined && (over.path !== 'service' || over.fallback?.taken() === true);

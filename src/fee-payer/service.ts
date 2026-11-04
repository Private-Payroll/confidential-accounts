/**
 * THE FEE PAYER, AS A SERVICE OF ITS OWN.
 *
 * The web process never holds the wallet that pays. It holds a client that asks
 * this service to add the fee to a transaction the company has already
 * balanced and signed, and later asks it to submit what it added the fee to -
 * or hands what it added the fee to back to a device, which submits it itself.
 * The funded wallet, its keys and its DUST live in the process that serves
 * this, and nowhere else.
 *
 * -- WHY A SEPARATE PROCESS ------------------------------------------------
 *
 * Bringing a funded wallet up means a seed, a proof server, a sync and a wait
 * for DUST. A web process that did that on boot would be a web process that can
 * spend because it was started, and everything it serves would share an address
 * space with the key. Kept here, what the web process can do with our DUST is
 * exactly what the three calls below allow: add a capped fee to a transaction,
 * submit what this service built, or let go of it.
 *
 * -- WHAT A CALLER CAN AND CANNOT MAKE IT DO ------------------------------
 *
 * **IT SUBMITS ONLY WHAT IT BALANCED ITSELF.** A submission names a booking
 * this service handed out, and the transaction submitted is the one it kept -
 * not bytes the caller sends back.
 *
 * **ONE TRANSACTION THIS SERVICE SUBMITS AT A TIME, FROM THE BALANCE UNTIL
 * ITS SUBMISSION OR RELEASE HAS FINISHED.** While such a booking is outstanding
 * - held, being submitted or being released - a second one is refused by name,
 * and a booking is submitted or released once, never both. The wallet books
 * coins while it balances, so only one balance runs at a time, and a release
 * racing a submission would mark spent coins free.
 *
 * **A TRANSACTION HANDED BACK TO BE SUBMITTED ELSEWHERE HOLDS UP NONE OF
 * THAT.** It is booked under its own rules: one per company at a time, at most
 * `MOST_HANDED_BACK` in all, and a deadline at most five minutes away, since
 * whoever is handed it submits it at once. Its holder says when it is done with
 * it (`/done`), which frees its company's turn and releases nothing; a release
 * asked for by name never releases it either, because it may still land.
 *
 * **EVERY BOOKING NOBODY SUBMITS HERE IS SETTLED BY WHAT THE CHAIN SHOWS.**
 * Once the chain shows its transaction, wherever it was submitted, the booking
 * is dropped and its DUST is never released as free; it is released only when
 * it can no longer land: the chain read up to date, not showing it, and the
 * newest finalized block's time past its deadline. This is checked at the
 * deadline, again every half minute while the chain cannot say, and before the
 * next booking is made. A deadline further out than thirty minutes is refused.
 * **A SUBMISSION THAT NEVER SETTLES DOES HOLD IT**,
 * until this process restarts: nothing here can tell a submission that will
 * never settle from a slow one, and letting the next one go while it might
 * still land is the race this rule exists to prevent.
 *
 * **A BOOKING THAT WAS SUBMITTED IS REMEMBERED AS SUBMITTED**, so asking again
 * is answered as a transaction that may have landed, never as nothing sent.
 *
 * **EVERY PAYMENT GOES THROUGH A FEE PAYER WITH A CEILING.** The service is
 * given a way to make one, not a wallet, and each booking gets its own, so the
 * company and the estimate a payment is recorded with belong to that payment.
 *
 * **NOTHING ANSWERS WITHOUT THE SHARED SECRET**, and nothing says why beyond
 * the status, so an unauthenticated caller learns nothing about what is here.
 */
import express from 'express';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import type { FeeSponsor } from '../midnight/ledger.js';
import { saysNothingWasSent } from '../core/jobs.js';
import { feeAnswerCodeOf } from '../midnight/sponsor.js';

/** How a transaction crosses the wire, in both directions. */
export interface TransactionCodec {
  read(bytes: Uint8Array): unknown | Promise<unknown>;
  write(tx: unknown): Uint8Array | Promise<Uint8Array>;
}

export interface FeePayerDeps {
  /**
   * A fee payer for one payment. Called once per booking, over the one funded
   * wallet this process holds, and never with anything the caller supplied.
   */
  newPayer(): FeeSponsor;
  /** Reads the company's balanced transaction and writes the one with the fee added. */
  codec: TransactionCodec;
  /** The secret a caller must present. Compared in constant time. */
  secret: string;
  /** Remaining DUST and NIGHT, reported to the caller that asks. */
  capacity(): Promise<{ dust: bigint; night: bigint }>;
  /** The clock, for the deadline rules. */
  now?: () => number;
  /** Schedules the settling of a booking: at its deadline, then again while the chain cannot say. Answers a cancel. */
  schedule?: (ms: number, run: () => void) => () => void;
}

/** The furthest ahead a booking's deadline may be. */
export const LONGEST_DEADLINE_MS = 30 * 60_000;

/** How long a booking the chain cannot yet speak for waits before it is asked again. */
export const ASK_THE_CHAIN_AGAIN_MS = 30_000;

/**
 * The furthest ahead a handed-back booking's deadline may be. Whoever is handed the transaction submits it at
 * once, so its DUST is held only as long as a submission takes.
 */
export const HANDED_BACK_DEADLINE_MS = 5 * 60_000;

/** How many handed-back bookings may stand at once, across every company, so they cannot hold all the DUST. */
export const MOST_HANDED_BACK = 8;

/** The shortest secret this service will run with. */
export const SHORTEST_SECRET = 32;

interface Booking {
  readonly payer: FeeSponsor;
  readonly finalised: unknown;
  /** Stops the timer that settles it; replaced each time that timer is set again. */
  cancel: () => void;
  /** Held until one of the two ways out starts; then it is that way's alone. */
  state: 'held' | 'submitting' | 'releasing';
  /** When the booking may be let go, in the clock's milliseconds. */
  readonly deadline: number;
  /** Handed back to be submitted elsewhere, and for which company; never released on anyone's word. */
  readonly handedBack: boolean;
  readonly company: string;
  /** For a handed-back booking: its holder is done with it, so it no longer counts against its company. */
  done: boolean;
}

/**
 * Whether a presented secret is the right one.
 *
 * **CONSTANT TIME OVER EQUAL LENGTHS, AND A DIGEST FIRST SO THE LENGTHS ARE
 * ALWAYS EQUAL.** A comparison that stops at the first difference, or refuses
 * early on length, tells a caller how close it got.
 */
export const secretMatches = (presented: string | undefined, secret: string): boolean => {
  if (typeof presented !== 'string') return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
};

/**
 * The refusal for a request to add a fee, or `null` when it may go ahead.
 *
 * Pure, so every branch can be read without a wallet.
 */
export function refusalForFeeRequest(
  body: unknown,
  now: number,
  busy: boolean,
): string | null {
  if (busy) {
    return 'the fee payer is already paying for another transaction, and it pays for one at '
      + 'a time. Nothing was booked. Send this again once that transaction has been submitted '
      + 'or released.';
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.company !== 'string' || b.company.length === 0 || b.company.length > 200) {
    return 'this request does not say which company the transaction is for, and a fee is '
      + 'never paid without that record. Nothing was booked.';
  }
  if (typeof b.tx !== 'string' || b.tx.length === 0) {
    return 'this request carries no transaction to add a fee to. Nothing was booked.';
  }
  const ttl = typeof b.ttl === 'string' ? Date.parse(b.ttl) : NaN;
  if (!Number.isFinite(ttl)) {
    return 'this request carries no deadline, and a fee is not added to a transaction that '
      + 'never expires. Nothing was booked.';
  }
  if (ttl <= now) {
    return 'this transaction\'s deadline has already passed, so there is nothing to pay for. '
      + 'Nothing was booked.';
  }
  if (ttl - now > LONGEST_DEADLINE_MS) {
    return 'this transaction\'s deadline is more than thirty minutes away, and the fee payer '
      + 'does not hold DUST for a transaction that long. Nothing was booked. Build it again '
      + 'with a nearer deadline.';
  }
  return null;
}

/**
 * The refusal for a request to add a fee and hand the transaction back, given the handed-back bookings standing,
 * or `null`. One per company at a time, at most `MOST_HANDED_BACK` in all, and a deadline no further than
 * `HANDED_BACK_DEADLINE_MS`; none of it ever waits on, or holds up, a fee this service submits itself.
 */
export function refusalToHandBack(
  body: unknown, now: number, standing: readonly { readonly company: string; readonly done: boolean }[],
): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const ttl = typeof b.ttl === 'string' ? Date.parse(b.ttl) : NaN;
  if (Number.isFinite(ttl) && ttl - now > HANDED_BACK_DEADLINE_MS) {
    return 'a transaction handed back to be submitted elsewhere may have a deadline at most five minutes away. '
      + 'Nothing was booked. Build it again with a nearer deadline.';
  }
  if (standing.some((x) => x.company === b.company && !x.done)) {
    return 'the fee payer is already holding a transaction it handed back for this company. Nothing was booked. '
      + 'Send this again once that one has been submitted.';
  }
  if (standing.length >= MOST_HANDED_BACK) {
    return 'the fee payer is holding as many handed-back transactions as it holds at once. Nothing was booked. '
      + 'Send this again in a few minutes.';
  }
  return null;
}

const fromBase64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const message = (e: unknown): string => String((e as { message?: unknown })?.message ?? e);

/**
 * The service. Serve it on this machine's loopback, or behind something that
 * adds transport security; the secret travels in a header.
 */
export function feePayerApp(deps: FeePayerDeps): express.Express {
  if (typeof deps.secret !== 'string' || deps.secret.length < SHORTEST_SECRET) {
    throw new Error(
      `the fee payer was about to be served with a shared secret shorter than ${SHORTEST_SECRET} `
      + 'characters, so it was not served. The secret is all that stands between this service '
      + 'and anyone who can reach it.');
  }
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((ms: number, run: () => void) => {
    const t = setTimeout(run, ms);
    t.unref?.();
    return () => clearTimeout(t);
  });
  const bookings = new Map<string, Booking>();
  /** Every booking this process has submitted, so a second ask is not told nothing was sent. */
  const submitted = new Set<string>();
  /* Set while a booking is being made, so two requests cannot both pass the busy check. */
  let balancing = false;

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.use((req, res, next) => {
    const header = req.headers.authorization;
    const presented = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length) : undefined;
    if (!secretMatches(presented, deps.secret)) {
      res.status(401).end();
      return;
    }
    next();
  });

  /*
   * **A HELD BOOKING IS SETTLED BY WHAT THE CHAIN SHOWS.** Shown on the chain, it is dropped and nothing is
   * released: its DUST is spent, wherever the transaction was submitted. It is released only when the fee payer's
   * chain read says it can no longer land: up to date, not showing it, and the latest finalized block's time past
   * its deadline (`landed` answering false). Otherwise it stays held. A fee payer that cannot read the chain
   * (`landed` absent) is released at its deadline by the clock. A release that failed leaves it held.
   */
  const settle = async (id: string, held: Booking, due = false): Promise<void> => {
    if (held.state !== 'held') return;
    held.state = 'releasing';
    try {
      const shown = held.payer.landed === undefined
        ? (due || held.deadline <= now() ? false : null)
        : await held.payer.landed(held.finalised, new Date(held.deadline)).catch(() => null);
      if (shown === true) {
        bookings.delete(id);
        held.cancel();
        return;
      }
      if (shown === null) {
        held.state = 'held';
        return;
      }
      await held.payer.release(held.finalised);
      bookings.delete(id);
      held.cancel();
    } catch {
      held.state = 'held';
    }
  };

  /* Every held booking is settled before anything new is booked. */
  const settleAll = async (): Promise<void> => {
    for (const [id, held] of [...bookings]) await settle(id, held);
  };

  /* At the deadline, and every half minute after while the booking is still held. */
  const settleAt = (id: string, held: Booking, ms: number): void => {
    held.cancel = schedule(Math.max(0, ms), () => {
      if (bookings.get(id) !== held) return;
      void settle(id, held, true).then(() => {
        if (bookings.get(id) === held && held.state === 'held') settleAt(id, held, ASK_THE_CHAIN_AGAIN_MS);
      });
    });
  };

  app.post('/fee', async (req, res) => {
    if (!balancing) await settleAll();
    const handedBack = (req.body as { handedBack?: unknown } | null)?.handedBack === true;
    const all = [...bookings.values()];
    const refusal = refusalForFeeRequest(req.body, now(), balancing || (!handedBack && all.some((x) => !x.handedBack)))
      ?? (handedBack ? refusalToHandBack(req.body, now(), all.filter((x) => x.handedBack)) : null);
    if (refusal) {
      res.status(409).json({ nothingWasSent: true, error: refusal });
      return;
    }
    balancing = true;
    const { company, tx, ttl } = req.body as { company: string; tx: string; ttl: string };
    const deadline = new Date(ttl);
    const payer = deps.newPayer();
    try {
      payer.payingFor(company);
      const finalised = await payer.addFeeAndFinalise(await deps.codec.read(fromBase64(tx)), deadline);
      const booking = randomUUID();
      const held: Booking = {
        payer, finalised, cancel: () => undefined, state: 'held', deadline: deadline.getTime(), handedBack, company, done: false,
      };
      bookings.set(booking, held);
      settleAt(booking, held, deadline.getTime() - now());
      let written: Uint8Array;
      try {
        written = await deps.codec.write(finalised);
      } catch (e) {
        bookings.delete(booking);
        held.cancel();
        try { await payer.release(finalised); } catch { /* the write failure is the error */ }
        throw e;
      }
      res.json({ booking, tx: toBase64(written) });
    } catch (e) {
      /*
       * **NOTHING ON THIS ROUTE SUBMITS**, so every failure here is a
       * transaction that was not sent. A refusal keeps its own status so the
       * caller can tell a decision from a fault.
       */
      res.status(saysNothingWasSent(e) ? 422 : 502).json({ nothingWasSent: true, error: message(e) });
    } finally {
      balancing = false;
    }
  });

  app.post('/submit', async (req, res) => {
    const id = (req.body as { booking?: unknown })?.booking;
    if (typeof id === 'string' && submitted.has(id)) {
      res.status(409).json({
        nothingWasSent: false,
        error: 'this transaction was already submitted by the fee payer, and it was not sent '
          + 'again. It may have landed: check the chain before building it again.',
      });
      return;
    }
    const held = typeof id === 'string' ? bookings.get(id) : undefined;
    if (!held || held.state !== 'held') {
      res.status(held ? 409 : 404).json({
        nothingWasSent: true,
        error: held
          ? 'the fee payer is releasing this transaction, so it was not sent. Build it again.'
          : 'the fee payer holds no such transaction: it was released at its deadline, or was '
            + 'never booked here. Nothing was sent. Build the transaction again.',
      });
      return;
    }
    /* Marked before the submission: from here the fee payer's own submit owns the booking. */
    held.state = 'submitting';
    submitted.add(id as string);
    held.cancel();
    try {
      const ref = await held.payer.submit(held.finalised);
      res.json({ ref: ref.ref, at: ref.at, ...(ref.transactionHash ? { transactionHash: ref.transactionHash } : {}) });
    } catch (e) {
      /* A refusal the fee payer established came at the node's door is nothing sent, with its code; the outcome of any other is not known. */
      const code = feeAnswerCodeOf(e);
      if (code !== null) {
        res.status(422).json({ nothingWasSent: true, code, error: message(e) });
        return;
      }
      res.status(502).json({ nothingWasSent: false, error: message(e) });
    } finally {
      /* Only now may the next transaction be balanced. */
      bookings.delete(id as string);
    }
  });

  /*
   * **A HANDED-BACK BOOKING'S HOLDER SAYS IT IS DONE WITH IT**, submitted or not. It then no longer counts against
   * its company, and nothing is released: the transaction may still land, so its DUST waits for the chain.
   */
  app.post('/done', (req, res) => {
    const id = (req.body as { booking?: unknown })?.booking;
    const held = typeof id === 'string' ? bookings.get(id) : undefined;
    if (held?.handedBack === true) held.done = true;
    res.json({ done: held?.handedBack === true });
  });

  app.post('/release', async (req, res) => {
    const id = (req.body as { booking?: unknown })?.booking;
    const held = typeof id === 'string' ? bookings.get(id) : undefined;
    if (!held || held.state !== 'held') {
      /* Nothing held here, or it is already on its way out by the other door. */
      res.json({ released: false });
      return;
    }
    if (held.handedBack) {
      /* Its transaction is in someone else's hands and may still land: only the chain releases it. */
      held.done = true;
      res.json({ released: false, done: true });
      return;
    }
    held.state = 'releasing';
    try {
      /* A transaction the chain already shows spent its DUST: dropped, never released. */
      if (held.payer.landed !== undefined && await held.payer.landed(held.finalised, new Date(held.deadline)).catch(() => null) === true) {
        bookings.delete(id as string);
        held.cancel();
        res.json({ released: false, landed: true });
        return;
      }
      await held.payer.release(held.finalised);
      bookings.delete(id as string);
      held.cancel();
      res.json({ released: true });
    } catch (e) {
      /* Held again, so a later release can find it; the deadline still releases it. */
      held.state = 'held';
      res.status(502).json({ released: false, error: message(e) });
    }
  });

  app.get('/capacity', async (_req, res) => {
    try {
      const { dust, night } = await deps.capacity();
      res.json({ dust: String(dust), night: String(night) });
    } catch (e) {
      res.status(502).json({ error: message(e) });
    }
  });

  return app;
}

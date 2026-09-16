/**
 * THE FEE PAYER, AS A SERVICE OF ITS OWN.
 *
 * The web process never holds the wallet that pays. It holds a client that asks
 * this service to add the fee to a transaction the company has already
 * balanced and signed, and later asks it to submit what it added the fee to.
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
 * **ONE TRANSACTION AT A TIME, FROM THE BALANCE UNTIL ITS SUBMISSION OR
 * RELEASE HAS FINISHED.** While a booking is outstanding - held, being
 * submitted or being released - a second one is refused by name, and a booking
 * is submitted or released once, never both. The wallet books coins while it
 * balances, and a release racing a submission would mark spent coins free. A
 * booking nobody submits is released at its deadline - and, if that release
 * failed, again before the next booking is made - and a deadline further out
 * than thirty minutes is refused, so a caller that walks away cannot hold the
 * wallet for longer than that. **A SUBMISSION THAT NEVER SETTLES DOES HOLD IT**,
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
  /** Schedules the release of a booking at its deadline. Answers a cancel. */
  schedule?: (ms: number, run: () => void) => () => void;
}

/** The furthest ahead a booking's deadline may be. */
export const LONGEST_DEADLINE_MS = 30 * 60_000;

/** The shortest secret this service will run with. */
export const SHORTEST_SECRET = 32;

interface Booking {
  readonly payer: FeeSponsor;
  readonly finalised: unknown;
  readonly cancel: () => void;
  /** Held until one of the two ways out starts; then it is that way's alone. */
  state: 'held' | 'submitting' | 'releasing';
  /** When the booking may be let go, in the clock's milliseconds. */
  readonly deadline: number;
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
   * **A BOOKING PAST ITS DEADLINE IS LET GO BEFORE ANYTHING NEW IS BOOKED.**
   * The timer at the deadline tries once; if that release failed, the booking
   * is held again, and without this it would hold the wallet until a restart.
   */
  const releaseOverdue = async (): Promise<void> => {
    for (const [id, held] of bookings) {
      if (held.state !== 'held' || held.deadline > now()) continue;
      held.state = 'releasing';
      try {
        await held.payer.release(held.finalised);
        bookings.delete(id);
        held.cancel();
      } catch {
        held.state = 'held';
      }
    }
  };

  app.post('/fee', async (req, res) => {
    if (!balancing) await releaseOverdue();
    const refusal = refusalForFeeRequest(req.body, now(), balancing || bookings.size > 0);
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
      const cancel = schedule(Math.max(0, deadline.getTime() - now()), () => {
        const held = bookings.get(booking);
        /* Only a booking nobody has started to submit or release is let go here. */
        if (!held || held.state !== 'held') return;
        held.state = 'releasing';
        void held.payer.release(held.finalised).then(
          () => { bookings.delete(booking); },
          () => { held.state = 'held'; });
      });
      bookings.set(booking, { payer, finalised, cancel, state: 'held', deadline: deadline.getTime() });
      let written: Uint8Array;
      try {
        written = await deps.codec.write(finalised);
      } catch (e) {
        bookings.delete(booking);
        cancel();
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
      res.json({ ref: ref.ref, at: ref.at });
    } catch (e) {
      /* The outcome of a submission that threw is not known, and it is not reported as nothing sent. */
      res.status(502).json({ nothingWasSent: false, error: message(e) });
    } finally {
      /* Only now may the next transaction be balanced. */
      bookings.delete(id as string);
    }
  });

  app.post('/release', async (req, res) => {
    const id = (req.body as { booking?: unknown })?.booking;
    const held = typeof id === 'string' ? bookings.get(id) : undefined;
    if (!held || held.state !== 'held') {
      /* Nothing held here, or it is already on its way out by the other door. */
      res.json({ released: false });
      return;
    }
    held.state = 'releasing';
    try {
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

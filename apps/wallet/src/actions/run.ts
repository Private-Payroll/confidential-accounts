import { ACT_ENDED_SCHEMA, MOST_ACT_STEPS, readOutcome } from 'midnight-identity/profile/channel';
import type { ActEnded, ActStop, ActingChannel, CalledOver, KeptOver, RelayLabel, StepAt } from 'midnight-identity/profile/channel';
import { intentShapeOf, routeOf, sendsIn, type ActRequest } from 'midnight-identity/profile/request';
import type { Keyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import { keyringMarksFor, openHeldKeyring, SavedKeysRefused, type HeldKeyring, type KeyringMarks } from '../keyring/held-keyring.js';
import { readFor } from '../keyring/read-for-the-page.js';
import { checkedChannel, SecretWouldCross } from '../keyring/nothing-secret-crosses.js';
import { StepRefused, type ActKeyring, type ActionDefinition, type Held, type Words } from './definition.js';

/**
 * RUNS ONE ACTION, STEP BY STEP, OVER THE ONE CHANNEL ITS ASK CAME ON.
 *
 * The wallet keeps its own limits whatever the page asks: its own deadline (a
 * little before the ask's, and never more than `MOST_ACT_MS` from the start),
 * the most steps any action may have, and a wait for each transaction's
 * answer. It stops at any of them, at Stop, at a refused relay, at saved keys
 * it refuses to open or the page did not keep, at a call to the service the
 * action's route list does not name or the page would not make or answer, at
 * a check that does not hold and at a step that fails, and then sends exactly
 * one terminal answer saying where it stopped, how many transactions the page
 * said it handed over and, when the action's entry lists one, what it got to.
 * A transaction is never handed over after Stop.
 *
 * **STOP STARTS NOTHING MORE.** It aborts the step running and refuses any
 * transaction that step would hand over next; a transaction already with the
 * page is waited for, so the count says what became of it. A step that still
 * finishes is counted as finished, and the action stops at the step after it.
 */

/** The longest any action may run, whatever deadline the page wrote. */
export const MOST_ACT_MS = 30 * 60_000;
/** How long before the ask's deadline the wallet stops, so its answer reaches the page while the page still waits. */
export const DEADLINE_MARGIN_MS = 30_000;
/** How often the step running is said again, so the page keeps waiting while a step builds. */
export const HEARTBEAT_MS = 30_000;
/** How long the wallet waits for the page to say what it did with one transaction. */
export const RELAY_PATIENCE_MS = 3 * 60_000;

/**
 * **WHERE THE ACTION'S OWN LINES GO WHEN ITS CALLER NAMES NOWHERE:** the console, as a warning, only in a development
 * build with the console report on (the same test `error-sink.ts` arms itself on), which carries each line to the
 * service's log; nowhere otherwise. Read when the action starts.
 */
const actLogInDevelopment = (): ((line: string) => void) | undefined =>
  (import.meta.env.DEV && import.meta.env.VITE_DEV_ERROR_SINK === '1' ? (line: string) => { console.warn(line); } : undefined);

/** An error as one line, its kind and message; never cut short here, so the console report can still see a key in it. */
const thrown = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Why a step ended the action early. */
export class ActionStopped extends Error {
  readonly why: ActStop;
  constructor(why: ActStop) {
    super(`the action stopped: ${why}`);
    this.name = 'ActionStopped';
    this.why = why;
  }
}

/** Where a running action is, for its screen. */
export interface RunState {
  readonly step: number;
  readonly steps: number;
  /** Transactions the page said it handed to the service. */
  readonly relayed: number;
  /** Transactions handed to the page that it refused or did not answer: it holds them, and may still send them. */
  readonly unconfirmed: number;
  /** What the action has told so far, so a passed step that had nothing to do is listed as such. */
  readonly told?: Readonly<Record<string, string | number>>;
}

export interface RunOf {
  readonly definition: ActionDefinition;
  readonly request: ActRequest;
  readonly channel: ActingChannel;
  readonly held: Held;
  /** Aborted when the person presses Stop. */
  readonly stop: AbortSignal;
  readonly now?: () => number;
  readonly watch?: (state: RunState) => void;
  /** Where the highest count of writes of each person's saved keys is kept; this wallet's own storage if not given. */
  readonly marks?: KeyringMarks;
  /**
   * Where the lines only the wallet can write go: each step's title as it starts, what a step or the check threw, and
   * how the action ended. Only step numbers, title keys, stop reasons, counts and error messages. Not said: the console
   * in a development build with the console report on (`actLogInDevelopment`), nowhere otherwise.
   */
  readonly log?: (line: string) => void;
}

/**
 * How the action ended, as sent to the page; the words for the screen when a check did not hold; and whether a step
 * was still running when it ended. Such a step is cut off from the wallet's keys and hands nothing more over, but it
 * may still be finishing work it started, so the screen does not say its work is over.
 */
export interface RunEnded {
  readonly ended: ActEnded;
  readonly says: Words | null;
  readonly abandoned: boolean;
}

type Raced = { readonly of: 'ran' } | { readonly of: 'failed'; readonly error: unknown } | { readonly of: 'cut'; readonly why: ActStop };

/**
 * NEVER THROWS: whatever a definition does, the page gets one terminal answer. A refused or unanswered transaction
 * stops the action at its step whatever the step does with the error, and transactions go to the page one at a time,
 * each only after the one before it was answered.
 */
export async function runAction(run: RunOf): Promise<RunEnded> {
  const now = run.now ?? Date.now;
  const { request, definition } = run;
  /* Every message to the page is checked for a secret of the saved keys first (`nothing-secret-crosses.ts`). */
  const channel = checkedChannel(run.channel);
  const write = run.log ?? actLogInDevelopment();
  const log = (line: string): void => {
    if (write === undefined) return;
    try { write(`action ${request.intent.name} in the wallet: ${line}`); } catch { /* a line that cannot be written never stops the action */ }
  };
  const started = now();
  const deadline = Math.min(request.expiresAt - DEADLINE_MARGIN_MS, started + MOST_ACT_MS);
  let total = 1;
  let relayed = 0;
  let unconfirmed = 0;
  let current = 1;
  let says: Words | null = null;
  const told: Record<string, string | number> = {};
  /* Set once the action is ending: nothing is handed over after it. */
  let closed = false;
  /* Set by a transaction the page refused or did not answer: the action stops at that step, whatever the step does. */
  let latched: ActStop | null = null;
  /* Every transaction handed over, in turn: the next waits for the page's answer to the one before. */
  let queue: Promise<unknown> = Promise.resolve();
  /* Whether the step running now has returned. */
  let stepSettled = true;
  let ended: RunEnded | null = null;
  /* The opened wallet, reachable from a step only until the action ends. */
  let released = false;
  const keys = (): Held => {
    if (released) throw new ActionStopped('stopped');
    return run.held;
  };
  const held: Held = Object.freeze({
    get identity() { return keys().identity; },
    get secret() { return keys().secret; },
    get wallet() { return keys().wallet; },
    get account() { return keys().account; },
  });
  /* Aborted at Stop, at the deadline and when the action ends: what each step is given to stop building. */
  const cut = new AbortController();
  if (run.stop.aborted) cut.abort();
  else run.stop.addEventListener('abort', () => cut.abort(), { once: true });

  /*
   * When a step opened the saved keys: what they hold that is not secret, as the action left them, so the page reads
   * the creations and seats it lists without opening them (`read-for-the-page.ts`), and no copy. The one viewing key in
   * it is the action's own company's, from the served keys the ask handed in for it, opened with this seat and given
   * only when it makes that company's inbox public key (`servedKeysOpenedFrom`), so a page that ran an action with its
   * keys closed can open that company afterwards with no other window.
   */
  const keysAtTheEnd = (): { keys?: NonNullable<ActEnded['keys']> } => {
    const h = opened;
    if (h === null || request.person === undefined) return {};
    try {
      const k = h.read();
      const own = ownCompany ?? ownCompanyIn(k);
      const served = own === null ? [] : (request.served ?? []).filter((s) => s.accountId === own);
      const read = readFor(run.held.identity, { requester: request.requester, person: request.person, served }, k);
      const viewing = own !== null && Object.prototype.hasOwnProperty.call(read.viewing, own) ? { [own]: read.viewing[own]! } : {};
      return { keys: Object.freeze({ ...read, viewing, resealed: null }) };
    } catch {
      return {};
    }
  };
  const finish = (why: ActStop | null, step: number): RunEnded => {
    if (ended !== null) return ended;
    closed = true;
    released = true;
    cut.abort();
    const answer: ActEnded = Object.freeze({
      schema: ACT_ENDED_SCHEMA, nonce: request.nonce, intent: request.intent.name,
      ended: why === null ? 'done' as const : 'stopped' as const, step, steps: total, relayed, unconfirmed,
      ...(why === null ? {} : { why }),
      ...((): { outcome?: Readonly<Record<string, string | number>> } => {
        const outcome = Object.keys(told).length === 0 ? undefined : readOutcome({ ...told }, request.intent.name);
        return outcome === undefined || outcome === null ? {} : { outcome };
      })(),
      ...keysAtTheEnd(),
    });
    let sent: ActEnded = answer;
    try {
      channel.answer(answer);
    } catch (e) {
      if (!(e instanceof SecretWouldCross)) throw e;
      /* The end answer held a secret: it is not sent, and the page is told the action stopped, with nothing else. */
      sent = Object.freeze({
        schema: ACT_ENDED_SCHEMA, nonce: request.nonce, intent: request.intent.name,
        ended: 'stopped' as const, step, steps: total, relayed, unconfirmed, why: 'step-failed' as const,
      });
      channel.answer(sent);
    }
    ended = Object.freeze({ ended: sent, says, abandoned: !stepSettled });
    log(sent.ended === 'done'
      ? `done, ${sent.steps} of ${sent.steps} steps (relayed ${relayed})`
      : `stopped at step ${sent.step} of ${sent.steps}: ${sent.why ?? 'step-failed'} (relayed ${relayed}, unconfirmed ${unconfirmed})`);
    return ended;
  };

  const watch = (): void => { run.watch?.({ step: current, steps: total, relayed, unconfirmed, told: { ...told } }); };
  /* A message refused for holding a secret stops the action where it is: nothing more is sent for it. */
  const sending = <T>(send: () => T): T => {
    try {
      return send();
    } catch (e) {
      if (!(e instanceof SecretWouldCross)) throw e;
      latched = 'step-failed';
      closed = true;
      watch();
      throw new ActionStopped(latched);
    }
  };

  const relayOne = async (at: StepAt, transaction: string, label?: RelayLabel): Promise<void> => {
    if (latched !== null) throw new ActionStopped(latched);
    if (closed || run.stop.aborted) throw new ActionStopped('stopped');
    if (now() >= deadline) throw new ActionStopped('out-of-time');
    const answered = sending(() => channel.relay(at, transaction, label));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const patience = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), Math.max(0, Math.min(RELAY_PATIENCE_MS, deadline - now())));
    });
    const outcome = await Promise.race([answered, patience]).finally(() => clearTimeout(timer));
    if (outcome === 'relayed') {
      relayed += 1;
      watch();
      return;
    }
    if (outcome === 'gone') throw new ActionStopped('stopped');
    /* Handed over and not confirmed: the page holds it and may still send it. */
    unconfirmed += 1;
    latched = outcome === 'refused' ? 'relay-refused' : 'no-relay-answer';
    closed = true;
    watch();
    throw new ActionStopped(latched);
  };
  const relay = (at: StepAt, transaction: string, label?: RelayLabel): Promise<void> => {
    const mine = queue.then(() => relayOne(at, transaction, label));
    queue = mine.catch(() => undefined);
    return mine;
  };

  const shape = intentShapeOf(request.intent.name);
  const callOne = async (at: StepAt, method: 'GET' | 'PUT' | 'POST', path: string, body?: string): Promise<{ status: number; body: unknown }> => {
    if (latched !== null) throw new ActionStopped(latched);
    if (closed || run.stop.aborted) throw new ActionStopped('stopped');
    if (now() >= deadline) throw new ActionStopped('out-of-time');
    const route = shape === undefined ? null : routeOf(shape, method, path);
    if (route === null) {
      latched = 'call-refused';
      closed = true;
      watch();
      throw new ActionStopped(latched);
    }
    const answered = sending(() => channel.call(at, method, path, body));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const patience = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), Math.max(0, Math.min(RELAY_PATIENCE_MS, deadline - now())));
    });
    const outcome: CalledOver | 'late' = await Promise.race([answered, patience]).finally(() => clearTimeout(timer));
    if (typeof outcome === 'object') {
      if (sendsIn(route, body)) {
        if (outcome.status >= 200 && outcome.status < 300) relayed += 1; else unconfirmed += 1;
        watch();
      }
      return { status: outcome.status, body: outcome.body };
    }
    if (outcome === 'gone') throw new ActionStopped('stopped');
    if (sendsIn(route, body)) unconfirmed += 1;
    latched = outcome === 'refused' ? 'call-refused' : 'no-call-answer';
    closed = true;
    watch();
    throw new ActionStopped(latched);
  };
  const callInTurn = (at: StepAt, method: 'GET' | 'PUT' | 'POST', path: string, body?: string) => {
    const mine = queue.then(() => callOne(at, method, path, body));
    queue = mine.catch(() => undefined);
    return mine;
  };
  const tell = (outcome: Readonly<Record<string, string | number>>): void => { Object.assign(told, outcome); };

  /* The person's saved keys, opened once on a step's first use, and let go when the action ends. */
  let opened: HeldKeyring | null = null;
  /*
   * The action's own company, by its record: the intent names it, or (for finishing a company) the creation the saved
   * keys hold for the intent's label names it, read when they are first opened, before the finish lets it go.
   */
  const ownCompanyIn = (k: Keyring): string | null => {
    const record = request.intent.fields['record'];
    if (typeof record === 'string') return record;
    const label = request.intent.fields['company'];
    const creation = Object.values({ ...(k.creationsSetAside ?? {}), ...(k.creations ?? {}) }).find((c) => c.label === label);
    return creation === undefined ? null : creation.accountId;
  };
  let ownCompany: string | null = null;
  const openSavedKeys = (): HeldKeyring => {
    const h = keys();
    if (opened !== null) return opened;
    if (request.person === undefined || request.keyring === undefined) throw new ActionStopped('step-failed');
    try {
      opened = openHeldKeyring({
        identity: h.identity,
        ask: { requester: request.requester, person: request.person },
        handedIn: request.keyring,
        marks: run.marks ?? keyringMarksFor(h.secret),
      });
      ownCompany = ownCompanyIn(opened.read());
    } catch (e) {
      if (e instanceof SavedKeysRefused) throw new ActionStopped(e.why);
      throw e;
    }
    return opened;
  };
  const keepOne = async (at: StepAt, change: (current: Keyring) => Keyring): Promise<void> => {
    if (latched !== null) throw new ActionStopped(latched);
    if (closed || run.stop.aborted) throw new ActionStopped('stopped');
    if (now() >= deadline) throw new ActionStopped('out-of-time');
    const again = openSavedKeys().seal(change);
    let answered: Promise<KeptOver>;
    try {
      answered = sending(() => channel.keep(at, again.sealed, again.ifVersion));
    } catch (e) {
      again.notKept();
      throw e;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const patience = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), Math.max(0, Math.min(RELAY_PATIENCE_MS, deadline - now())));
    });
    const outcome: KeptOver | 'late' = await Promise.race([answered, patience]).finally(() => clearTimeout(timer));
    if (typeof outcome === 'object') {
      again.kept(outcome.version);
      return;
    }
    again.notKept();
    if (outcome === 'gone') throw new ActionStopped('stopped');
    /* Handed over and not said to be kept: the page may still write them, and this wallet does not count them as newest. */
    latched = outcome === 'refused' ? 'keep-refused' : 'no-keep-answer';
    closed = true;
    watch();
    throw new ActionStopped(latched);
  };
  const keepInTurn = (at: StepAt, change: (current: Keyring) => Keyring): Promise<void> => {
    const mine = queue.then(() => keepOne(at, change));
    queue = mine.catch(() => undefined);
    return mine;
  };
  const savedKeysAt = (at: StepAt): ActKeyring | null => (request.keyring === undefined ? null : Object.freeze({
    open: openSavedKeys,
    keep: (change: (current: Keyring) => Keyring) => keepInTurn(at, change),
  }));

  let beat: ReturnType<typeof setInterval> | undefined;
  try {
    const steps = definition.steps(request.intent);
    total = Math.max(1, Math.min(steps.length, MOST_ACT_STEPS));
    if (steps.length === 0 || steps.length > MOST_ACT_STEPS) return finish('too-many', 1);
    if (run.stop.aborted) return finish('stopped', 1);
    if (now() >= deadline) return finish('out-of-time', 1);

    let found: Words | null;
    try {
      found = await definition.check(request.intent, held);
    } catch (e) {
      log(`its check threw: ${thrown(e)}`);
      found = { key: 'act.over.check-threw' };
    }
    if (found !== null) {
      says = found;
      return finish('check-failed', 1);
    }

    beat = setInterval(() => { channel.step({ step: current, steps: total }); }, HEARTBEAT_MS);

    /* Resolves when the action is cut short from outside a step: Stop, or the deadline. */
    const outside = new Promise<ActStop>((resolve) => {
      const late = setTimeout(() => resolve('out-of-time'), Math.max(0, deadline - now()));
      const stopped = (): void => { clearTimeout(late); resolve('stopped'); };
      if (run.stop.aborted) stopped();
      else run.stop.addEventListener('abort', stopped, { once: true });
      cut.signal.addEventListener('abort', () => clearTimeout(late), { once: true });
    });

    for (let i = 0; i < steps.length; i += 1) {
      current = i + 1;
      if (latched !== null) return finish(latched, i);
      if (run.stop.aborted) return finish('stopped', current);
      if (now() >= deadline) return finish('out-of-time', current);
      const at: StepAt = { step: current, steps: total };
      channel.step(at);
      watch();
      const step = steps[i]!;
      log(`step ${current} of ${total} started: ${step.title.key}`);
      stepSettled = false;
      const ran: Promise<Raced> = Promise.resolve()
        .then(() => step.run({
          intent: request.intent, asker: request.requester, person: request.person ?? null, held, at, signal: cut.signal, relay: (transaction, label) => relay(at, transaction, label), keyring: savedKeysAt(at),
          call: (method, path, body) => callInTurn(at, method, path, body), tell,
        }))
        .then(() => ({ of: 'ran' as const }), (error: unknown) => {
          log(`step ${at.step} of ${at.steps} threw: ${thrown(error)}`);
          return { of: 'failed' as const, error };
        })
        .finally(() => { stepSettled = true; });
      const raced = await Promise.race([ran, outside.then((why) => ({ of: 'cut' as const, why }))]);
      if (raced.of === 'cut') {
        /* A transaction already with the page is waited for, so the counts say what the page did with it. */
        closed = true;
        cut.abort();
        await queue;
        if (latched !== null) return finish(latched, current);
        if (raced.why !== 'stopped') return finish(raced.why, current);
        /* After Stop, a step that is only finishing what it already handed over may still finish, and counts as done. */
        const bound = Math.max(0, Math.min(RELAY_PATIENCE_MS, deadline - now()));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const after = await Promise.race([
          ran, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), bound); }),
        ]).finally(() => clearTimeout(timer));
        if (latched !== null) return finish(latched, current);
        if (after?.of !== 'ran') return finish(raced.why, current);
        return current === steps.length ? finish(null, total) : finish(raced.why, current + 1);
      }
      await queue;
      if (latched !== null) {
        /* A step that says why its refused transaction was refused keeps its words; the end still says it was refused. */
        if (raced.of === 'failed' && raced.error instanceof StepRefused) says = raced.error.words;
        return finish(latched, current);
      }
      if (raced.of === 'failed') {
        if (raced.error instanceof StepRefused) {
          says = raced.error.words;
          return finish('check-failed', current);
        }
        const why = raced.error instanceof ActionStopped ? raced.error.why : 'step-failed';
        return finish(why, current);
      }
    }
    return finish(null, total);
  } catch (e) {
    log(`threw at step ${current} of ${total}: ${thrown(e)}`);
    return finish('step-failed', current);
  } finally {
    if (beat !== undefined) clearInterval(beat);
    released = true;
    (opened as HeldKeyring | null)?.letGo();
    cut.abort();
  }
}

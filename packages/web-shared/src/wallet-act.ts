import { ACT_CALLED_SCHEMA, ACT_KEPT_SCHEMA, ACT_RELAYED_SCHEMA, MOST_ACT_STEPS, PROGRESS_SCHEMA } from 'midnight-identity/profile/channel';
import { intentShapeOf, readActCall, readActEnded, readActKeep, readActRelay, routeOf, sendsIn } from 'midnight-identity/profile/act-channel';
import type { KeyringHandedIn, SealedKeyring } from 'midnight-identity/profile/unlock';
import type { ServedHandedIn } from 'midnight-identity/profile/request';
import type { ActEnded, ActStop, StepAt } from 'midnight-identity/profile/channel';
import { REQUEST_SCHEMA } from 'midnight-identity/profile/request';
import { buildSetting } from 'midnight-identity/profile/origin';
import { randomBytes, toHex } from '../../../src/core/crypto.js';
import {
  askWallet, openWalletDialog, UNREADABLE_SAYS, US_TO_A_WALLET, WalletClosed, type Openable, type WalletDialog,
} from './wallet-sign-in.js';

/**
 * **AN ACTION THE WALLET RUNS WHOLE, AND THE PAGE RELAYS.** The same
 * conversation as every ask in `wallet-sign-in.ts` (`askWallet`), with each
 * transaction the wallet built relayed in between and its fate told back.
 *
 * It is its own file so that the page's first download does not carry it: it
 * reads the action's messages and the saved keys the wallet hands back, which
 * only a signed-in person's keyring asks for, and the keyring is loaded on
 * demand after sign-in. Its readers come from `midnight-identity/profile/act-channel`,
 * not from the channel the sign-in imports, for the same reason.
 * `apps/web/src/first-download.test.ts` holds the page to its size.
 */

/**
 * HOW LONG AN ACTION MAY RUN, in minutes, unless its caller says otherwise. The
 * wallet keeps its own deadline inside this and stops a little before it, so
 * its answer saying where it stopped reaches this page before this page stops
 * waiting.
 */
const ACT_MINUTES = 25;
const MOST_ACT_MINUTES = 30;

const ACT_PURPOSE =
  'To run this action from your wallet: it shows what it will do, then builds each transaction itself and hands it to '
  + 'this page to send.';

/**
 * **HOW OFTEN A RUNNING ACTION IS WRITTEN DOWN AS STILL RUNNING.** In a development build that reports the page's
 * console (`error-sink.ts`), every action writes its steps, its relays and calls, its end and any error to the console
 * as warnings, which that report carries to the service's log; and while one step runs this long or longer, a line
 * says which step is still running and for how many minutes, so a step that never ends shows in the log as one.
 */
export const ACT_LOG_EVERY_MS = 60_000;

/**
 * **WHERE AN ACTION'S LINES GO WHEN ITS CALLER NAMES NOWHERE:** the console, as a warning, only in a development
 * build with the console report on; nowhere otherwise, so a production build writes none of it. Read when the
 * action starts, so `console.warn` is whatever the report put there. Read through `buildSetting`, which asks the
 * bundler's settings and then the process's, so a script that loads this file outside a bundler is nowhere too.
 */
const actLogInDevelopment = (): ((line: string) => void) | undefined =>
  (buildSetting('DEV') === true && buildSetting('VITE_DEV_ERROR_SINK') === '1' ? (line: string) => { console.warn(line); } : undefined);

/**
 * An error as one line: its kind and message, or a refusal's code and message; never anything else it carries. Not
 * cut short here: the console report removes what looks like a key before it shortens a line, and a key cut first
 * would no longer look like one.
 */
const errorLine = (e: unknown): string =>
  (e instanceof WalletClosed ? `${e.refusal.of}: ${e.message}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Why a page sees an action stopped: the wallet's own reasons, or the wallet going quiet or being given up on. */
type ActStoppedWhy = ActStop | 'went-quiet' | 'gave-up';

/**
 * **HOW AN ACTION IN THE WALLET ENDED, FOR THE PAGE.** Done, or stopped at a
 * step it can be taken up again from. `relayed` counts the transactions THIS
 * PAGE handed to the service, from its own count; that is never a count of
 * what landed on the chain, which only a read of the chain can say.
 */
export type ActOutcome = (
  | { readonly of: 'done'; readonly steps: number; readonly relayed: number }
  | {
    readonly of: 'stopped'; readonly step: number; readonly steps: number; readonly relayed: number;
    /** Transactions this page was handed and did not hand to the service. Whether any landed is read from the chain. */
    readonly unconfirmed: number;
    readonly why: ActStoppedWhy;
    /** On a refused check: the key of the words the wallet refused with, and the kind of refusal, never the words' values. */
    readonly refused?: string;
    readonly code?: string;
  }
) & {
  /** What the wallet said the action got to, when its entry lists any: public facts only, the wallet's word. */
  readonly outcome?: Readonly<Record<string, string | number>>;
  /** When the action opened the saved keys: what they hold that is not secret, as it left them (`KeysRead`). */
  readonly keys?: NonNullable<ActEnded['keys']>;
};

export interface ActAsked {
  /** The action and what it acts on: its name, and each of its fields as an id, an amount or this page's own words. */
  readonly intent: { readonly name: string } & Readonly<Record<string, string>>;
  /**
   * Sends one transaction the wallet built and handed over. Resolves `true` once
   * the service has taken it, `false` (or throws) if this page will not send it;
   * the wallet then stops the action at that step. `what` is what the wallet
   * says it is for, from the action's list, and `also` a second transaction sent
   * with it; a page refuses a `what` it does not know rather than guess.
   */
  readonly relay: (transaction: string, at: StepAt & { readonly n: number; readonly what?: string; readonly also?: string }) => Promise<boolean>;
  /**
   * Makes one call to the service for the wallet, only ever one the action's
   * route list names (this page checks it before calling): resolves the
   * service's status and body, which the wallet takes as this page's word.
   * Throws when this page will not make it; the wallet then stops the action at
   * that step. Without it, every call is refused.
   */
  readonly call?: (request: { readonly method: 'GET' | 'PUT' | 'POST'; readonly path: string; readonly body?: string }, at: StepAt & { readonly n: number }) => Promise<{ readonly status: number; readonly body: unknown }>;
  /**
   * For an action that opens the person's saved keys: the site's identifier for the person, the saved keys as the
   * service holds them now, and `keep`, which writes saved keys the wallet sealed again over the version it names and
   * resolves the version the service then holds, or null (or throws) when the service did not take them; the wallet
   * then stops the action at that step. `served`, one entry at most, is the action's own company's viewing key as the
   * service holds it, for the end answer to give that one key opened (`ActEnded.keys`).
   */
  readonly savedKeys?: {
    readonly person: string;
    readonly keyring: KeyringHandedIn;
    readonly served?: readonly ServedHandedIn[];
    readonly keep: (sealed: SealedKeyring, ifVersion: number) => Promise<number | null>;
  };
  /** Told each time the wallet says which step it is on. */
  readonly onStep?: (at: StepAt) => void;
  /** How long the action may run, from 1 to 30 minutes; 25 if not said. */
  readonly minutes?: number;
  readonly name?: string;
  readonly rdns?: string;
  readonly purpose?: string;
  readonly now?: () => number;
  readonly nonce?: string;
  /**
   * Where the action's lines are written: each step's start and finish, each transaction and call by its number and
   * kind and what became of it, a line each minute a step runs past one, the end with its step, reason and counts, and
   * any error. Only numbers, kinds, codes and messages: never a transaction, a body, a field or a key. Not said: the
   * console in a development build with the console report on (`actLogInDevelopment`), nowhere otherwise.
   */
  readonly log?: (line: string) => void;
}

/**
 * **RUNS ONE ACTION IN THE WALLET, OVER ONE WINDOW, AND RELAYS WHAT IT BUILDS.**
 *
 * Sends one `act` ask naming the action; the wallet shows what it will do and
 * asks for one passkey. Then, for each transaction the wallet builds, this
 * calls `relay` and tells the wallet whether it was handed over, in order and
 * one at a time; saved keys the wallet hands back sealed go to `keep` in the
 * same turn, and the wallet hears `kept` only once the service has taken them;
 * a call to the service the wallet asks for goes to `call`, in the same turn,
 * only when the action's route list names it, and a call that carries a
 * transaction is counted with the relays.
 * It resolves with the action done, or stopped at a step: by
 * the person, by a refused relay, by the wallet's own deadline or limits, or
 * because the wallet went quiet or was given up on after it had started. A
 * decline, an unreadable ask or a wallet that never started still throws
 * `WalletClosed`, as every ask does, because nothing was done.
 *
 * What it trusts: the wallet's word for where it stopped; this page's own count
 * for what was handed over. It checks nothing a transaction does: the wallet
 * built it, and the service and the chain judge it.
 *
 * Where it got to is written to `log` as it goes (`ActAsked.log`); a line that
 * cannot be written is dropped and never stops the action.
 */
export async function actInTheWallet(
  view: Openable, walletOrigin: string, asked: ActAsked, dialog: WalletDialog = openWalletDialog(view, walletOrigin),
): Promise<ActOutcome> {
  const now = asked.now ?? (() => Date.now());
  const nonce = asked.nonce ?? toHex(randomBytes(16));
  const minutes = Math.min(MOST_ACT_MINUTES, Math.max(1, asked.minutes ?? ACT_MINUTES));
  const { name: intentName } = asked.intent;
  const message = Object.freeze({
    schema: REQUEST_SCHEMA,
    kind: 'act' as const,
    requester: Object.freeze({ name: asked.name ?? US_TO_A_WALLET.name, rdns: asked.rdns ?? US_TO_A_WALLET.rdns }),
    purpose: asked.purpose ?? ACT_PURPOSE,
    nonce,
    expiresAt: now() + minutes * 60_000,
    progress: PROGRESS_SCHEMA,
    intent: Object.freeze({ ...asked.intent }),
    ...(asked.savedKeys === undefined ? {} : { person: asked.savedKeys.person, keyring: asked.savedKeys.keyring }),
    ...(asked.savedKeys?.served === undefined || asked.savedKeys.served.length === 0 ? {} : { served: asked.savedKeys.served }),
  });

  let at: StepAt | null = null;
  let relayed = 0;
  let expected = 1;
  let relaying: Promise<void> = Promise.resolve();
  const write = asked.log ?? actLogInDevelopment();
  const log = (line: string): void => {
    if (write === undefined) return;
    try { write(`action ${intentName}: ${line}`); } catch { /* a line that cannot be written never stops the action */ }
  };
  const counts = (): string => `relayed ${relayed}, unconfirmed ${handedOver - relayed}`;
  let stepSince = now();
  let heardAt = now();
  let beat: number | null = null;
  /*
   * The step the log writes under: the last step the wallet's progress said it began. A call, a transaction or saved
   * keys carry a step of their own, and the wallet may send one with the step it was made for rather than the step it
   * is on; those are written under this step, and only progress moves it.
   */
  let shown: StepAt | null = null;
  const under = (own: StepAt): string => { const s = shown ?? own; return `step ${s.step} of ${s.steps}`; };
  const minutesSince = (from: number): number => Math.floor((now() - from) / 60_000);
  const beatOnce = (): void => {
    beat = null;
    const running = minutesSince(stepSince);
    if (running >= 1) {
      const where = shown ?? (at as StepAt | null);
      const heard = `the wallet last heard from ${Math.round((now() - heardAt) / 1000)} s ago; ${counts()}`;
      log(where === null
        ? `still waiting for the wallet to begin, ${running} minute${running === 1 ? '' : 's'} (${heard})`
        : `still running step ${where.step} of ${where.steps}, ${running} minute${running === 1 ? '' : 's'} (${heard})`);
    }
    beat = view.setTimeout(beatOnce, ACT_LOG_EVERY_MS);
  };
  const reached = (next: StepAt): void => {
    const was = shown;
    at = next;
    shown = next;
    if (was !== null && was.step === next.step && was.steps === next.steps) return;
    if (was !== null && next.step > was.step) log(`step ${was.step} of ${was.steps} finished (${counts()})`);
    stepSince = now();
    log(`step ${next.step} of ${next.steps} started`);
  };
  const acknowledge = (n: number, outcome: 'relayed' | 'refused'): void => {
    dialog.wallet?.postMessage({ schema: ACT_RELAYED_SCHEMA, nonce, n, outcome }, walletOrigin);
  };
  let handedOver = 0;
  let expectedCall = 1;
  const shape = intentShapeOf(intentName);
  const acknowledgeCall = (n: number, answer: { status: number; body: unknown } | null): void => {
    dialog.wallet?.postMessage(answer === null
      ? { schema: ACT_CALLED_SCHEMA, nonce, n, outcome: 'refused' }
      : { schema: ACT_CALLED_SCHEMA, nonce, n, outcome: 'answered', status: answer.status, body: answer.body }, walletOrigin);
  };
  let expectedKeep = 1;
  const acknowledgeKeep = (n: number, version: number | null): void => {
    dialog.wallet?.postMessage(version === null
      ? { schema: ACT_KEPT_SCHEMA, nonce, n, outcome: 'refused' }
      : { schema: ACT_KEPT_SCHEMA, nonce, n, outcome: 'kept', version }, walletOrigin);
  };
  const hears = (body: Readonly<Record<string, unknown>>): void => {
    heardAt = now();
    if (body['schema'] === PROGRESS_SCHEMA) {
      const step = body['step'];
      const steps = body['steps'];
      if (typeof steps === 'number' && Number.isSafeInteger(steps) && steps >= 1 && steps <= MOST_ACT_STEPS
        && typeof step === 'number' && Number.isSafeInteger(step) && step >= 1 && step <= steps) {
        reached({ step, steps });
        asked.onStep?.({ step, steps });
      }
      return;
    }
    const keeping = readActKeep(body, nonce);
    if (keeping !== null) {
      /* In order, and in turn with the transactions: saved keys out of turn are refused, never written. */
      if (keeping.n !== expectedKeep) { log(`saved keys ${keeping.n} out of turn, refused`); acknowledgeKeep(keeping.n, null); return; }
      expectedKeep += 1;
      log(`${under(keeping)}: the wallet handed saved keys ${keeping.n} to keep`);
      relaying = relaying.then(async () => {
        let version: number | null = null;
        try { version = asked.savedKeys === undefined ? null : await asked.savedKeys.keep(keeping.sealed, keeping.ifVersion); } catch (e) {
          log(`${under(keeping)}: keeping saved keys ${keeping.n} failed: ${errorLine(e)}`);
          version = null;
        }
        const kept = typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 ? version : null;
        log(`${under(keeping)}: saved keys ${keeping.n} ${kept === null ? 'refused' : `kept, version ${kept}`}`);
        acknowledgeKeep(keeping.n, kept);
      });
      return;
    }
    const calling = readActCall(body, nonce);
    if (calling !== null) {
      const called = `call ${calling.n} ${calling.method} ${calling.path}`;
      if (calling.n !== expectedCall) { log(`${called} out of turn, refused`); acknowledgeCall(calling.n, null); return; }
      expectedCall += 1;
      const route = shape === undefined ? null : routeOf(shape, calling.method, calling.path);
      if (route === null || asked.call === undefined) { log(`${called} is not on the action's list, refused`); acknowledgeCall(calling.n, null); return; }
      const sends = sendsIn(route, calling.body);
      if (sends) handedOver += 1;
      at = { step: calling.step, steps: calling.steps };
      log(`${under(calling)}: ${called}`);
      relaying = relaying.then(async () => {
        let answer: { status: number; body: unknown } | null = null;
        try {
          const got = await asked.call!({ method: calling.method, path: calling.path, ...(calling.body === undefined ? {} : { body: calling.body }) },
            { step: calling.step, steps: calling.steps, n: calling.n });
          answer = Number.isSafeInteger(got.status) && got.status >= 100 && got.status <= 599 ? { status: got.status, body: got.body ?? null } : null;
        } catch (e) {
          log(`${under(calling)}: ${called} failed: ${errorLine(e)}`);
          answer = null;
        }
        if (answer !== null && sends && answer.status >= 200 && answer.status < 300) relayed += 1;
        log(`${under(calling)}: ${called} ${answer === null ? 'refused' : `answered ${answer.status}`} (${counts()})`);
        acknowledgeCall(calling.n, answer);
      });
      return;
    }
    const handed = readActRelay(body, nonce);
    /* One at a time and in order: a transaction out of turn is refused, never sent. */
    if (handed === null) return;
    const transaction = `transaction ${handed.n}${handed.what === undefined ? '' : ` (${handed.what})`}`;
    if (handed.n !== expected) { log(`${transaction} out of turn, refused`); acknowledge(handed.n, 'refused'); return; }
    expected += 1;
    handedOver += 1;
    at = { step: handed.step, steps: handed.steps };
    log(`${under(handed)}: the wallet handed over ${transaction}; sending`);
    relaying = relaying.then(async () => {
      let sent = false;
      try { sent = await asked.relay(handed.transaction, {
        step: handed.step, steps: handed.steps, n: handed.n,
        ...(handed.what === undefined ? {} : { what: handed.what }), ...(handed.also === undefined ? {} : { also: handed.also }),
      }); } catch (e) {
        log(`${under(handed)}: sending ${transaction} failed: ${errorLine(e)}`);
        sent = false;
      }
      if (sent) relayed += 1;
      log(`${under(handed)}: ${transaction} ${sent ? 'relayed' : 'refused'} (${counts()})`);
      acknowledge(handed.n, sent ? 'relayed' : 'refused');
    });
  };

  const ending = async (): Promise<ActOutcome> => {
    let answer: unknown;
    try {
      answer = await askWallet(view, walletOrigin, message, dialog, hears);
    } catch (e) {
      await relaying;
      const started = at as StepAt | null;
      if (started === null || !(e instanceof WalletClosed)) throw e;
      log(`the wallet's window ended without an answer: ${errorLine(e)}`);
      return Object.freeze({
        of: 'stopped' as const, step: started.step, steps: started.steps, relayed, unconfirmed: handedOver - relayed,
        why: e.refusal.of === 'gave-up' ? 'gave-up' as const : e.refusal.of === 'expired' ? 'out-of-time' as const : 'went-quiet' as const,
      });
    }
    await relaying;
    const ended = readActEnded(answer, { nonce, intent: intentName });
    if (ended === null) {
      log('the wallet\'s answer could not be read');
      const started = at as StepAt | null;
      if (started === null) throw new WalletClosed({ of: 'unreadable' }, UNREADABLE_SAYS);
      return Object.freeze({
        of: 'stopped' as const, step: started.step, steps: started.steps, relayed, unconfirmed: handedOver - relayed,
        why: 'went-quiet' as const,
      });
    }
    const told = { ...(ended.outcome === undefined ? {} : { outcome: ended.outcome }), ...(ended.keys === undefined ? {} : { keys: ended.keys }) };
    if (ended.ended === 'done') return Object.freeze({ of: 'done' as const, steps: ended.steps, relayed, ...told });
    return Object.freeze({
      of: 'stopped' as const, step: ended.step, steps: ended.steps, relayed, unconfirmed: handedOver - relayed,
      why: ended.why ?? 'step-failed',
      ...(ended.refused === undefined ? {} : { refused: ended.refused, ...(ended.code === undefined ? {} : { code: ended.code }) }),
      ...told,
    });
  };

  log('asked the wallet to run it');
  if (write !== undefined) beat = view.setTimeout(beatOnce, ACT_LOG_EVERY_MS);
  try {
    const outcome = await ending();
    log(outcome.of === 'done'
      ? `done, ${outcome.steps} of ${outcome.steps} steps (relayed ${outcome.relayed})`
      : `stopped at step ${outcome.step} of ${outcome.steps}: ${outcome.why} (relayed ${outcome.relayed}, unconfirmed ${outcome.unconfirmed})`
        + (outcome.refused === undefined ? '' : ` (refused: ${outcome.refused}${outcome.code === undefined ? '' : ` ${outcome.code}`})`));
    return outcome;
  } catch (e) {
    log(`ended with an error: ${errorLine(e)}`);
    throw e;
  } finally {
    if (beat !== null) view.clearTimeout(beat);
  }
}

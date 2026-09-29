import type { Port } from 'midnight-identity/profile/store';
import type { Channel, ChannelState, PaymentFailure, ProgressStage, Refusal } from 'midnight-identity/profile/channel';

/**
 * **WHAT THIS WALLET SHOWED AND SENT FOR EACH REQUEST, KEPT SO THAT A WAIT THAT
 * NEVER ENDED CAN BE TOLD APART FROM THE NEXT ONE.**
 *
 * A page that waits and hears nothing can only say that it heard nothing. The
 * wallet at the other end knows which of several things happened - it refused
 * what it was sent, it was still reading the network, it was proving, it was
 * put away before anybody pressed anything - and until this was kept, that was
 * known to nobody once the window closed.
 *
 * **WHICH REQUESTS.** A request to pay, and any request refused the moment it
 * arrived: those are the ones a page waits on for minutes. Nothing is written
 * about a sign-in, an unlock or a disclosure the wallet showed.
 *
 * **WHAT A LINE HOLDS, AND WHAT IT NEVER HOLDS.** When; whether the wallet was
 * asked, showed something or sent something; and one short word for which:
 * the kind of request, the stage on screen, the message sent and whether it
 * actually went. Never an amount, an address, a token, a transaction, a key or
 * the page's own words. It is kept in this wallet's own storage in this browser
 * and goes nowhere; the last `KEPT_LINES` lines are kept and older ones are
 * dropped. Each line is also written to the browser's console, where a person
 * helping somebody with a stuck payment can read it.
 */

export const ASK_RECORD_KEY = 'midnight-wallet:ask-record:v1';
export const KEPT_LINES = 200;

export type AskRecordWhat = 'asked' | 'shown' | 'sent' | 'not-sent';

export interface AskRecordLine {
  readonly at: number;
  readonly what: AskRecordWhat;
  /** One short word: `balance`, `reading`, `answer`, `refused:unreadable`, `progress:proving`. */
  readonly detail: string;
  /** How many times in a row this same line was written; `at` is the last. */
  readonly times?: number;
}

/** A word only: letters, digits and the three separators, cut short. Anything else is replaced, never carried. */
const word = (detail: string): string => detail.replace(/[^a-z0-9:-]/giu, '_').slice(0, 48);

/** Every line kept here, oldest first. An unreadable record reads as none. */
export function readAskRecord(port: Port): AskRecordLine[] {
  try {
    const raw = port.getItem(ASK_RECORD_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((l): l is AskRecordLine => typeof l === 'object' && l !== null
      && typeof (l as AskRecordLine).at === 'number' && typeof (l as AskRecordLine).detail === 'string'
      && ['asked', 'shown', 'sent', 'not-sent'].includes((l as AskRecordLine).what));
  } catch {
    return [];
  }
}

/**
 * Adds one line. **A record that cannot be written is a record that is not
 * kept, and nothing else**: this never throws and never stops what it records.
 */
export function recordAsk(port: Port, what: AskRecordWhat, detail: string, at: number = Date.now()): void {
  const line: AskRecordLine = { at, what, detail: word(detail) };
  try {
    const lines = readAskRecord(port);
    const last = lines[lines.length - 1];
    /* A wallet at work says the same stage many times, and a screen can show one twice; one line says when it last did, and how often. */
    if (last !== undefined && last.what === line.what && last.detail === line.detail) {
      lines[lines.length - 1] = { ...last, at, times: (last.times ?? 1) + 1 };
    } else {
      lines.push(line);
    }
    port.setItem(ASK_RECORD_KEY, JSON.stringify(lines.slice(-KEPT_LINES)));
  } catch { /* storage full or refused: the console line below still says it */ }
  try {
    // eslint-disable-next-line no-console
    console.info(`[wallet record] ${new Date(at).toISOString()} ${line.what} ${line.detail}`);
  } catch { /* no console */ }
}

/**
 * What the channel told this wallet about a request, as a line: a request to
 * pay arriving, or any request refused on arrival. **Only those**: they are the
 * requests a page waits on for minutes, and nothing is written about the others.
 */
export function recordChannelState(port: Port, state: ChannelState, at: number = Date.now()): void {
  if (state.of === 'request' && state.request.kind === 'balance') recordAsk(port, 'asked', state.request.kind, at);
  if (state.of === 'refused') {
    const code = (state.error as { code?: unknown } | null)?.code;
    recordAsk(port, 'asked', `refused-on-arrival:${typeof code === 'string' ? code : 'unknown'}`, at);
  }
}

/**
 * **THE CHANNEL, WITH EVERY MESSAGE THIS WALLET TRIES TO SEND WRITTEN DOWN** -
 * and whether it went: a terminal message the channel dropped, because the page
 * had already been answered, is recorded as `not-sent`. The channel itself is
 * unchanged underneath: this adds a line and nothing else.
 */
export function recordedChannel(channel: Channel, port: Port, now: () => number = Date.now): Channel {
  const refuse = (reason: Refusal | 'failed', why?: PaymentFailure): boolean => {
    const sent = reason === 'failed' ? channel.refuse('failed', why ?? 'did-not-finish') : channel.refuse(reason);
    recordAsk(port, sent ? 'sent' : 'not-sent', reason === 'failed' ? `refused:failed:${why ?? 'did-not-finish'}` : `refused:${reason}`, now());
    return sent;
  };
  return Object.freeze({
    answer: (answer: Parameters<Channel['answer']>[0]) => {
      const sent = channel.answer(answer);
      recordAsk(port, sent ? 'sent' : 'not-sent', 'answer', now());
      return sent;
    },
    refuse: refuse as Channel['refuse'],
    progress: (stage: ProgressStage) => {
      const sent = channel.progress(stage);
      if (sent) recordAsk(port, 'sent', `progress:${stage}`, now());
      return sent;
    },
    over: () => channel.over(),
    stop: () => channel.stop(),
  });
}

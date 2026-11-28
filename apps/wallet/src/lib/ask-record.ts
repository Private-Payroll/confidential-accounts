import type { Channel, ChannelState, PaymentFailure, ProgressStage, Refusal } from 'midnight-identity/profile/channel';
import type { Port } from 'midnight-identity/profile/store';

/* What this wallet showed and sent for each request to pay, or refused on arrival, so a stuck wait can be explained.
 * A line never holds an amount, an address, a token, a transaction, a key or the page's own words. */

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

/* Each word of a detail is kept only when it is lower-case letters joined by `-`; anything else becomes `other`,
 * so no digit or fragment of a value is ever carried. */
const FIXED_WORD = /^[a-z]+(?:-[a-z]+)*$/u;
const word = (detail: string): string =>
  detail
    .split(':')
    .map((w) => (FIXED_WORD.test(w) && w.length <= 32 ? w : 'other'))
    .join(':')
    .slice(0, 48);

const WHATS: readonly string[] = ['asked', 'shown', 'sent', 'not-sent'];

const isLine = (l: unknown): l is AskRecordLine =>
  typeof l === 'object' &&
  l !== null &&
  'at' in l &&
  typeof l.at === 'number' &&
  'detail' in l &&
  typeof l.detail === 'string' &&
  'what' in l &&
  typeof l.what === 'string' &&
  WHATS.includes(l.what);

/** Every line kept here, oldest first. An unreadable record reads as none. */
export function readAskRecord(port: Port): AskRecordLine[] {
  try {
    const raw = port.getItem(ASK_RECORD_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isLine) : [];
  } catch {
    return [];
  }
}

/** Adds one line, never throwing and never stopping what it records: a record that cannot be written is not kept. */
export function recordAsk(port: Port, what: AskRecordWhat, detail: string, at: number = Date.now()): void {
  const line: AskRecordLine = { at, what, detail: word(detail) };
  try {
    const lines = readAskRecord(port);
    const last = lines[lines.length - 1];
    /* A wallet at work says the same stage many times, and a screen can show one twice; one line says when it last
     * did, and how often. */
    if (last !== undefined && last.what === line.what && last.detail === line.detail) {
      lines[lines.length - 1] = { ...last, at, times: (last.times ?? 1) + 1 };
    } else {
      lines.push(line);
    }
    port.setItem(ASK_RECORD_KEY, JSON.stringify(lines.slice(-KEPT_LINES)));
  } catch {
    /* storage full or refused: the console line below still says it */
  }
  try {
    console.info(`[wallet record] ${new Date(at).toISOString()} ${line.what} ${line.detail}`);
  } catch {
    /* no console */
  }
}

/** Records a request to pay arriving, or any request refused on arrival; nothing is written about the others. */
export function recordChannelState(port: Port, state: ChannelState, at: number = Date.now()): void {
  if (state.of === 'request' && state.request.kind === 'balance') recordAsk(port, 'asked', state.request.kind, at);
  if (state.of === 'refused') {
    const code = (state.error as { code?: unknown } | null)?.code;
    recordAsk(port, 'asked', `refused-on-arrival:${typeof code === 'string' ? code : 'unknown'}`, at);
  }
}

/** The channel, with every message this wallet tries to send recorded, and `not-sent` for one the channel dropped. */
export function recordedChannel(channel: Channel, port: Port, now: () => number = Date.now): Channel {
  const refuse = (reason: Refusal | 'failed', why?: PaymentFailure): boolean => {
    const sent = reason === 'failed' ? channel.refuse('failed', why ?? 'did-not-finish') : channel.refuse(reason);
    recordAsk(
      port,
      sent ? 'sent' : 'not-sent',
      reason === 'failed' ? `refused:failed:${why ?? 'did-not-finish'}` : `refused:${reason}`,
      now()
    );
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
    stop: () => channel.stop()
  });
}

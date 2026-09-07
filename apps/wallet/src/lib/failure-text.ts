/**
 * ONE FORMATTER FOR EVERY FAILURE THIS WALLET SHOWS A PERSON.
 *
 * The first real send got as far as a real proof and was then refused by the
 * SDK's own pre-submit check, and the report said only:
 *
 *     the act stopped at "pre-flight validation": .
 *
 * Nothing after the colon. `validateTransaction` throws
 * `new WellFormedError({ cause })` — the type is
 * `WellFormedError extends WellFormedError_base<{ cause: unknown }>`,
 * ONE field, NOT optional
 * (`@midnightntwrk/wallet-sdk-capabilities/dist/validation/validationService.d.ts:30-33`),
 * thrown at `validationService.js:47`. Read in Effect's own source rather
 * than assumed: `Data.Error`'s constructor is
 * `super(args?.message, args?.cause ? { cause: args.cause } : undefined)`
 * followed by `Object.assign(this, args)`
 * (`effect/dist/esm/Data.js:269-279`), so an error built with `{ cause }`
 * alone has `message === ''` and carries `cause` twice over — as its own
 * enumerable property and as the native `Error.cause`. `TaggedError` then
 * sets `Base.prototype.name = tag` (`Data.js:302`), so the `_tag` is already
 * sitting in `.name` for a reader who thinks to look.
 *
 * Every error surface in this wallet formatted `e.message` and stopped, so
 * the ledger's complaint was deleted before anybody read it. On a report
 * that is annoying. On the send screen it is a `failed` card carrying no
 * reason at all — a definite negative statement with nothing behind it,
 * which is the same disease.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: **nothing in this wallet may report a
 * failure as a blank.** Not as `''`, and not as `[object Object]` either —
 * a blank wearing a disguise is still a blank.
 */

/** How deep the `cause` chain is walked before the text is cut short. */
const MAX_DEPTH = 8;

/** What is said when every other reading of a value came out empty. */
const LAST_RESORT = 'an unnamed failure (the error carried no message, no tag and no cause)';

/**
 * A value rendered on its own, WITHOUT its cause — one link of the chain.
 *
 * Order matters, and it is the order of how much a person can act on:
 * a real message first; then the `_tag`/`name` an Effect `TaggedError`
 * carries even when it has no message; then the shapes that are not errors
 * at all. `String(value)` is never the last word, because `String({})` is
 * `'[object Object]'` and that tells a person nothing.
 */
function renderOne(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (typeof value === 'string') return value.trim() === '' ? '' : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);

  if (value instanceof Error) {
    const message = typeof value.message === 'string' ? value.message.trim() : '';
    if (message !== '') return message;
    /* NO MESSAGE. An Effect `Data.TaggedError` puts its `_tag` on the
     * instance AND on `name` (`Data.js:302`); a plain Error has a `name`
     * too. Either is a great deal more than the empty string. */
    const tag = tagOf(value);
    if (tag !== '') return tag;
    return '';
  }

  /* Not an Error. It may still be error-shaped — Effect failures logged by
   * the SDK arrive as `{_tag: 'Fail', error: ...}`, and wasm bindings throw
   * whatever was in the externref table. Read the shape rather than
   * stringifying it into nothing. */
  if (typeof value === 'object') {
    const tag = tagOf(value);
    const own = value as Record<string, unknown>;

    const message = typeof own.message === 'string' ? own.message.trim() : '';
    if (message !== '' && tag !== '') return `${tag}: ${message}`;
    if (message !== '') return message;

    const nested = own.error;
    if (nested !== undefined && nested !== value) {
      const inner = renderOne(nested);
      if (inner !== '') return tag !== '' ? `${tag}: ${inner}` : inner;
    }

    const printed = printedForm(value);
    if (printed !== '') return tag !== '' ? `${tag}: ${printed}` : printed;
    if (tag !== '') return tag;
    return '';
  }

  return '';
}

/** The `_tag` an Effect error carries, or the `name` any Error carries. */
function tagOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const record = value as Record<string, unknown>;
  const tag = record._tag;
  if (typeof tag === 'string' && tag.trim() !== '') return tag;
  const name = record.name;
  if (typeof name === 'string' && name.trim() !== '' && name !== 'Error') return name;
  return '';
}

/**
 * An object turned into something readable WITHOUT going through
 * `String()`. A custom `toString` is worth having; the inherited one is
 * exactly the `[object Object]` this file exists to refuse.
 */
function printedForm(value: object): string {
  const own = value as { toString?: unknown };
  if (typeof own.toString === 'function' && own.toString !== Object.prototype.toString) {
    try {
      const printed = String(value).trim();
      if (printed !== '' && printed !== '[object Object]') return printed;
    } catch { /* a throwing toString is not a reason to lose the failure */ }
  }
  try {
    const json = JSON.stringify(value, jsonSafe());
    if (typeof json === 'string' && json !== '' && json !== '{}' && json !== 'null') {
      return json.length > 600 ? `${json.slice(0, 600)}…` : json;
    }
  } catch { /* cyclic or unserialisable — fall through */ }
  return '';
}

/** A JSON replacer that survives bigints, functions and cycles. */
function jsonSafe(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    return value;
  };
}

/** The next link in the chain: the native `cause`, or an Effect `error` field. */
function causeOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if ('cause' in record && record.cause !== undefined && record.cause !== value) return record.cause;
  return undefined;
}

/**
 * WHAT A PERSON IS TOLD WENT WRONG. Never empty, never `[object Object]`.
 *
 * A failure is rendered as its own reading, then each link of its `cause`
 * chain, joined by ` <- caused by: `. An error with a message reads exactly
 * as it used to and gains whatever its cause adds; an error with NO message
 * — which is the whole point — reads as its `_tag` followed by the
 * complaint the ledger actually made.
 *
 * Used at every failure surface in this wallet. `probe.ts` runs it BEFORE
 * `adviceFor`, because a classifier reading an empty string is not
 * the probe declining to classify a reason: it is this defect being handed
 * to the instrument built to catch it.
 */
export function describeFailure(e: unknown): string {
  const parts: string[] = [];
  const seen = new WeakSet<object>();
  let current: unknown = e;

  for (let depth = 0; depth < MAX_DEPTH && current !== undefined; depth += 1) {
    if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) {
        parts.push('[circular cause]');
        break;
      }
      seen.add(current);
    }

    const rendered = renderOne(current);
    if (rendered !== '' && !parts.includes(rendered)) parts.push(rendered);

    const next = causeOf(current);
    if (next === undefined) break;
    if (depth === MAX_DEPTH - 1) {
      parts.push('[further causes not shown]');
      break;
    }
    current = next;
  }

  const text = parts.join(' <- caused by: ').trim();
  return text === '' ? LAST_RESORT : text;
}

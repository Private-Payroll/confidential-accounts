import {
  ACT_CALL_SCHEMA, ACT_ENDED_SCHEMA, ACT_KEEP_SCHEMA, ACT_REFUSED_CODE, ACT_REFUSED_KEY, ACT_RELAY_SCHEMA, ACT_STOPS,
  MOST_ACT_CALL_BODY, MOST_ACT_CALLS, MOST_ACT_RELAYS, MOST_ACT_STEPS, MOST_ACT_TRANSACTION,
} from './channel.js';
import type { ActCall, ActEnded, ActKeep, ActRelay, ActStop } from './channel.js';
import { readKeysRead, readSealedKeyring } from './unlock.js';
import { ACT_INTENTS, type IntentShape } from './act-intents.js';
export { routeOf, sendsIn } from './act-intents.js';
export { intentShapeOf } from './act-shape.js';

/**
 * READING WHAT AN ACTION HANDS THE PAGE. The messages a wallet sends while it
 * runs an action, and the answer it ends on, read by the page that relays
 * them: a transaction, saved keys sealed again, a call to the service, and how
 * the action ended. The wallet's own channel (`channel.ts`) reads its outgoing
 * messages with the same readers before it sends them.
 *
 * They are their own module, apart from the channel's names and limits, because
 * they read sealed saved keys (`unlock.ts`) and the table of actions
 * (`act-intents.ts`), with the action's entry they are checked against. A page
 * that signs a person in imports the channel's names and not these, so neither
 * is in the page's first download.
 */

/** A count from 1 up to `most`, as every step and hand-over of an action is numbered. */
export const countFrom1 = (n: unknown, most: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= most;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/** Reads saved keys an action hands back sealed, for the ask with this nonce; `null` for anything else. */
export function readActKeep(raw: unknown, nonce: string): ActKeep | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m['schema'] !== ACT_KEEP_SCHEMA || m['nonce'] !== nonce) return null;
  if (!countFrom1(m['n'], MOST_ACT_RELAYS) || !countFrom1(m['steps'], MOST_ACT_STEPS)
    || !countFrom1(m['step'], m['steps'] as number)) return null;
  const ifVersion = m['ifVersion'];
  if (typeof ifVersion !== 'number' || !Number.isSafeInteger(ifVersion) || ifVersion < 0) return null;
  const sealed = readSealedKeyring(m['sealed']);
  if (sealed === null) return null;
  return Object.freeze({
    schema: ACT_KEEP_SCHEMA, nonce, n: m['n'] as number, step: m['step'] as number, steps: m['steps'] as number, sealed, ifVersion,
  });
}

/** A call as the page reads it, or null when it is not one: the shape only; whether the action may make it is the page's route check. */
export function readActCall(raw: unknown, nonce: string): ActCall | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m['schema'] !== ACT_CALL_SCHEMA || m['nonce'] !== nonce) return null;
  if (!countFrom1(m['n'], MOST_ACT_CALLS) || !countFrom1(m['steps'], MOST_ACT_STEPS)
    || !countFrom1(m['step'], m['steps'] as number)) return null;
  const method = m['method'];
  if (method !== 'GET' && method !== 'PUT' && method !== 'POST') return null;
  const path = m['path'];
  if (typeof path !== 'string' || path.length > 512 || !path.startsWith('/api/')) return null;
  const body = m['body'];
  if (body !== undefined && (typeof body !== 'string' || body.length > MOST_ACT_CALL_BODY || method === 'GET')) return null;
  return Object.freeze({
    schema: ACT_CALL_SCHEMA, nonce, n: m['n'] as number, step: m['step'] as number, steps: m['steps'] as number,
    method, path, ...(body === undefined ? {} : { body: body as string }),
  });
}

/** Reads one transaction an action hands over, for the ask with this nonce; `null` for anything else. */
export function readActRelay(raw: unknown, nonce: string): ActRelay | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m['schema'] !== ACT_RELAY_SCHEMA || m['nonce'] !== nonce) return null;
  if (!countFrom1(m['n'], MOST_ACT_RELAYS) || !countFrom1(m['steps'], MOST_ACT_STEPS)
    || !countFrom1(m['step'], m['steps'] as number)) return null;
  const transaction = m['transaction'];
  if (!aTransaction(transaction)) return null;
  const what = m['what'];
  if (what !== undefined && (typeof what !== 'string' || !RELAY_NAME.test(what))) return null;
  const also = m['also'];
  if (also !== undefined && (what === undefined || !aTransaction(also))) return null;
  return Object.freeze({
    schema: ACT_RELAY_SCHEMA, nonce, n: m['n'] as number, step: m['step'] as number, steps: m['steps'] as number, transaction,
    ...(what === undefined ? {} : { what: what as string }), ...(also === undefined ? {} : { also: also as string }),
  });
}

/** A relay's name: lower-case words joined by hyphens, as `act-intents.ts` lists them. */
const RELAY_NAME = /^[a-z]+(?:-[a-z]+){0,5}$/u;

const aTransaction = (t: unknown): t is string =>
  typeof t === 'string' && t.length > 0 && t.length <= MOST_ACT_TRANSACTION && t.length % 4 === 0 && BASE64.test(t);

const OUTCOME_VAULT = /^[0-9a-f]{64}$/u;
const OUTCOME_CODES = /^[a-z]+(?:-[a-z]+){0,7}(?:,[a-z]+(?:-[a-z]+){0,7}){0,7}$/u;

/** An action's outcome as its entry allows it, or undefined when there is none, or null when it carries anything else. */
export function readOutcome(raw: unknown, intent: string): Readonly<Record<string, string | number>> | undefined | null {
  if (raw === undefined) return undefined;
  const shapes = ACT_INTENTS as Readonly<Record<string, IntentShape>>;
  const kinds = Object.prototype.hasOwnProperty.call(shapes, intent) ? shapes[intent]?.outcome : undefined;
  if (kinds === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const kind = Object.prototype.hasOwnProperty.call(kinds, k) ? kinds[k] : undefined;
    if (kind === 'vault' && typeof v === 'string' && OUTCOME_VAULT.test(v)) out[k] = v;
    else if (kind === 'count' && typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000) out[k] = v;
    else if (kind === 'code' && typeof v === 'string' && OUTCOME_CODES.test(v)) out[k] = v;
    else return null;
  }
  return Object.freeze(out);
}

/** Reads how an action ended, for the ask with this nonce and intent; `null` for anything else. */
export function readActEnded(raw: unknown, expecting: { readonly nonce: string; readonly intent: string }): ActEnded | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const outcome = readOutcome(m['outcome'], expecting.intent);
  if (outcome === null) return null;
  const keys = m['keys'] === undefined ? undefined : readKeysRead(m['keys']);
  if (keys === null || (keys !== undefined && (Object.keys(keys.viewing).length > 1 || keys.resealed !== null))) return null;
  const told = { ...(outcome === undefined ? {} : { outcome }), ...(keys === undefined ? {} : { keys }) };
  if (m['schema'] !== ACT_ENDED_SCHEMA || m['nonce'] !== expecting.nonce || m['intent'] !== expecting.intent) return null;
  if (!countFrom1(m['steps'], MOST_ACT_STEPS) || !countFrom1(m['step'], m['steps'] as number)) return null;
  const relayed = m['relayed'];
  if (typeof relayed !== 'number' || !Number.isSafeInteger(relayed) || relayed < 0 || relayed > MOST_ACT_RELAYS) return null;
  const unconfirmed = m['unconfirmed'];
  if (typeof unconfirmed !== 'number' || !Number.isSafeInteger(unconfirmed) || unconfirmed < 0
    || relayed + unconfirmed > MOST_ACT_RELAYS) return null;
  const ended = m['ended'];
  if (ended === 'done') {
    if (m['step'] !== m['steps'] || 'why' in m || unconfirmed !== 0) return null;
    return Object.freeze({
      schema: ACT_ENDED_SCHEMA, nonce: expecting.nonce, intent: expecting.intent, ended, step: m['step'] as number,
      steps: m['steps'] as number, relayed, unconfirmed, ...told,
    });
  }
  if (ended !== 'stopped' || !(ACT_STOPS as readonly unknown[]).includes(m['why'])) return null;
  /* Which refusal a refused check stopped at, kept only in its own shape and only on `check-failed`; anything else is dropped. */
  const refused = m['refused'], code = m['code'];
  const said = m['why'] === 'check-failed' && typeof refused === 'string' && ACT_REFUSED_KEY.test(refused)
    ? { refused, ...(typeof code === 'string' && ACT_REFUSED_CODE.test(code) ? { code } : {}) }
    : {};
  return Object.freeze({
    schema: ACT_ENDED_SCHEMA, nonce: expecting.nonce, intent: expecting.intent, ended, step: m['step'] as number,
    steps: m['steps'] as number, relayed, unconfirmed, why: m['why'] as ActStop, ...said, ...told,
  });
}

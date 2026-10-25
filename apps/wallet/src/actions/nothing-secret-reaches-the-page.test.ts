import { beforeEach, describe, expect, it, vi } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import type { ActEnded, ActingChannel } from 'midnight-identity/profile/channel';
import type { ActRequest, KeyringRequest } from 'midnight-identity/profile/request';
import { fromHex, toHex } from '../../../../src/core/crypto.js';
import { sealKeyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { KeyringMark, KeyringMarks } from '../keyring/held-keyring.js';
import { checkedChannel, forgetWatched, SecretWouldCross } from '../keyring/nothing-secret-crosses.js';
import { keysReadForThePage } from '../keyring/read-for-the-page.js';
import { keyringParentFor, keyringSealKeyFor } from '../keyring/seal-key.js';
import type { ActionDefinition, ActionStep, Held } from './definition.js';
import { runAction } from './run.js';

/*
 * **NO SECRET OF THE SAVED KEYS REACHES THE PAGE, HOWEVER THE CODE THAT BUILT THE MESSAGE GOT HOLD OF IT.** Every
 * message the wallet sends the page is checked for the bytes of a secret it opened - a seat's signing secret, wrapping
 * secret or blinding, the seal key or its parent - and one that holds any is not sent: an action stops at that step, an
 * end answer goes out with nothing in it but that it stopped, and a keyring answer is not given. Each secret below is
 * put in by value, as no check of names could see it.
 */

const leak = vi.hoisted(() => ({ atTheEnd: false }));
vi.mock('../keyring/read-for-the-page.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../keyring/read-for-the-page.js')>();
  return {
    ...real,
    /* A read for the end answer that carries a whole seat, by value, when a test plants it. */
    readFor: (...args: Parameters<typeof real.readFor>) => {
      const read = real.readFor(...args);
      return leak.atTheEnd ? { ...read, seats: { ...read.seats, ...args[2].accounts } } : read;
    },
  };
});

const START = Date.now();
const secret = newSecret();
const identity = identityFromSecret(secret);
const held: Held = { identity, secret };
const REQUESTER = { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' };
const KEY = toHex(keyringSealKeyFor(identity, { requester: REQUESTER, person: 'usr_a' }));
const SEAT = {
  signerId: 'sig_1', signingSecret: '5a'.repeat(32), wrappingSecret: '6b'.repeat(32), blinding: 'fb'.repeat(32), scope: '44'.repeat(32),
};
const sealed = () => ({ sealed: sealKeyring({ accounts: { acc_A: SEAT } }, KEY).sealed, version: 5 });

const request = (): ActRequest => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'act', requester: REQUESTER, purpose: 'A test.', nonce: 'n1',
  expiresAt: START + 20 * 60_000, hearsProgress: true, intent: { name: 'give-vault-keys' as never, fields: {} },
  person: 'usr_a', keyring: sealed(),
});
const marks = (): KeyringMarks => {
  const seen = new Map<string, KeyringMark>();
  return { markOf: (p) => seen.get(p) ?? null, raise: (p, m) => { seen.set(p, m); } };
};

/** A page that records everything it is handed. */
const aPage = () => {
  const handed: string[] = [];
  const ended: ActEnded[] = [];
  const channel: ActingChannel = {
    step: () => true,
    relay: async (_at, tx) => { handed.push(`relay ${tx}`); return 'relayed'; },
    keep: async () => { handed.push('keep'); return { of: 'kept', version: 6 }; },
    call: async (_at, method, path, body) => { handed.push(`${method} ${path} ${body ?? ''}`); return { of: 'called', status: 200, body: null } as never; },
    answer: (a) => { ended.push(a as ActEnded); return true; },
    refuse: () => true, progress: () => true, over: () => false, stop: () => {},
  };
  return { channel, handed, ended };
};
const actionOf = (steps: readonly ActionStep[]): ActionDefinition => ({
  headline: 'ask.act.headline', shown: async () => [], checks: [], check: async () => null, steps: () => steps,
});
const run = (steps: readonly ActionStep[], page: ReturnType<typeof aPage>) => runAction({
  definition: actionOf(steps), request: request(), channel: page.channel, held, stop: new AbortController().signal, marks: marks(),
});
const noSecretIn = (text: string): void => {
  for (const s of [SEAT.signingSecret, SEAT.wrappingSecret, SEAT.blinding, KEY]) expect(text.toLowerCase()).not.toContain(s);
};

beforeEach(() => { leak.atTheEnd = false; forgetWatched(); });

describe('NO SECRET OF THE SAVED KEYS REACHES THE PAGE', () => {
  it('an act-call body holding a seat by value is not sent, and the action stops at that step', async () => {
    const page = aPage();
    const end = await run([{
      title: { key: 'x' },
      run: async (c) => {
        const seat = c.keyring!.open().read().accounts['acc_A'];
        await c.call('PUT', '/api/accounts/acc_A/vault-keys', JSON.stringify({ ...seat }));
      },
    }], page);
    /* RED WHEN: the outgoing check is taken away, or the action's channel is not the checked one. */
    expect(page.handed).toEqual([]);
    expect(end.ended).toMatchObject({ ended: 'stopped', why: 'step-failed', step: 1 });
    noSecretIn(JSON.stringify(page.ended));
  });

  it('a relay holding a blinding as base64url is not handed over, and nothing after it is', async () => {
    const page = aPage();
    const end = await run([{
      title: { key: 'x' },
      run: async (c) => {
        const { blinding } = c.keyring!.open().read().accounts['acc_A']!;
        const b64 = btoa(String.fromCharCode(...fromHex(blinding))).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
        await c.relay(`tx:${b64}`).catch(() => undefined);
        await c.relay('AAAA');
      },
    }], page);
    /* RED WHEN: a secret in another spelling passes, or a refused message does not stop the action. */
    expect(page.handed).toEqual([]);
    expect(end.ended).toMatchObject({ ended: 'stopped', why: 'step-failed' });
  });

  it('an end answer holding a seat goes out as a bare stop, with nothing of the keys in it', async () => {
    leak.atTheEnd = true;
    const page = aPage();
    const end = await run([{ title: { key: 'x' }, run: async (c) => { c.keyring!.open(); } }], page);
    /* RED WHEN: the end answer is sent as built, seat and all. */
    expect(page.ended).toHaveLength(1);
    expect(page.ended[0]).toMatchObject({ ended: 'stopped', why: 'step-failed' });
    expect(page.ended[0]!.keys).toBeUndefined();
    noSecretIn(JSON.stringify(page.ended));
    expect(end.ended).toEqual(page.ended[0]);
  });

  it('a keyring answer holding a seat, or the seal key\'s parent, is not given', () => {
    const page = aPage();
    const channel = checkedChannel(page.channel);
    const ask = {
      schema: 'midnight-identity/disclosure-request/v1', kind: 'keyring', requester: REQUESTER, purpose: 'x', nonce: 'k1',
      expiresAt: START + 600_000, person: 'usr_a', signedInAs: null, company: null, account: null, drawLabel: false, keyring: sealed(),
    } as unknown as KeyringRequest;
    const here = keysReadForThePage({ identity, request: ask, marks: marks() })!;
    const answer = { schema: 'midnight-identity/keyring-release/v1', read: here.read };
    /* RED WHEN: the outgoing check is taken away, so an answer built with a seat in it is handed over. */
    expect(() => channel.answer({ ...answer, read: { ...here.read, seats: { acc_A: SEAT } } } as never)).toThrow(SecretWouldCross);
    expect(() => channel.answer({ ...answer, holder: toHex(keyringParentFor(identity)).toUpperCase() } as never)).toThrow(SecretWouldCross);
    expect(page.ended).toEqual([]);
    /* The answer as the wallet builds it goes, and the ask is over: what was watched is forgotten. */
    expect(channel.answer(answer as never)).toBe(true);
    expect(page.ended).toHaveLength(1);
    expect(() => channel.answer({ seats: { acc_A: SEAT } } as never)).not.toThrow();
  });

  it('a value the wallet never opened is no secret of the saved keys, and passes', async () => {
    const page = aPage();
    const end = await run([{
      title: { key: 'x' },
      run: async (c) => { c.keyring!.open(); await c.call('PUT', '/api/accounts/acc_A/vault-keys', JSON.stringify({ x: '9d'.repeat(32) })); },
    }], page);
    /* RED WHEN: the check refuses what it was never given to watch. */
    expect(end.ended).toMatchObject({ ended: 'done' });
    expect(page.handed).toHaveLength(1);
  });
});

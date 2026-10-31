import { describe, expect, it, vi } from 'vitest';

vi.mock('./act-intents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./act-intents.js')>();
  return {
    ...actual,
    ACT_INTENTS: Object.freeze({
      'name-a-vault': {
        fields: { company: 'record', vault: 'vault', title: 'words' },
        optional: ['vault'],
        calls: [
          { method: 'GET', path: '/api/accounts/:company' },
          { method: 'POST', path: '/api/accounts/:company/vaults', sends: true },
          { method: 'GET', path: '/api/accounts/:company/headers', query: ['after', 'limit'] },
        ],
        outcome: { vault: 'vault', approvals: 'count', said: 'code' },
      },
    }),
  };
});

import { ACT_CALLED_SCHEMA, ACT_CALL_SCHEMA, listen } from './channel.js';
import { readActCall, readActEnded } from './act-channel.js';
import type { ActingChannel, CalledOver, ChannelWindow } from './channel.js';
import { RequestError, parseAsk, routeOf } from './request.js';
import { ACT_INTENTS, type IntentShape } from './act-intents.js';

/*
 * **AN ACTION ASKS THE PAGE FOR A CALL TO THE SERVICE ONLY WHERE ITS ENTRY NAMES ONE, AND HEARS THE ANSWER ONLY FROM
 * THE PAGE THAT ASKED.** The answer is the page's word, carried as given; what the action may tell the page at its
 * end is only the public parts its entry lists.
 */

const NOW = 1_755_000_000_000;
const PAGE = 'https://app.payroll.example';
const SHAPE = (ACT_INTENTS as unknown as Record<string, IntentShape>)['name-a-vault']!;
const VAULT = 'c'.repeat(64);

const act = (intent: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'act', requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'To name a vault.', nonce: 'n1', expiresAt: NOW + 600_000,
  intent: { name: 'name-a-vault', company: 'acc_1', title: 'Payroll float', ...intent },
});
const refusal = (raw: unknown): string => {
  try {
    parseAsk(raw, PAGE, NOW);
  } catch (e) {
    if (e instanceof RequestError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('an action names a record and carries the page\'s words, and may leave out what its entry says is optional', () => {
  it('reads a record\'s name and the page\'s words, and an optional vault given or not', () => {
    const read = parseAsk(act(), PAGE, NOW);
    /* RED WHEN: a record's name or the page's words are refused, or an optional field is required. */
    expect(read.kind === 'act' ? read.intent.fields : null).toEqual({ company: 'acc_1', title: 'Payroll float' });
    const resumed = parseAsk(act({ vault: VAULT }), PAGE, NOW);
    /* RED WHEN: an optional field given is dropped. */
    expect(resumed.kind === 'act' ? resumed.intent.fields['vault'] : null).toBe(VAULT);
  });

  it('refuses a record\'s name that is a path, words with control characters or too long, and a required field left out', () => {
    /* RED WHEN: a record's name can carry a path, so a call built from it reaches another route. */
    expect(refusal(act({ company: 'acc/../x' }))).toBe('not-an-act');
    expect(refusal(act({ company: '' }))).toBe('not-an-act');
    /* RED WHEN: the page's words can carry control characters or run past their bound. */
    expect(refusal(act({ title: 'a\u0000b' }))).toBe('not-an-act');
    expect(refusal(act({ title: 'x'.repeat(2_001) }))).toBe('not-an-act');
    expect(refusal(act({ title: 'two\nlines' }))).toBe('accepted');
    /* RED WHEN: optional fields let a required one be left out. */
    const missing = act();
    delete (missing['intent'] as Record<string, unknown>)['company'];
    expect(refusal(missing)).toBe('not-an-act');
  });
});

describe('a call matches a route of its action, segment by segment, or nothing', () => {
  it('matches the listed routes with one plain segment for each name', () => {
    /* RED WHEN: a listed route is not matched, so the action cannot read what it needs. */
    expect(routeOf(SHAPE, 'GET', '/api/accounts/acc_1')).toEqual({ method: 'GET', path: '/api/accounts/:company' });
    expect(routeOf(SHAPE, 'POST', '/api/accounts/acc_1/vaults')?.sends).toBe(true);
    /* RED WHEN: a route that names its query parameters cannot be read with them. */
    expect(routeOf(SHAPE, 'GET', '/api/accounts/acc_1/headers?after=3&limit=50')?.path).toBe('/api/accounts/:company/headers');
    expect(routeOf(SHAPE, 'GET', '/api/accounts/acc_1/headers')?.path).toBe('/api/accounts/:company/headers');
  });

  it('matches nothing for a query parameter its route does not name, one given twice, or a value that is not plain', () => {
    /* RED WHEN: a call can carry a query its route does not name, and so reach the service with what the action never asks. */
    for (const path of [
      '/api/accounts/acc_1/headers?after=3&root=x', '/api/accounts/acc_1/headers?after=3&after=4', '/api/accounts/acc_1/headers?after=a%20b',
      '/api/accounts/acc_1/headers?after', '/api/accounts/acc_1/headers?after=1?limit=2', '/api/accounts/acc_1/headers?',
    ]) {
      expect(routeOf(SHAPE, 'GET', path), path).toBeNull();
    }
  });

  it('matches nothing for another method, another path, a longer path, a query, an encoded or a dot segment', () => {
    /* RED WHEN: a call reaches a route the action's entry does not name. */
    for (const [method, path] of [
      ['PUT', '/api/accounts/acc_1'], ['GET', '/api/accounts/acc_1/keys'], ['GET', '/api/accounts'],
      ['GET', '/api/accounts/acc_1?x=1'], ['GET', '/api/accounts/acc%2F1'], ['GET', '/api/accounts/..'],
      ['GET', '/api/accounts//'], ['GET', '/other/accounts/acc_1'], ['GET', 'https://evil.example/api/accounts/acc_1'],
    ] as const) {
      expect(routeOf(SHAPE, method, path), `${method} ${path}`).toBeNull();
    }
  });
});

const opened = () => {
  const posted: unknown[] = [];
  const opener = { postMessage: (m: unknown) => { posted.push(m); } };
  let handler: ((e: MessageEvent) => void) | null = null;
  const view = {
    opener, parent: null, addEventListener: (_t: string, h: (e: MessageEvent) => void) => { handler = h; },
    removeEventListener: () => { handler = null; },
  } as unknown as ChannelWindow;
  const from = (data: unknown, source: unknown = opener, origin = PAGE) =>
    handler?.({ source, origin, data } as unknown as MessageEvent);
  const channel = listen(view, () => NOW, () => {}, PAGE) as ActingChannel;
  return { posted, from, channel };
};
const called = (n: number, over: Record<string, unknown> = {}) =>
  ({ schema: ACT_CALLED_SCHEMA, nonce: 'n1', n, outcome: 'answered', status: 200, body: { id: 'acc_1' }, ...over });
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe('a call goes to the page that asked, numbered, and is answered only by it', () => {
  it('hands the call over in its shape and hears the status and body only from the asking window', async () => {
    const { posted, from, channel } = opened();
    from(act());
    let heard: CalledOver | null = null;
    void channel.call({ step: 1, steps: 2 }, 'POST', '/api/accounts/acc_1/vaults', '{"tx":"AAAA"}').then((r) => { heard = r; });
    /* RED WHEN: a call reaches the page in another shape, or without the body it carries. */
    expect(posted.at(-1)).toEqual({
      schema: ACT_CALL_SCHEMA, nonce: 'n1', n: 1, step: 1, steps: 2, method: 'POST', path: '/api/accounts/acc_1/vaults', body: '{"tx":"AAAA"}',
    });
    /* RED WHEN: the page reads the call without the body it carries, so a write reaches the service empty. */
    expect(readActCall(posted.at(-1), 'n1')?.body).toBe('{"tx":"AAAA"}');
    /* RED WHEN: another window, origin, ask or number can answer the call. */
    from(called(1), { postMessage: () => {} });
    from(called(1), undefined, 'https://evil.example');
    from(called(1, { nonce: 'another' }));
    from(called(2));
    await settle();
    expect(heard).toBeNull();
    from(called(1, { status: 409, body: { error: 'taken' } }));
    await settle();
    /* RED WHEN: the service's status or body is lost or changed on the way. */
    expect(heard).toEqual({ of: 'answered', status: 409, body: { error: 'taken' } });
  });

  it('an answer with no status the web uses is taken as a refusal, and an ended action leaves a call unanswered', async () => {
    const { from, channel } = opened();
    from(act());
    const one = channel.call({ step: 1, steps: 1 }, 'GET', '/api/accounts/acc_1');
    /* RED WHEN: a page can answer a call without saying what the service said. */
    from(called(1, { status: 42 }));
    expect(await one).toBe('refused');
    const two = channel.call({ step: 1, steps: 1 }, 'GET', '/api/accounts/acc_1');
    channel.answer({ schema: 'midnight-identity/act-ended/v1' } as never);
    /* RED WHEN: a call still waiting is left waiting for ever once the action has ended. */
    expect(await two).toBe('unanswered');
  });

  it('refuses to hand over a call that is not under /api/, or a read that carries a body', async () => {
    const { from, channel } = opened();
    from(act());
    /* RED WHEN: the wallet can ask the page to reach outside the service's own routes. */
    expect(await channel.call({ step: 1, steps: 1 }, 'GET', 'https://evil.example/api/x')).toBe('gone');
    expect(await channel.call({ step: 1, steps: 1 }, 'GET', '/api/accounts/acc_1', '{}')).toBe('gone');
  });
});

describe('the end of an action tells the page only the public parts its entry lists', () => {
  const ended = (outcome: unknown) => ({
    schema: 'midnight-identity/act-ended/v1', nonce: 'n1', intent: 'name-a-vault', ended: 'done', step: 2, steps: 2,
    relayed: 1, unconfirmed: 0, ...(outcome === undefined ? {} : { outcome }),
  });
  it('reads a vault, a count and short codes', () => {
    /* RED WHEN: the outcome the entry lists does not reach the page. */
    expect(readActEnded(ended({ vault: VAULT, approvals: 1, said: 'vault-name-not-filed,proposal-not-written-down' }), { nonce: 'n1', intent: 'name-a-vault' })?.outcome)
      .toEqual({ vault: VAULT, approvals: 1, said: 'vault-name-not-filed,proposal-not-written-down' });
    expect(readActEnded(ended(undefined), { nonce: 'n1', intent: 'name-a-vault' })?.outcome).toBeUndefined();
  });
  it('refuses an end that carries a part the entry does not list, or a part not of its kind', () => {
    /* RED WHEN: a wallet's end can carry anything beyond the public facts its entry names. */
    for (const outcome of [{ secret: 'ab'.repeat(32) }, { vault: 'not a vault' }, { approvals: -1 }, { said: 'Has Spaces' }, [1], 'x']) {
      expect(readActEnded(ended(outcome), { nonce: 'n1', intent: 'name-a-vault' }), JSON.stringify(outcome)).toBeNull();
    }
  });

  const stopped = (why: string, said: Record<string, unknown>) => ({
    schema: 'midnight-identity/act-ended/v1', nonce: 'n1', intent: 'name-a-vault', ended: 'stopped', step: 1, steps: 2,
    relayed: 0, unconfirmed: 0, why, ...said,
  });
  const at = { nonce: 'n1', intent: 'name-a-vault' };
  it('a stop for a refused check carries the key of its words and the kind of refusal, and nothing else of them', () => {
    const read = readActEnded(stopped('check-failed', { refused: 'act.name-a-vault.why.start-owed', code: 'chain-unread' }), at);
    /* RED WHEN: the page cannot say which check refused, or of what kind. */
    expect(read).toMatchObject({ why: 'check-failed', refused: 'act.name-a-vault.why.start-owed', code: 'chain-unread' });
    /* RED WHEN: a code reaches the page without the key it qualifies. */
    expect(readActEnded(stopped('check-failed', { code: 'chain-unread' }), at)).not.toHaveProperty('code');
  });
  it('drops a refusal not in its shape, or on any stop but a refused check, and keeps the rest of the end', () => {
    for (const said of [
      { refused: 'act.name-a-vault.why.start-owed 12 USDC' }, { refused: 'Setting up this vault did not finish' },
      { refused: `act.x.why.${'ab'.repeat(32)}0` }, { refused: { key: 'act.x.why.y' } },
    ]) {
      const read = readActEnded(stopped('check-failed', said), at);
      /* RED WHEN: words, an amount, a digit or anything but a key in its shape reaches the page as the refusal. */
      expect(read, JSON.stringify(said)).not.toBeNull();
      expect(read, JSON.stringify(said)).not.toHaveProperty('refused');
    }
    const badCode = readActEnded(stopped('check-failed', { refused: 'act.x.why.y', code: 'seat 7' }), at);
    /* RED WHEN: a code not in its shape reaches the page. */
    expect(badCode).toMatchObject({ refused: 'act.x.why.y' });
    expect(badCode).not.toHaveProperty('code');
    /* RED WHEN: a stop that is not a refused check carries a refusal. */
    expect(readActEnded(stopped('step-failed', { refused: 'act.x.why.y', code: 'z' }), at)).not.toHaveProperty('refused');
  });
});

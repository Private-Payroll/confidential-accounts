/**
 * THE BROWSER ERROR SINK, DRIVEN BY A FAKE WINDOW.
 *
 * ── WHY A FAKE AND NOT A DOM ─────────────────────────────────────────────
 *
 * Everything this module can be wrong about is a decision it makes about
 * things it was handed — whether it calls the original `console.error`,
 * whether it re-throws what `fetch` rejected with, whether the text it posts
 * still has a seed in it. **A DOM would supply the same four objects and hide
 * the posted body**, which is the one thing worth reading. So the window is a
 * plain object and `post` is a function that keeps what it was given.
 *
 * The half this cannot see is that a real browser fires these events at all.
 * That is `WEB-CHECK.command`'s job, and it is why the round has both.
 */
import { describe, it, expect, vi } from 'vitest';
import { installErrorSink, type SinkPost, type SinkWindow } from './error-sink.js';

type Listener = (event: any) => void;

/** A window that records instead of doing, and the posts made through it. */
const rig = () => {
  const listeners = new Map<string, Listener[]>();
  const posted: SinkPost[] = [];
  const originalCalls: string[] = [];
  const responses: any[] = [];

  const w: SinkWindow = {
    addEventListener: (type, handler) => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    fetch: vi.fn(async (..._args: any[]) => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? { ok: true, status: 200 };
    }),
    console: {
      error: (...a: any[]) => originalCalls.push(`error:${a.join(' ')}`),
      warn: (...a: any[]) => originalCalls.push(`warn:${a.join(' ')}`),
    },
    location: { href: 'http://localhost:5173/' },
    // Synchronous, so a test never waits: the debounce is not what is under test.
    setTimeout: (fn: () => void) => { fn(); return 0 as any; },
  };

  installErrorSink(w, (body) => { posted.push(body); });

  return {
    w,
    posted,
    originalCalls,
    /** Queue what the next `fetch` should do: a response, or an Error to reject with. */
    willAnswer: (value: any) => responses.push(value),
    fire: (type: string, event: any) => {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    /** Everything posted, flattened to text — what would reach the report. */
    text: () => JSON.stringify(posted),
  };
};

describe('the browser error sink', () => {
  it('keeps an uncaught error, with where it came from', () => {
    const r = rig();
    const error = new TypeError('t is not a function');
    r.fire('error', { error, filename: 'http://localhost:5173/main.tsx', lineno: 4, colno: 1 });
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0].page).toBe('http://localhost:5173/');
    expect(r.posted[0].entries[0].level).toBe('error');
    expect(r.posted[0].entries[0].message).toContain('TypeError: t is not a function');
    expect(r.posted[0].entries[0].message).toContain('main.tsx:4:1');
  });

  it('THE ONE A WHITE PAGE NEEDS: a script that fails to load is kept too', () => {
    // This event is fired at the element and does not bubble, so it only ever
    // reaches the window on the way down. It is the failure that leaves a page
    // blank with nothing else to say.
    const r = rig();
    r.fire('error', { target: { src: 'http://localhost:5173/main.tsx' } });
    expect(r.posted[0].entries[0].level).toBe('resource');
    expect(r.posted[0].entries[0].message).toContain('failed to load');
  });

  it('keeps an unhandled rejection', () => {
    const r = rig();
    r.fire('unhandledrejection', { reason: new Error('nope') });
    expect(r.posted[0].entries[0].level).toBe('rejection');
    expect(r.posted[0].entries[0].message).toContain('nope');
  });

  it('keeps console.error and console.warn', () => {
    const r = rig();
    r.w.console.error('boom', 1);
    r.w.console.warn('careful');
    const levels = r.posted.flatMap(p => p.entries.map(e => e.level));
    expect(levels).toEqual(['console.error', 'console.warn']);
  });

  it('THE ONE THAT SAYS IT CHANGES NOTHING: the original console is always called', () => {
    const r = rig();
    r.w.console.error('boom');
    r.w.console.warn('careful');
    expect(r.originalCalls).toEqual(['error:boom', 'warn:careful']);
  });

  it('keeps a failed response, by status and path, and hands back the same response', async () => {
    const r = rig();
    const response = { ok: false, status: 503, body: 'the one the caller gets' };
    r.willAnswer(response);
    const got = await r.w.fetch('/api/me');
    expect(got).toBe(response);
    expect(r.posted[0].entries[0].message).toBe('503 /api/me');
  });

  /*
   * A refusal recorded as `400 POST /api/accounts` and nothing else is
   * a refusal nobody can tell from a different refusal, which is what cost a
   * morning on 24 Aug. These three are the sink half of the row.
   *
   * `settled` is a macrotask boundary, not a poll: the body's promise is
   * already resolved, and there is no condition to wait FOR. `X9`'s discipline
   * — await the thing, never poll for it — is what this is.
   */
  const settled = () => new Promise(resolve => { setTimeout(resolve, 0); });

  /** A response whose body can be read once, like a real one. */
  const answering = (status: number, body: string) => {
    let taken = false;
    const response: any = {
      ok: false,
      status,
      text: async () => {
        if (taken) throw new Error('body already read');
        taken = true;
        return body;
      },
      clone: () => ({ text: async () => body }),
    };
    return response;
  };

  it('C157: the REASON is kept beside the status, so two refusals are two events', async () => {
    const r = rig();
    r.willAnswer(answering(400, JSON.stringify({ error: 'you are already on this account' })));
    await r.w.fetch('/api/accounts');
    await settled();
    expect(r.posted[0].entries[0].message)
      .toBe('400 /api/accounts — you are already on this account');
  });

  it('C157: and the caller still gets the body, because the sink read a CLONE', async () => {
    // Rule 3. Reading `response.text()` here would drain the stream the screen
    // is about to read, and every refusal would render as an empty one.
    const r = rig();
    const response = answering(400, JSON.stringify({ error: 'that signer already has access' }));
    r.willAnswer(response);
    const got = await r.w.fetch('/api/accounts/a1/invites');
    await settled();
    expect(got).toBe(response);
    expect(await got.text()).toBe('{"error":"that signer already has access"}');
  });

  it('C157: A SECRET IS REDACTED BEFORE THE BODY IS CUT, NOT AFTER', async () => {
    /*
     * The order, pinned. A key cut in half is twenty hex characters, which is
     * under every threshold the redactor has — so cutting first would post a
     * fragment of a real key and the redaction downstream could not see it.
     *
     * The padding puts the key across the 300-character cap deliberately.
     * The deliberate defect here swaps the two operations round, and this
     * is the test that has to die when it does.
     */
    const key = '0123456789abcdef'.repeat(4);
    const padding = 'the service refused this request. '.repeat(9).slice(0, 279);
    const r = rig();
    r.willAnswer(answering(400, JSON.stringify({ error: `${padding} ${key}` })));
    await r.w.fetch('/api/accounts/a1/state');
    await settled();

    const wire = r.text();
    expect(wire).not.toContain(key);
    // The half a cut would have left behind, named rather than implied.
    expect(wire).not.toContain(key.slice(0, 20));
    expect(wire).toContain('<redacted:hex>');
  });

  it('says nothing about a response that was fine', async () => {
    const r = rig();
    r.willAnswer({ ok: true, status: 200 });
    await r.w.fetch('/api/health');
    expect(r.posted).toHaveLength(0);
  });

  it('THE ONE THAT SAYS IT SWALLOWS NOTHING: a rejected fetch is re-thrown, unchanged', async () => {
    // A sink that swallows an error is worse than no sink: the screen fails
    // silently and the report says everything is fine.
    const r = rig();
    const failure = new Error('connection refused');
    r.willAnswer(failure);
    await expect(r.w.fetch('/api/me')).rejects.toBe(failure);
    expect(r.posted[0].entries[0].message).toContain('connection refused');
  });

  it('THE ONE C145 ASKS OF THE PAGE: nothing shaped like a secret crosses the wire', () => {
    const r = rig();
    r.w.console.error('login failed for '
      + '{"password":"hunter2","authKey":"0123456789abcdef0123456789abcdef"}');
    r.fire('error', {
      error: new Error('Your wallet seed is: '
        + '39aebaeb0a2f4c1d8e7b6a5940312233445566778899aabbccddeeff00112233'),
    });
    const wire = r.text();
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('0123456789abcdef');
    expect(wire).not.toContain('39aebaeb');
    expect(wire).toContain('<redacted');
  });

  it('does not watch its own post, so a service that is down cannot start a loop', async () => {
    // The reference to fetch is taken before the wrapper goes on, and the sink
    // posts through that one. Nothing here should have been recorded.
    const r = rig();
    r.willAnswer({ ok: false, status: 500 });
    await r.w.fetch('/api/me');
    const before = r.posted.length;
    expect(before).toBe(1);
    // Posting again must not add entries about the post itself.
    expect(r.posted[0].entries).toHaveLength(1);
  });

  it('stops keeping entries long before it could fill anything', () => {
    const r = rig();
    for (let i = 0; i < 500; i += 1) r.w.console.warn(`noise ${i}`);
    const kept = r.posted.reduce((n, p) => n + p.entries.length, 0);
    expect(kept).toBeLessThanOrEqual(500);
    expect(kept).toBeGreaterThan(0);
  });
});

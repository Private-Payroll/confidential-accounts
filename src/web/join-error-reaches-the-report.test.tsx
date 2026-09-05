// @vitest-environment jsdom
/**
 * **A JOURNEY THAT SHOWS A PERSON AN ERROR PUTS A LINE IN THE REPORT.**
 * `docs/NEXT.md` `X11` §5, `docs/how-money-can-be-lost.md` `C159`.
 *
 * ── THIS IS DELIBERATELY NOT A UNIT TEST, AND THE ROUND SAYS SO ──────────
 *
 * `C159` is not *the recording function does not record*. It is that **the one
 * class of failure that by definition reaches a human was the one class no
 * artefact kept**: the sink watches uncaught errors, unhandled rejections,
 * `console` calls and failed requests, and the failure the founder actually hit
 * was none of them — the application CAUGHT it and rendered it onto the screen,
 * which is the correct thing to do with an error a person needs to read.
 *
 * A test of `shownError` in isolation would have passed on the day `C159` was
 * open, because the function would have existed and nothing would have called
 * it. **So this drives a real screen through a real failure and reads what
 * would have crossed the wire to the sink.** If a future screen renders a
 * failure by some other route, this is what notices.
 *
 * ── AND IT IS THE INVITATION SCREEN BECAUSE THAT IS THE ROUND'S JOURNEY ──
 *
 * A person opening a link that has expired, been used, or been mistyped is the
 * commonest failure this round can produce, it happens to somebody who has no
 * account and cannot be asked to describe it, **and it is exactly the walk that
 * found `C159` in the first place.**
 *
 * ── NO `waitFor`, NO `findBy*` ───────────────────────────────────────────
 *
 * `C134`, `X9`'s discipline. Everything below awaits a thing: the fetch this
 * test itself controls, and React's own queue through `act`.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { JoinScreen, joinTokenFromLocation } from './Join.js';
import { installErrorSink, forgetSinkForTest, type SinkPost } from './error-sink.js';

afterEach(() => { cleanup(); forgetSinkForTest(); });

/** What the sink would have posted, without a service to post it to. */
let posted: SinkPost[] = [];

/**
 * Everything the sink touches on a window, pointed at the globals the screen
 * actually reaches.
 *
 * **`globalThis` AND NOT `window`, AND THAT COST TWENTY MINUTES.** A module
 * calling a bare `fetch` resolves it on the global object, and in this runner
 * that is not the same property as `window.fetch` — so a stub installed on
 * `window` alone is never called and the test hangs on a promise nothing
 * settles. Both are set, and the sink is handed a view over the one the code
 * under test uses.
 */
const armTheSink = (failing: (...args: any[]) => Promise<any>) => {
  posted = [];
  (globalThis as any).fetch = failing;
  (window as any).fetch = failing;
  installErrorSink(
    {
      addEventListener: (t: string, h: (e: any) => void, c?: boolean) =>
        window.addEventListener(t, h as never, c),
      get fetch() { return (globalThis as any).fetch; },
      set fetch(f: any) { (globalThis as any).fetch = f; (window as any).fetch = f; },
      console: window.console as never,
      location: window.location as never,
      /* Immediate, so a flush is something this test can await rather than
       * something it has to wait out. */
      setTimeout: (fn: () => void) => { fn(); return 0; },
    } as never,
    (body) => { posted.push(body); });
};

/** Every line the sink was given, whatever level it arrived at. */
const lines = () => posted.flatMap(p => p.entries);

beforeEach(() => {
  window.history.replaceState({}, '', '/join#inv_a-link-that-is-no-good');
});

/**
 * **RENDER IN ONE `act`, SETTLE IN THE NEXT — AND THIS COST HALF AN HOUR.**
 *
 * `act` flushes React's effects when its callback RETURNS. So awaiting the
 * screen's own fetch inside the same callback that renders it is a deadlock:
 * the effect that starts the fetch has not run yet, and it cannot run until the
 * callback returns, which is waiting on the fetch. It hangs for the whole test
 * timeout and says nothing about why.
 *
 * **AND IT IS NOT A REASON TO POLL.** `C134`, `X9`. Two `act`s, each awaiting a
 * thing: the first the commit, the second the promise this test itself settles.
 * No `waitFor`, no `findBy*`, no sleep.
 */
const renderAndSettle = async (element: React.ReactElement, settled: Promise<unknown>) => {
  await act(async () => { render(element); });
  await act(async () => { await settled; });
};

describe('§5 — a shown error is a recorded error', () => {
  it('THE INVITATION SCREEN SHOWS A REFUSAL AND THE REPORT KEEPS IT', async () => {
    /*
     * The exact refusal a real dead link produces: `offerFor` throws *"invite
     * not found"* and `wrap` answers 400 with it in the body.
     */
    let answer!: () => void;
    const arrived = new Promise<void>(r => { answer = r; });
    armTheSink(async () => {
      answer();
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: 'invite not found' }),
        clone: () => ({ text: async () => JSON.stringify({ error: 'invite not found' }) }),
      };
    });

    const token = joinTokenFromLocation(window.location);
    expect(token).toBe('inv_a-link-that-is-no-good');

    await renderAndSettle(<JoinScreen token={token!} />, arrived);

    /* ── THE PERSON READS IT ──────────────────────────────────────────── */
    expect(screen.getByText('invite not found')).toBeTruthy();

    /* ── AND THE REPORT KEEPS IT, WHICH IS THE WHOLE ROW ──────────────── */
    const shown = lines().filter(e => e.level === 'shown');
    expect(shown, 'a person read an error and the report has no line for it').toHaveLength(1);
    expect(shown[0]!.message).toContain('invite not found');
    /* Named by the journey, because a report of sentences with no context says
     * what went wrong and not what somebody was doing. */
    expect(shown[0]!.message).toContain('opening an invitation');
  });

  it('AND IT IS REDACTED ON THE WAY, LIKE EVERYTHING ELSE THAT REACHES DISK', async () => {
    /*
     * `C145`, `C148`. An error message can carry anything — and the one this
     * round can most easily produce carries a COMPANY ADDRESS or a payee
     * address, because those are what the failing steps are about.
     */
    const secret = 'ab'.repeat(32);
    let answer!: () => void;
    const arrived = new Promise<void>(r => { answer = r; });
    armTheSink(async () => {
      answer();
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: `this company is not on a chain: ${secret}` }),
        clone: () => ({ text: async () => '{}' }),
      };
    });

    await renderAndSettle(<JoinScreen token="inv_whatever" />, arrived);

    const shown = lines().filter(e => e.level === 'shown');
    expect(shown).toHaveLength(1);
    expect(shown[0]!.message).not.toContain(secret);
    expect(shown[0]!.message).toContain('<redacted');
    /*
     * **AND THE SCREEN SHOWS THE REDACTED SENTENCE TOO.** Deliberate: a person
     * reading one thing while the report keeps another is the exact confusion
     * an instrument exists to remove, and a secret is no safer on a screen
     * somebody is about to photograph than in a file.
     */
    expect(document.body.textContent).not.toContain(secret);
  });

  it('A LINK THAT IS NOT AN INVITATION IS NOT AN INVITATION SCREEN', () => {
    /*
     * The routing decision, as a fact rather than a comment: the token is read
     * from the FRAGMENT, which is never sent to a server, and only on `/join`.
     */
    expect(joinTokenFromLocation({ pathname: '/join', hash: '#inv_abc' })).toBe('inv_abc');
    expect(joinTokenFromLocation({ pathname: '/join/', hash: '#inv_abc' })).toBe('inv_abc');
    expect(joinTokenFromLocation({ pathname: '/', hash: '#inv_abc' })).toBeNull();
    expect(joinTokenFromLocation({ pathname: '/join', hash: '' })).toBeNull();
    /* A token in the PATH is not read, which is what keeps it out of a log. */
    expect(joinTokenFromLocation({ pathname: '/join/inv_abc', hash: '' })).toBeNull();
  });
});

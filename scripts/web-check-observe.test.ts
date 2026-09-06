/**
 * **THE ONE THING THE REPORT HAS TO GET RIGHT.**
 *
 * *"No errors and an empty page" is a different fault from "an error", and the
 * report has to be able to tell them apart.* That sentence is the whole reason
 * this round has a report format rather than a dump, and it is checkable
 * without a browser — so it is checked here, every run, rather than being
 * observed once during a walk.
 */
// @ts-ignore — the observing half is plain JavaScript, shared with the launcher.
import { renderReport } from './web-check-observe.mjs';
import { describe, it, expect } from 'vitest';

const collected = (over: any = {}) => ({
  console: [], errors: [], failed: [], timeline: [], ...over,
});
const rendered = (over: any = {}) => ({
  title: 'CA', body: '', rootChildren: 0, background: 'rgb(10, 14, 22)', ...over,
});
const report = (c: any, r: any) => renderReport({
  url: 'http://localhost:5173/',
  collected: c,
  rendered: r,
  startedAt: '2026-08-23T00:00:00.000Z',
  finishedAt: '2026-08-23T00:00:05.000Z',
});

describe('the report a real browser walk writes', () => {
  it('THE ONE THE ROUND EXISTS FOR: an empty page with nothing complaining says exactly that',
    () => {
      const out = report(collected(), rendered());
      expect(out).toContain('THE PAGE IS EMPTY AND NOTHING COMPLAINED');
      expect(out).toContain('elements in #root  0');
      expect(out).toContain('THE PAGE RENDERED NO TEXT AT ALL');
    });

  it('and an empty page that DID complain is a different sentence', () => {
    const out = report(
      collected({ errors: [{ message: 'TypeError: t is not a function', stack: 'at main.tsx:4:1' }] }),
      rendered(),
    );
    expect(out).toContain('THE PAGE IS EMPTY AND SOMETHING COMPLAINED');
    expect(out).not.toContain('THE PAGE IS EMPTY AND NOTHING COMPLAINED');
    expect(out).toContain('TypeError: t is not a function');
    expect(out).toContain('at main.tsx:4:1');
  });

  it('a page that rendered and complained is neither of those', () => {
    const out = report(
      collected({ console: [{ level: 'error', text: 'Warning: bad key' }] }),
      rendered({ body: 'Sign in', rootChildren: 1 }),
    );
    expect(out).toContain('THE PAGE RENDERED AND SOMETHING COMPLAINED');
  });

  it('and a clean walk says so without qualification', () => {
    const out = report(collected(), rendered({ body: 'Sign in', rootChildren: 1 }));
    expect(out).toContain('THE PAGE RENDERED AND NOTHING COMPLAINED');
  });

  it('every failed request is in it, with its status and its path', () => {
    const out = report(
      collected({ failed: [{ status: 404, url: 'http://localhost:5173/styles.css', method: 'GET' }] }),
      rendered({ body: 'Sign in', rootChildren: 1 }),
    );
    expect(out).toContain('404');
    expect(out).toContain('/styles.css');
  });

  it('THE ONE THE FIRST WALK ADDED: a failed load nothing can name is called out', () => {
    // The browser fetches a favicon on its own behalf, outside the page, and
    // reports the failure to nothing that can name what failed. Left alone the
    // report says "a resource failed" in one section and "(none)" in the next,
    // which reads as a bug in the instrument.
    const out = report(
      collected({ console: [{ level: 'error', text: 'Failed to load resource: the server responded with a status of 404 (Not Found)' }] }),
      rendered({ body: 'Sign in', rootChildren: 1 }),
    );
    expect(out).toContain('DID NOT ATTRIBUTE TO A REQUEST');
  });

  it('and it is not said when the failure was attributed', () => {
    const out = report(
      collected({
        console: [{ level: 'error', text: 'Failed to load resource: the server responded with a status of 404 (Not Found)' }],
        failed: [{ status: 404, url: 'http://localhost:5173/styles.css', method: 'GET' }],
      }),
      rendered({ body: 'Sign in', rootChildren: 1 }),
    );
    expect(out).not.toContain('DID NOT ATTRIBUTE TO A REQUEST');
    expect(out).toContain('/styles.css');
  });

  it('and a section with nothing in it says so rather than being absent', () => {
    // A missing heading reads as a report that was cut short. "(none)" reads as
    // a question that was asked and answered.
    const out = report(collected(), rendered());
    expect(out).toContain('EVERY CONSOLE MESSAGE');
    expect(out).toContain('(none)');
  });
});

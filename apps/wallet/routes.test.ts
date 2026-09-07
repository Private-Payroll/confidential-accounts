import { describe, expect, it } from 'vitest';
import { hrefOf, parseRoute } from './routes.js';

describe('the route table', () => {
  it('treats an empty hash, # and #/ all as home', () => {
    expect(parseRoute('').name).toBe('home');
    expect(parseRoute('#').name).toBe('home');
    expect(parseRoute('#/').name).toBe('home');
  });

  it('knows every screen the shell links to', () => {
    expect(parseRoute('#/send').name).toBe('send');
    expect(parseRoute('#/secure').name).toBe('secure');
    expect(parseRoute('#/recover').name).toBe('recover');
    expect(parseRoute('#/add-device').name).toBe('add-device');
    expect(parseRoute('#/advanced').name).toBe('advanced');
  });

  it('ignores a trailing slash', () => {
    expect(parseRoute('#/secure/').name).toBe('secure');
  });

  /*
   * A typo is a screen that says so, never a silent fall-through to home —
   * somebody following a stale link should learn the link is stale, not be
   * shown a wallet as though nothing happened.
   */
  it('sends anything unknown to not-found, keeping the path for the message', () => {
    const route = parseRoute('#/secrue');
    expect(route.name).toBe('not-found');
    expect(route.path).toBe('/secrue');
  });

  it('round-trips through hrefOf', () => {
    expect(parseRoute(hrefOf('home')).name).toBe('home');
    expect(parseRoute(hrefOf('secure')).name).toBe('secure');
    expect(parseRoute(hrefOf('add-device')).name).toBe('add-device');
  });
});

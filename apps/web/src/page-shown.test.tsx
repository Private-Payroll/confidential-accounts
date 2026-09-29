// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { untilPageShown, untilShown } from './page-shown.test-support.js';

/*
 * A TEST WAITS FOR A PAGE THROUGH THE ONE SHARED HELPER. A page's screen loads
 * when it is first opened and its records are read after, so a test that
 * read it a fixed number of turns later would pass on one machine and fail on
 * another. Its own file, so the page drawn here has not been loaded by any
 * test before it.
 */
vi.mock('./adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('./adapters/company-records.js')>()),
  readCompany: async () => ({ of: 'locked' }),
}));

const { PageView } = await import('./app.js');
const { Shell } = await import('./shell/shell.js');
const { SessionProvider } = await import('./session.js');
const { DEFAULT_PREFERENCES } = await import('./preferences.js');
const { VIEWS } = await import('./pages.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const SRC = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SRC, '../../..');
const EN = JSON.parse(readFileSync(`${SRC}/locales/en.json`, 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const walk = (dir: string): { path: string; text: string }[] => readdirSync(`${ROOT}/${dir}`, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.test\.tsx?$/.test(e.name) ? [{ path: `${dir}/${e.name}`, text: readFileSync(`${ROOT}/${dir}/${e.name}`, 'utf8') }] : []);
const TESTS = walk('apps/web/src');
const HERE = 'apps/web/src/page-shown.test.tsx';

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('a test waits for a page through the one helper', () => {
  /*
   * RED WHEN: a page loaded on demand could be read the moment it is drawn,
   * so a test reading it then would see the page; or the helper hands back
   * before the page is on screen, loaded and read.
   */
  it('finds a page on screen only once it has loaded and been read', async () => {
    const session = {
      person: { id: 'u1', name: 'Priya' }, companies: [{ id: 'c-1', createdAt: '2026-09-01T00:00:00.000Z', signers: 1, approvalsNeeded: 1 }], company: 'c-1',
      chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
      choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
    };
    const { container } = render(<KitProvider languages={LANGUAGES} pick="en"><SessionProvider session={session}><Shell current="payroll"><PageView id="payroll" /></Shell></SessionProvider></KitProvider>);
    expect(container.querySelector('[data-screen]')).toBeNull();
    expect(container.querySelector('[data-loading]')).not.toBeNull();
    const screen = await untilPageShown(container);
    expect(screen.getAttribute('data-screen')).toBe('payroll');
    expect(container.querySelector('[data-loading], [data-reading]')).toBeNull();
  });

  /* RED WHEN: a read of a page that never comes on screen, or never finishes reading, passes, silently or with nothing said about what was waited for. */
  it('fails, naming what it waited for, when it does not come', async () => {
    await expect(untilShown(() => null, 'a thing never drawn', 50)).rejects.toThrow('not on screen after 50 ms: a thing never drawn');
    const view = render(<div data-screen="x" data-reading="" />);
    await expect(untilPageShown(view.container, 50)).rejects.toThrow(/not on screen/);
  });

  /*
   * RED WHEN: a test that opens a page (the application, the frame's page
   * view, the wizard, or any screen) reads it without waiting through the
   * shared helper; or a test file keeps a wait of its own: a helper of its
   * own, a counted loop that waits, or turns waited one after another. The
   * loading placeholder's own test reads the page before it loads, on
   * purpose, and is the one named.
   */
  it('is the only way a test waits for a page', () => {
    const OPENS = /<(PageView|Root|Setup)\b|^import\b[^;]*from '(?:\.\.?\/)+screens\/|\bawait import\('(?:\.\.?\/)+screens\//m;
    const NAMED = ['apps/web/src/records/page-loading.test.tsx', HERE];
    const opening = TESTS.filter((f) => OPENS.test(f.text) && !NAMED.includes(f.path));
    expect(opening.map((f) => f.path).sort()).toEqual([
      'apps/web/src/app.test.tsx', 'apps/web/src/foundation-look.test.tsx', 'apps/web/src/one-menu.test.tsx', 'apps/web/src/records/pages-that-read.test.tsx', 'apps/web/src/setup/wizard.test.tsx',
      'apps/web/src/shell/shell.test.tsx',
    ]);
    for (const f of opening) {
      expect(f.text, f.path).toMatch(/from '(\.\.?\/)+page-shown\.test-support\.js'/);
      expect(f.text, f.path).toMatch(/\buntilPageShown\(/);
    }
    const OWN_WAIT = [
      /\b(const|function|let)\s+until[A-Z]\w*/,
      /for\s*\(\s*let\b[^;]*;[^;]*;[^)]*\)[^\n]*\bawait\b/,
      /\bsettle\b[^\n;]*;\s*(?:await\s+)?(?:act\()?settle\b/,
    ];
    const waits = (text: string) => OWN_WAIT.some((r) => r.test(text));
    for (const probe of [
      'const untilShown = async', 'function untilLoaded(', 'for (let i = 0; i < 50 && x; i += 1) await act(async () => {});',
      'for (let i = 0; i < 5; i += 1) await act(async () => {});', 'await settle(); await settle();', 'await act(settle);\n  await act(settle);',
    ]) expect(waits(probe), probe).toBe(true);
    for (const probe of ['for (let i = 0; i < 3; i += 1) expect(x[i]).toBe(1);', 'await act(settle);\n  expect(a).toBe(1);', 'const until = 3;']) expect(waits(probe), probe).toBe(false);
    expect(TESTS.filter((f) => f.path !== HERE && waits(f.text)).map((f) => f.path)).toEqual([]);
  });
});

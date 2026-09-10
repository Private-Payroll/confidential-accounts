/**
 * **ONE COMMAND STARTS THE PRODUCT, AND EVERY ORIGIN A SCRIPT NAMES IS ONE IT
 * STARTS.**
 *
 * The defect this file exists for: the development script named the wallet's
 * origin and started only the application and its service. The rules are pure,
 * so they are pinned here; the two commands that start the product are pinned by
 * reading their source, because starting either from a test would start servers.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  LAUNCHER_COMMAND, commandOf, leadingAssignments, originsNotStarted, pageStartsFor,
  refuseWhatTheServerSaid,
} from './serve-rules.js';

const ROOT = join(import.meta.dirname, '..');
const SCRIPTS: Record<string, string> = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
const DEV = SCRIPTS.dev;
const devSettings = () => Object.fromEntries(leadingAssignments(DEV).map(a => [a.name, a.value]));
const code = (file: string) => readFileSync(join(ROOT, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('every origin a script names is an origin the development script starts', () => {
  /*
   * RED WHEN: the development script stops running the launcher, a page's
   * origin is edited in one script and not the other, or the wallet agrees to
   * sit inside a page nothing starts.
   */
  it('holds for the scripts as they are', () => {
    expect(originsNotStarted(SCRIPTS)).toEqual([]);
  });

  /*
   * RED WHEN: a script that runs something other than the launcher is taken to
   * start the origins it names. This is the development script as it was: it
   * named the wallet and started only the application and its service.
   */
  it('refuses the development script that named a wallet it never started', () => {
    const before = {
      ...SCRIPTS,
      dev: DEV.replace(LAUNCHER_COMMAND, "sh -c 'tsx src/server/index.ts & vite'"),
    };
    const out = originsNotStarted(before);
    expect(out).toContain('"dev" names WALLET_ORIGIN=http://localhost:5180, and "dev" starts nothing there');
    expect(out).toContain('"dev" names VITE_WALLET_ORIGIN=http://localhost:5180, and "dev" starts nothing there');
  });

  /* RED WHEN: an origin the page opens the wallet at is not compared with where the wallet starts. */
  it('refuses a page that opens the wallet on a port nothing serves', () => {
    const moved = { ...SCRIPTS, dev: DEV.replace('VITE_WALLET_ORIGIN=http://localhost:5180', 'VITE_WALLET_ORIGIN=http://localhost:5181') };
    expect(originsNotStarted(moved).join('\n')).toMatch(/VITE_WALLET_ORIGIN=http:\/\/localhost:5181/);
  });

  /* RED WHEN: the wallet's own script is left out of the check. */
  it('refuses a wallet told to sit inside an application nothing starts', () => {
    const moved = { ...SCRIPTS, wallet: SCRIPTS.wallet.replace('VITE_APP_ORIGIN=http://localhost:5173', 'VITE_APP_ORIGIN=http://localhost:5174') };
    expect(originsNotStarted(moved)).toEqual(
      ['"wallet" names VITE_APP_ORIGIN=http://localhost:5174, and "dev" starts nothing there']);
  });

  /* RED WHEN: a switch named like an origin (`VITE_ALLOW_LOCALHOST_ORIGIN=1`) is read as one. */
  it('reads only web addresses as origins', () => {
    expect(originsNotStarted({ dev: 'VITE_ALLOW_LOCALHOST_ORIGIN=1 tsx x.ts' })).toEqual([]);
  });

  /* RED WHEN: the development script runs anything but the read-only launcher, or it is not there. */
  it('the development script runs the launcher, and the launcher exists', () => {
    expect(commandOf(DEV)).toBe(LAUNCHER_COMMAND);
    expect(existsSync(join(ROOT, LAUNCHER_COMMAND.replace(/^tsx /, '')))).toBe(true);
  });
});

describe('where each page is started', () => {
  /*
   * RED WHEN: a page is started on any port but the one its origin names, is
   * allowed to take another, listens beyond this machine, or the wallet is
   * started by anything but its own script.
   */
  it('starts the application and the wallet on their own origins, pinned, on loopback', () => {
    const plan = pageStartsFor(devSettings());
    if (!('starts' in plan)) throw new Error(plan.refusals.join('; '));
    expect(plan.starts.map(s => [s.setting, s.origin])).toEqual([
      ['APP_ORIGIN', 'http://localhost:5173'],
      ['WALLET_ORIGIN', 'http://localhost:5180'],
    ]);
    expect(plan.starts[0].command).toEqual(
      ['node_modules/.bin/vite', '--host', 'localhost', '--port', '5173', '--strictPort']);
    expect(plan.starts[1].command).toEqual(
      ['npm', 'run', 'wallet', '--', '--host', 'localhost', '--port', '5180', '--strictPort']);
  });

  /*
   * RED WHEN: the wallet can be planned onto the application's origin. Its keys
   * are made for the origin it is served from, so that would bind every wallet
   * to wherever the application is hosted.
   */
  it('refuses to serve the wallet from the application\'s origin', () => {
    const one = { APP_ORIGIN: 'http://localhost:5173', WALLET_ORIGIN: 'http://localhost:5173', VITE_WALLET_ORIGIN: 'http://localhost:5173' };
    const plan = pageStartsFor(one);
    expect('refusals' in plan && plan.refusals.join('\n')).toMatch(/are on one port. The wallet is served on an origin of its own/);
  });

  /* RED WHEN: the two declarations of the wallet's origin are not held to each other. */
  it('refuses a page that would open the wallet somewhere else', () => {
    const plan = pageStartsFor({ ...devSettings(), VITE_WALLET_ORIGIN: 'http://localhost:5181' });
    expect('refusals' in plan && plan.refusals.join('\n')).toMatch(/where nothing is listening/);
  });

  /* RED WHEN: a missing, remote, secure or portless origin is accepted, or only the first is named. */
  it('names every origin it cannot start, at once', () => {
    const plan = pageStartsFor({ APP_ORIGIN: 'https://payroll.example', WALLET_ORIGIN: 'http://localhost' });
    const said = 'refusals' in plan ? plan.refusals.join('\n') : '';
    expect(said).toMatch(/APP_ORIGIN is "https:\/\/payroll.example"; a page started on this machine is served over http/);
    expect(said).toMatch(/WALLET_ORIGIN is "http:\/\/localhost", which names no port/);
    expect(said).toMatch(/VITE_WALLET_ORIGIN is not set/);
    expect(pageStartsFor({ APP_ORIGIN: 'http://payroll.example:80', WALLET_ORIGIN: 'http://localhost:5180', VITE_WALLET_ORIGIN: 'http://localhost:5180' }))
      .toEqual({ refusals: [expect.stringMatching(/listens only on this machine/)] });
  });

  /* RED WHEN: a development subdomain of localhost is refused. */
  it('accepts a subdomain of localhost, still pinned to loopback', () => {
    const plan = pageStartsFor({
      APP_ORIGIN: 'http://app.pp.localhost:5173', WALLET_ORIGIN: 'http://identity.pp.localhost:5180',
      VITE_WALLET_ORIGIN: 'http://identity.pp.localhost:5180',
    });
    expect('starts' in plan && plan.starts[1].command).toContain('localhost');
  });
});

describe('what the server says, held to what the command promised', () => {
  const WRITES = 'Midnight stagenet via https://i.example, reading and writing (a wallet is wired, so this deployment can open companies and raise rounds)';
  const READS = 'Midnight stagenet via https://i.example, read-only (no wallet is wired, so nothing can be written to the chain)';

  /* RED WHEN: the read-only command accepts a server that says it can write, or one that never answered. */
  it('the read-only command refuses a server that can write, and a server that said nothing', () => {
    expect(refuseWhatTheServerSaid('cannot write', WRITES, 8787)).toMatch(/says it can write.*read-only/);
    expect(refuseWhatTheServerSaid('cannot write', '', 8787)).toMatch(/did not answer on port 8787/);
    expect(refuseWhatTheServerSaid('cannot write', READS, 8787)).toBeNull();
    expect(refuseWhatTheServerSaid('cannot write', 'SimulatedLedger (local, no consensus)', 8787)).toBeNull();
  });

  /* RED WHEN: the wallet-holding command accepts a server that cannot write. */
  it('the wallet-holding command refuses a server that cannot write', () => {
    expect(refuseWhatTheServerSaid('can write', READS, 8787)).toMatch(/did not say it can write/);
    expect(refuseWhatTheServerSaid('can write', '', 8787)).toMatch(/nothing, on port 8787/);
    expect(refuseWhatTheServerSaid('can write', WRITES, 8787)).toBeNull();
  });
});

describe('the read-only command cannot come to hold a wallet', () => {
  /** Every file under `scripts/` or `src/` the entry reaches by a static relative import. */
  const reach = (entry: string): string[] => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const m of text.matchAll(/^\s*import\s[^'"]*?from\s+['"](\.[^'"]+)['"]/gm)) {
        const target = relative(ROOT, resolve(dirname(join(ROOT, file)), m[1])).replace(/\.js$/, '.ts');
        if (existsSync(join(ROOT, target))) walk(target);
      }
    };
    walk(entry);
    return [...seen].sort();
  };

  /*
   * RED WHEN: anything the read-only command loads names the one call that
   * hands the server a wallet, the construction of one, a wallet being brought
   * up, or a seed file.
   */
  it('reaches nothing that hands over, builds or brings up a wallet', () => {
    const files = reach('scripts/serve.ts');
    expect(files, 'the walk read nothing, so its absence means nothing').toEqual(
      ['scripts/serve-product.ts', 'scripts/serve-rules.ts', 'scripts/serve.ts']);
    for (const f of files) {
      const text = code(f);
      expect(text, `${f} names a wallet hand-over`).not.toMatch(/handInFundedParties|handed-in-wallets/);
      expect(text, `${f} names a wallet construction`).not.toMatch(/fundedPartiesOver|funded-wallets|WalletFeeSponsor/);
      expect(text, `${f} brings a wallet up`).not.toMatch(/bringUpWallet|wallet-bringup/);
      expect(text, `${f} names a seed`).not.toMatch(/\.seed\b/);
    }
  });

  /* RED WHEN: the read-only command offers the pages before checking the server cannot write. */
  it('checks that the server cannot write before it starts a page', () => {
    const text = code('scripts/serve.ts');
    const check = text.indexOf("refuseWhatTheServerSaid('cannot write'");
    const pages = text.indexOf('startThePages(');
    expect(check).toBeGreaterThan(-1);
    expect(pages).toBeGreaterThan(check);
  });
});

describe('both commands start the product the same way', () => {
  /*
   * RED WHEN: either command starts the server or a page by a route of its own
   * rather than through the shared machinery - which is how the two came to
   * start different products.
   */
  it.each(['scripts/serve.ts', 'scripts/serve-with-wallets.ts'])('%s uses the shared start and nothing else', (file) => {
    const text = code(file);
    expect(text).toMatch(/await startTheServer\(ROOT\)/);
    expect(text).toMatch(/startThePages\(ROOT, plan\.starts, /);
    expect(text).toMatch(/pageStartsFor\(/);
    expect(text, 'it spawns a process of its own').not.toMatch(/\bspawn\(/);
    expect(text, 'it loads the server by a route of its own').not.toMatch(/import\(pathToFileURL/);
  });
});

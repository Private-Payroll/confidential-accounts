/**
 * **NO PATH ON WHICH STARTING THE SERVER ACQUIRES A FUNDED WALLET.**
 *
 * The server asks one module for a funded pair. That module answers with what
 * a launcher handed it, or with `null`; it reads no setting and builds nothing.
 * These cases hold the three things that make that true: nothing the product
 * ships hands a pair in, the server's one capability line asks that module and
 * nothing else, and the module itself cannot conjure one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { handInFundedParties, handedInFundedParties } from './handed-in-wallets.js';
import { deploymentWriteCapability } from './write-capability-for-deployment.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');
const DEFINED_IN = 'src/wiring/handed-in-wallets.ts';

/** Source with comments removed, so prose that names a thing is not a use of it. */
const code = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [p] : [];
  });

describe('§1 - nothing the product ships can hand the server a wallet', () => {
  /*
   * RED WHEN: any non-test module under `src/` - the server included - calls
   * `handInFundedParties`. That module would be a server able to spend because
   * it was started.
   */
  it('the setter is named only where it is defined', () => {
    const naming = walk(SRC)
      .filter(p => /handInFundedParties/.test(code(readFileSync(p, 'utf8'))))
      .map(p => relative(ROOT, p));
    expect(naming).toEqual([DEFINED_IN]);
  });

  /*
   * RED WHEN: the module that holds the pair reads the environment - a pair,
   * or anything that selects one, reachable by configuration.
   */
  it('the module that holds the pair reads no setting and no file', () => {
    const own = code(readFileSync(join(ROOT, DEFINED_IN), 'utf8'));
    expect(own).not.toMatch(/process\.env/);
    expect(own).not.toMatch(/from 'node:fs'|readFileSync|existsSync/);
    expect(own).not.toMatch(/bringUpWallet|seed/i);
  });
});

describe('§2 - the server\'s parties are the handed-in read, and nothing it builds', () => {
  /*
   * RED WHEN: the server's third argument becomes anything but the handed-in
   * read - a constructed pair, a pair looked up by name, or a second call to
   * the supplier somewhere else in the file. The fee payer a deployment's
   * settings name is a client to another process, resolved inside the
   * supplier, and is held by its own cases.
   */
  it('one call to the supplier, and its third argument is the handed-in read', () => {
    const server = code(readFileSync(join(SRC, 'server', 'index.ts'), 'utf8'));
    const calls = server.match(/deploymentWriteCapability\s*\(/g) ?? [];
    expect(calls, 'the server calls the supplier more than once, or not at all').toHaveLength(1);
    expect(server).toMatch(
      /deploymentWriteCapability\(\s*process\.cwd\(\),\s*process\.env,\s*handedInFundedParties\(\)\s*,?\s*\)/);
  });
});

describe('§3 - the module answers what it was handed, once', () => {
  /*
   * RED WHEN: the read answers anything but `null` before a hand-in, or the
   * supplier builds a capability from that answer. Together these are what a
   * server started the ordinary way sees.
   */
  it('nothing handed in is null, and the supplier answers it with no capability', async () => {
    expect(handedInFundedParties()).toBeNull();
    await expect(deploymentWriteCapability('/nowhere', {}, handedInFundedParties()))
      .resolves.toBeUndefined();
  });

  /* RED WHEN: the half-a-pair refusal is removed. */
  it('a pair missing a half is refused and nothing is held', () => {
    expect(() => handInFundedParties({ customer: {} } as never)).toThrow(/without both halves/);
    expect(handedInFundedParties()).toBeNull();
  });

  /*
   * RED WHEN: a second hand-in replaces the first. The server's ledger was
   * built over the first; the process would report one wallet and pay with
   * another.
   */
  it('the first pair is held and a second is refused', () => {
    const first = { customer: { c: 1 }, sponsor: { s: 1 } } as never;
    handInFundedParties(first);
    expect(handedInFundedParties()).toBe(first);
    expect(() => handInFundedParties({ customer: { c: 2 }, sponsor: { s: 2 } } as never))
      .toThrow(/already been handed/);
    expect(handedInFundedParties()).toBe(first);
  });
});

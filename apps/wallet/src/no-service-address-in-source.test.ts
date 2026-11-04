/**
 * **NO SHIPPING SOURCE NAMES THE ADDRESS OF A SERVICE.**
 *
 * The page reaches its own service at the address it was served from, and the wallet reaches the service only
 * through that page, so an address written into the source would tie every company to one service. Every address
 * the shipping source does write is listed here with what it is, none of them a company's service: the chain's
 * indexer and node, an address that reaches nowhere, a name keys are made under, the public hosts proving
 * parameters are fetched from, and a development build's error sink.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SHIPPING = ['apps/wallet/src', 'apps/web/src', 'packages/web-shared/src', 'packages/identity/src', 'src'];
const NOT_SHIPPED = /(\.test\.tsx?|\.test-support\.tsx?|\.fixtures\.ts|\.d\.ts)$|\/testing\//u;

/** Every address the shipping source may write, by file, with what it is. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  /* The chain's node and indexer this wallet reads and sends through. */
  'apps/wallet/src/chain/facade.ts': ['wss://rpc.stagenet.shielded.tools'],
  'apps/wallet/src/config.ts': ['https://indexer.stagenet.shielded.tools/api/v4/graphql', 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws'],
  /* An address under a name that never resolves, so a rehearsal reaches nothing. */
  'apps/wallet/src/chain/rehearsal.ts': ['https://rehearsal.invalid/graphql', 'wss://rehearsal.invalid/graphql/ws'],
  /* A name keys are made under for a wallet made from words; nothing is fetched from it. */
  'src/core/payroll.ts': ['https://payroll.example'],
  /* The public hosts the proving parameters are fetched from. */
  'src/server/proving-parameters.ts': ['https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com', 'https://srs.midnight.network'],
  /* Where a development build's errors go; a build for anyone else carries none. */
  'packages/web-shared/src/error-sink.ts': ['http://localhost:8787'],
};

/** Every address written as a string in `source`, comments left out. */
export const addressesIn = (source: string): string[] => {
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`])\/\/.*$/gmu, '$1');
  return [...code.matchAll(/['"`]((?:https?|wss?):\/\/[^'"`\s]*)/gu)].map((m) => m[1]!.replace(/\$\{.*$/u, ''));
};

const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const at = join(dir, name);
  if (statSync(at).isDirectory()) return name === 'node_modules' ? [] : filesUnder(at);
  return /\.tsx?$/u.test(name) ? [at] : [];
});

describe('NO SHIPPING SOURCE NAMES THE ADDRESS OF A SERVICE', () => {
  it('every address written in shipping source is one listed here, and none is a service', () => {
    const found: Record<string, string[]> = {};
    for (const dir of SHIPPING) {
      for (const file of filesUnder(join(ROOT, dir))) {
        const name = relative(ROOT, file).split('\\').join('/');
        if (NOT_SHIPPED.test(name)) continue;
        const written = addressesIn(readFileSync(file, 'utf8'));
        if (written.length > 0) found[name] = [...new Set(written)].sort();
      }
    }
    /* RED WHEN: shipping source writes an address this list does not name - a service's among them. */
    expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, [...a].sort()])));
  });

  it('an address written anywhere in code is found, and one written in a comment is not', () => {
    /* RED WHEN: the scan misses an address a source writes, so a service's address could pass unseen. */
    expect(addressesIn("const SERVICE = 'https://payroll-service.example:8443/api';")).toEqual(['https://payroll-service.example:8443/api']);
    expect(addressesIn('const at = `https://${host}/api`;')).toEqual(['https://']);
    expect(addressesIn('/* https://not-code.example */ // "https://nor-this.example"')).toEqual([]);
  });
});

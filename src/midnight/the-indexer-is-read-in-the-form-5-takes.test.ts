/**
 * Midnight.js 5.0.0 takes the indexer's public data provider's settings as one options object, and still accepts the
 * positional form, which it marks deprecated and keeps for backward compatibility. Every reader here goes through
 * `publicDataProviderAt` (src/midnight/providers.ts) or writes the options object itself, and nothing casts the
 * answer to fit. Read as text: what is checked is the call, not the network.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');

/** Every .ts file under `dir`, tests and node_modules left out. */
const filesUnder = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((name) => {
  const rel = join(dir, name);
  if (name === 'node_modules') return [];
  if (statSync(join(ROOT, rel)).isDirectory()) return filesUnder(rel);
  return rel.endsWith('.ts') && !rel.endsWith('.test.ts') ? [rel] : [];
});

/** Each call of the provider whose first argument is not the options object. */
const positionalCalls = (text: string): string[] =>
  [...withoutComments(text).matchAll(/indexerPublicDataProvider\(\s*([^{\s)][^)]*)\)/gu)].map((m) => m[0]);

describe('the indexer is read in the form 5.0.0 takes', () => {
  it('no file calls the public data provider with two arguments', () => {
    const found = ['src', 'scripts', 'packages/web-shared/src'].flatMap(filesUnder)
      .flatMap((f) => positionalCalls(readFileSync(join(ROOT, f), 'utf8')).map((c) => `${f}: ${c}`));
    /* RED WHEN a reader goes back to the positional form, which 5.0.0 marks deprecated. */
    expect(found).toEqual([]);
    /* RED WHEN the census cannot see the form it is looking for, so it would pass on anything. */
    expect(positionalCalls('const p = indexerPublicDataProvider(url, ws);')).toHaveLength(1);
    expect(positionalCalls('const p = indexerPublicDataProvider({ queryURL: url, subscriptionURL: ws });')).toEqual([]);
  });

  it('the service reads a vault\'s account through the one builder, with nothing cast', () => {
    const routes = withoutComments(readFileSync(join(ROOT, 'src/server/records-and-chain-routes.ts'), 'utf8'));
    /* RED WHEN the server builds its own provider again, or casts it to fit the vault reader. */
    expect(routes).toContain('vaultAccountFromTheIndexer(await publicDataProviderAt(startup.deployment))');
    expect(routes).not.toContain('indexerPublicDataProvider');
    const providers = withoutComments(readFileSync(join(ROOT, 'src/midnight/providers.ts'), 'utf8'));
    expect(providers).toContain('indexerPublicDataProvider({ queryURL: indexer.indexerUrl, subscriptionURL: indexer.indexerWsUrl })');
    expect(providers).toContain('publicDataProviderAt(b.config)');
    /* RED WHEN the service's chain reads build a provider of their own beside the one builder. */
    const chain = withoutComments(readFileSync(join(ROOT, 'src/server/vault-chain.ts'), 'utf8'));
    expect(chain).toContain('publicDataProviderAt({ indexerUrl: indexer.url, indexerWsUrl: indexer.wsUrl })');
    expect(chain).not.toContain('indexerPublicDataProvider');
  });
});

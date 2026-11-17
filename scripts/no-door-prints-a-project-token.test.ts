import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * A network reached through a project token carries the token in the query of its node and indexer
 * addresses, so a door that prints either address whole prints the token into its window and its report.
 * Every address a door prints goes through `shownAddress`, which drops the query.
 */
const ROOT = join(import.meta.dirname, '..');
const sources = (dir: string): string[] => readdirSync(join(ROOT, dir))
  .filter((f) => /\.(ts|mjs)$/u.test(f) && !/\.test\./u.test(f) && !f.endsWith('.d.ts') && !f.endsWith('.d.mts'))
  .map((f) => join(dir, f));

describe('no door prints an endpoint with its project token', () => {
  it('prints the environment\'s node and indexer only through shownAddress', () => {
    const whole = /\$\{\s*cfg\.(node|nodeWS|indexer|indexerWS)\s*\}/u;
    const offenders = [...sources('scripts'), ...sources('.maintainer')]
      .filter((f) => whole.test(readFileSync(join(ROOT, f), 'utf8')));
    /* RED WHEN a door prints `${cfg.node}` or `${cfg.indexer}` whole (15 Nov: send-test-token printed preprod's token). */
    expect(offenders).toEqual([]);
  });
});

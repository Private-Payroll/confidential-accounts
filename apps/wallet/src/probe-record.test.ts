// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { carriedInOutcomes, syncingAgainst } from './probe-record.js';

/*
 * THE BROWSER PROBE PRINTS ITS INDEXER ONLY AS AN ADDRESS WITHOUT ITS QUERY.
 * On a network whose indexer is reached with a project token, the token travels in the address's
 * query, so a log line that prints the address as configured prints the token with it. The probe's
 * lines go to a page and to a report, so every printed indexer address goes through
 * `syncingAgainst`, which prints `shownAddress`.
 */

const TOKEN = 'project-token-0123456789abcdef';
const WITH_TOKEN = `https://indexer.example/api/v4/graphql?project_id=${TOKEN}`;

const HERE = dirname(fileURLToPath(import.meta.url));
const probeSources = (): { name: string; text: string }[] => readdirSync(HERE)
  .filter((name) => /^probe(-[a-z-]+)?\.ts$/u.test(name))
  .map((name) => ({ name, text: readFileSync(join(HERE, name), 'utf8') }));

describe('a probe line that names the indexer', () => {
  it('never carries the project token in the address\'s query', () => {
    /* RED WHEN: `syncingAgainst` prints the address as configured instead of through `shownAddress`. */
    const line = syncingAgainst(WITH_TOKEN);
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain('project_id');
    expect(line).toBe('syncing against https://indexer.example/api/v4/graphql');
  });

  it('is the only way any probe file prints the indexer\'s address', () => {
    /* RED WHEN: a probe file puts `INDEXER_HTTP_URL` into a step or a log line itself, as in
     * `syncing against ${INDEXER_HTTP_URL}`, rather than through `syncingAgainst`. */
    const uses = probeSources().flatMap(({ name, text }) => text.split('\n')
      .filter((line) => /INDEXER_(HTTP|WS)_URL/u.test(line) && !/^import /u.test(line))
      .map((line) => ({ name, line: line.trim() })));
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const use of uses) expect(use.line, use.name).toMatch(/syncingAgainst\(INDEXER_HTTP_URL\)/u);
  });
});

describe('a payment an earlier run left unresolved', () => {
  const carried = [{ key: 'a-payment' }, { key: 'b-payment' }];

  it('is reported as not asked when resolving failed, never as the chain\'s silence', () => {
    /* RED WHEN: a failed attempt to resolve is reported as "still unresolved", which claims the chain was asked. */
    const outcomes = carriedInOutcomes(carried, [], 'the pending store could not be read');
    expect(outcomes.map((o) => o.outcome)).toEqual([
      'NOT ASKED — resolving it failed: the pending store could not be read',
      'NOT ASKED — resolving it failed: the pending store could not be read',
    ]);
  });

  it('carries the chain\'s outcome when it settled, and says the chain has not answered otherwise', () => {
    /* RED WHEN: a settled payment loses its outcome, or one the chain has not answered is reported as settled. */
    const outcomes = carriedInOutcomes(carried, [{ key: 'a-payment', outcome: { name: 'CONFIRMED' } }], null);
    expect(outcomes).toEqual([
      { key: 'a-payment', outcome: 'CONFIRMED' },
      { key: 'b-payment', outcome: 'STILL unresolved — the chain has not answered, and silence decides nothing' },
    ]);
  });
});

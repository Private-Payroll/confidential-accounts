import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * **NO ROUTE READS A VIEWING KEY FROM AN ADDRESS.**
 *
 * An address is written into logs, proxies, browser history and the refusal
 * report; a key in one is a key handed to all of them. The people read and the
 * state read took the company's viewing key in their address. The first now
 * answers with records the page opens itself; the second is gone.
 *
 * So this reads every route file of the service and lists every place a route
 * reads its address: the query string, the raw url, a parsed search. Each is
 * named below with what it reads. A new one turns this red until it is named,
 * and none may read `viewingKey`.
 */
const SERVER = 'src/server';
const routeFiles = readdirSync(SERVER)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('test-support'))
  .sort();

/** Every reading of a request's address in `text`, as `file: what it reads`. */
const addressReads = (file: string, text: string): string[] => {
  const found: string[] = [];
  const reads = /\b(?:req|request)\s*\.\s*(?:query\s*(?:\.\s*(\w+)|\[\s*['"`](\w+)['"`]\s*\])?|url\b|originalUrl\b)|\bsearchParams\b|\bURLSearchParams\b|\bquery\s*\[/gu;
  for (const m of text.matchAll(reads)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 60), m.index);
    const what = m[1] ?? m[2] ?? m[0].replace(/\s+/gu, '');
    /* The refusal report is handed the address to redact and write down; it is not a route reading it. */
    const reported = /(?:appendRefusal|recordRefusal)\(\s*req\.method,\s*$/u.test(before);
    found.push(`${file}: ${reported ? 'reported ' : ''}${what}`);
  }
  return found;
};

describe('no route reads a viewing key from an address', () => {
  const reads = routeFiles.flatMap((f) => addressReads(f, readFileSync(join(SERVER, f), 'utf8')));

  /* RED WHEN: any route reads `viewingKey` from its query string, under any spelling this sees - the people or state read put back, or a new one. */
  it('reads no viewingKey from any query string', () => {
    expect(reads.filter((r) => /viewingKey/iu.test(r))).toEqual([]);
  });

  /* RED WHEN: a route reads its address anywhere not named here - a whole `req.query`, the raw url, a parsed search - which this cannot see the names in. */
  it('reads its address only where named, and only for what is named', () => {
    expect(reads).toEqual([
      'index.ts: reported req.originalUrl',
      'index.ts: reported req.originalUrl',
      'index.ts: reported req.originalUrl',
      /* `GET /api/payslips/addresses?company=co_…`: a public label. */
      'index.ts: company',
      'invitations-route.ts: reported req.originalUrl',
      /* A relay of a proven call refused or failed, written down as every other is. */
      'proposal-relays.ts: reported req.originalUrl',
      /* The refusal report saying, in its own words, that it writes the address down redacted. */
      'refusal-log.ts: req.originalUrl',
    ]);
  });

  /* RED WHEN: the census reads no file, or misses a read it was written to see, so it would pass on anything. */
  it('sees the reads it is written to see', () => {
    expect(routeFiles).toContain('index.ts');
    expect(routeFiles).toContain('people-route.ts');
    expect(addressReads('x.ts', "const k = String(req.query.viewingKey ?? '');")).toEqual(['x.ts: viewingKey']);
    expect(addressReads('x.ts', "const k = req.query['viewingKey'];")).toEqual(['x.ts: viewingKey']);
    expect(addressReads('x.ts', 'const { viewingKey } = req.query;')).toEqual(['x.ts: req.query']);
    expect(addressReads('x.ts', 'new URL(req.url, base).searchParams')).toEqual(['x.ts: req.url', 'x.ts: searchParams']);
  });
});

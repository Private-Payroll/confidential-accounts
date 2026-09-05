/**
 * **ONE REFUSAL, THE SAME REASON IN BOTH ARTEFACTS.** `C157`, `X10` §1.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM THE OTHER TWO ───────────────────
 *
 * `refusal-log.test.ts` proves the service writes its reason down.
 * `error-sink.test.ts` proves the page keeps a body beside a status. **Both can
 * pass while the two artefacts say different things about the same event**, and
 * a walk is read by putting them side by side — which was the whole complaint:
 * *two entirely different failures were indistinguishable in every artefact
 * this project keeps.* So this drives ONE real refusal through BOTH, from a
 * real HTTP request, and requires the same sentence to come out of each.
 *
 * ── THE SINK IS THE REAL ONE, WRAPPING THE REAL `fetch` ──────────────────
 *
 * `installErrorSink` is given a window whose `fetch` is node's, pointed at a
 * service that is actually listening. Nothing is stubbed between the refusal
 * and the two places it lands. `post` is injected so the test reads exactly
 * what would have crossed the wire, which is the shape `error-sink.test.ts`
 * already uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { installErrorSink, type SinkPost, type SinkWindow } from '../web/error-sink.js';

const DIR = mkdtempSync(join(tmpdir(), 'mn-both-'));
const REPORT = join(DIR, 'REPORT-REFUSALS.txt');

process.env.REFUSAL_LOG = REPORT;
process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(DIR, 'db.json');

const { app } = await import('./index.js');

let server: Server;
let base: string;

beforeAll(async () => {
  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

/** A window with node's real `fetch` in it, and nothing else pretended. */
const aBrowser = () => {
  const posted: SinkPost[] = [];
  const w: SinkWindow = {
    addEventListener: () => {},
    fetch: (...args: any[]) => (globalThis.fetch as any)(...args),
    console: { error: () => {}, warn: () => {} },
    location: { href: 'http://localhost:5173/' },
    // Synchronous: the debounce is not what is under test.
    setTimeout: (fn: () => void) => { fn(); return 0 as any; },
  };
  installErrorSink(w, (body) => { posted.push(body); });
  return { w, posted };
};

/* A macrotask boundary so the clone's already-resolved body read lands. Not a
 * poll: there is no condition being watched for. */
const settled = () => new Promise(resolve => { setTimeout(resolve, 0); });

describe('a refusal, read the way a walk reads one', () => {
  it('THE ONE C157 ASKS FOR: the log and the sink give the same reason for one 400',
    async () => {
      const { w, posted } = aBrowser();

      const response = await w.fetch(`${base}/api/invites/nothing-here/offer`);
      expect(response.status).toBe(400);
      await settled();

      /* 1. WHAT THE PERSON WAS GIVEN. */
      const shown = (await response.json()).error as string;
      expect(shown).toBe('invite not found');

      /* 2. WHAT THE SINK KEPT — the status, the path AND the reason. Before
       *    this round it was the first two, and nothing else. */
      const kept = posted[0].entries[0].message;
      expect(kept).toContain('400 ');
      expect(kept).toContain('/api/invites/nothing-here/offer');
      expect(kept).toContain(`— ${shown}`);

      /* 3. AND WHAT THE SERVICE WROTE DOWN. */
      const written = readFileSync(REPORT, 'utf8');
      expect(written).toContain('/api/invites/nothing-here/offer');
      expect(written).toContain(`Error: ${shown}`);

      /*
       * **THE ASSERTION THE ROW IS ACTUALLY ABOUT.** Not that each artefact has
       * something in it, but that a person holding both is holding one event.
       * Two `400 GET …/state` from different causes now differ HERE.
       */
      expect(kept.endsWith(shown), `sink kept: ${kept}`).toBe(true);
      expect(written).toContain(shown);
    });

  it('THE TWO ARTEFACTS ARE NOT ONE STRING: the browser keeps the secret, the disk does not — `T-326`, `S58`',
    async () => {
      /*
       * **`refusal-log.ts`'s HEADER CLAIMED THESE WERE ONE STRING AND THEY ARE
       * TWO.** `T-326`. It said *the same redactor answers the browser in
       * `wrap`, so the person's sentence and the line on disk are one string
       * rather than two that can drift*. `wrap` calls no redactor at all: it
       * forks one value, sending it raw to the browser and redacted to
       * `appendRefusal`.
       *
       * **AND THAT DIVERGENCE IS CORRECT, WHICH IS WHY THIS PINS IT RATHER THAN
       * REMOVING IT.** `src/server/index.ts`'s own note says redaction belongs
       * at each boundary — the page redacts on the way to the wire, this file
       * redacts on the way to disk — and a third redaction inside `wrap` would
       * mask both, so a mutation removing either would survive and look like it
       * had proved the opposite. **The two existing cases above could not see
       * any of this**, because `'invite not found'` and its path contain
       * nothing `redactSecrets` touches, so both forks agreed by construction.
       *
       * The path here is 64 hex characters, which is what the redactor's
       * `[0-9a-fA-F]{32,}` rule is for.
       */
      const { w, posted } = aBrowser();
      const secret = 'ab'.repeat(32);

      const response = await w.fetch(`${base}/api/invites/${secret}/offer`);
      expect(response.status).toBe(400);
      await settled();

      const shown = (await response.json()).error as string;
      const written = readFileSync(REPORT, 'utf8');

      /*
       * **THEY ARE TWO STRINGS AND HERE IS THE PROOF, IN BOTH DIRECTIONS.** The
       * browser is handed the reason ALONE — `wrap` sends `{ error: reason }`
       * and nothing else — so the person's string carries no path, redacted or
       * otherwise. The disk line carries the path, and carries it redacted.
       * Neither is a substring of the other.
       */
      expect(shown).toBe('invite not found');
      expect(shown).not.toContain(secret);
      expect(shown).not.toContain('<redacted:hex>');
      expect(shown).not.toContain('/api/invites');

      /* And the disk's own boundary did its own redaction, on its own copy. */
      expect(written).toContain('<redacted:hex>');
      expect(written).not.toContain(secret);

      /*
       * **STILL ONE EVENT, WHICH THE CORRECTED SENTENCE MUST NOT BE READ AS
       * DENYING.** `C157` asks that a person holding both artefacts is holding
       * one refusal, and that is unchanged: the reason is common to all three
       * copies. What is NOT true, and what the header claimed until `S58`, is
       * that one redactor produced them.
       */
      const kept = posted[0].entries[0].message;
      expect(kept).toContain(`— ${shown}`);
      expect(written).toContain(`Error: ${shown}`);
      /* The page redacted its own copy, independently — `src/web/error-sink.ts`.
       * That is the third boundary, and it is why the sink shows the same
       * placeholder as the disk while having never read the disk's copy. */
      expect(kept).not.toContain(secret);
    });

  it('and two different refusals are two different lines, which is the whole point',
    async () => {
      const { w, posted } = aBrowser();
      await w.fetch(`${base}/api/invites/one-bad-token/offer`);
      await w.fetch(`${base}/api/accounts/a1/state?viewingKey=nope`);
      await settled();

      const [first, second] = posted.map(p => p.entries[0].message);
      // Both were 400s on this walk. Before this round these two lines differed
      // only in their path; a policy refusal and a key failure on the SAME path
      // did not differ at all.
      expect(first).not.toBe(second);
      expect(first).toContain('invite not found');
      /*
       * **AND THE SECOND NEVER REACHES `wrap` AT ALL**, which is worth pinning
       * rather than discovering. `authed` answers `401` itself, above the
       * wrapper, exactly as `member` answers `404` — deliberately the same
       * answer for missing and not-yours, so the route cannot be used to
       * enumerate account ids.
       *
       * So the sink now carries a reason for these too, because it reads the
       * BODY and does not care which handler wrote it — while the service's
       * refusal report holds `wrap`'s 400s only. **That asymmetry is real and
       * is named here** so nobody reads a missing line in `REPORT-REFUSALS.txt`
       * as a refusal that went unrecorded.
       */
      expect(second).toContain('401');
      expect(second).toContain('not signed in');
      expect(readFileSync(REPORT, 'utf8')).not.toContain('a1/state');
    });
});

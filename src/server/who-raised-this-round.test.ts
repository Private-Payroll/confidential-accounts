/**
 * **WHO RAISED THIS ROUND COMES FROM THE SIGNED-IN CALLER, NEVER FROM THE
 * REQUEST.** The same rule the payroll skip register already holds, on the
 * three routes that were left with the older shape.
 *
 * ── WHY THIS IS WORSE THAN A WRONG NAME ON A RECORD ──────────────────────
 *
 * A round is judged against the ceiling of the ROLE that raised it -
 * `AccountService.recordStanding` reads the proposer's role and hands it to the
 * policy. So a caller free to name any seat is not merely filing under a
 * colleague's name: **they are choosing which ceiling applies.** A viewer
 * naming an admin's seat raises a round the policy would otherwise have
 * refused, and every screen afterwards says an admin raised it.
 *
 * ── WHAT IS BEING PROVED IS AN ABSENCE, SO THE BODY MATTERS MORE THAN THE
 *    ASSERTION ──────────────────────────────────────────────────────────
 *
 * Each attempt below sends a complete, well-formed, plausible seat id belonging
 * to a real signer on the caller's own account - the shape the attack actually
 * arrives in - and the answer is the caller's own seat, or the same answer the
 * request would have got with no seat named at all. **A field that is merely
 * unused comes back**, so the schemas do not accept it either.
 *
 * ── THE THIRD ROUTE HAS NO SIGNED-IN CALLER, AND ITS ANSWER IS DIFFERENT ─
 *
 * `POST /api/plugin/propose` is called by a plug-in holding a capability token.
 * There is no session to take a seat from. What a plug-in has instead is an
 * installation - a seat granted it an allowance, and every ceiling it spends
 * against is that installation's - so its round is raised under the seat that
 * installed it. That is the authority it is actually acting on, and it is the
 * one route where copying the other two would have had nothing to copy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { identityFromWords } from 'midnight-identity';
import { addressOfVerifyingKey, mint } from 'midnight-identity/profile/disclosure';

process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-who-raised-')), 'db.json');

const ORIGIN = 'https://payroll.example';

/**
 * **DRIVEN OVER A TEST DOUBLE, AND SAID HERE SO NOBODY READS THESE CASES AS
 * EVIDENCE ABOUT A CHAIN.** Raising a round is a write, and this product's
 * deployment holds no wallet. What is under test is which seat the ROUTE hands
 * down, which is decided before any ledger is reached.
 */
const { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } = await import('../core/ledger.js');
const { handInWiring } = await import('../wiring/handed-in.js');
handInWiring({
  name: 'simulated',
  commitments: SimulatedCommitments,
  createLedger: () => new SimulatedLedger(SimulatedCommitments),
  createProofSystem: () => new SimulatedProofSystem(),
});

const { app } = await import('./index.js');
const { networkOfThePair } = await import('../midnight/network.js');
const NETWORK = networkOfThePair(process.env.MIDNIGHT_NETWORK_ID);

const identity = identityFromWords(TEST_MNEMONIC);
const addressOf = (slot: number): string => addressOfVerifyingKey(
  signatureVerifyingKey({
    tag: 'schnorr',
    value: Buffer.from(identity.moneyAt(slot).night).toString('hex'),
  }).value, NETWORK);

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

type Res = { status: number; body: any };

const call = async (
  method: string, path: string, opts: { token?: string; body?: unknown } = {},
): Promise<Res> => {
  const r = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const signedIn = async (slot: number): Promise<string> => {
  const asked = await call('POST', '/api/auth/wallet/challenge');
  expect(asked.status, JSON.stringify(asked.body)).toBe(200);
  const response = mint(identity, slot, {
    origin: ORIGIN,
    nonce: asked.body.nonce,
    address: addressOf(slot),
    at: Date.now(),
    disclosed: [],
    declined: [],
    requesterSaidItWas: { name: 'Payroll', rdns: 'example.payroll' },
  }).response;
  const inHere = await call('POST', '/api/auth/wallet', {
    body: { handle: asked.body.handle, nonce: asked.body.nonce, response },
  });
  expect(inHere.status, JSON.stringify(inHere.body)).toBe(200);
  return inHere.body.session.token as string;
};

/**
 * A company whose creator holds the ADMIN seat and whose second seat - a
 * VIEWER, the lowest role there is - belongs to nobody.
 *
 * **THE ROLES ARE CHOSEN AND NOT INCIDENTAL.** The seat the attempts below name
 * is the one whose ceiling differs most from the caller's, so a route that
 * believed the request would be judging the round against the wrong bar as well
 * as recording the wrong name.
 */
const aCompany = async (token: string) => {
  const made = await call('POST', '/api/accounts', {
    token,
    body: {
      name: 'Northwind',
      signers: [
        { name: 'Ada', role: 'admin' },
        { name: 'Bo', role: 'viewer' },
      ],
      threshold: 1,
    },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const signers = made.body.account.signers as { id: string; name: string; role: string }[];
  const mine = signers.find(s => s.name === 'Ada')!;
  const notMine = signers.find(s => s.name === 'Bo')!;
  expect(mine.id).not.toBe(notMine.id);
  return {
    accountId: made.body.account.id as string,
    viewingKey: made.body.viewingKey as string,
    mine, notMine,
  };
};

describe('a caller cannot choose which seat raises a round, or which ceiling judges it', () => {
  /*
   * **THE PLUG-IN ROUTE, END TO END, AND IT IS THE ONE THAT PROVES THE SEAT
   * RATHER THAN MERELY PROVING THE FIELD IS INERT.**
   *
   * RED WHEN: `PluginService.propose` takes the seat from its arguments again,
   * or the route puts `proposedBy` back in its schema. Watched red both ways.
   *
   * The body carries a real seat on the caller's own account - the viewer's -
   * so a route that believed it would produce a round attributed to a viewer
   * and judged against a viewer's ceiling.
   */
  it('a plug-in\'s round is raised under the seat that installed it, not the one it names',
    async () => {
      const token = await signedIn(11);
      const { accountId, viewingKey, mine, notMine } = await aCompany(token);

      const installed = await call('POST', `/api/accounts/${accountId}/plugins`, {
        token,
        body: {
          pluginId: 'treasury-yield',
          scopes: ['state:read', 'proposal:create'],
          allowance: { periodDays: 30, limits: { GBP: { perProposal: '5000', perPeriod: '8000' } } },
          viewingKey,
          /* Named, and it must not be believed - see the case below. */
          installedBy: notMine.id,
        },
      });
      expect(installed.status, JSON.stringify(installed.body)).toBe(200);

      const raised = await call('POST', '/api/plugin/propose', {
        body: {
          token: installed.body.token,
          viewingKey,
          summary: 'Deploy to lending',
          asset: 'GBP',
          amount: '10',
          recipient: 'Pool',
          /* The attack, in the shape it would actually arrive in. */
          proposedBy: notMine.id,
        },
      });
      expect(raised.status, JSON.stringify(raised.body)).toBe(200);
      expect(raised.body.proposedBy).toBe(mine.id);
      expect(raised.body.proposedBy).not.toBe(notMine.id);
    });

  /*
   * **AND THE SEAT IT IS RAISED UNDER IS ITSELF NOT NAMEABLE**, which is the
   * half that would otherwise move the hole one step earlier rather than close
   * it.
   *
   * RED WHEN: `installedBy` goes back into the install schema and is believed.
   */
  it('the seat that installed a plug-in comes from the signed-in caller too', async () => {
    const token = await signedIn(12);
    const { accountId, viewingKey, mine, notMine } = await aCompany(token);

    const installed = await call('POST', `/api/accounts/${accountId}/plugins`, {
      token,
      body: {
        pluginId: 'treasury-yield',
        scopes: ['state:read'],
        allowance: null,
        viewingKey,
        installedBy: notMine.id,
      },
    });
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);

    const list = await call('GET', `/api/accounts/${accountId}/plugins`, { token });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].installedBy).toBe(mine.id);
    expect(list.body[0].installedBy).not.toBe(notMine.id);
  });

  /*
   * **THE TWO SIGNED-IN ROUTES: THE FIELD HAS NO EFFECT AT ALL.**
   *
   * These two rounds cannot be driven to a proposal here - one needs a vault
   * with state on chain, the other a payroll run with material - so what is
   * pinned is the stronger-than-it-looks property that the request answers
   * IDENTICALLY whether a seat is named or not.
   *
   * **AND THAT IS NOT A WEAK ASSERTION, BECAUSE OF WHAT IT CATCHES.** Put
   * `proposedBy: z.string()` back in either schema and the two requests stop
   * agreeing at once: the one that names a seat proceeds to whatever refusal
   * lies beyond, and the one that names none is refused by the schema, with a
   * different status and a different body. The case dies on the first
   * comparison.
   *
   * RED WHEN: either schema accepts the field again, or the handler reads it.
   */
  it('the vault-threshold round is raised by the caller\'s own seat, whoever is named', async () => {
    const token = await signedIn(13);
    const { accountId, viewingKey, mine, notMine } = await aCompany(token);
    const vault = 'a'.repeat(64);

    const naming = await call('POST', `/api/accounts/${accountId}/vault-threshold/propose`, {
      token, body: { viewingKey, vault, newThreshold: 1, proposedBy: notMine.id },
    });
    expect(naming.status, JSON.stringify(naming.body)).toBe(200);
    expect(naming.body.proposedBy).toBe(mine.id);
    expect(naming.body.proposedBy).not.toBe(notMine.id);

    /*
     * **AND THE ROLE THE ROUND WILL BE JUDGED BY MOVED WITH IT**, which is the
     * half that is about money rather than about a name. The seat named in the
     * body is a viewer; the caller's is an admin.
     */
    expect(naming.body.proposerRole).toBe('admin');
    expect(naming.body.proposerRole).not.toBe('viewer');

    /*
     * And the field is gone from the door rather than ignored at it: a body
     * with no seat in it is answered exactly the same way. **A field that is
     * merely unused comes back.**
     */
    const silent = await call('POST', `/api/accounts/${accountId}/vault-threshold/propose`, {
      token, body: { viewingKey, vault: 'c'.repeat(64), newThreshold: 1 },
    });
    expect(silent.status, JSON.stringify(silent.body)).toBe(200);
    expect(silent.body.proposedBy).toBe(mine.id);
  });

  it('naming a seat on a payroll round changes nothing about the answer', async () => {
    const token = await signedIn(14);
    const { accountId, viewingKey, notMine } = await aCompany(token);

    const made = await call('POST', `/api/accounts/${accountId}/payroll`, {
      token,
      body: {
        period: '2026-07', viewingKey,
        employees: [{ name: 'Nina', asset: 'GBP', amount: '1000' }],
      },
    });
    /* If a run cannot be created here the case has nothing to drive, and a
     * silently skipped case is worse than an absent one. */
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    /*
     * **THE RUN IS INSIDE THE ANSWER, NOT THE ANSWER.** The first version of
     * this case read `made.body.id`, which is undefined - so both requests
     * below were refused by the ownership gate before either reached the route,
     * and the case compared two identical 404s. It passed, and it could not
     * fail. The round's own mutation of the schema is what found it.
     */
    const runId = made.body.run.id;
    expect(runId, JSON.stringify(made.body).slice(0, 200)).toMatch(/^run_/);

    const window = { vault: 'b'.repeat(64), opensAt: '1000', closesAt: '2000' };
    const silent = await call('POST', `/api/runs/${runId}/propose`, {
      token, body: { viewingKey, ...window },
    });
    const naming = await call('POST', `/api/runs/${runId}/propose`, {
      token, body: { viewingKey, ...window, proposedBy: notMine.id },
    });

    /* Neither may be refused for want of an owner: that would mean this case
     * never reached the route at all, which is exactly how it first passed. */
    expect(silent.status, JSON.stringify(silent.body)).not.toBe(404);
    expect(naming.status, JSON.stringify(naming.body)).toBe(silent.status);
    expect(naming.body).toEqual(silent.body);
    expect(JSON.stringify(naming.body ?? null)).not.toContain(notMine.id);

    /*
     * **AND THE ANSWER IS NOT ABOUT THE FIELD**, which is what stops this case
     * being vacuous. Both requests are refused - this run's payee is not on the
     * roster, so it is refused before the seat is ever used - but neither
     * refusal may be the schema asking for a seat.
     */
    expect(JSON.stringify(silent.body ?? null)).not.toContain('proposedBy');
    expect(JSON.stringify(naming.body ?? null)).not.toContain('proposedBy');
  });
});

/**
 * **WHAT THE CASE ABOVE CANNOT SEE, AND WHY THIS WALK IS HERE RATHER THAN A
 * BETTER ASSERTION.**
 *
 * The payroll round is refused before the seat is reached, so no answer it can
 * produce carries one. That makes it blind to the regression in the shape the
 * regression would actually take: **`proposedBy: z.string().optional()` put
 * back, and the handler preferring it.** Measured - that mutation left every
 * behavioural case in this file green, and the caller had full control of the
 * seat and therefore of the ceiling again. Every other attribution field on
 * these two files is written `.optional()`, so that is not a contrived shape;
 * it is the ordinary one.
 *
 * **SO THE ABSENCE IS PINNED AS AN ABSENCE.** A field a caller can put a seat
 * in must not exist on either build, and that is a property of the source
 * rather than of any one request. It is a weaker kind of evidence than a
 * behavioural case and it is the kind available here, which is said plainly
 * rather than dressed up: a walk cannot tell you the right seat was used, only
 * that no wrong one can arrive.
 *
 * **BOTH BUILDS, BECAUSE THEY ARE TWO IMPLEMENTATIONS OF ONE API** and this is
 * exactly the sort of field on which they drift.
 */
describe('no door on either build has anywhere to put somebody else\'s seat', () => {
  const SURFACES = ['src/server/index.ts', 'src/standalone/main.tsx'];
  /* Who is acting. Every one of these selects a ceiling, not just a name. */
  const CLAIMS = ['proposedBy', 'installedBy'];

  /** Comments only describe; what runs is what is left when they are gone. */
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  for (const surface of SURFACES) {
    for (const claim of CLAIMS) {
      /*
       * RED WHEN: the field reappears in a schema or is read off a body, in
       * any form - required, optional, defaulted, or spread in with the rest
       * of the request.
       */
      it(`${surface} gives a caller nowhere to put ${claim}`, async () => {
        const { readFileSync } = await import('node:fs');
        const text = code(readFileSync(surface, 'utf8'));
        /*
         * The two shapes it can arrive in, and the identifier by itself is
         * neither of them - the value still has to be PASSED to a service under
         * that name, which is where it legitimately appears.
         */
        const declared = new RegExp(`${claim}\\s*:\\s*z\\.`);
        const readOff = new RegExp(`\\b(?:b|body|args|req\\.body)\\.${claim}\\b`);
        const hits = text.split('\n')
          .map((line, i) => [i + 1, line] as const)
          .filter(([, line]) => declared.test(line) || readOff.test(line));
        expect(hits.map(([n, line]) => `${surface}:${n} ${line.trim()}`)).toEqual([]);
      });
    }
  }

  /*
   * **AND THE SHAPE THAT NAMES NOTHING: A WHOLE REQUEST BODY HANDED TO A
   * SERVICE.**
   *
   * The four cases above look for a field. A spread carries every field the
   * caller sent and mentions none of them, so it is invisible to them - and it
   * is what one of these routes actually did: the plug-in propose door passed
   * the request body whole, so the seat rode in without appearing anywhere in
   * the file.
   *
   * RED WHEN: either build goes back to spreading a request into a call.
   */
  it('neither build hands a whole request body to a service', async () => {
    const { readFileSync } = await import('node:fs');
    for (const surface of SURFACES) {
      const text = code(readFileSync(surface, 'utf8'));
      const hits = text.split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => /\.\.\.\s*(?:body|req\.body)\b/.test(line));
      expect(hits.map(([n, line]) => `${surface}:${n} ${line.trim()}`)).toEqual([]);
    }
  });

  /*
   * **THE POSITIVE CONTROL, AND WITHOUT IT THE FIVE ABOVE ALSO PASS IF THE
   * STRIPPER EATS THE WHOLE FILE** - which is how a walk quietly stops walking.
   */
  it('the walk is looking at code that is still there', async () => {
    const { readFileSync } = await import('node:fs');
    for (const surface of SURFACES) {
      const text = code(readFileSync(surface, 'utf8'));
      expect(text, surface).toContain('seatOf');
      expect(text.length, surface).toBeGreaterThan(10_000);
    }
  });
});

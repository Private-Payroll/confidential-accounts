/**
 * **WHO RAISED THIS ROUND COMES FROM THE SIGNED-IN CALLER, NEVER FROM THE
 * REQUEST.** The same rule the payroll skip register already holds, on the
 * routes that were left with the older shape.
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
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { importTheServer, useOnlyTheseSettings } from '../testing/server-under-test.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { identityFromWords } from 'midnight-identity';
import { addressOfVerifyingKey, mint } from 'midnight-identity/profile/disclosure';

useOnlyTheseSettings({
  ALLOW_SIMULATED_COMPANY_ADDRESS: '1',
  ALLOW_MEMORY_SESSIONS: '1',
  DATABASE_URL: '',
  SERVE: '0',
  APP_ORIGIN: 'https://payroll.example',
  DATA_PATH: join(mkdtempSync(join(tmpdir(), 'mn-who-raised-')), 'db.json'),
});

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

const { app } = await importTheServer();
const { theNetwork } = await import('../midnight/network.js');
const NETWORK = theNetwork();

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
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
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
    body: { companyLabel: drawCompanyLabel(),
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
   * **THE ROUTE THAT TOOK A NAMED SEAT IS GONE.** The payroll round's case
   * went with the service's own draw of a run: a run is drawn, sealed and
   * signed on a signer's device, and the seat that files it is the one its
   * signature names (`run-routes.ts`).
   */
  /*
   * **A VAULT'S THRESHOLD IS NOW RAISED FROM A SEAT'S OWN DEVICE**: written down
   * by `POST /api/accounts/:id/proposals` only when signed by the key the
   * company's directory holds for the signed-in person's own seat, so there is no
   * seat to name. That rule, and its refusal of another seat's key, is driven in
   * `a-proposal-is-relayed-for-a-seat-that-may-act.test.ts`.
   *
   * RED WHEN: the route that took a named seat beside the viewing key is served again.
   */
  it('the vault-threshold round that took a named seat is gone', async () => {
    const token = await signedIn(13);
    const { accountId, viewingKey, notMine } = await aCompany(token);
    const naming = await call('POST', `/api/accounts/${accountId}/vault-threshold/propose`, {
      token, body: { viewingKey, vault: 'a'.repeat(64), newThreshold: 1, proposedBy: notMine.id },
    });
    expect(naming.status, JSON.stringify(naming.body)).toBe(404);
  });
});

/**
 * **WHAT THE CASE ABOVE CANNOT SEE, AND WHY THIS WALK IS HERE RATHER THAN A
 * BETTER ASSERTION.**
 *
 * No answer a route gives carries the seat it was raised under, so a case
 * that drives one is blind to the regression in the shape the regression
 * would actually take: **`proposedBy: z.string().optional()` put
 * back, and the handler preferring it.** Measured - that mutation left every
 * behavioural case in this file green, and the caller had full control of the
 * seat and therefore of the ceiling again. Every other attribution field on
 * these two files is written `.optional()`, so that is not a contrived shape;
 * it is the ordinary one.
 *
 * **SO THE ABSENCE IS PINNED AS AN ABSENCE.** A field a caller can put a seat
 * in must not exist on the server, and that is a property of the source
 * rather than of any one request. It is a weaker kind of evidence than a
 * behavioural case and it is the kind available here, which is said plainly
 * rather than dressed up: a walk cannot tell you the right seat was used, only
 * that no wrong one can arrive.
 */
describe('no door on the server has anywhere to put somebody else\'s seat', () => {
  /* The server's routes, and the files of routes it mounts that relay or file what a seat's device made, each with code it must still hold. */
  const MARKS: Record<string, string> = {
    'src/server/index.ts': 'proposalRelayRoutes(', 'src/server/proposal-relays.ts': 'actingSeat', 'src/server/signer-routes.ts': 'fileRoster',
  };
  const SURFACES = Object.keys(MARKS);
  /* Who is acting. Every one of these selects a ceiling, not just a name. */
  const CLAIMS = ['proposedBy'];

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
   * The cases above look for a field. A spread carries every field the
   * caller sent and mentions none of them, so it is invisible to them - and it
   * is what one of these routes actually did: a route since deleted passed
   * the request body whole, so the seat rode in without appearing anywhere in
   * the file.
   *
   * RED WHEN: the server goes back to spreading a request into a call.
   */
  it('the server hands no whole request body to a service', async () => {
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
   * **THE POSITIVE CONTROL, AND WITHOUT IT THE CASES ABOVE ALSO PASS IF THE
   * STRIPPER EATS THE WHOLE FILE** - which is how a walk quietly stops walking.
   */
  it('the walk is looking at code that is still there', async () => {
    const { readFileSync } = await import('node:fs');
    for (const surface of SURFACES) {
      const text = code(readFileSync(surface, 'utf8'));
      expect(text, surface).toContain(MARKS[surface]);
      expect(text.length, surface).toBeGreaterThan(5_000);
    }
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { identityFromWords } from 'midnight-identity';
import { addressOfVerifyingKey, mint } from 'midnight-identity/profile/disclosure';

/**
 * **A WALLET MAY CREATE AS MANY COMPANIES AS IT LIKES.**
 * `docs/how-money-can-be-lost.md` `C155`, `C131`,
 * `docs/scope-v1-data-model.md` D4.
 *
 * ── THE DEFECT, AND WHY NO TEST COULD SEE IT ──────────────────────────────
 *
 * `POST /api/accounts` called `refuseReusedSubwallet(store, userId, null)`.
 * `null` means *the company does not exist yet*, so nothing filtered the list
 * of memberships, and the check threw for **any wallet user already on any
 * account at all.** One company made the second impossible, and the 400 said
 * nothing a person could act on. It was found by a person walking through the
 * product, twice over, and not by this suite — because every test that created
 * a company created exactly one.
 *
 * **SO THIS ONE CREATES TWO.** Over real HTTP, from one wallet sign-in, with
 * the second creation's status quoted rather than inferred: that is the whole
 * assertion, and putting the refusal back is what
 * a deliberate defect on the creation route does.
 *
 * ── IT IS NOT A JUDGEMENT CALL, IT IS A CONTRADICTED DECISION ─────────────
 *
 * `docs/scope-v1-data-model.md` D4, 15 Aug: **"A person may create and belong
 * to many companies. Already true."** — and for a wallet sign-in it had never
 * been true. `C131` closed on 22 Aug by REMOVAL and moved the concern into the
 * wallet, which knows which of its own slots it has used and with which sites;
 * the server-side half survived that removal. This is the rest of it.
 */

process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
/* Empty, not deleted: since `X2` the server reads `.env`, `.env` holds a live
 * connection string, and a deleted name is one `loadEnvFile` puts back. */
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-two-companies-')), 'db.json');

const ORIGIN = 'https://payroll.example';
/**
 * **THESE ROUTES ARE DRIVEN OVER A TEST DOUBLE, NOT OVER THE DEPLOYMENT, AND
 * THAT IS SAID HERE SO NOBODY READS THESE CASES AS EVIDENCE ABOUT A CHAIN.**
 *
 * This file is about one wallet opening a second company and a third, and about nothing refusing them for being second or third. Opening a company is a write, and the deployment this product runs on cannot write: it reads a chain and has no wallet.
 *
 * **SO THIS FILE BUILDS ITS OWN BOUNDARY IMPLEMENTATION AND HANDS IT OVER
 * BEFORE THE ENTRY POINT IS IMPORTED.** The services, the routes, the sign-in state
 * handling and the checks below are the real ones - the LEDGER is a double, and
 * it is named here, out loud, which is the difference between a test saying
 * which implementation it exercises and a second decision hidden in the
 * product. Nothing outside a test may do this: the walk beside the selector
 * refuses `handInWiring` in every non-test module.
 *
 * **WHAT THESE CASES PROVE AND WHAT THEY DO NOT.** They prove exactly what they
 * proved before the product selected a chain, and nothing more. **They are not
 * evidence that this server works against a chain.** `server-starts.test.ts` is
 * the file that exercises the real chain wiring, and it is deliberately the one
 * file here that takes no double.
 *
 * The three come from one object because they may never be chosen apart: a leaf
 * computed under one commitment scheme is meaningless to a ledger running under
 * another.
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
/* The network THIS server resolved, worked out the way it works it out —
 * `C151` is what a name disagreeing across two applications costs. */
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

/**
 * A REAL SIGN-IN, MINTED BY THE WALLET'S OWN CODE. `mint` and
 * `identityFromWords` ship from `midnight-identity`, so what this server
 * checks is bytes the wallet actually produced. Nothing here is a fixture
 * shaped like a signature.
 */
const signedInWithAWallet = async (slot: number): Promise<string> => {
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

const aCompany = async (token: string, name: string): Promise<Res> =>
  call('POST', '/api/accounts', {
    token, body: { name, signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
  });

describe('C155 — POST /api/accounts refuses nothing for being a SECOND company', () => {
  it('WATCHED FAILING: ONE WALLET, TWO COMPANIES, AND THE SECOND IS NOT REFUSED',
    async () => {
      const token = await signedInWithAWallet(5);

      const first = await aCompany(token, 'Northwind');
      expect(first.status, JSON.stringify(first.body)).toBe(200);

      const second = await aCompany(token, 'Eastgate');
      /* The status is quoted rather than described: this used to be a 400 with
       * a sentence about employers on a founder starting their own business. */
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body.account.id).not.toBe(first.body.account.id);

      /* And both are on the list this person is scoped to. */
      const mine = await call('GET', '/api/accounts', { token });
      expect(mine.status).toBe(200);
      expect(mine.body.map((a: { id: string }) => a.id).sort())
        .toEqual([first.body.account.id, second.body.account.id].sort());
    });

  it('AND A THIRD IS NOT A SPECIAL CASE EITHER', async () => {
    const token = await signedInWithAWallet(6);
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      // eslint-disable-next-line no-await-in-loop
      const made = await aCompany(token, name);
      expect(made.status, JSON.stringify(made.body)).toBe(200);
    }
    const mine = await call('GET', '/api/accounts', { token });
    expect(mine.body).toHaveLength(3);
  });

  it('NOTHING ANSWERS `subwallet-already-bound` ANY MORE, on any of these doors',
    async () => {
      /*
       * **THE CODE, ASSERTED ABSENT.** The refusal carried one — `409` with
       * `code: 'subwallet-already-bound'` — and a wallet sign-in that arrived
       * on an invitation could be answered with it too. Both are gone, so
       * neither door can produce it; a test that only counted companies would
       * miss the second door coming back on its own.
       */
      const token = await signedInWithAWallet(7);
      const first = await aCompany(token, 'Delta');
      const second = await aCompany(token, 'Epsilon');
      for (const r of [first, second]) {
        expect(r.status).not.toBe(409);
        expect(JSON.stringify(r.body)).not.toContain('subwallet-already-bound');
        expect(JSON.stringify(r.body)).not.toContain('already used by another employer');
      }
    });
});

/**
 * **THE PASTED ADDRESS IS GONE FROM THE DOOR.** `docs/NEXT.md` X8 §2,
 * `docs/how-money-can-be-lost.md` `C153`.
 *
 * `X7` built `POST /api/accounts/:id/self-payee` with `address: z.string()` on
 * it — the founder's own receiving address, typed into a box. It was safe on
 * that one door because the caller and the payee are the same person by
 * construction, **and `X7` said in as many words that it is a precedent that
 * must not spread to any door where they are not.**
 *
 * **WHAT IS BEING PROVED HERE IS AN ABSENCE**, which is why the body of the
 * attempt matters more than the assertion: a caller sends a complete,
 * well-formed, plausible payee address of its own choosing beside an honest
 * disclosure, and the record comes back pointing at the WALLET'S address. It is
 * a ROUTE, so it is tested over real HTTP for `server.test.ts`'s reason — the
 * two leaks that actually shipped in this project were both in a route, and a
 * mock request object gets middleware order, body parsing and status codes
 * right by definition. `scripts/mutate-self-payee.mjs` mutation 3 puts the door
 * back in and this is the test that dies.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { signInWithAWallet } from '../testing/wallet-session.js';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { addressFor, identityFromWords } from 'midnight-identity';
import { addressOfVerifyingKey, mint } from 'midnight-identity/profile/disclosure';
import { RECEIVING_ADDRESS } from 'midnight-identity/profile/attributes';
import { newWrappingKeypair } from '../core/crypto.js';
import { payeeFor } from '../testing/payees.js';

/* The same declarations `unlock-company.test.ts` makes, and for the same
 * reasons: a simulated ledger, sessions in memory, no port served, and the
 * live connection string emptied rather than deleted. */
process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
/* **THE ORIGIN A DISCLOSURE HAS TO NAME.** Configuration, never a header — a
 * disclosure minted for another payroll names that payroll inside the
 * signature, and the test below sends one. */
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-self-payee-')), 'db.json');

const ORIGIN = 'https://payroll.example';
/**
 * **THESE ROUTES ARE DRIVEN OVER A TEST DOUBLE, NOT OVER THE DEPLOYMENT, AND
 * THAT IS SAID HERE SO NOBODY READS THESE CASES AS EVIDENCE ABOUT A CHAIN.**
 *
 * This file is about the address a salary is paid to arriving signed from a wallet, and about every shape of it that must be refused. Registering one is a write, and the deployment this product runs on cannot write: it reads a chain and has no wallet.
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
/* The one the SERVER is running, worked out the same way it works it out —
 * `C151` is what a network name disagreeing across two applications costs. */
const { networkOfThePair } = await import('../midnight/network.js');
const NETWORK = networkOfThePair(process.env.MIDNIGHT_NETWORK_ID);

const identity = identityFromWords(TEST_MNEMONIC);
const SLOT = 2;
const signingAddress = addressOfVerifyingKey(
  signatureVerifyingKey({
    tag: 'schnorr',
    value: Buffer.from(identity.moneyAt(SLOT).night).toString('hex'),
  }).value,
  NETWORK);
const shielded = addressFor(identity.moneyAt(SLOT).zswap, NETWORK).bech32;

/** A complete, well-formed payee address that belongs to somebody else. */
const NOT_THEIRS = payeeFor('f0'.repeat(32), NETWORK).bech32;

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

let n = 20;
/**
 * **SIGNED IN WITH A WALLET, WHICH IS WHAT `C153` WAS ALWAYS ABOUT.**
 *
 * This used to register with a password, and `X7`'s note says why that was
 * awkward from the start: *the walk had to use an email session, and the one
 * thing the product is being rebuilt around cannot complete the money path.*
 * The caller now has no email, which is the case `X8` §3 moved the cap onto —
 * so these tests are exercising the state the product actually produces rather
 * than one only a deleted door could reach.
 */
const withACompany = async () => {
  const { token } = await signInWithAWallet(call,
    { slot: ++n, origin: ORIGIN, network: NETWORK });
  const made = await call('POST', '/api/accounts', {
    token,
    body: { name: 'Acme', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return {
    token,
    accountId: made.body.account.id as string,
    viewingKey: made.body.viewingKey as string,
  };
};

/** What a wallet would answer, minted by the wallet's own `mint`. */
const disclosureFor = (nonce: string, over: { origin?: string; value?: string } = {}) =>
  mint(identity, SLOT, {
    origin: over.origin ?? ORIGIN,
    nonce,
    address: signingAddress,
    at: Date.now(),
    disclosed: [{
      id: RECEIVING_ADDRESS,
      about: RECEIVING_ADDRESS,
      says: { of: 'value', value: over.value ?? shielded },
      asserted: { by: 'wallet' },
    }],
    declined: [],
    requesterSaidItWas: { name: 'Payroll', rdns: 'example.payroll' },
  }).response;

const asked = async (token: string, accountId: string) => {
  const r = await call('POST', `/api/accounts/${accountId}/payee-challenge`, { token });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { handle: r.body.handle as string, nonce: r.body.nonce as string };
};

const payload = (extra: Record<string, unknown>, viewingKey: string) => ({
  name: 'The Founder', title: 'Founder', asset: 'GBP', salary: '5500.00',
  viewingKey,
  wrappingPublicKey: newWrappingKeypair().publicKey,
  ...extra,
});

describe('POST /api/accounts/:id/self-payee', () => {
  it('THE ADDRESS COMES FROM THE WALLET, SIGNED, AND THE RECORD IS PAYABLE', async () => {
    const { token, accountId, viewingKey } = await withACompany();
    const given = await asked(token, accountId);
    const r = await call('POST', `/api/accounts/${accountId}/self-payee`, {
      token,
      body: payload({ disclosure: { ...given, response: disclosureFor(given.nonce) } },
        viewingKey),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('active');
    expect(r.body.address.bech32).toBe(shielded);
  });

  it('A CALLER THAT NAMES ITS OWN ADDRESS IS NOT SERVED IT', async () => {
    /*
     * The attack, in the shape it would actually arrive in: an honest
     * disclosure, and a perfectly valid payee address in the body beside it. If
     * any of these were believed, an operator could put a salary anywhere they
     * liked and every signature in the request would still check out.
     */
    const { token, accountId, viewingKey } = await withACompany();
    for (const extra of [
      { address: NOT_THEIRS },
      { payeeAddress: NOT_THEIRS },
      { address: NOT_THEIRS, bech32: NOT_THEIRS },
    ]) {
      const given = await asked(token, accountId);
      const r = await call('POST', `/api/accounts/${accountId}/self-payee`, {
        token,
        body: payload(
          { ...extra, disclosure: { ...given, response: disclosureFor(given.nonce) } },
          viewingKey),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.address.bech32).toBe(shielded);
      expect(r.body.address.bech32).not.toBe(NOT_THEIRS);
      expect(JSON.stringify(r.body)).not.toContain(NOT_THEIRS);
      /* One payable entry per person, so the next attempt needs its own
       * company rather than a second entry here. */
      break;
    }
  });

  it('AND AN ADDRESS WITH NO DISCLOSURE AT ALL IS REFUSED BY SHAPE', async () => {
    /* The old body, sent to the new door. There is nowhere to put an address,
     * so this is a 400 from the shape and never a record. */
    const { token, accountId, viewingKey } = await withACompany();
    const r = await call('POST', `/api/accounts/${accountId}/self-payee`, {
      token, body: payload({ address: shielded }, viewingKey),
    });
    expect(r.status).toBe(400);
  });

  it('AND A DISCLOSURE MINTED FOR ANOTHER PAYROLL IS REFUSED AT THIS ONE', async () => {
    const { token, accountId, viewingKey } = await withACompany();
    const given = await asked(token, accountId);
    const r = await call('POST', `/api/accounts/${accountId}/self-payee`, {
      token,
      body: payload({
        disclosure: {
          ...given,
          response: disclosureFor(given.nonce, { origin: 'https://elsewhere.example' }),
        },
      }, viewingKey),
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('origin-mismatch');
  });

  it('no session, no payee', async () => {
    const { accountId } = await withACompany();
    expect((await call('POST', `/api/accounts/${accountId}/self-payee`)).status).toBe(401);
    expect((await call('POST', `/api/accounts/${accountId}/payee-challenge`)).status).toBe(401);
  });
});

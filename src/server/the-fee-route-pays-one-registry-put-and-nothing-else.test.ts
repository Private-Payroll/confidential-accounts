import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MemoryStore } from '../core/store.js';
import type { SealedAccount } from '../core/types.js';
import { NothingWasSent } from '../core/jobs.js';
import { companyVaultRoutes, type CompanyVaultDeps } from './company-vaults.js';
import { REGISTRY_PUT } from '../wiring/registry-call-checks.js';
import REGISTRY_INFO from '../../contracts/managed-registry/compiler/contract-info.json' with { type: 'json' };

/**
 * **THE FEE ROUTE PAYS FOR ONE CALL TO A REGISTRY'S `put` AS IT PAYS FOR A CALL TO THE COMPANY'S OWN ACCOUNT**: only
 * to a registry its network lists, only that one call, moving nothing, and the call handed back with its fee alone.
 */
const hex = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const REGISTRY = hex(0x5e);
const ACCOUNT = hex(0xc0);
const CALL = Buffer.from([0xee]).toString('base64');

let server: Server;
let base: string;
let shape: unknown;
let paid: string[];
let registries: readonly string[] | undefined;
let seats: number;
let clock: Date;
let feeAnswer: (() => never) | null;
let store: MemoryStore;
const VAULT = hex(0xab);

/* One transaction as the reader hands it to the route: `actions` in one intent, with whatever else is given. */
const tx = (actions: unknown[], more: Record<string, unknown> = {}) => ({
  intents: new Map([[1, { actions, guaranteedUnshieldedOffer: undefined, fallibleUnshieldedOffer: undefined, dustActions: undefined, ...more }]]),
});
const put = (address = REGISTRY, circuit = REGISTRY_PUT) => ({ address, entryPoint: circuit });

beforeEach(async () => {
  store = new MemoryStore();
  seats = 1;
  clock = new Date('2026-11-25T10:00:00Z');
  feeAnswer = null;
  store.putAccount({
    id: 'acc_1', createdAt: '', keyEpoch: 0, threshold: 1, signerCount: 1, memberUserIds: ['ada'], pendingSigners: [], wrappedKeys: [], inboxPublicKey: '',
  } as unknown as SealedAccount);
  shape = {};
  paid = [];
  registries = [REGISTRY];
  const app = express();
  const deps: CompanyVaultDeps = {
    signedIn: (req, _res, next) => { (req as { userId?: string }).userId = String(req.headers['x-test-person']); next(); },
    member: (req, res, next) => {
      if (store.getAccount(String(req.params.id))?.memberUserIds.includes((req as { userId?: string }).userId!) !== true) {
        res.status(404).json({ error: 'account not found' });
        return;
      }
      next();
    },
    store,
    company: async () => ({ address: ACCOUNT, threshold: 1, seats, vaultThresholds: [] }),
    now: () => clock,
    ledger: {
      feeAddedTo: async (_a, what, arrival, bytes, check, read) => {
        const refused = await check(await read(bytes));
        if (refused !== null) throw new NothingWasSent(refused);
        if (feeAnswer !== null) feeAnswer();
        paid.push(`${arrival}: ${what}`);
        return { tx: new Uint8Array([7]), transactionHash: 'h' };
      },
    },
    chain: {
      contractState: async () => null, serialize: () => new Uint8Array(), notesOf: () => [],
      startingLedgerOf: () => { throw new Error('no vault is read here'); }, everCreated: async () => new Set(),
    },
    verifierKeys: async () => new Map(),
    account: { circuits: [], verifierKeys: async () => new Map() },
    readers: { proven: async () => shape, finished: async () => shape },
    get registries() { return registries; },
  };
  app.use(companyVaultRoutes(deps));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

const done = async (booking: unknown) => {
  await fetch(`${base}/api/accounts/acc_1/fee/done`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-person': 'ada' }, body: JSON.stringify({ booking }),
  });
};

const fee = async (body: Record<string, unknown>) => {
  const r = await fetch(`${base}/api/accounts/acc_1/fee`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-person': 'ada' },
    body: JSON.stringify({ tx: CALL, kind: 'registry-put', contract: REGISTRY, circuit: REGISTRY_PUT, ...body }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
};

describe('THE FEE ROUTE AND A REGISTRY WRITE', () => {
  it('the circuit it pays for is the registry\'s one proving circuit, as compiled', () => {
    /* RED WHEN: the route's name for the registry's write drifts from the compiled contract. */
    expect(REGISTRY_INFO.circuits.filter((c) => c.proof).map((c) => c.name)).toEqual([REGISTRY_PUT]);
  });

  it('one put to a registry the network lists gets only its fee, handed back unsent', async () => {
    /* RED WHEN: the route refuses the registry's write, or pays for it as anything but a call moving nothing. */
    shape = tx([put()]);
    expect(await fee({})).toMatchObject({ status: 200, body: { tx: Buffer.from([7]).toString('base64'), transactionHash: 'h' } });
    expect(paid).toEqual(['proven-moving-nothing: a call whose fee alone is paid here']);
  });

  it('a put to an address the network does not list as a registry is refused before any fee', async () => {
    /* RED WHEN: any contract named as a registry is paid for. */
    shape = tx([put(hex(0x77))]);
    expect(await fee({ contract: hex(0x77) })).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    /* RED WHEN: the company's own account passes as a registry. */
    shape = tx([put(ACCOUNT)]);
    expect(await fee({ contract: ACCOUNT })).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    /* RED WHEN: a network with no registries pays for one. */
    registries = undefined;
    shape = tx([put()]);
    expect(await fee({})).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(paid).toEqual([]);
  });

  it('another circuit, named or carried, is refused before any fee', async () => {
    /* RED WHEN: the kind names another circuit and is paid for. */
    shape = tx([put(REGISTRY, 'other')]);
    expect(await fee({ circuit: 'other' })).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    /* RED WHEN: the transaction calls another circuit than the put it is named as. */
    expect(await fee({})).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    expect(paid).toEqual([]);
  });

  it('a second call in the transaction, to the registry or to another contract, is refused before any fee', async () => {
    /* RED WHEN: a put carrying a second put is paid for. */
    shape = tx([put(), put()]);
    expect(await fee({})).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    /* RED WHEN: a put carrying a call to the company's account is paid for. */
    shape = tx([put(), put(ACCOUNT, 'approve')]);
    expect(await fee({})).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    expect(paid).toEqual([]);
  });

  it('a put that moves any coin or DUST is refused before any fee', async () => {
    /* RED WHEN: a put that also pays out public money is paid for. */
    shape = tx([put()], { guaranteedUnshieldedOffer: { inputs: [{}], outputs: [] } });
    expect(await fee({})).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    /* RED WHEN: a put that spends a shielded coin is paid for. */
    shape = { ...tx([put()]), guaranteedOffer: { inputs: [{}], outputs: [], transients: [] } };
    expect(await fee({})).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    /* RED WHEN: a put that already spends DUST is paid for. */
    shape = tx([put()], { dustActions: { spends: [{}], registrations: [] } });
    expect(await fee({})).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    expect(paid).toEqual([]);
  });
});

describe('A REFUSAL SAYS WHETHER THE CALL OR ONLY THE PAYMENT WAS REFUSED', () => {
  it('every refusal by a call\'s own checks is marked as the call\'s, so no wallet offers another way to pay for it', async () => {
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: 'then', deployRef: 'r', intended: { committee: [], threshold: 1 }, bornHeld: false } as never);
    const refusals = [
      /* RED WHEN: a put to a registry the network does not list is refused as only a payment. */
      await fee({ contract: hex(0x77) }),
      /* RED WHEN: a call to another company's account is refused as only a payment. */
      await fee({ kind: 'account-call', contract: hex(0xc1), circuit: 'approve' }),
      /* RED WHEN: a call to a vault the company does not have is refused as only a payment. */
      await fee({ kind: 'payout', contract: hex(0x99), circuit: 'payout' }),
      /* RED WHEN: a payment out of a vault this service cannot vouch for is refused as only a payment. */
      await fee({ kind: 'payout', contract: VAULT, circuit: 'payout' }),
      /* RED WHEN: a vault's first secret the start route would not send is refused as only a payment. */
      await fee({ kind: 'vault-secret', contract: VAULT, circuit: 'setNonceSecret' }),
      /* RED WHEN: a transaction the call's check refuses is refused as only a payment. */
      await (async () => { shape = tx([put(), put()]); return fee({}); })(),
    ];
    for (const r of refusals) expect(r.body, JSON.stringify(r.body)).toMatchObject({ nothingWasSent: true, callRefused: true });
    expect(paid).toEqual([]);
  });

  it('a refusal to pay is not marked as the call\'s, so the person may still pay it from their own DUST', async () => {
    shape = tx([put()]);
    feeAnswer = () => { throw Object.assign(new NothingWasSent('the fee payer has too little DUST to pay this fee'), { code: 'fee-not-paid' }); };
    const out = await fee({});
    /* RED WHEN: a sponsorship out of DUST is marked as the call's refusal, so the own-DUST offer never comes. */
    expect(out).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    expect(out.body['callRefused']).toBeUndefined();
  });
});

describe('OUR SPONSORSHIP PAYS FOR A BOUNDED NUMBER OF REGISTRY WRITES', () => {
  it('twice the seats the chain holds, each day, and a payment refusal past it', async () => {
    shape = tx([put()]);
    seats = 2;
    for (let i = 0; i < 4; i += 1) {
      const ok = await fee({});
      expect(ok.status, String(i)).toBe(200);
      await done(ok.body['booking']);
    }
    const over = await fee({});
    /* RED WHEN: our sponsorship pays for more registry writes in a day than the company's seats need. */
    expect(over).toMatchObject({ status: 429, body: { nothingWasSent: true } });
    /* RED WHEN: the bound is told as the call's own refusal, so the person cannot pay it themselves. */
    expect(over.body['callRefused']).toBeUndefined();
    clock = new Date('2026-11-26T00:00:01Z');
    /* RED WHEN: the bound does not start again the next day. */
    expect((await fee({})).status).toBe(200);
  });
});

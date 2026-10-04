/**
 * **A COMPANY'S ACCOUNT, CREATED FROM ITS FOUNDING SIGNER'S BROWSER, AS THIS
 * SERVICE READS, RECORDS, SENDS AND FINISHES IT.** Every transaction here is
 * built by the device's own builder and signed by the founding signer's wallet
 * code; the service's sends are applied to an empty ledger in memory with every
 * signature checked, and what the routes read back is that ledger.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { committeeKeyFor, committeeSigningKeyFor } from 'midnight-identity/profile/committee-key';
import { buildCreationInsert } from 'midnight-identity/profile/contract-keys';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { MemoryStore } from '../core/store.js';
import type { SealedAccount } from '../core/types.js';
import { CREATION_STEPS, DEPLOYED_CIRCUITS } from '../midnight/deferral.js';
import { circuitsRefusal } from '../wiring/vault-submission.js';
import { readProvenTransaction } from '../wiring/proven-submission.js';
import { NothingWasSent } from '../core/jobs.js';
import { accountCreationRoutes, serverCreationRefusal } from './account-creation.js';
import { accountCreationExpectationsIn } from './vault-chain.js';
import { buildAccountDeploy, finishedCreation } from '../../packages/web-shared/src/vault-builder.js';
import { keysOnDisk, ACCOUNT_KEYS } from '../../contracts/test/keys-on-disk.js';
import { accountBuilderDeps, anAccountBornHeld } from '../../contracts/test/an-account-born-held.js';

const ROOT = join(import.meta.dirname, '..', '..');
const KEYS = join(ROOT, 'contracts', 'managed', 'keys');
const ON_DISK = keysOnDisk([ACCOUNT_KEYS]).ok;
const NET = 'undeployed';
const LABEL = `co_${'3d'.repeat(32)}` as CompanyLabel;
const LEAF = '4e'.repeat(32);
const founder = identityFromWords(TEST_MNEMONIC);
const foundingKey = committeeKeyFor(founder, LABEL);
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const keyFile = (c: string) => new Uint8Array(readFileSync(join(KEYS, `${c}.verifier`)));

/** What the founding signer's device and wallet produce together: the deploy and the signed second step. */
const createdOnTheDevice = async (over: { leaf?: string; key?: { tag: string; value: string }; signWith?: 'founder' | 'stranger' } = {}) => {
  if (over.signWith !== 'stranger' && over.key === undefined) {
    const made = await anAccountBornHeld({ network: NET, founder, label: LABEL, foundingLeaf: over.leaf ?? LEAF });
    return { address: made.deploy.address, deploy: b64(made.deploy.proven), insert: b64(made.insert.proven) };
  }
  /* A deploy held by another key, or a second step signed by one: the device's builder, with a stranger's signature. */
  const deploy = await buildAccountDeploy(accountBuilderDeps(NET), { foundingLeaf: over.leaf ?? LEAF, label: LABEL, foundingKey: over.key ?? foundingKey });
  const keys = new Map(CREATION_STEPS.second.map((c) => [c, keyFile(c)] as [string, Uint8Array]));
  const signature = L.signData(L.sampleSigningKey(), new Uint8Array([1]));
  const insert = await finishedCreation(accountBuilderDeps(NET), { account: deploy.address, keys, signature });
  return { address: deploy.address, deploy: b64(deploy.proven), insert: b64(insert.proven) };
};

/** The chain: an empty ledger in memory, every transaction applied with its signatures checked. */
class Chain {
  state: any = L.LedgerState.blank(NET);
  apply(bytes: Uint8Array): void {
    const now = new Date();
    const t = BigInt(Math.floor(now.getTime() / 1000));
    const s = new L.WellFormedStrictness();
    s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = false; s.enforceLimits = true; s.verifySignatures = true;
    const tx = (L.Transaction.deserialize('signature', 'proof', 'pre-binding', bytes) as any).bind();
    const [next, r] = this.state.apply(tx.wellFormed(this.state, s, now),
      new L.TransactionContext(this.state, { secondsSinceEpoch: t, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: t - 6n }));
    if (r.type !== 'success') throw new Error(`the chain refused it: ${String(r.error ?? r.type)}`);
    this.state = next;
  }
  contract(address: string): unknown | null {
    try { return this.state.index(address) ?? null; } catch { return null; }
  }
}

let store: MemoryStore;
let chain: Chain;
let sent: string[];
let registered: Array<[string, string]>;
let landing: boolean;
let server: ReturnType<express.Express['listen']>;
let base: string;

beforeEach(async () => {
  store = new MemoryStore();
  store.putAccount({ id: 'acc_1', memberUserIds: ['ada'], companyLabel: LABEL, contractAddress: null, addressSource: null } as unknown as SealedAccount);
  store.recordAccountOpening({ accountId: 'acc_1', foundingKey, foundingLeaf: LEAF, companyLabel: LABEL });
  chain = new Chain();
  sent = [];
  registered = [];
  landing = true;
  const app = express();
  app.use(accountCreationRoutes({
    signedIn: (req, res, next) => { if (req.headers['x-test-person'] === undefined) { res.status(401).end(); return; } (req as { userId?: string }).userId = String(req.headers['x-test-person']); next(); },
    member: (req, res, next) => { if (store.getAccount(String(req.params.id))?.memberUserIds.includes((req as { userId?: string }).userId!) !== true) { res.status(404).end(); return; } next(); },
    store,
    ledger: {
      sendVault: async (_a: string, what: string, _arrival: unknown, bytes: Uint8Array, check: (tx: unknown) => unknown, read: (b: Uint8Array) => Promise<unknown>) => {
        const refused = await check(await read(bytes));
        if (refused !== null) throw new NothingWasSent(String(refused));
        sent.push(what);
        if (landing) chain.apply(bytes);
        return { ref: 'r', at: 'now', transactionHash: 'h' };
      },
    } as never,
    contractState: async (a) => chain.contract(a),
    register: async (id, a) => { registered.push([id, a]); },
    readers: { proven: readProvenTransaction },
    expected: accountCreationExpectationsIn(ROOT),
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

const call = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-test-person': 'ada' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const create = (b: { deploy: string; insert: string }) => call('/api/accounts/acc_1/creation', 'POST', { deploy: b.deploy, insert: b.insert });

describe('THE SERVICE CREATES NO COMPANY\'S ACCOUNT ON A CHAIN', () => {
  it('REFUSES BY NAME A CREATION THAT DOES NOT NAME THE FOUNDING SIGNER\'S KEY, AND LEAVES THE SIMULATED LEDGER ITS OWN', () => {
    /* RED WHEN the old creation, which deployed under a key this service held, still runs on a chain. */
    expect(serverCreationRefusal('midnight', undefined)).toMatchObject({ code: 'created-from-the-founding-signers-browser' });
    expect(serverCreationRefusal('midnight', { tag: 'schnorr', value: 'ab'.repeat(32) })).toBeNull();
    expect(serverCreationRefusal('simulated', undefined)).toBeNull();
  });
});

describe.skipIf(!ON_DISK)('A COMPANY\'S ACCOUNT FROM ITS FOUNDING SIGNER\'S BROWSER [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  it('IS READ, RECORDED BEFORE IT IS SENT, SENT, AND FINISHED BY ITS SECOND STEP, THE SAME BYTES AS RECORDED', async () => {
    const made = await createdOnTheDevice();
    expect((await call('/api/accounts/acc_1/creation')).body).toEqual({ state: 'not-created', account: null });
    const r = await create(made);
    expect(r).toMatchObject({ status: 201, body: { account: made.address, state: 'deploy-sent' } });
    /* RED WHEN the attempt is not recorded before it is sent, or the address is not the company's from then on. */
    expect(store.getAccountDeploy('acc_1')).toMatchObject({ address: made.address, deploy: made.deploy, insert: made.insert, foundingKey });
    expect(store.getAccount('acc_1')).toMatchObject({ contractAddress: made.address, addressSource: 'chain' });
    expect(registered).toEqual([['acc_1', made.address]]);
    expect((await call('/api/accounts/acc_1/creation')).body).toEqual({ state: 'finish-owed', account: made.address });
    const done = await call('/api/accounts/acc_1/creation/finish', 'POST');
    expect(done).toMatchObject({ status: 200, body: { state: 'finish-sent' } });
    expect((await call('/api/accounts/acc_1/creation')).body).toEqual({ state: 'finished', account: made.address });
    expect(sent).toEqual(['creating the company\'s account', 'finishing the company\'s account']);
    /* Finishing again sends nothing. */
    expect((await call('/api/accounts/acc_1/creation/finish', 'POST')).body).toMatchObject({ state: 'finished' });
    expect(sent).toHaveLength(2);
  });

  it('TAKES NO MONEY UNTIL ITS SECOND STEP HAS LANDED: UNTIL THEN IT DOES NOT RUN THIS BUILD\'S CIRCUITS', async () => {
    const made = await createdOnTheDevice();
    await create(made);
    const all = new Map(DEPLOYED_CIRCUITS.map((c) => [c, keyFile(c)] as [string, Uint8Array]));
    /* RED WHEN an account carrying only its first step's circuits is read as this build's, so money could go in before it is finished. */
    expect(circuitsRefusal(chain.contract(made.address), all, 'no money goes in', DEPLOYED_CIRCUITS, 'the account\'s'))
      .toBe('no money goes in: it has circuits other than the account\'s own. Nothing was sent.');
    await call('/api/accounts/acc_1/creation/finish', 'POST');
    expect(circuitsRefusal(chain.contract(made.address), all, 'no money goes in', DEPLOYED_CIRCUITS, 'the account\'s')).toBeNull();
  });

  it('NEVER A SECOND ACCOUNT: A RETRY SENDS THE RECORDED BYTES, OTHER BYTES ARE REFUSED, AND NO ADDRESS IS RECORDED TWICE', async () => {
    const made = await createdOnTheDevice();
    landing = false;
    expect((await create(made)).status).toBe(201);
    /* The deploy did not land: the same bytes again are sent again, unchanged. */
    expect(await create(made)).toMatchObject({ status: 200, body: { state: 'deploy-sent' } });
    expect(sent).toEqual(['creating the company\'s account', 'creating the company\'s account, again']);
    /* RED WHEN a rebuilt deploy, which is a second account, is taken for a company that has one. */
    const rebuilt = await createdOnTheDevice();
    const other = await create(rebuilt);
    expect(other).toMatchObject({ status: 409, body: { nothingWasSent: true, account: made.address } });
    expect(store.getAccountDeploy('acc_1')!.address).toBe(made.address);
    /* The second step is not sent before the chain shows the deploy. */
    expect((await call('/api/accounts/acc_1/creation/finish', 'POST'))).toMatchObject({ status: 409, body: { state: 'deploy-sent' } });
    expect(sent).toHaveLength(2);
  });

  it('REFUSES, BEFORE ANYTHING IS RECORDED OR PAID FOR, A DEPLOY HELD BY ANOTHER KEY, ONE STARTING FROM ANOTHER STATE, AND AN INSERT NOT SIGNED BY THE FOUNDING SIGNER', async () => {
    const theirs = await createdOnTheDevice({ key: L.signatureVerifyingKey(L.sampleSigningKey()) });
    /* RED WHEN the deploy's own authority is believed rather than the key recorded when the company was made. */
    expect((await create(theirs)).body.error).toMatch(/held by its founding signer's own key alone/);
    /* RED WHEN the starting state is not compared with the constructor's own run over what was recorded. */
    const anotherSeat = await createdOnTheDevice({ leaf: '5f'.repeat(32) });
    expect((await create(anotherSeat)).body.error).toMatch(/starts from a state other than the one the account's constructor makes/);
    /* RED WHEN a second step signed by any key but the founding signer's is paid for. */
    const made = await createdOnTheDevice();
    const forged = await createdOnTheDevice({ signWith: 'stranger' });
    expect((await create({ deploy: forged.deploy, insert: forged.insert })).body.error).toMatch(/not signed once by the founding signer's own key/);
    /* RED WHEN a second step finishing another account is paid for with this one. */
    expect((await create({ deploy: made.deploy, insert: forged.insert })).body.error).toMatch(/changes a different contract/);
    expect(store.getAccountDeploy('acc_1')).toBeNull();
    expect(sent).toEqual([]);
    expect(store.getAccount('acc_1')!.contractAddress).toBeNull();
  });

  it('REFUSES A SECOND STEP THE FOUNDING SIGNER DID SIGN, WHEN IT IS NOT THE ONE THIS SERVICE BUILDS: ANOTHER COUNTER, OR OTHER KEYS', async () => {
    const made = await createdOnTheDevice();
    /* The founding signer's own key signs each of these, so only what the step carries can refuse it. */
    const signedByTheFounder = async (counter: bigint, swap: boolean) => {
      const keys = new Map(CREATION_STEPS.second.map((c) => [c, keyFile(swap && c === 'recordPaymentFromVault' ? 'approve' : c)] as [string, Uint8Array]));
      const { update } = buildCreationInsert(L as never, { address: made.address, counter, onChain: CREATION_STEPS.first, keys, steps: CREATION_STEPS });
      const key = committeeSigningKeyFor(founder, LABEL);
      const signed = (update as any).addSignature(0n, L.signData(key as never, (update as any).dataToSign));
      const tx = L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(new Date(Date.now() + 30 * 60_000)).addMaintenanceUpdate(signed));
      return b64((await accountBuilderDeps(NET).prove(tx)).serialize());
    };
    /* RED WHEN the step's counter is not read: a step built for a later counter would be recorded and could never land. */
    expect((await create({ deploy: made.deploy, insert: await signedByTheFounder(1n, false) })).body.error)
      .toMatch(/built against a counter other than the account's first/);
    /* RED WHEN what the founding signer signed is not compared with the step this service builds: a key that is not this build's would be inserted. */
    expect((await create({ deploy: made.deploy, insert: await signedByTheFounder(0n, true) })).body.error)
      .toMatch(/inserts something other than exactly this build's remaining circuits/);
    expect(store.getAccountDeploy('acc_1')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('DOES NOT SEND THE RECORDED SECOND STEP TO AN ACCOUNT CHANGED BEFORE IT LANDED, WHICH IT COULD NEVER LAND ON', async () => {
    const made = await createdOnTheDevice();
    await create(made);
    /* The founding signer's key changes the account first, at its first counter, with something that is not the second step. */
    const one = CREATION_STEPS.second[0]!;
    const { update } = buildCreationInsert(L as never, {
      address: made.address, counter: 0n, onChain: CREATION_STEPS.first, keys: new Map([[one, keyFile(one)]]),
      steps: { first: CREATION_STEPS.first, second: [one] },
    });
    const signed = (update as any).addSignature(0n, L.signData(committeeSigningKeyFor(founder, LABEL) as never, (update as any).dataToSign));
    chain.apply((await accountBuilderDeps(NET).prove(L.Transaction.fromParts(NET, undefined, undefined,
      L.Intent.new(new Date(Date.now() + 30 * 60_000)).addMaintenanceUpdate(signed)))).serialize());
    const r = await call('/api/accounts/acc_1/creation/finish', 'POST');
    /* RED WHEN the account's counter is not read before the recorded step is sent: it would be paid for and could never land. */
    expect(r).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(r.body.error).toMatch(/changed before its second step landed/);
    expect(sent).toEqual(['creating the company\'s account']);
  });

  it('REFUSES A COMPANY NOT CREATED FROM ITS FOUNDING SIGNER\'S BROWSER, WHICH HAS NOTHING TO BE READ AGAINST', async () => {
    store.putAccount({ id: 'acc_2', memberUserIds: ['ada'], companyLabel: LABEL } as unknown as SealedAccount);
    const made = await createdOnTheDevice();
    const r = await call('/api/accounts/acc_2/creation', 'POST', { deploy: made.deploy, insert: made.insert });
    expect(r).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(sent).toEqual([]);
  });
});

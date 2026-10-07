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
import { storedSignerLeaf } from '../core/signer-leaf.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import * as accountModule from '../../contracts/managed/contract/index.js';
import { newWrappingKeypair } from '../core/crypto.js';
import { NO_ASSET } from '../core/assets.js';
import { readAccountDeploy } from '../wiring/vault-submission.js';
import { openSealedPayKey, payKeyCommitmentOf, payKeyPayloadOf } from '../midnight/pay-key-commitment.js';
import { sealedPayKeyIn } from '../midnight/pay-key-round.js';
import { creationCarriedAgain } from '../../packages/web-shared/src/vault-builder.js';
import { answerVaultAsk } from '../../packages/web-shared/src/vault-worker-entry.js';
import type { GovernedCallOrder, OpenedRound } from '../../packages/web-shared/src/governed-call-builder.js';

/** The proving worker as a device runs it, with every proof mocked: the chain here does not check contract proofs. */
const workerDeps = async () => ({
  ...accountBuilderDeps(NET),
  accountZkConfig: new NodeZkConfigProvider(join(ROOT, 'contracts', 'managed')),
  accountPure: (accountModule as any).pureCircuits,
  accountLedger: (accountModule as any).ledger,
  prove: async (unproven: any) => unproven,
}) as never;

const ROOT = join(import.meta.dirname, '..', '..');
const KEYS = join(ROOT, 'contracts', 'managed', 'keys');
const ON_DISK = keysOnDisk([ACCOUNT_KEYS]).ok;
const NET = 'undeployed';
const LABEL = `co_${'3d'.repeat(32)}` as CompanyLabel;
/* The founding signer's seat, from key material held for the test as a device holds it. */
const MATERIAL = { signingSecret: '1c'.repeat(32), blinding: '2d'.repeat(32), scope: MidnightCommitments.allVaults().toLowerCase() };
const LEAF = storedSignerLeaf(MATERIAL, MidnightCommitments).toLowerCase();
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
/**
 * **A TRANSACTION AS THIS TEST'S CHAIN AND SERVICE READ IT.** A deploy and a
 * second step are proven, as the device sends them. A call to one of the
 * account's circuits is built here by the device's own builder with its proof
 * left out, because the chain in this test does not check contract proofs and
 * proving one here would take minutes; it is read unproven, and nothing else is.
 */
const deviceCallOrProven = (bytes: Uint8Array): unknown => {
  try {
    return L.Transaction.deserialize('signature', 'proof', 'pre-binding', bytes);
  } catch {
    return L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', bytes);
  }
};

/** The time the chain and this service go by. A test moves it to watch a transaction run out. */
let clock = (): Date => new Date();

class Chain {
  state: any = L.LedgerState.blank(NET);
  apply(bytes: Uint8Array): void {
    const now = clock();
    const t = BigInt(Math.floor(now.getTime() / 1000));
    const s = new L.WellFormedStrictness();
    s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = false; s.enforceLimits = true; s.verifySignatures = true;
    const tx = (deviceCallOrProven(bytes) as any).bind();
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
/** While set, a send that has passed its reading waits on it: a send held in flight. */
let holding: Promise<void> | null;
/** A state the chain is read as holding for an account in place of its own, for a test of what is read from it. */
let readAs: unknown | undefined;
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
  holding = null;
  clock = () => new Date();
  readAs = undefined;
  const app = express();
  app.use(accountCreationRoutes({
    signedIn: (req, res, next) => { if (req.headers['x-test-person'] === undefined) { res.status(401).end(); return; } (req as { userId?: string }).userId = String(req.headers['x-test-person']); next(); },
    member: (req, res, next) => { if (store.getAccount(String(req.params.id))?.memberUserIds.includes((req as { userId?: string }).userId!) !== true) { res.status(404).end(); return; } next(); },
    store,
    ledger: {
      sendVault: async (_a: string, what: string, _arrival: unknown, bytes: Uint8Array, check: (tx: unknown) => unknown, read: (b: Uint8Array) => Promise<unknown>) => {
        const refused = await check(await read(bytes));
        if (refused !== null) throw new NothingWasSent(String(refused));
        if (holding !== null) await holding;
        sent.push(what);
        if (landing) chain.apply(bytes);
        return { ref: 'r', at: 'now', transactionHash: 'h' };
      },
    } as never,
    contractState: async (a) => (readAs !== undefined ? readAs : chain.contract(a)),
    register: async (id, a) => { registered.push([id, a]); },
    readers: { proven: async (bytes: Uint8Array) => { try { return await readProvenTransaction(bytes); } catch { return deviceCallOrProven(bytes); } } },
    expected: accountCreationExpectationsIn(ROOT),
    now: () => clock(),
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
    /* RED WHEN: the account reads finished before it is committed to the company's pay-record key. */
    expect((await call('/api/accounts/acc_1/creation')).body).toEqual({ state: 'pay-key-owed', account: made.address });
    expect(sent).toEqual(['creating the company\'s account', 'finishing the company\'s account']);
    /* Finishing again sends nothing. */
    expect((await call('/api/accounts/acc_1/creation/finish', 'POST')).body).toMatchObject({ state: 'pay-key-owed' });
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

  it('NEVER RECORDS ONE ACCOUNT FOR TWO COMPANIES: A DEPLOY ALREADY RECORDED FOR ANOTHER IS REFUSED, AND NOTHING IS SENT', async () => {
    const made = await createdOnTheDevice();
    await create(made);
    store.putAccount({ id: 'acc_2', memberUserIds: ['ada'], companyLabel: LABEL, contractAddress: null, addressSource: null } as unknown as SealedAccount);
    store.recordAccountOpening({ accountId: 'acc_2', foundingKey, foundingLeaf: LEAF, companyLabel: LABEL });
    /* RED WHEN: a second company records, and pays to send, the deploy of an account already recorded for the first. */
    expect(await call('/api/accounts/acc_2/creation', 'POST', { deploy: made.deploy, insert: made.insert }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true, error: expect.stringMatching(/already recorded for a company/) } });
    expect(store.getAccountDeploy('acc_2')).toBeNull();
    expect(store.getAccount('acc_2')!.contractAddress).toBeNull();
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

describe.skipIf(!ON_DISK)('A CREATION CARRIED ON PAST WHAT RUNS OUT, JUDGED BY ITS KEYS, AND FINISHED BY ITS PAY-RECORD KEY [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  /** Moves this service's and the chain's time on by `minutes`. */
  const later = (minutes: number) => { const at = Date.now() + minutes * 60_000; clock = () => new Date(at); };
  const standing = async () => (await call('/api/accounts/acc_1/creation')).body;
  /** The same deploy and the same signed second step, carried in fresh transactions, as the founding signer's device carries them. */
  const carriedAgain = async (made: { deploy: string; insert: string }) => {
    const again = await creationCarriedAgain({ ...accountBuilderDeps(NET), now: () => clock().getTime() },
      { deploy: new Uint8Array(Buffer.from(made.deploy, 'base64')), insert: new Uint8Array(Buffer.from(made.insert, 'base64')) });
    return { address: again.account, deploy: b64(again.deploy), insert: b64(again.insert) };
  };

  it('A DEPLOY THAT RAN OUT BEFORE IT LANDED IS CARRIED AGAIN: THE SAME ACCOUNT, RECORDED IN ITS PLACE, AND NEVER A SECOND', async () => {
    const made = await createdOnTheDevice();
    landing = false;
    await create(made);
    /* RED WHEN: a deploy that can still land is replaced. */
    const early = await carriedAgain(made);
    expect(await call('/api/accounts/acc_1/creation/again', 'POST', { deploy: early.deploy, insert: early.insert }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true, state: 'deploy-sent' } });
    later(36);
    /* RED WHEN: a deploy past its time to live, with nothing at its address, is still read as on its way. */
    expect(await standing()).toEqual({ state: 'deploy-expired', account: made.address });
    /* The control: the deploy that ran out can never land. */
    expect(() => chain.apply(new Uint8Array(Buffer.from(made.deploy, 'base64')))).toThrow();
    /* RED WHEN: another deploy, which is another account, takes the place of the one the wallet signed for. */
    const other = await carriedAgain(await createdOnTheDevice());
    const refused = await call('/api/accounts/acc_1/creation/again', 'POST', { deploy: other.deploy, insert: other.insert });
    expect(refused).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    expect(refused.body.error).toMatch(/creates another account than the one recorded/);
    const again = await carriedAgain(made);
    expect(again.address).toBe(made.address);
    landing = true;
    expect(await call('/api/accounts/acc_1/creation/again', 'POST', { deploy: again.deploy, insert: again.insert }))
      .toMatchObject({ status: 200, body: { account: made.address, state: 'deploy-sent' } });
    /* RED WHEN: what was carried again is not recorded in the place of what ran out, so a retry would send what can never land. */
    expect(store.getAccountDeploy('acc_1')).toMatchObject({ address: made.address, deploy: again.deploy, insert: again.insert });
    /* RED WHEN: a record is replaced by one for another account or another key. */
    const kept = store.getAccountDeploy('acc_1')!;
    expect(store.replaceAccountDeploy({ ...kept, address: other.address as never })).toBe(false);
    expect(store.replaceAccountDeploy({ ...kept, foundingKey: { tag: 'schnorr', value: 'ab'.repeat(32) } })).toBe(false);
    expect(store.replaceAccountDeploy({ ...kept, accountId: 'acc_9' })).toBe(false);
    expect(store.getAccountDeploy('acc_1')).toEqual(kept);
    expect(await standing()).toEqual({ state: 'finish-owed', account: made.address });
    expect((await call('/api/accounts/acc_1/creation/finish', 'POST')).body).toMatchObject({ state: 'finish-sent' });
    expect((await standing()).state).toBe('pay-key-owed');
  });

  it('A SECOND STEP THAT RAN OUT BEFORE IT WAS SENT IS CARRIED AGAIN WITH THE SAME SIGNATURE, AND NOTHING ELSE TAKES ITS PLACE', async () => {
    const made = await createdOnTheDevice();
    await create(made);
    later(36);
    /* RED WHEN: a second step past its time to live is read as one that can still be sent. */
    expect(await standing()).toEqual({ state: 'finish-expired', account: made.address });
    /* RED WHEN: the recorded step that ran out is sent: it would be paid for and never land. */
    expect(await call('/api/accounts/acc_1/creation/finish', 'POST')).toMatchObject({ status: 409, body: { nothingWasSent: true, state: 'finish-expired' } });
    expect(sent).toEqual(['creating the company\'s account']);
    /* RED WHEN: a step signed by anybody but the founding signer, for another account, takes its place. */
    const stranger = await carriedAgain(await createdOnTheDevice({ signWith: 'stranger' }));
    expect(await call('/api/accounts/acc_1/creation/finish', 'POST', { insert: stranger.insert })).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    const again = await carriedAgain(made);
    expect(await call('/api/accounts/acc_1/creation/finish', 'POST', { insert: again.insert }))
      .toMatchObject({ status: 200, body: { state: 'finish-sent' } });
    expect(store.getAccountDeploy('acc_1')).toMatchObject({ deploy: made.deploy, insert: again.insert });
    expect((await standing()).state).toBe('pay-key-owed');
  });

  it('WHAT WAS CARRIED AGAIN AND HAS ITSELF RUN OUT IS NOT RECORDED, AND A SECOND STEP THAT CAN STILL LAND IS NOT REPLACED', async () => {
    const made = await createdOnTheDevice();
    landing = false;
    await create(made);
    later(36);
    const stale = await carriedAgain(made);
    later(72);
    const before = store.getAccountDeploy('acc_1');
    /* RED WHEN: a deploy carried again that has itself run out is recorded in the place of the first, so a retry sends what can never land. */
    const deploy = await call('/api/accounts/acc_1/creation/again', 'POST', { deploy: stale.deploy, insert: stale.insert });
    expect(deploy).toMatchObject({ status: 422, body: { nothingWasSent: true, error: expect.stringMatching(/run out already/) } });
    expect(store.getAccountDeploy('acc_1')).toEqual(before);
    /* The control: the same deploy, carried now, is recorded. */
    landing = true;
    const now = await carriedAgain(made);
    expect((await call('/api/accounts/acc_1/creation/again', 'POST', { deploy: now.deploy, insert: now.insert })).status).toBe(200);
    expect((await standing()).state).toBe('finish-owed');
    const fresh = await carriedAgain(made);
    /* RED WHEN: a second step that can still land is replaced, so two signed steps for one account are on their way. */
    expect(await call('/api/accounts/acc_1/creation/finish', 'POST', { insert: fresh.insert }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true, error: expect.stringMatching(/can still land, so it is not replaced/) } });
    expect(store.getAccountDeploy('acc_1')!.insert).toBe(now.insert);
    later(110);
    expect((await standing()).state).toBe('finish-expired');
    later(150);
    /* RED WHEN: a second step carried again that has itself run out is recorded in the place of the first. */
    expect(await call('/api/accounts/acc_1/creation/finish', 'POST', { insert: fresh.insert }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true, error: expect.stringMatching(/run out already/) } });
    expect(store.getAccountDeploy('acc_1')!.insert).toBe(now.insert);
    expect(sent.filter((w) => w.startsWith('finishing'))).toEqual([]);
  });

  it('FINISHED IS JUDGED BY THE KEYS THE CHAIN HOLDS AND THE PAY-RECORD KEY, NEVER BY THE CIRCUITS\' NAMES', async () => {
    const made = await createdOnTheDevice();
    await create(made);
    await call('/api/accounts/acc_1/creation/finish', 'POST');
    const real = chain.contract(made.address) as any;
    readAs = {
      data: real.data, operations: () => real.operations(),
      operation: (n: string) => (n === 'sealPayKey' ? { verifierKey: keyFile('approve') } : real.operation(n)),
    };
    /* RED WHEN: an account whose every circuit carries the right name, one of them with another key, reads as complete. */
    expect((await standing()).state).toBe('finish-owed');
    readAs = undefined;
    expect((await standing()).state).toBe('pay-key-owed');
  });

  it('THE PAY-RECORD KEY IS COMMITTED UNDER AN APPROVED PROPOSAL AND SEALED TO THE FOUNDING SIGNER, EACH STEP BUILT ON THE DEVICE, AND READ BACK', async () => {
    const made = await createdOnTheDevice();
    await create(made);
    const KEY = '9a'.repeat(32);
    const wrapping = newWrappingKeypair();
    const standingOnTheDevice = async () => {
      const a = await answerVaultAsk(workerDeps, {
        id: 1, network: NET, ask: 'pay-key-standing', account: made.address, accountState: b64((chain.contract(made.address) as any).serialize()),
        key: KEY, signingSecret: MATERIAL.signingSecret, wrappingPublicKey: wrapping.publicKey,
      });
      if (!a.ok || a.ask !== 'pay-key-standing') throw new Error(a.ok ? 'another answer' : a.error);
      return a.standing;
    };
    /* RED WHEN: a step is taken before the account is finished. */
    const s0 = await standingOnTheDevice();
    const payKey = { kind: 'pay-key', commitment: s0.round.commitment } as const;
    const opened: OpenedRound = {
      chainId: s0.round.proposal, digest: s0.round.payload, vault: s0.noVault, salt: s0.round.salt, summary: '', governance: payKey,
      half: { assetId: NO_ASSET, changeAmount: '0', changeBatchDigest: '00'.repeat(32) },
    };
    const onTheDevice = async (order: GovernedCallOrder) => {
      const a = await answerVaultAsk(workerDeps, {
        id: 2, network: NET, ask: 'governed-call', account: made.address, order, material: MATERIAL, opened,
        chain: { blockHash: '00'.repeat(32), accountState: b64((chain.contract(made.address) as any).serialize()), parameters: b64(L.LedgerParameters.initialParameters().serialize()) },
      });
      if (!a.ok || a.ask !== 'governed-call') throw new Error(a.ok ? 'another answer' : a.error);
      return a.tx;
    };
    const raise = await onTheDevice({
      circuit: 'propose', payKey, proposal: s0.round.proposal,
      half: { assetId: NO_ASSET, assetBlinding: '77'.repeat(32), proposalSalt: s0.round.salt, changeAmount: '0', changeBatchDigest: '00'.repeat(32) },
    });
    expect(await call('/api/accounts/acc_1/creation/pay-key', 'POST', { call: 'propose', tx: raise })).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    await call('/api/accounts/acc_1/creation/finish', 'POST');
    /* RED WHEN: the proposal's identity is not the one the account itself makes from the key's commitment and its salt. */
    expect(s0.committed).toBeNull();
    expect(s0.round.commitment).toBe(payKeyCommitmentOf(KEY));
    expect(s0.round.proposal).toBe(Buffer.from((accountModule as any).pureCircuits.proposalIdOf(
      Buffer.from(payKeyPayloadOf(s0.round.commitment), 'hex'), (accountModule as any).pureCircuits.noVault(), Buffer.from(s0.round.salt, 'hex'))).toString('hex'));
    /* RED WHEN: a raise is sent as anything but itself. */
    expect((await call('/api/accounts/acc_1/creation/pay-key', 'POST', { call: 'approve', tx: raise })).body.error).toMatch(/exactly one 'approve' call/);
    expect((await call('/api/accounts/acc_1/creation/pay-key', 'POST', { call: 'propose', tx: made.insert })).status).toBe(422);
    /* RED WHEN: a step already on its way is sent a second time by a second request, and paid for twice. */
    let release = () => {};
    holding = new Promise<void>((r) => { release = r; });
    const first = call('/api/accounts/acc_1/creation/pay-key', 'POST', { call: 'propose', tx: raise });
    await new Promise((r) => setTimeout(r, 200));
    expect(await call('/api/accounts/acc_1/creation/pay-key', 'POST', { call: 'propose', tx: raise }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true, error: expect.stringMatching(/being sent right now/) } });
    release();
    holding = null;
    expect(await first).toMatchObject({ status: 200 });
    expect(sent.filter((w) => w.startsWith('raising'))).toHaveLength(1);
    const s1 = await standingOnTheDevice();
    expect([s1.round.open, s1.round.approvals, s1.round.needed, s1.committed]).toEqual([true, 0, 1, null]);
    const approve = await onTheDevice({ circuit: 'approve', proposal: s0.round.proposal, of: { governance: payKey, proposalSalt: s0.round.salt } });
    expect(await call('/api/accounts/acc_1/creation/pay-key', 'POST', { call: 'approve', tx: approve })).toMatchObject({ status: 200 });
    const s2 = await standingOnTheDevice();
    expect([s2.round.approvals, s2.committed, s2.sealedMine]).toEqual([1, null, false]);
    const seal = await onTheDevice({ circuit: 'sealPayKey', wrap: s2.wrap, commitment: s0.round.commitment, proposal: s0.round.proposal, proposalSalt: s0.round.salt });
    expect(await call('/api/accounts/acc_1/creation/pay-key', 'POST', { call: 'sealPayKey', tx: seal })).toMatchObject({ status: 200 });
    const s3 = await standingOnTheDevice();
    /* RED WHEN: the account is not committed to this key, or the founding signer's copy is not read as theirs. */
    expect([s3.committed, s3.isThisKey, s3.sealedMine]).toEqual([payKeyCommitmentOf(KEY), true, true]);
    /*
     * RED WHEN: the one reader of a signer's copy, which the service's own reader calls, turns the account's address
     * into other bytes than the account's own address is: the copy read back from this deployment would not be theirs.
     */
    const roles = (accountModule as any).ledger((runtime as any).ContractState.deserialize((chain.contract(made.address) as any).serialize()).data).signerRoles;
    const parts = sealedPayKeyIn((accountModule as any).pureCircuits, roles, made.address, MATERIAL.signingSecret);
    expect(openSealedPayKey(parts!, wrapping.secret, s3.committed!)).toBe(KEY);
    expect(sealedPayKeyIn((accountModule as any).pureCircuits, roles, made.address, '5e'.repeat(32))).toBeNull();
    expect((await standing()).state).toBe('finished');
    /* RED WHEN: a step is sent for an account already committed to its key. */
    expect(await call('/api/accounts/acc_1/creation/pay-key', 'POST', { call: 'sealPayKey', tx: seal })).toMatchObject({ status: 409, body: { state: 'finished' } });
  });

  it('AN ACCOUNT\'S DEPLOY THAT WOULD START HOLDING MONEY IS REFUSED, WHATEVER ELSE IT GETS RIGHT', async () => {
    const made = await createdOnTheDevice();
    const tx = await readProvenTransaction(new Uint8Array(Buffer.from(made.deploy, 'base64'))) as any;
    const d = [...tx.intents.values()][0].actions[0];
    const state = d.initialState;
    const expectations = accountCreationExpectationsIn(ROOT);
    const expect_ = {
      foundingKey, verifierKeys: await expectations.firstKeys(), circuits: CREATION_STEPS.first,
      expectedState: await expectations.stateOf({ accountId: 'acc_1', foundingKey, foundingLeaf: LEAF, companyLabel: LABEL }),
    };
    const startingWith = (balance: Map<string, bigint>) => ({
      intents: new Map([[1, { actions: [{
        address: d.address,
        initialState: {
          maintenanceAuthority: state.maintenanceAuthority, balance, serialize: () => state.serialize(),
          operations: () => state.operations(), operation: (n: string) => state.operation(n),
        },
      }] }]]),
    });
    /* The control: the same deploy starting with nothing is this company's account. */
    expect(readAccountDeploy(startingWith(new Map()), expect_)).toEqual({ vault: made.address });
    /* RED WHEN: the account deploy's own check of its starting balance is removed. */
    expect(readAccountDeploy(startingWith(new Map([['x', 1n]])), expect_)).toMatchObject({ refusal: expect.stringMatching(/start holding money/) });
  });
});

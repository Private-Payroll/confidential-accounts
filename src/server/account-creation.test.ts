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
import { MemoryStore, accountDeployDigest } from '../core/store.js';
import type { SealedAccount } from '../core/types.js';
import { CREATION_STEPS, DEPLOYED_CIRCUITS } from '../midnight/deferral.js';
import { circuitsRefusal } from '../wiring/vault-submission.js';
import { readProvenTransaction } from '../wiring/proven-submission.js';
import { NothingWasSent } from '../core/jobs.js';
import { FeeNotPaid } from '../midnight/sponsor.js';
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
/** While set, the fee payer's lane throws this instead of sending. */
let refuseWith: Error | null;
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
  refuseWith = null;
  const app = express();
  app.use(accountCreationRoutes({
    signedIn: (req, res, next) => { if (req.headers['x-test-person'] === undefined) { res.status(401).end(); return; } (req as { userId?: string }).userId = String(req.headers['x-test-person']); next(); },
    member: (req, res, next) => { if (store.getAccount(String(req.params.id))?.memberUserIds.includes((req as { userId?: string }).userId!) !== true) { res.status(404).end(); return; } next(); },
    store,
    ledger: {
      sendVault: async (_a: string, what: string, _arrival: unknown, bytes: Uint8Array, check: (tx: unknown) => unknown, read: (b: Uint8Array) => Promise<unknown>) => {
        const refused = await check(await read(bytes));
        if (refused !== null) throw new NothingWasSent(String(refused));
        if (refuseWith !== null) throw refuseWith;
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
    expect((await call('/api/accounts/acc_1/creation')).body).toMatchObject({ state: 'not-created', account: null });
    const r = await create(made);
    expect(r).toMatchObject({ status: 201, body: { account: made.address, state: 'deploy-sent' } });
    /* RED WHEN the attempt is not recorded before it is sent, or the address is not the company's from then on. */
    expect(store.getAccountDeploy('acc_1')).toMatchObject({ address: made.address, deploy: made.deploy, insert: made.insert, foundingKey });
    expect(store.getAccount('acc_1')).toMatchObject({ contractAddress: made.address, addressSource: 'chain' });
    expect(registered).toEqual([['acc_1', made.address]]);
    expect((await call('/api/accounts/acc_1/creation')).body).toMatchObject({ state: 'finish-owed', account: made.address });
    const done = await call('/api/accounts/acc_1/creation/finish', 'POST');
    expect(done).toMatchObject({ status: 200, body: { state: 'finish-sent' } });
    /* RED WHEN: the account reads finished before it is committed to the company's pay-record key. */
    expect((await call('/api/accounts/acc_1/creation')).body).toMatchObject({ state: 'pay-key-owed', account: made.address });
    expect(sent).toEqual(['creating the company\'s account', 'finishing the company\'s account']);
    /* Finishing again sends nothing. */
    expect((await call('/api/accounts/acc_1/creation/finish', 'POST')).body).toMatchObject({ state: 'pay-key-owed' });
    expect(sent).toHaveLength(2);
  });

  /*
   * RED WHEN: a fee that was not paid reaches the page without the code that says so.
   * RED WHEN: a send whose outcome is not known carries a code a page would read as nothing lost.
   */
  it('A FEE THAT WAS NOT PAID SAYS SO WITH ITS CODE, AND ONLY WHEN NOTHING WAS SENT', async () => {
    const made = await createdOnTheDevice();
    refuseWith = new FeeNotPaid('the fee payer did not pay this fee. Nothing was sent.');
    expect(await create(made)).toMatchObject({ status: 422, body: { nothingWasSent: true, code: 'fee-not-paid' } });
    refuseWith = Object.assign(new Error('the node did not answer'), { code: 'fee-not-paid' });
    const unknown = await create(made);
    expect(unknown.status).toBe(502);
    expect(unknown.body.nothingWasSent).toBe(false);
    expect(unknown.body.code).toBeUndefined();
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

  /*
   * RED WHEN: a creation kept as digests compares the deploy only, so another second step is taken for it.
   * RED WHEN: a creation kept as digests compares the second step only, so another deploy is taken for it.
   * RED WHEN: a resuming device's repeat of the same bytes is refused once only the digests are kept.
   * RED WHEN: a company kept as digests whose chain read comes back empty reads as a deploy sent, and the repeat
   * sends the empty deploy that is all that is kept.
   */
  it('WHAT IS KEPT OF A CREATION ONCE FINISHED IS ITS DIGESTS: THE SAME BYTES ARE ANSWERED, OTHER BYTES REFUSED, AND NOTHING IS SENT FROM AN EMPTY READ', async () => {
    const made = await createdOnTheDevice();
    await create(made);
    await call('/api/accounts/acc_1/creation/finish', 'POST');
    expect(store.keepOnlyAccountDeployDigests('acc_1')).toBe(true);
    expect(store.getAccountDeploy('acc_1')).toMatchObject({
      deploy: '', insert: '', deployDigest: accountDeployDigest(made.deploy), insertDigest: accountDeployDigest(made.insert),
    });
    expect(await create(made)).toMatchObject({ status: 200, body: { account: made.address, state: 'pay-key-owed' } });
    expect(await create({ deploy: made.deploy, insert: `${made.insert}AA` }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true, account: made.address } });
    expect(await create({ deploy: `${made.deploy}AA`, insert: made.insert }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true, account: made.address } });
    readAs = null;
    const sentBefore = sent.length;
    expect((await standing()).state).toBe('unknown');
    expect((await create(made)).body.state).toBe('unknown');
    expect(sent).toHaveLength(sentBefore);
  });
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
    expect(await standing()).toMatchObject({ state: 'deploy-expired', account: made.address });
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
    expect(await standing()).toMatchObject({ state: 'finish-owed', account: made.address });
    expect((await call('/api/accounts/acc_1/creation/finish', 'POST')).body).toMatchObject({ state: 'finish-sent' });
    expect((await standing()).state).toBe('pay-key-owed');
  });

  it('A SECOND STEP THAT RAN OUT BEFORE IT WAS SENT IS CARRIED AGAIN WITH THE SAME SIGNATURE, AND NOTHING ELSE TAKES ITS PLACE', async () => {
    const made = await createdOnTheDevice();
    await create(made);
    later(36);
    /* RED WHEN: a second step past its time to live is read as one that can still be sent. */
    expect(await standing()).toMatchObject({ state: 'finish-expired', account: made.address });
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

  it('A CREATION BUILT LONG BEFORE IT IS SENT IS NEITHER RECORDED NOR SENT: THE NODE WOULD ANSWER "CUSTOM ERROR: 228" AND THE COMPANY WOULD NEVER FINISH', async () => {
    const made = await createdOnTheDevice();
    later(120);
    /* The control, with the ledger's own checks: a real deploy past its time to live is refused by the chain this test applies it to. */
    expect(() => chain.apply(new Uint8Array(Buffer.from(made.deploy, 'base64')))).toThrow(/ttl|time to live|expired/i);
    /* RED WHEN: the service records and sends a deploy or a second step that has run out, and answers 502 for what the node refuses. */
    const r = await create(made);
    expect(r).toMatchObject({ status: 422, body: { nothingWasSent: true, error: expect.stringMatching(/run out already, or is about to/) } });
    expect(store.getAccountDeploy('acc_1')).toBeNull();
    expect(store.getAccount('acc_1')).toMatchObject({ contractAddress: null });
    expect(registered).toEqual([]);
    expect(sent).toEqual([]);
    /* The same creation, built again now, is recorded and sent. */
    const again = await carriedAgain(made);
    expect(await create(again)).toMatchObject({ status: 201, body: { account: made.address, state: 'deploy-sent' } });
    expect(sent).toEqual(['creating the company\'s account']);
  });

  it('A CREATION WITH LESS THAN HALF ITS LIFE LEFT IS NOT RECORDED OR SENT EITHER, WHICHEVER OF THE TWO STEPS IT IS', async () => {
    const made = await createdOnTheDevice();
    later(20);
    /* RED WHEN: a deploy that will run out in ten minutes is sent: the service may wait that long for the fee payer. */
    expect(await create(made)).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    /* A fresh deploy with a second step that is about to run out: also refused, before either is recorded. */
    const fresh = await carriedAgain(made);
    const old = await createdOnTheDevice();
    later(22);
    const rebuilt = await carriedAgain(old);
    const mixed = { deploy: rebuilt.deploy, insert: old.insert };
    expect(await create(mixed)).toMatchObject({ status: 422, body: { nothingWasSent: true, error: expect.stringMatching(/^this second step has run out already, or is about to/) } });
    /* RED WHEN: a second step with life left carries a deploy that is about to run out through. */
    const other = { deploy: old.deploy, insert: rebuilt.insert };
    expect(await create(other)).toMatchObject({ status: 422, body: { nothingWasSent: true, error: expect.stringMatching(/^this deploy has run out already, or is about to/) } });
    expect(fresh.address).toBe(made.address);
    expect(store.getAccountDeploy('acc_1')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('A RECORDED DEPLOY THAT IS ABOUT TO RUN OUT IS NOT SENT AGAIN, AND IS CARRIED AGAIN BEFORE IT HAS', async () => {
    const made = await createdOnTheDevice();
    landing = false;
    await create(made);
    later(20);
    /* The standing still says it may land, because it was sent with time to spare. */
    expect(await standing()).toMatchObject({ state: 'deploy-sent', account: made.address });
    /* RED WHEN: a retry sends the recorded deploy with ten minutes of life left, or answers that it was sent. */
    expect(await create(made)).toMatchObject({ status: 409, body: { nothingWasSent: true, state: 'deploy-expired' } });
    expect(sent).toEqual(['creating the company\'s account']);
    /* RED WHEN: it cannot be replaced until it has run out for good, so the company waits for it. */
    const again = await carriedAgain(made);
    /* RED WHEN: a deploy built again is recorded with the second step it was recorded with, which is about to run out. */
    expect(await call('/api/accounts/acc_1/creation/again', 'POST', { deploy: again.deploy, insert: made.insert }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true, error: expect.stringMatching(/second step has run out already, or is about to/) } });
    /* RED WHEN: the deploy recorded, about to run out, is handed back in as its own replacement. */
    expect(await call('/api/accounts/acc_1/creation/again', 'POST', { deploy: made.deploy, insert: again.insert }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true, error: expect.stringMatching(/^this deploy has run out already, or is about to/) } });
    landing = true;
    expect(await call('/api/accounts/acc_1/creation/again', 'POST', { deploy: again.deploy, insert: again.insert }))
      .toMatchObject({ status: 200, body: { account: made.address, state: 'deploy-sent' } });
    expect(store.getAccountDeploy('acc_1')).toMatchObject({ deploy: again.deploy, insert: again.insert });
    expect((await standing()).state).toBe('finish-owed');
  });

  it('A RECORDED SECOND STEP THAT IS ABOUT TO RUN OUT IS NOT SENT, AND IS CARRIED AGAIN WITH THE SAME SIGNATURE', async () => {
    const made = await createdOnTheDevice();
    await create(made);
    later(5);
    const soon = await carriedAgain(made);
    later(21);
    expect(await standing()).toMatchObject({ state: 'finish-owed', account: made.address });
    /* RED WHEN: the recorded second step is sent with nine minutes of life left. */
    expect(await call('/api/accounts/acc_1/creation/finish', 'POST')).toMatchObject({ status: 409, body: { nothingWasSent: true, state: 'finish-expired' } });
    expect(sent).toEqual(['creating the company\'s account']);
    /* RED WHEN: a second step built again that has fourteen minutes left, which will not be sent, is recorded in the place of the one that ran short. */
    expect(await call('/api/accounts/acc_1/creation/finish', 'POST', { insert: soon.insert }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true, error: expect.stringMatching(/second step has run out already, or is about to/) } });
    expect(store.getAccountDeploy('acc_1')!.insert).toBe(made.insert);
    const again = await carriedAgain(made);
    expect(await call('/api/accounts/acc_1/creation/finish', 'POST', { insert: again.insert })).toMatchObject({ status: 200, body: { state: 'finish-sent' } });
    expect(store.getAccountDeploy('acc_1')).toMatchObject({ deploy: made.deploy, insert: again.insert });
    expect((await standing()).state).toBe('pay-key-owed');
  });

  it('THE STANDING SAYS WHAT THE RECORDED STEP\'S OWN TIME TO LIVE ALLOWS, AND WHAT THE TIME IS HERE, FOR A DEVICE WHOSE CLOCK IS WRONG', async () => {
    const made = await createdOnTheDevice();
    landing = false;
    later(0);
    /* Before anything is recorded there is nothing to replace. */
    expect(await standing()).toMatchObject({ state: 'not-created', replaceable: false, now: clock().toISOString() });
    await create(made);
    /* RED WHEN: a deploy with thirty minutes left is offered for replacement, so a device builds another beside it. */
    expect(await standing()).toMatchObject({ state: 'deploy-sent', replaceable: false });
    later(10);
    expect(await standing()).toMatchObject({ state: 'deploy-sent', replaceable: false, now: clock().toISOString() });
    later(12);
    /* RED WHEN: the recorded deploy is judged by when the device built it and not by its own time to live: eighteen minutes left may be replaced. */
    expect(await standing()).toMatchObject({ state: 'deploy-sent', replaceable: true, now: clock().toISOString() });
    later(36);
    expect(await standing()).toMatchObject({ state: 'deploy-expired', replaceable: true });
    landing = true;
    const again = await carriedAgain(made);
    await call('/api/accounts/acc_1/creation/again', 'POST', { deploy: again.deploy, insert: again.insert });
    /* The second step is judged on its own: owed, with the life it was built with. */
    expect(await standing()).toMatchObject({ state: 'finish-owed', replaceable: false });
    later(36 + 12);
    expect(await standing()).toMatchObject({ state: 'finish-owed', replaceable: true });
  });

  it('A REFUSAL FOR A STEP\'S TIME LEFT SAYS SO, AND WHAT THE TIME IS HERE; A REFUSAL FOR ANYTHING ELSE DOES NOT', async () => {
    const made = await createdOnTheDevice();
    /* A device whose clock is twenty minutes slow builds a deploy with ten minutes of life, by this service's clock. */
    const slow = await carriedAgain(made);
    later(20);
    const refused = await create(slow);
    /* RED WHEN: the refusal does not name its cause, so the device cannot tell a slow clock from any other refusal. */
    expect(refused).toMatchObject({ status: 422, body: { nothingWasSent: true, runsOutSoon: true, now: clock().toISOString() } });
    expect(await create({ deploy: 'AAAA', insert: 'AAAA' })).toMatchObject({ status: 422 });
    expect((await create({ deploy: 'AAAA', insert: 'AAAA' })).body.runsOutSoon).toBeUndefined();
  });

  /** The first request held in flight at the node while the second arrives: both answered once the first is let go. */
  const twoAtOnce = async <T>(first: () => Promise<T>, second: () => Promise<T>): Promise<T[]> => {
    let release!: () => void;
    holding = new Promise<void>((resolve) => { release = resolve; });
    const a = first();
    await new Promise((r) => setTimeout(r, 250));
    const b = second();
    await new Promise((r) => setTimeout(r, 250));
    release();
    return Promise.all([a, b]);
  };

  it('TWO REQUESTS AT ONCE FOR ONE COMPANY SEND ONE STEP, AND THE OTHER IS TOLD WHERE THE COMPANY STANDS', async () => {
    const made = await createdOnTheDevice();
    landing = false;
    await create(made);
    later(36);
    const one = await carriedAgain(made);
    const other = await carriedAgain(made);
    landing = true;
    /* The step-2 carry and the wallet press, both asking to carry the deploy again at the same moment. */
    const both = await twoAtOnce(
      () => call('/api/accounts/acc_1/creation/again', 'POST', { deploy: one.deploy, insert: one.insert }),
      () => call('/api/accounts/acc_1/creation/again', 'POST', { deploy: other.deploy, insert: other.insert }),
    );
    /* RED WHEN: both are sent, and the second one's fee is spent on a deploy the chain already holds. */
    expect(sent.filter((w) => w === 'creating the company\'s account, carried again')).toHaveLength(1);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const refused = both.find((r) => r.status === 409)!;
    expect(refused.body).toMatchObject({ nothingWasSent: true, account: made.address });
    expect(refused.body.state).toEqual(expect.any(String));
    /* Released with the answer: a request after both is answered on its own merits, not as one at once. */
    expect(await call('/api/accounts/acc_1/creation/finish', 'POST')).toMatchObject({ status: 200, body: { state: 'finish-sent' } });
  });

  it('TWO FINISHING SENDS AT ONCE SEND THE SECOND STEP ONCE, AND A SEND THAT HAS ENDED LEAVES THE NEXT FREE', async () => {
    const made = await createdOnTheDevice();
    await create(made);
    const both = await twoAtOnce(
      () => call('/api/accounts/acc_1/creation/finish', 'POST'),
      () => call('/api/accounts/acc_1/creation/finish', 'POST'),
    );
    /* RED WHEN: the second step is sent twice, the second landing nowhere and costing a fee. */
    expect(sent.filter((w) => w === 'finishing the company\'s account')).toHaveLength(1);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    /* RED WHEN: a send that failed leaves the company locked, so that nothing can ever be sent for it again. */
    expect((await call('/api/accounts/acc_1/creation/finish', 'POST')).status).toBe(200);
  });

  it('THE DEVICE\'S WORKER BUILDS BY THE CLOCK IT IS TOLD OF: A STEP FOR A TAB WHOSE CLOCK IS SLOW LIVES THE FULL THIRTY MINUTES BY THE SERVICE\'S', async () => {
    const made = await createdOnTheDevice();
    const lifeOf = async (over: { clockOffsetMs?: number }) => {
      const a = await answerVaultAsk(workerDeps, { id: 3, network: NET, ask: 'creation-again', deploy: made.deploy, insert: made.insert, ...over });
      if (!a.ok || a.ask !== 'creation-again') throw new Error(a.ok ? 'another answer' : a.error);
      const tx = deviceCallOrProven(new Uint8Array(Buffer.from(a.deploy, 'base64'))) as { intents: Map<unknown, { ttl: Date }> };
      return ([...tx.intents.values()][0]!.ttl.getTime() - Date.now()) / 60_000;
    };
    /* A tab whose clock is twenty-five minutes behind builds by the service's: its offset is what the service measured. */
    const slow = await lifeOf({ clockOffsetMs: 25 * 60_000 });
    /* RED WHEN: the worker builds by its own clock whatever it is told, so a slow tab builds steps with five minutes of life. */
    expect(slow).toBeGreaterThan(54);
    expect(slow).toBeLessThan(56);
    expect(await lifeOf({})).toBeGreaterThan(29);
    expect(await lifeOf({})).toBeLessThan(31);
    /* RED WHEN: an offset that is not a number moves the clock. */
    expect(await lifeOf({ clockOffsetMs: 'soon' as unknown as number })).toBeLessThan(31);
  });

  it('THE MARGINS: A RECORDED DEPLOY IS SENT AGAIN WITH SEVENTEEN MINUTES LEFT AND NOT WITH FOURTEEN, AND IS REPLACED ONLY FROM EIGHTEEN', async () => {
    const made = await createdOnTheDevice();
    landing = false;
    await create(made);
    later(10);
    /* RED WHEN: a deploy with twenty minutes left is replaced, so two are on their way. */
    const early = await carriedAgain(made);
    expect(await call('/api/accounts/acc_1/creation/again', 'POST', { deploy: early.deploy, insert: early.insert }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true, state: 'deploy-sent' } });
    later(13);
    /* RED WHEN: a deploy with seventeen minutes left is refused: the device and the service would not agree on when to build it again. */
    expect(await create(made)).toMatchObject({ status: 200, body: { state: 'deploy-sent' } });
    expect(sent).toHaveLength(2);
    later(16);
    /* RED WHEN: a deploy with fourteen minutes left is sent. */
    expect(await create(made)).toMatchObject({ status: 409, body: { nothingWasSent: true, state: 'deploy-expired' } });
    expect(sent).toHaveLength(2);
    /* The device builds it again below seventeen, and the service lets it be replaced from eighteen. */
    later(12);
    const again = await carriedAgain(made);
    expect(await call('/api/accounts/acc_1/creation/again', 'POST', { deploy: again.deploy, insert: again.insert })).toMatchObject({ status: 200 });
  });

  it('THE MARGINS FOR THE SECOND STEP: IT IS REPLACED ONLY FROM EIGHTEEN MINUTES LEFT, AND SENT AS RECORDED TO THE LAST', async () => {
    const made = await createdOnTheDevice();
    await create(made);
    later(10);
    /* RED WHEN: a second step with twenty minutes left is replaced, so two signed steps for one account are on their way. */
    const early = await carriedAgain(made);
    expect(await call('/api/accounts/acc_1/creation/finish', 'POST', { insert: early.insert }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true, error: expect.stringMatching(/can still land, so it is not replaced/) } });
    later(12);
    /* RED WHEN: a second step with eighteen minutes left, which the device builds again, is refused when it is handed in. */
    const again = await carriedAgain(made);
    expect(await call('/api/accounts/acc_1/creation/finish', 'POST', { insert: again.insert })).toMatchObject({ status: 200, body: { state: 'finish-sent' } });
    expect(store.getAccountDeploy('acc_1')!.insert).toBe(again.insert);
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
    /* RED WHEN: a finished account's deploy and second step are still kept as bytes. */
    expect(store.getAccountDeploy('acc_1')).toMatchObject({
      deploy: '', insert: '', deployDigest: accountDeployDigest(made.deploy), insertDigest: accountDeployDigest(made.insert),
    });
    /* RED WHEN: a resuming device's repeat of the same finished creation is refused once only the digests are kept. */
    expect(await create(made)).toMatchObject({ status: 200, body: { account: made.address, state: 'finished' } });
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

  it('AN ACCOUNT\'S DEPLOY HELD BY THE FOUNDING KEY IS READ, WRITTEN IN LOWER CASE OR IN UPPER CASE', async () => {
    const made = await createdOnTheDevice();
    const tx = await readProvenTransaction(new Uint8Array(Buffer.from(made.deploy, 'base64'))) as any;
    const d = [...tx.intents.values()][0].actions[0];
    const state = d.initialState;
    const expectations = accountCreationExpectationsIn(ROOT);
    const expect_ = {
      foundingKey, verifierKeys: await expectations.firstKeys(), circuits: CREATION_STEPS.first,
      expectedState: await expectations.stateOf({ accountId: 'acc_1', foundingKey, foundingLeaf: LEAF, companyLabel: LABEL }),
    };
    const held = (key: (k: { tag: string; value: string }) => unknown, authority: Record<string, unknown> = {}) => ({
      intents: new Map([[1, { actions: [{
        address: d.address,
        initialState: {
          maintenanceAuthority: {
            committee: [key(state.maintenanceAuthority.committee[0])], threshold: state.maintenanceAuthority.threshold,
            counter: state.maintenanceAuthority.counter, ...authority,
          },
          balance: new Map(), serialize: () => state.serialize(),
          operations: () => state.operations(), operation: (n: string) => state.operation(n),
        },
      }] }]]),
    });
    const plain = (k: { tag: string; value: string }) => ({ tag: k.tag, value: k.value });
    /* The control: the same key written as plain strings is the founding signer's account. */
    expect(readAccountDeploy(held(plain), expect_)).toEqual({ vault: made.address });
    /* RED WHEN: the digits of a key are compared as written, so the founding key in upper case is not the founding key. */
    expect(readAccountDeploy(held((k) => ({ tag: k.tag, value: k.value.toUpperCase() })), expect_)).toEqual({ vault: made.address });
  });
});

/* These refuse before any verifying key or compiled state is looked at, so they run on a checkout with no keys. */
describe('AN ACCOUNT\'S DEPLOY IS REFUSED UNLESS ITS AUTHORITY IS THE FOUNDING SIGNER\'S KEY ALONE, NEVER CHANGED', () => {
  const KEY = { tag: 'schnorr', value: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' };
  const expect_ = { foundingKey: KEY, verifierKeys: new Map<string, Uint8Array>(), circuits: [], expectedState: new Uint8Array() };
  const refusedAsAuthority = /held by its founding signer's own key alone/;
  const deployHeldBy = (committee: unknown[], counter: unknown = 0n, threshold = 1) => ({
    intents: new Map([[1, { actions: [{
      address: 'ab'.repeat(32),
      initialState: { maintenanceAuthority: { committee, threshold, counter }, balance: new Map(), serialize: () => new Uint8Array() },
    }] }]]),
  });
  const refusal = (tx: unknown): string => {
    const r = readAccountDeploy(tx, expect_ as never);
    return 'refusal' in r ? r.refusal : '';
  };

  it('refuses a founding key whose kind or digits are not plain strings, and a counter that is not a bigint of zero', () => {
    /* RED WHEN: the account's authority is read by anything but `authorityIn`, so a key whose parts are not plain strings is taken. */
    expect(refusal(deployHeldBy([{ tag: new String(KEY.tag), value: KEY.value }]))).toMatch(refusedAsAuthority);
    expect(refusal(deployHeldBy([{ tag: KEY.tag, value: new String(KEY.value) }]))).toMatch(refusedAsAuthority);
    /* RED WHEN: a counter that is not a bigint of zero is taken for an account never changed. */
    expect(refusal(deployHeldBy([KEY], 1n))).toMatch(refusedAsAuthority);
    expect(refusal(deployHeldBy([KEY], 0))).toMatch(refusedAsAuthority);
    /* RED WHEN: a key written with a prefix, or a threshold other than one, is taken for the founding key alone. */
    expect(refusal(deployHeldBy([{ tag: KEY.tag, value: '0x' + KEY.value }]))).toMatch(refusedAsAuthority);
    expect(refusal(deployHeldBy([KEY], 0n, 2))).toMatch(refusedAsAuthority);
  });

  it('does not refuse the founding key written in upper case as another authority', () => {
    /* RED WHEN: the digits of a key are compared as written, so the founding key in upper case is not the founding key. */
    expect(refusal(deployHeldBy([KEY]))).not.toMatch(refusedAsAuthority);
    expect(refusal(deployHeldBy([{ tag: KEY.tag, value: KEY.value.toUpperCase() }]))).not.toMatch(refusedAsAuthority);
  });
});

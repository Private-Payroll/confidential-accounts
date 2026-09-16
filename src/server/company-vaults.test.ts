import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../core/store.js';
import type { SealedAccount } from '../core/types.js';
import { NothingWasSent } from '../core/jobs.js';
import { companyCommittee, companyVaultRoutes, vaultState, type CompanyVaultDeps } from './company-vaults.js';

/*
 * The company-vault routes' own refusals, with the chain and the fee payer
 * stood in. The whole path, with the ledger's own state machine, is
 * `contracts/test/a-company-vault-from-the-page.test.ts`.
 */
const key = (n: number) => ({ tag: 'schnorr' as const, value: n.toString(16).padStart(2, '0').repeat(32) });
const hex = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const VAULT = hex(0xab);

let server: ReturnType<express.Express['listen']>;
let base: string;
let store: MemoryStore;
let sent: string[];
let authority: unknown;
let sendVault: CompanyVaultDeps['ledger']['sendVault'];
let deployShape = false;
/* The verifying keys the chain shows for the vault; a test changes one to stand for a vault whose proofs were swapped. */
let circuitKeys: (c: string) => Uint8Array;
/* The account the vault's ledger names on the chain now. */
let pinnedNow: string;
const CIRCUITS = ['deposit', 'depositUnshielded', 'forgetUnshielded', 'payout', 'payoutUnshielded', 'retire', 'splitNote'];
/* The company account: its own circuits, its own authority, and its own verifying keys, apart from the vault's. */
const ACCOUNT_CIRCUITS = ['approve', 'propose', 'recordPayment'];
const ACCOUNTS = new Set([hex(0xc0), hex(0xc1)]);
let accountAuthority: unknown;
let accountKeys: (c: string) => Uint8Array;
let accountUnreachable = false;
let handoverDep: CompanyVaultDeps['account']['handover'];
let serviceKey: { tag: string; value: string } | undefined;
let acc1Threshold = 2;
let handoverShape: unknown;
const vkOf = (c: string) => new TextEncoder().encode(`vk:${c}`);
const aDeploy = () => ({
  intents: new Map([[1, { actions: [{
    address: VAULT,
    initialState: {
      maintenanceAuthority: { committee: [key(9)], threshold: 1, counter: 0n },
      operations: () => CIRCUITS,
      operation: (c: string) => ({ verifierKey: vkOf(c) }),
    },
  }] }]]),
});

const account = (over: Partial<SealedAccount> = {}): SealedAccount => ({
  id: 'acc_1', createdAt: '', keyEpoch: 0, threshold: 2, signerCount: 2, memberUserIds: ['ada', 'bo'],
  pendingSigners: [], wrappedKeys: [], inboxPublicKey: '', ...over,
} as unknown as SealedAccount);

beforeEach(async () => {
  store = new MemoryStore();
  store.putAccount(account());
  store.putAccount(account({ id: 'acc_2', memberUserIds: ['carol'] }));
  sent = [];
  authority = { committee: [key(9)], threshold: 1, counter: 0n };
  circuitKeys = vkOf;
  /* By default the account is already the committee's, so a test about a vault is about the vault. */
  accountAuthority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
  accountKeys = vkOf;
  accountUnreachable = false;
  handoverDep = undefined;
  serviceKey = undefined;
  acc1Threshold = 2;
  handoverShape = {};
  pinnedNow = hex(0xc0);
  sendVault = async (_a, what) => { sent.push(what); return { ref: 'r', at: 'now', transactionHash: 'h' }; };
  const app = express();
  app.use(companyVaultRoutes({
    signedIn: (req, res, next) => {
      const p = req.headers['x-test-person'];
      if (typeof p !== 'string') { res.status(401).json({ error: 'not signed in' }); return; }
      (req as { userId?: string }).userId = p; next();
    },
    member: (req, res, next) => {
      const a = store.getAccount(String(req.params.id));
      if (!a?.memberUserIds.includes((req as { userId?: string }).userId!)) { res.status(404).json({ error: 'account not found' }); return; }
      next();
    },
    store,
    company: async (id) => (id === 'acc_1' ? { address: hex(0xc0), threshold: acc1Threshold } : { address: hex(0xc1), threshold: 1 }),
    ledger: { get sendVault() { return sendVault; } },
    chain: {
      contractState: async (address) => {
        if (ACCOUNTS.has(address)) {
          if (accountUnreachable) throw new Error('the indexer did not answer');
          return {
            maintenanceAuthority: accountAuthority, serialize: () => new Uint8Array([8]),
            operations: () => ACCOUNT_CIRCUITS, operation: (c: string) => ({ verifierKey: accountKeys(c) }),
          };
        }
        return {
          maintenanceAuthority: authority, serialize: () => new Uint8Array([7]),
          operations: () => CIRCUITS, operation: (c: string) => ({ verifierKey: circuitKeys(c) }),
        };
      },
      serialize: (s) => (s as { serialize(): Uint8Array }).serialize(),
      notesOf: () => [],
      startingLedgerOf: () => ({ account: pinnedNow, notes: 0n, unshieldedTokens: 0n, payments: 0n, spendingCaps: 0n }),
      everCreated: async () => new Set(),
    },
    verifierKeys: async () => new Map(CIRCUITS.map((c) => [c, vkOf(c)])),
    account: {
      circuits: ACCOUNT_CIRCUITS,
      verifierKeys: async () => new Map(ACCOUNT_CIRCUITS.map((c) => [c, vkOf(c)])),
      get handover() { return handoverDep; },
      get temporaryKey() { return serviceKey; },
    },
    readers: {
      proven: async (b) => (b[0] === 0xee ? handoverShape : deployShape ? aDeploy() : {}),
      finished: async () => ({}),
    },
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

const call = async (path: string, as: string | null, method = 'GET', body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(as === null ? {} : { 'x-test-person': as }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const give = (as: string, n: number, over: Record<string, unknown> = {}) => call('/api/accounts/acc_1/vault-keys', as, 'PUT', {
  committeeKey: key(n), recordsKey: hex(n + 0x10), filingKey: hex(n + 0x20), ...over,
});

describe('A SIGNER\'S VAULT KEYS', () => {
  it('are given once, and the same keys again change nothing', async () => {
    expect((await give('ada', 1)).status).toBe(201);
    expect((await give('ada', 1)).status).toBe(200);
    expect(store.getVaultKeys('acc_1', 'ada')!.filingKey).toBe(hex(0x21));
  });

  it('A DIFFERENT SET FROM THE SAME PERSON IS REFUSED, AND THE FIRST IS KEPT', async () => {
    await give('ada', 1);
    const r = await give('ada', 2);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/different wallet or seat/);
    expect(store.getVaultKeys('acc_1', 'ada')!.committeeKey).toEqual(key(1));
    expect((await give('ada', 1, { filingKey: hex(0x99) })).status).toBe(409);
  });

  it('refuses anything that is not three public keys, a non-member and nobody signed in', async () => {
    expect((await give('ada', 1, { committeeKey: { tag: 'ecdsa', value: hex(1) } })).status).toBe(400);
    expect((await give('ada', 1, { recordsKey: 'AB'.repeat(32) })).status).toBe(400);
    expect((await give('ada', 1, { signingSecret: hex(1) })).status).toBe(400);
    expect((await give('carol', 1)).status).toBe(404);
    expect((await call('/api/accounts/acc_1/vault-keys', null, 'PUT', {})).status).toBe(401);
    expect(store.getVaultKeys('acc_1', 'carol')).toBeNull();
  });

  it('the committee is complete only when every signer has given a key', async () => {
    await give('ada', 1);
    let k = await call('/api/accounts/acc_1/vault-keys', 'ada');
    expect(k.body.committee).toBeNull();
    expect(k.body.why).toMatch(/1 of this company's 2 signers has not/);
    expect(k.body.mine).toEqual({ committeeKey: key(1), recordsKey: hex(0x11), filingKey: hex(0x21) });
    await give('bo', 2);
    k = await call('/api/accounts/acc_1/vault-keys', 'ada');
    expect(k.body.committee).toEqual({ committee: [key(1), key(2)], threshold: 2 });
    expect(k.body.readers.sort()).toEqual([hex(0x11), hex(0x12)]);
  });

  it('a seeded signer with no person behind them leaves the committee incomplete', () => {
    const r = companyCommittee(account({ memberUserIds: ['ada'], signerCount: 2 }), 1, () => ({
      accountId: 'acc_1', userId: 'ada', committeeKey: key(1), recordsKey: hex(1), filingKey: hex(1), givenAt: '',
    }));
    expect(r.committee).toBeNull();
    expect(r.why).toMatch(/1 of this company's 2 signers/);
  });
});

describe('A VAULT\'S ROUTES', () => {
  it('NO COMMITTEE, NO DEPLOY: refused before anything is read or sent', async () => {
    await give('ada', 1);
    const r = await call('/api/accounts/acc_1/vaults', 'ada', 'POST', { tx: 'AAAA' });
    expect(r).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(sent).toEqual([]);
  });

  it('refuses a request with no transaction, or one past the limit', async () => {
    expect((await call('/api/accounts/acc_1/vaults', 'ada', 'POST', {})).status).toBe(400);
    expect((await call('/api/accounts/acc_1/vaults', 'ada', 'POST', { tx: 'A'.repeat(1_000_001) })).status).toBe(400);
  });

  it('A VAULT THIS COMPANY DID NOT CREATE IS NOT THIS COMPANY\'S, WHOEVER ASKS', async () => {
    store.putCompanyVault({ accountId: 'acc_2', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [], threshold: 1 } });
    for (const path of [`/api/accounts/acc_1/vaults/${VAULT}/chain`]) {
      expect((await call(path, 'ada')).status).toBe(404);
    }
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' })).status).toBe(404);
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/handover`, 'ada', 'POST', { tx: 'AAAA' })).status).toBe(404);
    expect((await call(`/api/accounts/acc_2/vaults/${VAULT}/chain`, 'ada')).status).toBe(404);
    expect(sent).toEqual([]);
  });

  it('NO DEPOSIT WHILE THE CHAIN SAYS THE COMMITTEE DOES NOT HOLD THE VAULT, whatever the record says', async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 } });
    const refused = await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });
    expect(refused).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(refused.body.error).toMatch(/finish handing it to the committee first/);
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows).toEqual([
      expect.objectContaining({ vault: VAULT, state: 'handover-owed' }),
    ]);
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    const paid = await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });
    expect(paid).toMatchObject({ status: 200, body: { txRef: 'r', transactionHash: 'h' } });
    expect(sent).toEqual(['a deposit into a vault']);
    authority = undefined;
    const unread = await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });
    expect(unread).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('unknown');
  });

  it('NO DEPOSIT INTO A VAULT WHOSE PROOFS ON THE CHAIN ARE NOT THIS BUILD\'S, even when the committee holds it', async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 } });
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    /* The key it was created with swapped one circuit in the handover itself. */
    circuitKeys = (c) => (c === 'payout' ? new TextEncoder().encode('vk:someone else') : vkOf(c));
    const refused = await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });
    expect(refused).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(refused.body.error).toMatch(/'payout' circuit is not the one this service's build compiled/);
    const view = await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada');
    expect(view.body).toMatchObject({ heldByCommittee: false });
    expect(view.body.why).toMatch(/'payout' circuit/);
    expect(sent).toEqual([]);
  });

  it('NO DEPOSIT INTO A VAULT CHANGED MORE THAN ONCE, OR NOW PINNED ELSEWHERE, though the chain shows the committee and this build', async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 } });
    const refusedEverywhere = async (pattern: RegExp) => {
      const refused = await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });
      expect(refused).toMatchObject({ status: 409, body: { nothingWasSent: true } });
      expect(refused.body.error).toMatch(pattern);
      const view = await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada');
      expect(view.body).toMatchObject({ heldByCommittee: false });
      expect(view.body.why).toMatch(pattern);
      expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows).toEqual([
        expect.objectContaining({ vault: VAULT, state: 'not-fundable', why: expect.stringMatching(pattern) }),
      ]);
    };
    /* A circuit swapped, used, and put back before the committee was installed: three changes, not one. */
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 3n };
    await refusedEverywhere(/changed 3 times/);
    /* One change, but the ledger now names an account that is not the company's. */
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    pinnedNow = hex(0xd0);
    await refusedEverywhere(/pinned to an account other than the company's/);
    expect(sent).toEqual([]);
    pinnedNow = hex(0xc0);
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('held-by-committee');
  });

  it('a deployment that cannot send says so, and a send that may have landed is not marked as nothing sent', async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [], threshold: 2 } });
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    sendVault = undefined;
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' }))
      .toMatchObject({ status: 503, body: { nothingWasSent: true } });
    sendVault = async () => { throw new Error('the node did not answer'); };
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' }))
      .toMatchObject({ status: 502, body: { nothingWasSent: false } });
    sendVault = async () => { throw new NothingWasSent('refused. Nothing was sent.'); };
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true } });
  });

  it('A DEPLOY THAT MAY HAVE LANDED IS STILL RECORDED, SO SOMEBODY CAN HAND IT OVER; ONE REFUSED IS NOT', async () => {
    await give('ada', 1); await give('bo', 2);
    sendVault = async (_a, what, _arr, bytes, check, read) => {
      const refusal = await check(await read(bytes));
      if (refusal !== null) throw new NothingWasSent(refusal);
      sent.push(what);
      throw new Error('the node did not answer');
    };
    deployShape = true;
    const r = await call('/api/accounts/acc_1/vaults', 'ada', 'POST', { tx: 'AAAA' });
    expect(r).toMatchObject({ status: 502, body: { nothingWasSent: false } });
    expect(store.listCompanyVaults('acc_1')).toEqual([
      expect.objectContaining({ vault: VAULT, deployRef: 'unknown', intended: { committee: [key(1), key(2)], threshold: 2 } }),
    ]);
    /* The same vault again is refused before anything is sent. */
    const again = await call('/api/accounts/acc_1/vaults', 'ada', 'POST', { tx: 'AAAA' });
    expect(again).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    expect(again.body.error).toMatch(/already recorded/);
    expect(sent).toEqual(['deploying a vault']);
    /* A deploy the check refuses records nothing. */
    deployShape = false;
    store = new MemoryStore();
  });
});

describe('THE COMPANY ACCOUNT STANDS BEHIND EVERY VAULT', () => {
  const vaultHeld = async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 } });
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
  };
  const deposit = () => call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });

  it('NO MONEY GOES INTO A VAULT THE COMMITTEE HOLDS WHILE THE ACCOUNT IS STILL HELD BY ITS TEMPORARY KEY', async () => {
    /* RED WHEN: the account check at the end of `whyNotFunded` is removed - the first deposit is then paid for,
     * `sent` carries it, and the row reads 'held-by-committee' over an account one machine's key can drain. */
    await vaultHeld();
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    const refused = await deposit();
    expect(refused).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(refused.body.error).toMatch(/account is still held by the temporary key it was created with/);
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows).toEqual([
      expect.objectContaining({ vault: VAULT, state: 'account-not-handed-over', why: expect.stringMatching(/temporary key/) }),
    ]);
    /* The vault's own handover is finished, and a device waiting on it must be told so; the money is what waits. */
    const view = await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada');
    expect(view.body).toMatchObject({ heldByCommittee: true, fundable: false });
    expect(view.body.why).toMatch(/temporary key/);
    expect(sent).toEqual([]);
  });

  it('NOR WHILE THE ACCOUNT IS HELD BY OTHER KEYS, HAS CHANGED MORE THAN ONCE, RUNS OTHER CIRCUITS, OR CANNOT BE READ', async () => {
    /* RED WHEN, one per step: `accountFundingRefusal` answers `null` on a disagreeing authority; its counter test is
     * removed; `whyAccountNotReady` stops comparing the account's circuits; an unreachable account is read as ready. */
    await vaultHeld();
    accountAuthority = { committee: [key(1), key(3)], threshold: 2, counter: 1n };
    expect((await deposit()).body.error).toMatch(/not held by the company's committee on the chain/);
    accountAuthority = { committee: [key(1), key(2)], threshold: 2, counter: 2n };
    expect((await deposit()).body.error).toMatch(/changed 2 times/);
    accountAuthority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    accountKeys = (c) => (c === 'recordPayment' ? new TextEncoder().encode('vk:drain') : vkOf(c));
    expect((await deposit()).body.error).toMatch(/'recordPayment' circuit is not the one this service's build compiled/);
    /* An account as deployed but running circuits this build did not compile is an alarm, not a step not yet taken. */
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    expect((await deposit()).body.error).toMatch(/temporary key/);
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('account-not-fundable');
    accountAuthority = { committee: [key(1), key(2)], threshold: 2, counter: 2n };
    accountKeys = vkOf;
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('account-not-fundable');
    /* One key, never changed, and not this service's: somebody else holds the account, which is not a step not yet taken.
     * RED WHEN: the "as deployed" test stops comparing the key with this service's own. */
    serviceKey = key(9);
    accountAuthority = { committee: [key(8)], threshold: 1, counter: 0n };
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('account-not-fundable');
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('account-not-handed-over');
    serviceKey = undefined;
    accountAuthority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    accountUnreachable = true;
    expect((await deposit()).body.error).toMatch(/could not be (asked|read)/);
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('unknown');
    expect(sent).toEqual([]);
    accountUnreachable = false;
    expect(await deposit()).toMatchObject({ status: 200 });
    expect(sent).toEqual(['a deposit into a vault']);
  });

  it('A VAULT HELD BY A COMMITTEE THE COMPANY NO LONGER HAS IS NOT SHOWN AS A HANDOVER ANYBODY HERE CAN FINISH', async () => {
    /* RED WHEN: `vaultState` answers 'handover-owed' for any authority that is not the committee - the row then
     * offers a button the service refuses, and says nothing about who still holds the vault. */
    await vaultHeld();
    authority = { committee: [key(1)], threshold: 1, counter: 1n };
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('held-by-other-keys');
    const read = (a: { committee: { tag: string; value: string }[]; threshold: number; counter: bigint; shape: string }) =>
      ({ state: 'read', address: VAULT, authority: { ...a, hasDuplicateMembers: false } }) as never;
    expect(vaultState(read({ committee: [key(9)], threshold: 1, counter: 0n, shape: 'one-key' }), { heldByOthers: true })).toBe('handover-owed');
    expect(vaultState(read({ committee: [key(9)], threshold: 1, counter: 1n, shape: 'one-key' }), { heldByOthers: true })).toBe('held-by-other-keys');
    expect(vaultState(read({ committee: [key(1), key(3)], threshold: 2, counter: 1n, shape: 'committee' }), { heldByOthers: true })).toBe('held-by-other-keys');
    expect(vaultState({ state: 'absent', address: VAULT, why: '' }, { heldByOthers: true })).toBe('not-on-chain-yet');
  });

  it('SETTINGS SHOWS EVERY CONTRACT\'S SEATS FROM THE CHAIN, WHO HOLDS EACH, AND A SEAT HELD BY SOMEBODY NOT ON THE COMPANY', async () => {
    /* RED WHEN: `authorityView` stops counting seats outside the committee - `seatsOutsideTheCommittee` reads 0 for
     * the vault and its sentence stops naming the seat - or a seat's holder is taken from anything but the keys given. */
    await vaultHeld();
    authority = { committee: [key(1), key(3)], threshold: 2, counter: 1n };
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    handoverDep = async () => new Uint8Array([0xee]);
    serviceKey = key(9);
    const r = await call('/api/accounts/acc_1/authority', 'ada');
    expect(r.status).toBe(200);
    expect(r.body.company).toEqual({ address: hex(0xc0), threshold: 2, signerCount: 2 });
    const [acct, vault] = r.body.contracts;
    expect(acct).toMatchObject({ contract: 'account', heldByTheCompany: false, shape: 'one-key', changes: '0', seatsOutsideTheCommittee: 1 });
    expect(vault).toMatchObject({ contract: 'vault', heldByTheCompany: false, threshold: 2, seatsOutsideTheCommittee: 1 });
    expect(vault.seats).toEqual([
      { key: key(1), holder: 'ada', thisService: false, onTheCompanysCommittee: true, you: true },
      { key: key(3), holder: null, thisService: false, onTheCompanysCommittee: false, you: false },
    ]);
    expect(vault.why).toMatch(/1 seat\(s\) on this vault are held by a key that is not on the company's committee/);
    /* RED WHEN: the service's own key is not passed to the view - the seat then reads as nobody's. */
    expect(acct.seats[0]).toMatchObject({ key: key(9), thisService: true });
    expect(acct.why).toMatch(/THIS SERVICE'S temporary key holds this account's rules/);
    expect(r.body.handover).toMatchObject({ possible: true, why: null });
    expect(r.body.handover.permanent).toMatch(/a signer who leaves keeps their seat/);
    expect(r.body.change.possible).toBe(false);
    expect(r.body.change.why).toMatch(/sign the change in their own wallets/);
    /* Two signers at a threshold of two: losing either one strands the money, and the company is told. */
    expect(r.body.everySignerNeeded).toMatch(/Every one of this company's 2 signers/);
    expect((await call('/api/accounts/acc_1/authority', 'carol')).status).toBe(404);
    expect(sent).toEqual([]);
  });

  it('THE ACCOUNT IS HANDED OVER ONLY WHEN THE CHECK THE SERVICE APPLIES TO A STRANGER PASSES', async () => {
    /* RED WHEN: the handover route sends without `refusalForHandover` - the wrong-committee transaction is then
     * paid for and `sent` carries it. */
    await give('ada', 1); await give('bo', 2);
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    const path = '/api/accounts/acc_1/authority/handover';
    const checked = { committee: { committee: [key(1), key(2)], threshold: 2 } };
    expect(await call(path, 'ada', 'POST', checked)).toMatchObject({ status: 503, body: { nothingWasSent: true } });
    handoverDep = async () => new Uint8Array([0xee]);
    sendVault = async (_a, what, _arr, bytes, check, readBytes) => {
      const refusal = await check(await readBytes(bytes));
      if (refusal !== null) throw new NothingWasSent(refusal);
      sent.push(what);
      return { ref: 'r', at: 'now', transactionHash: 'h' };
    };
    const handoverTo = (committee: unknown[], threshold: number) => ({
      intents: new Map([[1, { actions: [{
        address: hex(0xc0), counter: 0n, signatures: [[0n, key(7)]],
        updates: [{ authority: { committee, threshold, counter: 1n } }],
      }] }]]),
    });
    handoverShape = handoverTo([key(1), key(3)], 2);
    /* RED WHEN: the route installs its own committee instead of refusing one the device did not check. */
    const unchecked = await call(path, 'ada', 'POST', { committee: { committee: [key(1), key(3)], threshold: 2 } });
    expect(unchecked).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(unchecked.body.error).toMatch(/committee your device checked is not the one/);
    expect((await call(path, 'ada', 'POST', {})).body.error).toMatch(/committee your device checked/);
    const wrong = await call(path, 'ada', 'POST', checked);
    expect(wrong).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    expect(wrong.body.error).toMatch(/not this company's committee/);
    expect(sent).toEqual([]);
    /* A builder that refuses sends nothing. */
    const builds = handoverDep;
    handoverDep = async () => { throw new Error('this company\'s account has already had its rules changed'); };
    expect(await call(path, 'ada', 'POST', checked)).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    handoverDep = builds;
    handoverShape = handoverTo([key(1), key(2)], 2);
    expect(await call(path, 'ada', 'POST', checked)).toMatchObject({ status: 200, body: { state: 'handover-sent' } });
    expect(sent).toEqual(['handing the company account to its committee']);
    /* RED WHEN: the pending-handover guard is removed - a second copy is then paid for and `sent` holds two. */
    const again = await call(path, 'bo', 'POST', checked);
    expect(again).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(again.body.error).toMatch(/has not shown it yet/);
    expect((await call('/api/accounts/acc_1/authority', 'ada')).body.handover).toMatchObject({ possible: false, why: expect.stringMatching(/has not shown it yet/) });
    expect(sent).toHaveLength(1);
  });

  it('TWO PRESSES AT ONCE ARE ONE HANDOVER, AND ONE THAT MAY HAVE LANDED IS NOT SENT AGAIN', async () => {
    /* RED WHEN: the pending mark is set after the first wait instead of before it - both presses are then paid for;
     * or when a send that may have landed does not keep the mark - the second press is then paid for. */
    await give('ada', 1); await give('bo', 2);
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    const checked = { committee: { committee: [key(1), key(2)], threshold: 2 } };
    const path = '/api/accounts/acc_1/authority/handover';
    handoverDep = async () => { await new Promise((r) => setTimeout(r, 40)); return new Uint8Array([0xee]); };
    handoverShape = {
      intents: new Map([[1, { actions: [{
        address: hex(0xc0), counter: 0n, signatures: [[0n, key(7)]],
        updates: [{ authority: { committee: [key(1), key(2)], threshold: 2, counter: 1n } }],
      }] }]]),
    };
    sendVault = async (_a, what, _arr, bytes, check, readBytes) => {
      const refusal = await check(await readBytes(bytes));
      if (refusal !== null) throw new NothingWasSent(refusal);
      sent.push(what);
      throw new Error('the node did not answer');
    };
    const both = await Promise.all([call(path, 'ada', 'POST', checked), call(path, 'bo', 'POST', checked)]);
    expect(both.map((r) => r.status).sort()).toEqual([409, 502]);
    expect(sent).toHaveLength(1);
    const later = await call(path, 'ada', 'POST', checked);
    expect(later).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(later.body.error).toMatch(/has not shown it yet/);
    expect(sent).toHaveLength(1);
  });

  it('NOT WHILE ONE SIGNER COULD ACT ALONE AND ANOTHER COULD LEAVE', async () => {
    /* RED WHEN: `whyNotYet` is removed from the route or from the settings answer. */
    await give('ada', 1); await give('bo', 2);
    acc1Threshold = 1;
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    handoverDep = async () => { throw new Error('must not be reached'); };
    const r = await call('/api/accounts/acc_1/authority/handover', 'ada', 'POST', { committee: { committee: [key(1), key(2)], threshold: 1 } });
    expect(r).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(r.body.error).toMatch(/any one of them can approve alone.*Raise the threshold to at least two/s);
    expect((await call('/api/accounts/acc_1/authority', 'ada')).body.handover).toMatchObject({
      possible: false, why: expect.stringMatching(/approve alone/),
    });
    expect(sent).toEqual([]);
  });

  it('NO COMMITTEE, NO ACCOUNT HANDOVER', async () => {
    await give('ada', 1);
    handoverDep = async () => { throw new Error('must not be reached'); };
    const r = await call('/api/accounts/acc_1/authority/handover', 'ada', 'POST', {});
    expect(r).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(r.body.error).toMatch(/1 of this company's 2 signers has not/);
  });
});

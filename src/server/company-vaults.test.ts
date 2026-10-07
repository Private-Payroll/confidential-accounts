import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../core/store.js';
import type { SealedAccount } from '../core/types.js';
import { NothingWasSent } from '../core/jobs.js';
import { companyCommittee, companyVaultRoutes, vaultState, type CompanyVaultDeps } from './company-vaults.js';
import type { VaultKey } from '../core/vault-keys.js';

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
/* Whether the vault's state on the chain fails to read as a vault's at all. */
let startingLedgerUnreadable: boolean;
const CIRCUITS = ['batchPayout', 'deposit', 'depositUnshielded', 'forgetUnshielded', 'mergeNotes', 'payout', 'payoutUnshielded', 'retire', 'setNonceSecret', 'splitNote', 'writeSecretCopy'];
/* The company account: its own circuits, its own authority, and its own verifying keys, apart from the vault's. */
const ACCOUNT_CIRCUITS = ['approve', 'propose', 'recordPaymentFromVault'];
const ACCOUNTS = new Set([hex(0xc0), hex(0xc1)]);
let accountAuthority: unknown;
let accountKeys: (c: string) => Uint8Array;
let accountUnreachable = false;
/* How many times the vault's state has been read in this test, and which of those reads the indexer does not answer. */
let vaultReads = 0;
let vaultReadFails: (n: number) => boolean = () => false;
let handoverDep: CompanyVaultDeps['account']['handover'];
let serviceKey: { tag: string; value: string } | undefined;
let acc1Threshold = 2;
let acc1VaultThresholds: Array<{ vault: string; threshold: number }> = [];
let handoverShape: unknown;
let payoutShape: unknown;
/* What a step of a vault's start reads as, and the vault's secret and start as its ledger shows them. */
let startShape: unknown;
let secretNow: string;
let startedNow: boolean;
let payoutState: CompanyVaultDeps['chain']['payoutState'];
let eventsOf: CompanyVaultDeps['chain']['eventsOf'];
let createdBy: CompanyVaultDeps['chain']['createdBy'];
let accountCallState: CompanyVaultDeps['chain']['accountCallState'];
let asked: string[];
/* Whether the vault's ledger is this build's shape, as the chain reader answers it; `undefined` for a reader with no such check. */
let ledgerIsThisBuilds: CompanyVaultDeps['chain']['ledgerIsThisBuilds'];
let assembleDep: CompanyVaultDeps['committeeChange'];
/* The vault's public balance as its state carries it; absent unless a test sets it. */
let vaultBalance: unknown;
/*
 * **THE ROSTER, STOOD IN.** What each member's own roster entry carries, and the
 * index a seat's device files with the roster, made from it - sorted, with no
 * names. The roster itself is written on a device: offered and folded in
 * `vault-keys-are-offered-and-folded.test.ts`, and checked in
 * `a-signers-keys-are-the-rosters.test.ts`.
 */
let roster: Map<string, { committeeKey: VaultKey; recordsKey: string }>;
const vkOf = (c: string) => new TextEncoder().encode(`vk:${c}`);
const aDeploy = () => ({
  intents: new Map([[1, { actions: [{
    address: VAULT,
    initialState: {
      /* Born held: the company's committee, at its threshold, from the first transaction. */
      maintenanceAuthority: { committee: [key(1), key(2)], threshold: 2, counter: 0n },
      operations: () => CIRCUITS,
      operation: (c: string) => ({ verifierKey: vkOf(c) }),
    },
  }] }]]),
});

/** The company's label, which its signers' wallets derive their committee keys from. */
const LABEL = 'co_' + 'c1'.repeat(32);
const account = (over: Partial<SealedAccount> = {}): SealedAccount => ({
  id: 'acc_1', createdAt: '', keyEpoch: 0, threshold: 2, signerCount: 2, memberUserIds: ['ada', 'bo'], companyLabel: LABEL,
  pendingSigners: [], wrappedKeys: [], inboxPublicKey: '', ...over,
} as unknown as SealedAccount);

beforeEach(async () => {
  store = new MemoryStore();
  roster = new Map();
  store.putAccount(account());
  store.putAccount(account({ id: 'acc_2', memberUserIds: ['carol'] }));
  /* By default the account was created here from its founding signer's browser, so it is born held. */
  store.recordAccountDeploy({
    accountId: 'acc_1', address: hex(0xc0), foundingKey: key(1), deploy: 'ZA==', insert: 'aQ==', recordedAt: 'then',
  });
  sent = [];
  authority = { committee: [key(9)], threshold: 1, counter: 0n };
  circuitKeys = vkOf;
  /* By default the account is already the committee's, so a test about a vault is about the vault. */
  accountAuthority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
  accountKeys = vkOf;
  accountUnreachable = false;
  vaultReads = 0;
  vaultReadFails = () => false;
  handoverDep = undefined;
  serviceKey = undefined;
  acc1Threshold = 2;
  acc1VaultThresholds = [];
  handoverShape = {};
  payoutShape = {};
  startShape = {};
  secretNow = '00'.repeat(32);
  startedNow = true;
  asked = [];
  payoutState = async (vault, account) => {
    asked.push(`state of ${vault.slice(0, 2)} and ${account.slice(0, 2)}`);
    return { blockHash: 'B', vaultState: 'dg==', zswapState: 'eg==', parameters: 'cA==', accountState: 'YQ==' };
  };
  eventsOf = async (tx) => { asked.push(`events of ${tx.slice(0, 2)}`); return [{ transactionHash: tx, details: { tag: 'zswapOutput', mtIndex: '7' } }]; };
  createdBy = async (vault, commitment) => {
    asked.push(`created ${commitment.slice(0, 2)} in ${vault.slice(0, 2)}`);
    return commitment === hex(0x0c)
      ? { transactionHash: hex(0x0e), events: [{ transactionHash: hex(0x0e), details: { tag: 'zswapOutput', commitment, contract: vault, mtIndex: '7' } }] }
      : null;
  };
  accountCallState = async (address) => {
    asked.push(`call state of ${address.slice(0, 2)}`);
    return { blockHash: 'B', accountState: 'YQ==', parameters: 'cA==' };
  };
  pinnedNow = hex(0xc0);
  startingLedgerUnreadable = false;
  ledgerIsThisBuilds = async () => {};
  assembleDep = undefined;
  vaultBalance = undefined;
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
    company: async (id) => (id === 'acc_1'
      ? { address: hex(0xc0), threshold: acc1Threshold, vaultThresholds: acc1VaultThresholds }
      : { address: hex(0xc1), threshold: 1, vaultThresholds: [] }),
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
        vaultReads += 1;
        if (vaultReadFails(vaultReads)) throw new Error('the indexer did not answer');
        return {
          maintenanceAuthority: authority, serialize: () => new Uint8Array([7]),
          operations: () => CIRCUITS, operation: (c: string) => ({ verifierKey: circuitKeys(c) }),
          ...(vaultBalance === undefined ? {} : { balance: vaultBalance }),
        };
      },
      serialize: (s) => (s as { serialize(): Uint8Array }).serialize(),
      notesOf: () => [hex(0x5a)],
      get ledgerIsThisBuilds() { return ledgerIsThisBuilds; },
      startingLedgerOf: () => {
        if (startingLedgerUnreadable) throw new Error('this state has no vault ledger in it');
        return { account: pinnedNow, notes: 0n, unshieldedTokens: 0n, payments: 0n, nonceCommitment: secretNow, splitJournal: 0n, secretCopies: 0n, reserved: 0n, started: startedNow };
      },
      everCreated: async () => new Set(),
      get payoutState() { return payoutState; },
      get eventsOf() { return eventsOf; },
      get createdBy() { return createdBy; },
      get accountCallState() { return accountCallState; },
    },
    verifierKeys: async () => new Map(CIRCUITS.map((c) => [c, vkOf(c)])),
    account: {
      circuits: ACCOUNT_CIRCUITS,
      verifierKeys: async () => new Map(ACCOUNT_CIRCUITS.map((c) => [c, vkOf(c)])),
      get handover() { return handoverDep; },
      get temporaryKey() { return serviceKey; },
    },
    readers: {
      proven: async (b) => (b[0] === 0xee ? handoverShape : b[0] === 0xdd ? payoutShape : b[0] === 0xcc ? startShape : deployShape ? aDeploy() : {}),
      finished: async () => ({}),
    },
    get committeeChange() { return assembleDep; },
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
/**
 * **AN ACCOUNT CREATED THE OLD WAY**, under this service's temporary key and handed over later: the record holds no
 * deploy from its founding signer's browser. Only the handover's own tests, which go with the handover, use this.
 */
const accountNotBornHeld = () => {
  delete (store as unknown as { data: { accountDeploys: Record<string, unknown> } }).data.accountDeploys['acc_1'];
};
/** A member's vault keys, folded into the roster as a seat's device folds them, and the index filed with it. */
const give = async (as: string, n: number): Promise<void> => {
  roster.set(`acc_1:${as}`, { committeeKey: key(n), recordsKey: hex(n + 0x10) });
  const mine = [...roster.values()];
  store.putVaultKeyIndex({
    accountId: 'acc_1', signerCount: store.getAccount('acc_1')!.signerCount,
    committeeKeys: mine.map((k) => k.committeeKey).sort((a, b) => (a.value < b.value ? -1 : 1)),
    readers: mine.map((k) => k.recordsKey).sort(), filers: [],
  });
};

describe('A SIGNER\'S VAULT KEYS', () => {
  it('ARE NOT TAKEN BY THE VAULT ROUTES: a seat\'s device files them in the roster, or offers them to be folded in', async () => {
    /* RED WHEN: the vault routes write a signer's keys into the roster again. */
    expect((await call('/api/accounts/acc_1/vault-keys', 'ada', 'PUT', {
      viewingKey: 'vk', committeeKey: key(1), recordsKey: hex(0x11), signature: 'ab'.repeat(64),
    })).status).toBe(404);
  });

  it('the committee is complete only when every signer has given a key', async () => {
    await give('ada', 1);
    let k = await call('/api/accounts/acc_1/vault-keys', 'ada');
    expect(k.body.committee).toBeNull();
    expect(k.body.why).toMatch(/1 of this company's 2 signers has not/);
    /* RED WHEN: the answer says which key is whose - the service then tells anybody who asks. */
    expect(Object.keys(k.body).sort()).toEqual(['committee', 'readers', 'why']);
    await give('bo', 2);
    k = await call('/api/accounts/acc_1/vault-keys', 'ada');
    expect(k.body.committee).toEqual({ committee: [key(1), key(2)], threshold: 2 });
    expect(k.body.readers.sort()).toEqual([hex(0x11), hex(0x12)]);
  });

  it('a seeded signer with no person behind them leaves the committee incomplete', () => {
    const r = companyCommittee(account({ memberUserIds: ['ada'], signerCount: 2 }), 1, {
      accountId: 'acc_1', signerCount: 2, committeeKeys: [key(1)], readers: [hex(1)], filers: [hex(1)],
    });
    expect(r.committee).toBeNull();
    expect(r.why).toMatch(/1 of this company's 2 signers/);
    /* RED WHEN: an index made when the company had another number of signers is taken as this company's committee. */
    const stale = companyCommittee(account({ signerCount: 3 }), 1, {
      accountId: 'acc_1', signerCount: 2, committeeKeys: [key(1), key(2)], readers: [], filers: [],
    });
    expect(stale.committee).toBeNull();
    expect(stale.why).toMatch(/3 of this company's 3 signers/);
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
    store.putCompanyVault({ accountId: 'acc_2', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [], threshold: 1 }, bornHeld: true });
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
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    const refused = await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });
    expect(refused).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(refused.body.error).toMatch(/its committee is changed to match in Settings/);
    /* A vault is born held, so one the committee does not hold has nothing owed to it: it is held by other keys. */
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows).toEqual([
      expect.objectContaining({ vault: VAULT, state: 'held-by-other-keys' }),
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
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
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

  it('NO DEPOSIT INTO A VAULT NOT BORN HELD, OR NOW PINNED ELSEWHERE, though the chain shows the committee and this build', async () => {
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
    /* Created under some other key, which could have swapped a circuit, used it and put it back before installing the
     * committee: the chain shows the committee and this build's circuits, and only the record tells it apart. */
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    await refusedEverywhere(/were not read by this service at their creation as held by the company's committee/);
    /* Born held, but the ledger now names an account that is not the company's. */
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    pinnedNow = hex(0xd0);
    await refusedEverywhere(/pinned to an account other than the company's/);
    /* RED WHEN: a vault whose state on the chain cannot be read as a vault's is passed rather than refused. */
    startingLedgerUnreadable = true;
    await refusedEverywhere(/its state on the chain cannot be read as a vault's/);
    startingLedgerUnreadable = false;
    expect(sent).toEqual([]);
    pinnedNow = hex(0xc0);
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('held-by-committee');
  });

  /*
   * **A HICCUP BETWEEN TWO READS IS NOT AN ALARM.** The list reads who holds
   * the vault, then reads the vault's state for everything else the gate asks.
   * When the second read fails, the chain has not said anything is wrong with
   * the vault: the screen shows that it could not be asked, and the doors still
   * refuse. RED WHEN: a failed state read is answered as a refusal about the
   * vault rather than put to the gate as a read that went unanswered.
   */
  it('A STATE READ THAT FAILS AFTER THE RULES WERE READ SHOWS AS UNKNOWN, NOT AS AN ALARM, AND STILL SENDS NOTHING', async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('held-by-committee');
    /* Every second read of the vault fails: the rules are read, the state that follows is not. */
    vaultReads = 0;
    vaultReadFails = (n) => n % 2 === 0;
    const rows = (await call('/api/accounts/acc_1/vaults', 'ada')).body.rows;
    expect(rows).toEqual([expect.objectContaining({ vault: VAULT, state: 'unknown', why: expect.stringMatching(/could not be asked/) })]);
    vaultReads = 0;
    const refused = await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });
    expect(refused).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(refused.body.error).toMatch(/could not be asked/);
    vaultReads = 0;
    const unpaid = await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', { tx: '3Q==' });
    expect(unpaid).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(unpaid.body.error).toMatch(/^this service pays no fee for a payment out of this vault: /);
    expect(sent).toEqual([]);
  });

  /*
   * **THE VIEW A DEVICE READS BEFORE A PAYMENT OUT SPEAKS OF BOTH DIRECTIONS.**
   * The device quotes it to a person paying out, and the service refuses a
   * payment out on the same gate. RED WHEN: the view's reason is worded for
   * money going in alone.
   */
  it('THE CHAIN VIEW\'S REASON IS TRUE OF A PAYMENT OUT AS WELL AS A DEPOSIT', async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    const notHeld = await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada');
    expect(notHeld.body).toMatchObject({ heldByCommittee: false, fundable: false });
    expect(notHeld.body.why).toMatch(/^no money goes into or out of this vault: /);
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    /* The vault is the committee's; the account it pays out on is not one the record holds as born held. */
    accountNotBornHeld();
    const unvouched = await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada');
    expect(unvouched.body).toMatchObject({ heldByCommittee: true, fundable: false });
    expect(unvouched.body.why).toMatch(/^no money goes into or out of this vault: /);
  });

  it('a deployment that cannot send says so, and a send that may have landed is not marked as nothing sent', async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [], threshold: 2 }, bornHeld: true });
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

  it('A DEPLOY THAT MAY HAVE LANDED IS STILL RECORDED, BORN HELD AND WITH ITS BYTES, SO IT IS NEVER LOST; ONE REFUSED IS NOT', async () => {
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
      expect.objectContaining({ vault: VAULT, deployRef: 'unknown', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true, deploy: 'AAAA' }),
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

describe('NO VAULT UNTIL THE COMPANY\'S ACCOUNT IS FINISHED', () => {
  it('REFUSES A VAULT FOR AN ACCOUNT NOT CREATED FROM ITS FOUNDING SIGNER\'S BROWSER, OR NOT YET RUNNING THIS BUILD\'S CIRCUITS', async () => {
    await give('ada', 1); await give('bo', 2);
    deployShape = true;
    /* RED WHEN: a vault is made for an account whose second step has not landed, so it does not run this build's circuits yet. */
    accountKeys = (c) => (c === 'recordPaymentFromVault' ? new TextEncoder().encode('vk:not-yet') : vkOf(c));
    const early = await call('/api/accounts/acc_1/vaults', 'ada', 'POST', { tx: 'AAAA' });
    expect(early).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(early.body.error).toMatch(/not finished being created yet/);
    accountKeys = vkOf;
    /* RED WHEN: a vault is made for an account this service's record does not hold as born held. */
    accountNotBornHeld();
    const old = await call('/api/accounts/acc_1/vaults', 'ada', 'POST', { tx: 'AAAA' });
    expect(old).toMatchObject({ status: 409 });
    expect(old.body.error).toMatch(/was not created held by its committee from its first transaction/);
    expect(sent).toEqual([]);
    expect(store.listCompanyVaults('acc_1')).toEqual([]);
    deployShape = false;
  });
});

describe('THE COMPANY ACCOUNT STANDS BEHIND EVERY VAULT', () => {
  const vaultHeld = async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
  };
  const deposit = () => call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });

  it('NO MONEY GOES INTO A VAULT THE COMMITTEE HOLDS WHILE THE ACCOUNT IS STILL HELD BY ITS TEMPORARY KEY', async () => {
    /* RED WHEN: the account check at the end of `whyNotFunded` is removed - the first deposit is then paid for,
     * `sent` carries it, and the row reads 'held-by-committee' over an account one machine's key can drain. */
    await vaultHeld();
    /* The key the chain shows on the account is THIS SERVICE'S: a door that keeps none cannot say whose it is. */
    serviceKey = key(9);
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

  it('NOR WHILE THE ACCOUNT IS HELD BY OTHER KEYS, RUNS OTHER CIRCUITS, OR CANNOT BE READ; A BORN-HELD ONE CHANGED TWICE IS FUNDED', async () => {
    /* RED WHEN, one per step, all inside the one gate: `committeeHoldsIt` answers `null` on a disagreeing
     * authority; the account's circuits stop being compared; an unreachable account is read as ready. */
    await vaultHeld();
    accountAuthority = { committee: [key(1), key(3)], threshold: 2, counter: 1n };
    expect((await deposit()).body.error).toMatch(/not held by the company's committee on the chain/);
    /* RED WHEN: a born-held account is refused for having been changed more than once. */
    accountAuthority = { committee: [key(1), key(2)], threshold: 2, counter: 2n };
    expect((await deposit()).status).toBe(200);
    sent.length = 0;
    accountAuthority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    accountKeys = (c) => (c === 'recordPaymentFromVault' ? new TextEncoder().encode('vk:drain') : vkOf(c));
    expect((await deposit()).body.error).toMatch(/'recordPaymentFromVault' circuit is not the one this service's build compiled/);
    /* An account as deployed but running circuits this build did not compile is an alarm, not a step not yet taken. */
    serviceKey = key(9);
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    expect((await deposit()).body.error).toMatch(/temporary key/);
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('account-not-fundable');
    accountAuthority = { committee: [key(1), key(2)], threshold: 2, counter: 2n };
    accountKeys = vkOf;
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('held-by-committee');
    /*
     * **A DOOR THAT KEEPS NO KEY OF ITS OWN CANNOT SAY WHOSE SINGLE KEY THAT IS.**
     * RED WHEN: `accountAsDeployed` treats an empty `heldHere` as a match, which makes every one-key,
     * never-changed account read as OUR temporary key - so a screen offers the handover button, and the
     * sentence claims custody the door has not checked, while a stranger holds the account.
     */
    serviceKey = undefined;
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('account-not-fundable');
    expect((await deposit()).body.error).not.toMatch(/temporary key it was created with/);

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
    /* RED WHEN: `vaultState` answers 'handover-owed' for any authority - the row then offers a button the service
     * refuses, and says nothing about who still holds the vault. */
    await vaultHeld();
    authority = { committee: [key(1)], threshold: 1, counter: 1n };
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('held-by-other-keys');
    const read = (a: { committee: { tag: string; value: string }[]; threshold: number; counter: bigint; shape: string }) =>
      ({ state: 'read', address: VAULT, authority: { ...a, hasDuplicateMembers: false } }) as never;
    /* RED WHEN: a vault held by one key outside the committee is still offered as a handover: a vault is born held, and nothing is handed over. */
    expect(vaultState(read({ committee: [key(9)], threshold: 1, counter: 0n, shape: 'one-key' }), { heldByOthers: true })).toBe('held-by-other-keys');
    expect(vaultState(read({ committee: [key(9)], threshold: 1, counter: 1n, shape: 'one-key' }), { heldByOthers: true })).toBe('held-by-other-keys');
    expect(vaultState(read({ committee: [key(1), key(3)], threshold: 2, counter: 1n, shape: 'committee' }), { heldByOthers: true })).toBe('held-by-other-keys');
    expect(vaultState({ state: 'absent', address: VAULT, why: '' }, { heldByOthers: true })).toBe('not-on-chain-yet');
    /*
     * **WHAT THE CHAIN SAID IS READ BEFORE THE REFUSAL'S FLAGS.**
     * RED WHEN: the `!heldByOthers` branch runs before the read's own state, so a vault the chain could not be
     * asked about is reported as a decision this service made about it - an alarm for a chain hiccup.
     */
    expect(vaultState({ state: 'unreachable', address: VAULT, why: 'down' }, { heldByOthers: false })).toBe('unknown');
    expect(vaultState({ state: 'absent', address: VAULT, why: '' }, { heldByOthers: false })).toBe('not-on-chain-yet');
  });

  it('SETTINGS SHOWS EVERY CONTRACT\'S SEATS FROM THE CHAIN, AND A SEAT HELD BY SOMEBODY NOT ON THE COMPANY - AND NEVER WHOSE EACH SEAT IS', async () => {
    /* RED WHEN: `authorityView` stops counting seats outside the committee - `seatsOutsideTheCommittee` reads 0 for
     * the vault and its sentence stops naming the seat - or the service names whose key a seat is, which only the
     * sealed roster may say. */
    await vaultHeld();
    accountNotBornHeld();
    authority = { committee: [key(1), key(3)], threshold: 2, counter: 1n };
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    handoverDep = async () => new Uint8Array([0xee]);
    serviceKey = key(9);
    const r = await call('/api/accounts/acc_1/authority', 'ada');
    expect(r.status).toBe(200);
    /* RED WHEN the label is left out: a signer's wallet would have nothing to derive its committee key from. */
    expect(r.body.company).toEqual({ address: hex(0xc0), label: LABEL, threshold: 2, signerCount: 2 });
    const [acct, vault] = r.body.contracts;
    expect(acct).toMatchObject({ contract: 'account', heldByTheCompany: false, shape: 'one-key', changes: '0', seatsOutsideTheCommittee: 1 });
    expect(vault).toMatchObject({ contract: 'vault', heldByTheCompany: false, threshold: 2, seatsOutsideTheCommittee: 1 });
    expect(vault.seats).toEqual([
      { key: key(1), holder: null, thisService: false, onTheCompanysCommittee: true },
      { key: key(3), holder: null, thisService: false, onTheCompanysCommittee: false },
    ]);
    expect(vault.why).toMatch(/1 seat\(s\) on this vault are held by a key that is not on the company's committee/);
    /* RED WHEN: the service's own key is not passed to the view - the seat then reads as nobody's. */
    expect(acct.seats[0]).toMatchObject({ key: key(9), thisService: true });
    expect(acct.why).toMatch(/THIS SERVICE'S temporary key holds this account's rules/);
    expect(r.body.handover).toMatchObject({ possible: true, why: null });
    expect(r.body.handover.permanent).toMatch(/A signer who has left keeps their seat until then/);
    /* RED WHEN: a handed-over vault held by a committee that is not the company's is not offered a change - it is
     * the one thing that brings it back, and the screen would offer nothing. */
    expect(r.body.change.possible).toBe(true);
    expect(r.body.change.why).toMatch(/^1 vault is still held by the committee from before/);
    expect(r.body.change.why).toMatch(/no money goes into or out of that vault/);
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
    accountNotBornHeld();
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

  it('THE ACCOUNT\'S HANDOVER CARRIES THE HIGHEST BAR THE ACCOUNT ENFORCES, ITS VAULTS\' INCLUDED', async () => {
    await give('ada', 1); await give('bo', 2);
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    acc1VaultThresholds = [{ vault: hex(0xdd), threshold: 3 }];
    let bar: number | null = null;
    handoverDep = async ({ strictestBar }) => { bar = strictestBar; throw new Error('stopped before anything was built'); };
    const r = await call('/api/accounts/acc_1/authority/handover', 'ada', 'POST', { committee: { committee: [key(1), key(2)], threshold: 2 } });
    expect(r.body).toMatchObject({ nothingWasSent: true });
    /* RED WHEN: the handover is built with the company's threshold alone as its bar. */
    expect(bar).toBe(3);
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

  it('NOT WHILE ONE SIGNER COULD ACT ALONE AND ANOTHER COULD LEAVE, ON EVERY DOOR THAT INSTALLS A COMMITTEE', async () => {
    /* RED WHEN: `whyNotYet` is removed from the route or from the settings answer. */
    await give('ada', 1); await give('bo', 2);
    accountNotBornHeld();
    acc1Threshold = 1;
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    handoverDep = async () => { throw new Error('must not be reached'); };
    const r = await call('/api/accounts/acc_1/authority/handover', 'ada', 'POST', { committee: { committee: [key(1), key(2)], threshold: 1 } });
    expect(r).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(r.body.error).toMatch(/could change them alone.*Raise the company's threshold to at least two/s);
    expect((await call('/api/accounts/acc_1/authority', 'ada')).body.handover).toMatchObject({
      possible: false, why: expect.stringMatching(/could change them alone/),
    });
    expect(sent).toEqual([]);
  });

  it('A BORN-HELD ONE-SIGNER COMPANY\'S FIRST CHANGE IS OFFERED, AND NEVER ONE THAT LEAVES A KEY ABLE TO ACT ALONE', async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1)], threshold: 1 }, bornHeld: true });
    /* The founding signer alone holds the account and the vault, never changed; a second signer is now seated. */
    accountAuthority = { committee: [key(1)], threshold: 1, counter: 0n };
    authority = { committee: [key(1)], threshold: 1, counter: 0n };
    const settings = (await call('/api/accounts/acc_1/authority', 'ada')).body;
    /* RED WHEN: a one-key contract at counter 0 is left out of the contracts behind, or offered a handover instead. */
    expect(settings.change).toMatchObject({ possible: true });
    expect(settings.change.why).toMatch(/^The company account and 1 vault are still held by the committee from before/);
    expect(settings.handover).toMatchObject({ possible: false, why: expect.stringMatching(/created held by its committee, so there is nothing to hand over/) });
    const owed = (await call('/api/accounts/acc_1/committee-change', 'ada')).body;
    expect(owed.contracts.map((c: { contract: string; counter: string }) => [c.contract, c.counter])).toEqual([['account', '0'], ['vault', '0']]);
    /* The same company at a threshold of one: two keys either of which could act alone, so nothing is offered. */
    acc1Threshold = 1;
    const loose = (await call('/api/accounts/acc_1/authority', 'ada')).body;
    expect(loose.change).toMatchObject({ possible: false, why: expect.stringMatching(/could change them alone/) });
  });

  it('NO COMMITTEE, NO ACCOUNT HANDOVER', async () => {
    await give('ada', 1);
    handoverDep = async () => { throw new Error('must not be reached'); };
    const r = await call('/api/accounts/acc_1/authority/handover', 'ada', 'POST', {});
    expect(r).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(r.body.error).toMatch(/1 of this company's 2 signers has not/);
  });
});

describe('A PRIVATE PAYMENT OUT OF A VAULT', () => {
  const PAYOUT_TX = Buffer.from([0xdd, 1]).toString('base64');
  /* A payment with the shape the fee payer reads: one of the vault's coins to one person, asking acc_1's account. */
  const aPayout = (account = hex(0xc0), vault = VAULT) => ({
    intents: new Map([[1, { actions: [{ address: account, entryPoint: 'recordPaymentFromVault' }, { address: vault, entryPoint: 'payout' }] }]]),
    guaranteedOffer: { inputs: [{ contractAddress: vault }], outputs: [{}], transients: [] },
    imbalances: () => new Map(),
  });
  let arrivals: string[];
  beforeEach(async () => {
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [], threshold: 2 }, bornHeld: true });
    /* A vault the service can vouch for: the committee holds it, changed once, this build's circuits, pinned here. */
    await give('ada', 1); await give('bo', 2);
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    arrivals = [];
    payoutShape = aPayout();
    sendVault = async (_a, what, arrival, bytes, check, read) => {
      arrivals.push(arrival);
      const refusal = await check(await read(bytes));
      if (refusal !== null) throw new NothingWasSent(refusal);
      sent.push(what);
      return { ref: 'r-pay', at: 'now', transactionHash: 'fe'.repeat(32) };
    };
  });

  it('is paid for as the vault\'s own coins, read as a proven transaction, and answers the transaction that made the change', async () => {
    /* RED WHEN: the route sends under another arrival (the reader or the binding then differ), or drops the hash. */
    const r = await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', { tx: PAYOUT_TX });
    expect(r).toEqual({ status: 200, body: { txRef: 'r-pay', transactionHash: 'fe'.repeat(32) } });
    expect(arrivals).toEqual(['proven-moving-the-vaults-own-coins']);
    expect(sent).toEqual(['a private payment out of a vault']);
  });

  it('IS NOT PAID FOR WHEN IT ASKS ANOTHER COMPANY\'S ACCOUNT, OR SPENDS FROM ANOTHER VAULT', async () => {
    /* RED WHEN: the route hands the reader anything but this company's account and this vault. */
    payoutShape = aPayout(hex(0xc1));
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', { tx: PAYOUT_TX }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true } });
    payoutShape = aPayout(hex(0xc0), hex(0xaa));
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', { tx: PAYOUT_TX }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true } });
    expect(sent).toEqual([]);
  });

  it('NO FEE IS PAID FOR A PAYMENT OUT OF A VAULT THE SERVICE CANNOT VOUCH FOR, READ FROM THE CHAIN NOW', async () => {
    /* RED WHEN: the route stops asking what the chain shows of the vault before it pays the fee. */
    authority = { committee: [key(9)], threshold: 1, counter: 0n };
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', { tx: PAYOUT_TX }))
      /* RED WHEN: the payout door quotes the deposit gate's wording, so a person paying money OUT is told about
       * money going IN. The cause is the one gate's; the consequence belongs to the door that asked. */
      .toMatchObject({
        status: 409,
        body: {
          nothingWasSent: true,
          error: expect.stringMatching(/^this service pays no fee for a payment out of this vault:/),
        },
      });
    expect(
      (await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', { tx: PAYOUT_TX })).body.error,
      'RED WHEN: a payout refusal tells the reader that no money goes IN',
    ).not.toMatch(/money goes in|goes into this vault/);
    /* The committee holds it now, and the record does not hold it as born held. */
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    const record = store.getCompanyVault(VAULT)!;
    store.putCompanyVault({ ...record, bornHeld: undefined });
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', { tx: PAYOUT_TX })).status).toBe(409);
    store.putCompanyVault(record);
    circuitKeys = (c) => (c === 'payout' ? new Uint8Array([1]) : vkOf(c));
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', { tx: PAYOUT_TX })).status).toBe(409);
    circuitKeys = vkOf;
    pinnedNow = hex(0xc1);
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', { tx: PAYOUT_TX })).status).toBe(409);
    expect(arrivals).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('A VAULT THAT IS NOT THIS COMPANY\'S, A PERSON WHO IS NOT A MEMBER, OR NO TRANSACTION: NOTHING IS READ OR SENT', async () => {
    store.putCompanyVault({ accountId: 'acc_2', vault: hex(0xba), deployedAt: '', deployRef: 'r', intended: { committee: [], threshold: 1 }, bornHeld: true });
    expect((await call(`/api/accounts/acc_1/vaults/${hex(0xba)}/payout`, 'ada', 'POST', { tx: PAYOUT_TX })).status).toBe(404);
    expect((await call(`/api/accounts/acc_1/vaults/${hex(0xba)}/payout-state`, 'ada')).status).toBe(404);
    expect((await call(`/api/accounts/acc_1/vaults/${hex(0xba)}/events/${hex(1)}`, 'ada')).status).toBe(404);
    expect((await call(`/api/accounts/acc_1/vaults/${hex(0xba)}/created/${hex(0x0c)}`, 'ada')).status).toBe(404);
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/created/${hex(0x0c)}`, 'carol')).status).toBe(404);
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'carol', 'POST', { tx: PAYOUT_TX })).status).toBe(404);
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, null, 'POST', { tx: PAYOUT_TX })).status).toBe(401);
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', {})).status).toBe(400);
    expect(sent).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('WHAT A PAYMENT IS BUILT ON IS READ FOR THIS VAULT AND THIS COMPANY\'S ACCOUNT, AT ONE BLOCK', async () => {
    /* RED WHEN: the state is read for any other pair, or the block is dropped from the answer. */
    const r = await call(`/api/accounts/acc_1/vaults/${VAULT}/payout-state`, 'ada');
    expect(r).toEqual({
      status: 200,
      body: { vault: VAULT, account: hex(0xc0), blockHash: 'B', vaultState: 'dg==', zswapState: 'eg==', parameters: 'cA==', accountState: 'YQ==' },
    });
    expect(asked).toEqual(['state of ab and c0']);
    payoutState = async () => null;
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/payout-state`, 'ada')).status).toBe(409);
    payoutState = async () => { throw new Error('the indexer did not answer'); };
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/payout-state`, 'ada'))
      .toMatchObject({ status: 503, body: { error: expect.stringMatching(/the indexer did not answer/) } });
    payoutState = undefined;
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/payout-state`, 'ada')).status).toBe(503);
  });

  it('WHAT A RAISE OR AN APPROVAL IS BUILT ON IS THIS COMPANY\'S ACCOUNT AT ONE BLOCK, FOR A MEMBER, AND NOTHING ELSE', async () => {
    /* RED WHEN: the account read is any but this company's, or the address or the block is dropped from the answer. */
    expect(await call('/api/accounts/acc_1/call-state', 'ada')).toEqual({
      status: 200, body: { account: hex(0xc0), blockHash: 'B', accountState: 'YQ==', parameters: 'cA==' },
    });
    expect(asked).toEqual(['call state of c0']);
    /* RED WHEN: a person who is not a member, or nobody, is answered. */
    expect((await call('/api/accounts/acc_1/call-state', 'carol')).status).toBe(404);
    expect((await call('/api/accounts/acc_1/call-state', null)).status).toBe(401);
    expect(asked).toEqual(['call state of c0']);
    accountCallState = async () => null;
    expect((await call('/api/accounts/acc_1/call-state', 'ada')).status).toBe(409);
    accountCallState = async () => { throw new Error('the indexer did not answer'); };
    expect(await call('/api/accounts/acc_1/call-state', 'ada'))
      .toMatchObject({ status: 503, body: { error: expect.stringMatching(/the indexer did not answer/) } });
    accountCallState = undefined;
    expect((await call('/api/accounts/acc_1/call-state', 'ada')).status).toBe(503);
  });

  it('A TRANSACTION\'S EVENTS ARE READ ONLY BY ITS HASH, AND A READER THAT CANNOT ANSWER SAYS WHICH KIND OF NO', async () => {
    const tx = hex(0x0e);
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/events/${tx}`, 'ada')).toEqual({
      status: 200, body: { events: [{ transactionHash: tx, details: { tag: 'zswapOutput', mtIndex: '7' } }] },
    });
    /* RED WHEN: the hash is not checked before the chain is asked. */
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/events/${'0e'.repeat(33)}`, 'ada')).status).toBe(400);
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/events/not-a-hash`, 'ada')).status).toBe(400);
    expect(asked).toEqual(['events of 0e']);
    eventsOf = async () => { throw Object.assign(new Error('not yet'), { name: 'NoteIndexUnreadable' }); };
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/events/${tx}`, 'ada'))
      .toMatchObject({ status: 503, body: { error: 'not yet', kind: 'NoteIndexUnreadable' } });
  });

  it('THE TRANSACTION THAT CREATED AN OUTPUT IS LOOKED FOR IN THIS VAULT\'S HISTORY, BY THE OUTPUT\'S COMMITMENT ALONE', async () => {
    const out = hex(0x0c);
    /* RED WHEN: the route asks any vault's history but the one in its address, or drops the events from the answer. */
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/created/${out.toUpperCase()}`, 'ada')).toEqual({
      status: 200,
      body: { found: true, transactionHash: hex(0x0e), events: [{ transactionHash: hex(0x0e), details: { tag: 'zswapOutput', commitment: out, contract: VAULT, mtIndex: '7' } }] },
    });
    /* RED WHEN: nothing found is answered as an error, or as a transaction. */
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/created/${hex(0x0d)}`, 'ada')).toEqual({ status: 200, body: { found: false } });
    /* RED WHEN: the commitment is not checked before the chain is asked. */
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/created/${'0c'.repeat(33)}`, 'ada')).status).toBe(400);
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/created/not-a-commitment`, 'ada')).status).toBe(400);
    expect(asked).toEqual([`created 0c in ${VAULT.slice(0, 2)}`, `created 0d in ${VAULT.slice(0, 2)}`]);
    createdBy = async () => { throw Object.assign(new Error('not yet'), { name: 'NoteIndexUnreadable' }); };
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/created/${out}`, 'ada'))
      .toMatchObject({ status: 503, body: { error: 'not yet', kind: 'NoteIndexUnreadable' } });
    createdBy = undefined;
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/created/${out}`, 'ada')).status).toBe(503);
  });
});

describe('THE VAULT\'S NOTES ARE VOUCHED FOR ONLY WHEN READ OFF A LEDGER OF THIS BUILD\'S SHAPE', () => {
  const view = async () => {
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    return call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada');
  };

  it('says so beside the notes when the ledger is this build\'s', async () => {
    const v = await view();
    /* RED WHEN: the view stops saying whether its notes were read off this build's ledger - a device then cannot tell. */
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ notes: [hex(0x5a)], notesFromThisBuild: true });
    expect(v.body.notesWhy).toBeUndefined();
  });

  it('says not, and why, when the ledger is another shape, and keeps the rest of the view', async () => {
    ledgerIsThisBuilds = async () => { throw new Error('this vault\'s ledger holds 4 fields where this build\'s holds 5'); };
    const v = await view();
    /* RED WHEN: a ledger of another shape is vouched for - a device then compares its record with some other field. */
    expect(v.status).toBe(200);
    expect(v.body.notesFromThisBuild).toBe(false);
    expect(v.body.notesWhy).toMatch(/holds 4 fields where this build's holds 5/u);
    /* RED WHEN: the whole view is refused - handing a vault over and depositing read it too, and they gate on shape themselves. */
    expect(v.body).toMatchObject({ onChain: true, notes: [hex(0x5a)] });
  });

  it('does not vouch when the chain reader has no way to check', async () => {
    ledgerIsThisBuilds = undefined;
    const v = await view();
    /* RED WHEN: a reader that cannot check is read as one that checked. */
    expect(v.body.notesFromThisBuild).toBe(false);
    expect(v.body.notesWhy).toMatch(/not set up to check how a vault is laid out.*Whoever runs the service turns that check on$/su);
  });
});

describe('THE VAULT\'S VIEW SAYS WHAT IT HOLDS IN PUBLIC MONEY', () => {
  const NIGHT = 'ab'.repeat(32);
  const OTHER = 'cd'.repeat(32);
  const view = async () => {
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    return call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada');
  };

  it('lists every public token the vault\'s state holds, with its amount as a whole number', async () => {
    vaultBalance = new Map<unknown, bigint>([
      [{ tag: 'unshielded', raw: OTHER }, 5n], [{ tag: 'dust' }, 9n], [{ tag: 'unshielded', raw: NIGHT }, 12_000_000n],
    ]);
    const v = await view();
    /* RED WHEN the view leaves the balance out, lists the fee token, or sends an amount a page reads as a float. */
    expect(v.status).toBe(200);
    expect(v.body.publicBalances).toEqual([{ token: NIGHT, amount: '12000000' }, { token: OTHER, amount: '5' }]);
    expect(v.body.publicBalancesWhy).toBeUndefined();
  });

  it('sends an EMPTY list for a vault whose balance holds no public token', async () => {
    vaultBalance = new Map();
    /* RED WHEN an empty balance is sent as unreadable. */
    expect((await view()).body.publicBalances).toEqual([]);
  });

  it('says why, and sends no list, when the state carries no balance it can read, and keeps the rest of the view', async () => {
    const v = await view();
    /* RED WHEN an unreadable balance is sent as an empty list: a page would then show a funded vault as holding nothing. */
    expect(v.body.publicBalances).toBeUndefined();
    expect(v.body.publicBalancesWhy).toMatch(/carries no balance this client can read.*does not mean it is empty/su);
    /* RED WHEN one unreadable part refuses the whole view, which a handover and a deposit read too. */
    expect(v.body).toMatchObject({ onChain: true, notes: [hex(0x5a)] });
  });

  it('says only that it could not read it when the read fails some other way, and passes on no raw error', async () => {
    vaultBalance = new (class extends Map<unknown, bigint> {
      override [Symbol.iterator](): MapIterator<[unknown, bigint]> { throw new Error('iterator exploded at 0x1f'); }
    })();
    const v = await view();
    /* RED WHEN any exception's own message is sent to the page as the reason. */
    expect(v.body.publicBalances).toBeUndefined();
    expect(v.body.publicBalancesWhy).toBe('this service could not read what the vault holds in public money');
  });
});

describe('A COMMITTEE CHANGED AFTER A SIGNER JOINS OR LEAVES', () => {
  /* The vault and the account held by the committee the company had: ada alone. bo has since joined. */
  const behind = async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1)], threshold: 1 }, bornHeld: true });
    authority = { committee: [key(1)], threshold: 1, counter: 1n };
    accountAuthority = { committee: [key(1)], threshold: 1, counter: 1n };
  };
  const to = { committee: [key(1), key(2)], threshold: 2 };
  let assembled: Array<{ address: string; seats: number[] }>;
  /* The builder stood in: it checks nothing but counts seats, and a signature spelled 'bad' is one that does not verify. */
  const standIn = () => {
    assembled = [];
    assembleDep = async ({ read, signatures }) => {
      if (signatures.some((x) => x.signature.value === 'bad')) throw new Error('this signature does not verify against the key in seat 0.');
      const required = read.state === 'read' ? read.authority.threshold : 99;
      assembled.push({ address: read.address, seats: signatures.map((x) => x.seat) });
      return { have: signatures.length, required, seatsSigned: signatures.map((x) => x.seat), proven: signatures.length >= required ? new Uint8Array([0xcc]) : null };
    };
  };
  const sig = (address: string, counter = '1', seat = 0, value = 'ab') => ({ address, counter, seat, signature: { tag: 'schnorr', value } });
  const post = (as: string, body: unknown) => call('/api/accounts/acc_1/committee-change/signatures', as, 'POST', body);

  it('LISTS EVERY HANDED-OVER CONTRACT WHOSE COMMITTEE IS NOT THE COMPANY\'S, WITH THE COUNTER AND THE COMMITTEE THAT MUST SIGN', async () => {
    await behind();
    const r = await call('/api/accounts/acc_1/committee-change', 'ada');
    expect(r.status).toBe(200);
    /* RED WHEN: the account is left out - every vault pays out on it, so its committee must change too. */
    expect(r.body).toEqual({
      company: hex(0xc0), label: LABEL, to, why: null, notChangeable: [],
      contracts: [
        { contract: 'account', address: hex(0xc0), counter: '1', now: { committee: [key(1)], threshold: 1 }, signedSeats: [], required: 1 },
        { contract: 'vault', address: VAULT, counter: '1', now: { committee: [key(1)], threshold: 1 }, signedSeats: [], required: 1 },
      ],
    });
    expect((await call('/api/accounts/acc_1/committee-change', 'carol')).status).toBe(404);
  });

  it('SENDS EACH CHANGE ONCE ENOUGH HAVE SIGNED, READING IT AS A STRANGER\'S FIRST, AND KEEPS NOTHING BUT THE SIGNATURES', async () => {
    await behind();
    standIn();
    const checked: Array<string | null> = [];
    sendVault = async (_a, what, _arrival, _bytes, check) => {
      checked.push(await check({ intents: new Map([[1, { actions: [{ address: VAULT, counter: 1n, updates: [{ authority: { ...to, counter: 2n } }], signatures: [[0n, {}]] }] }]]) }));
      sent.push(what);
      return { ref: 'r', at: 'now', transactionHash: 'h' };
    };
    const r = await post('ada', { to, signatures: [sig(hex(0xc0)), sig(VAULT)] });
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: { address: string; state: string }) => [x.address, x.state])).toEqual([[hex(0xc0), 'sent'], [VAULT, 'sent']]);
    expect(sent).toEqual(['changing the company\'s account\'s committee to the company\'s', `changing vault ${VAULT}'s committee to the company's`]);
    /* RED WHEN: the fee is paid without `refusalForCommitteeChange` reading the transaction - the account's check then
     * reads the vault's shape as another contract's and must refuse it. */
    expect(checked[0]).toMatch(/changes a different contract/);
    expect(checked[1]).toBeNull();
    /* RED WHEN: anything but the seat and the signature is kept. */
    expect(store.getCommitteeSignatures(VAULT)).toEqual({
      accountId: 'acc_1', address: VAULT, counter: '1', to, signatures: [{ seat: 0, signature: { tag: 'schnorr', value: 'ab' } }],
    });
    /* A second press while the change could still land sends nothing. */
    const again = await post('ada', { to, signatures: [sig(VAULT)] });
    expect(again.body.results[0].state).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('KEEPS NO SIGNATURE AND SENDS NOTHING FOR A CONTRACT THE RECORD DOES NOT HOLD AS BORN HELD', async () => {
    await behind();
    standIn();
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1)], threshold: 1 } });
    accountNotBornHeld();
    const r = await post('ada', { to, signatures: [sig(hex(0xc0)), sig(VAULT)] });
    /* RED WHEN: a change to a contract created under some other key is collected and paid for. */
    expect(r.body.results.map((x: { state: string }) => x.state)).toEqual(['refused', 'refused']);
    expect(r.body.results[1].error).toMatch(/was not created here held by the company's committee/);
    expect(assembled).toEqual([]);
    expect(store.getCommitteeSignatures(VAULT)).toBeNull();
    expect(sent).toEqual([]);
    /* And the list of contracts owed a change names them as not changeable, never as owed. */
    const listed = (await call('/api/accounts/acc_1/committee-change', 'ada')).body;
    expect(listed.contracts).toEqual([]);
    expect(listed.notChangeable.map((c: { contract: string }) => c.contract)).toEqual(['account', 'vault']);
  });

  it('EACH CHANGE CARRIES THE STRICTEST BAR ITS CONTRACT ENFORCES: A VAULT ITS OWN, THE ACCOUNT THE HIGHEST OF ALL', async () => {
    await behind();
    const bars: Array<[string, number]> = [];
    assembleDep = async ({ read, strictestBar }) => {
      bars.push([read.address, strictestBar]);
      return { have: 0, required: 1, seatsSigned: [], proven: null };
    };
    acc1VaultThresholds = [{ vault: VAULT, threshold: 3 }, { vault: hex(0xdd), threshold: 4 }];
    await post('ada', { to, signatures: [sig(hex(0xc0)), sig(VAULT)] });
    /* RED WHEN: the account's bar ignores the vaults' own thresholds, or a vault's ignores its own row. */
    expect(bars).toEqual([[hex(0xc0), 4], [VAULT, 3]]);
    /* A vault with no row of its own needs the company's threshold, and so does the account. */
    acc1VaultThresholds = [];
    bars.length = 0;
    await post('ada', { to, signatures: [sig(hex(0xc0)), sig(VAULT)] });
    expect(bars).toEqual([[hex(0xc0), 2], [VAULT, 2]]);
  });

  it('WAITS FOR MORE SIGNERS, KEEPING EACH SEAT ONCE, AND SAYS HOW MANY HAVE SIGNED', async () => {
    await behind();
    authority = { committee: [key(1), key(3)], threshold: 2, counter: 4n };
    standIn();
    const first = await post('ada', { to, signatures: [sig(VAULT, '4', 0)] });
    expect(first.body.results[0]).toMatchObject({ state: 'waiting', have: 1, required: 2 });
    expect(sent).toEqual([]);
    const listed = await call('/api/accounts/acc_1/committee-change', 'ada');
    expect(listed.body.contracts.find((c: { contract: string }) => c.contract === 'vault').signedSeats).toEqual([0]);
    /* The same seat again replaces its own signature rather than counting twice. */
    await post('ada', { to, signatures: [sig(VAULT, '4', 0, 'cd')] });
    expect(assembled.at(-1)).toEqual({ address: VAULT, seats: [0] });
    const second = await post('bo', { to, signatures: [sig(VAULT, '4', 1)] });
    expect(second.body.results[0].state).toBe('sent');
    expect(assembled.at(-1)!.seats.sort()).toEqual([0, 1]);
  });

  it('REFUSES A COMMITTEE THAT IS NOT THE COMPANY\'S, A CONTRACT THAT IS NOT ITS, A COUNTER THE CHAIN HAS MOVED PAST, AND A SIGNATURE THAT DOES NOT VERIFY', async () => {
    await behind();
    standIn();
    /* RED WHEN: the service installs whatever committee the request names. */
    const other = await post('ada', { to: { committee: [key(1), key(3)], threshold: 2 }, signatures: [sig(VAULT)] });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ nothingWasSent: true });
    const results = (await post('ada', { to, signatures: [sig(hex(0xee)), sig(VAULT, '0'), sig(hex(0xc0), '1', 0, 'bad')] })).body.results;
    expect(results.map((x: { state: string }) => x.state)).toEqual(['refused', 'refused', 'refused']);
    expect(results[0].error).toMatch(/no contract at that address/);
    expect(results[1].error).toMatch(/has been changed since these signatures were made/);
    expect(results[2].error).toMatch(/does not verify/);
    /* Nothing kept, nothing sent. */
    expect(store.getCommitteeSignatures(VAULT)).toBeNull();
    expect(store.getCommitteeSignatures(hex(0xc0))).toBeNull();
    expect(sent).toEqual([]);
    expect((await post('ada', { to, signatures: [{ ...sig(VAULT), signingKey: 'ab' }] })).status).toBe(400);
    expect((await post('carol', { to, signatures: [sig(VAULT)] })).status).toBe(404);
  });

  it('SIGNATURES KEPT FOR A COUNTER THE CHAIN HAS MOVED PAST ARE NEVER REPORTED OR USED', async () => {
    await behind();
    authority = { committee: [key(1), key(3)], threshold: 2, counter: 4n };
    standIn();
    await post('ada', { to, signatures: [sig(VAULT, '4', 0)] });
    authority = { committee: [key(1), key(3)], threshold: 2, counter: 5n };
    const listed = await call('/api/accounts/acc_1/committee-change', 'ada');
    expect(listed.body.contracts.find((c: { contract: string }) => c.contract === 'vault')).toMatchObject({ counter: '5', signedSeats: [] });
    await post('bo', { to, signatures: [sig(VAULT, '5', 1)] });
    /* RED WHEN: a signature made against counter 4 is put on the change against counter 5. */
    expect(assembled.at(-1)).toEqual({ address: VAULT, seats: [1] });
  });

  it('SIGNATURES KEPT FOR A COMMITTEE THE COMPANY NO LONGER HAS ARE NEVER REPORTED OR USED', async () => {
    await behind();
    authority = { committee: [key(1), key(3)], threshold: 2, counter: 4n };
    standIn();
    await post('ada', { to, signatures: [sig(VAULT, '4', 0)] });
    /* Another signer joins before the change is sent: same counter, a different committee to install. */
    store.putAccount(account({ signerCount: 3, memberUserIds: ['ada', 'bo', 'cy'] }));
    await give('cy', 5);
    acc1Threshold = 2;
    const next = { committee: [key(1), key(2), key(5)], threshold: 2 };
    const listed = await call('/api/accounts/acc_1/committee-change', 'ada');
    expect(listed.body.to).toEqual(next);
    /* RED WHEN: ada's signature on the old committee is reported as given - her device would never be asked again,
     * and it can never verify against the new change, so the contract would wait for good. */
    expect(listed.body.contracts.find((c: { contract: string }) => c.contract === 'vault').signedSeats).toEqual([]);
    await post('bo', { to: next, signatures: [sig(VAULT, '4', 1)] });
    expect(assembled.at(-1)).toEqual({ address: VAULT, seats: [1] });
  });

  it('A VAULT ANOTHER COMPANY HOLDS IS NOT THIS COMPANY\'S, AND A SEND THAT SENT NOTHING FREES THE CONTRACT FOR ANOTHER', async () => {
    await behind();
    standIn();
    store.putCompanyVault({ accountId: 'acc_2', vault: hex(0xaa), deployedAt: '', deployRef: 'r', intended: to, bornHeld: true });
    /* RED WHEN: a vault is taken as this company's because it is some company's. */
    const theirs = await post('ada', { to, signatures: [sig(hex(0xaa))] });
    expect(theirs.body.results[0]).toMatchObject({ state: 'refused', error: 'this company has no contract at that address.' });
    sendVault = async () => { throw new NothingWasSent('the fee payer could not pay. Nothing was sent.'); };
    expect((await post('ada', { to, signatures: [sig(VAULT)] })).body.results[0]).toMatchObject({ state: 'refused', nothingWasSent: true });
    sendVault = async (_a, what) => { sent.push(what); return { ref: 'r', at: 'now', transactionHash: 'h' }; };
    /* RED WHEN: a send that sent nothing leaves the contract marked as sent, and the next press does nothing. */
    expect((await post('ada', { to, signatures: [sig(VAULT)] })).body.results[0]).toMatchObject({ state: 'sent', txRef: 'r' });
    expect(sent).toHaveLength(1);
  });

  it('TWO SIGNERS WHOSE SIGNATURES EACH COMPLETE THE CHANGE, ARRIVING TOGETHER, SEND IT ONCE', async () => {
    await behind();
    authority = { committee: [key(1), key(2)], threshold: 1, counter: 1n };
    standIn();
    const slow = assembleDep!;
    /* The builder takes a moment, as proving does, so both requests are inside it at once. */
    assembleDep = async (input) => { await new Promise((r) => setTimeout(r, 20)); return slow(input); };
    const [a, b] = await Promise.all([
      post('ada', { to, signatures: [sig(VAULT, '1', 0)] }), post('bo', { to, signatures: [sig(VAULT, '1', 1)] }),
    ]);
    /* RED WHEN: the two are put together and sent side by side - the chain charges for the second and refuses it. */
    expect(sent.filter((w) => w.includes(VAULT))).toHaveLength(1);
    expect([a.body.results[0].state, b.body.results[0].state]).toEqual(['sent', 'sent']);
  });

  it('A CONTRACT BORN HELD IS FUNDED AT ANY COUNTER, AND ONE THE RECORD DOES NOT HOLD AS BORN HELD AT NONE', async () => {
    await give('ada', 1); await give('bo', 2);
    const rows = async () => (await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0];
    /* Changed twice since its deploy, every change signed by the committee then holding it: no history is read. */
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: to, bornHeld: true });
    authority = { ...to, counter: 2n };
    /* RED WHEN: a born-held vault changed more than once is refused for want of a history. */
    expect(await rows()).toMatchObject({ state: 'held-by-committee', why: null });
    authority = { ...to, counter: 0n };
    expect(await rows()).toMatchObject({ state: 'held-by-committee', why: null });
    /* The same chain, and a record written without the born-held reader: refused at every counter. */
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: to });
    for (const counter of [0n, 1n, 2n]) {
      authority = { ...to, counter };
      /* RED WHEN: counter 1 is funded with no record of how the vault was created. */
      expect((await rows()).why, String(counter)).toMatch(/were not read by this service at their creation/);
    }
    /* A second company's deploy at this address, or a second deploy for this company, is never recorded over the first. */
    expect(store.recordAccountDeploy({ accountId: 'acc_2', address: hex(0xc0), foundingKey: key(1), deploy: '', insert: '', recordedAt: '' })).toBe(false);
    expect(store.recordAccountDeploy({ accountId: 'acc_1', address: hex(0xc9), foundingKey: key(1), deploy: '', insert: '', recordedAt: '' })).toBe(false);
    /* And the account: with no record of it created from its founding signer's browser, every vault is refused. */
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: to, bornHeld: true });
    authority = { ...to, counter: 1n };
    expect(await rows()).toMatchObject({ state: 'held-by-committee', why: null });
    delete (store as unknown as { data: { accountDeploys: Record<string, unknown> } }).data.accountDeploys['acc_1'];
    /* RED WHEN: an account created under any other key is funded because the chain shows the committee now. */
    expect((await rows()).why).toMatch(/the rules of this company's account, which every vault pays out on, were not read by this service at their creation/);
    /* RED WHEN: a record of some other address stands for the account the chain names. */
    store.recordAccountDeploy({ accountId: 'acc_1', address: hex(0xc9), foundingKey: key(1), deploy: '', insert: '', recordedAt: '' });
    expect((await rows()).why).toMatch(/which every vault pays out on, were not read by this service at their creation/);
  });
});

describe('A PUBLIC DEPOSIT\'S ROUTE', () => {
  const TOKEN_ASKED = 'cd'.repeat(32);
  const vaultHeld = async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
  };
  const publicDeposit = (body: Record<string, unknown> = { tx: 'AAAA', token: TOKEN_ASKED, amount: '900' }) =>
    call(`/api/accounts/acc_1/vaults/${VAULT}/public-deposit`, 'ada', 'POST', body);

  it('IS SENT ONLY FOR A VAULT AND AN ACCOUNT THE COMMITTEE HOLDS ON THE CHAIN NOW, AND READ AS A PUBLIC DEPOSIT OF THE TOKEN AND AMOUNT ASKED', async () => {
    const checks: Array<(tx: unknown) => unknown> = [];
    sendVault = async (_a, what, _arrival, _bytes, check) => { sent.push(what); checks.push(check); return { ref: 'r', at: 'now', transactionHash: 'h' }; };
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    /* RED WHEN: the route stops reading the vault's authority from the chain before it pays a fee. */
    const notHeld = await publicDeposit();
    expect(notHeld).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(notHeld.body.error).toMatch(/its committee is changed to match in Settings/);
    /* RED WHEN: the route stops asking whether the company's account is held by the committee too. */
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    serviceKey = key(9);
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    expect(await publicDeposit()).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(sent).toEqual([]);
    serviceKey = undefined;
    accountAuthority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    expect(await publicDeposit()).toMatchObject({ status: 200, body: { txRef: 'r', transactionHash: 'h' } });
    expect(sent).toEqual(['a public deposit into a vault']);
    /* RED WHEN: the route sends with any reader but the public deposit's, or one not told the token and amount asked. */
    expect(await checks[0]!({})).toMatch(/^this is not this company's public deposit into this vault/);
  });

  it('A BODY THAT DOES NOT NAME ONE PUBLIC TOKEN AND A WHOLE AMOUNT, OR CARRIES ANYTHING ELSE, IS REFUSED BEFORE ANYTHING IS READ', async () => {
    await vaultHeld();
    for (const [why, body] of [
      ['no token', { tx: 'AAAA', amount: '900' }],
      ['no amount', { tx: 'AAAA', token: TOKEN_ASKED }],
      ['a token that is not one', { tx: 'AAAA', token: 'CD'.repeat(32), amount: '900' }],
      ['an amount of nothing', { tx: 'AAAA', token: TOKEN_ASKED, amount: '0' }],
      ['an amount that is not whole', { tx: 'AAAA', token: TOKEN_ASKED, amount: '9.5' }],
      ['something else as well', { tx: 'AAAA', token: TOKEN_ASKED, amount: '900', vault: 'ee'.repeat(32) }],
      ['no transaction', { token: TOKEN_ASKED, amount: '900' }],
    ] as const) {
      expect(await publicDeposit(body), why).toMatchObject({ status: 400, body: { nothingWasSent: true } });
    }
    expect(sent).toEqual([]);
  });

  it('A VAULT THIS COMPANY DID NOT CREATE IS NOT THIS COMPANY\'S', async () => {
    store.putCompanyVault({ accountId: 'acc_2', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [], threshold: 1 }, bornHeld: true });
    expect((await publicDeposit()).status).toBe(404);
    expect(sent).toEqual([]);
  });
});

describe('A VAULT\'S START', () => {
  /* One call, as the ledger names its parts, to `address`'s `circuit`. */
  const oneCall = (address: string, ...circuits: string[]) => ({
    intents: new Map([[1, { actions: circuits.map((c) => ({ address, entryPoint: new TextEncoder().encode(c) })) }]]),
  });
  const START = Buffer.from([0xcc]).toString('base64');
  const at = (route: string) => `/api/accounts/acc_1/vaults/${VAULT}/start/${route}`;
  const checked = () => {
    sendVault = async (_a, what, _arr, bytes, check, read) => {
      const refusal = await check(await read(bytes));
      if (refusal !== null) throw new NothingWasSent(refusal);
      sent.push(what);
      return { ref: 'r', at: 'now', transactionHash: null };
    };
  };
  const heldVault = async () => {
    await give('ada', 1); await give('bo', 2);
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [], threshold: 2 }, bornHeld: true });
    startedNow = false;
    checked();
  };

  it('IS SENT ONLY FOR A VAULT THIS COMPANY\'S COMMITTEE HOLDS, READ FROM THE CHAIN NOW', async () => {
    await heldVault();
    authority = { committee: [key(9)], threshold: 1, counter: 0n };
    startShape = oneCall(hex(0xc0), 'adopt');
    const r = await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'adopt' });
    /* RED WHEN: a step of a start is paid for on a vault its temporary key still holds. */
    expect(r).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(sent).toEqual([]);
  });

  it('SENDS EACH STEP ONCE: A SECOND COPY WHILE THE FIRST MAY STILL LAND IS REFUSED, AN APPROVAL ONCE PER PERSON', async () => {
    await heldVault();
    startShape = oneCall(hex(0xc0), 'adopt');
    expect((await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'adopt' })).status).toBe(200);
    /* RED WHEN: the same step is sent twice, and the second fee is paid for a refusal. */
    expect(await call(at('account'), 'bo', 'POST', { tx: START, step: 'adoption', call: 'adopt' }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true } });
    startShape = oneCall(hex(0xc0), 'approve');
    expect((await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'approve' })).status).toBe(200);
    /* Another signer's approval of the same round is theirs to send. */
    expect((await call(at('account'), 'bo', 'POST', { tx: START, step: 'adoption', call: 'approve' })).status).toBe(200);
    expect(await call(at('account'), 'bo', 'POST', { tx: START, step: 'adoption', call: 'approve' }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(sent).toEqual(['adopting this vault', 'approving the adoption of this vault', 'approving the adoption of this vault']);
  });

  it('REFUSES A TRANSACTION THAT IS NOT WHAT THE ROUTE SAYS, AND A REFUSAL FREES THE STEP FOR ANOTHER TRY', async () => {
    await heldVault();
    /* RED WHEN: the route pays for another circuit, or a call on another account, than the step it was sent as. */
    startShape = oneCall(hex(0xc0), 'adopt');
    expect(await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'propose' }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true } });
    startShape = oneCall(hex(0xc1), 'propose');
    expect(await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'propose' }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true } });
    startShape = oneCall(hex(0xc0), 'propose');
    expect((await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'propose' })).status).toBe(200);
    expect((await call(at('account'), 'ada', 'POST', { tx: START, step: 'secret-run', call: 'adopt' })).status).toBe(400);
    expect(sent).toEqual(['raising the adoption of this vault']);
  });

  it('SETS A FIRST SECRET ONLY WHILE THE VAULT HOLDS NONE, AND WRITES A COPY ONLY WHILE ONE IS STILL OWED', async () => {
    await heldVault();
    startShape = oneCall(hex(0xc0), 'approveVaultChange');
    (startShape as { intents: Map<number, { actions: unknown[] }> }).intents.get(1)!.actions.push({ address: VAULT, entryPoint: 'setNonceSecret' });
    secretNow = '5e'.repeat(32);
    /* RED WHEN: a first secret is sent for a vault that holds one already. */
    expect((await call(at('secret'), 'ada', 'POST', { tx: START })).body.error).toMatch(/already holds a secret/);
    secretNow = '00'.repeat(32);
    expect((await call(at('secret'), 'ada', 'POST', { tx: START })).status).toBe(200);
    startShape = oneCall(VAULT, 'writeSecretCopy');
    expect((await call(at('copy'), 'ada', 'POST', { tx: START, place: 0 })).status).toBe(200);
    expect((await call(at('copy'), 'ada', 'POST', { tx: START, place: 0 })).status).toBe(409);
    expect((await call(at('copy'), 'ada', 'POST', { tx: START, place: 1 })).status).toBe(200);
    startedNow = true;
    /* RED WHEN: a copy is paid for once every copy is written. */
    expect((await call(at('copy'), 'ada', 'POST', { tx: START, place: 2 })).body.error).toMatch(/already written/);
    expect(sent).toEqual(['setting this vault\'s first secret', 'writing a sealed copy of this vault\'s secret', 'writing a sealed copy of this vault\'s secret']);
  });

  it('A VAULT HELD BY THE COMMITTEE AND NOT STARTED IS SAID AS ITS START OWED, AND TAKES NO DEPOSIT', async () => {
    await heldVault();
    const view = await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada');
    /* RED WHEN: a vault not started is read as not held, so its handover would be sent again. */
    expect(view.body).toMatchObject({ heldByCommittee: true, started: false, fundable: false });
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows).toEqual([expect.objectContaining({ vault: VAULT, state: 'start-owed' })]);
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true } });
  });
});

import { schnorr } from '@noble/curves/secp256k1.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../core/store.js';
import type { SealedAccount } from '../core/types.js';
import { NothingWasSent } from '../core/jobs.js';
import { FeeNotPaid, NetworkRefused, WalletFeeSponsor } from '../midnight/sponsor.js';
import { ChainLedger } from '../wiring/chain.js';

/**
 * The real lane and the real fee payer over a wallet whose first hand-in the node refuses for its spend proof and
 * whose second balance cannot be made, as `sendVault` for a route. Each read transaction is taken as finished, so
 * the stand-in shapes the routes read are handed to the fee payer as they are.
 */
const aRefusedSpendProofThatCannotBePaidAgain = (): CompanyVaultDeps['ledger']['sendVault'] => {
  const refusal = Object.assign(new Error('Transaction submission error'), {
    cause: { code: 1010, message: '1010: Invalid Transaction: Custom error: 170', data: 'Custom error: 170' },
  });
  let balanced = 0;
  const payer = new WalletFeeSponsor({
    shieldedSecretKeys: 's', dustSecretKey: 'd',
    balanceFinalizedTransaction: async (tx: unknown) => { balanced += 1; if (balanced > 1) throw new Error('could not balance dust'); return { tx }; },
    finalizeRecipe: async () => ({ intents: new Map(), transactionHash: () => 'h1' }),
    submitTransaction: async () => { throw refusal; },
    revert: async () => {},
    estimateFee: async () => 1n,
    paidFee: async () => null,
    balances: async () => ({ dust: 1n, night: 1n }),
  }, { perTransaction: 1_000n });
  const ledger = new ChainLedger({} as never, { network: 'stagenet', indexerUrl: 'x', indexerWsUrl: 'x' } as never, {
    maintenanceAuthority: { kind: 'unmaintainable' } as never, compiled: {},
    customer: { coinPublicKey: () => '', encryptionPublicKey: () => '', release: async () => {}, balanceOwnLegs: async () => null },
    sponsor: payer as never, storagePassword: async () => 'x',
  });
  return (accountId, what, _arrival, bytes, check, read) =>
    ledger.sendVault(accountId, what, 'finished-by-the-depositor', bytes, check, read);
};

/**
 * The real lane and the real fee payer, with the fee payer's two steps counted, as `sendVault` for a route: the
 * route's own check runs inside `sendVault` before the fee is added, so a refused transaction leaves both counts at
 * nothing.
 */
const aFeePayerThatCountsWhatItIsAskedFor = (): { sendVault: CompanyVaultDeps['ledger']['sendVault']; asked: string[] } => {
  const asked: string[] = [];
  const payer = new WalletFeeSponsor({
    shieldedSecretKeys: 's', dustSecretKey: 'd',
    balanceFinalizedTransaction: async (tx: unknown) => ({ tx }),
    finalizeRecipe: async () => ({ intents: new Map(), transactionHash: () => 'h1' }),
    submitTransaction: async () => 'h1',
    revert: async () => {},
    estimateFee: async () => 1n,
    paidFee: async () => null,
    balances: async () => ({ dust: 1n, night: 1n }),
  }, { perTransaction: 1_000n });
  const addFee = payer.addFeeAndFinalise.bind(payer);
  const submit = payer.submit.bind(payer);
  payer.addFeeAndFinalise = async (tx, ttl) => { asked.push('addFeeAndFinalise'); return addFee(tx, ttl); };
  payer.submit = async (tx) => { asked.push('submit'); return submit(tx); };
  const ledger = new ChainLedger({} as never, { network: 'stagenet', indexerUrl: 'x', indexerWsUrl: 'x' } as never, {
    maintenanceAuthority: { kind: 'unmaintainable' } as never, compiled: {},
    customer: { coinPublicKey: () => '', encryptionPublicKey: () => '', release: async () => {}, balanceOwnLegs: async () => null },
    sponsor: payer as never, storagePassword: async () => 'x',
  });
  return { sendVault: (accountId, what, arrival, bytes, check, read) => ledger.sendVault(accountId, what, arrival, bytes, check, read), asked };
};
import { companyVaultRoutes, vaultState, type CompanyVaultDeps } from './company-vaults.js';
import type { VaultKey } from '../core/vault-keys.js';

/*
 * The company-vault routes' own refusals, with the chain and the fee payer
 * stood in. The whole path, with the ledger's own state machine, is
 * `contracts/test/a-company-vault-from-the-page.test.ts`.
 */
/** Wallet key `n`: the x-only public key of a secret made of one repeated byte, a key the chain builds a committee with. */
const key = (n: number) => ({ tag: 'schnorr' as const, value: Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(n))).toString('hex') });
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
/* The vaults the company's account lists on the chain now, adopted or retired. */
let listedNow: string[];
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
let serviceKey: { tag: string; value: string } | undefined;
let acc1Threshold = 2;
/** How many seats the chain holds on the first company's account. */
let acc1Seats: number | null = 2;
let acc1VaultThresholds: Array<{ vault: string; threshold: number }> = [];
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
/* The routes' own dependencies, so a test can start a second process of the same service over the same store. */
let routeDeps: CompanyVaultDeps;
/* The vault's public balance as its state carries it; absent unless a test sets it. */
let vaultBalance: unknown;
/* What a transaction its depositor finished reads as; nothing but an empty shape unless a test sets it. */
let finishedShape: unknown;
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
  serviceKey = undefined;
  acc1Threshold = 2;
  acc1Seats = 2;
  acc1VaultThresholds = [];
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
  listedNow = [VAULT];
  startingLedgerUnreadable = false;
  ledgerIsThisBuilds = async () => {};
  assembleDep = undefined;
  vaultBalance = undefined;
  finishedShape = {};
  sendVault = async (_a, what) => { sent.push(what); return { ref: 'r', at: 'now', transactionHash: 'h' }; };
  const app = express();
  app.use(companyVaultRoutes(routeDeps = {
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
    company: async (id) => (id === 'acc_1' && acc1Seats === null ? null : id === 'acc_1'
      ? { address: hex(0xc0), threshold: acc1Threshold, seats: acc1Seats!, vaultThresholds: acc1VaultThresholds }
      : { address: hex(0xc1), threshold: 1, seats: 1, vaultThresholds: [] }),
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
      accountVaults: async (address) => {
        if (accountUnreachable) throw new Error('the indexer did not answer');
        return address === hex(0xc0) ? listedNow : [];
      },
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
      get temporaryKey() { return serviceKey; },
    },
    readers: {
      proven: async (b) => (b[0] === 0xdd ? payoutShape : b[0] === 0xcc ? startShape : deployShape ? aDeploy() : {}),
      finished: async () => finishedShape,
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
 * **AN ACCOUNT CREATED THE OLD WAY**, under this service's temporary key: the record holds no deploy from its
 * founding signer's browser, so nothing is funded on it.
 */
const accountNotBornHeld = () => {
  delete (store as unknown as { data: { accountDeploys: Record<string, unknown> } }).data.accountDeploys['acc_1'];
};
/** A member's vault keys, folded into the roster as a seat's device folds them, and the index filed with it: records keys only. */
const give = async (as: string, n: number): Promise<void> => {
  roster.set(`acc_1:${as}`, { committeeKey: key(n), recordsKey: hex(n + 0x10) });
  const mine = [...roster.values()];
  store.putVaultKeyIndex({
    accountId: 'acc_1', signerCount: store.getAccount('acc_1')!.signerCount,
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

  it('the committee is the one holding the company\'s account on the chain, whoever has given vault keys', async () => {
    /* RED WHEN: the committee is made from the signers' vault keys again - a signer joining or leaving would then change
     * which committee a vault is born held by. */
    let k = await call('/api/accounts/acc_1/vault-keys', 'ada');
    expect(k.body.committee).toEqual({ committee: [key(1), key(2)], threshold: 2 });
    /* RED WHEN: the answer says which key is whose - the service then tells anybody who asks. */
    expect(Object.keys(k.body).sort()).toEqual(['committee', 'readers', 'why']);
    await give('ada', 1); await give('bo', 2);
    accountAuthority = { committee: [key(7)], threshold: 1, counter: 4n };
    k = await call('/api/accounts/acc_1/vault-keys', 'ada');
    expect(k.body.committee).toEqual({ committee: [key(7)], threshold: 1 });
    expect(k.body.readers.sort()).toEqual([hex(0x11), hex(0x12)]);
    /* RED WHEN: an account the chain does not answer for is given a committee anyway. */
    accountUnreachable = true;
    k = await call('/api/accounts/acc_1/vault-keys', 'ada');
    expect(k.body.committee).toBeNull();
    expect(k.body.why).toMatch(/could not be asked who holds this company's account/);
  });

  it('the readers are given only while the key index counts the seats the chain holds, whatever the service\'s own count says', async () => {
    await give('ada', 1); await give('bo', 2);
    /* RED WHEN: the route compares the index with the service's own count of signers: it would give readers here. */
    store.putAccount(account({ signerCount: 2 }));
    acc1Seats = 3;
    expect((await call('/api/accounts/acc_1/vault-keys', 'ada')).body.readers).toEqual([]);
    /* RED WHEN: the route reads the service's own count, which says 3 here while the chain holds 2: it would hold the readers back. */
    store.putAccount(account({ signerCount: 3 }));
    acc1Seats = 2;
    expect((await call('/api/accounts/acc_1/vault-keys', 'ada')).body.readers.sort()).toEqual([hex(0x11), hex(0x12)]);
    /* RED WHEN: the readers are given where the chain could not be asked how many seats the company holds. */
    acc1Seats = null;
    expect((await call('/api/accounts/acc_1/vault-keys', 'ada')).body.readers).toEqual([]);
  });

  it('an account still held by this service\'s temporary key has no committee', async () => {
    /* RED WHEN: the service's own key is offered as the committee a vault is born held by. */
    serviceKey = key(9);
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    const k = await call('/api/accounts/acc_1/vault-keys', 'ada');
    expect(k.body.committee).toBeNull();
    expect(k.body.why).toMatch(/still held by the temporary key/);
  });
});

describe('A VAULT\'S ROUTES', () => {
  it('NO COMMITTEE, NO DEPLOY: refused before anything is read or sent', async () => {
    /* RED WHEN: a vault is deployed while no committee holds the company's account on the chain. */
    accountUnreachable = true;
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

  it('WHOEVER HOLDS THE VAULT ON THE CHAIN, A DEPOSIT GOES IN; A VAULT THE CHAIN DOES NOT ANSWER FOR TAKES NONE', async () => {
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    /* RED WHEN: the funding gate compares who holds the vault with any committee - a change of the super admins that has
     * not reached this vault yet would then stop money. */
    const paid = await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });
    expect(paid).toMatchObject({ status: 200, body: { txRef: 'r', transactionHash: 'h' } });
    expect(sent).toEqual(['a deposit into a vault']);
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows).toEqual([
      expect.objectContaining({ vault: VAULT, state: 'held-by-committee' }),
    ]);
    /* RED WHEN: the gate reads who holds the vault or the account - a contract whose maintenance authority cannot be
     * read would then stop money. */
    authority = undefined;
    accountAuthority = undefined;
    const unheld = await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });
    expect(unheld).toMatchObject({ status: 200, body: { txRef: 'r' } });
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('held-by-committee');
    vaultReadFails = () => true;
    const unread = await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });
    expect(unread).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(unread.body.error).toMatch(/could not be asked/);
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('unknown');
  });

  it('A SIGNER JOINING OR LEAVING STOPS NO PAYMENT, IN OR OUT', async () => {
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    await give('ada', 1); await give('bo', 2);
    /* A third signer seated: the roster's index no longer has every signer's keys. */
    store.putAccount(account({ signerCount: 3 }));
    /* RED WHEN: a payment reads the signers or their vault keys - a signer joining then stops it. */
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' })).status).toBe(200);
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', { tx: '3Q==' })).status).toBe(200);
    /* And one leaving. */
    store.putAccount(account({ signerCount: 1 }));
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/merge`, 'ada', 'POST', { tx: '3Q==' })).status).toBe(200);
    /* RED WHEN: the chain view of a vault carries a verdict on money, which only a device's own read answers. */
    const view = (await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada')).body;
    expect(view).toMatchObject({ onChain: true, started: true });
    expect(view).not.toHaveProperty('fundable');
    expect(view).not.toHaveProperty('why');
  });

  it('A CHANGE OF THE SUPER ADMINS LANDED ON THE ACCOUNT AND NOT YET ON THE VAULT STOPS NO PAYMENT', async () => {
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    accountAuthority = { committee: [key(3), key(4)], threshold: 2, counter: 2n };
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    /* RED WHEN: the funding or payout gate compares the vault's committee with the account's. */
    for (const [path, tx] of [['deposit', 'AAAA'], ['payout', '3Q=='], ['merge', '3Q=='], ['public-payout', '3Q==']] as const) {
      expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/${path}`, 'ada', 'POST', { tx })).status, path).toBe(200);
    }
    const view = (await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada')).body;
    expect(view).toMatchObject({ onChain: true, started: true });
    expect(view).not.toHaveProperty('fundable');
    expect(view).not.toHaveProperty('why');
    /* RED WHEN: the view a device reads before a deposit, a payment out or a vault's start reads who holds the vault or
     * the account. */
    expect(Object.keys(view).filter((k) => ['authority', 'committee', 'committeeWhy', 'heldByCommittee'].includes(k))).toEqual([]);
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
    /* RED WHEN: the chain view says why money is refused, so a page could read the service's verdict in place of its own. */
    expect(view.body).toMatchObject({ onChain: true });
    expect(view.body).not.toHaveProperty('fundable');
    expect(view.body).not.toHaveProperty('why');
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows).toEqual([
      expect.objectContaining({ vault: VAULT, state: 'not-fundable', why: expect.stringMatching(/'payout' circuit/) }),
    ]);
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
      expect(view.body).not.toHaveProperty('fundable');
      expect(view.body).not.toHaveProperty('why');
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
   * **A STATE READ THAT FAILS IS NOT AN ALARM.** The list and every door read
   * the vault's state once, for everything the gate asks. When that read
   * fails, the chain has not said anything is wrong with the vault: the screen
   * shows that it could not be asked, and the doors still refuse. RED WHEN: a
   * failed state read is answered as a refusal about the vault rather than put
   * to the gate as a read that went unanswered.
   */
  it('A STATE READ THAT FAILS SHOWS AS UNKNOWN, NOT AS AN ALARM, AND STILL SENDS NOTHING', async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('held-by-committee');
    /* Every read of the vault's state fails. */
    vaultReads = 0;
    vaultReadFails = () => true;
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
  it('A VAULT NOT STARTED, OR WHOSE ACCOUNT IS NOT VOUCHED, IS REFUSED A DEPOSIT AND A PAYMENT OUT IN THE SERVICE\'S OWN WORDS, AND ITS CHAIN VIEW GIVES NO REASON', async () => {
    await give('ada', 1); await give('bo', 2);
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    startedNow = false;
    const notStarted = await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada');
    /* RED WHEN: the chain view carries a reason or a verdict again, or stops saying the vault is not started. */
    expect(notStarted.body).toMatchObject({ onChain: true, started: false });
    expect(notStarted.body).not.toHaveProperty('fundable');
    expect(notStarted.body).not.toHaveProperty('why');
    /* RED WHEN: the service sends a deposit or a payment out of a vault that is not started. */
    const deposit = await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });
    expect(deposit).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(deposit.body.error).toMatch(/^no money goes into this vault: /);
    const payout = await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', { tx: '3Q==' });
    expect(payout).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(payout.body.error).toMatch(/^this service pays no fee for a payment out of this vault: /);
    startedNow = true;
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
    /* The vault is the committee's; the account it pays out on is not one the record holds as born held. */
    accountNotBornHeld();
    const unvouched = await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada');
    expect(unvouched.body).not.toHaveProperty('fundable');
    expect(unvouched.body).not.toHaveProperty('why');
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' })).status).toBe(409);
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/payout`, 'ada', 'POST', { tx: '3Q==' })).status).toBe(409);
    expect(sent).toEqual([]);
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

  /* RED WHEN: a vault's deploy is kept as bytes nothing reads, or served back. */
  it('A DEPLOY THAT MAY HAVE LANDED IS STILL RECORDED, BORN HELD, SO IT IS NEVER LOST, WITHOUT ITS BYTES; ONE REFUSED IS NOT', async () => {
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
      expect.objectContaining({ vault: VAULT, deployRef: 'unknown', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true }),
    ]);
    expect(store.listCompanyVaults('acc_1')[0]).not.toHaveProperty('deploy');
    /* The same vault again is refused before anything is sent. */
    const again = await call('/api/accounts/acc_1/vaults', 'ada', 'POST', { tx: 'AAAA' });
    expect(again).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    expect(again.body.error).toMatch(/already recorded/);
    expect(sent).toEqual(['deploying a vault']);
    /* A deploy the check refuses records nothing. */
    deployShape = false;
    store = new MemoryStore();
  });

  /*
   * RED WHEN: a deploy whose fee could not be paid again after a refused spend proof is recorded as a vault that may
   * have landed, so the company lists a vault the chain never held and its bytes can never be sent again.
   */
  it('A DEPLOY WHOSE FEE COULD NOT BE PAID AGAIN AFTER A REFUSED SPEND PROOF IS NOTHING SENT, AND NOTHING IS RECORDED', async () => {
    await give('ada', 1); await give('bo', 2);
    deployShape = true;
    sendVault = aRefusedSpendProofThatCannotBePaidAgain();
    const r = await call('/api/accounts/acc_1/vaults', 'ada', 'POST', { tx: 'AAAA' });
    expect(r).toMatchObject({ status: 422, body: { nothingWasSent: true, code: 'fee-not-paid' } });
    expect(store.listCompanyVaults('acc_1')).toEqual([]);
  });

  /*
   * RED WHEN: a private deposit that shows which token it moves and how much is handed to the fee payer - the route
   * stops checking what the deposit states, or the ledger stops running the route's check before the fee is added.
   */
  it('A PRIVATE DEPOSIT THAT SHOWS WHICH TOKEN IT MOVES AND HOW MUCH IS REFUSED BEFORE THE FEE PAYER SEES IT', async () => {
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    const payer = aFeePayerThatCountsWhatItIsAskedFor();
    sendVault = payer.sendVault;
    /* One call to this vault's deposit, nothing public and no fee of its own, whose offer states 500 of one token. */
    finishedShape = {
      intents: new Map([[1, { actions: [{ address: VAULT, entryPoint: 'deposit' }] }]]),
      guaranteedOffer: { deltas: new Map([[hex(0x01), 500n]]) },
    };
    const r = await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });
    expect(r).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    expect(r.body.error).toMatch(/could have seen which token it moves and how much/);
    expect(payer.asked).toEqual([]);
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
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    authority = { committee: [key(1), key(2)], threshold: 2, counter: 1n };
  };
  const deposit = () => call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' });

  it('NO MONEY GOES IN ON AN ACCOUNT THIS SERVICE DID NOT READ AT ITS CREATION AS HELD FROM ITS FIRST TRANSACTION', async () => {
    /* RED WHEN: the account's half of the gate stops asking this service's record of the account's creation - an
     * account this service's own temporary key holds is then funded. */
    await vaultHeld();
    accountNotBornHeld();
    serviceKey = key(9);
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    const refused = await deposit();
    expect(refused).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(refused.body.error).toMatch(/account, which every vault pays out on, were not read by this service at their creation/);
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows).toEqual([
      expect.objectContaining({ vault: VAULT, state: 'account-not-fundable' }),
    ]);
    /* No committee holds the account, so the vault is held by none the account has, and no money moves. */
    const view = await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada');
    expect(view.body).not.toHaveProperty('fundable');
    expect(sent).toEqual([]);
  });

  it('A BORN-HELD ACCOUNT IS FUNDED WHOEVER HOLDS IT NOW; NOT WHILE IT RUNS OTHER CIRCUITS OR CANNOT BE READ', async () => {
    await vaultHeld();
    /* RED WHEN: the gate compares who holds the account with any committee - a change of the super admins then stops money. */
    accountAuthority = { committee: [key(1), key(3)], threshold: 2, counter: 1n };
    expect((await deposit()).status).toBe(200);
    accountAuthority = { committee: [key(1), key(2)], threshold: 2, counter: 2n };
    expect((await deposit()).status).toBe(200);
    sent.length = 0;
    /* RED WHEN: the account's circuits stop being compared. */
    accountKeys = (c) => (c === 'recordPaymentFromVault' ? new TextEncoder().encode('vk:drain') : vkOf(c));
    expect((await deposit()).body.error).toMatch(/'recordPaymentFromVault' circuit is not the one this service's build compiled/);
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('account-not-fundable');
    accountKeys = vkOf;
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('held-by-committee');
    /* RED WHEN: an unreachable account is read as ready. */
    accountUnreachable = true;
    expect((await deposit()).body.error).toMatch(/could not be (asked|read)/);
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('unknown');
    expect(sent).toEqual([]);
    accountUnreachable = false;
    expect(await deposit()).toMatchObject({ status: 200 });
    expect(sent).toEqual(['a deposit into a vault']);
  });

  it('A VAULT HELD BY KEYS THE ACCOUNT DOES NOT HAVE TAKES MONEY, AND THE WORD FOR A VAULT READS THE CHAIN FIRST', async () => {
    /* RED WHEN: the list's word for a vault is decided by who holds it rather than by the gate. */
    await vaultHeld();
    authority = { committee: [key(1)], threshold: 1, counter: 1n };
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows[0].state).toBe('held-by-committee');
    const read = (a: { committee: { tag: string; value: string }[]; threshold: number; counter: bigint; shape: string }) =>
      ({ state: 'read', address: VAULT, authority: { ...a, hasDuplicateMembers: false } }) as never;
    expect(vaultState(read({ committee: [key(9)], threshold: 1, counter: 0n, shape: 'one-key' }), { heldByOthers: true })).toBe('held-by-other-keys');
    expect(vaultState({ state: 'absent', address: VAULT, why: '' }, { heldByOthers: true })).toBe('not-on-chain-yet');
    /*
     * **WHAT THE CHAIN SAID IS READ BEFORE THE REFUSAL'S FLAGS.**
     * RED WHEN: the `!heldByOthers` branch runs before the read's own state, so a vault the chain could not be
     * asked about is reported as a decision this service made about it - an alarm for a chain hiccup.
     */
    expect(vaultState({ state: 'unreachable', address: VAULT, why: 'down' }, { heldByOthers: false })).toBe('unknown');
    expect(vaultState({ state: 'absent', address: VAULT, why: '' }, { heldByOthers: false })).toBe('not-on-chain-yet');
  });

  it('SETTINGS SHOWS EVERY CONTRACT\'S SEATS FROM THE CHAIN AGAINST THE ACCOUNT\'S COMMITTEE - AND NEVER WHOSE EACH SEAT IS', async () => {
    /* RED WHEN: `authorityView` stops counting seats outside the committee holding the account - `seatsOutsideTheCommittee`
     * reads 0 for the vault - or the service names whose key a seat is, which only the sealed roster may say. */
    await vaultHeld();
    authority = { committee: [key(1), key(3)], threshold: 2, counter: 1n };
    const r = await call('/api/accounts/acc_1/authority', 'ada');
    expect(r.status).toBe(200);
    /* RED WHEN the label is left out: a signer's wallet would have nothing to derive its committee key from. */
    expect(r.body.company).toEqual({ address: hex(0xc0), label: LABEL });
    expect(r.body.committee).toEqual({ committee: [key(1), key(2)], threshold: 2 });
    const [acct, vault] = r.body.contracts;
    expect(acct).toMatchObject({ contract: 'account', heldByTheCompany: true, seatsOutsideTheCommittee: 0 });
    expect(vault).toMatchObject({ contract: 'vault', heldByTheCompany: false, threshold: 2, seatsOutsideTheCommittee: 1 });
    expect(vault.seats).toEqual([
      { key: key(1), holder: null, thisService: false, onTheCompanysCommittee: true },
      { key: key(3), holder: null, thisService: false, onTheCompanysCommittee: false },
    ]);
    /* RED WHEN: a screen says a change owed stops payments - it stops none. */
    expect(r.body.change.possible).toBe(true);
    expect(r.body.change.why).toMatch(/^1 vault is still held by the super admins from before/);
    expect(r.body.change.why).toMatch(/Payments into and out of it go on as before/);
    expect(r.body.change.why).not.toMatch(/no money/i);
    expect((await call('/api/accounts/acc_1/authority', 'carol')).status).toBe(404);
    expect(sent).toEqual([]);
  });

  it('AN ACCOUNT STILL HELD BY THIS SERVICE\'S TEMPORARY KEY NAMES THAT SEAT AS THE SERVICE\'S, AND NOTHING HANDS IT OVER', async () => {
    accountNotBornHeld();
    serviceKey = key(9);
    accountAuthority = { committee: [key(9)], threshold: 1, counter: 0n };
    const r = (await call('/api/accounts/acc_1/authority', 'ada')).body;
    /* RED WHEN: the service's own key is passed off as the company's committee. */
    expect(r.committee).toBeNull();
    /* RED WHEN: the service's own key is not passed to the view - the seat then reads as nobody's. */
    expect(r.contracts[0].seats[0]).toMatchObject({ key: key(9), thisService: true });
    expect(r.contracts[0].why).toMatch(/THIS SERVICE'S temporary key holds this account's rules/);
    /* RED WHEN: the handover route comes back - any member could then install a committee of their own key alone. */
    expect((await call('/api/accounts/acc_1/authority/handover', 'ada', 'POST', { committee: { committee: [key(1)], threshold: 1 } })).status).toBe(404);
    /* RED WHEN: the super admins' view carries the signers' threshold, count or a judgement made from them. */
    expect(Object.keys(r).sort()).toEqual(['change', 'committee', 'company', 'contracts', 'why']);
    expect(Object.keys(r.company).sort()).toEqual(['address', 'label']);
    expect(sent).toEqual([]);
  });

  it('A VAULT BEHIND THE ACCOUNT\'S COMMITTEE IS OFFERED A CHANGE TO IT, WITH ITS COUNTER; THE ACCOUNT ITSELF NEVER IS', async () => {
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1)], threshold: 1 }, bornHeld: true });
    accountAuthority = { committee: [key(1), key(2)], threshold: 1, counter: 1n };
    authority = { committee: [key(1)], threshold: 1, counter: 0n };
    const settings = (await call('/api/accounts/acc_1/authority', 'ada')).body;
    expect(settings.change).toMatchObject({ possible: true });
    const owed = (await call('/api/accounts/acc_1/committee-change', 'ada')).body;
    /* RED WHEN: the change offered is to anything but the committee holding the account on the chain now. */
    expect(owed.to).toEqual({ committee: [key(1), key(2)], threshold: 1 });
    expect(owed.contracts.map((c: { contract: string; counter: string }) => [c.contract, c.counter])).toEqual([['vault', '0']]);
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
    startedNow = false;
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
    /* Started now, and the record does not hold it as born held. */
    startedNow = true;
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

  /* A merge with the shape the fee payer reads: two of the vault's coins in, one coin back to the vault, one call. */
  const aMerge = (vault = VAULT) => ({
    intents: new Map([[1, { actions: [{ address: vault, entryPoint: 'mergeNotes' }] }]]),
    guaranteedOffer: { inputs: [{ contractAddress: vault }, { contractAddress: vault }], outputs: [{ contractAddress: vault }], transients: [] },
    imbalances: () => new Map(),
  });

  it('A MERGE OF THE VAULT\'S NOTES IS RELAYED AS THE VAULT\'S OWN COINS, AND ANSWERS ITS TRANSACTION', async () => {
    payoutShape = aMerge();
    /* RED WHEN: the merge route is missing, sends under another arrival, or drops the hash. */
    const r = await call(`/api/accounts/acc_1/vaults/${VAULT}/merge`, 'ada', 'POST', { tx: PAYOUT_TX });
    expect(r).toEqual({ status: 200, body: { txRef: 'r-pay', transactionHash: 'fe'.repeat(32) } });
    expect(arrivals).toEqual(['proven-moving-the-vaults-own-coins']);
    expect(sent).toEqual(['a merge of a vault\'s notes']);
  });

  it('THE MERGE ROUTE PAYS NO FEE FOR A PAYMENT, A MERGE OF ANOTHER VAULT, A VAULT IT CANNOT VOUCH FOR, OR A NON-MEMBER', async () => {
    /* RED WHEN: the merge route hands its transaction to any reader but the merge's, or for any vault but this one. */
    payoutShape = aPayout();
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/merge`, 'ada', 'POST', { tx: PAYOUT_TX }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true, error: expect.stringMatching(/^this is not a merge of this vault's own notes/) } });
    payoutShape = aMerge(hex(0xaa));
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/merge`, 'ada', 'POST', { tx: PAYOUT_TX }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true } });
    /* RED WHEN: the route stops asking what the chain shows of the vault before it pays the fee. */
    payoutShape = aMerge();
    startedNow = false;
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/merge`, 'ada', 'POST', { tx: PAYOUT_TX }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true, error: expect.stringMatching(/^this service pays no fee for a merge of this vault's notes:/) } });
    startedNow = true;
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/merge`, 'carol', 'POST', { tx: PAYOUT_TX })).status).toBe(404);
    expect(sent).toEqual([]);
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

describe('A CHANGE OF WHO HOLDS THE CONTRACTS: KEPT AND HANDED BACK, AND SENT ONLY ON A DEVICE\'S REQUEST', () => {
  const ACCOUNT = hex(0xc0);
  const to = { committee: [key(1), key(2)], threshold: 2 };
  /* A change to key 1 and key 2 has landed on the account; the vault is still held by key 1 alone. */
  const behind = () => {
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1)], threshold: 1 }, bornHeld: true });
    authority = { committee: [key(1)], threshold: 1, counter: 1n };
    accountAuthority = { ...to, counter: 2n };
  };
  let assembled: Array<{ address: string; indexes: number[] }>;
  /* The builder stood in: a signature spelled 'bad' is one that does not verify, and a place past the committee counts for nothing. */
  const standIn = () => {
    assembled = [];
    assembleDep = async ({ read, signatures }) => {
      const holders = read.state === 'read' ? read.authority.committee : [];
      const byPlace = new Map<number, (typeof signatures)[number]>();
      for (const x of signatures) if (x.signature.value !== 'bad' && x.index < holders.length && !byPlace.has(x.index)) byPlace.set(x.index, x);
      const counted = [...byPlace.values()].sort((m, n) => m.index - n.index);
      const required = read.state === 'read' ? read.authority.threshold : 99;
      assembled.push({ address: read.address, indexes: counted.map((x) => x.index) });
      return { have: counted.length, required, indexesSigned: counted.map((x) => x.index), counted, proven: counted.length >= required ? new Uint8Array([0xcc]) : null };
    };
  };
  /* What the fee payer reads the sent bytes as: one update of `address` at `counter`, installing `to`, signed once. */
  const updateOf = (address: string, counter: bigint, installs = to) => ({
    intents: new Map([[1, { actions: [{ address, counter, updates: [{ authority: { ...installs, counter: counter + 1n } }], signatures: [[0n, {}]] }] }]]),
  });
  let checked: Array<string | null>;
  const paying = () => {
    checked = [];
    sendVault = async (_a, what, _arrival, bytes, check, readBytes) => {
      const refusal = await check(await readBytes(bytes));
      checked.push(refusal);
      if (refusal !== null) throw new NothingWasSent(refusal);
      sent.push(what);
      return { ref: 'r', at: 'now', transactionHash: 'h' };
    };
  };
  const sig = (address: string, counter = '1', index = 0, value = 'ab') => ({ address, counter, index, signature: { tag: 'schnorr', value } });
  const keep = (as: string, body: unknown) => call('/api/accounts/acc_1/committee-change/signatures', as, 'POST', body);
  const sendNow = (as: string, body: unknown) => call('/api/accounts/acc_1/committee-change/send', as, 'POST', body);

  it('LISTS EVERY VAULT NOT HOLDING THE COMMITTEE THAT HOLDS THE ACCOUNT ON THE CHAIN, AND NEVER THE ACCOUNT ITSELF', async () => {
    behind();
    const r = await call('/api/accounts/acc_1/committee-change', 'ada');
    expect(r.status).toBe(200);
    /* RED WHEN: the committee offered is made anywhere but from the account's on the chain. */
    expect(r.body).toEqual({
      company: ACCOUNT, label: LABEL, to, why: null, notChangeable: [],
      contracts: [{ contract: 'vault', address: VAULT, counter: '1', now: { committee: [key(1)], threshold: 1 }, signedIndexes: [], required: 1 }],
    });
    expect((await call('/api/accounts/acc_1/committee-change', 'carol')).status).toBe(404);
  });

  it('KEEPS WHAT VERIFIES, BY ITS PLACE ON THE COMMITTEE, NAMES NO SEAT, AND SENDS NOTHING', async () => {
    behind();
    standIn();
    const r = await keep('ada', { to, signatures: [sig(VAULT, '1', 0), sig(VAULT, '1', 3)] });
    expect(r.body.results).toEqual([{ address: VAULT, state: 'kept', have: 1, required: 1, indexesSigned: [0] }]);
    /* RED WHEN: keeping a signature sends the update - a send is a device's to ask for. */
    expect(sent).toEqual([]);
    /* RED WHEN: anything but the place and the signature is kept, or a signature that counts for nothing is kept. */
    expect(store.getCommitteeSignatures('acc_1', VAULT)).toEqual({
      accountId: 'acc_1', address: VAULT, counter: '1', sentAt: null,
      proposed: [{ to, signatures: [{ index: 0, signature: { tag: 'schnorr', value: 'ab' } }] }],
    });
    expect(JSON.stringify(store.getCommitteeSignatures('acc_1', VAULT))).not.toMatch(/seat/);
    expect((await call('/api/accounts/acc_1/committee-change', 'ada')).body.contracts[0].signedIndexes).toEqual([0]);
  });

  it('NO SIGNATURE IS REFUSED FOR A ROLE, A SEAT OR A SIGNER, AND ANY COMMITTEE THE INSTALL RULE ALLOWS IS TAKEN', async () => {
    behind();
    standIn();
    /* No member has given vault keys, and a different committee is proposed: a change of the super admins in progress. */
    const proposed = { committee: [key(4), key(5)], threshold: 1 };
    /* RED WHEN: a signature is kept only from a seat, a signer, or for the committee the service would have chosen. */
    const r = await keep('bo', { to: proposed, signatures: [sig(VAULT, '1', 0)] });
    expect(r.body.results[0]).toMatchObject({ state: 'kept', have: 1 });
    expect(store.getCommitteeSignatures('acc_1', VAULT)!.proposed.map((x) => x.to)).toEqual([proposed]);
    /* And signatures for two committees at one counter are kept apart. */
    await keep('ada', { to, signatures: [sig(VAULT, '1', 0, 'cd')] });
    expect(store.getCommitteeSignatures('acc_1', VAULT)!.proposed.map((x) => x.to)).toEqual([proposed, to]);
  });

  it('HANDS BACK EVERY SIGNATURE KEPT FOR THE COMPANY, WITH THE COMMITTEE IT IS OVER, TO A MEMBER', async () => {
    behind();
    standIn();
    await keep('ada', { to, signatures: [sig(VAULT, '1', 0)] });
    /* RED WHEN: the route stops handing signatures back - a device then has only its own file to count from. */
    expect((await call('/api/accounts/acc_1/committee-change/signatures', 'bo')).body).toEqual({
      signatures: [{ address: VAULT, counter: '1', index: 0, signature: { tag: 'schnorr', value: 'ab' }, to }],
    });
    expect((await call('/api/accounts/acc_1/committee-change/signatures', 'carol')).status).toBe(404);
  });

  it('TWO COMPANIES NAMING ONE ADDRESS KEEP THEIR SIGNATURES APART, AND NEITHER LISTS OR REPLACES THE OTHER\'S', async () => {
    behind();
    standIn();
    await keep('ada', { to, signatures: [sig(VAULT, '1', 0)] });
    /* Another company's record of signatures at the same address, at the same counter. */
    store.putCommitteeSignatures({
      accountId: 'acc_2', address: VAULT, counter: '1', sentAt: null,
      proposed: [{ to: { committee: [key(7)], threshold: 1 }, signatures: [{ index: 0, signature: { tag: 'schnorr', value: 'ef' } }] }],
    });
    /* RED WHEN: signatures are kept by address alone - the other company's write then replaces this one's, and moves them out of its list. */
    expect(store.getCommitteeSignatures('acc_1', VAULT)!.proposed.map((x) => x.to)).toEqual([to]);
    expect((await call('/api/accounts/acc_1/committee-change/signatures', 'ada')).body.signatures).toEqual([
      { address: VAULT, counter: '1', index: 0, signature: { tag: 'schnorr', value: 'ab' }, to },
    ]);
    expect((await call('/api/accounts/acc_1/committee-change', 'ada')).body.contracts[0].signedIndexes).toEqual([0]);
  });

  it('KEEPS NOTHING FOR A COMMITTEE NO CONTRACT CAN HOLD, A CONTRACT NOT THE COMPANY\'S, OR A COUNTER THE CHAIN HAS MOVED PAST', async () => {
    behind();
    standIn();
    /* RED WHEN: a committee the one install rule refuses is kept for. */
    const twice = await keep('ada', { to: { committee: [key(1), key(1)], threshold: 1 }, signatures: [sig(VAULT)] });
    expect(twice).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    /* RED WHEN: a vault is taken as this company's because its deployer pinned it to the account, which the account's
     * own list of vaults on the chain does not bear out. */
    const theirs = await keep('ada', { to, signatures: [sig(hex(0xee))] });
    expect(theirs.body.results[0]).toMatchObject({ state: 'refused', error: expect.stringMatching(/does not list a vault there/) });
    expect((await sendNow('ada', { address: hex(0xee), counter: '1', to })).body.error).toMatch(/does not list a vault there/);
    const moved = await keep('ada', { to, signatures: [sig(VAULT, '0')] });
    expect(moved.body.results[0].error).toMatch(/has been changed since these signatures were made/);
    expect(store.getCommitteeSignatures('acc_1', VAULT)).toBeNull();
    expect((await keep('ada', { to, signatures: [{ ...sig(VAULT), seat: 0 }] })).status).toBe(400);
    expect((await keep('carol', { to, signatures: [sig(VAULT)] })).status).toBe(404);
  });

  it('SENDS ONLY WHEN A DEVICE ASKS, AND ONLY ONCE THE SIGNATURES THAT VERIFY REACH THE THRESHOLD ON THE CHAIN', async () => {
    behind();
    standIn();
    paying();
    startShape = updateOf(VAULT, 1n);
    /* RED WHEN: the fee is paid before the verifying signatures reach the threshold of the committee holding the vault. */
    const short = await sendNow('ada', { address: VAULT, counter: '1', to, signatures: [sig(VAULT, '1', 0, 'bad')].map(({ index, signature }) => ({ index, signature })) });
    expect(short).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(short.body.error).toMatch(/0 of the 1 signatures/);
    expect(sent).toEqual([]);
    await keep('ada', { to, signatures: [sig(VAULT, '1', 0)] });
    const r = await sendNow('bo', { address: VAULT, counter: '1', to });
    expect(r).toMatchObject({ status: 200, body: { state: 'sent', txRef: 'r', have: 1, required: 1 } });
    /* RED WHEN: the fee is paid without `refusalForCommitteeChange` reading the transaction. */
    expect(checked).toEqual([null]);
    expect(sent).toEqual([`changing the committee holding vault ${VAULT}`]);
    /* RED WHEN: a counter the chain is not at is sent at. */
    expect((await sendNow('ada', { address: VAULT, counter: '0', to })).body.error).toMatch(/is at counter 1 on the chain, not 0/);
  });

  it('SENDS AT ONE COUNTER ONCE, WHICH A SECOND PROCESS OF THE SERVICE SEES TOO; A SEND THAT SENT NOTHING FREES IT', async () => {
    behind();
    standIn();
    startShape = updateOf(VAULT, 1n);
    await keep('ada', { to, signatures: [sig(VAULT, '1', 0)] });
    sendVault = async () => { throw new NothingWasSent('the fee payer could not pay. Nothing was sent.'); };
    expect(await sendNow('ada', { address: VAULT, counter: '1', to })).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    /* RED WHEN: a send that sent nothing leaves the counter marked as sent, and the next request does nothing. */
    sendVault = async (_a, what) => { sent.push(what); throw new Error('the node did not answer'); };
    expect(await sendNow('ada', { address: VAULT, counter: '1', to })).toMatchObject({ status: 502, body: { nothingWasSent: false } });
    expect(sent).toHaveLength(1);
    /* RED WHEN: an update that may have landed is sent again at the same counter - the chain charges for the second and refuses it. */
    expect((await sendNow('bo', { address: VAULT, counter: '1', to })).body.error).toMatch(/was sent and the chain has not shown it yet/);
    /* A second process of the same service, over the same store, refuses it too: the mark is kept with the signatures. */
    const other = express().use(companyVaultRoutes(routeDeps));
    const second = await new Promise<ReturnType<express.Express['listen']>>((resolve) => { const s2 = other.listen(0, '127.0.0.1', () => resolve(s2)); });
    try {
      const r = await fetch(`http://127.0.0.1:${(second.address() as AddressInfo).port}/api/accounts/acc_1/committee-change/send`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-person': 'ada' }, body: JSON.stringify({ address: VAULT, counter: '1', to }),
      });
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatch(/was sent and the chain has not shown it yet/);
    } finally {
      await new Promise<void>((resolve) => second.close(() => resolve()));
    }
    expect(sent).toHaveLength(1);
  });

  it('TWO REQUESTS AT ONCE FOR ONE CONTRACT SEND IT ONCE', async () => {
    behind();
    standIn();
    const slow = assembleDep!;
    assembleDep = async (input) => { await new Promise((r) => setTimeout(r, 20)); return slow(input); };
    await keep('ada', { to, signatures: [sig(VAULT, '1', 0)] });
    sendVault = async (_a, what) => { sent.push(what); return { ref: 'r', at: 'now', transactionHash: 'h' }; };
    const both = await Promise.all([sendNow('ada', { address: VAULT, counter: '1', to }), sendNow('bo', { address: VAULT, counter: '1', to })]);
    /* RED WHEN: the two are put together and sent side by side. */
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(sent).toHaveLength(1);
  });

  it('WITHOUT A CHANGE OF THE SUPER ADMINS, AN UPDATE IS SENT ONLY TO THE COMMITTEE HOLDING THE ACCOUNT ON THE CHAIN', async () => {
    behind();
    standIn();
    const other = { committee: [key(1), key(3)], threshold: 2 };
    await keep('ada', { to: other, signatures: [sig(VAULT, '1', 0)] });
    /* RED WHEN: a key enters a contract by an update no change of the super admins carries. */
    const r = await sendNow('ada', { address: VAULT, counter: '1', to: other });
    expect(r).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(r.body.error).toMatch(/only to the committee holding the company's account on the chain now/);
    expect(sent).toEqual([]);
  });

  describe('WITH A CHANGE OF THE SUPER ADMINS', () => {
    const L = () => import('@midnightntwrk/ledger-v9');
    const secret = (n: number) => new Uint8Array(32).fill(n);
    const SALT = 'a5'.repeat(32);
    /* The change from key 1 alone to key 1 and key 2, raised with the account at counter 1, naming the account and the vault. */
    const change = { kind: 'super-admins' as const, from: { committee: [key(1)], threshold: 1 }, ...to, contracts: [
      { contract: 'account' as const, address: ACCOUNT, counter: '1' }, { contract: 'vault' as const, address: VAULT, counter: '1' },
    ] };
    const joinedBy2 = async () => {
      const { superAdminChangeBytes } = await import('midnight-identity/profile/committee-sign');
      const l = await L();
      const sk = l.signingKeyFromBip340(secret(2));
      expect(l.signatureVerifyingKey(sk).value).toBe(key(2).value);
      return { key: key(2), signature: l.signData(sk, superAdminChangeBytes(LABEL, ACCOUNT, SALT, change)).value };
    };
    const withChange = (joined: unknown[]) => ({ company: LABEL, salt: SALT, change, joined });

    it('A VAULT\'S UPDATE GOES ONLY ONCE THE ACCOUNT HOLDS THE CHANGE\'S COMMITTEE ON THE CHAIN, PAST THE COUNTER IT WAS RAISED AT', async () => {
      behind();
      standIn();
      accountAuthority = { committee: [key(1)], threshold: 1, counter: 1n };
      await keep('ada', { to, signatures: [sig(VAULT, '1', 0)] });
      const joined = [await joinedBy2()];
      /* RED WHEN: a vault's update is sent before the account's has landed. */
      const early = await sendNow('ada', { address: VAULT, counter: '1', to, change: withChange(joined) });
      expect(early.body.error).toMatch(/does not yet hold this committee on the chain/);
      expect(sent).toEqual([]);
      accountAuthority = { ...to, counter: 2n };
      expect((await sendNow('ada', { address: VAULT, counter: '1', to, change: withChange(joined) })).body).toMatchObject({ state: 'sent' });
    });

    it('A VAULT\'S UPDATE IS NOT SENT WHILE THE ACCOUNT IS PAST THE RAISE ON ANOTHER COMMITTEE', async () => {
      behind();
      standIn();
      /* Another change moved the account past the counter this one was raised at, to a committee that is not this one. */
      accountAuthority = { committee: [key(1), key(3)], threshold: 2, counter: 2n };
      await keep('ada', { to, signatures: [sig(VAULT, '1', 0)] });
      /* RED WHEN: the account's committee is not compared with the one the change installs. */
      const r = await sendNow('ada', { address: VAULT, counter: '1', to, change: withChange([await joinedBy2()]) });
      expect(r).toMatchObject({ status: 409, body: { nothingWasSent: true } });
      expect(r.body.error).toMatch(/does not yet hold this committee on the chain/);
      expect(sent).toEqual([]);
    });

    it('A VAULT\'S UPDATE IS NOT SENT WHILE THE ACCOUNT HOLDS THE CHANGE\'S COMMITTEE AT A COUNTER NOT PAST THE RAISE', async () => {
      behind();
      standIn();
      /* The account holds the committee the change installs, at the counter the change was raised at: not the change landing. */
      accountAuthority = { ...to, counter: 1n };
      await keep('ada', { to, signatures: [sig(VAULT, '1', 0)] });
      /* RED WHEN: the account's counter is not compared with the counter the change was raised at. */
      const r = await sendNow('ada', { address: VAULT, counter: '1', to, change: withChange([await joinedBy2()]) });
      expect(r).toMatchObject({ status: 409, body: { nothingWasSent: true } });
      expect(r.body.error).toMatch(/does not yet hold this committee on the chain/);
      expect(sent).toEqual([]);
    });

    it('REFUSES AN UPDATE WHOSE JOINING KEYS HAVE NOT ALL SIGNED THE CHANGE, PER CONTRACT, AGAINST ITS COMMITTEE ON THE CHAIN', async () => {
      behind();
      standIn();
      await keep('ada', { to, signatures: [sig(VAULT, '1', 0)] });
      /* Key 2 is not on the vault's committee, so it joins the vault, whatever the account holds. RED WHEN: joins are not checked. */
      const unsigned = await sendNow('ada', { address: VAULT, counter: '1', to, change: withChange([]) });
      expect(unsigned.body.error).toMatch(/1 key this update puts on vault .* has not signed the change with its own key/);
      /* RED WHEN: a joining signature over other bytes is taken. */
      const forged = { key: key(2), signature: (await joinedBy2()).signature.replace(/^./u, (c) => (c === '0' ? '1' : '0')) };
      expect((await sendNow('ada', { address: VAULT, counter: '1', to, change: withChange([forged]) })).body.error).toMatch(/has not signed the change/);
      expect(sent).toEqual([]);
      expect((await sendNow('ada', { address: VAULT, counter: '1', to, change: withChange([await joinedBy2()]) })).body).toMatchObject({ state: 'sent' });
    });

    it('SENDS THE UPDATE OF A CONTRACT ALREADY HOLDING THE COMMITTEE, SO EVERY COUNTER MOVES', async () => {
      behind();
      standIn();
      authority = { ...to, counter: 1n };
      await keep('ada', { to, signatures: [sig(VAULT, '1', 0), sig(VAULT, '1', 1)] });
      /* RED WHEN: a contract already at the change's committee is refused - an older signed update could then still land on it. */
      const r = await sendNow('ada', { address: VAULT, counter: '1', to, change: withChange([]) });
      expect(r.body).toMatchObject({ state: 'sent', have: 2, required: 2 });
    });

    it('REFUSES A CHANGE THAT DOES NOT NAME THE CONTRACT, OR DOES NOT NAME THE ACCOUNT FIRST, OR INSTALLS ANOTHER COMMITTEE', async () => {
      behind();
      standIn();
      const joined = [await joinedBy2()];
      const named = (contracts: typeof change.contracts) => ({ ...withChange(joined), change: { ...change, contracts } });
      expect((await sendNow('ada', { address: VAULT, counter: '1', to, change: named([change.contracts[0]!]) })).body.error).toMatch(/does not name vault/);
      expect((await sendNow('ada', { address: VAULT, counter: '1', to, change: named([change.contracts[1]!, change.contracts[0]!]) })).body.error)
        .toMatch(/does not name the company's account first/);
      expect((await sendNow('ada', { address: VAULT, counter: '1', to: { committee: [key(1), key(3)], threshold: 2 }, change: withChange(joined) })).body.error)
        .toMatch(/not the one this change installs/);
      expect(sent).toEqual([]);
    });
  });

  it('NO CHANGE CARRIES A BAR: NO VAULT\'S THRESHOLD OR BAND REACHES WHAT A CHANGE IS PUT TOGETHER FROM', async () => {
    behind();
    const given: Array<[string, string[]]> = [];
    assembleDep = async (input) => {
      given.push([input.read.address, Object.keys(input).sort()]);
      return { have: 0, required: 1, indexesSigned: [], counted: [], proven: null };
    };
    acc1VaultThresholds = [{ vault: VAULT, threshold: 3 }, { vault: hex(0xdd), threshold: 4 }];
    await keep('ada', { to, signatures: [sig(ACCOUNT, '2'), sig(VAULT)] });
    /* RED WHEN: a vault's threshold, the account's highest bar or a band is handed to what puts the change together. */
    expect(given).toEqual([[ACCOUNT, ['label', 'read', 'signatures', 'to']], [VAULT, ['label', 'read', 'signatures', 'to']]]);
  });
});

describe('WHO HOLDS A CONTRACT IS NOT ASKED BEFORE MONEY GOES IN; HOW IT WAS CREATED IS', () => {
  const to = { committee: [key(1), key(2)], threshold: 2 };
  it('A CONTRACT BORN HELD IS FUNDED AT ANY COUNTER, AND ONE THE RECORD DOES NOT HOLD AS BORN HELD AT NONE', async () => {
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

  it('IS SENT ONLY THROUGH THE ONE GATE, WHOEVER HOLDS THE VAULT, AND READ AS A PUBLIC DEPOSIT OF THE TOKEN AND AMOUNT ASKED', async () => {
    const checks: Array<(tx: unknown) => unknown> = [];
    sendVault = async (_a, what, _arrival, _bytes, check) => { sent.push(what); checks.push(check); return { ref: 'r', at: 'now', transactionHash: 'h' }; };
    store.putCompanyVault({ accountId: 'acc_1', vault: VAULT, deployedAt: '', deployRef: 'r', intended: { committee: [key(1), key(2)], threshold: 2 }, bornHeld: true });
    /* RED WHEN: the route stops asking the gate before it pays a fee. */
    startedNow = false;
    const notStarted = await publicDeposit();
    expect(notStarted).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(notStarted.body.error).toMatch(/has not yet adopted it/);
    /* RED WHEN: the route stops asking about the company's account too. */
    startedNow = true;
    accountNotBornHeld();
    expect(await publicDeposit()).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(sent).toEqual([]);
    store.recordAccountDeploy({ accountId: 'acc_1', address: hex(0xc0), foundingKey: key(1), deploy: 'ZA==', insert: 'aQ==', recordedAt: 'then' });
    /* Held by keys the account does not have: a payment goes ahead all the same. */
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

  it('IS SENT ONLY FOR A VAULT THAT IS THIS COMPANY\'S AS THE CHAIN AND THE RECORD SHOW IT NOW, WHOEVER HOLDS IT', async () => {
    await heldVault();
    startShape = oneCall(hex(0xc0), 'adopt');
    pinnedNow = hex(0xc1);
    const r = await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'adopt' });
    /* RED WHEN: a step of a start is paid for on a vault pinned to another account. */
    expect(r).toMatchObject({ status: 409, body: { nothingWasSent: true } });
    expect(sent).toEqual([]);
    /* RED WHEN: a step of a start, which is the signers' own, waits on who holds the vault. */
    pinnedNow = hex(0xc0);
    authority = { committee: [key(9)], threshold: 1, counter: 0n };
    expect((await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'adopt' })).status).toBe(200);
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
    expect(await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'approve' }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true } });
    startShape = oneCall(hex(0xc1), 'approve');
    expect(await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'approve' }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true } });
    startShape = oneCall(hex(0xc0), 'approve');
    expect((await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'approve' })).status).toBe(200);
    expect((await call(at('account'), 'ada', 'POST', { tx: START, step: 'secret-run', call: 'adopt' })).status).toBe(400);
    /* RED WHEN: a start's proposal is raised here, with no record of it written down; it is raised with its record instead. */
    startShape = oneCall(hex(0xc0), 'propose');
    for (const step of ['adoption', 'secret-run']) {
      expect(await call(at('account'), 'bo', 'POST', { tx: START, step, call: 'propose' })).toMatchObject({ status: 400, body: { nothingWasSent: true } });
    }
    expect(sent).toEqual(['approving the adoption of this vault']);
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

  /*
   * RED WHEN: a step the node refused at its door keeps the step held for half an hour, though it can never land.
   * RED WHEN: a step whose outcome is not known is freed, so a second copy is paid for.
   * RED WHEN: a fee that was not paid reaches the page without its code, or a step that may have landed carries one.
   */
  it('A STEP THE NODE REFUSED AT ITS DOOR IS FREED AT ONCE, WITH ITS CODE; ONE THAT MAY HAVE LANDED STAYS HELD', async () => {
    await heldVault();
    startShape = oneCall(hex(0xc0), 'adopt');
    sendVault = async () => { throw new NetworkRefused('refused at the door. Nothing was sent.'); };
    expect(await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'adopt' }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true, code: 'network-refused' } });
    sendVault = async () => { throw new FeeNotPaid('the fee payer did not pay this fee. Nothing was sent.'); };
    expect(await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'adopt' }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true, code: 'fee-not-paid' } });
    sendVault = async () => { throw Object.assign(new Error('the node did not answer'), { code: 'network-refused' }); };
    const unknown = await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'adopt' });
    expect(unknown).toMatchObject({ status: 502, body: { nothingWasSent: false } });
    expect(unknown.body.code).toBeUndefined();
    checked();
    expect(await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'adopt' }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true, error: expect.stringMatching(/has not shown it yet/) } });
    expect(sent).toEqual([]);
  });

  /*
   * RED WHEN: a step whose fee could not be paid again after a refused spend proof is held for half an hour as one
   * that may have landed.
   */
  it('A STEP WHOSE FEE COULD NOT BE PAID AGAIN AFTER A REFUSED SPEND PROOF IS FREED AT ONCE', async () => {
    await heldVault();
    startShape = oneCall(hex(0xc0), 'adopt');
    sendVault = aRefusedSpendProofThatCannotBePaidAgain();
    expect(await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'adopt' }))
      .toMatchObject({ status: 422, body: { nothingWasSent: true, code: 'fee-not-paid' } });
    checked();
    expect((await call(at('account'), 'ada', 'POST', { tx: START, step: 'adoption', call: 'adopt' })).status).toBe(200);
  });

  /* RED WHEN: a deploy kept on an older record is served back, though nothing reads it. */
  it('THE CHAIN VIEW OF A VAULT DOES NOT SERVE ITS DEPLOY', async () => {
    await heldVault();
    store.putCompanyVault({ ...store.getCompanyVault(VAULT)!, deploy: 'AAAA' });
    expect((await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada')).body).not.toHaveProperty('deployed');
  });

  it('A VAULT HELD BY THE COMMITTEE AND NOT STARTED IS SAID AS ITS START OWED, AND TAKES NO DEPOSIT', async () => {
    await heldVault();
    const view = await call(`/api/accounts/acc_1/vaults/${VAULT}/chain`, 'ada');
    /* RED WHEN: a vault not started is read as not held, so its handover would be sent again. */
    expect(view.body).toMatchObject({ started: false });
    expect(view.body).not.toHaveProperty('fundable');
    expect((await call('/api/accounts/acc_1/vaults', 'ada')).body.rows).toEqual([expect.objectContaining({ vault: VAULT, state: 'start-owed' })]);
    expect(await call(`/api/accounts/acc_1/vaults/${VAULT}/deposit`, 'ada', 'POST', { tx: 'AAAA' }))
      .toMatchObject({ status: 409, body: { nothingWasSent: true } });
  });
});

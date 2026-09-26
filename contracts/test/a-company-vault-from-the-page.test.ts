/**
 * **A COMPANY'S VAULT CREATED FROM ITS SIGNER'S DEVICE, HANDED TO THE COMPANY'S
 * COMMITTEE, ITS POOL OPENED, AND MONEY PUT IN - EVERY STEP THROUGH THE ROUTES
 * THE PAGE CALLS, NONE FROM A TERMINAL.**
 *
 * What is real here:
 *   · the chain is the ledger's own state machine (`LedgerState`), applying
 *     each transaction as its own block, with signatures checked;
 *   · the vault is the compiled contract, its deploy and deposit built by the
 *     device's own builder through the worker's own message handling;
 *   · the committee key is the wallet's own derivation from the signer's words;
 *   · the service is the product's own routes (`company-vaults.ts`) and its own
 *     records mount, over real HTTP, and a real `ChainLedger` sends each
 *     transaction through its one-write-at-a-time lane;
 *   · the wallet's side of a deposit is the wallet's own reader
 *     (`balance-for-page.ts`), which decides what the person is shown.
 *
 * **WHAT THIS DOES NOT SHOW, SAID HERE SO NOTHING RELIES ON IT:** no proof is
 * made (the builder's prover hands back what it was given, and the ledger is told
 * not to check proofs); the ledger is told not to check that a transaction
 * balances, so nothing here shows a wallet paying for a coin or a fee payer
 * paying a fee; nothing reaches a real network, a real indexer, a browser or a
 * wallet screen. The company's account is deployed here as the service
 * deploys one - under its temporary key, carrying this build's circuits - but
 * with no starting state, because creating a company from the screen is the
 * existing path and what follows it is what this watches: the account handed
 * to the committee, and no money going in until it is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { identityFromWords, newWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import * as vaultModule from '../managed-vault/contract/index.js';
import { MemoryStore } from '../../src/core/store.js';
import { AccountService, openAccount, sealAccount } from '../../src/core/account.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { signVaultKeys } from '../../src/core/vault-keys.js';
import { ChainLedger } from '../../src/wiring/chain.js';
import { companyVaultRoutes, type VaultChain } from '../../src/server/company-vaults.js';
import { mountVaultRecords, vaultAccountFromTheIndexer } from '../../src/server/vault-records-authority.js';
import { MemorySealedPoolStore, SealedNotePool } from '../../src/midnight/vault-pool.js';
import type { WireRecord } from '../../src/midnight/sealed-record-wire.js';
import { HttpSealedPoolStore, type WireSend } from '../../src/web/http-sealed-pool-store.js';
import { recordsReaderOf, type DeviceSigner } from '../../src/web/deposit-on-device.js';
import { answerVaultAsk } from '../../src/web/vault-worker-entry.js';
import { vaultBuilderOver, type VaultAnswer } from '../../src/web/vault-worker-client.js';
import {
  createCompanyVault, depositIntoCompanyVault, openCompanyVaultPool, VaultHandoverOwed,
  type TemporaryKeys, type VaultService, type DepositInFlight, type DepositsInFlight,
} from '../../src/web/vault-operation.js';
import { inFlightInMemory as inFlightRecordsInMemory, sealedOnThisDevice, type KeptOnThisDevice } from '../../src/web/in-flight-on-this-device.js';
import { readWhatThePageAsks, base64FromBytes, bytesFromBase64 } from '../../apps/wallet/src/chain/balance-for-page.js';
import { aWalletThatPaysPrivately, type AWalletThatPaysPrivately } from './a-wallet-that-pays-privately.js';
import { UNLOCK_PURPOSE, UNLOCK_WINDOW_MS, unlockAsk } from '../../src/core/wallet-unlock.js';
import { newSigningKeypair, newWrappingKeypair, toHex, type Hex } from '../../src/core/crypto.js';
import { committeeReplacement } from '../../src/midnight/vault-committee.js';
import { accountHandoverWith, accountTemporaryVerifyingKey, accountVerifierKeysIn } from '../../src/server/vault-chain.js';
import { DEPLOYED_CIRCUITS } from '../../src/midnight/deferral.js';
import { fileURLToPath } from 'node:url';
import { whyNotHandOver } from '../../src/web/handover-check.js';
import { readProvenTransaction, readFinishedTransaction } from '../../src/wiring/proven-submission.js';
import { startingLedgerFrom } from '../../src/wiring/vault-submission.js';
import { signingKeyFromBip340 } from '@midnightntwrk/ledger-v9';

/** Deposits or payments on their way, kept for the length of one test, sealed as the page keeps them. */
const keptOnThisDevice = <T,>(kind: 'deposit' | 'payment'): KeptOnThisDevice<T> =>
  sealedOnThisDevice<T>(inFlightRecordsInMemory(), { signerId: 'ada', wrappingSecret: newWrappingKeypair().secret }, kind);
const inFlightInMemory = (): DepositsInFlight => keptOnThisDevice<DepositInFlight>('deposit');

const NET = 'undeployed';
const RECORDS: readonly WireRecord[] = ['pool', 'deposit-journal', 'payment-journal', 'nonce-secret'];
const ACCOUNT_ID = 'acc_vaulted';
const GBP = 'a7'.repeat(32);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const asRuntime = (state: { serialize(): Uint8Array }) => (runtime as any).ContractState.deserialize(state.serialize());
const vaultLedgerOf = (state: { serialize(): Uint8Array }) => (vaultModule as any).ledger(asRuntime(state).data);

const releasedCompanyKey = (words: string, company: string): Uint8Array => {
  const ask = parseAsk(unlockAsk({
    name: 'Confidential Accounts', rdns: 'social.lemonade.confidential-accounts', purpose: UNLOCK_PURPOSE,
    nonce: 'derivation-has-no-conversation', expiresAt: UNLOCK_WINDOW_MS, company,
  }), 'https://payroll.example', 0);
  if (ask.kind !== 'unlock') throw new Error('not an unlock');
  return unlockKeyFor(identityFromWords(words), ask);
};

/* ------------------------------------------------------------------ the chain */

/** The ledger's own state machine, one transaction per block, signatures checked. */
class Chain {
  state: any = L.LedgerState.blank(NET);
  everCreated = new Map<string, Set<string>>();
  /* Every applied transaction's events, under the name an indexer would give it: its hash, or for an unproven one a hash of its identifier. */
  events = new Map<string, any[]>();
  applied: Array<{ hash: string; ok: boolean; error: string }> = [];
  private strictness() {
    const s = new L.WellFormedStrictness();
    s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = false;
    s.enforceLimits = false; s.verifySignatures = true;
    return s;
  }
  apply(tx: any): { ok: boolean; error: string } {
    const now = new Date();
    const t = BigInt(Math.floor(now.getTime() / 1000));
    const [next, result] = this.state.apply(tx.wellFormed(this.state, this.strictness(), now),
      new L.TransactionContext(this.state, {
        secondsSinceEpoch: t, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: t - 6n,
      }));
    const ok = result.type === 'success';
    if (ok) {
      this.state = next;
      let named: string;
      try { named = String(tx.transactionHash()); } catch { named = createHash('sha256').update(String(tx.identifiers()[0])).digest('hex'); }
      this.events.set(named, [...result.events]);
      for (const out of tx.guaranteedOffer?.outputs ?? []) {
        if (out.contractAddress === undefined) continue;
        const k = String(out.contractAddress).toLowerCase();
        this.everCreated.set(k, (this.everCreated.get(k) ?? new Set()).add(String(out.commitment).toLowerCase()));
      }
    }
    const error = String(result.error ?? '');
    let hash: string;
    /* An unproven transaction has no hash, only identifiers; the one here that is unproven is a deposit. */
    try { hash = String(tx.transactionHash()); } catch { hash = `unproven:${String(tx.identifiers()[0])}`; }
    this.applied.push({ hash, ok, error });
    return { ok, error };
  }
  contract(address: string): any | null {
    try { return this.state.index(address) ?? null; } catch { return null; }
  }
  /** What was on the chain before the watch began: applied, and not counted among what the watch sent. */
  seed(tx: any): { ok: boolean; error: string } {
    const r = this.apply(tx);
    this.applied.pop();
    /* The block ends here, so the commitment tree's root after it is one a later spend may prove against. */
    if (r.ok) this.state = this.state.postBlockUpdate(new Date());
    return r;
  }
}

/** This service's temporary key for company accounts, as the recorded authority file holds one. */
const TEMPORARY_ACCOUNT_KEY = signingKeyFromBip340(new Uint8Array(32).fill(0x5a));
const accountKeys = accountVerifierKeysIn(fileURLToPath(new URL('../..', import.meta.url)));

/*
 * **THE DEPLOY, THE HANDOVER AND THE DEPOSIT BELOW ARE BUILT FROM THE VAULT'S
 * VERIFIER KEYS, WHICH ONLY A FULL VAULT COMPILE PRODUCES.** The general checks
 * compile without them, so this is skipped there by name, and the job that
 * builds the keys runs this file by name after building them.
 *
 * Derived from this file's own location, not the working directory.
 */
const KEYS_ON_DISK = existsSync(new URL('../managed-vault/keys/deposit.verifier', import.meta.url))
  && existsSync(new URL('../managed/keys/recordPayment.verifier', import.meta.url));
if (!KEYS_ON_DISK) {
  console.log(
    '  NOT CHECKED HERE: the vault\'s verifier keys are not on disk, so a company vault was not'
    + ' created, handed over, pooled and funded through the routes the page calls.'
    + ' `npm run compact:vault -- --full` builds them.',
  );
}

describe.skipIf(!KEYS_ON_DISK)('A COMPANY VAULT, FROM THE SIGNER\'S DEVICE [needs contracts/managed-vault/keys; `npm run compact:vault -- --full` builds them]', () => {
  let chain: Chain;
  let depositor: AWalletThatPaysPrivately;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let store: MemoryStore;
  let viewingKey: Hex;
  let company: Hex;
  let words: string;
  let me: DeviceSigner;
  let signing: ReturnType<typeof newSigningKeypair>;
  let wrapping: ReturnType<typeof newWrappingKeypair>;
  let sent: string[];
  let temporaryKeys: Map<string, { tag: string; value: string }>;
  let dropHandover: boolean;
  let serverStores: Map<WireRecord, MemorySealedPoolStore>;
  let companyThreshold: number;

  const zk = new NodeZkConfigProvider(new URL('../managed-vault', import.meta.url).pathname);
  const compiled = CompiledContract.make('Vault', (vaultModule as any).Contract).pipe(
    CompiledContract.withWitnesses({ noteToSpend: () => { throw new Error('nothing here spends'); } } as any),
  );
  /*
   * NO PROOF IS MADE. A deploy and a handover call no circuit, so the ledger's own
   * `prove` runs over them with a prover that is never asked for anything, and they
   * reach the service in the form a real one sends. A deposit's circuits cannot be
   * proved that way (the ledger's mock prover refuses them too), so a deposit
   * reaches the service unproven and is read as such - the one reader here that
   * is not the service's own. The ledger is told not to check proofs.
   */
  const neverAsked = {
    check: async () => { throw new Error('asked to check a circuit'); },
    prove: async () => { throw new Error('asked to prove a circuit'); },
    lookupKey: async () => undefined,
  };
  /** The worker's own handler, reached through the page's own client, with no Worker. */
  const builder = (proves = true) => {
    const deps = async () => ({
      ledger: L, vault: vaultModule, runtimeState: (runtime as any).ContractState, contracts: contracts as any,
      compiled, zkConfig: zk,
      prove: async (unproven: any, circuit?: string) =>
        (proves && circuit === undefined ? unproven.prove(neverAsked, (L as any).CostModel.initialCostModel()) : unproven),
    });
    const listeners: Array<(e: { data: unknown }) => void> = [];
    return vaultBuilderOver({
      addEventListener: (_t, l) => { listeners.push(l); },
      postMessage: (message) => {
        void answerVaultAsk(deps as never, message as never).then(
          (a: VaultAnswer) => listeners.forEach((l) => l({ data: a })),
          (e: Error) => listeners.forEach((l) => l({ data: { id: (message as { id: number }).id, ok: false, error: e.message } })));
      },
    }, NET);
  };
  /* The service's own reader for a deploy and a handover; a deposit arrives unproven (above). */
  const readers = {
    proven: readProvenTransaction,
    finished: async (b: Uint8Array) => L.Transaction.deserialize('signature', 'pre-proof', 'binding', b),
  };

  beforeEach(async () => {
    chain = new Chain();
    /* The depositor's wallet holds its own private coins before anything else is on the chain. */
    depositor = aWalletThatPaysPrivately(NET);
    chain.seed(depositor.seedTransaction(GBP, [100_000n, 100_000n, 100_000n, 100_000n]));
    store = new MemoryStore();
    /* The company account, deployed as the service deploys one: its temporary key, this build's circuits. */
    const accountState = new L.ContractState();
    accountState.maintenanceAuthority = new L.ContractMaintenanceAuthority(
      [L.signatureVerifyingKey(TEMPORARY_ACCOUNT_KEY)], 1, 0n);
    /* Read here from the build's files, apart from the service's own reader, so the service is checked against them. */
    for (const c of DEPLOYED_CIRCUITS) {
      const op = new L.ContractOperation();
      op.verifierKey = new Uint8Array(readFileSync(new URL(`../managed/keys/${c}.verifier`, import.meta.url)));
      accountState.setOperation(c, op);
    }
    const accountDeploy = new L.ContractDeploy(accountState);
    const seeded = chain.seed(L.Transaction.fromParts(NET, undefined, undefined,
      L.Intent.new(new Date(Date.now() + 600_000)).addDeploy(accountDeploy)));
    if (!seeded.ok) throw new Error(`the company account was not deployed: ${seeded.error}`);
    company = String(accountDeploy.address).toLowerCase() as Hex;
    companyThreshold = 1;
    words = newWords().join(' ');
    signing = newSigningKeypair();
    wrapping = newWrappingKeypair();
    me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: releasedCompanyKey(words, company) };
    sent = [];
    temporaryKeys = new Map();
    dropHandover = false;
    /* A company of one, with its roster sealed under a viewing key the page holds, as the product keeps it. */
    viewingKey = toHex(new Uint8Array(32).fill(0x5e));
    store.putAccount(sealAccount({
      id: ACCOUNT_ID, createdAt: new Date().toISOString(), name: 'Northwind',
      signers: [{
        id: 'ada', userId: 'ada', name: 'Ada', status: 'active', role: 'admin', leafCommitment: null,
        signingPublicKey: signing.publicKey, wrappingPublicKey: wrapping.publicKey,
      }],
      policy: { threshold: 1, limitsByRole: {} }, recovery: { signerIds: ['ada'], threshold: 1 }, wrappedKeys: [],
    } as never, viewingKey, []));
    const accounts = new AccountService(store, {} as never, MidnightCommitments);

    const app = express();
    const signedIn: express.RequestHandler = (req, res, next) => {
      const p = req.headers['x-test-person'];
      if (typeof p !== 'string') { res.status(401).json({ error: 'not signed in' }); return; }
      (req as { userId?: string }).userId = p;
      next();
    };
    const member: express.RequestHandler = (req, res, next) => {
      const a = store.getAccount(String(req.params.id));
      if (!a || !a.memberUserIds.includes((req as { userId?: string }).userId!)) { res.status(404).json({ error: 'account not found' }); return; }
      next();
    };
    const vaultChain: VaultChain = {
      contractState: async (v) => chain.contract(v),
      serialize: (s) => (s as { serialize(): Uint8Array }).serialize(),
      notesOf: (s) => [...vaultLedgerOf(s as never).notes].map((c: Uint8Array) => hex(c) as Hex),
      startingLedgerOf: (s) => startingLedgerFrom(vaultLedgerOf(s as never)),
      everCreated: async (v) => chain.everCreated.get(v.toLowerCase()) ?? new Set(),
      /* One moment of this chain; a deposit reads the ledger parameters from it. */
      payoutState: async (v, account) => {
        const vs = chain.contract(v);
        const as = chain.contract(account);
        if (vs === null || as === null) return null;
        const b64 = (x: { serialize(): Uint8Array }) => base64FromBytes(x.serialize());
        return {
          blockHash: 'b1'.repeat(32), vaultState: b64(vs), zswapState: b64(chain.state.zswap),
          parameters: b64(chain.state.parameters), accountState: b64(as),
        };
      },
      /* As an indexer would answer it: the one applied transaction whose events carry this output, made for this vault. */
      createdBy: async (v, commitment) => {
        for (const [name, events] of chain.events) {
          const wire = events.map((e: any) => ({
            transactionHash: name,
            details: {
              tag: String(e.content.tag),
              ...(e.content.commitment === undefined ? {} : { commitment: String(e.content.commitment) }),
              ...(e.content.contract === undefined ? {} : { contract: String(e.content.contract) }),
              ...(e.content.mtIndex === undefined ? {} : { mtIndex: String(e.content.mtIndex) }),
            },
          }));
          if (wire.some((e) => e.details.tag === 'zswapOutput' && e.details.commitment?.toLowerCase() === commitment.toLowerCase()
            && e.details.contract?.toLowerCase() === v.toLowerCase())) return { transactionHash: name as Hex, events: wire };
        }
        return null;
      },
    };
    /* A fee payer that adds no fee, and whose submission is the chain applying the transaction. */
    const payer = {
      addFeeAndFinalise: async (tx: unknown) => tx,
      submit: async (tx: any) => {
        if (dropHandover && tx.intents && [...tx.intents.values()][0].actions[0]?.updates) {
          throw new Error('the node did not answer');
        }
        const r = chain.apply(tx);
        if (!r.ok) throw new Error(`the chain refused it: ${r.error}`);
        return { ref: String(tx.identifiers()[0]), at: new Date().toISOString() };
      },
      release: async () => {}, payingFor: () => {}, capacity: async () => ({ dust: 1n, night: 1n }),
    };
    const ledger = new ChainLedger({} as never, { network: NET, indexerUrl: 'x' } as never, {
      maintenanceAuthority: { kind: 'unmaintainable' }, compiled: {},
      customer: { balanceOwnLegs: async () => { throw new Error('no company wallet is asked'); }, coinPublicKey: () => '', encryptionPublicKey: () => '', release: async () => {} },
      sponsor: payer, storagePassword: async () => 'x',
    } as never);
    app.use(companyVaultRoutes({
      signedIn, member, store,
      giveVaultKeys: (id, vk, person, given) => accounts.giveVaultKeys(id, vk as Hex, person, given),
      company: async () => ({ address: company, threshold: companyThreshold }),
      ledger, chain: vaultChain,
      verifierKeys: async () => new Map(await Promise.all(
        ['deposit', 'depositUnshielded', 'forgetUnshielded', 'payout', 'payoutUnshielded', 'retire', 'splitNote']
          .map(async (c) => [c, await zk.getVerifierKey(c) as unknown as Uint8Array] as const))),
      account: {
        circuits: DEPLOYED_CIRCUITS,
        verifierKeys: accountKeys,
        handover: accountHandoverWith(
          { kind: 'single-key', signingKey: TEMPORARY_ACCOUNT_KEY, temporary: { fixedBy: 'this watch' } }, NET),
        temporaryKey: await accountTemporaryVerifyingKey(
          { kind: 'single-key', signingKey: TEMPORARY_ACCOUNT_KEY, temporary: { fixedBy: 'this watch' } }),
      },
      readers,
    }));
    serverStores = new Map(RECORDS.map((r) => [r, new MemorySealedPoolStore()]));
    mountVaultRecords(app, {
      signedIn,
      records: { of: (r) => serverStores.get(r)! },
      accountOf: vaultAccountFromTheIndexer({
        queryContractState: async (a) => { const c = chain.contract(a); return c === null ? null : { data: asRuntime(c).data }; },
      }),
      companies: () => store.listAccounts().map((a) => ({ id: a.id, contractAddress: company, memberUserIds: a.memberUserIds })),
      filingKeyOf: (id, person) => store.getFilingKey(id, person)?.filingKey ?? null,
    });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  /* ------------------------------------------------------------ the page */
  const http = async (path: string, init: { method: string; body?: unknown } = { method: 'GET' }, as = 'ada') => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    if (body !== undefined) sent.push(body);
    const r = await fetch(base + path, {
      method: init.method, ...(body === undefined ? {} : { body }),
      headers: { 'content-type': 'application/json', 'x-test-person': as },
    });
    const json = await r.json().catch(() => ({}));
    answered.push(JSON.stringify(json));
    if (!r.ok) throw Object.assign(new Error(json.error ?? `status ${r.status}`), { status: r.status, nothingWasSent: json.nothingWasSent });
    return json;
  };
  const service = (as = 'ada'): VaultService => ({
    keys: () => http(`/api/accounts/${ACCOUNT_ID}/vault-keys`, undefined, as),
    deploy: (tx) => http(`/api/accounts/${ACCOUNT_ID}/vaults`, { method: 'POST', body: { tx } }, as),
    handover: (vault, tx) => http(`/api/accounts/${ACCOUNT_ID}/vaults/${vault}/handover`, { method: 'POST', body: { tx } }, as),
    chain: (vault) => http(`/api/accounts/${ACCOUNT_ID}/vaults/${vault}/chain`, undefined, as),
    deposit: (vault, tx) => http(`/api/accounts/${ACCOUNT_ID}/vaults/${vault}/deposit`, { method: 'POST', body: { tx } }, as),
    /* A payment out is watched in `a-private-payment-from-the-page.test.ts`; a deposit reads the chain's parameters here. */
    payoutState: (vault) => http(`/api/accounts/${ACCOUNT_ID}/vaults/${vault}/payout-state`, undefined, as),
    events: () => { throw new Error('this watch makes no payment out'); },
    createdBy: async (vault, commitment) => {
      const found = await http(`/api/accounts/${ACCOUNT_ID}/vaults/${vault}/created/${commitment}`, undefined, as);
      return found.found === true ? { transactionHash: found.transactionHash, events: found.events } : null;
    },
    payout: () => { throw new Error('this watch makes no payment out'); },
    payoutPublicly: () => { throw new Error('this watch makes no payment out'); },
  });
  const keys: TemporaryKeys = {
    put: async (v, k) => { temporaryKeys.set(v, k); },
    get: async (v) => temporaryKeys.get(v) ?? null,
    forget: async (v) => { temporaryKeys.delete(v); },
  };
  const pacing = { sleep: async () => {}, waitMs: 3, everyMs: 1 };
  const wireAs = (person: string): WireSend => async (path, init) => {
    if (init.body !== undefined) sent.push(init.body);
    const r = await fetch(base + path, {
      method: init.method, ...(init.body === undefined ? {} : { body: init.body }),
      headers: { 'content-type': 'application/json', 'x-test-person': person },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const records = (secret = signing.secret) => (record: WireRecord) =>
    new HttpSealedPoolStore(record, wireAs('ada'), secret, async () => new Set([signing.publicKey]));
  const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
  const giveKeys = () => http(`/api/accounts/${ACCOUNT_ID}/vault-keys`, {
    method: 'PUT',
    body: {
      viewingKey,
      ...signVaultKeys(ACCOUNT_ID, 'ada', {
        committeeKey: committeeKeyFor(identityFromWords(words), company), recordsKey: recordsReaderOf(me.companyKey).publicKey,
      }, signing.secret),
    },
  });
  /** The person's wallet: its own reader decides what is shown, and it binds what it was given. */
  const wallet = async (ask: { company: Hex; vault: Hex; transaction: string }) => {
    const asProven = { Transaction: { deserialize: (_s: string, _p: string, b: 'pre-binding', raw: Uint8Array) => L.Transaction.deserialize('signature', 'pre-proof', b, raw) } };
    const read = readWhatThePageAsks(asProven as never, ask.transaction, ask.vault);
    shown.push(read.leaves);
    /* What the wallet's coins and proofs would be is not run here: it is bound, and nothing is added. */
    /* Paid for with the stand-in wallet's own private coin, as a wallet does, then bound. */
    return { transaction: base64FromBytes((depositor.payFor(read.tx) as any).bind().serialize()), leaves: read.leaves };
  };
  let shown: unknown[] = [];
  /* Every body the service answered with, so what it holds can be looked for in what it said. */
  const answered: string[] = [];

  it('NO COMMITTEE, NO DEPLOY: a vault is refused until every signer\'s wallet has given its committee key', async () => {
    const doors = { ...pacing, account: company, service: service(), builder: builder(), keys };
    await expect(createCompanyVault(doors)).rejects.toThrow(/committee that must hold the vault's rules is not complete/);
    expect(chain.applied).toEqual([]);
    /* And the route itself refuses a deploy sent without asking. */
    const built = await builder().deploy(company);
    await expect(http(`/api/accounts/${ACCOUNT_ID}/vaults`, { method: 'POST', body: { tx: built.tx } }))
      .rejects.toMatchObject({ status: 409, nothingWasSent: true });
    expect(chain.applied).toEqual([]);
  });

  it('CREATED, HANDED OVER, POOLED AND FUNDED - AND NOTHING IS REPORTED DONE UNTIL THE CHAIN SAYS SO', async () => {
    await giveKeys();
    const committee = committeeKeyFor(identityFromWords(words), company);

    /* ---- the handover is lost on its way: FAILED, the vault named, nothing reported created ---- */
    dropHandover = true;
    const doors = { ...pacing, account: company, service: service(), builder: builder(), keys };
    const lost = await createCompanyVault(doors).catch((e) => e);
    expect(lost, String(lost?.message)).toBeInstanceOf(VaultHandoverOwed);
    const vault = (lost as VaultHandoverOwed).vault;
    expect(lost.message).toContain(vault);
    expect(chain.applied.map((a) => a.ok), lost.message).toEqual([true]);
    const onChain = chain.contract(vault);
    expect(onChain.maintenanceAuthority.committee).toHaveLength(1);
    expect(onChain.maintenanceAuthority.committee[0].value).not.toBe(committee.value);
    expect(hex(vaultLedgerOf(onChain).account.bytes)).toBe(company);
    const listed = await http(`/api/accounts/${ACCOUNT_ID}/vaults`);
    expect(listed.rows).toEqual([expect.objectContaining({ vault, state: 'handover-owed' })]);
    /* The temporary key is still on this device, and on nothing the service received. */
    expect(temporaryKeys.has(vault)).toBe(true);
    expect(sent.some((b) => b.includes(temporaryKeys.get(vault)!.value))).toBe(false);

    /* ---- no money goes in while the committee does not hold it: read from the chain ---- */
    await expect(openCompanyVaultPool({ ...pacing, service: service(), me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records: records() }, vault))
      .rejects.toThrow(/not held by the company's committee/);
    const early = await builder().deposit({
      vault, coin: { nonce: 'c1'.repeat(32), token: GBP, value: '5' },
      state: (await http(`/api/accounts/${ACCOUNT_ID}/vaults/${vault}/chain`)).state,
      parameters: base64FromBytes(chain.state.parameters.serialize()),
    });
    await expect(http(`/api/accounts/${ACCOUNT_ID}/vaults/${vault}/deposit`, {
      method: 'POST', body: { tx: base64FromBytes((L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', bytesFromBase64(early.tx)) as any).bind().serialize()) },
    })).rejects.toMatchObject({ status: 409, nothingWasSent: true });
    expect(chain.applied).toHaveLength(1);

    /* ---- running it again finishes the handover, against the counter the chain holds ---- */
    dropHandover = false;
    await expect(createCompanyVault(doors, vault)).resolves.toEqual({ vault, state: 'held-by-committee' });
    expect(chain.applied.map((a) => a.ok)).toEqual([true, true]);
    const held = chain.contract(vault).maintenanceAuthority;
    expect(held.committee.map((k: { value: string }) => k.value)).toEqual([committee.value]);
    expect(held.threshold).toBe(1);
    expect(held.counter).toBe(1n);
    expect(temporaryKeys.has(vault)).toBe(false);
    /* The committee holds the vault; the account it pays out on is still the service's temporary key's. */
    expect((await http(`/api/accounts/${ACCOUNT_ID}/vaults`)).rows)
      .toEqual([expect.objectContaining({ vault, state: 'account-not-handed-over' })]);

    /* ---- the pool and the nonce secret, filed signed through the mounted route ---- */
    const poolDoors = { ...pacing, service: service(), me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records: records() };
    await openCompanyVaultPool(poolDoors, vault);
    expect(await serverStores.get('pool')!.get(vault)).not.toBeNull();
    expect(await serverStores.get('nonce-secret')!.get(vault)).not.toBeNull();
    await openCompanyVaultPool(poolDoors, vault);
    expect((await serverStores.get('pool')!.versions(vault)).length).toBe(1);
    /* A filing signed with a key its filer did not give is refused, whoever sends it. */
    const stranger = newSigningKeypair();
    await expect(new SealedNotePool(records(stranger.secret)('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers)
      .save(vault, { notes: [] }, { vault, version: 1 })).rejects.toThrow(/403|not filed|could not be/);
    expect((await serverStores.get('pool')!.versions(vault)).length).toBe(1);

    /* ---- NO MONEY GOES IN WHILE THE ACCOUNT IS STILL THE TEMPORARY KEY'S, AND THE WALLET IS NOT ASKED ---- */
    shown = [];
    await expect(depositIntoCompanyVault({
      ...poolDoors, company, builder: builder(), pay: wallet, inFlight: inFlightInMemory(),
    }, vault, { token: GBP, value: 1n })).rejects.toThrow(/account is still held by the temporary key/);
    expect(shown).toEqual([]);
    expect(chain.applied).toHaveLength(2);
    const before = await http(`/api/accounts/${ACCOUNT_ID}/authority`);
    expect(before.contracts[0]).toMatchObject({ contract: 'account', address: company, heldByTheCompany: false, shape: 'one-key', changes: '0' });
    expect(before.contracts[1]).toMatchObject({ contract: 'vault', address: vault, heldByTheCompany: true, changes: '1' });
    /* Whose each seat is, the service does not say: the page names it from the roster it opens. */
    expect(before.contracts[1].seats).toEqual([{ key: committee, holder: null, thisService: false, onTheCompanysCommittee: true }]);
    expect(before.contracts[0].seats).toEqual([expect.objectContaining({ thisService: true, onTheCompanysCommittee: false })]);
    /* The page's own check, against the key the wallet itself derives. */
    const roster = openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey);
    expect(whyNotHandOver(before, committee, roster, { signerId: 'ada' })).toBeNull();
    expect(whyNotHandOver(before, committeeKeyFor(identityFromWords(newWords().join(' ')), company), roster, { signerId: 'ada' }))
      .toMatch(/roster does not carry the key your wallet gives/);
    expect(before.everySignerNeeded).toMatch(/only signer/);
    expect(before.handover).toMatchObject({ possible: true, why: null });

    /* ---- a committee at a threshold of nothing is refused before anything is signed or sent ---- */
    companyThreshold = 0;
    await expect(http(`/api/accounts/${ACCOUNT_ID}/authority/handover`, { method: 'POST', body: {} }))
      .rejects.toMatchObject({ status: 409, nothingWasSent: true, message: expect.stringMatching(/threshold is 0/) });
    expect(chain.applied).toHaveLength(2);
    expect(chain.contract(company).maintenanceAuthority.counter).toBe(0n);
    companyThreshold = 1;

    /* ---- the account handed to the committee, by the service's temporary key, read back from the chain ---- */
    await http(`/api/accounts/${ACCOUNT_ID}/authority/handover`, { method: 'POST', body: { committee: before.committee } });
    expect(chain.applied.map((a) => a.ok)).toEqual([true, true, true]);
    const accountHeld = chain.contract(company).maintenanceAuthority;
    expect(accountHeld.committee.map((k: { value: string }) => k.value)).toEqual([committee.value]);
    expect(accountHeld.threshold).toBe(1);
    expect(accountHeld.counter).toBe(1n);
    const after = await http(`/api/accounts/${ACCOUNT_ID}/authority`);
    expect(after.contracts[0]).toMatchObject({ contract: 'account', heldByTheCompany: true, changes: '1', seatsOutsideTheCommittee: 0 });
    expect(after.handover.possible).toBe(false);
    expect((await http(`/api/accounts/${ACCOUNT_ID}/vaults`)).rows)
      .toEqual([expect.objectContaining({ vault, state: 'held-by-committee', why: null })]);
    /* And once is all: the temporary key cannot change the account again through this route. */
    await expect(http(`/api/accounts/${ACCOUNT_ID}/authority/handover`, { method: 'POST', body: { committee: before.committee } }))
      .rejects.toMatchObject({ status: 409, nothingWasSent: true });
    expect(chain.applied).toHaveLength(3);
    expect(sent.some((b) => b.includes(TEMPORARY_ACCOUNT_KEY.value))).toBe(false);
    expect(answered.length).toBeGreaterThan(5);
    expect(answered.some((b) => b.includes(TEMPORARY_ACCOUNT_KEY.value))).toBe(false);

    /* ---- the deposit ---- */
    shown = [];
    const deposited = await depositIntoCompanyVault({
      ...poolDoors, company, builder: builder(), pay: wallet, inFlight: inFlightInMemory(),
    }, vault, { token: GBP, value: 1_000n });
    expect(chain.applied.map((a) => a.ok)).toEqual([true, true, true, true]);

    expect(shown).toEqual([[{ token: GBP, amount: '1000', kind: 'shielded' }]]);
    const notes = [...vaultLedgerOf(chain.contract(vault)).notes].map((c: Uint8Array) => hex(c));
    expect(notes).toHaveLength(1);
    /* An unproven transaction has no hash, so the service names none; the note is recorded under the transaction the
     * vault's history holds its output in, found through the service's own route by the output's commitment. */
    expect(chain.applied[3]!.hash).toMatch(/^unproven:/);
    expect(deposited.transactionHash).toBeNull();
    /* RED WHEN: the page does not look the deposit up by its output - the note is then recorded without its transaction. */
    expect(deposited.note.createdIn, 'the deposit is recorded without its creating transaction')
      .toBe(createHash('sha256').update(chain.applied[3]!.hash.slice('unproven:'.length)).digest('hex'));
    expect(deposited.notYetSpendable).toBeUndefined();
    const pool = new SealedNotePool(records()('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers);
    const loaded = await pool.load(vault);
    expect(loaded.notes).toEqual([deposited.note]);
    expect(notes[0]).toBe((await builder().commitments({ vault, coin: { nonce: deposited.note.nonce, token: GBP, value: '1000' } })).held);
    expect(loaded.notes[0]!.value).toBe(1_000n);

    /* ---- nothing the service received carried a key a wallet or this device keeps ---- */
    for (const secret of [
      hex(me.companyKey), wrapping.secret, signing.secret,
      identityFromWords(words).words.join(' '),
    ]) {
      expect(sent.some((b) => b.includes(secret))).toBe(false);
    }
  });

  it('THE LEDGER\'S OWN RULES THIS RESTS ON: a deploy and its handover cannot share a transaction, and a deposit is open to anyone', async () => {
    const built = await builder(false).deploy(company);
    const deploy = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', bytesFromBase64(built.tx)) as any;
    const temporary = signingKeyFromBip340(Buffer.from(built.temporaryKey.value, 'hex'));
    const to = { committee: [committeeKeyFor(identityFromWords(words), company)], threshold: 1 };
    let update = committeeReplacement(L as never, { vault: built.vault, counter: 0n, to }) as any;
    update = update.addSignature(0n, L.signData(temporary, update.dataToSign));
    const intent = [...deploy.intents.values()][0];
    const both = L.Transaction.fromParts(NET, undefined, undefined,
      L.Intent.new(new Date(Date.now() + 600_000)).addDeploy(intent.actions[0]).addMaintenanceUpdate(update));
    expect(() => chain.apply(both)).toThrow(/non-existant contract/i);
    expect(chain.apply(deploy).ok).toBe(true);
    /* The residue: before its handover, the vault takes a deposit from anybody at all. */
    const stranger = await builder().deposit({
      vault: built.vault, coin: { nonce: 'd2'.repeat(32), token: GBP, value: '7' }, state: base64FromBytes(chain.contract(built.vault).serialize()),
      parameters: base64FromBytes(chain.state.parameters.serialize()),
    });
    expect(chain.apply(L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', bytesFromBase64(stranger.tx))).ok).toBe(true);
    expect([...vaultLedgerOf(chain.contract(built.vault)).notes]).toHaveLength(1);
  });
});

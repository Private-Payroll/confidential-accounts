/**
 * **ONE PERSON PAID PRIVATELY OUT OF A COMPANY'S VAULT, FROM A SIGNER'S DEVICE,
 * THROUGH THE ROUTES THE PAGE CALLS - AND THE ACCOUNT, THE VAULT, THE POOL AND
 * THE PAYEE'S COIN READ BACK AFTERWARDS.**
 *
 * What is real here:
 *   · the chain is the ledger's own state machine (`LedgerState`), applying
 *     each transaction as its own block, with signatures checked;
 *   · the company account is the compiled account, deployed with the state its
 *     own constructor writes for one founding signer and this build's circuits,
 *     and its run is raised and approved by calls built from that signer's own
 *     private state, applied by the chain;
 *   · the vault is the compiled vault, created, handed over, pooled and funded
 *     by the device's own operations, and the payment out is built by the
 *     device's own builder through the worker's own message handling, with the
 *     account's `recordPayment` computed inside the same call against the
 *     account's state as the chain holds it;
 *   · the service is the product's own routes over real HTTP, and a real
 *     `ChainLedger` sends each transaction through its one-write lane after the
 *     service's own reader has read it;
 *   · the pool and both journals are sealed on the device and filed signed
 *     through the product's own records mount.
 *
 * **WHAT THIS DOES NOT SHOW, SAID HERE SO NOTHING RELIES ON IT:**
 *   · **no proof is made.** A circuit's call reaches the service unproven and
 *     the ledger is told not to check proofs. So whether a device's prover holds
 *     both contracts' keys for one payment is not measured here; the page's
 *     prover is pointed at both, and the first run on a network is what proves
 *     it;
 *   · **the ledger is told not to check that a transaction balances**, so no fee
 *     is paid by anybody;
 *   · **an unproven transaction has no hash**, so this chain names each one by a
 *     hash of its identifier and serves its events under that name, which is
 *     what the indexer does with a real hash;
 *   · the run's material is rebuilt here by the same function the service's
 *     route calls (`assemblePrivatePayments`), from a run built here; the
 *     payroll store and the route's reading of it are not driven;
 *   · nothing reaches a real network, a real indexer, a browser or a wallet;
 *   · **a vault's public money is put there by calling its public deposit
 *     straight onto this chain**, which does not check balancing, so the
 *     public payments below are paid out of money no wallet sent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { identityFromWords, newWords } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { parseAsk } from 'midnight-identity/profile/request';
import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import * as vaultModule from '../managed-vault/contract/index.js';
import * as accountModule from '../managed/contract/index.js';
import { witnesses, type AccountPrivateState } from '../src/witnesses.js';
import { privateStateFor, leafOfDevice, change, ZERO_32 } from './simulator.js';
import { MemoryStore } from '../../src/core/store.js';
import { AccountService, sealAccount } from '../../src/core/account.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { signVaultKeys } from '../../src/core/vault-keys.js';
import { ChainLedger } from '../../src/wiring/chain.js';
import { companyVaultRoutes, type VaultChain } from '../../src/server/company-vaults.js';
import { mountVaultRecords, vaultAccountFromTheIndexer } from '../../src/server/vault-records-authority.js';
import { MemorySealedPoolStore, SealedNotePool } from '../../src/midnight/vault-pool.js';
import { PaymentJournalInStore } from '../../src/midnight/vault-journal.js';
import type { WireRecord } from '../../src/midnight/sealed-record-wire.js';
import { HttpSealedPoolStore, type WireSend } from '../../src/web/http-sealed-pool-store.js';
import { recordsReaderOf, type DeviceSigner } from '../../src/web/deposit-on-device.js';
import { answerVaultAsk } from '../../src/web/vault-worker-entry.js';
import { vaultBuilderOver, type VaultAnswer } from '../../src/web/vault-worker-client.js';
import {
  createCompanyVault, depositIntoCompanyVault, openCompanyVaultPool, payPrivatelyFromCompanyVault,
  payPubliclyFromCompanyVault,
  type TemporaryKeys, type VaultService, type DepositInFlight, type DepositsInFlight,
} from '../../src/web/vault-operation.js';
import { readWhatThePageAsks, base64FromBytes } from '../../apps/wallet/src/chain/balance-for-page.js';
import { UNLOCK_PURPOSE, UNLOCK_WINDOW_MS, unlockAsk } from '../../src/core/wallet-unlock.js';
import { fromHex, newSigningKeypair, newWrappingKeypair, toHex, type Hex } from '../../src/core/crypto.js';
import { accountHandoverWith, accountTemporaryVerifyingKey, accountVerifierKeysIn } from '../../src/server/vault-chain.js';
import { DEPLOYED_CIRCUITS } from '../../src/midnight/deferral.js';
import { fileURLToPath } from 'node:url';
import { readProvenTransaction } from '../../src/wiring/proven-submission.js';
import { refusalForPayout, refusalForPublicPayout, startingLedgerFrom } from '../../src/wiring/vault-submission.js';
import { signingKeyFromBip340 } from '@midnightntwrk/ledger-v9';
import { buildRun, rootOfLeaves } from '../../src/midnight/payout-tree.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { payeeAddressFromKeys, type Payee } from '../../src/midnight/payee-address.js';
import { unshieldedPayeeFor } from '../../src/testing/payees.js';
import { assemblePrivatePayments } from '../../src/midnight/private-payment-wire.js';
import { witnessesOver } from '../../src/midnight/vault-notes.js';

/** Deposits in flight, kept for the length of one test. */
const inFlightInMemory = (): DepositsInFlight => {
  const kept = new Map<string, DepositInFlight>();
  return {
    get: async (v) => kept.get(v) ?? null,
    put: async (v, d) => { kept.set(v, d); },
    forget: async (v) => { kept.delete(v); },
  };
};

const NET = 'undeployed';
const RECORDS: readonly WireRecord[] = ['pool', 'deposit-journal', 'payment-journal', 'nonce-secret'];
const ACCOUNT_ID = 'acc_paying';
const TOKEN = 'a7'.repeat(32) as Hex;
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const asRuntime = (state: { serialize(): Uint8Array }) => (runtime as any).ContractState.deserialize(state.serialize());
const vaultLedgerOf = (state: { serialize(): Uint8Array }) => (vaultModule as any).ledger(asRuntime(state).data);
const accountLedgerOf = (state: { serialize(): Uint8Array }) => (accountModule as any).ledger(asRuntime(state).data);
const accountCircuits = (accountModule as any).pureCircuits;

const releasedCompanyKey = (words: string, company: string): Uint8Array => {
  const ask = parseAsk(unlockAsk({
    name: 'Confidential Accounts', rdns: 'social.lemonade.confidential-accounts', purpose: UNLOCK_PURPOSE,
    nonce: 'derivation-has-no-conversation', expiresAt: UNLOCK_WINDOW_MS, company,
  }), 'https://payroll.example', 0);
  if (ask.kind !== 'unlock') throw new Error('not an unlock');
  return unlockKeyFor(identityFromWords(words), ask);
};

/**
 * **THE NAME THIS CHAIN FILES AN UNPROVEN TRANSACTION UNDER.** A proven one has
 * a hash of its own; an unproven one has only identifiers, so it is named by a
 * hash of its first, the same way on the way in and on the way out.
 */
const nameOf = (tx: any): string => {
  try { return String(tx.transactionHash()); } catch {
    return createHash('sha256').update(String(tx.identifiers()[0])).digest('hex');
  }
};

/** The ledger's own state machine, one transaction per block, signatures checked, every block's events kept. */
class Chain {
  state: any = L.LedgerState.blank(NET);
  everCreated = new Map<string, Set<string>>();
  events = new Map<string, any[]>();
  applied: Array<{ name: string; ok: boolean; error: string; tx: any }> = [];
  apply(tx: any): { ok: boolean; error: string } {
    const s = new L.WellFormedStrictness();
    s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = false;
    s.enforceLimits = false; s.verifySignatures = true;
    const now = new Date();
    const t = BigInt(Math.floor(now.getTime() / 1000));
    const [next, result] = this.state.apply(tx.wellFormed(this.state, s, now),
      new L.TransactionContext(this.state, {
        secondsSinceEpoch: t, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: t - 6n,
      }));
    const ok = result.type === 'success';
    const name = nameOf(tx);
    if (ok) {
      /* Each transaction is its own block, so the commitment tree's root is one a later spend may prove against. */
      this.state = next.postBlockUpdate(now);
      this.events.set(name, [...result.events]);
      for (const offer of [tx.guaranteedOffer, ...(tx.fallibleOffer ? [...tx.fallibleOffer.values()] : [])]) {
        for (const out of offer?.outputs ?? []) {
          if (out.contractAddress === undefined) continue;
          const k = String(out.contractAddress).toLowerCase();
          this.everCreated.set(k, (this.everCreated.get(k) ?? new Set()).add(String(out.commitment).toLowerCase()));
        }
      }
    }
    this.applied.push({ name, ok, error: String(result.error ?? ''), tx });
    return { ok, error: String(result.error ?? '') };
  }
  contract(address: string): any | null {
    try { return this.state.index(address) ?? null; } catch { return null; }
  }
}

const TEMPORARY_ACCOUNT_KEY = signingKeyFromBip340(new Uint8Array(32).fill(0x5a));
const accountKeys = accountVerifierKeysIn(fileURLToPath(new URL('../..', import.meta.url)));
const TEMPORARY = { kind: 'single-key', signingKey: TEMPORARY_ACCOUNT_KEY, temporary: { fixedBy: 'this watch' } } as const;

/*
 * **THE VAULT'S AND THE ACCOUNT'S VERIFIER KEYS, WHICH ONLY A FULL COMPILE OF
 * EACH PRODUCES.** The general checks compile without them, so this is skipped
 * there by name, and the job that builds the keys runs this file by name.
 */
const KEYS_ON_DISK = ['deposit', 'payout', 'payoutUnshielded'].every((c) => existsSync(new URL(`../managed-vault/keys/${c}.verifier`, import.meta.url)))
  && ['propose', 'approve', 'recordPayment'].every((c) => existsSync(new URL(`../managed/keys/${c}.verifier`, import.meta.url)));
if (!KEYS_ON_DISK) {
  console.log(
    '  NOT CHECKED HERE: the vault\'s and the account\'s verifier keys are not on disk, so a private payment'
    + ' was not made out of a company vault through the routes the page calls.'
    + ' `npm run compact:vault -- --full` and `npm run compact` build them.',
  );
}

describe.skipIf(!KEYS_ON_DISK)('A PRIVATE PAYMENT OUT OF A COMPANY VAULT, FROM THE SIGNER\'S DEVICE [needs contracts/managed-vault/keys and contracts/managed/keys; `npm run compact` then `npm run compact:vault -- --full` build them]', () => {
  let chain: Chain;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let store: MemoryStore;
  let viewingKey: Hex;
  let company: Hex;
  let words: string;
  let me: DeviceSigner;
  let founder: AccountPrivateState;
  let signing: ReturnType<typeof newSigningKeypair>;
  let wrapping: ReturnType<typeof newWrappingKeypair>;
  let sent: string[];
  let arrivals: string[];
  let temporaryKeys: Map<string, { tag: string; value: string }>;
  let serverStores: Map<WireRecord, MemorySealedPoolStore>;

  const vaultZk = new NodeZkConfigProvider(new URL('../managed-vault', import.meta.url).pathname);
  const accountZk = new NodeZkConfigProvider(new URL('../managed', import.meta.url).pathname);
  const vaultCompiled = (w: unknown) => CompiledContract.make('Vault', (vaultModule as any).Contract).pipe(
    CompiledContract.withWitnesses(w as never));
  const accountCompiled = CompiledContract.make('ConfidentialAccount', (accountModule as any).Contract).pipe(
    CompiledContract.withWitnesses(witnesses as never));
  const neverAsked = {
    check: async () => { throw new Error('asked to check a circuit'); },
    prove: async () => { throw new Error('asked to prove a circuit'); },
    lookupKey: async () => undefined,
  };
  /** The worker's own handler, reached through the page's own client, with no Worker and no prover. */
  const builder = () => {
    const deps = async () => ({
      ledger: L, vault: vaultModule, runtimeState: (runtime as any).ContractState, contracts: contracts as any,
      compiled: vaultCompiled({ noteToSpend: () => { throw new Error('nothing here spends'); } }),
      compiledWith: (w: ReturnType<typeof witnessesOver>) => vaultCompiled(w),
      zkConfig: vaultZk,
      prove: async (unproven: any, circuit?: string) =>
        (circuit === undefined ? unproven.prove(neverAsked, (L as any).CostModel.initialCostModel()) : unproven),
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
  /* A proven transaction is read by the service's own reader; the unproven ones this watch makes, as themselves. */
  const readers = {
    proven: async (b: Uint8Array) => {
      try { return await readProvenTransaction(b); } catch { return L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', b); }
    },
    finished: async (b: Uint8Array) => L.Transaction.deserialize('signature', 'pre-proof', 'binding', b),
  };

  /** A call into the company account, built from one signer's own private state and applied by the chain. */
  const callAccount = async (circuitId: string, args: unknown[], privateState: AccountPrivateState) => {
    const keys = L.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
    const built = await (contracts as any).createUnprovenCallTxFromInitialStates(accountZk, {
      compiledContract: accountCompiled, circuitId, contractAddress: company, coinPublicKey: keys.coinPublicKey,
      initialContractState: asRuntime(chain.contract(company)),
      initialZswapChainState: new L.ZswapChainState(),
      ledgerParameters: L.LedgerParameters.initialParameters(),
      initialPrivateState: privateState, args,
    }, keys.encryptionPublicKey);
    const r = chain.apply(built.private.unprovenTx);
    if (!r.ok) throw new Error(`the chain refused ${circuitId}: ${r.error}`);
  };

  beforeEach(async () => {
    setNetworkId(NET as never);
    chain = new Chain();
    store = new MemoryStore();
    founder = privateStateFor(1);
    /* The company account, with the state its own constructor writes for its founder, this build's circuits and the service's temporary key. */
    const init = await new (accountModule as any).Contract(witnesses).initialState(
      runtime.createConstructorContext(founder, '0'.repeat(64)), leafOfDevice(founder));
    const accountState = L.ContractState.deserialize(init.currentContractState.serialize());
    accountState.maintenanceAuthority = new L.ContractMaintenanceAuthority([L.signatureVerifyingKey(TEMPORARY_ACCOUNT_KEY)], 1, 0n);
    for (const c of DEPLOYED_CIRCUITS) {
      const op = new L.ContractOperation();
      op.verifierKey = new Uint8Array(readFileSync(new URL(`../managed/keys/${c}.verifier`, import.meta.url)));
      accountState.setOperation(c, op);
    }
    const accountDeploy = new L.ContractDeploy(accountState);
    const seeded = chain.apply(L.Transaction.fromParts(NET, undefined, undefined,
      L.Intent.new(new Date(Date.now() + 600_000)).addDeploy(accountDeploy)));
    if (!seeded.ok) throw new Error(`the company account was not deployed: ${seeded.error}`);
    chain.applied.pop();
    company = String(accountDeploy.address).toLowerCase() as Hex;
    words = newWords().join(' ');
    signing = newSigningKeypair();
    wrapping = newWrappingKeypair();
    me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: releasedCompanyKey(words, company) };
    sent = [];
    arrivals = [];
    temporaryKeys = new Map();
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
      /* One moment of this chain: both contracts and the commitment tree as it stands. */
      payoutState: async (vault, account) => {
        const v = chain.contract(vault);
        const a = chain.contract(account);
        if (v === null || a === null) return null;
        const b64 = (x: { serialize(): Uint8Array }) => base64FromBytes(x.serialize());
        return {
          blockHash: 'b1'.repeat(32), vaultState: b64(v), zswapState: b64(chain.state.zswap),
          parameters: b64(chain.state.parameters), accountState: b64(a),
        };
      },
      /* As the indexer serves them: the transaction's own events, named by its hash. */
      eventsOf: async (tx) => (chain.events.get(tx) ?? []).map((e: any) => ({
        transactionHash: tx,
        details: {
          tag: String(e.content.tag),
          ...(e.content.commitment === undefined ? {} : { commitment: String(e.content.commitment) }),
          ...(e.content.contract === undefined ? {} : { contract: String(e.content.contract) }),
          ...(e.content.mtIndex === undefined ? {} : { mtIndex: String(e.content.mtIndex) }),
        },
      })),
    };
    /* A fee payer that adds no fee, names what it finalises as the chain names it, and whose submission is the chain applying it. */
    const payer = {
      addFeeAndFinalise: async (tx: any) => ({ tx, transactionHash: () => nameOf(tx) }),
      submit: async (finalised: any) => {
        const r = chain.apply(finalised.tx);
        if (!r.ok) throw new Error(`the chain refused it: ${r.error}`);
        return { ref: String(finalised.tx.identifiers()[0]), at: new Date().toISOString() };
      },
      release: async () => {}, payingFor: () => {}, capacity: async () => ({ dust: 1n, night: 1n }),
    };
    const ledger = new ChainLedger({} as never, { network: NET, indexerUrl: 'x' } as never, {
      maintenanceAuthority: { kind: 'unmaintainable' }, compiled: {},
      customer: { balanceOwnLegs: async () => { throw new Error('no company wallet is asked'); }, coinPublicKey: () => '', encryptionPublicKey: () => '', release: async () => {} },
      sponsor: payer, storagePassword: async () => 'x',
    } as never);
    const watched = {
      sendVault: (...args: Parameters<NonNullable<typeof ledger.sendVault>>) => {
        arrivals.push(args[2]);
        return ledger.sendVault(...args);
      },
    };
    app.use(companyVaultRoutes({
      signedIn, member, store,
      giveVaultKeys: (id, vk, person, given) => accounts.giveVaultKeys(id, vk as Hex, person, given),
      company: async () => ({ address: company, threshold: 1 }),
      ledger: watched, chain: vaultChain,
      verifierKeys: async () => new Map(await Promise.all(
        ['deposit', 'depositUnshielded', 'forgetUnshielded', 'payout', 'payoutUnshielded', 'retire', 'splitNote']
          .map(async (c) => [c, await vaultZk.getVerifierKey(c) as unknown as Uint8Array] as const))),
      account: {
        circuits: DEPLOYED_CIRCUITS,
        verifierKeys: accountKeys,
        handover: accountHandoverWith(TEMPORARY, NET),
        temporaryKey: await accountTemporaryVerifyingKey(TEMPORARY),
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
  const http = async (path: string, init: { method: string; body?: unknown } = { method: 'GET' }) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    if (body !== undefined) sent.push(body);
    const r = await fetch(base + path, {
      method: init.method, ...(body === undefined ? {} : { body }),
      headers: { 'content-type': 'application/json', 'x-test-person': 'ada' },
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(json.error ?? `status ${r.status}`), { status: r.status, nothingWasSent: json.nothingWasSent });
    return json;
  };
  const at = `/api/accounts/${ACCOUNT_ID}`;
  const service: VaultService = {
    keys: () => http(`${at}/vault-keys`),
    deploy: (tx) => http(`${at}/vaults`, { method: 'POST', body: { tx } }),
    handover: (vault, tx) => http(`${at}/vaults/${vault}/handover`, { method: 'POST', body: { tx } }),
    chain: (vault) => http(`${at}/vaults/${vault}/chain`),
    deposit: (vault, tx) => http(`${at}/vaults/${vault}/deposit`, { method: 'POST', body: { tx } }),
    payoutState: (vault) => http(`${at}/vaults/${vault}/payout-state`),
    events: (vault, tx) => http(`${at}/vaults/${vault}/events/${tx}`),
    payout: (vault, tx) => http(`${at}/vaults/${vault}/payout`, { method: 'POST', body: { tx } }),
    payoutPublicly: (vault, tx) => http(`${at}/vaults/${vault}/public-payout`, { method: 'POST', body: { tx } }),
  };
  const keys: TemporaryKeys = {
    put: async (v, k) => { temporaryKeys.set(v, k); },
    get: async (v) => temporaryKeys.get(v) ?? null,
    forget: async (v) => { temporaryKeys.delete(v); },
  };
  const pacing = { sleep: async () => {}, waitMs: 3, everyMs: 1 };
  const wire: WireSend = async (path, init) => {
    if (init.body !== undefined) sent.push(init.body);
    const r = await fetch(base + path, {
      method: init.method, ...(init.body === undefined ? {} : { body: init.body }),
      headers: { 'content-type': 'application/json', 'x-test-person': 'ada' },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const records = (record: WireRecord) =>
    new HttpSealedPoolStore(record, wire, signing.secret, async () => new Set([signing.publicKey]));
  const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
  const wallet = async (ask: { company: Hex; vault: Hex; transaction: string }) => {
    const asProven = { Transaction: { deserialize: (_s: string, _p: string, b: 'pre-binding', raw: Uint8Array) => L.Transaction.deserialize('signature', 'pre-proof', b, raw) } };
    const read = readWhatThePageAsks(asProven as never, ask.transaction, ask.vault);
    return { transaction: base64FromBytes((read.tx as any).bind().serialize()), leaves: read.leaves };
  };

  /** A vault the committee holds, its pool open, the account handed over, and 1,000 in it: the existing path, run to its end. */
  const aFundedVault = async (): Promise<{ vault: Hex; note: { nonce: Hex; token: Hex; value: bigint } }> => {
    await http(`${at}/vault-keys`, {
      method: 'PUT',
      body: {
        viewingKey,
        ...signVaultKeys(ACCOUNT_ID, 'ada', {
          committeeKey: committeeKeyFor(identityFromWords(words), company), recordsKey: recordsReaderOf(me.companyKey).publicKey,
        }, signing.secret),
      },
    });
    const { vault } = await createCompanyVault({ ...pacing, account: company, service, builder: builder(), keys });
    const poolDoors = { ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records };
    await openCompanyVaultPool(poolDoors, vault);
    const authority = await http(`${at}/authority`);
    await http(`${at}/authority/handover`, { method: 'POST', body: { committee: authority.committee } });
    const deposited = await depositIntoCompanyVault({ ...poolDoors, company, builder: builder(), pay: wallet, inFlight: inFlightInMemory() }, vault, { token: TOKEN, value: 1_000n });
    return { vault, note: deposited.note };
  };

  /** A one-person run of `amount`, raised and approved on the account by its founder, and what the service would hand the device for it. */
  const anApprovedRun = async (vault: Hex, amount: bigint, paying?: { payee: Payee; token: Hex }) => {
    const payeeKeys = L.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
    const payee = paying?.payee
      ?? payeeAddressFromKeys({ coinPublicKey: payeeKeys.coinPublicKey as Hex, encryptionPublicKey: payeeKeys.encryptionPublicKey as Hex }, NET);
    const facts = [{ payee, token: paying?.token ?? TOKEN, amount }];
    const run = buildRun([{ epoch: 0, seed: toHex(new Uint8Array(randomBytes(32))) }], { accountId: ACCOUNT_ID, runId: 'run_1', epoch: 0 }, facts, vaultDetails);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const window = { from: now - 600n, until: now + 3_600n };
    const c = change(0n, 41);
    const idFrom = (leaves: Hex[], w: { from: bigint; until: bigint }) => toHex(accountCircuits.proposalIdOf(
      accountCircuits.runPayload(fromHex(rootOfLeaves(leaves)), BigInt(leaves.length), w.from, w.until), fromHex(vault), c.salt));
    const id = idFrom(run.tree.leaves, window);
    const staged = { ...founder, assetId: c.asset, changeAmount: c.amount, changeBatchDigest: c.batch, proposalSalt: c.salt };
    await callAccount('propose', [ZERO_32, fromHex(run.tree.root), run.tree.payees, window.from, window.until, true, fromHex(vault)], staged);
    await callAccount('approve', [fromHex(id)], founder);
    const paidNow = () => new Set(run.tree.leaves.filter((leaf) =>
      accountLedgerOf(chain.contract(company)).movements.member(accountCircuits.paidMovementOf(fromHex(leaf)))));
    const order = () => {
      const out = assemblePrivatePayments({
        order: {
          asset: 'TESTUSD', vault, proposal: id, salt: toHex(c.salt), root: run.tree.root,
          payees: run.tree.payees, opensAt: window.from, closesAt: window.until,
        },
        leaves: run.tree.leaves, window, idFrom, built: run, facts, paid: paidNow(),
      });
      if ('refusal' in out) throw new Error(out.refusal);
      return out.order;
    };
    return { order, payeeKeys, leaf: run.tree.leaves[0]!, id };
  };

  it('ONE PERSON IS PAID: THE ACCOUNT RECORDS IT, THE VAULT SPENDS ITS NOTE AND KEEPS THE CHANGE, THE POOL SAYS SO, AND THE PAYEE HOLDS A COIN', async () => {
    const { vault, note } = await aFundedVault();
    expect(chain.applied.map((a) => a.ok)).toEqual([true, true, true, true]);
    const run = await anApprovedRun(vault, 250n);
    expect(accountLedgerOf(chain.contract(company)).openProposals.member(fromHex(run.id))).toBe(true);
    const order = run.order();
    expect(order.payments.map((p) => p.paid)).toEqual([false]);
    const before = chain.applied.length;
    const done = await payPrivatelyFromCompanyVault({
      ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, builder: builder(),
    }, { order, payment: order.payments[0]! });

    /* ---- the chain applied exactly one more transaction, and the service paid for it as the vault's own coins ---- */
    expect(chain.applied.slice(before).map((a) => [a.ok, a.error])).toEqual([[true, '']]);
    expect(arrivals.at(-1)).toBe('proven-moving-the-vaults-own-coins');
    /* ---- the account records this person paid, against the run its signers approved ---- */
    const account = accountLedgerOf(chain.contract(company));
    expect(account.movements.member(accountCircuits.paidMovementOf(fromHex(run.leaf)))).toBe(true);
    expect(run.order().payments.map((p) => p.paid)).toEqual([true]);
    /* ---- the vault: the spent note is gone and the change is held, by the vault's own commitments ---- */
    const held = async (n: { nonce: string; token: string; value: bigint }) =>
      (await builder().commitments({ vault, coin: { nonce: n.nonce, token: n.token, value: n.value.toString() } })).held;
    const notesNow = [...vaultLedgerOf(chain.contract(vault)).notes].map((c: Uint8Array) => hex(c));
    expect(done.change).not.toBeNull();
    expect(notesNow).toEqual([await held({ ...done.change!, value: BigInt(done.change!.value) })]);
    expect(notesNow).not.toContain(await held(note));
    expect(vaultLedgerOf(chain.contract(vault)).payments).toBe(1n);
    /* ---- the pool: the note gone, the change of 750 recorded with the transaction that made it ---- */
    const pool = await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).load(vault);
    expect(pool.notes).toEqual([{ nonce: done.change!.nonce, token: TOKEN, value: 750n, createdIn: chain.applied.at(-1)!.name }]);
    expect(done.transactionHash).toBe(chain.applied.at(-1)!.name);
    /* ---- the journal wrote the payment down ---- */
    const journal = await new PaymentJournalInStore(records('payment-journal'), vault, { id: 'ada', wrappingSecret: wrapping.secret }, signers).open();
    expect(journal.attempts).toEqual([expect.objectContaining({ spent: { nonce: note.nonce, token: TOKEN, value: 1_000n }, amount: 250n })]);
    /* ---- the payee: one output that is not a contract's, of 250 in this token, and their own keys can read it ---- */
    const payTx = chain.events.get(chain.applied.at(-1)!.name)!;
    const toPeople = payTx.filter((e: any) => e.content.tag === 'zswapOutput' && e.content.contract === undefined);
    expect(toPeople).toHaveLength(1);
    /* RED WHEN: the payment is encrypted to any key but the payee's own - their wallet would then never see it. */
    const paidWith = chain.applied.at(-1)!.tx;
    const offers = [paidWith.guaranteedOffer, ...(paidWith.fallibleOffer ? [...paidWith.fallibleOffer.values()] : [])].filter(Boolean);
    const found = (sk: unknown) => offers.flatMap((o: any) => [...new L.ZswapLocalState().applyWithChanges(sk as never, o).changes]
      .flatMap((c: any) => [...c.receivedCoins].map((r: any) => [String(r.type), r.value])));
    expect(found(run.payeeKeys)).toEqual([[TOKEN, 250n]]);
    expect(found(L.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32))))).toEqual([]);
    /* ---- nothing the service received carried a key this device keeps ---- */
    for (const secret of [hex(me.companyKey), wrapping.secret, signing.secret, hex(founder.secretKey)]) {
      expect(sent.some((b) => b.includes(secret))).toBe(false);
    }
  });

  it('THE SAME PERSON IS NOT OFFERED TWICE, AND A SECOND PAYMENT BUILT ANYWAY IS REFUSED BY THE ACCOUNT', async () => {
    const { vault } = await aFundedVault();
    const run = await anApprovedRun(vault, 100n);
    const doors = { ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, builder: builder() };
    const first = run.order();
    await payPrivatelyFromCompanyVault(doors, { order: first, payment: first.payments[0]! });
    /* RED WHEN: `paid` is not read back from the account - the device would be offered the person again. */
    const again = run.order();
    await expect(payPrivatelyFromCompanyVault(doors, { order: again, payment: again.payments[0]! }))
      .rejects.toThrow(/already records this person paid/);
    /*
     * Built anyway, from the order read before the first payment landed: the account's own record refuses it while
     * it is built on this device, against the chain as it is now, so nothing reaches the service or the chain and
     * the pool is unchanged.
     */
    const poolBefore = await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).load(vault);
    const applied = chain.applied.length;
    const payoutsSent = arrivals.length;
    await expect(payPrivatelyFromCompanyVault(doors, { order: first, payment: first.payments[0]! })).rejects.toThrow(/already been made/);
    expect(chain.applied.length).toBe(applied);
    expect(arrivals.length).toBe(payoutsSent);
    const poolAfter = await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).load(vault);
    expect(poolAfter.notes).toEqual(poolBefore.notes);
  });

  it('A PAYMENT FOR SOMEBODY THE SIGNERS DID NOT APPROVE IS BUILT AND REFUSED BY THE ACCOUNT, AND THE SERVICE READS IT AS A PAYMENT OUT', async () => {
    const { vault } = await aFundedVault();
    const run = await anApprovedRun(vault, 100n);
    const order = run.order();
    /* Another amount for the same person: the leaf is no longer the approved one. */
    const forged = { ...order.payments[0]!, amount: '999' };
    const applied = chain.applied.length;
    await expect(payPrivatelyFromCompanyVault({
      ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, builder: builder(),
    }, { order, payment: forged })).rejects.toThrow();
    /* The account's own check stops it inside the call, before anything reaches the service. */
    expect(chain.applied.length).toBe(applied);
    expect(arrivals.filter((a) => a === 'proven-moving-the-vaults-own-coins')).toEqual([]);
  });

  it('THE SERVICE\'S READER ACCEPTS THE PAYMENT THE DEVICE BUILT, AND ONLY FOR THIS VAULT AND THIS COMPANY', async () => {
    const { vault, note } = await aFundedVault();
    const run = await anApprovedRun(vault, 250n);
    const order = run.order();
    const { payments: _p, ...round } = order;
    const chainNow = await service.payoutState(vault);
    const built = await builder().payout({
      vault, account: company, order: round, payment: order.payments[0]!,
      note: { nonce: note.nonce, token: note.token, value: note.value.toString(), createdIn: (await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).load(vault)).notes[0]!.createdIn },
      events: (await service.events(vault, (await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).load(vault)).notes[0]!.createdIn!)).events,
      chain: chainNow,
    });
    const tx = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', Buffer.from(built.tx, 'base64')) as any;
    /* RED WHEN: the reader's shape stops matching what the SDK builds - two calls, one contract-owned input, a payee and a change. */
    expect(refusalForPayout(tx, { vault, account: company })).toBeNull();
    expect(refusalForPayout(tx, { vault, account: 'c1'.repeat(32) })).toMatch(/must call this vault's payout/);
    expect(refusalForPayout(tx, { vault: 'ee'.repeat(32), account: company })).toMatch(/must call this vault's payout/);
    const named = (e: unknown) => (e instanceof Uint8Array ? new TextDecoder().decode(e) : String(e));
    /* Exactly these two calls. The SDK adds the account's first and the vault's last, and the transaction read back
     * lists them the other way round, which is why the reader compares them as a set. */
    expect([...tx.intents.values()][0].actions.map((a: any) => `${String(a.address).toLowerCase()}/${named(a.entryPoint)}`).sort())
      .toEqual([`${company}/recordPayment`, `${vault}/payout`].sort());
    /* One of the vault's coins in; one person's coin and the vault's change out. */
    const offer = tx.guaranteedOffer ?? [...(tx.fallibleOffer?.values() ?? [])][0];
    expect(offer.inputs.map((i: any) => String(i.contractAddress).toLowerCase())).toEqual([vault]);
    expect(offer.outputs.map((o: any) => (o.contractAddress === undefined ? 'person' : String(o.contractAddress).toLowerCase())).sort())
      .toEqual(['person', vault].sort());
  });

  /* ------------------------------------------------ a public payment out */

  /* Not NIGHT: this chain holds NIGHT's supply fixed, and a vault funded from nothing would break it. */
  const PUBLIC_TOKEN = 'a8'.repeat(32) as Hex;
  /**
   * **A VAULT THAT ALREADY HOLDS PUBLIC MONEY.** Put there by the vault's own
   * public deposit circuit, called straight onto this chain, which does not check
   * that a transaction balances: nobody's coin is spent to fund it. This is how
   * the test gets public money into a vault, not how a company does.
   */
  const holdingPublicly = async (vault: Hex, amount: bigint) => {
    const keys = L.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
    const built = await (contracts as any).createUnprovenCallTxFromInitialStates(vaultZk, {
      compiledContract: vaultCompiled({ noteToSpend: () => { throw new Error('nothing here spends'); } }),
      circuitId: 'depositUnshielded', contractAddress: vault, coinPublicKey: keys.coinPublicKey,
      initialContractState: asRuntime(chain.contract(vault)),
      initialZswapChainState: new L.ZswapChainState(),
      ledgerParameters: L.LedgerParameters.initialParameters(),
      args: [fromHex(PUBLIC_TOKEN), amount],
    }, keys.encryptionPublicKey);
    const r = chain.apply(built.private.unprovenTx);
    if (!r.ok) throw new Error(`the chain refused the public deposit: ${r.error}`);
    chain.applied.pop();
  };
  const publicBalance = (vault: Hex): bigint => {
    let held = 0n;
    for (const [type, value] of chain.contract(vault).balance) if (String(type.raw ?? '') === PUBLIC_TOKEN) held += value;
    return held;
  };
  const USER = 'c3'.repeat(32);
  const publicDoors = (run: { leaf: Hex }) => ({
    ...pacing, service, builder: builder(),
    paidYet: async () => accountLedgerOf(chain.contract(company)).movements.member(accountCircuits.paidMovementOf(fromHex(run.leaf))),
  });

  it('ONE PERSON IS PAID PUBLICLY: THE VAULT\'S PUBLIC PAYOUT PAYS THEIR PUBLIC ADDRESS, AND THE ACCOUNT RECORDS IT', async () => {
    const { vault } = await aFundedVault();
    await holdingPublicly(vault, 1_000n);
    expect(publicBalance(vault)).toBe(1_000n);
    const run = await anApprovedRun(vault, 250n, { payee: unshieldedPayeeFor(USER, NET), token: PUBLIC_TOKEN });
    const order = run.order();
    expect(order.payments.map((p) => [p.kind, p.paid])).toEqual([['unshielded', false]]);
    const before = chain.applied.length;
    const notesBefore = [...vaultLedgerOf(chain.contract(vault)).notes].map((c: Uint8Array) => hex(c));

    const done = await payPubliclyFromCompanyVault(publicDoors(run), { order, payment: order.payments[0]! });

    /* RED WHEN: the payment does not reach the chain through the public door, or the chain refuses it. */
    expect(chain.applied.slice(before).map((a) => [a.ok, a.error])).toEqual([[true, '']]);
    expect(arrivals.at(-1)).toBe('proven-moving-the-vaults-own-coins');
    expect(done.txRef).toBe(String(chain.applied.at(-1)!.tx.identifiers()[0]));
    const tx = chain.applied.at(-1)!.tx;
    const named = (e: unknown) => (e instanceof Uint8Array ? new TextDecoder().decode(e) : String(e));
    /* RED WHEN: a public payee is paid through anything but the vault's public payout. */
    expect([...tx.intents.values()][0].actions.map((a: any) => `${String(a.address).toLowerCase()}/${named(a.entryPoint)}`).sort())
      .toEqual([`${company}/recordPayment`, `${vault}/payoutUnshielded`].sort());
    /* RED WHEN: the money goes anywhere but the payee's public address, or in another amount or token. */
    const outs = [...tx.intents.values()].flatMap((i: any) => [
      ...(i.guaranteedUnshieldedOffer?.outputs ?? []), ...(i.fallibleUnshieldedOffer?.outputs ?? [])]);
    expect(outs.map((o: any) => [String(o.owner).toLowerCase(), String(o.type).toLowerCase(), o.value])).toEqual([[USER, PUBLIC_TOKEN, 250n]]);
    /* The vault's public money went down by the payment, and its private notes were not touched. */
    expect(publicBalance(vault)).toBe(750n);
    expect([...vaultLedgerOf(chain.contract(vault)).notes].map((c: Uint8Array) => hex(c))).toEqual(notesBefore);
    /* RED WHEN: the account does not record the public payee paid - a second payment would then be offered. */
    expect(accountLedgerOf(chain.contract(company)).movements.member(accountCircuits.paidMovementOf(fromHex(run.leaf)))).toBe(true);
    expect(run.order().payments.map((p) => p.paid)).toEqual([true]);
    /* RED WHEN: the service's reader for a public payment stops matching what the SDK builds, or its reader for a
     * private payment would take a public one. */
    expect(refusalForPublicPayout(tx, { vault, account: company })).toBeNull();
    expect(refusalForPayout(tx, { vault, account: company })).toMatch(/^this is not a private payment out of this company's vault/);
  });

  it('A PUBLIC PAYEE IS NOT PAID TWICE: NOT OFFERED AGAIN, AND A SECOND PAYMENT BUILT ANYWAY IS REFUSED BY THE ACCOUNT', async () => {
    const { vault } = await aFundedVault();
    await holdingPublicly(vault, 1_000n);
    const run = await anApprovedRun(vault, 100n, { payee: unshieldedPayeeFor(USER, NET), token: PUBLIC_TOKEN });
    const first = run.order();
    await payPubliclyFromCompanyVault(publicDoors(run), { order: first, payment: first.payments[0]! });
    const again = run.order();
    /* RED WHEN: `paid` is not read back from the account for a public payee. */
    await expect(payPubliclyFromCompanyVault(publicDoors(run), { order: again, payment: again.payments[0]! }))
      .rejects.toThrow(/already records this person paid/);
    const applied = chain.applied.length;
    const sentBefore = arrivals.length;
    /* Built anyway from the order read before: the account refuses it while it is built, so nothing is sent. */
    await expect(payPubliclyFromCompanyVault(publicDoors(run), { order: first, payment: first.payments[0]! }))
      .rejects.toThrow(/already been made/);
    expect(chain.applied.length).toBe(applied);
    expect(arrivals.length).toBe(sentBefore);
    expect(publicBalance(vault)).toBe(900n);
  });

  it('A PRIVATE PAYEE IS NEVER PAID PUBLICLY, AND A PUBLIC PAYEE NEVER PRIVATELY', async () => {
    const { vault } = await aFundedVault();
    await holdingPublicly(vault, 1_000n);
    const privateRun = await anApprovedRun(vault, 100n);
    const priv = privateRun.order();
    const applied = chain.applied.length;
    const sentBefore = arrivals.length;
    /* RED WHEN: the public door takes a payment the leg names private. */
    await expect(payPubliclyFromCompanyVault(publicDoors(privateRun), { order: priv, payment: priv.payments[0]! }))
      .rejects.toThrow(/not a public one/);
    /* RED WHEN: the public builder takes a private address because the payment was relabelled public. */
    await expect(payPubliclyFromCompanyVault(publicDoors(privateRun), {
      order: priv, payment: { ...priv.payments[0]!, kind: 'unshielded' },
    })).rejects.toThrow(/is not a public payee address for undeployed/);
    /* RED WHEN: the account pays a private payee's approved leaf to a public address - the leaf is built by kind. */
    await expect(payPubliclyFromCompanyVault(publicDoors(privateRun), {
      order: priv, payment: { ...priv.payments[0]!, kind: 'unshielded', payee: unshieldedPayeeFor(USER, NET).bech32, token: PUBLIC_TOKEN },
    })).rejects.toThrow(/that path is not for this payee/);
    /* RED WHEN: the device's public builder takes a payment the leg names private, whatever the page asked. */
    const chainNow = await service.payoutState(vault);
    const { payments: _p, ...round } = priv;
    await expect(builder().payoutPublicly({ vault, account: company, order: round, payment: priv.payments[0]!, chain: chainNow }))
      .rejects.toThrow(/^this payment is not a public one, so it is not built as one\. Nothing was built\.$/);
    expect(privateRun.order().payments.map((p) => p.paid)).toEqual([false]);

    const publicRun = await anApprovedRun(vault, 100n, { payee: unshieldedPayeeFor(USER, NET), token: PUBLIC_TOKEN });
    const pub = publicRun.order();
    const privateDoors = { ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, builder: builder() };
    /* RED WHEN: the device's private builder takes a payment the leg names public, whatever the page asked. */
    const { payments: _q, ...pubRound } = pub;
    await expect(builder().payout({
      vault, account: company, order: pubRound, payment: pub.payments[0]!,
      note: { nonce: '01'.repeat(32), token: PUBLIC_TOKEN, value: '1000', createdIn: '02'.repeat(32) }, events: [], chain: chainNow,
    })).rejects.toThrow(/^this payment is not a private one, so it is not built as one\. Nothing was built\.$/);
    /* RED WHEN: the private door takes a payment the leg names public. */
    await expect(payPrivatelyFromCompanyVault(privateDoors, { order: pub, payment: pub.payments[0]! }))
      .rejects.toThrow(/not a private one/);
    /*
     * RED WHEN: the private builder takes a public address because the payment was relabelled private. Named in the
     * vault's private token, so a note covers it and the builder's own decode of the address is what refuses.
     */
    await expect(payPrivatelyFromCompanyVault(privateDoors, { order: pub, payment: { ...pub.payments[0]!, kind: 'shielded', token: TOKEN } }))
      .rejects.toThrow(/is not a payee address for undeployed[\s\S]*It must be a shield-addr/);
    expect(publicRun.order().payments.map((p) => p.paid)).toEqual([false]);
    expect(chain.applied.length).toBe(applied + 2);
    expect(arrivals.length).toBe(sentBefore);
    expect(publicBalance(vault)).toBe(1_000n);
  });
});

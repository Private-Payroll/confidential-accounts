/**
 * **A COMPANY'S SIGNERS CHANGE, AND EVERY CONTRACT'S COMMITTEE CHANGES WITH
 * THEM - SIGNED IN EACH SIGNER'S OWN WALLET - AND PAYMENTS OUT OF THE VAULT
 * CARRY ON.**
 *
 * What is real here:
 *   · the chain is the ledger's own state machine (`LedgerState`), one
 *     transaction per block, signatures checked, and every state each contract
 *     was left in kept, the way the indexer serves a contract's history;
 *   · the vault and the account are the compiled contracts, and a payment out
 *     is the one the page builds, through the worker's own handling;
 *   · each signer's committee key is their wallet's own derivation from their
 *     words, and each signature is made by the wallet's own ask parser and
 *     signing function, and read back by the page's own reader;
 *   · the service is the product's own routes, over real HTTP, putting the
 *     change together with the product's own builder and paying for it only
 *     after reading it as a stranger's.
 *
 * **WHAT THIS DOES NOT SHOW, SAID HERE SO NOTHING RELIES ON IT:** no proof is
 * made; nothing reaches a real network, a real indexer, a browser or a wallet
 * screen. The company's committee threshold is what the service's `company`
 * door reports, set here directly; seating a signer on the account contract
 * and changing its approval threshold is the existing path and is not run
 * here, so the payroll run below is approved by the founder alone.
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
import { committeeKeyFor, committeeSigningKeyFor } from 'midnight-identity/profile/committee-key';
import { parseAsk } from 'midnight-identity/profile/request';
import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import * as vaultModule from '../managed-vault/contract/index.js';
import * as accountModule from '../managed/contract/index.js';
import { witnesses, type AccountPrivateState } from '../src/witnesses.js';
import { privateStateFor, leafOfDevice, change, ZERO_32 } from './simulator.js';
import { MemoryStore } from '../../src/core/store.js';
import { AccountService, sealAccount } from '../../src/core/account.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { signVaultKeys, vaultKeyIndexOf } from '../../src/core/vault-keys.js';
import { ChainLedger } from '../../src/wiring/chain.js';
import { companyVaultRoutes, type VaultChain } from '../../src/server/company-vaults.js';
import { mountVaultRecords, vaultAccountFromTheIndexer } from '../../src/server/vault-records-authority.js';
import { MemorySealedPoolStore } from '../../src/midnight/vault-pool.js';
import type { WireRecord } from '../../src/midnight/sealed-record-wire.js';
import { HttpSealedPoolStore, type WireSend } from '../../src/web/http-sealed-pool-store.js';
import { recordsReaderOf, type DeviceSigner } from '../../src/web/deposit-on-device.js';
import { answerVaultAsk } from '../../src/web/vault-worker-entry.js';
import { vaultBuilderOver, type VaultAnswer } from '../../src/web/vault-worker-client.js';
import {
  createCompanyVault, depositIntoCompanyVault, openCompanyVaultPool, payPrivatelyFromCompanyVault,
  type TemporaryKeys, type VaultService,
} from '../../src/web/vault-operation.js';
import { readWhatThePageAsks, base64FromBytes } from '../../apps/wallet/src/chain/balance-for-page.js';
import { UNLOCK_PURPOSE, UNLOCK_WINDOW_MS, unlockAsk } from '../../src/core/wallet-unlock.js';
import { fromHex, newSigningKeypair, newWrappingKeypair, toHex, type Hex } from '../../src/core/crypto.js';
import {
  accountHandoverWith, accountTemporaryVerifyingKey, accountVerifierKeysIn, committeeChangeWith,
} from '../../src/server/vault-chain.js';
import { committeeSignaturesFor, readCommitteeSignatures } from 'midnight-identity/profile/committee-sign';
import { committeeAsk } from '../../src/web/wallet-committee.js';
import { signCommitteeChangeOnDevice, type CommitteeChangeView } from '../../src/web/committee-change-on-device.js';
import { openAccount } from '../../src/core/account.js';
import { DEPLOYED_CIRCUITS } from '../../src/midnight/deferral.js';
import { fileURLToPath } from 'node:url';
import { readProvenTransaction } from '../../src/wiring/proven-submission.js';
import { startingLedgerFrom } from '../../src/wiring/vault-submission.js';
import { signingKeyFromBip340 } from '@midnightntwrk/ledger-v9';
import { buildRun, rootOfLeaves } from '../../src/midnight/payout-tree.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { payeeAddressFromKeys, type Payee } from '../../src/midnight/payee-address.js';
import { assemblePrivatePayments } from '../../src/midnight/private-payment-wire.js';
import { witnessesOver } from '../../src/midnight/vault-notes.js';

const NET = 'undeployed';
const RECORDS: readonly WireRecord[] = ['pool', 'deposit-journal', 'payment-journal', 'nonce-secret'];
const ACCOUNT_ID = 'acc_changing';
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
  /** Every state each contract was left in, oldest first, as the indexer serves a contract's actions. */
  history = new Map<string, Array<{ kind: 'deploy' | 'call' | 'update'; transaction: string; state: any }>>();
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
      for (const intent of tx.intents?.values?.() ?? []) {
        for (const action of intent.actions ?? []) {
          const address = String(action.address).toLowerCase();
          const kind = action.initialState !== undefined ? 'deploy' : action.entryPoint !== undefined ? 'call' : 'update';
          const after = L.ContractState.deserialize(this.state.index(address).serialize());
          this.history.set(address, [...(this.history.get(address) ?? []), { kind, transaction: name, state: after }]);
        }
      }
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
    '  NOT CHECKED HERE: the vault\'s and the account\'s verifier keys are not on disk, so a company\'s committee'
    + ' was not changed with its signers and no payment was made out of its vault afterwards.'
    + ' `npm run compact:vault -- --full` and `npm run compact` build them.',
  );
}

describe.skipIf(!KEYS_ON_DISK)('A VAULT\'S COMMITTEE CHANGES WITH THE COMPANY\'S SIGNERS, AND PAYMENTS CARRY ON [needs contracts/managed-vault/keys and contracts/managed/keys; `npm run compact` then `npm run compact:vault -- --full` build them]', () => {
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
  let companyThreshold: number;
  let people: Map<string, { words: string; signing: ReturnType<typeof newSigningKeypair>; wrapping: ReturnType<typeof newWrappingKeypair> }>;

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
    companyThreshold = 1;
    people = new Map([['ada', { words, signing, wrapping }]]);
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
      /* As the indexer serves a contract's actions: every state it was left in, oldest first. */
      historyOf: async (address) => chain.history.get(address.toLowerCase()) ?? [],
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
      company: async () => ({ address: company, threshold: companyThreshold }),
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
      committeeChange: committeeChangeWith(NET),
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
    const deposited = await depositIntoCompanyVault({ ...poolDoors, company, builder: builder(), pay: wallet }, vault, { token: TOKEN, value: 1_000n });
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

  /* ------------------------------------------------ the signers change */

  const ORIGIN = 'https://payroll.example';
  /** Every committee change a wallet was asked to sign, as its own parser read the ask. */
  let asked: unknown[] = [];

  /** Somebody seated on the company's roster, as the existing seat path leaves them, who then gives their vault keys. */
  const seat = async (id: string) => {
    const p = { words: newWords().join(' '), signing: newSigningKeypair(), wrapping: newWrappingKeypair() };
    people.set(id, p);
    const acc = openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey);
    store.putAccount(sealAccount({
      ...acc,
      signers: [...acc.signers, {
        id, userId: id, name: id, status: 'active', role: 'admin', leafCommitment: null,
        signingPublicKey: p.signing.publicKey, wrappingPublicKey: p.wrapping.publicKey,
      }],
    } as never, viewingKey, []));
    await http(`${at}/vault-keys`, {
      method: 'PUT',
      body: {
        viewingKey,
        ...signVaultKeys(ACCOUNT_ID, id, {
          committeeKey: committeeKeyFor(identityFromWords(p.words), company),
          recordsKey: recordsReaderOf(releasedCompanyKey(p.words, company)).publicKey,
        }, p.signing.secret),
      },
    }, id);
  };

  /** Somebody taken off the company's roster, and the index the service keeps made again from what is left. */
  const unseat = (id: string) => {
    const acc = openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey);
    const next = { ...acc, signers: acc.signers.filter((s) => s.id !== id) };
    store.putAccount(sealAccount(next as never, viewingKey, []));
    store.putVaultKeyIndex(vaultKeyIndexOf(next));
  };

  /** The threshold changed, as the existing threshold path leaves it: on the chain, and on the company's record. */
  const thresholdBecomes = (n: number) => {
    companyThreshold = n;
    const acc = openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey);
    store.putAccount(sealAccount({ ...acc, policy: { ...acc.policy, threshold: n } } as never, viewingKey, []));
  };

  const committeeKeyOf = (id: string) => committeeKeyFor(identityFromWords(people.get(id)!.words), company);
  const signingKeyOf = (id: string) => committeeSigningKeyFor(identityFromWords(people.get(id)!.words), company);
  const sortedKeys = (...ids: string[]) => ids.map((i) => committeeKeyOf(i).value).sort();

  /** Who holds a contract's rules on the chain now. */
  const onChain = (address: Hex) => {
    const a = chain.contract(address).maintenanceAuthority;
    return { keys: [...a.committee].map((k: any) => String(k.value)), threshold: a.threshold, counter: a.counter };
  };

  /**
   * **ONE SIGNER'S DEVICE SIGNS THE CHANGE IN THEIR OWN WALLET.** The page's own flow; the wallet's own parser and
   * signing function, handed the ask as it would cross the channel; the page's own reader of the answer.
   */
  const signAs = async (id: string) => {
    const identity = identityFromWords(people.get(id)!.words);
    return signCommitteeChangeOnDevice({
      view: async () => await http(`${at}/committee-change`, undefined, id) as CommitteeChangeView,
      walletKey: async () => committeeKeyFor(identity, company),
      roster: async () => openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey),
      askWallet: async (ask) => {
        const nonce = toHex(new Uint8Array(randomBytes(16)));
        const wire = JSON.parse(JSON.stringify(committeeAsk({
          name: 'Confidential Accounts', rdns: 'social.lemonade.confidential-accounts', purpose: 'change the committee',
          nonce, expiresAt: Date.now() + 600_000, ...ask,
        })));
        const parsed = parseAsk(wire, ORIGIN, Date.now());
        if (parsed.kind !== 'committee') throw new Error('not a committee change');
        asked.push(parsed);
        const answer = JSON.parse(JSON.stringify(committeeSignaturesFor(L as never, identity, parsed, Date.now())));
        const read = readCommitteeSignatures(answer, {
          atOrigin: ORIGIN, expectingNonce: nonce, company: ask.company, to: ask.to as never, contracts: ask.contracts,
        });
        if (!read.ok) throw new Error((read as Extract<typeof read, { ok: false }>).says);
        return read;
      },
      send: async (body) => await http(`${at}/committee-change/signatures`, { method: 'POST', body }, id),
    }, { signerId: id });
  };

  const payDoors = () => ({
    ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, builder: builder(),
  });
  /** One person paid out of the vault, by the page's own payment path. */
  const pay = async (vault: Hex, amount: bigint) => {
    const run = await anApprovedRun(vault, amount);
    const order = run.order();
    return payPrivatelyFromCompanyVault(payDoors(), { order, payment: order.payments[0]! });
  };

  it('A SIGNER JOINS: EVERY PAYMENT STOPS UNTIL THE COMMITTEE CHANGES, THE FOUNDER SIGNS IT IN THEIR WALLET, AND PAYMENTS CARRY ON', async () => {
    asked = [];
    const { vault } = await aFundedVault();
    await pay(vault, 100n);
    expect(onChain(vault)).toEqual({ keys: sortedKeys('ada'), threshold: 1, counter: 1n });

    await seat('bo');
    /* The company's committee is now two keys at a threshold of one; the vault and the account still hold one. */
    /* RED WHEN: a payment is paid for out of a vault whose committee is not the company's. */
    const payoutsBefore = arrivals.filter((a) => a === 'proven-moving-the-vaults-own-coins').length;
    await expect(pay(vault, 100n)).rejects.toThrow(/not held by the company's committee/);
    expect(arrivals.filter((a) => a === 'proven-moving-the-vaults-own-coins')).toHaveLength(payoutsBefore);

    const owed = await http(`${at}/committee-change`) as CommitteeChangeView;
    expect(owed.to).toEqual({ committee: sortedKeys('ada', 'bo').map((value) => ({ tag: 'schnorr', value })), threshold: 1 });
    expect(owed.contracts.map((c) => [c.contract, c.address, c.counter, c.required, c.signedSeats])).toEqual([
      ['account', company, '1', 1, []], ['vault', vault, '1', 1, []],
    ]);

    const before = chain.applied.length;
    const { results } = await signAs('ada');
    expect(results.map((r) => [r.address, r.state])).toEqual([[company, 'sent'], [vault, 'sent']]);
    expect(chain.applied.slice(before).map((a) => [a.ok, a.error])).toEqual([[true, ''], [true, '']]);
    /* RED WHEN: the wallet is shown anything but who joins, who leaves and the new threshold of this change. */
    expect(asked).toHaveLength(1);
    expect((asked[0] as any).to.committee.map((k: any) => k.value)).toEqual(sortedKeys('ada', 'bo'));
    /* RED WHEN: the change installs anything but the company's committee, or on only one of its contracts. */
    for (const c of [vault, company]) expect(onChain(c)).toEqual({ keys: sortedKeys('ada', 'bo'), threshold: 1, counter: 2n });
    expect((await http(`${at}/committee-change`) as CommitteeChangeView).contracts).toEqual([]);
    expect((await http(`${at}/authority`)).change.possible).toBe(false);

    /* RED WHEN: a contract changed after its handover is refused although its whole history vouches for it. */
    const paid = await pay(vault, 100n);
    expect([chain.applied.at(-1)!.ok, chain.applied.at(-1)!.error]).toEqual([true, '']);
    expect(paid.transactionHash).toBe(chain.applied.at(-1)!.name);
    expect(arrivals.filter((a) => a === 'proven-moving-the-vaults-own-coins')).toHaveLength(payoutsBefore + 1);

    /* RED WHEN: a committee signing key reaches the service in any request. */
    for (const id of ['ada', 'bo']) expect(sent.some((b) => b.includes(signingKeyOf(id).value))).toBe(false);
    /* RED WHEN: a signature the service kept verifies against anything but the one change it was made for. */
    const kept = store.getCommitteeSignatures(vault)!;
    const sig = kept.signatures[0]!.signature;
    const updateFor = (address: string, committee: string[], threshold: number, counter: bigint) => new L.MaintenanceUpdate(address,
      [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(committee.map((value) => ({ tag: 'schnorr', value })) as never, threshold, counter + 1n))], counter);
    expect(L.verifySignature(committeeKeyOf('ada') as never, updateFor(vault, sortedKeys('ada', 'bo'), 1, 1n).dataToSign, sig as never)).toBe(true);
    expect(L.verifySignature(committeeKeyOf('ada') as never, updateFor(vault, sortedKeys('ada', 'bo'), 1, 2n).dataToSign, sig as never)).toBe(false);
    expect(L.verifySignature(committeeKeyOf('ada') as never, updateFor(company, sortedKeys('ada', 'bo'), 1, 1n).dataToSign, sig as never)).toBe(false);
    expect(L.verifySignature(committeeKeyOf('ada') as never, updateFor(vault, sortedKeys('ada'), 1, 1n).dataToSign, sig as never)).toBe(false);
  });

  it('A SIGNER WHO LEAVES LOSES EVERY SEAT: TWO SIGNERS SIGN ON THEIR OWN, AND THE ONE WHO LEFT CAN SIGN NOTHING AFTERWARDS', async () => {
    const { vault } = await aFundedVault();
    await seat('bo');
    await seat('cy');
    thresholdBecomes(2);
    await signAs('ada');
    for (const c of [vault, company]) expect(onChain(c)).toEqual({ keys: sortedKeys('ada', 'bo', 'cy'), threshold: 2, counter: 2n });

    /* cy's device is lost: the company takes them off, and the committee left is two keys at a threshold of two. */
    unseat('cy');
    const first = await signAs('ada');
    /* RED WHEN: a change is sent with fewer signatures than the committee holding the contract now requires. */
    expect(first.results.map((r) => [r.state, r.have, r.required])).toEqual([['waiting', 1, 2], ['waiting', 1, 2]]);
    for (const c of [vault, company]) expect(onChain(c).counter).toBe(2n);
    await expect(pay(vault, 100n)).rejects.toThrow(/not held by the company's committee/);
    /* Signed a second time by the same person, nothing moves: each seat counts once. */
    await expect(signAs('ada')).rejects.toThrow(/you have signed the change on every contract you hold a seat on/);

    const second = await signAs('bo');
    expect(second.results.map((r) => r.state)).toEqual(['sent', 'sent']);
    /* RED WHEN: a signer who left keeps any seat on the account or the vault. */
    for (const c of [vault, company]) {
      expect(onChain(c)).toEqual({ keys: sortedKeys('ada', 'bo'), threshold: 2, counter: 3n });
      expect(onChain(c).keys).not.toContain(committeeKeyOf('cy').value);
    }
    const paid = await pay(vault, 100n);
    expect([chain.applied.at(-1)!.ok, paid.transactionHash]).toEqual([true, chain.applied.at(-1)!.name]);

    /* ---- and cy can sign nothing for either contract, at any seat ---- */
    for (const c of [vault, company]) {
      for (const seatAt of [0n, 1n]) {
        let u = new L.MaintenanceUpdate(c, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(
          [committeeKeyOf('cy')] as never, 1, onChain(c).counter + 1n))], onChain(c).counter);
        u = u.addSignature(seatAt, L.signData(signingKeyOf('cy') as never, u.dataToSign));
        /* RED WHEN: the chain accepts a change signed by a key no longer on the contract's committee. */
        expect(() => chain.apply(L.Transaction.fromParts(NET, undefined, undefined,
          L.Intent.new(new Date(Date.now() + 600_000)).addMaintenanceUpdate(u)))).toThrow(/signature for key id \d+ invalid/);
      }
    }
    /* The service does not take their signatures either: they are no longer a member, and the contracts already
     * hold the committee the company has now, so there is no change left for any signature to go on. */
    await expect(http(`${at}/committee-change`, undefined, 'cy')).rejects.toMatchObject({ status: 404 });
    const at3 = onChain(vault).counter;
    const forged = new L.MaintenanceUpdate(vault, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(
      sortedKeys('ada', 'bo').map((value) => ({ tag: 'schnorr', value })) as never, 2, at3 + 1n))], at3);
    const body = {
      to: { committee: sortedKeys('ada', 'bo').map((value) => ({ tag: 'schnorr', value })), threshold: 2 },
      signatures: [{ address: vault, counter: String(at3), seat: 0, signature: L.signData(signingKeyOf('cy') as never, forged.dataToSign) }],
    };
    const r = await http(`${at}/committee-change/signatures`, { method: 'POST', body });
    expect(r.results).toEqual([expect.objectContaining({ state: 'refused', nothingWasSent: true })]);
    expect(r.results[0].error).toMatch(/already held by the company's committee/);
  });
});

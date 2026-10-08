/**
 * **A COMPANY'S VAULT CREATED FROM ITS SIGNER'S DEVICE, HELD BY THE COMPANY'S
 * COMMITTEE FROM ITS FIRST TRANSACTION, ITS POOL OPENED, AND MONEY PUT IN -
 * EVERY STEP THROUGH THE ROUTES THE PAGE CALLS, NONE FROM A TERMINAL.**
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
 * wallet screen. The company's account is created here as its founding
 * signer's browser creates one (`an-account-born-held.ts`): held by their
 * committee key from its first transaction, its second step signed by their
 * wallet's own code. What this watches is what follows: the vault created born
 * held and started from the founding signer's device, and no money going in
 * until it is.
 *
 * Every call a device builds reaches the service unproven here, so the
 * service's reader below takes an unproven transaction as itself where a proven
 * one would be read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { drawCompanyLabel, readAccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import * as vaultModule from '../managed-vault/contract/index.js';
import * as accountModule from '../managed/contract/index.js';
import { witnesses, type AccountPrivateState } from '../src/witnesses.js';
import { privateStateFor, leafOfDevice } from './simulator.js';
import { recordsKeypairFrom } from '../../src/midnight/company-nonce-secret.js';
import { openSecretCopy, secretCopyOnTheChain } from '../../src/midnight/sealed-secret-copy.js';
import { ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE, VAULT_CIRCUITS } from '../../src/midnight/vault-contract.js';
import { MemoryStore } from '../../src/core/store.js';
import { AccountService, openAccount, sealAccount } from '../../src/core/account.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { rosterVaultKeys, signVaultKeys } from '../../src/core/vault-keys.js';
import { seatsInAccountState, vaultInState } from '../../apps/wallet/src/chain/company-label-on-chain.js';
import { directoryChainOver, fileOwnEntry, judgeOver, mayFileUnderOver, walletReadsOver } from './the-chain-as-a-wallet-reads-it.js';
import { seatDirectoryRoutes } from '../../src/server/seat-directory-route.js';
import { ChainLedger } from '../../src/wiring/chain.js';
import { companyVaultRoutes, type VaultChain } from '../../src/server/company-vaults.js';
import { mountVaultRecords, vaultAccountFromTheIndexer } from '../../src/server/vault-records-authority.js';
import { MemorySealedPoolStore, SealedNotePool } from '../../src/midnight/vault-pool.js';
import type { WireRecord } from '../../src/midnight/sealed-record-wire.js';
import { HttpSealedPoolStore, type WireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { recordsReaderOf, type DeviceSigner } from 'vaults-web-shared/deposit-on-device.js';
import { answerVaultAsk, checkedAccountKeys } from 'vaults-web-shared/vault-worker-entry.js';
import { vaultBuilderOver, type VaultAnswer } from 'vaults-web-shared/vault-worker-client.js';
import {
  createCompanyVault, depositIntoCompanyVault, openCompanyVaultPool,
  type TemporaryKeys, type VaultService, type DepositInFlight, type DepositsInFlight,
} from 'vaults-web-shared/vault-operation.js';
import { inFlightInMemory as inFlightRecordsInMemory, sealedOnThisDevice, type KeptOnThisDevice } from 'vaults-web-shared/in-flight-on-this-device.js';
import { readWhatThePageAsks, base64FromBytes, bytesFromBase64 } from '../../apps/wallet/src/chain/balance-for-page.js';
import { aWalletThatPaysPrivately, type AWalletThatPaysPrivately } from './a-wallet-that-pays-privately.js';
import { UNLOCK_PURPOSE, UNLOCK_WINDOW_MS, unlockAsk } from '../../src/core/wallet-unlock.js';
import { newSigningKeypair, newWrappingKeypair, toHex, type Hex } from '../../src/core/crypto.js';
import { accountVerifierKeysIn } from '../../src/server/vault-chain.js';
import { DEPLOYED_CIRCUITS } from '../../src/midnight/deferral.js';
import { fileURLToPath } from 'node:url';
import { readProvenTransaction } from '../../src/wiring/proven-submission.js';
import { startingLedgerFrom } from '../../src/wiring/vault-submission.js';
import { approverRosterFrom } from '../../src/core/vault-approvers.js';
import { keysFoldedIntoTheRoster } from './keys-folded-into-the-roster.js';
import { keysOnDisk } from './keys-on-disk.js';
import { anAccountBornHeld } from './an-account-born-held.js';

/** Deposits or payments on their way, kept for the length of one test, sealed as the page keeps them. */
const keptOnThisDevice = <T,>(kind: 'deposit' | 'payment'): KeptOnThisDevice<T> =>
  sealedOnThisDevice<T>(inFlightRecordsInMemory(), { signerId: 'ada', wrappingSecret: newWrappingKeypair().secret }, kind);
const inFlightInMemory = (): DepositsInFlight => keptOnThisDevice<DepositInFlight>('deposit');

const NET = 'undeployed';
const RECORDS: readonly WireRecord[] = ['pool', 'deposit-journal', 'payment-journal', 'nonce-secret'];
const ACCOUNT_ID = 'acc_vaulted';
const TOKEN_HEX = 'a7'.repeat(32);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const asRuntime = (state: { serialize(): Uint8Array }) => (runtime as any).ContractState.deserialize(state.serialize());
const vaultLedgerOf = (state: { serialize(): Uint8Array }) => (vaultModule as any).ledger(asRuntime(state).data);

const releasedCompanyKey = (words: string, company: CompanyLabel, account: string): Uint8Array => {
  const ask = parseAsk(unlockAsk({
    name: 'Confidential Accounts', rdns: 'social.lemonade.confidential-accounts', purpose: UNLOCK_PURPOSE,
    nonce: 'derivation-has-no-conversation', expiresAt: UNLOCK_WINDOW_MS, company, account: readAccountAddress(account),
  }), 'https://payroll.example', 0);
  if (ask.kind !== 'unlock') throw new Error('not an unlock');
  return unlockKeyFor(identityFromWords(words), ask);
};

/* ------------------------------------------------------------------ the chain */

/** The ledger's own state machine, one transaction per block, signatures checked. */
class Chain {
  state: any = L.LedgerState.blank(NET);
  everCreated = new Map<string, Set<string>>();
  /* The state each deploy left at its address, as an indexer answers for the deploy of a contract. */
  deploys = new Map<string, any>();
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
      for (const intent of tx.intents?.values() ?? []) {
        for (const action of intent.actions ?? []) {
          if (action.initialState !== undefined && action.address !== undefined) this.deploys.set(String(action.address).toLowerCase(), action.initialState);
        }
      }
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

const accountKeys = accountVerifierKeysIn(fileURLToPath(new URL('../..', import.meta.url)));

/*
 * **THE DEPLOY, THE HANDOVER AND THE DEPOSIT BELOW ARE BUILT FROM THE VAULT'S
 * VERIFIER KEYS, WHICH ONLY A FULL VAULT COMPILE PRODUCES.** The general checks
 * compile without them, so this is skipped there by name, and the job that
 * builds the keys runs this file by name after building them.
 *
 * Derived from this file's own location, not the working directory.
 */
/* Every circuit of the account and of the vault has its verifier key on disk, and each is the key this build compiled. */
const KEYS = keysOnDisk();
const KEYS_ON_DISK = KEYS.ok;
if (!KEYS_ON_DISK) {
  console.log(`  NOT CHECKED HERE: a company vault was not created, handed over, pooled and funded through the routes the page calls, because ${KEYS.why}`);
}

describe.skipIf(!KEYS_ON_DISK)('A COMPANY VAULT, FROM THE SIGNER\'S DEVICE [needs contracts/managed-vault/keys and contracts/managed/keys; `npm run compact` then `npm run compact:vault -- --full` build them]', () => {
  let chain: Chain;
  let depositor: AWalletThatPaysPrivately;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let store: MemoryStore;
  let viewingKey: Hex;
  let company: Hex;
  /* The account as its deploy left it: what the signer's wallet reads its founding seat from. */
  let deployed: { serialize(): Uint8Array };
  /* The label the company's keys are derived from, drawn once as the founding signer's wallet draws it. */
  let label: CompanyLabel;
  let words: string;
  let me: DeviceSigner;
  let signing: ReturnType<typeof newSigningKeypair>;
  let wrapping: ReturnType<typeof newWrappingKeypair>;
  let sent: string[];
  let temporaryKeys: Map<string, { tag: string; value: string }>;
  let serverStores: Map<WireRecord, MemorySealedPoolStore>;
  let companyThreshold: number;
  /* The founding signer's own three, as their keyring holds them: what the account's rounds are proved with. */
  let founder: AccountPrivateState;

  const zk = new NodeZkConfigProvider(new URL('../managed-vault', import.meta.url).pathname);
  const accountZk = new NodeZkConfigProvider(new URL('../managed', import.meta.url).pathname);
  /* The vault's keys with the account's served beside them by circuit name, as the worker routes them. */
  const both = new (class extends NodeZkConfigProvider<string> {
    override getZKIR(c: string) { return ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE.includes(c) ? accountZk.getZKIR(c) : super.getZKIR(c); }
    override getProverKey(c: string) { return ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE.includes(c) ? accountZk.getProverKey(c) : super.getProverKey(c); }
    override getVerifierKey(c: string) { return ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE.includes(c) ? accountZk.getVerifierKey(c) : super.getVerifierKey(c); }
  })(new URL('../managed-vault', import.meta.url).pathname);
  const accountCompiled = CompiledContract.make('ConfidentialAccount', (accountModule as any).Contract).pipe(
    CompiledContract.withWitnesses(witnesses as never));
  const compiled = CompiledContract.make('Vault', (vaultModule as any).Contract).pipe(
    CompiledContract.withWitnesses({ noteToSpend: () => { throw new Error('nothing here spends'); }, nonceSecret: () => { throw new Error('nothing here spends'); } } as any),
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
      /*
       * The indexer the wallet names, over this chain: the vault's state as the ledger holds it, and every output the
       * chain made for it, served as one transaction's events. The worker reads the vault from these and nothing else.
       */
      chainSourceAt: () => ({
        contractState: async (v: string) => chain.contract(v),
        deployState: async (v: string) => chain.deploys.get(v.toLowerCase()) ?? null,
        transactions: { of: async () => ['e0'.repeat(32)] as never },
        events: {
          eventsOf: async () => [...chain.everCreated.values()].flatMap((made, i) => [...made].map((commitment) => ({
            transactionHash: 'e0'.repeat(32),
            details: { tag: 'zswapOutput', commitment, contract: [...chain.everCreated.keys()][i]!, mtIndex: 0n },
          }))),
        },
      }),
      compiled, zkConfig: both,
      /* The company account beside the vault, as the worker loads it: its compiled contract, its functions and its ledger. */
      accountCompiled, accountZkConfig: accountZk, accountPure: (accountModule as any).pureCircuits,
      accountLedger: (accountModule as any).ledger,
      /* What a vault's first secret run is made again with, where its approval is built. */
      vaultPure: (vaultModule as any).pureCircuits,
      /* The vault's keys as the worker checks them before reading a vault as it was born. */
      vaultKeys: checkedAccountKeys(async (c) => await zk.getVerifierKey(c) as unknown as Uint8Array, (vaultModule as any).expectedVk,
        (b) => new Uint8Array(createHash('sha256').update(b).digest()), 'the vault'),
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
  /*
   * The service's own reader for a deploy and a handover; every circuit's call arrives unproven (above), read as
   * itself. Only bytes that ARE a pre-proof transaction are read that way: anything else is refused exactly as the
   * service's own reader refuses it. Each call read as unproven is written down by its entry points, so a test can
   * say which calls arrived unproven and that nothing else did.
   */
  let readAsUnproven: string[] = [];
  const entryPointsOf = (tx: any): string => [...tx.intents.values()]
    .flatMap((i: any) => i.actions.map((a: any) => (a.entryPoint === undefined ? 'no call'
      : a.entryPoint instanceof Uint8Array ? new TextDecoder().decode(a.entryPoint) : String(a.entryPoint))))
    .join('+');
  const readers = {
    proven: async (b: Uint8Array) => {
      try { return await readProvenTransaction(b); } catch (refused) {
        let unproven: any;
        try { unproven = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', b); } catch { throw refused; }
        readAsUnproven.push(entryPointsOf(unproven));
        return unproven;
      }
    },
    finished: async (b: Uint8Array) => L.Transaction.deserialize('signature', 'pre-proof', 'binding', b),
  };

  beforeEach(async () => {
    readAsUnproven = [];
    chain = new Chain();
    /* The depositor's wallet holds its own private coins before anything else is on the chain. */
    depositor = aWalletThatPaysPrivately(NET);
    chain.seed(depositor.seedTransaction(TOKEN_HEX, [100_000n, 100_000n, 100_000n, 100_000n]));
    store = new MemoryStore();
    founder = privateStateFor(1);
    label = drawCompanyLabel();
    words = newWords().join(' ');
    /*
     * The company account, created as its founding signer's browser creates one: held by their committee key for
     * the label from its first transaction, then its second step signed by that key in their wallet. Both are on
     * the chain, and recorded as the account-creation route records them, before the watch begins.
     */
    const made = await anAccountBornHeld({ network: NET, founder: identityFromWords(words), label, foundingLeaf: hex(leafOfDevice(founder)) });
    for (const step of [made.deploy.proven, made.insert.proven]) {
      const seeded = chain.seed((L.Transaction.deserialize('signature', 'proof', 'pre-binding', step) as any).bind());
      if (!seeded.ok) throw new Error(`the company account was not created: ${seeded.error}`);
      if (step === made.deploy.proven) deployed = chain.contract(made.deploy.address.toLowerCase());
    }
    company = made.deploy.address.toLowerCase() as Hex;
    companyThreshold = 1;
    signing = newSigningKeypair();
    wrapping = newWrappingKeypair();
    me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: releasedCompanyKey(words, label, company) };
    sent = [];
    temporaryKeys = new Map();
    /* A company of one, with its roster sealed under a viewing key the page holds, as the product keeps it. */
    viewingKey = toHex(new Uint8Array(32).fill(0x5e));
    store.putAccount(sealAccount({
      id: ACCOUNT_ID, createdAt: new Date().toISOString(), name: 'Northwind', companyLabel: label,
      /* The account's address, recorded on the company as the account-creation route records it once the deploy is read. */
      contractAddress: company, addressSource: 'chain',
      signers: [{
        /* The founding signer's own seat, as the chain seats it: a records key is believed only for the seat held. */
        id: 'ada', userId: 'ada', name: 'Ada', status: 'active', role: 'admin', leafCommitment: hex(leafOfDevice(founder)),
        signingPublicKey: signing.publicKey, wrappingPublicKey: wrapping.publicKey,
      }],
      policy: { threshold: 1, limitsByRole: {} }, recovery: { signerIds: ['ada'], threshold: 1 }, wrappedKeys: [],
    } as never, viewingKey, []));
    store.recordAccountOpening({ accountId: ACCOUNT_ID, foundingKey: made.foundingKey, foundingLeaf: hex(leafOfDevice(founder)), companyLabel: label });
    store.recordAccountDeploy({
      accountId: ACCOUNT_ID, address: company, foundingKey: made.foundingKey, recordedAt: new Date().toISOString(),
      deploy: base64FromBytes(made.deploy.proven), insert: base64FromBytes(made.insert.proven),
    });
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
      startingLedgerOf: (s) => startingLedgerFrom(vaultLedgerOf(s as never), (vaultModule as any).pureCircuits.copiesWrittenKey()),
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
    app.use(seatDirectoryRoutes({ signedIn, member, store, chain: directoryChainOver(() => chain.contract(company)) }));
    app.use(companyVaultRoutes({
      signedIn, member, store,
      company: async () => ({ address: company, threshold: companyThreshold, vaultThresholds: [] }),
      ledger, chain: vaultChain,
      verifierKeys: async () => new Map(await Promise.all(
        [...VAULT_CIRCUITS]
          .map(async (c) => [c, await zk.getVerifierKey(c) as unknown as Uint8Array] as const))),
      account: {
        circuits: DEPLOYED_CIRCUITS,
        verifierKeys: accountKeys,
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
      mayFileUnder: mayFileUnderOver(store, directoryChainOver(() => chain.contract(company))),
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
    startAccountCall: (vault, body) => http(`/api/accounts/${ACCOUNT_ID}/vaults/${vault}/start/account`, { method: 'POST', body }, as),
    startSecret: (vault, tx) => http(`/api/accounts/${ACCOUNT_ID}/vaults/${vault}/start/secret`, { method: 'POST', body: { tx } }, as),
    startCopy: (vault, tx, place) => http(`/api/accounts/${ACCOUNT_ID}/vaults/${vault}/start/copy`, { method: 'POST', body: { tx, place } }, as),
  });
  const keys: TemporaryKeys = {
    put: async (v, k) => { temporaryKeys.set(v, k); },
    get: async (v) => temporaryKeys.get(v) ?? null,
    forget: async (v) => { temporaryKeys.delete(v); },
  };
  /*
   * The pacing every operation takes, and the company as a device counts it for the vault check: three seats with every
   * right and one approval needed, a stand-in, so no vault here is left short. The check is driven in
   * `src/core/a-vault-keeps-as-many-approvers-as-its-bar.test.ts` and `apps/web/src/adapters/create-vault.test.ts`.
   */
  const pacing = {
    sleep: async () => {}, waitMs: 3, everyMs: 1, vaultName: (v: string) => v,
    /* The indexer this signer's own wallet names: the worker reads the vault there, over the chain above. */
    indexer: async () => ({ indexerUri: 'https://indexer.example/api/v3/graphql', indexerWsUri: 'wss://indexer.example/api/v3/graphql/ws' }),
    approvers: async () => approverRosterFrom({
      threshold: 1, vaultThresholds: [], seated: ['e1', 'e2', 'e3'].map((leaf) => ({ leaf })), adoptedVaults: [], companyWide: 'cc'.repeat(32),
    }),
  };
  const wireAs = (person: string): WireSend => async (path, init) => {
    if (init.body !== undefined) sent.push(init.body);
    const r = await fetch(base + path, {
      method: init.method, ...(init.body === undefined ? {} : { body: init.body }),
      headers: { 'content-type': 'application/json', 'x-test-person': person },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  /* The page's own requests, as `api` makes them. */
  const apiAs = (as = 'ada') => async (path: string, init?: RequestInit) =>
    http(path, { method: String(init?.method ?? 'GET'), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) }, as);
  /* Who filed each version, judged afresh for every read: the directory read again and the account read off the chain. */
  const judge = () => judgeOver({
    api: apiAs(), accountId: ACCOUNT_ID, label, account: company, accountState: () => chain.contract(company), deployed: () => deployed,
    roster: async () => openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey),
  });
  const records = (secret = signing.secret) => (record: WireRecord) =>
    new HttpSealedPoolStore(record, wireAs('ada'), secret, judge());
  /* The founding signer's own directory entry, signed by their wallet and filed from their device once the account is the committee's. */
  const fileEntry = () => fileOwnEntry({
    api: apiAs(), accountId: ACCOUNT_ID, person: 'ada', identity: identityFromWords(words), label, account: company,
    companyKey: me.companyKey, signingKey: signing.publicKey, seat: hex(leafOfDevice(founder)),
  });
  const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
  /** The founding signer's three, as their keyring hands them to the page. */
  const material = () => ({ signingSecret: hex(founder.secretKey), blinding: hex(founder.blinding), scope: hex(founder.scope) });
  /** Everything the page hands the press that creates a vault. */
  const createDoors = () => ({
    ...pacing, account: readAccountAddress(company)!, service: service(), builder: builder(), keys,
    me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records: records(), material: material(),
    onChain: walletReads,
    /* What the founding signer's wallet gave, and reads off the chain afresh for each check: who holds the account and the vault. */
    secretReaders: {
      company: label, committeeKey: committeeKeyFor(identityFromWords(words), label),
      read: async (v: Hex) => ({
        ...seatsInAccountState(chain.contract(company).serialize()),
        vault: vaultInState(v as never, chain.contract(v).serialize()),
      }),
      roster: async () => rosterVaultKeys(openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey)),
    },
  });
  /* Who holds the company and which vaults it adopted, as the signer's own wallet reads them off the chain for each step. */
  const walletReads = walletReadsOver(() => chain.contract(company), { state: () => deployed, label: () => label });
  const giveKeys = () => keysFoldedIntoTheRoster(store, ACCOUNT_ID, viewingKey, label, company, 'ada', signVaultKeys(ACCOUNT_ID, 'ada', {
        committeeKey: committeeKeyFor(identityFromWords(words), label), recordsKey: recordsReaderOf(me.companyKey).publicKey,
        ...((st) => ({ recordsKeyStatement: st.signature as Hex, recordsKeySeat: st.seat as Hex }))(
            signRecordsKey(identityFromWords(words), label, company as never, me.companyKey, hex(leafOfDevice(founder)))),
      }, signing.secret));
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
    const doors = createDoors();
    await expect(createCompanyVault(doors)).rejects.toThrow(/committee that must hold the vault's rules is not complete/);
    expect(chain.applied).toEqual([]);
    /* And the route itself refuses a deploy sent without asking. */
    const built = await builder().bornHeldVault!({ account: company, holders: { committee: [committeeKeyFor(identityFromWords(words), label)], threshold: 1 } });
    await expect(http(`/api/accounts/${ACCOUNT_ID}/vaults`, { method: 'POST', body: { tx: built.tx } }))
      .rejects.toMatchObject({ status: 409, nothingWasSent: true });
    expect(chain.applied).toEqual([]);
  });

  it('CREATED BORN HELD, STARTED, POOLED AND FUNDED - AND NOTHING IS REPORTED DONE UNTIL THE CHAIN SAYS SO', async () => {
    await giveKeys();
    const committee = committeeKeyFor(identityFromWords(words), label);
    const doors = createDoors();
    expect(await fileEntry()).toBe('filed');

    /* RED WHEN: the press ends before the chain shows the vault adopted, its secret set and every copy written. */
    const created = await createCompanyVault(doors);
    expect(created.state).toBe('started');
    const vault = created.vault;
    /*
     * The deploy, held by the committee from its first transaction; the adoption raised, approved and carried out;
     * the first secret run raised and approved, the secret set and the founding signer's sealed copy written. Eight,
     * every one applied, and no hand-over among them.
     */
    expect(chain.applied.map((a) => a.ok)).toEqual(Array(8).fill(true));
    const startedAt = chain.applied.length;
    /* RED WHEN the deploy reaches the service unproven, or a call of the start is read as something else. */
    expect(readAsUnproven).toEqual(['propose', 'approve', 'adopt', 'propose', 'approve', 'setNonceSecret+approveVaultChange', 'writeSecretCopy']);
    /*
     * RED WHEN: any key but the company's committee ever holds the vault: it is held by that committee at its
     * threshold, never changed, and no key was kept on this device or sent to the service.
     */
    const held = chain.contract(vault).maintenanceAuthority;
    expect(held.committee.map((k: { value: string }) => k.value)).toEqual([committee.value]);
    expect(held.threshold).toBe(1);
    expect(held.counter).toBe(0n);
    expect(temporaryKeys.size).toBe(0);
    expect(store.getCompanyVault(vault)).toMatchObject({ bornHeld: true, intended: { committee: [committee], threshold: 1 } });
    /* RED WHEN: the press ends without the company's account adopting the vault. */
    expect((accountModule as any).ledger(asRuntime(chain.contract(company)).data).vaults.member(Buffer.from(vault, 'hex'))).toBe(true);
    const startedLedger = vaultLedgerOf(chain.contract(vault));
    /* RED WHEN: the press ends with a vault that does not take money: no secret, or a sealed copy missing. */
    expect(startingLedgerFrom(startedLedger, (vaultModule as any).pureCircuits.copiesWrittenKey()).started).toBe(true);
    /* RED WHEN: the secret set is not the one the company's records hold, or the founding signer's copy does not open from their words. */
    const filed = (await import('../../src/midnight/company-nonce-secret.js')).openNonceSecrets(
      (await serverStores.get('nonce-secret')!.get(vault))!, vault, recordsKeypairFrom(me.companyKey));
    expect(hex(startedLedger.nonceCommitment)).toBe(hex((vaultModule as any).pureCircuits.secretCommitmentOf(
      Buffer.from(vault, 'hex'), Buffer.from(filed.secrets[0]!, 'hex'))));
    const fromWords = recordsKeypairFrom(releasedCompanyKey(words, label, company));
    const onChainCopy = secretCopyOnTheChain(startedLedger.secretCopies,
      (c, r, place, part) => (vaultModule as any).pureCircuits.copyKeyOf(c, r, place, part),
      { commitment: hex(startedLedger.nonceCommitment), reader: fromWords.publicKey, count: 1n });
    expect(openSecretCopy({ vault, parts: onChainCopy!, reader: fromWords })).toBe(filed.secrets[0]);
    /* RED WHEN: a press for a vault already started sends anything at all. */
    await expect(createCompanyVault(doors, vault)).resolves.toEqual({ vault, state: 'started' });
    expect(chain.applied).toHaveLength(startedAt);
    /* The committee holds the vault and the account it pays out on. */
    expect((await http(`/api/accounts/${ACCOUNT_ID}/vaults`)).rows)
      .toEqual([expect.objectContaining({ vault, state: 'held-by-committee', why: null })]);
    const poolDoors = { ...pacing, service: service(), builder: builder(), account: readAccountAddress(company)!, onChain: walletReads, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records: records() };

    /* ---- the pool and the nonce secret, filed signed through the mounted route ---- */
    await openCompanyVaultPool(poolDoors, vault, async () => {});
    expect(await serverStores.get('pool')!.get(vault)).not.toBeNull();
    expect(await serverStores.get('nonce-secret')!.get(vault)).not.toBeNull();
    await openCompanyVaultPool(poolDoors, vault, async () => {});
    expect((await serverStores.get('pool')!.versions(vault)).length).toBe(1);
    /* A filing signed with a key its filer did not give is refused, whoever sends it. */
    const stranger = newSigningKeypair();
    await expect(new SealedNotePool(records(stranger.secret)('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers)
      .save(vault, { notes: [] }, { vault, version: 1 })).rejects.toThrow(/403|not filed|could not be/);
    expect((await serverStores.get('pool')!.versions(vault)).length).toBe(1);


    /* ---- the deposit ---- */
    shown = [];
    const deposited = await depositIntoCompanyVault({
      ...poolDoors, company: label, account: readAccountAddress(company)!, builder: builder(), pay: wallet, inFlight: inFlightInMemory(),
    }, vault, { token: TOKEN_HEX, value: 1_000n });
    expect(chain.applied.map((a) => a.ok)).toEqual(Array(startedAt + 1).fill(true));
    const depositAt = startedAt;
    /* The deposit arrives finished by the wallet, through the other reader. RED WHEN anything after the start is read as unproven. */
    expect(readAsUnproven).toHaveLength(7);

    expect(shown).toEqual([[{ token: TOKEN_HEX, amount: '1000', kind: 'shielded' }]]);
    const notes = [...vaultLedgerOf(chain.contract(vault)).notes].map((c: Uint8Array) => hex(c));
    expect(notes).toHaveLength(1);
    /* An unproven transaction has no hash, so the service names none; the note is recorded under the transaction the
     * vault's history holds its output in, found through the service's own route by the output's commitment. */
    expect(chain.applied[depositAt]!.hash).toMatch(/^unproven:/);
    expect(deposited.transactionHash).toBeNull();
    /* RED WHEN: the page does not look the deposit up by its output - the note is then recorded without its transaction. */
    expect(deposited.note.createdIn, 'the deposit is recorded without its creating transaction')
      .toBe(createHash('sha256').update(chain.applied[depositAt]!.hash.slice('unproven:'.length)).digest('hex'));
    expect(deposited.notYetSpendable).toBeUndefined();
    const pool = new SealedNotePool(records()('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers);
    const loaded = await pool.load(vault);
    expect(loaded.notes).toEqual([deposited.note]);
    expect(notes[0]).toBe((await builder().commitments({ vault, coin: { nonce: deposited.note.nonce, token: TOKEN_HEX, value: '1000' } })).held);
    expect(loaded.notes[0]!.value).toBe(1_000n);

    /* ---- nothing the service received carried a key a wallet or this device keeps ---- */
    for (const secret of [
      hex(me.companyKey), wrapping.secret, signing.secret,
      identityFromWords(words).words.join(' '),
    ]) {
      expect(sent.some((b) => b.includes(secret))).toBe(false);
    }
  });

  it('THE LEDGER\'S OWN RULE THIS RESTS ON: the vault, born held, takes no deposit until its account approves a secret', async () => {
    const committee = { committee: [committeeKeyFor(identityFromWords(words), label)], threshold: 1 };
    const built = await builder().bornHeldVault!({ account: company, holders: committee });
    expect(chain.apply((L.Transaction.deserialize('signature', 'proof', 'pre-binding', bytesFromBase64(built.tx)) as any).bind()).ok).toBe(true);
    /*
     * A vault refuses a deposit until its account has adopted it and approved its first secret, so a stranger's
     * deposit is refused in the circuit, whoever holds the vault.
     * RED WHEN a vault fresh from its deploy takes money.
     */
    await expect(builder().deposit({
      vault: built.vault, coin: { nonce: 'd2'.repeat(32), token: TOKEN_HEX, value: '7' }, state: base64FromBytes(chain.contract(built.vault).serialize()),
      parameters: base64FromBytes(chain.state.parameters.serialize()),
    })).rejects.toThrow(/takes no money yet/);
    expect([...vaultLedgerOf(chain.contract(built.vault)).notes]).toHaveLength(0);
  });
});

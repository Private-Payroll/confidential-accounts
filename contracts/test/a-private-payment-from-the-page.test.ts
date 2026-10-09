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
 *     account's `recordPaymentFromVault` computed inside the same call against the
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
import { NoteIndexUnreadable } from '../../src/midnight/note-index.js';
import { createHash, randomBytes } from 'node:crypto';
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
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import { companyLabelOf, drawCompanyLabel, readAccountAddress } from 'midnight-identity/profile/company-label';
import * as vaultModule from '../managed-vault/contract/index.js';
import * as accountModule from '../managed/contract/index.js';
import { witnesses, type AccountPrivateState } from '../src/witnesses.js';
import { aWalletThatPaysPrivately, type AWalletThatPaysPrivately } from './a-wallet-that-pays-privately.js';
import { aWalletThatPaysPublicly } from './a-wallet-that-pays-publicly.js';
import { privateStateFor, leafOfDevice, change, ZERO_32, COMPANY_LABEL, rootOfTestLeaves } from './simulator.js';
import { MemoryStore } from '../../src/core/store.js';
import { AccountService, newStateBlinding, openAccount, sealAccount, sealState } from '../../src/core/account.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { rosterVaultKeys, signVaultKeys } from '../../src/core/vault-keys.js';
import { seatsInAccountState, vaultInState } from '../../apps/wallet/src/chain/company-label-on-chain.js';
import { directoryChainOver, fileOwnEntry, judgeOver, mayFileUnderOver, walletReadsOver } from './the-chain-as-a-wallet-reads-it.js';
import { seatDirectoryRoutes } from '../../src/server/seat-directory-route.js';
import { ChainLedger } from '../../src/wiring/chain.js';
import { companyVaultRoutes, type VaultChain } from '../../src/server/company-vaults.js';
import { mountVaultRecords, vaultAccountFromTheIndexer } from '../../src/server/vault-records-authority.js';
import { MemorySealedPoolStore, SealedNotePool } from '../../src/midnight/vault-pool.js';
import { PaymentJournalInStore } from '../../src/midnight/vault-journal.js';
import type { WireRecord } from '../../src/midnight/sealed-record-wire.js';
import { HttpSealedPoolStore, type WireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { recordsReaderOf, type DeviceSigner } from 'vaults-web-shared/deposit-on-device.js';
import { answerVaultAsk, checkedAccountKeys } from 'vaults-web-shared/vault-worker-entry.js';
import { vaultBuilderOver, type VaultAnswer } from 'vaults-web-shared/vault-worker-client.js';
import { chainReadThroughTheWallet, setSpendingPolicyOnDevice, spendingPolicyHere } from 'vaults-web-shared/spending-policy-here.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../../src/midnight/sealed-record-wire.js';
import { rolesInAccountState } from '../../apps/wallet/src/chain/company-label-on-chain.js';
import { periodTotalHere, type ChargeInFlight } from 'vaults-web-shared/run-charged-here.js';
import { periodOf } from '../../src/midnight/spending-policy-record.js';
import { spendingPolicyKeysOf } from 'vaults-web-shared/governed-call-builder.js';
import {
  createCompanyVault, depositIntoCompanyVault, mergeNotesInCompanyVault, openCompanyVaultPool, payPrivatelyFromCompanyVault,
  payPubliclyFromCompanyVault,
  type TemporaryKeys, type VaultService, type DepositInFlight, type DepositsInFlight, type PaymentInFlight, type PaymentsInFlight,
} from 'vaults-web-shared/vault-operation.js';
import { inFlightInMemory as inFlightRecordsInMemory, sealedOnThisDevice, type KeptOnThisDevice } from 'vaults-web-shared/in-flight-on-this-device.js';
import {
  readWhatThePageAsks, base64FromBytes, whyThePublicBalancingIsNotWhatWasApproved,
} from '../../apps/wallet/src/chain/balance-for-page.js';
import { depositFromSource, publicTokenFromTheWallet } from 'vaults-web-shared/deposit-source.js';
import { StaticAssetRegistry, type Asset } from '../../src/core/assets.js';
import { UNLOCK_PURPOSE, UNLOCK_WINDOW_MS, unlockAsk } from '../../src/core/wallet-unlock.js';
import { fromHex, newSigningKeypair, newWrappingKeypair, signingPublicKeyOf, toHex, type Hex } from '../../src/core/crypto.js';
import { accountVerifierKeysIn } from '../../src/server/vault-chain.js';
import { anAccountBornHeld } from './an-account-born-held.js';
import { DEPLOYED_CIRCUITS } from '../../src/midnight/deferral.js';
import { fileURLToPath } from 'node:url';
import { readProvenTransaction } from '../../src/wiring/proven-submission.js';
import {
  refusalForDeposit, refusalForPayout, refusalForPublicDeposit, refusalForPublicPayout, startingLedgerFrom,
} from '../../src/wiring/vault-submission.js';
import { buildRetryRun, buildRun, rootOfPayments } from '../../src/midnight/payout-tree.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { payeeAddressFromKeys, type Payee } from '../../src/midnight/payee-address.js';
import { unshieldedPayeeFor } from '../../src/testing/payees.js';
import { assemblePrivatePayments } from '../../src/midnight/private-payment-wire.js';
import { witnessesOver } from '../../src/midnight/vault-notes.js';
import { payFor } from '../../src/testing/payees.js';
import { ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE, VAULT_CIRCUITS } from '../../src/midnight/vault-contract.js';
import { approverRosterFrom } from '../../src/core/vault-approvers.js';
import { keysFoldedIntoTheRoster } from './keys-folded-into-the-roster.js';
import { keysOnDisk } from './keys-on-disk.js';
import { PayrollService, RecordingInviteDelivery, runLegOf } from '../../src/core/payroll.js';
import { SimulatedLedger } from '../../src/core/ledger.js';
import { sealHandover } from '../../src/core/invite-handover.js';
import { currentPayoutSeed } from '../../src/midnight/run-keys.js';
import { openNonceSecrets, recordsKeypairFrom } from '../../src/midnight/company-nonce-secret.js';
import type { PayrollRun, RosterEmployee, User } from '../../src/core/types.js';
import { signedFoundingState } from '../../src/core/founding-state.js';
import { newProposalId } from '../../src/core/proposal-filing.js';
import { NothingWasSent } from '../../src/core/jobs.js';
import type { LedgerStatus } from '../../src/core/ledger.js';
import { runRoutes } from '../../src/server/run-routes.js';
import { openSealedRun } from '../../src/core/run-legs.js';
import { proposalRelayRoutes } from '../../src/server/proposal-relays.js';
import { directoryOf } from '../../src/server/seat-directory-route.js';
import { attestedIn, directoryFilingsFrom, directoryHere } from 'vaults-web-shared/vault-page-doors.js';
import { drawRunHere } from 'vaults-web-shared/run-drawn-here.js';
import { governedCallServiceFor, openTheRoundHere, raiseRunOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import type { LegRaiseDoors } from 'vaults-web-shared/run-raised-here.js';
import type { CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import type { PeopleHere } from 'vaults-web-shared/people-on-device.js';
import { payAnApprovedLeg } from 'vaults-web-shared/leg-paid-here.js';

/** Deposits or payments on their way, kept for the length of one test, sealed as the page keeps them. */
const keptOnThisDevice = <T,>(kind: 'deposit' | 'payment'): KeptOnThisDevice<T> =>
  sealedOnThisDevice<T>(inFlightRecordsInMemory(), { signerId: 'ada', wrappingSecret: newWrappingKeypair().secret }, kind);
const inFlightInMemory = (): DepositsInFlight => keptOnThisDevice<DepositInFlight>('deposit');
const paymentsInFlight = (): PaymentsInFlight => keptOnThisDevice<PaymentInFlight>('payment');

const NET = 'undeployed';
const RECORDS: readonly WireRecord[] = ['pool', 'deposit-journal', 'payment-journal', 'nonce-secret'];
const ACCOUNT_ID = 'acc_paying';
const TOKEN = 'a7'.repeat(32) as Hex;
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const asRuntime = (state: { serialize(): Uint8Array }) => (runtime as any).ContractState.deserialize(state.serialize());
const vaultLedgerOf = (state: { serialize(): Uint8Array }) => (vaultModule as any).ledger(asRuntime(state).data);
const accountLedgerOf = (state: { serialize(): Uint8Array }) => (accountModule as any).ledger(asRuntime(state).data);
const accountCircuits = (accountModule as any).pureCircuits;

/** The label the account below carries, as its founding signer's wallet drew it. */
const LABEL = companyLabelOf(COMPANY_LABEL);

const releasedCompanyKey = (words: string, account: string): Uint8Array => {
  const ask = parseAsk(unlockAsk({
    name: 'Confidential Accounts', rdns: 'social.lemonade.confidential-accounts', purpose: UNLOCK_PURPOSE,
    nonce: 'derivation-has-no-conversation', expiresAt: UNLOCK_WINDOW_MS, company: LABEL, account: readAccountAddress(account),
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
  /* The state each deploy left at its address, as an indexer answers for the deploy of a contract. */
  deploys = new Map<string, any>();
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
      for (const intent of tx.intents?.values() ?? []) {
        for (const action of intent.actions ?? []) {
          if (action.initialState !== undefined && action.address !== undefined) this.deploys.set(String(action.address).toLowerCase(), action.initialState);
        }
      }
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

const accountKeys = accountVerifierKeysIn(fileURLToPath(new URL('../..', import.meta.url)));

/*
 * **THE VAULT'S AND THE ACCOUNT'S VERIFIER KEYS, WHICH ONLY A FULL COMPILE OF
 * EACH PRODUCES.** The general checks compile without them, so this is skipped
 * there by name, and the job that builds the keys runs this file by name.
 */
/* Every circuit of the account and of the vault has its verifier key on disk, and each is the key this build compiled. */
const KEYS = keysOnDisk();
const KEYS_ON_DISK = KEYS.ok;
if (!KEYS_ON_DISK) {
  console.log(`  NOT CHECKED HERE: a private payment was not made out of a company vault through the routes the page calls, because ${KEYS.why}`);
}

describe.skipIf(!KEYS_ON_DISK)('A PRIVATE PAYMENT OUT OF A COMPANY VAULT, FROM THE SIGNER\'S DEVICE [needs contracts/managed-vault/keys and contracts/managed/keys; `npm run compact` then `npm run compact:vault -- --full` build them]', () => {
  let chain: Chain;
  let depositor: AWalletThatPaysPrivately;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let store: MemoryStore;
  let viewingKey: Hex;
  let company: Hex;
  /* The account as its deploy left it: what the signer's wallet reads its founding seat from. */
  let deployed: { serialize(): Uint8Array };
  let words: string;
  let me: DeviceSigner;
  let founder: AccountPrivateState;
  let signing: ReturnType<typeof newSigningKeypair>;
  let wrapping: ReturnType<typeof newWrappingKeypair>;
  let sent: string[];
  let arrivals: string[];
  let temporaryKeys: Map<string, { tag: string; value: string }>;
  let serverStores: Map<WireRecord, MemorySealedPoolStore>;
  /* The company's records of every vault's spending policy, as the seats filed them. */
  let policyRecords: SealedCompanyRecord[] = [];
  /* The company's first state, as its founding seat signed it, made once per test. */
  let firstStateKept: ReturnType<typeof signedFoundingState> | undefined;

  const vaultZk = new NodeZkConfigProvider(new URL('../managed-vault', import.meta.url).pathname);
  const accountZk = new NodeZkConfigProvider(new URL('../managed', import.meta.url).pathname);
  /* The vault's keys with the account's served beside them by circuit name, as the worker routes them. */
  const both = new (class extends NodeZkConfigProvider<string> {
    override getZKIR(c: string) { return ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE.includes(c) ? accountZk.getZKIR(c) : super.getZKIR(c); }
    override getProverKey(c: string) { return ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE.includes(c) ? accountZk.getProverKey(c) : super.getProverKey(c); }
    override getVerifierKey(c: string) { return ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE.includes(c) ? accountZk.getVerifierKey(c) : super.getVerifierKey(c); }
  })(new URL('../managed-vault', import.meta.url).pathname);
  const vaultCompiled = (w: unknown) => CompiledContract.make('Vault', (vaultModule as any).Contract).pipe(
    CompiledContract.withWitnesses(w as never));
  const accountCompiled = CompiledContract.make('ConfidentialAccount', (accountModule as any).Contract).pipe(
    CompiledContract.withWitnesses(witnesses as never));
  const neverAsked = {
    check: async () => { throw new Error('asked to check a circuit'); },
    prove: async () => { throw new Error('asked to prove a circuit'); },
    lookupKey: async () => undefined,
  };
  /**
   * The worker's own handler, reached through the page's own client, with no Worker and no prover. `over` stands in
   * for the call builder where a test makes it build what the ledger never would.
   */
  const builder = (over?: { createUnprovenCallTxFromInitialStates: (...args: any[]) => Promise<any> }) => {
    const deps = async () => ({
      ledger: L, vault: vaultModule, runtimeState: (runtime as any).ContractState, contracts: { ...(contracts as any), ...over },
      /*
       * The indexer the wallet names, over this chain: the vault's state as the ledger holds it, every applied
       * transaction and its own events, and one moment of both contracts with the commitment tree. The worker reads
       * the vault, what a step is built on and what it is judged by from these and nothing else.
       */
      chainSourceAt: () => ({
        contractState: async (v: string) => chain.contract(v),
        deployState: async (v: string) => chain.deploys.get(v.toLowerCase()) ?? null,
        transactions: { of: async () => [...chain.events.keys()].reverse() as never },
        events: {
          eventsOf: async (tx: { hash?: string }) => {
            const events = chain.events.get(String(tx.hash));
            if (events === undefined) throw new NoteIndexUnreadable('the indexer does not hold this transaction yet');
            return events.map((e: any) => ({
              transactionHash: String(tx.hash),
              details: {
                tag: String(e.content.tag),
                ...(e.content.commitment === undefined ? {} : { commitment: String(e.content.commitment) }),
                ...(e.content.contract === undefined ? {} : { contract: String(e.content.contract) }),
                ...(e.content.mtIndex === undefined ? {} : { mtIndex: BigInt(e.content.mtIndex) }),
              },
            }));
          },
        },
        atOneBlock: async (vault: string, account: string) => {
          const v = chain.contract(vault);
          const a = chain.contract(account);
          if (v === null || a === null) return null;
          return { blockHash: 'b1'.repeat(32), zswap: chain.state.zswap, vault: v, parameters: chain.state.parameters, account: a };
        },
      }),
      compiled: vaultCompiled({ noteToSpend: () => { throw new Error('nothing here spends'); }, nonceSecret: () => { throw new Error('nothing here spends'); } }),
      compiledWith: (w: ReturnType<typeof witnessesOver>) => vaultCompiled(w),
      zkConfig: both,
      /* The company account beside the vault, as the worker loads it: its compiled contract, its functions and its ledger. */
      accountCompiled, accountZkConfig: accountZk, accountPure: (accountModule as any).pureCircuits,
      accountLedger: (accountModule as any).ledger,
      /* What a vault's first secret run is made again with, where its approval is built. */
      vaultPure: (vaultModule as any).pureCircuits,
      /* The vault's keys as the worker checks them before reading a vault as it was born. */
      vaultKeys: checkedAccountKeys(async (c) => await vaultZk.getVerifierKey(c) as unknown as Uint8Array, (vaultModule as any).expectedVk,
        (b) => new Uint8Array(createHash('sha256').update(b).digest()), 'the vault'),
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
    policyRecords = [];
    firstStateKept = undefined;
    /* The depositor's wallet holds its own private coins before anything else is on the chain. */
    depositor = aWalletThatPaysPrivately(NET);
    chain.apply(depositor.seedTransaction(TOKEN, [100_000n, 100_000n, 100_000n, 100_000n]));
    chain.applied.pop();
    store = new MemoryStore();
    founder = privateStateFor(1);
    words = newWords().join(' ');
    /* The company account, created as its founding signer's browser creates one: held by their committee key from its first transaction. */
    const made = await anAccountBornHeld({ network: NET, founder: identityFromWords(words), label: LABEL, foundingLeaf: hex(leafOfDevice(founder)) });
    for (const step of [made.deploy.proven, made.insert.proven]) {
      const seeded = chain.apply((L.Transaction.deserialize('signature', 'proof', 'pre-binding', step) as any).bind());
      if (!seeded.ok) throw new Error(`the company account was not created: ${seeded.error}`);
      chain.applied.pop();
      if (step === made.deploy.proven) deployed = chain.contract(made.deploy.address.toLowerCase());
    }
    company = made.deploy.address.toLowerCase() as Hex;
    /* The founding seat's own key signs its filings, as a device's seat key does: the one key the account seats it by. */
    signing = { secret: hex(founder.secretKey) as Hex, publicKey: signingPublicKeyOf(hex(founder.secretKey) as Hex) } as ReturnType<typeof newSigningKeypair>;
    wrapping = newWrappingKeypair();
    me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: releasedCompanyKey(words, company) };
    sent = [];
    arrivals = [];
    temporaryKeys = new Map();
    /* A company of one, with its roster sealed under a viewing key the page holds, as the product keeps it. */
    viewingKey = toHex(new Uint8Array(32).fill(0x5e));
    store.putAccount(sealAccount({
      id: ACCOUNT_ID, createdAt: new Date().toISOString(), name: 'Northwind', companyLabel: LABEL,
      /* The account's address, recorded on the company as the account-creation route records it once the deploy is read. */
      contractAddress: company, addressSource: 'chain',
      signers: [{
        /* The founding signer's own seat, as the chain seats it: a records key is believed only for the seat held. */
        id: 'ada', userId: 'ada', name: 'Ada', status: 'active', role: 'admin', leafCommitment: hex(leafOfDevice(founder)),
        signingPublicKey: signing.publicKey, wrappingPublicKey: wrapping.publicKey,
      }],
      policy: { threshold: 1, limitsByRole: {} }, recovery: { signerIds: ['ada'], threshold: 1 }, wrappedKeys: [],
    } as never, viewingKey, []));
    store.recordAccountOpening({ accountId: ACCOUNT_ID, foundingKey: made.foundingKey, foundingLeaf: hex(leafOfDevice(founder)), companyLabel: LABEL });
    store.recordAccountDeploy({
      accountId: ACCOUNT_ID, address: company, foundingKey: made.foundingKey, recordedAt: new Date().toISOString(),
      deploy: base64FromBytes(made.deploy.proven), insert: base64FromBytes(made.insert.proven),
    });
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
      /* As an indexer would answer it: the one applied transaction whose events carry this output, made for this vault. */
      createdBy: async (v, commitment) => {
        for (const [name, events] of chain.events) {
          if (events.some((e: any) => String(e.content.tag) === 'zswapOutput' && String(e.content.commitment).toLowerCase() === commitment.toLowerCase()
            && String(e.content.contract).toLowerCase() === v.toLowerCase())) {
            return { transactionHash: name as Hex, events: events.map((e: any) => ({
              transactionHash: name,
              details: {
                tag: String(e.content.tag),
                ...(e.content.commitment === undefined ? {} : { commitment: String(e.content.commitment) }),
                ...(e.content.contract === undefined ? {} : { contract: String(e.content.contract) }),
                ...(e.content.mtIndex === undefined ? {} : { mtIndex: String(e.content.mtIndex) }),
              },
            })) };
          }
        }
        return null;
      },
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
    app.use(seatDirectoryRoutes({ signedIn, member, store, chain: directoryChainOver(() => chain.contract(company)) }));
    /*
     * The routes a run drawn and raised on a device is filed and relayed through, over this chain: the company's
     * directory as the service reads it, and the account's open proposals and approvals as the chain holds them. A
     * raise is relayed by applying it to this chain. The vault's public money is not asked here: a private leg spends none.
     */
    const directoryNow = (id: string) => directoryOf(store, directoryChainOver(() => chain.contract(company)), id);
    app.use(runRoutes({ signedIn, member, store, directoryOf: directoryNow, wiring: () => 'simulated' }));
    const ownsProposal: express.RequestHandler = (req, res, next) => {
      const p = store.getProposal(String(req.params.id));
      return p !== null && store.getAccount(p.accountId)?.memberUserIds.includes((req as { userId?: string }).userId!) ? next() : res.status(404).json({ error: 'not found' });
    };
    app.use(proposalRelayRoutes({
      signedIn, member, ownsProposal, refuseSigningSecret: (_q, _r, next) => next(), store, directoryOf: directoryNow,
      ledger: {
        wiring: 'simulated',
        status: async (): Promise<LedgerStatus | null> => {
          const l = accountLedgerOf(chain.contract(company));
          return {
            assets: [], vaultThresholds: [], signerCount: 1, threshold: Number(l.threshold),
            openProposals: [...l.openProposals].map(([id, c]: [Uint8Array, Uint8Array]) => ({
              id: hex(id) as Hex, change: hex(c) as Hex, approvals: Number(l.approvalCounts.member(id) ? l.approvalCounts.lookup(id) : 0n),
            })),
          } as unknown as LedgerStatus;
        },
        submitProvenCall: async (_accountId: string, bytes: Uint8Array) => {
          const tx = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', bytes);
          const r = chain.apply(tx);
          if (!r.ok) throw new NothingWasSent(`the chain refused it: ${r.error}. Nothing was sent.`);
          return { ref: nameOf(tx), at: new Date().toISOString() };
        },
      },
      recordRefusal: () => undefined, wiring: () => 'simulated',
      proposalIdOf: (h, salt, v) => MidnightCommitments.proposalId(h as Hex, salt as Hex, v as Hex | undefined),
      publicMoney: async () => undefined,
    }));
    app.use(companyVaultRoutes({
      signedIn, member, store,
      company: async () => ({ address: company, threshold: 1, vaultThresholds: [] }),
      ledger: watched, chain: vaultChain,
      verifierKeys: async () => new Map(await Promise.all(
        [...VAULT_CIRCUITS]
          .map(async (c) => [c, await vaultZk.getVerifierKey(c) as unknown as Uint8Array] as const))),
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
    depositPublicly: (vault, tx, money) => http(`${at}/vaults/${vault}/public-deposit`, { method: 'POST', body: { tx, ...money } }),
    payoutState: (vault) => http(`${at}/vaults/${vault}/payout-state`),
    payout: (vault, tx) => http(`${at}/vaults/${vault}/payout`, { method: 'POST', body: { tx } }),
    merge: (vault, tx) => http(`${at}/vaults/${vault}/merge`, { method: 'POST', body: { tx } }),
    payoutPublicly: (vault, tx) => http(`${at}/vaults/${vault}/public-payout`, { method: 'POST', body: { tx } }),
    startAccountCall: (vault, body) => http(`${at}/vaults/${vault}/start/account`, { method: 'POST', body }),
    startSecret: (vault, tx) => http(`${at}/vaults/${vault}/start/secret`, { method: 'POST', body: { tx } }),
    startCopy: (vault, tx, place) => http(`${at}/vaults/${vault}/start/copy`, { method: 'POST', body: { tx, place } }),
  };
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
  const wire: WireSend = async (path, init) => {
    if (init.body !== undefined) sent.push(init.body);
    const r = await fetch(base + path, {
      method: init.method, ...(init.body === undefined ? {} : { body: init.body }),
      headers: { 'content-type': 'application/json', 'x-test-person': 'ada' },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  /* The page's own requests, as `api` makes them. */
  const api = async (path: string, init?: RequestInit) =>
    http(path, { method: String(init?.method ?? 'GET'), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
  /* Who filed each version, judged afresh for every read: the directory read again and the account read off the chain. */
  const records = (record: WireRecord) => new HttpSealedPoolStore(record, wire, signing.secret, judgeOver({
    api, accountId: ACCOUNT_ID, label: LABEL, account: company, accountState: () => chain.contract(company), deployed: () => deployed,
    roster: async () => openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey),
  }));
  /* Who holds the company and which vaults it adopted, as the signer's own wallet reads them off the chain for each step. */
  const walletReads = walletReadsOver(() => chain.contract(company), { state: () => deployed, label: () => LABEL });
  const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
  const wallet = async (ask: { company: Hex; vault: Hex; transaction: string }) => {
    const asProven = { Transaction: { deserialize: (_s: string, _p: string, b: 'pre-binding', raw: Uint8Array) => L.Transaction.deserialize('signature', 'pre-proof', b, raw) } };
    const read = readWhatThePageAsks(asProven as never, ask.transaction, ask.vault);
    /* Paid for with the stand-in wallet's own private coin, as a wallet does, then bound. */
    return { transaction: base64FromBytes((depositor.payFor(read.tx) as any).bind().serialize()), leaves: read.leaves };
  };

  /** A vault born held by the committee, started, its pool open, and 1,000 in it: the existing path, run to its end. */
  const aFundedVault = async (): Promise<{ vault: Hex; note: { nonce: Hex; token: Hex; value: bigint } }> => {
    await keysFoldedIntoTheRoster(store, ACCOUNT_ID, viewingKey, LABEL, company, 'ada', signVaultKeys(ACCOUNT_ID, 'ada', {
          committeeKey: committeeKeyFor(identityFromWords(words), LABEL), recordsKey: recordsReaderOf(me.companyKey).publicKey,
          ...((st) => ({ recordsKeyStatement: st.signature as Hex, recordsKeySeat: st.seat as Hex }))(
            signRecordsKey(identityFromWords(words), LABEL, company as never, me.companyKey, hex(leafOfDevice(founder)))),
        }, signing.secret));
    const poolDoors = {
      ...pacing, service, builder: builder(), account: readAccountAddress(company)!, onChain: walletReads,
      me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records,
    };
    /* The founding signer's press, with who holds the account as their wallet read it off the chain just then. */
    const press = (resume?: Hex) => createCompanyVault({
      ...poolDoors, account: readAccountAddress(company)!, builder: builder(), keys,
      material: { signingSecret: hex(founder.secretKey), blinding: hex(founder.blinding), scope: hex(founder.scope) },
      secretReaders: {
        company: LABEL, committeeKey: committeeKeyFor(identityFromWords(words), LABEL),
        read: async (v: Hex) => ({
          ...seatsInAccountState(chain.contract(company).serialize()),
          vault: vaultInState(v as never, chain.contract(v).serialize()),
        }),
        roster: async () => rosterVaultKeys(openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey)),
      },
    }, resume as never);
    /* The founding signer's own directory entry, filed from their device: the account is the committee's from its first transaction. */
    await fileOwnEntry({
      api, accountId: ACCOUNT_ID, person: 'ada', identity: identityFromWords(words), label: LABEL, account: company,
      companyKey: me.companyKey, signingKey: signing.publicKey, seat: hex(leafOfDevice(founder)),
    });
    /* Deployed born held, read as it was born, adopted and started by one press: its secret set and every copy written. */
    const created = await press();
    if (created.state !== 'started') throw new Error(`the vault was not started: ${JSON.stringify(created)}`);
    const { vault } = created;
    await openCompanyVaultPool(poolDoors, vault, async () => {});
    const deposited = await depositIntoCompanyVault({ ...poolDoors, company: LABEL, account: readAccountAddress(company)!, builder: builder(), pay: wallet, inFlight: inFlightInMemory() }, vault, { token: TOKEN, value: 1_000n });
    return { vault, note: deposited.note };
  };

  /** The vault's current secret, read back from the company's records and opened with this signer's own records key, as a payment out opens it. */
  const theSecretReadBack = async (vault: Hex): Promise<Hex> => {
    const opened = openNonceSecrets((await records('nonce-secret').get(vault))!, vault, recordsKeypairFrom(me.companyKey));
    return opened.secrets[opened.secrets.length - 1]! as Hex;
  };

  /** A one-person run of `amount`, raised and approved on the account by its founder, and what the service would hand the device for it. */
  const anApprovedRun = async (
    vault: Hex, amount: bigint, paying?: { payee: Payee; token: Hex },
    /** For a payroll raised as more than one run: the run's own id, its own change and who it pays. */
    asRun?: { runId: string; changeSeed: number; person: string },
  ) => {
    const payeeKeys = L.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
    const payee = paying?.payee
      ?? payeeAddressFromKeys({ coinPublicKey: payeeKeys.coinPublicKey as Hex, encryptionPublicKey: payeeKeys.encryptionPublicKey as Hex }, NET);
    /* The run pays the token it moves: its root commits to the token the vault hands the account. */
    const token = paying?.token ?? TOKEN;
    const facts = [{ payee, token, amount }];
    const run = buildRun([{ epoch: 0, seed: toHex(new Uint8Array(randomBytes(32))) }], { accountId: ACCOUNT_ID, runId: asRun?.runId ?? 'run_1', epoch: 0 }, facts, vaultDetails, payFor(facts, asRun === undefined ? {} : { people: [asRun.person] }), token);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const window = { from: now - 600n, until: now + 3_600n };
    const c = change(0n, asRun?.changeSeed ?? 41);
    const idFrom = (leaves: Hex[], w: { from: bigint; until: bigint }) => toHex(accountCircuits.proposalIdOf(
      accountCircuits.runPayload(fromHex(rootOfTestLeaves(leaves, leaves.map(() => amount), fromHex(token))), BigInt(leaves.length), w.from, w.until, 0n), fromHex(vault), c.salt));
    const id = idFrom(run.tree.leaves, window);
    const staged = { ...founder, assetId: c.asset, changeAmount: c.amount, changeBatchDigest: c.batch, proposalSalt: c.salt };
    /* No approvals beyond the vault's bar: `required` is nothing. */
    await callAccount('propose', [ZERO_32, fromHex(run.tree.root), run.tree.payees, window.from, window.until, 0n, true, fromHex(vault)], staged);
    await callAccount('approve', [fromHex(id)], founder);
    const paidNow = () => new Set(run.tree.leaves.filter((leaf) =>
      accountLedgerOf(chain.contract(company)).movements.member(accountCircuits.paidMovementOf(fromHex(leaf)))));
    const order = () => {
      const out = assemblePrivatePayments({
        order: {
          asset: token, form: payee.kind, vault, proposal: id, salt: toHex(c.salt), root: run.tree.root,
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
    /* The deploy, born held, the seven steps of its start and the deposit, every one applied: no hand-over of either contract.
     * RED WHEN: a step of the vault's start is skipped or sent twice, or a hand-over is sent. */
    expect(chain.applied.map((a) => a.ok)).toEqual(Array(9).fill(true));
    const run = await anApprovedRun(vault, 250n);
    expect(accountLedgerOf(chain.contract(company)).openProposals.member(fromHex(run.id))).toBe(true);
    const order = run.order();
    expect(order.payments.map((p) => p.paid)).toEqual([false]);
    const before = chain.applied.length;
    const done = await payPrivatelyFromCompanyVault({
      ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, account: readAccountAddress(company)!, onChain: walletReads, builder: builder(),
      inFlight: paymentsInFlight(),
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

  it('TWO NOTES ARE MERGED FROM THE DEVICE: WRITTEN DOWN, PAID FOR AS THE VAULT\'S OWN COINS, KEPT AS ONE, AND A PAYMENT NEITHER COVERED SPENDS IT WITH NO REBUILD', async () => {
    const { vault, note } = await aFundedVault();
    const doors = {
      ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, account: readAccountAddress(company)!,
      onChain: walletReads, builder: builder(), inFlight: paymentsInFlight(),
    };
    const second = await depositIntoCompanyVault({ ...doors, company: LABEL, pay: wallet, inFlight: inFlightInMemory() }, vault, { token: TOKEN, value: 500n });
    const poolOf = async () => new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).load(vault);
    const named = (await poolOf()).notes.map((n) => ({ nonce: n.nonce, token: n.token, value: n.value.toString() }))
      .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
    expect(named.map((n) => n.nonce)).toEqual([note.nonce, second.note.nonce]);
    const before = chain.applied.length;
    const merged = await mergeNotesInCompanyVault(doors, { vault, notes: named });

    /* ---- one transaction, applied, paid for as the vault moving its own coins ---- */
    expect(chain.applied.slice(before).map((a) => [a.ok, a.error])).toEqual([[true, '']]);
    expect(arrivals.at(-1)).toBe('proven-moving-the-vaults-own-coins');
    /* ---- the vault holds one note, worth both, and pays nobody: RED WHEN the merged coin is not the vault's or not the sum ---- */
    const held = async (n: { nonce: string; token: string; value: string }) => (await builder().commitments({ vault, coin: n })).held;
    expect([...vaultLedgerOf(chain.contract(vault)).notes].map((c: Uint8Array) => hex(c))).toEqual([await held(merged.kept)]);
    expect(merged.kept.value).toBe('1500');
    expect(chain.events.get(chain.applied.at(-1)!.name)!.filter((e: any) => e.content.tag === 'zswapOutput' && e.content.contract === undefined)).toEqual([]);
    /* ---- the pool: both notes gone, the merged one recorded under the merge's own transaction ---- */
    expect((await poolOf()).notes).toEqual([{ nonce: merged.kept.nonce, token: TOKEN, value: 1_500n, createdIn: chain.applied.at(-1)!.name }]);
    expect([merged.transactionHash, merged.seenAs]).toEqual([chain.applied.at(-1)!.name, 'its-own-transaction']);
    /* ---- the journal wrote the merge down as a merge, sending nothing out ---- */
    const journal = await new PaymentJournalInStore(records('payment-journal'), vault, { id: 'ada', wrappingSecret: wrapping.secret }, signers).open();
    expect(journal.attempts.at(-1)).toEqual(expect.objectContaining({
      spent: { nonce: note.nonce, token: TOKEN, value: 1_000n }, further: [{ nonce: second.note.nonce, token: TOKEN, value: 500n }], step: 'merge', amount: 0n,
    }));

    /* ---- the merged note pays a person neither note could: read from the pool as advanced, nothing rebuilt ---- */
    const run = await anApprovedRun(vault, 1_200n);
    const order = run.order();
    const paid = await payPrivatelyFromCompanyVault(doors, { order, payment: order.payments[0]!, notes: [merged.kept] });
    expect(paid.spent).toBe(merged.kept.nonce);
    expect(accountLedgerOf(chain.contract(company)).movements.member(accountCircuits.paidMovementOf(fromHex(run.leaf)))).toBe(true);
    expect((await poolOf()).notes.map((n) => n.value)).toEqual([300n]);
  });

  it('A MERGE WHOSE BUILD KEEPS A COIN WORTH LESS THAN THE NOTES IT SPENDS IS NOT SENT, AND THE VAULT AND ITS POOL ARE UNCHANGED', async () => {
    const { vault } = await aFundedVault();
    const doors = {
      ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, account: readAccountAddress(company)!,
      onChain: walletReads, builder: builder(), inFlight: paymentsInFlight(),
    };
    await depositIntoCompanyVault({ ...doors, company: LABEL, pay: wallet, inFlight: inFlightInMemory() }, vault, { token: TOKEN, value: 500n });
    const poolOf = async () => new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).load(vault);
    const before = (await poolOf()).notes;
    const named = before.map((n) => ({ nonce: n.nonce, token: n.token, value: n.value.toString() }))
      .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
    /*
     * The stand-in builds the merge with the ledger's own call builder, then hands back the coin it keeps for the vault
     * worth one less than the notes: the real ledger never builds that, so only this shows the build's own check holds.
     */
    const short = builder({
      createUnprovenCallTxFromInitialStates: async (...args: any[]) => {
        const built = await (contracts as any).createUnprovenCallTxFromInitialStates(...args);
        if (args[1]?.circuitId !== 'mergeNotes') return built;
        const next = built.private.nextZswapLocalState;
        const outputs = [...next.outputs].map((o: any) => {
          const c = o.coinInfo;
          return o.recipient.is_left ? o : { recipient: o.recipient, coinInfo: { nonce: c.nonce, color: c.color, type: c.type, value: BigInt(c.value) - 1n } };
        });
        return { ...built, private: { ...built.private, nextZswapLocalState: { outputs } } };
      },
    });
    const applied = chain.applied.length;
    const refused = await mergeNotesInCompanyVault({ ...doors, builder: short }, { vault, notes: named }).catch((e: Error) => e);
    /* RED WHEN: a merge is sent though the coin it keeps is not worth every note it spends - the difference leaves the vault's record. */
    expect(String((refused as Error).message)).toMatch(/does not keep one coin worth every note it spends/u);
    expect(chain.applied.length).toBe(applied);
    expect((await poolOf()).notes).toEqual(before);
  });

  /*
   * ---- A RUN DRAWN, RAISED AND APPROVED ON A SIGNER'S DEVICE, AND PAID FROM THE VAULT ----
   *
   * WHAT IS A STAND-IN, SAID HERE:
   *   · the people the device believes are handed to it as they are once invited, accepted and admitted on devices
   *     (that is driven in `src/server/a-leg-is-raised-on-the-device.test.ts`), each with an address their own keys make;
   *   · the company's first state, signed by the founding seat's filing key, is kept here rather than filed;
   *   · the device's proving of the raise is building the account's own `propose` call from the founding signer's
   *     private state with exactly the order the device made; the approval is the founding signer's own `approve` call, after the
   *     approving device opened the proposal and ran every raise check on it;
   *   · the vault's private money is not asked before the raise: the payment itself refuses what the vault cannot pay;
   *   · the company's ceilings are none (`policy`), and who the account records paid is read straight off this chain's
   *     account (`paidAmong`, and the wallet's `payments.read`), as the person's own wallet reads it; `paidYet` is never
   *     asked, because a private leg is not paid publicly;
   *   · what the account holds under its map of roles (a vault's spending-policy marker, its policy's commitment, and
   *     each period's marks and total) is read by the wallet's own reader of the account's state (`rolesInAccountState`)
   *     over this chain's account, without the wallet's ask and answer between the page and the wallet
   *     (`spendingPolicies.onChain`); the ask and its answer are driven in `wallet-records-key.test.ts` and
   *     `company-label-on-chain.test.ts`;
   *   · the company's records of a vault's spending policy are kept in a list here, each version signed by the seat that
   *     filed it as the product's records mount signs one (`spendingPolicies.versions` and `file`): no product code
   *     reads or files them yet;
   *   · that the approving device refuses what the raise checks refuse is pinned in
   *     `src/server/a-leg-is-raised-on-the-device.test.ts`, not here: here it opens a round every check passes.
   */
  const PAY_ROW: Asset = {
    code: TOKEN, symbol: 'tPAY', name: 'Test Pay', decimals: 0,
    ledger: { shielded: TOKEN, unshielded: TOKEN } as Asset['ledger'], enabled: true, sortOrder: 1,
  };
  const aPersonPaidPrivately = (n: number, name: string, amount: bigint): RosterEmployee => {
    const k = L.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
    return {
      id: `emp_${n}`, accountId: ACCOUNT_ID, name, email: `${name.toLowerCase()}@acme.example`, title: 'Eng', asset: TOKEN, baseAmount: amount,
      startDate: '2026-09-01', status: 'active', wrappingPublicKey: newWrappingKeypair().publicKey, handedOverBy: `usr_${n}`,
      admittedBy: 'ada', admittedAt: '2026-09-02T00:00:00.000Z', selfRaised: false,
      address: payeeAddressFromKeys({ coinPublicKey: k.coinPublicKey as Hex, encryptionPublicKey: k.encryptionPublicKey as Hex }, NET),
    } as unknown as RosterEmployee;
  };
  /** The company's records as the founding signer's device opens them: the directory, the people, the first state, the runs and proposals, and the wallet's read of the account. */
  const recordsHere = (people: readonly RosterEmployee[]): CompanyRecordsHere & { proposals: () => Promise<ReturnType<typeof store.listProposals>> } => {
    const registry = new StaticAssetRegistry([PAY_ROW]);
    /* One first state per company: every device reads the same blinding the founding seat signed. */
    const firstState = firstStateKept ??= signedFoundingState(ACCOUNT_ID, sealState({ entries: [] }, newStateBlinding(), viewingKey, 0), signing.secret);
    return {
      directory: () => directoryHere({
        accountId: ACCOUNT_ID, label: LABEL, filings: () => directoryFilingsFrom(api, ACCOUNT_ID),
        holders: async () => ({ ...(await walletReads()).holders, account: company as never }),
        attested: async () => attestedIn(openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey)),
      }),
      people: async () => ({ people: people.map((person) => ({ person, version: 1, handedOver: true })), notBelieved: [], notPayable: [] }) as unknown as PeopleHere,
      state: async (id) => (id === '0' ? firstState : null),
      runs: async () => store.listRuns(ACCOUNT_ID),
      proposals: async () => store.listProposals(ACCOUNT_ID),
      registry,
      payments: {
        paidOnceOf: accountCircuits.paidOnceOf, paidMovementOf: accountCircuits.paidMovementOf,
        /* What the person's own wallet reads off the account: the entries it holds, its open proposals, how many entries in all. */
        read: async (entries) => {
          const l = accountLedgerOf(chain.contract(company));
          const key = accountCircuits.payKeyCommitmentKey();
          return {
            payKeyCommitment: l.signerRoles.member(key) ? hex(l.signerRoles.lookup(key)) : null,
            held: entries.filter((e) => l.movements.member(fromHex(e))),
            openRounds: [...l.openProposals].map(([id]: [Uint8Array]) => hex(id)).sort(),
            entries: Number(l.movements.size()),
          };
        },
      },
      policy: async () => ({ threshold: 1, limitsByRole: {} }) as never,
      /*
       * STAND-IN, NAMED: the company's records of a vault's spending policy are
       * the list above, each version signed by its seat's filing key. What the
       * account holds under its map of roles is the wallet's own reader of the
       * account's state over this chain (`rolesInAccountState`), with the
       * wallet's ask and answer between them left out.
       */
      spendingPolicies: {
        versions: async (id) => policyRecords.filter((r) => r.id === id),
        file: async (rec) => { policyRecords = [...policyRecords, signCompanyFiling(rec, signing.secret as Hex)]; },
        me: { signerId: hex(leafOfDevice(founder)), wrappingSecret: recordsKeypairFrom(me.companyKey).secret as Hex },
        keys: async (input) => spendingPolicyKeysOf({ accountPure: accountCircuits as never }, input),
        onChain: chainReadThroughTheWallet(async (asked) => ({ roles: rolesInAccountState(chain.contract(company).serialize(), asked) })),
      },
    };
  };
  /** The founding signer's device raising a leg: the proving is the account's own call, built from their private state with the device's order. */
  const raisingOn = (here: ReturnType<typeof recordsHere>): LegRaiseDoors => ({
    service: { ...governedCallServiceFor(api), callState: async () => ({ account: company, accountState: '', parameters: '' }) as never },
    builder: {
      governedCall: async ({ order }: { order: { run: { root: string; payees: string; opensAt: string; closesAt: string; vault: string; required?: string }; half: Record<string, string> } }) => {
        const keys = L.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
        const staged = {
          ...founder, assetId: fromHex(order.half.assetId!), assetBlinding: fromHex(order.half.assetBlinding!),
          changeAmount: BigInt(order.half.changeAmount!), changeBatchDigest: fromHex(order.half.changeBatchDigest!), proposalSalt: fromHex(order.half.proposalSalt!),
        };
        const built = await (contracts as any).createUnprovenCallTxFromInitialStates(accountZk, {
          compiledContract: accountCompiled, circuitId: 'propose', contractAddress: company, coinPublicKey: keys.coinPublicKey,
          initialContractState: asRuntime(chain.contract(company)), initialZswapChainState: new L.ZswapChainState(),
          ledgerParameters: L.LedgerParameters.initialParameters(), initialPrivateState: staged,
          args: [ZERO_32, fromHex(order.run.root), BigInt(order.run.payees), BigInt(order.run.opensAt), BigInt(order.run.closesAt), BigInt(order.run.required ?? '0'), true, fromHex(order.run.vault)],
        }, keys.encryptionPublicKey);
        return { tx: base64FromBytes(built.private.unprovenTx.serialize()) };
      },
    } as never,
    material: { signingSecret: signing.secret as Hex, blinding: hex(founder.blinding) as Hex } as never,
    accountId: ACCOUNT_ID,
    records: here,
    holdings: { held: async () => ({ of: 'held', amount: 1n << 100n }), fits: async () => ({ of: 'fits' }) } as never,
    filing: { seat: hex(leafOfDevice(founder)), keyEpoch: 0, salt: () => toHex(new Uint8Array(randomBytes(32))), newId: () => newProposalId() },
    company: { account: company, label: LABEL },
    runs: {
      detailsOf: vaultDetails, runPayload: accountCircuits.runPayload, proposalIdOf: accountCircuits.proposalIdOf, noVault: accountCircuits.noVault,
      buildRun, buildRetryRun, rootOfPayments,
    },
    assets: here.registry!,
    waitMs: 50, everyMs: 10, sleep: async () => undefined,
  });

  it('A RUN DRAWN AND RAISED ON A SIGNER\'S DEVICE AND APPROVED BY THE BAR IS PAID FROM THE VAULT, MERGING FIRST FOR THE PERSON NO TWO NOTES COVER: EVERY PERSON RECORDED PAID, EVERY STEP JOURNALLED, AND PAYING AGAIN PAYS NOBODY', async () => {
    const { vault } = await aFundedVault();
    const doors = {
      ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, account: readAccountAddress(company)!,
      onChain: walletReads, builder: builder(), inFlight: paymentsInFlight(), paidYet: async () => null,
    };
    /* The vault holds 1,000, 500 and 400: no two of them cover 1,600. */
    for (const value of [500n, 400n]) await depositIntoCompanyVault({ ...doors, company: LABEL, pay: wallet, inFlight: inFlightInMemory() }, vault, { token: TOKEN, value });
    const people = [aPersonPaidPrivately(1, 'Dana', 1_600n), aPersonPaidPrivately(2, 'Eve', 250n)];
    const here = recordsHere(people);

    /* ---- drawn on the device and filed signed by its seat ---- */
    const drawn: PayrollRun = await drawRunHere({
      api, accountId: ACCOUNT_ID, viewingKey, keyEpoch: 0, signingSecret: signing.secret as Hex, company: { account: company, label: LABEL },
      records: here, by: 'ada', registry: here.registry!,
    }, { period: '2026-10' });
    /* ---- raised on the device, and the chain holds it ---- */
    const now = Math.floor(Date.now() / 1000);
    const round = await raiseRunOnDevice(raisingOn(here), {
      runId: drawn.id, viewingKey, vault, opensAt: String(now - 600), closesAt: String(now + 3_600),
    });
    expect(round.raisedAt, 'RED WHEN: the raise the device built does not reach the chain').toBeTruthy();
    /* ---- approved by the bar: the approving device opens it and runs every raise check, then the founding signer approves ---- */
    const proposal = store.getProposal(round.id)!;
    await expect(openTheRoundHere({ ...governedCallServiceFor(api), sealedProposals: async () => store.listProposals(ACCOUNT_ID) }, ACCOUNT_ID, round.id, viewingKey, false, here))
      .resolves.toMatchObject({ vault, chainId: proposal.chainId });
    await callAccount('approve', [fromHex(proposal.chainId)], founder);

    /* ---- paid from the vault by one function, from what the device made of the records ---- */
    const paidAmong = async (leaves: readonly Hex[]) => {
      const l = accountLedgerOf(chain.contract(company));
      return { known: true, paid: leaves.filter((leaf) => l.movements.member(accountCircuits.paidMovementOf(fromHex(leaf)))) };
    };
    const leg = {
      records: here, accountId: ACCOUNT_ID, runId: drawn.id, viewingKey,
      deps: { detailsOf: vaultDetails, runPayload: accountCircuits.runPayload, proposalIdOf: accountCircuits.proposalIdOf, paidAmong },
    };
    const before = chain.applied.length;
    const done = await payAnApprovedLeg(doors as never, leg);

    /* RED WHEN: the person no two notes cover is refused, or paid before the merge that covers them. */
    expect(done.steps.map((st) => st.kind)).toEqual(['merge', 'payment', 'payment']);
    expect(chain.applied.slice(before).map((a) => [a.ok, a.error])).toEqual([[true, ''], [true, ''], [true, '']]);
    /* RED WHEN: anybody on the run is not recorded paid by the account: each leaf the device made, recorded once. */
    expect([...done.paid].sort()).toEqual([0, 1]);
    const raised = openSealedRun(store.listRuns(ACCOUNT_ID).find((r) => r.id === drawn.id)!, viewingKey);
    const leaves = Object.values(raised.payout ?? {}).flatMap((l) => [...l!.leaves]);
    expect(leaves).toHaveLength(2);
    expect((await paidAmong(leaves as Hex[])).paid).toEqual(leaves);
    /* RED WHEN: a step is sent without being written down first: the merge as a merge, then each person's payment. */
    const journal = await new PaymentJournalInStore(records('payment-journal'), vault, { id: 'ada', wrappingSecret: wrapping.secret }, signers).open();
    expect(journal.attempts.map((a) => [a.step, a.amount])).toEqual([['merge', 0n], ['payment', 1_600n], ['payment', 250n]]);
    /* The pool follows the chain: one note left, worth what nobody was paid. */
    const pool = await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).load(vault);
    expect(pool.notes.map((n) => n.value)).toEqual([50n]);

    /* ---- paying again pays nobody ---- */
    const again = await payAnApprovedLeg(doors as never, leg);
    /* RED WHEN: a person the account records paid is paid, or anything is sent, a second time. */
    expect(again).toMatchObject({ paid: [], sentNotNamed: [], alreadyPaid: [0, 1], steps: [] });
    expect(chain.applied.length).toBe(before + 3);
  });

  /*
   * ---- A VAULT'S SPENDING POLICY SET FROM A DEVICE, AND RUNS FROM THAT VAULT RAISED, APPROVED, CHARGED AND PAID ----
   *
   * WHAT IS A STAND-IN, SAID HERE, beyond what is said above:
   *   · the policy's governance calls are built by the device's own worker (`governedCall`) from the founding signer's
   *     private state and filed, approved and carried out through the product's own routes; what the account's state is
   *     when the service hands it to the device to build a call on (`callState`), the bars it counts approvals against
   *     (`bars`) and the proposals it serves (`sealedProposals`) are read here straight off this chain and the store;
   *   · the company has one seat, so the second device is a second device of the same signer, made afresh: its own
   *     worker, its own reads of the company's records, nothing kept on it, and it never set the policy;
   *   · each run is approved by the founding signer's own `approve` call, with the run's opening, after the approving
   *     device opened it from the company's records and ran every raise check on it.
   */
  const DAY = 86_400n;
  /* Four bands of one approval each - the company has one signer - a limit of 2,000 a period, and a period ending in two hours. */
  const policyTermsAt = (now: bigint) => ({
    bands: ['1000', '10000', '100000', '1000000'].map((ceiling) => ({ ceiling, approvals: '1' })),
    periodLimit: '2000', periodStart: String(now + 7_200n - 30n * DAY), periodLength: String(30n * DAY),
  });
  /** The founding signer's device setting a policy: the governance doors over the product's routes and this chain. */
  const governingOn = (here: ReturnType<typeof recordsHere>) => ({
    service: {
      ...governedCallServiceFor(api),
      callState: async () => ({
        account: company, blockHash: '00'.repeat(32), accountState: base64FromBytes(chain.contract(company).serialize()),
        parameters: base64FromBytes(L.LedgerParameters.initialParameters().serialize()),
      }),
      bars: async () => {
        const l = accountLedgerOf(chain.contract(company));
        return { threshold: Number(l.threshold), vaultThresholds: [...l.thresholds].map(([k, v]: [Uint8Array, bigint]) => ({ vault: hex(k), threshold: Number(v) })) };
      },
      sealedProposals: async () => store.listProposals(ACCOUNT_ID),
    },
    builder: builder(),
    material: { signingSecret: hex(founder.secretKey), blinding: hex(founder.blinding), scope: hex(founder.scope) },
    accountId: ACCOUNT_ID, records: here,
    filing: { seat: hex(leafOfDevice(founder)), keyEpoch: 0, salt: () => toHex(new Uint8Array(randomBytes(32))), newId: () => newProposalId() },
    approvers: pacing.approvers, vaultName: (v: Hex) => v, sleep: async () => {}, waitMs: 50, everyMs: 1,
  });
  /** A second device of the signer: its own worker, its own reads, its own store for a charge on its way, and the routes. */
  const aSecondDevice = () => ({
    ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, account: readAccountAddress(company)!,
    onChain: walletReads, builder: builder(), inFlight: paymentsInFlight(), paidYet: async () => null,
    charge: (id: string, body: { tx: string }) => governedCallServiceFor(api).charge!(id, body),
    chargesInFlight: sealedOnThisDevice<ChargeInFlight>(inFlightRecordsInMemory(), { signerId: 'ada', wrappingSecret: newWrappingKeypair().secret }, 'charge'),
  });
  const paidAmongNow = async (leaves: readonly Hex[]) => {
    const l = accountLedgerOf(chain.contract(company));
    return { known: true, paid: leaves.filter((leaf) => l.movements.member(accountCircuits.paidMovementOf(fromHex(leaf)))) };
  };
  /** A run drawn on the founding signer's device for `people` and raised there in `[opensAt, closesAt)`. */
  const drawnAndRaised = async (people: readonly RosterEmployee[], period: string, vault: Hex, opensAt: bigint, closesAt: bigint) => {
    const here = recordsHere(people);
    const drawn: PayrollRun = await drawRunHere({
      api, accountId: ACCOUNT_ID, viewingKey, keyEpoch: 0, signingSecret: signing.secret as Hex, company: { account: company, label: LABEL },
      records: here, by: 'ada', registry: here.registry!,
    }, { period });
    const round = raiseRunOnDevice(raisingOn(here), { runId: drawn.id, viewingKey, vault, opensAt: String(opensAt), closesAt: String(closesAt) });
    return { drawn, round };
  };
  /** Approved: the approving device opens it and runs every raise check, then the founding signer approves it with its opening. */
  const approved = async (roundId: string, here: CompanyRecordsHere, vault: Hex) => {
    const proposal = store.getProposal(roundId)!;
    const opened = await openTheRoundHere({ ...governedCallServiceFor(api), sealedProposals: async () => store.listProposals(ACCOUNT_ID) },
      ACCOUNT_ID, roundId, viewingKey, false, here);
    await callAccount('approve', [fromHex(proposal.chainId)], {
      ...founder, runOpenings: { [proposal.chainId]: { payload: fromHex(opened.digest), vault: fromHex(vault), salt: fromHex(opened.salt) } },
    } as never);
    return proposal;
  };

  it('A SPENDING POLICY SET FROM ONE DEVICE: A RUN RAISED AT ITS BAND, APPROVED, CHARGED ON A SECOND DEVICE THAT DID NOT SET IT, AND PAID; A RUN ACROSS THE PERIOD\'S END REFUSED AT RAISE, AND A RUN PAST THE PERIOD\'S LIMIT REFUSED BEFORE ANY FEE', async () => {
    const { vault } = await aFundedVault();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const dana = aPersonPaidPrivately(1, 'Dana', 600n);
    const fay = aPersonPaidPrivately(3, 'Fay', 1_500n);

    /* ---- the policy, set from the founding signer's device: raised, approved and carried out through the routes ---- */
    const set = await setSpendingPolicyOnDevice(governingOn(recordsHere([dana])) as never, { viewingKey, vault, asset: TOKEN as never, terms: policyTermsAt(now) });
    /* RED WHEN: a policy cannot be set from a device - nothing in the product would write one. */
    expect(set.state).toBe('done');
    /* The second device reads it from the company's records and the chain, having set nothing. */
    const second = recordsHere([dana, fay]);
    const read = await spendingPolicyHere({ records: second, accountId: ACCOUNT_ID, viewingKey }, { vault, asset: TOKEN as never });
    /* RED WHEN: the record the setting device filed cannot be opened on another device against what the chain holds. */
    expect(read.state).toBe('set');

    /* ---- a run of 600, raised at its band ---- */
    const first = await drawnAndRaised([dana], '2026-10', vault, now - 600n, now + 3_600n);
    const round = await first.round;
    const raised = openSealedRun(store.listRuns(ACCOUNT_ID).find((r) => r.id === first.drawn.id)!, viewingKey);
    const leg = Object.values(raised.payout ?? {})[0]!;
    /*
     * RED WHEN: a run from a policy vault is raised needing no approvals of its
     * band - the charge then refuses it after its approvals. Every band here
     * needs one, as the company has one seat, so which band is chosen is not
     * measured here: that is src/server/a-leg-is-raised-on-the-device.test.ts's.
     */
    expect(leg.required).toBe(1n);
    expect(store.getProposal(round.id)!.digest).toBe(hex(accountCircuits.runPayload(fromHex(leg.root), leg.payees, leg.opensAt, leg.closesAt, 1n)));
    await approved(round.id, second, vault);

    /* ---- charged and paid on the second device ---- */
    const device = aSecondDevice();
    const legHere = {
      records: second, accountId: ACCOUNT_ID, runId: first.drawn.id, viewingKey,
      deps: { detailsOf: vaultDetails, runPayload: accountCircuits.runPayload, proposalIdOf: accountCircuits.proposalIdOf, paidAmong: paidAmongNow },
    };
    const before = chain.applied.length;
    const done = await payAnApprovedLeg(device as never, legHere);
    /* RED WHEN: a run from a policy vault is paid without being charged, or charged after its payment. */
    expect(done.steps.map((st) => st.kind)).toEqual(['charge', 'payment']);
    expect(done.steps[0]).toEqual({ kind: 'charge', spentBefore: 0n });
    expect(chain.applied.slice(before).map((a) => [a.ok, a.error])).toEqual([[true, ''], [true, '']]);
    expect(done.paid).toEqual([0]);
    expect((await paidAmongNow([...leg.leaves] as Hex[])).paid).toEqual([...leg.leaves]);
    /* RED WHEN: the period's total is kept anywhere or not what the chain charged: any device works it out again as 600. */
    if (read.state !== 'set') throw new Error('the policy was not read');
    const period = periodOf(read.policy, { opensAt: leg.opensAt, closesAt: leg.closesAt })!;
    expect(await periodTotalHere({ ...aSecondDevice(), records: second, accountId: ACCOUNT_ID, viewingKey }, { vault, asset: TOKEN, period })).toBe(600n);
    /* Paying again charges nothing and pays nobody. */
    const again = await payAnApprovedLeg(aSecondDevice() as never, legHere);
    /* RED WHEN: paying a run that has paid everybody sends anything - a charge the chain refuses after a fee, or a payment. */
    expect(again).toMatchObject({ paid: [], steps: [] });
    expect(chain.applied.length).toBe(before + 2);

    /* ---- a run whose window crosses the period's end is refused at raise ---- */
    const filed = store.listProposals(ACCOUNT_ID).length;
    const across = await drawnAndRaised([fay], '2026-11', vault, now - 600n, now + 10_000n);
    /* RED WHEN: a run whose window lies in no single period is raised - its approvals and fees are spent on a run no charge can clear. */
    await expect(across.round).rejects.toThrow(/period/u);
    expect(store.listProposals(ACCOUNT_ID).length).toBe(filed);
    expect(chain.applied.length).toBe(before + 2);

    /* ---- a run that takes the period past its limit is refused before any fee ---- */
    await depositIntoCompanyVault({ ...aSecondDevice(), company: LABEL, pay: wallet, inFlight: inFlightInMemory() }, vault, { token: TOKEN, value: 2_000n });
    const past = await drawnAndRaised([fay], '2026-12', vault, now - 600n, now + 3_600n);
    const pastRound = await past.round;
    await approved(pastRound.id, second, vault);
    const sentBefore = chain.applied.length;
    /* RED WHEN: a run past the period's limit is charged or paid - the chain refuses the charge after a fee, or the vault pays past its limit. */
    await expect(payAnApprovedLeg(aSecondDevice() as never, { ...legHere, runId: past.drawn.id })).rejects.toThrow(/past its limit for the period/u);
    expect(chain.applied.length).toBe(sentBefore);
  });

  it('A PAYMENT NO ONE NOTE COVERS DRAWS ON TWO OF THE VAULT\'S NOTES, AND THE SERVICE PAYS ITS FEE AS THE VAULT\'S OWN COINS', async () => {
    const { vault } = await aFundedVault();
    const doors = {
      ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, account: readAccountAddress(company)!,
      onChain: walletReads, builder: builder(), inFlight: paymentsInFlight(),
    };
    await depositIntoCompanyVault({ ...doors, company: LABEL, pay: wallet, inFlight: inFlightInMemory() }, vault, { token: TOKEN, value: 500n });
    const run = await anApprovedRun(vault, 1_200n);
    const order = run.order();
    const before = chain.applied.length;
    /* RED WHEN: the fee payer refuses a payment that spends two of the vault's coins, which the contract and the planner allow. */
    await payPrivatelyFromCompanyVault(doors, { order, payment: order.payments[0]! });
    expect(chain.applied.slice(before).map((a) => [a.ok, a.error])).toEqual([[true, '']]);
    expect(arrivals.at(-1)).toBe('proven-moving-the-vaults-own-coins');
    expect(accountLedgerOf(chain.contract(company)).movements.member(accountCircuits.paidMovementOf(fromHex(run.leaf)))).toBe(true);
    const pool = await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).load(vault);
    expect(pool.notes.map((n) => n.value)).toEqual([300n]);
  });

  it('THE SAME PERSON IS NOT OFFERED TWICE, AND A SECOND PAYMENT BUILT ANYWAY IS REFUSED BY THE ACCOUNT', async () => {
    const { vault } = await aFundedVault();
    const run = await anApprovedRun(vault, 100n);
    const doors = { ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, account: readAccountAddress(company)!, onChain: walletReads, builder: builder(), inFlight: paymentsInFlight() };
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
      ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, account: readAccountAddress(company)!, onChain: walletReads, builder: builder(),
      inFlight: paymentsInFlight(),
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
      events: await builder().eventsOf({
        transactionHash: (await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers).load(vault)).notes[0]!.createdIn!,
        indexer: { indexerUri: 'https://indexer.example/api/v3/graphql', indexerWsUri: 'wss://indexer.example/api/v3/graphql/ws' },
      }),
      chain: chainNow,
      /* The vault's secret, read back from the company's records and opened on this device, as a payment out opens it. */
      secret: await theSecretReadBack(vault),
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
      .toEqual([`${company}/recordPaymentFromVault`, `${vault}/payout`].sort());
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
  const holdingPublicly = async (vault: Hex, amount: bigint, token: Hex = PUBLIC_TOKEN) => {
    const keys = L.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
    const built = await (contracts as any).createUnprovenCallTxFromInitialStates(vaultZk, {
      compiledContract: vaultCompiled({ noteToSpend: () => { throw new Error('nothing here spends'); }, nonceSecret: () => { throw new Error('nothing here spends'); } }),
      circuitId: 'depositUnshielded', contractAddress: vault, coinPublicKey: keys.coinPublicKey,
      initialContractState: asRuntime(chain.contract(vault)),
      initialZswapChainState: new L.ZswapChainState(),
      ledgerParameters: L.LedgerParameters.initialParameters(),
      args: [fromHex(token), amount],
    }, keys.encryptionPublicKey);
    const r = chain.apply(built.private.unprovenTx);
    if (!r.ok) throw new Error(`the chain refused the public deposit: ${r.error}`);
    chain.applied.pop();
  };
  const publicBalance = (vault: Hex, token: Hex = PUBLIC_TOKEN): bigint => {
    let held = 0n;
    for (const [type, value] of chain.contract(vault).balance) if (String(type.raw ?? '') === token) held += value;
    return held;
  };
  const USER = 'c3'.repeat(32);
  const publicDoors = (run: { leaf: Hex }) => ({
    ...pacing, service, builder: builder(), account: readAccountAddress(company)!, onChain: walletReads,
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
      .toEqual([`${company}/recordPaymentFromVault`, `${vault}/payoutUnshielded`].sort());
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
    })).rejects.toThrow(/that payee is not in the approved run/);
    /* RED WHEN: the device's public builder takes a payment the leg names private, whatever the page asked. */
    const chainNow = await service.payoutState(vault);
    const { payments: _p, ...round } = priv;
    await expect(builder().payoutPublicly({ vault, account: company, order: round, payment: priv.payments[0]!, chain: chainNow }))
      .rejects.toThrow(/^this payment is not a public one, so it is not built as one\. Nothing was built\.$/);
    expect(privateRun.order().payments.map((p) => p.paid)).toEqual([false]);

    const publicRun = await anApprovedRun(vault, 100n, { payee: unshieldedPayeeFor(USER, NET), token: PUBLIC_TOKEN });
    const pub = publicRun.order();
    const privateDoors = { ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, account: readAccountAddress(company)!, onChain: walletReads, builder: builder(), inFlight: paymentsInFlight() };
    /* RED WHEN: the device's private builder takes a payment the leg names public, whatever the page asked. */
    const { payments: _q, ...pubRound } = pub;
    await expect(builder().payout({
      vault, account: company, order: pubRound, payment: pub.payments[0]!,
      note: { nonce: '01'.repeat(32), token: PUBLIC_TOKEN, value: '1000', createdIn: '02'.repeat(32) }, events: [], chain: chainNow,
      secret: await theSecretReadBack(vault),
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

  /*
   * The payroll as the product splits it: a company with a public payee and two private ones, all paid in the
   * token, drawn onto one month's run by the payroll service, which raises it as one leg per form. Each leg's
   * material is the service's own, built into a tree by the product's own builder, then raised and approved on
   * the account here.
   */
  const aPayrollWithBothKinds = async (people: ReadonlyArray<{ name: string; amount: bigint; payee: Payee }>) => {
    const store = new MemoryStore();
    const row: Asset = {
      code: TOKEN, symbol: 'tPAY', name: 'Test Pay', decimals: 0,
      ledger: { shielded: TOKEN, unshielded: TOKEN } as Asset['ledger'], enabled: true, sortOrder: 1,
    };
    const registry = new StaticAssetRegistry([row]);
    const holdings = { held: async () => ({ of: 'held' as const, amount: 1n << 100n }), fits: async () => ({ of: 'fits' as const }) };
    const accounts = new AccountService(store, new SimulatedLedger(MidnightCommitments), MidnightCommitments, registry, holdings as never);
    const invites = new RecordingInviteDelivery();
    const payroll = new PayrollService(store, accounts, registry, NET, invites);
    store.putUser({
      id: 'usr_founder', email: 'founder@acme.example', name: 'founder', keyBundle: null,
      keyBundleVersion: 0, identityPublicKey: null, walletKey: null, createdAt: '2026-09-25T00:00:00.000Z',
    } as unknown as User);
    const created = await accounts.create('Acme', [{ name: 'Ada', role: 'admin', userId: 'usr_founder' }], 1, undefined, drawCompanyLabel());
    const viewingKey = created.viewingKey;
    const companyId = created.account.id;
    /* Each person hired through the ordinary invitation, handing over their own address from their own device. */
    for (const { name, amount, payee } of people) {
      const user = `usr_${name.toLowerCase()}`;
      const { sentTo } = payroll.invite(companyId, { name, email: `${name.toLowerCase()}@acme.example`, title: 'Eng', asset: TOKEN, baseAmount: amount }, viewingKey, 'usr_founder');
      const invite = invites.tokenFor(sentTo!);
      store.putUser({
        id: user, email: sentTo, name: name.toLowerCase(), keyBundle: null, keyBundleVersion: 0, identityPublicKey: null,
        walletKey: null, createdAt: '2026-09-25T00:00:00.000Z',
      } as unknown as User);
      const handover = sealHandover({ wrappingPublicKey: newWrappingKeypair().publicKey, address: payee.bech32, confirmation: null },
        store.getAccount(store.getInvite(invite)!.accountId)!.inboxPublicKey);
      payroll.acceptInvite(invite, handover, user);
      const pending = store.listEmployees(companyId).find((e) => payroll.person(e.id, viewingKey)!.name === name)!;
      payroll.admit(pending.id, viewingKey, 'usr_founder');
    }
    const { run } = await payroll.createRunFromRoster(companyId, '2026-09', viewingKey);
    return { payroll, run, viewingKey };
  };

  /** One leg of the product's run, built by the product's own builder from the payroll service's own material, raised and approved on the account. */
  const aRaisedLeg = async (
    vault: Hex, inputs: Awaited<ReturnType<PayrollService['runMaterialInputs']>>, changeSeed: number,
  ) => {
    const token = inputs.asset as Hex;
    const amounts = inputs.facts.map((f) => f.amount);
    const run = buildRun(inputs.seeds, {
      accountId: inputs.accountId, runId: inputs.runId, epoch: inputs.epoch ?? currentPayoutSeed(inputs.seeds).epoch,
    }, inputs.facts, vaultDetails, inputs.pay, token);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const window = { from: now - 600n, until: now + 3_600n };
    const c = change(0n, changeSeed);
    const idFrom = (leaves: Hex[], w: { from: bigint; until: bigint }) => toHex(accountCircuits.proposalIdOf(
      accountCircuits.runPayload(fromHex(rootOfTestLeaves(leaves, amounts, fromHex(token))), BigInt(leaves.length), w.from, w.until, 0n), fromHex(vault), c.salt));
    const id = idFrom(run.tree.leaves, window);
    const staged = { ...founder, assetId: c.asset, changeAmount: c.amount, changeBatchDigest: c.batch, proposalSalt: c.salt };
    await callAccount('propose', [ZERO_32, fromHex(run.tree.root), run.tree.payees, window.from, window.until, 0n, true, fromHex(vault)], staged);
    await callAccount('approve', [fromHex(id)], founder);
    const paidNow = () => new Set(run.tree.leaves.filter((leaf) =>
      accountLedgerOf(chain.contract(company)).movements.member(accountCircuits.paidMovementOf(fromHex(leaf)))));
    const order = () => {
      const out = assemblePrivatePayments({
        order: {
          asset: token, form: inputs.form, vault, proposal: id, salt: toHex(c.salt), root: run.tree.root,
          payees: run.tree.payees, opensAt: window.from, closesAt: window.until,
        },
        leaves: run.tree.leaves, window, idFrom, built: run, facts: inputs.facts, paid: paidNow(),
      });
      if ('refusal' in out) throw new Error(out.refusal);
      return out.order;
    };
    return { order, leaves: run.tree.leaves as Hex[], leaf: run.tree.leaves[0]! as Hex };
  };

  /*
   * A PAYROLL WITH BOTH KINDS OF PAYEE, IN ONE TOKEN: one run pays one token in
   * one form, so the product raises it as two runs side by side, each approved
   * on its own, and every person is paid exactly once: the private run
   * privately out of the vault's notes, the public run publicly out of its
   * balance. The split is the payroll service's own, not one made here.
   */
  it('A PAYROLL WITH BOTH KINDS OF PAYEE IS TWO RUNS, AND EVERY PERSON IS PAID: THE PRIVATE RUN PRIVATELY, THE PUBLIC RUN PUBLICLY', async () => {
    const { vault } = await aFundedVault();
    /* The same token, held publicly too. */
    await holdingPublicly(vault, 1_000n, TOKEN);
    expect(publicBalance(vault, TOKEN)).toBe(1_000n);
    const keys = L.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
    const privatePayee = payeeAddressFromKeys({ coinPublicKey: keys.coinPublicKey as Hex, encryptionPublicKey: keys.encryptionPublicKey as Hex }, NET);
    const publicPayee = unshieldedPayeeFor(USER, NET);
    const mixed = [{ payee: privatePayee, token: TOKEN, amount: 250n }, { payee: publicPayee, token: TOKEN, amount: 100n }];
    /* RED WHEN one run is built over both kinds of payee, so one approval covers two kinds of money. */
    expect(() => buildRun([{ epoch: 0, seed: 'ab'.repeat(32) }], { accountId: ACCOUNT_ID, runId: 'run_both', epoch: 0 }, mixed, vaultDetails, payFor(mixed), TOKEN))
      .toThrow(/^This run has both private and public payments/);

    /* ---- the product's split: one month's run, raised as one leg per form ---- */
    /* Robin hands over a public address; Dana and Eve private ones. */
    const aPrivateAddress = () => {
      const k = L.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
      return payeeAddressFromKeys({ coinPublicKey: k.coinPublicKey as Hex, encryptionPublicKey: k.encryptionPublicKey as Hex }, NET);
    };
    const { payroll, run, viewingKey } = await aPayrollWithBothKinds([
      { name: 'Robin', amount: 100n, payee: publicPayee }, { name: 'Dana', amount: 250n, payee: aPrivateAddress() },
      { name: 'Eve', amount: 150n, payee: aPrivateAddress() },
    ]);
    const privately = runLegOf(TOKEN, 'shielded');
    const publicly = runLegOf(TOKEN, 'unshielded');
    const legs = payroll.legsOf(run.id, viewingKey);
    /* RED WHEN the payroll service draws a payroll with both kinds of payee as one run, or as anything but one leg per form. */
    expect(legs.map((l) => [l.leg, l.form, l.total]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      .toEqual([[privately, 'shielded', 400n], [publicly, 'unshielded', 100n]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    /* RED WHEN somebody is on both legs, or on neither: paid twice, or never. */
    const onALeg = legs.flatMap((l) => l.people);
    expect(onALeg.slice().sort()).toEqual(run.employees.map((e) => e.id).sort());
    expect(new Set(onALeg).size).toBe(run.employees.length);
    const privateInputs = await payroll.runMaterialInputs(run.id, viewingKey, privately);
    const publicInputs = await payroll.runMaterialInputs(run.id, viewingKey, publicly);
    expect([privateInputs.facts.map((f) => f.payee.kind), publicInputs.facts.map((f) => f.payee.kind)])
      .toEqual([['shielded', 'shielded'], ['unshielded']]);
    expect(publicInputs.facts[0]!.payee.bech32).toBe(publicPayee.bech32);

    /* ---- each leg raised and approved on its own, and every payment of each paid ---- */
    const privateRun = await aRaisedLeg(vault, privateInputs, 51);
    const publicRun = await aRaisedLeg(vault, publicInputs, 52);
    expect([privateRun.order().payments.map((p) => p.kind), publicRun.order().payments.map((p) => p.kind)])
      .toEqual([['shielded', 'shielded'], ['unshielded']]);

    const before = chain.applied.length;
    const privateDoors = () => ({
      ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, account: readAccountAddress(company)!, onChain: walletReads, builder: builder(),
      inFlight: paymentsInFlight(),
    });
    for (let i = 0; i < 2; i += 1) {
      const priv = privateRun.order();
      const next = priv.payments.find((p) => !p.paid)!;
      await payPrivatelyFromCompanyVault(privateDoors(), { order: priv, payment: next });
    }
    const pub = publicRun.order();
    await payPubliclyFromCompanyVault(publicDoors(publicRun), { order: pub, payment: pub.payments[0]! });

    /* RED WHEN any payment of either run does not reach the chain, or the chain refuses it: three people, three payments. */
    expect(chain.applied.slice(before).map((a) => [a.ok, a.error])).toEqual([[true, ''], [true, ''], [true, '']]);
    /* RED WHEN anybody on the payroll is not recorded paid: every person is paid, each by their own run's leaf. */
    const account = accountLedgerOf(chain.contract(company));
    expect([...privateRun.leaves, ...publicRun.leaves].map((leaf) => account.movements.member(accountCircuits.paidMovementOf(fromHex(leaf)))))
      .toEqual([true, true, true]);
    expect([...privateRun.order().payments, ...publicRun.order().payments].map((p) => p.paid)).toEqual([true, true, true]);
    /* The public run moved the vault's public balance of the token; the private run spent notes of it. */
    expect(publicBalance(vault, TOKEN)).toBe(900n);
    expect(vaultLedgerOf(chain.contract(vault)).payments).toBe(3n);
    /* RED WHEN a person already paid can be paid again: the account refuses a second payment of the same leaf, and nothing lands. */
    const again = privateRun.order();
    await expect(payPrivatelyFromCompanyVault(privateDoors(), { order: again, payment: again.payments[0]! })).rejects.toThrow();
    expect(chain.applied.length).toBe(before + 3);
  });

  /* ------------------------------------------- a public deposit from the page */

  /** A public token the page can offer, in a registry of its own: `PUBLIC_TOKEN` has no private form. */
  const PUBLIC_ASSET: Asset = {
    code: PUBLIC_TOKEN, symbol: 'PUBT', name: 'A public token', decimals: 0,
    ledger: { shielded: null, unshielded: PUBLIC_TOKEN } as Asset['ledger'], enabled: true, sortOrder: 1,
  };
  const PUBLIC_REGISTRY = new StaticAssetRegistry([PUBLIC_ASSET]);
  /** The depositor's wallet, paying publicly: it reads the page's ask as the product wallet does, balances through the SDK and checks what it added. */
  const aPublicWallet = async (values: readonly bigint[]) => {
    const w = await aWalletThatPaysPublicly(NET);
    const seededAt = chain.apply(w.seedTransaction(PUBLIC_TOKEN, values));
    if (!seededAt.ok) throw new Error(`the depositor's public coins were not seeded: ${seededAt.error}`);
    chain.applied.pop();
    w.holdWhatTheChainSays(chain.state.utxo.utxos);
    const asProven = { Transaction: { deserialize: (_s: string, _p: string, b: 'pre-binding', raw: Uint8Array) => L.Transaction.deserialize('signature', 'pre-proof', b, raw) } };
    const asked: Array<{ pays: string; leaves: unknown }> = [];
    const pay = async (ask: { company: Hex; vault: Hex; transaction: string }) => {
      const read = readWhatThePageAsks(asProven as never, ask.transaction, ask.vault);
      asked.push({ pays: read.pays, leaves: read.leaves });
      const paid = await w.payFor(read.tx);
      const why = whyThePublicBalancingIsNotWhatWasApproved({ baseTransaction: paid }, read.leaves[0]!, w.address);
      if (why !== null) throw new Error(why);
      return { transaction: base64FromBytes((paid as any).bind().serialize()), leaves: read.leaves };
    };
    return { wallet: w, pay, asked };
  };

  it('A COMPANY PUTS A PUBLIC TOKEN INTO ITS VAULT FROM THE PAGE: ONE PUBLIC DEPOSIT, OF THIS AMOUNT, INTO THIS VAULT, PAID FROM THE WALLET\'S OWN PUBLIC COINS', async () => {
    const { vault } = await aFundedVault();
    const { wallet, pay, asked } = await aPublicWallet([600n, 700n]);
    expect(publicBalance(vault)).toBe(0n);
    const before = chain.applied.length;
    const notesBefore = [...vaultLedgerOf(chain.contract(vault)).notes].map((c: Uint8Array) => hex(c));
    const doors = {
      ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, onChain: walletReads,
      company: LABEL, account: readAccountAddress(company)!, builder: builder(), inFlight: inFlightInMemory(),
    };

    const done = await depositFromSource(doors, vault, publicTokenFromTheWallet(pay, PUBLIC_REGISTRY), { code: PUBLIC_TOKEN, value: 900n });

    /* RED WHEN: the deposit does not reach the chain through the public deposit route, or the chain refuses it. */
    expect(chain.applied.slice(before).map((a) => [a.ok, a.error])).toEqual([[true, '']]);
    expect(arrivals.at(-1)).toBe('finished-by-the-depositor');
    expect(sent.some((b) => b.includes('"amount":"900"') && b.includes(`"token":"${PUBLIC_TOKEN}"`))).toBe(true);
    expect(done.txRef).toBe(String(chain.applied.at(-1)!.tx.identifiers()[0]));
    /* RED WHEN: the wallet is asked as for a private deposit, or is shown another token or amount. */
    expect(asked).toEqual([{ pays: 'public', leaves: [{ token: PUBLIC_TOKEN, amount: '900', kind: 'unshielded' }] }]);
    const tx = chain.applied.at(-1)!.tx;
    const named = (e: unknown) => (e instanceof Uint8Array ? new TextDecoder().decode(e) : String(e));
    /* RED WHEN: a public deposit is anything but the vault's public deposit. */
    expect([...tx.intents.values()].flatMap((i: any) => i.actions.map((a: any) => `${String(a.address).toLowerCase()}/${named(a.entryPoint)}`)))
      .toEqual([`${vault}/depositUnshielded`]);
    /* RED WHEN: the vault receives another amount, or the page's deposit is paid in the wrong section and never balances. */
    expect(publicBalance(vault)).toBe(900n);
    /* The wallet spent both coins and took 400 back as change; nobody else was paid. */
    const outs = [...tx.intents.values()].flatMap((i: any) => [
      ...(i.guaranteedUnshieldedOffer?.outputs ?? []), ...(i.fallibleUnshieldedOffer?.outputs ?? [])]);
    expect(outs.map((o: any) => [String(o.owner).toLowerCase(), String(o.value)])).toEqual([[wallet.address.toLowerCase(), '400']]);
    /* No private coin moved and the vault's notes were not touched: nothing is recorded on the device for public money. */
    expect(tx.guaranteedOffer).toBeUndefined();
    expect([...vaultLedgerOf(chain.contract(vault)).notes].map((c: Uint8Array) => hex(c))).toEqual(notesBefore);
    /* RED WHEN: the service's reader stops matching what the page and the wallet build, or takes it for another vault, token or amount. */
    const addressOf = L.addressFromKey as (o: unknown) => string;
    expect(refusalForPublicDeposit(tx, { vault, token: PUBLIC_TOKEN, amount: 900n, addressOf })).toBeNull();
    expect(refusalForPublicDeposit(tx, { vault: 'ee'.repeat(32), token: PUBLIC_TOKEN, amount: 900n, addressOf })).toMatch(/must call this vault's public deposit/);
    expect(refusalForPublicDeposit(tx, { vault, token: PUBLIC_TOKEN, amount: 901n, addressOf })).toMatch(/exactly the token and amount asked for/);
    expect(refusalForPublicDeposit(tx, { vault, token: TOKEN, amount: 900n, addressOf })).toMatch(/exactly the token and amount asked for/);
    /* And the private deposit's reader never takes it. */
    expect(refusalForDeposit(tx, { vault })).not.toBeNull();
  });

  it('A VAULT FUNDED BY A PUBLIC DEPOSIT FROM THE PAGE PAYS A PUBLIC PAYEE FROM THE PAGE', async () => {
    const { vault } = await aFundedVault();
    const { pay } = await aPublicWallet([1_000n]);
    const doors = {
      ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, onChain: walletReads,
      company: LABEL, account: readAccountAddress(company)!, builder: builder(), inFlight: inFlightInMemory(),
    };
    await depositFromSource(doors, vault, publicTokenFromTheWallet(pay, PUBLIC_REGISTRY), { code: PUBLIC_TOKEN, value: 1_000n });
    expect(publicBalance(vault)).toBe(1_000n);
    const run = await anApprovedRun(vault, 250n, { payee: unshieldedPayeeFor(USER, NET), token: PUBLIC_TOKEN });
    const order = run.order();
    const before = chain.applied.length;

    await payPubliclyFromCompanyVault(publicDoors(run), { order, payment: order.payments[0]! });

    /* RED WHEN: money a company put in publicly from the page cannot be paid out publicly from the page. */
    expect(chain.applied.slice(before).map((a) => [a.ok, a.error])).toEqual([[true, '']]);
    const outs = [...chain.applied.at(-1)!.tx.intents.values()].flatMap((i: any) => [
      ...(i.guaranteedUnshieldedOffer?.outputs ?? []), ...(i.fallibleUnshieldedOffer?.outputs ?? [])]);
    expect(outs.map((o: any) => [String(o.owner).toLowerCase(), String(o.type).toLowerCase(), o.value])).toEqual([[USER, PUBLIC_TOKEN, 250n]]);
    expect(publicBalance(vault)).toBe(750n);
    expect(run.order().payments.map((p) => p.paid)).toEqual([true]);
  });

  it('THE SERVICE SENDS NO PUBLIC DEPOSIT THAT IS NOT EXACTLY WHAT THE PAGE ASKED FOR, AND NO MONEY MOVES', async () => {
    const { vault } = await aFundedVault();
    /* One coin for each deposit the wallet pays for below, since it forgets a coin once it has paid with it. */
    const { pay } = await aPublicWallet([1_000n, 1_000n, 1_000n, 1_000n]);
    const doors = {
      ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, onChain: walletReads,
      company: LABEL, account: readAccountAddress(company)!, builder: builder(), inFlight: inFlightInMemory(),
    };
    const applied = chain.applied.length;
    const refusedBy = async (svc: VaultService) => {
      const e = await depositFromSource({ ...doors, service: svc }, vault, publicTokenFromTheWallet(pay, PUBLIC_REGISTRY), { code: PUBLIC_TOKEN, value: 300n })
        .then(() => null, (err: Error) => err.message);
      return e;
    };
    /* RED WHEN: the service sends a public deposit for another amount than the page named. */
    expect(await refusedBy({ ...service, depositPublicly: (v, tx, m) => service.depositPublicly!(v, tx, { ...m, amount: '299' }) }))
      .toMatch(/^the public deposit was not sent, so no money has moved yet\.[\s\S]*The service said: this is not this company's public deposit into this vault: it does not put exactly the token and amount asked for/);
    /* RED WHEN: the service sends a public deposit for another token than the page named. */
    expect(await refusedBy({ ...service, depositPublicly: (v, tx, m) => service.depositPublicly!(v, tx, { ...m, token: TOKEN }) }))
      .toMatch(/it does not put exactly the token and amount asked for/);
    /* RED WHEN: the service sends a deposit nobody's public money paid for: the page's own, unbalanced. */
    const theWalletPaidNothing = async (ask: { company: Hex; vault: Hex; transaction: string }) => {
      const t = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', Buffer.from(ask.transaction, 'base64')) as any;
      return { transaction: base64FromBytes(t.bind().serialize()), leaves: [{ token: PUBLIC_TOKEN, amount: '300', kind: 'unshielded' }] };
    };
    await expect(depositFromSource(doors, vault, publicTokenFromTheWallet(theWalletPaidNothing, PUBLIC_REGISTRY), { code: PUBLIC_TOKEN, value: 300n }))
      .rejects.toThrow(/nobody's public money pays for it/);
    /* RED WHEN: the service sends a private deposit's route a public one. */
    const intoThePrivateRoute = await refusedBy({ ...service, depositPublicly: (v, tx) => service.deposit(v, tx) });
    expect(intoThePrivateRoute).toMatch(/^the public deposit was not sent, so no money has moved yet\.[\s\S]*The service said: this deposit moves public money as well/);
    expect(chain.applied.length).toBe(applied);
    expect(publicBalance(vault)).toBe(0n);
  });
});

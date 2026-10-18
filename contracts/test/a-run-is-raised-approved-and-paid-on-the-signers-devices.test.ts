/**
 * **ONE RUN OF THE SIGNERS' SYSTEM, END TO END: RAISED ON A SIGNER'S DEVICE,
 * APPROVED ON ANOTHER DEVICE, CHARGED TO ITS VAULT'S PERIOD AND PAID, UNTIL THE
 * PAYMENT LANDS ON THE CHAIN.**
 *
 * What is real: the devices' raise (`raiseRunOnDevice`), approval
 * (`approveOnDevice`), charge and payment (`payAnApprovedLeg`), the compiled
 * account and vault, the service's own routes over real HTTP, and the ledger's
 * own state machine applying every transaction. The doubles are the edges: the
 * chain is held in memory, with no proof made and no fee paid; the wallets are
 * stand-ins that read the chain as a wallet does; and the service's own read of
 * the chain counts one approval more than the chain holds, so a device that
 * believed the service instead of the chain would wait for an approval that
 * never comes.
 *
 * While the run goes from raise to payment, the signers' side is given no way to
 * read who holds the contracts: every read of the account a device or the
 * service is handed leaves out the committee, its threshold and the key that
 * held the account at its deploy, and any reach for them is recorded.
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
import { vaultInState } from '../../apps/wallet/src/chain/company-label-on-chain.js';
import { holdersInAccountState, seatsInAccountState } from 'midnight-identity/profile/account-state';
import {
  directoryBelievedOver, directoryChainOver, directoryHereOver, fileOwnEntry, judgeOver, madeForTheWallet, mayFileUnderOver, walletReadsOver,
} from './the-chain-as-a-wallet-reads-it.js';
import type { SeatOpening } from '../../src/core/seat-opening.js';
import { leavesOfTheContract } from '../../src/testing/directory-seats.js';
import { seatDirectoryRoutes } from '../../src/server/seat-directory-route.js';
import { filedAsIn, recordManifestRoutes } from '../../src/server/record-manifest-route.js';
import { MemoryCompanyRecordStore } from '../../src/server/company-records-route.js';
import { companyRecordEntry } from '../../src/midnight/record-manifest.js';
import { manifestServiceFor, recordsEnteredFor } from 'vaults-web-shared/record-entered-here.js';
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
import { accountDeployedIn, spendingPolicyKeysOf, type AccountDeployed } from 'vaults-web-shared/governed-call-builder.js';
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
import { attestedIn, directoryFilingsFrom, directoryHere, directoryJudge } from 'vaults-web-shared/vault-page-doors.js';
import { drawRunHere } from 'vaults-web-shared/run-drawn-here.js';
import { approveOnDevice, governedCallServiceFor, openTheRoundHere, raiseRunOnDevice, type GovernedCallDoors } from 'vaults-web-shared/governed-call-on-device.js';
import type { LegRaiseDoors } from 'vaults-web-shared/run-raised-here.js';
import type { CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import type { PeopleHere } from 'vaults-web-shared/people-on-device.js';
import { payAnApprovedLeg } from 'vaults-web-shared/leg-paid-here.js';
import { anchoredOver, headsCheckedHere, onChainOf, roundsOnATestChain } from '../../src/testing/record-tree-double.js';
import type { DirectoryChainRead } from '../../src/server/seat-directory-route.js';

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

/** Every reach for who holds the contracts, made on the signers' side while the run goes from raise to payment. */
let committeeReads: string[] = [];
/** Whether the run is under way: before it, the vault is created and handed to the committee, which is the super admins' work. */
let underWay = false;
/**
 * Every name a read here gives who holds a contract by: the committee, its
 * threshold and the committee that held the account at its deploy, in a read
 * of the account; and the maintenance authority, in a contract's state.
 */
const WHO_HOLDS = new Set(['committee', 'threshold', 'foundingCommittee', 'maintenanceAuthority']);
/**
 * A read of the account as the signers' side is handed it while the run is
 * under way: everything but who holds the contracts. A reach for that is
 * recorded and answered with nothing.
 */
/** The door the service reads a contract's state through, as `committeeReads` names it. */
const THE_SERVICES_STATE_READ = 'the service\'s read of a contract';
/**
 * A contract's state as the service is handed it while the run is under way:
 * the state itself, every part of it answered as before, with a reach for its
 * maintenance authority recorded. It is answered rather than withheld, so a
 * reach shows as a recorded read rather than as a failure somewhere else.
 */
function stateWithoutWhoHolds<T>(door: string, state: T): T {
  if (!underWay || state === null || typeof state !== 'object') return state;
  return new Proxy(state as object, {
    get(t, p) {
      if (typeof p === 'string' && WHO_HOLDS.has(p)) committeeReads.push(`${door}.${p}`);
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as T;
}
function withoutWhoHolds<T extends object>(door: string, read: T): T {
  if (!underWay) return read;
  const kept = Object.fromEntries(Object.entries(read).filter(([k]) => !WHO_HOLDS.has(k)));
  return new Proxy(kept, {
    get(t, p, r) {
      if (typeof p === 'string' && WHO_HOLDS.has(p)) { committeeReads.push(`${door}.${p}`); return undefined; }
      return Reflect.get(t, p, r);
    },
    has(t, p) {
      if (typeof p === 'string' && WHO_HOLDS.has(p)) { committeeReads.push(`${door}.${p}`); return false; }
      return Reflect.has(t, p);
    },
  }) as T;
}

describe.skipIf(!KEYS_ON_DISK)('ONE RUN, RAISED, APPROVED, CHARGED AND PAID ON THE SIGNERS\' DEVICES [needs contracts/managed-vault/keys and contracts/managed/keys; `npm run compact` then `npm run compact:vault -- --full` build them]', () => {
  let chain: Chain;
  let depositor: AWalletThatPaysPrivately;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let store: MemoryStore;
  let viewingKey: Hex;
  let company: Hex;
  /* The account as its deploy left it: the first step of its history, which a device reads how it was deployed from. */
  let deployed: { serialize(): Uint8Array };
  let words: string;
  let me: DeviceSigner;
  let founder: AccountPrivateState;
  let founderOpening: SeatOpening;
  let signing: ReturnType<typeof newSigningKeypair>;
  let wrapping: ReturnType<typeof newWrappingKeypair>;
  let sent: string[];
  let arrivals: string[];
  let temporaryKeys: Map<string, { tag: string; value: string }>;
  let serverStores: Map<WireRecord, MemorySealedPoolStore>;
  /* The company's records of every vault's spending policy, as the seats filed them. */
  let policyRecords: SealedCompanyRecord[] = [];
  /* The company's records the service keeps, as the product's records mount keeps them: what an entry is checked against. */
  let companyRecords: MemoryCompanyRecordStore;
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
    companyRecords = new MemoryCompanyRecordStore();
    firstStateKept = undefined;
    /* The depositor's wallet holds its own private coins before anything else is on the chain. */
    depositor = aWalletThatPaysPrivately(NET);
    chain.apply(depositor.seedTransaction(TOKEN, [100_000n, 100_000n, 100_000n, 100_000n]));
    chain.applied.pop();
    store = new MemoryStore();
    words = newWords().join(' ');
    /* The founding seat as the founding signer's device makes it: its leaf commits to their wallet's key for the company. */
    ({ device: founder, opening: founderOpening } = madeForTheWallet(privateStateFor(1), identityFromWords(words), LABEL));
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
      contractState: async (v) => stateWithoutWhoHolds(THE_SERVICES_STATE_READ, chain.contract(v)),
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
      /* The account alone at the same moment: what a raise of the company's proposals is built on. */
      accountCallState: async (account) => {
        const as = chain.contract(account);
        if (as === null) return null;
        return {
          blockHash: 'b1'.repeat(32), accountState: base64FromBytes(as.serialize()), parameters: base64FromBytes(chain.state.parameters.serialize()),
        };
      },
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
    /* The service's own read of the account for its directory: who holds the account is left out while the run is under way. */
    const directoryChain: DirectoryChainRead = async (id, seats) => {
      const read = await directoryChainOver(() => chain.contract(company))(id, seats);
      return read === null ? null : { ...read, seats: withoutWhoHolds('the service\'s read of the account', read.seats) };
    };
    app.use(seatDirectoryRoutes({ signedIn, member, store, chain: directoryChain }));
    /*
     * The routes a run drawn and raised on a device is filed and relayed through, over this chain: the company's
     * directory as the service reads it, and the account's open proposals and approvals as the chain holds them. A
     * raise is relayed by applying it to this chain. The vault's public money is not asked here: a private leg spends none.
     */
    const directoryNow = (id: string) => directoryOf(store, directoryChain, id);
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
            assets: [], vaultThresholds: [], signerCount: Number(l.signerLeaves.size()), threshold: Number(l.threshold),
            openProposals: [...l.openProposals].map(([id, c]: [Uint8Array, Uint8Array]) => ({
              id: hex(id) as Hex, change: hex(c) as Hex, approvals: Number(l.approvalCounts.member(id) ? l.approvalCounts.lookup(id) : 0n) + (underWay ? 1 : 0),
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
    /* The company's proposals as the service lists them, where a vault's start finds its own. */
    app.get('/api/accounts/:id/proposals', signedIn, member, (req, res) => { res.json(store.listProposals(String(req.params.id))); });
    app.use(companyVaultRoutes({
      signedIn, member, store,
      company: async () => ({
        address: company, threshold: 1, vaultThresholds: [],
        seats: Number(accountLedgerOf(chain.contract(company)).signerLeaves.size()),
      }),
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
      mayFileUnder: mayFileUnderOver(store, directoryChain),
    });
    /* The company's records: every filing entered and every header kept, as the whole server serves them. */
    app.use(recordManifestRoutes({
      signedIn, member, store, directoryOf: directoryNow,
      filedAs: filedAsIn({
        company: companyRecords,
        vault: { of: (r) => serverStores.get(r)! },
        runs: (c) => store.listRuns(c), proposals: (c) => store.listProposals(c),
      }),
    }));
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
  /* The page's one filing call over the service's own manifest route, signed by this device's seat. */
  const enteredThrough = () => recordsEnteredFor(manifestServiceFor(api), ACCOUNT_ID, signing.secret as Hex);
  /* Who filed each version, judged afresh for every read: the directory read again and the account read off the chain. */
  const records = (record: WireRecord) => new HttpSealedPoolStore(record, wire, signing.secret, directoryJudge({
    accountId: ACCOUNT_ID, label: LABEL, viewingKey, filings: () => directoryFilingsFrom(api, ACCOUNT_ID),
    holders: async () => withoutWhoHolds('a device\'s read of the account', { ...holdersRead(), account: company as never }),
    attested: async () => attestedIn(openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey)),
    anchored: anchoredOver(api, ACCOUNT_ID, () => onChainOf([], { approvals: 1, seats: [] }, deployRead())),
    leaves: leavesOfTheContract,
  }), enteredThrough());
  /* Who holds the company and which vaults it adopted, as the signer's own wallet reads them off the chain for each step. */
  /** Who holds the company, its seats and the vaults it adopted, as the signer's own wallet reads them off the chain. */
  const holdersRead = () => {
    const at = deployRead();
    if (at === null) throw new Error('the account\'s history does not open with its deploy, so its founding seat cannot be said');
    return { ...holdersInAccountState(chain.contract(company).serialize(), hex(accountCircuits.policyBarKey())), founding: at.seats[0]!, foundingCommittee: at.committee };
  };
  /**
   * How the account was deployed, read as a device reads it from the account's history at the indexer its wallet
   * names (`accountDeployedIn`): the deploy's state first, then the state the account holds now, the seats read the one
   * way a wallet reads them. What the directory judges the founding seat by (`foundingSeatHere`), never a stand-in.
   */
  const deployRead = (): AccountDeployed | null => accountDeployedIn({ runtimeState: (runtime as any).ContractState }, [
    { kind: 'deploy', state: deployed.serialize() }, { kind: 'call', state: chain.contract(company).serialize() },
  ], seatsInAccountState);
  const walletReads = async () => ({ holders: withoutWhoHolds('the wallet\'s read of the account', holdersRead()) });
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
      /* Where the vault's adoption and first secret run are written down, by the founding seat under its own filing key. */
      proposals: (({ callState, send, file, sealedProposals }) => ({
        accountId: ACCOUNT_ID, companyKeys: viewingKey, signingSecret: signing.secret as Hex,
        directory: directoryHereOver({ viewingKey,
          api, accountId: ACCOUNT_ID, label: LABEL, account: company, accountState: () => chain.contract(company), deployed: () => deployed,
          roster: async () => openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey),
        }),
        entered: recordsEnteredFor(manifestServiceFor(api), ACCOUNT_ID, signing.secret as Hex),
        service: { callState, send, file: file!, sealedProposals: sealedProposals! },
      }))(governedCallServiceFor(api)),
      secretReaders: {
        company: LABEL,
        read: async (v: Hex) => ({
          ...seatsInAccountState(chain.contract(company).serialize()),
          vault: vaultInState(v as never, chain.contract(v).serialize()),
        }),
        roster: async () => rosterVaultKeys(openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey)),
        /* Each reader's seat's opening, from the company's directory as this device believes it. */
        directory: directoryBelievedOver({ viewingKey,
          api: api, accountId: ACCOUNT_ID, label: LABEL, account: company, accountState: () => chain.contract(company), deployed: () => deployed,
          roster: async () => openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey),
        }),
      },
    }, resume as never);
    /* The founding signer's own directory entry, filed from their device: the account is the committee's from its first transaction. */
    await fileOwnEntry({ viewingKey, signingSecret: signing.secret,
      api, accountId: ACCOUNT_ID, person: 'ada', identity: identityFromWords(words), label: LABEL, account: company,
      companyKey: me.companyKey, signingKey: signing.publicKey, seat: hex(leafOfDevice(founder)), opening: founderOpening, founding: hex(leafOfDevice(founder)),
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
  /* Where each proposal stands, as the wallet's indexer shows this file's chain to every device: each proposal the account holds, with its approvals. */
  /** The head of the company's records every device here says it checked. */
  const A_HEAD = '1c'.repeat(32) as Hex;
  const watching = roundsOnATestChain(async () => {
    const l = accountLedgerOf(chain.contract(company));
    return [...l.openProposals].map(([id]: [Uint8Array]) => ({ id: hex(id), approvals: Number(l.approvalCounts.member(id) ? l.approvalCounts.lookup(id) : 0n) }));
  });
  const recordsHere = (people: readonly RosterEmployee[]): CompanyRecordsHere & { proposals: () => Promise<ReturnType<typeof store.listProposals>> } => {
    const registry = new StaticAssetRegistry([PAY_ROW]);
    /* One first state per company: every device reads the same blinding the founding seat signed. */
    const firstState = firstStateKept ??= signedFoundingState(ACCOUNT_ID, sealState({ entries: [] }, newStateBlinding(), viewingKey, 0), signing.secret);
    return {
      directory: (asked) => directoryHere({
        accountId: ACCOUNT_ID, label: LABEL, viewingKey, filings: () => directoryFilingsFrom(api, ACCOUNT_ID),
        holders: async () => withoutWhoHolds('a device\'s read of the account', { ...holdersRead(), account: company as never }),
        attested: async () => attestedIn(openAccount(store.getAccount(ACCOUNT_ID)!, viewingKey)),
        leaves: leavesOfTheContract,
        /*
         * The company's records over the service's own manifest route, after the batch the founding device anchored
         * while its seat was the account's only one: its entry and its first state.
         */
        anchored: anchoredOver(api, ACCOUNT_ID, undefined, undefined, {
          seat: hex(leafOfDevice(founder)), signingSecret: signing.secret as Hex, records: [firstState],
          committee: [committeeKeyFor(identityFromWords(words), LABEL)], directory: store.directoryFilingsOf(ACCOUNT_ID).slice(0, 1),
          deployed: deployRead(),
        }),
      }, asked),
      people: async () => ({ people: people.map((person) => ({ person, version: 1, handedOver: true })), notBelieved: [], notPayable: [] }) as unknown as PeopleHere,
      state: async (id) => (id === '0' ? firstState : null),
      runs: async () => store.listRuns(ACCOUNT_ID),
      proposals: async () => store.listProposals(ACCOUNT_ID),
      /*
       * The heads of the company's records this device checked: the raiser seals its latest, an approver approves over one of them.
       * **A STAND-IN, NAMED**: a fixed head, not one this file's read reached; what this file proves is the payment, not
       * which head a run is raised over.
       */
      checked: async () => headsCheckedHere(A_HEAD),
      roundsOnChain: watching,
      registry,
      roundIdentity: accountCircuits,
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
        /* Filed as the product's records mount files one: kept, then entered in the company's records by this device's seat. */
        file: async (rec) => {
          const signed = signCompanyFiling(rec, signing.secret as Hex);
          policyRecords = [...policyRecords, signed];
          await companyRecords.put(signed);
          await enteredThrough().enter([companyRecordEntry(signed)]);
        },
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
      retrySaltOf: accountCircuits.retrySaltOf, buildRun, buildRetryRun, rootOfPayments,
    },
    assets: here.registry!,
    waitMs: 50, everyMs: 10, sleep: async () => undefined,
    /* The filings entered where this file watches them, and the anchor recorded, never proved here. */
    recorded: { entered: enteredThrough(), anchor: async () => ({ anchored: 0, head: '00'.repeat(32) }) },
  });


  /*
   * ---- A VAULT'S SPENDING POLICY SET FROM A DEVICE, AND RUNS FROM THAT VAULT RAISED, APPROVED, CHARGED AND PAID ----
   *
   * WHAT IS A STAND-IN, SAID HERE, beyond what is said above:
   *   · the policy's governance calls are built by the device's own worker (`governedCall`) from the founding signer's
   *     private state and filed, approved and carried out through the product's own routes; what the account's state is
   *     when the service hands it to the device to build a call on (`callState`) and the proposals it serves
   *     (`sealedProposals`) are read here straight off this chain and the store; the bars a device counts approvals
   *     against are its wallet's read of this chain;
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
      sealedProposals: async () => store.listProposals(ACCOUNT_ID),
    },
    builder: builder(),
    material: { signingSecret: hex(founder.secretKey), blinding: hex(founder.blinding), scope: hex(founder.scope) },
    accountId: ACCOUNT_ID, records: here,
    filing: { seat: hex(leafOfDevice(founder)), keyEpoch: 0, salt: () => toHex(new Uint8Array(randomBytes(32))), newId: () => newProposalId(), entered: enteredThrough() },
    approvers: pacing.approvers, vaultName: (v: Hex) => v, sleep: async () => {}, waitMs: 50, everyMs: 1,
  });
  /** A second device of the signer: its own worker, its own reads, its own store for a charge on its way, and the routes. */
  const aSecondDevice = () => ({
    ...pacing, service, me, myRecordsKey: recordsReaderOf(me.companyKey).publicKey, signers, records, account: readAccountAddress(company)!,
    onChain: walletReads, builder: builder(), inFlight: paymentsInFlight(), paidYet: async () => null,
    charge: (id: string, body: { tx: string; filer: string }) => governedCallServiceFor(api).charge!(id, body),
    filer: signing.publicKey,
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
      records: here, by: 'ada', registry: here.registry!, entered: enteredThrough(),
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

  /** The approving device: the company's records it reads, the service's routes, and its signer's own call built from their private state. */
  const approvingOn = (here: CompanyRecordsHere): GovernedCallDoors => ({
    service: {
      ...governedCallServiceFor(api),
      callState: async () => ({ account: company, accountState: '', parameters: '' }) as never,
      sealedProposals: async () => store.listProposals(ACCOUNT_ID),
    },
    builder: {
      governedCall: async ({ order, opened }: { order: { circuit: string; proposal: string }; opened: { digest: string; vault?: string; salt: string; chainId: string } }) => {
        if (order.circuit !== 'approve') throw new Error(`this device was asked to build ${order.circuit}, and it only approves here`);
        const keys = L.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
        const built = await (contracts as any).createUnprovenCallTxFromInitialStates(accountZk, {
          compiledContract: accountCompiled, circuitId: 'approve', contractAddress: company, coinPublicKey: keys.coinPublicKey,
          initialContractState: asRuntime(chain.contract(company)), initialZswapChainState: new L.ZswapChainState(),
          ledgerParameters: L.LedgerParameters.initialParameters(),
          initialPrivateState: { ...founder, runOpenings: { [opened.chainId]: { payload: fromHex(opened.digest), vault: fromHex(opened.vault!), salt: fromHex(opened.salt) } } },
          args: [fromHex(order.proposal)],
        }, keys.encryptionPublicKey);
        return { tx: base64FromBytes(built.private.unprovenTx.serialize()) };
      },
    } as never,
    material: { signingSecret: signing.secret as Hex, blinding: hex(founder.blinding) as Hex, scope: hex(founder.scope) as Hex } as never,
    accountId: ACCOUNT_ID, records: here, sleep: async () => undefined, waitMs: 5, everyMs: 1,
  });

  /**
   * A vault made, funded and given a spending policy; then, the signers'
   * system alone: Dana's run raised on the founding signer's device at its
   * band, approved on a second device that raised nothing, charged to its
   * period and paid there. Returns what each step left, and every reach for
   * who holds the contracts made before the payment and after it.
   */
  const raisedApprovedChargedAndPaid = async () => {
    committeeReads = [];
    const { vault } = await aFundedVault();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const dana = aPersonPaidPrivately(1, 'Dana', 600n);
    const set = await setSpendingPolicyOnDevice(governingOn(recordsHere([dana])) as never, { viewingKey, vault, asset: TOKEN as never, terms: policyTermsAt(now) });
    if (set.state !== 'done') throw new Error('the vault\'s spending policy was not set, so no run here is raised at a band or charged');
    underWay = true;
    try {
      const first = await drawnAndRaised([dana], '2026-10', vault, now - 600n, now + 3_600n);
      const round = await first.round;
      const raised = openSealedRun(store.listRuns(ACCOUNT_ID).find((r) => r.id === first.drawn.id)!, viewingKey);
      const leg = Object.values(raised.payout ?? {})[0]!;
      const second = recordsHere([dana]);
      const shown = await governedCallServiceFor(api).standing(round.id);
      /* Each step's refusal is kept rather than thrown, so every assertion below says what it found. */
      const approval = await approveOnDevice(approvingOn(second), { round: shown, viewingKey }).catch((e: Error) => e);
      const readsBeforePaying = [...committeeReads];
      const before = chain.applied.length;
      const done = await payAnApprovedLeg(aSecondDevice() as never, {
        records: second, accountId: ACCOUNT_ID, runId: first.drawn.id, viewingKey,
        deps: { detailsOf: vaultDetails, runPayload: accountCircuits.runPayload, proposalIdOf: accountCircuits.proposalIdOf, paidAmong: paidAmongNow },
      }).catch((e: Error) => e);
      return {
        leg, approval, readsBeforePaying, done, landed: chain.applied.slice(before).map((a) => [a.ok, a.error]),
        paid: (await paidAmongNow([...leg.leaves] as Hex[])).paid, leaves: [...leg.leaves], reads: [...committeeReads],
      };
    } finally {
      underWay = false;
    }
  };

  it('a run raised on one device, approved on another, charged to its period and paid lands its payment on the chain',
    /* Every step is a call on the real ledger: a vault made and funded, a policy set, a run raised, approved, charged and paid. */
    { timeout: 120_000 }, async () => {
    const t = await raisedApprovedChargedAndPaid();
    /* RED WHEN: a run from a vault under a policy is raised needing none of the approvals its band needs. */
    expect.soft(t.leg.required).toBe(1n);
    /*
     * RED WHEN: the approving device counts the approvals already given, or the
     * ones after its own, from the service's answer and not from the chain: the
     * service's read here counts one more than the chain holds, so the device
     * either waits for an approval that never comes or reports one never given.
     */
    expect.soft(t.approval instanceof Error ? t.approval.message : t.approval.approvalCount).toBe(1);
    /* RED WHEN: the raise or the approval reads who holds the contracts, on a device or at the service; the payment is the next test's. */
    expect.soft(t.readsBeforePaying).toEqual([]);
    /*
     * RED WHEN: the approvals the run was raised needing are dropped when it is
     * charged or paid - the chain then refuses the charge and nothing is paid.
     * The trace ends here: the charge and the payment landed, and the account
     * on the chain records Dana paid, at the leaf the raising device made.
     */
    expect.soft(t.done instanceof Error ? t.done.message : t.done.steps.map((st) => st.kind)).toEqual(['charge', 'payment']);
    expect.soft(t.landed).toEqual([[true, ''], [true, '']]);
    expect.soft(t.paid).toEqual(t.leaves);
  });

  /*
   * The whole run, payment included: opening the vault for a step out of it
   * asks the wallet only whether the account adopted the vault, and never who
   * holds the vault or the account.
   */
  it('nothing on the signers\' devices, or in the service\'s reads of the account, from the raise to the payment landing, reads who holds the contracts',
    { timeout: 120_000 }, async () => {
    const t = await raisedApprovedChargedAndPaid();
    expect(t.landed).toEqual([[true, ''], [true, '']]);
    /* RED WHEN: a signer's device, or the service's read of the account for its directory, reads who holds the contracts during the run. */
    expect(t.reads.filter((r) => !r.startsWith(THE_SERVICES_STATE_READ))).toEqual([]);
  });

  /*
   * The service's side of the same run: its money gate is handed only whether
   * the chain answered for each contract's state, so from the raise to the
   * payment landing it reaches for no contract's maintenance authority.
   */
  it('the service pays the fee on a payment without reading who holds the vault or the account',
    { timeout: 120_000 }, async () => {
    const t = await raisedApprovedChargedAndPaid();
    expect(t.landed).toEqual([[true, ''], [true, '']]);
    /* RED WHEN: the service reads a contract's maintenance authority anywhere between the raise and the payment landing. */
    expect(t.reads).toEqual([]);
  });
});

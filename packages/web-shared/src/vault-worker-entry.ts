/**
 * **THE WORKER A COMPANY VAULT'S TRANSACTIONS ARE BUILT AND PROVED IN, AND THE
 * COMPANY ACCOUNT'S RAISES AND APPROVALS BESIDE THEM.**
 *
 * The ledger, the contract runtime and the prover are WebAssembly and are not
 * allowed on the page; this thread is where they load, and only once something
 * asks. The page talks to it through `vault-worker-client.ts`, one request and
 * one answer at a time, each carrying the id it answers.
 *
 * Nothing this worker is asked for leaves it except the answer to the page: it
 * fetches the vault's public proving material from this application's own
 * origin and sends nothing anywhere.
 */
import {
  buildAccountDeploy, buildVaultBornHeld, buildCommitteeHandover, buildDeposit, buildPayout, creationCarriedAgain, finishedCreation, buildPublicDeposit, buildPublicPayout, buildSetNonceSecret, buildVaultDeploy,
  buildWriteSecretCopy, notesForPayment, confirmPayment, paymentsFitNotes, poolAfterPayment, buildMerge,
  type SecretRunOnTheWire, type VaultBuilderDeps,
} from './vault-builder.js';
import {
  firstSecretRunOf, startStandingOf, type AccountLedgerForAStart, type AccountStartPure, type SecretRun,
  type StartStanding, type VaultLedgerForAStart, type VaultStartPure,
} from '../../../src/midnight/vault-start.js';
import { buildGovernedCall, identityOfAChange, spendingPolicyKeysOf, type GovernedCallDeps } from './governed-call-builder.js';
import { buildClearRun, periodTotalOf, runChargeStandingOf } from './run-charge-builder.js';
import { detailsOfKind } from '../../../src/midnight/vault-details.js';
import { circuitOf, httpKeyMaterialSource, IndexedDbArtefactCache, type ArtefactSource } from './key-material.js';
import { ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE } from '../../../src/midnight/vault-contract.js';
import { zkConfigOver, byCircuitName } from './zk-config.js';
import type { CreatingTransactionAnswer, StartStandingOnTheWire, VaultAsk, VaultAnswer } from './vault-worker-client.js';
import type { EventOnTheWire } from './vault-builder.js';
import { establishCreatingTransaction, NoteIndexRefused, type ServedEvent } from '../../../src/midnight/note-index.js';
import type { Hex } from '../../../src/core/crypto.js';
import { ensureBuffer } from 'midnight-identity/browser';
import { whyItFailed } from './why-it-failed.js';
import { proofProviderOnWorkers } from './vault-proof-workers.js';
import { CREATION_STEPS } from '../../../src/midnight/deferral.js';
import { startingLedgerFrom, vaultBornHeldRefusal } from '../../../src/midnight/vault-circuits.js';
import { VAULT_CIRCUITS } from '../../../src/midnight/vault-contract.js';
import type { Committee } from '../../../src/midnight/vault-committee.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** Where this application serves the vault's public proving material. */
export const VAULT_ARTEFACT_BASE = '/artefacts/vault';

const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/**
 * **A DEPOSIT ALSO PROVES THE NETWORK'S OWN SHIELDED-OUTPUT CIRCUIT**, which the
 * prover asks for as `midnight/zswap/output`. Those three are served beside the
 * vault's own, and every other name goes to the vault's.
 */
export const networkCircuitsBeside = (vault: ArtefactSource, network: ArtefactSource): ArtefactSource => {
  const which = (keyLocation: string) => (keyLocation.startsWith('midnight/zswap/') ? network : vault);
  return {
    lookupKey: (keyLocation) => which(keyLocation).lookupKey(keyLocation),
    getParams: (k) => vault.getParams(k),
    artefact: (kind, keyLocation) => which(keyLocation).artefact(kind, keyLocation),
  };
};

/**
 * **A PAYMENT OUT ALSO PROVES THE COMPANY ACCOUNT'S `recordPayment`**, which the
 * vault's `payout` calls inside the same transaction, **AND A RAISE OR AN
 * APPROVAL IS ONE OF THE ACCOUNT'S OWN CIRCUITS.** Their material is served
 * beside the vault's, and a location is sent there by the circuit it names: no
 * vault circuit shares a name with one of the account's served to a device.
 */
export const accountCircuitsBeside = (vault: ArtefactSource, account: ArtefactSource): ArtefactSource => {
  const which = (keyLocation: string) =>
    (ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE.includes(circuitOf(keyLocation)) ? account : vault);
  return {
    lookupKey: (keyLocation) => which(keyLocation).lookupKey(keyLocation),
    getParams: (k) => vault.getParams(k),
    artefact: (kind, keyLocation) => which(keyLocation).artefact(kind, keyLocation),
  };
};

/** The served events, with each position read as the number it is. */
const servedOf = (events: readonly EventOnTheWire[]): ServedEvent[] => events.map((e) => ({
  transactionHash: e.transactionHash,
  details: {
    tag: e.details.tag,
    ...(e.details.commitment === undefined ? {} : { commitment: e.details.commitment }),
    ...(e.details.contract === undefined ? {} : { contract: e.details.contract }),
    ...(e.details.mtIndex === undefined || !/^[0-9]+$/u.test(e.details.mtIndex) ? {} : { mtIndex: BigInt(e.details.mtIndex) }),
  },
}));

/**
 * **WHICH TRANSACTION CREATED A NOTE, AS THE EVENTS OF THE TRANSACTION NAMED
 * FOR IT SAY.** The events must carry exactly one output with this commitment,
 * owned by this vault. A refusal is `refused`; anything else that stops the
 * answer is `unreadable`, and asking again may answer it.
 */
export const creatingTransactionOfNote = (input: {
  readonly vault: string; readonly commitment: string; readonly transactionHash: string;
  readonly events: readonly EventOnTheWire[];
}): CreatingTransactionAnswer => {
  try {
    const { createdIn } = establishCreatingTransaction(servedOf(input.events), {
      vault: input.vault as Hex, commitment: input.commitment, transaction: { hash: input.transactionHash as Hex },
    });
    return { state: 'found', createdIn };
  } catch (cause) {
    if (cause instanceof NoteIndexRefused) return { state: 'refused' };
    return { state: 'unreadable' };
  }
};

/**
 * What this worker builds with: the vault's builder, and the account's circuits
 * beside it, with the account's compiled ledger reader, which a vault's start
 * reads the account's rounds with.
 */
export type WorkerDeps = Omit<VaultBuilderDeps, 'network'> & { vault: any; accountLedger: (data: unknown) => unknown }
  & Omit<GovernedCallDeps, 'random'> & {
    /**
     * Every one of the company account's verifying keys, fetched from this
     * application's own origin and each checked against the digest the account's
     * compiled module carries for it before it is used. Answers as the SDK's key
     * provider asks.
     */
    accountKeys: { getVerifierKey(c: string): Promise<Uint8Array>; getVerifierKeys(cs: readonly string[]): Promise<Array<[string, Uint8Array]>> };
    /** Every vault circuit's verifying key, checked the same way against the compiled vault's own digests. */
    vaultKeys: { getVerifierKey(c: string): Promise<Uint8Array>; getVerifierKeys(cs: readonly string[]): Promise<Array<[string, Uint8Array]>> };
    /** Where a vault is read from, at the indexer the wallet names; absent, the indexer itself. A test hands its own. */
    chainSourceAt?: (indexer: { indexerUri: string; indexerWsUri: string }) => import('./vault-on-chain-here.js').VaultChainSource;
  };

/**
 * **A CONTRACT'S VERIFYING KEYS, EACH CHECKED AGAINST THE DIGEST ITS COMPILED
 * MODULE CARRIES FOR IT**, from wherever they are fetched. A key that is not the
 * build's own is refused by name before anything is built or read with it.
 */
export const checkedAccountKeys = (
  fetchKey: (circuit: string) => Promise<Uint8Array>, expected: Readonly<Record<string, string>>,
  digest: (bytes: Uint8Array) => Uint8Array, whose = 'the company account',
): WorkerDeps['accountKeys'] => {
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const one = async (c: string): Promise<Uint8Array> => {
    const want = expected[c];
    if (typeof want !== 'string') throw new Error(`${whose} has no circuit called ${c} in this build.`);
    const key = await fetchKey(c);
    if (hex(digest(key)) !== want.toLowerCase()) {
      throw new Error(`the verifying key served for ${whose}'s ${c} circuit is not this build's, so nothing was built.`);
    }
    return key;
  };
  return {
    getVerifierKey: one,
    getVerifierKeys: async (cs) => Promise.all(cs.map(async (c): Promise<[string, Uint8Array]> => [c, await one(c)])),
  };
};

/**
 * **A VAULT AS ITS DEPLOY MADE IT, READ ON THIS DEVICE** before the vault is
 * adopted or its set-up carried on: the state the chain recorded its deploy
 * leaving at the vault's own address, read from the indexer the person's own
 * wallet names, never a deploy anybody serves. Read with the one reading the
 * service makes before paying for a deploy (`vaultBornHeldRefusal`), against
 * this build's keys, each checked against the compiled vault's own digest. Null
 * when the vault was born held.
 */
export const vaultAsDeployed = async (
  d: Pick<WorkerDeps, 'ledger' | 'runtimeState' | 'vault' | 'vaultKeys'>,
  ask: { vault: string; account: string; holders: Committee },
  source: Pick<import('./vault-on-chain-here.js').VaultChainSource, 'deployState'>,
): Promise<string | null> => {
  const what = 'a vault this company can use';
  const initialState = await source.deployState(ask.vault);
  if (initialState === null || initialState === undefined) {
    return `this is not ${what} yet: the chain holds no deploy at this vault's address. Nothing was sent.`;
  }
  const verifierKeys = new Map(await d.vaultKeys.getVerifierKeys(VAULT_CIRCUITS));
  return vaultBornHeldRefusal(initialState, {
    account: ask.account, holders: ask.holders, verifierKeys,
    startingLedgerOf: (state) => startingLedgerFrom(
      d.vault.ledger((d.runtimeState as any).deserialize((state as { serialize(): Uint8Array }).serialize()).data),
      d.vault.pureCircuits.copiesWrittenKey()),
  }, what);
};

/** The first secret run, as it crosses to the page. */
const secretRunToWire = (r: SecretRun): SecretRunOnTheWire => ({
  vault: r.vault, previous: r.previous, commitment: r.commitment, copiesRoot: r.copiesRoot, count: r.count.toString(),
  edge: r.edge.map((s) => ({ sibling: s.sibling.toString(), goesLeft: s.goesLeft })),
  details: r.details, nonce: r.nonce, salt: r.salt, asset: r.asset, root: r.root, payees: r.payees.toString(),
  path: r.path.map((s) => ({ sibling: s.sibling.toString(), siblingSum: s.siblingSum.toString(), goesLeft: s.goesLeft })),
  copies: r.copies.map((c) => ({
    reader: c.reader, parts: [...c.parts], path: c.path.map((s) => ({ sibling: s.sibling.toString(), goesLeft: s.goesLeft })),
  })),
});

/** Where a vault's start stands, as it crosses to the page. */
const standingToWire = (s: StartStanding): StartStandingOnTheWire => {
  if (s.secret === undefined) return { adopted: s.adopted, adoption: s.adoption };
  const { run, raise, written, ...rest } = s.secret;
  return {
    adopted: s.adopted,
    adoption: s.adoption,
    secret: {
      ...rest,
      run: run === null ? null : { ...run, opensAt: run.opensAt.toString(), closesAt: run.closesAt.toString() },
      ...(raise === undefined ? {} : { raise: { ...raise, opensAt: raise.opensAt.toString(), closesAt: raise.closesAt.toString() } }),
      written: [...written],
    },
  };
};

/** Everything heavy, loaded the first time it is needed and kept. */
const loadDeps = (scope: any) => {
  let loaded: Promise<WorkerDeps> | null = null;
  return (): Promise<WorkerDeps> => {
    loaded ??= (async () => {
      const [ledger, runtime, contracts, compactJs, vault, proving, account, accountWitnesses] = await Promise.all([
        import('@midnightntwrk/ledger-v9'),
        import('@midnight-ntwrk/compact-runtime'),
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/compact-js'),
        import('../../../contracts/managed-vault/contract/index.js'),
        import('../../../src/midnight/wasm-proving.js'),
        import('../../../contracts/managed/contract/index.js'),
        import('../../../contracts/src/witnesses.js'),
      ]);
      const options = {
        /* A store that will not keep a file costs a download; it is said in this thread's console. */
        cache: new IndexedDbArtefactCache(scope.indexedDB, undefined, (why: string) => scope.console?.warn?.(why)),
        fetchImpl: scope.fetch.bind(scope),
      };
      const source = networkCircuitsBeside(
        accountCircuitsBeside(
          httpKeyMaterialSource(VAULT_ARTEFACT_BASE, options),
          httpKeyMaterialSource(`${VAULT_ARTEFACT_BASE}/account`, options)),
        httpKeyMaterialSource(`${VAULT_ARTEFACT_BASE}/builtin/zswap/9`, options));
      /* Each proof on a thread of its own where this thread can start one (`vault-proof-workers.ts`); on this thread where it cannot. */
      const prover = await proofProviderOnWorkers(source, scope, () => proving.wasmProofProvider(source));
      const CompiledContract = (compactJs as any).CompiledContract;
      const zkConfig = zkConfigOver(source, byCircuitName);
      const compiled = CompiledContract.make('Vault', (vault as any).Contract).pipe(
        CompiledContract.withWitnesses({
          /* No transaction built here spends a note, so nothing may ask for one. */
          noteToSpend: () => { throw new Error('a vault transaction built on this device spends no note.'); },
          nonceSecret: () => { throw new Error('a vault transaction built on this device reads no nonce secret.'); },
        }),
      );
      return {
        ledger,
        vault,
        runtimeState: (runtime as any).ContractState,
        contracts: contracts as any,
        compiled,
        /* A payment out is the one transaction built here that spends a note, and it hands in the one it chose. */
        compiledWith: (witnesses: unknown) => CompiledContract.make('Vault', (vault as any).Contract).pipe(
          CompiledContract.withWitnesses(witnesses)),
        zkConfig,
        /*
         * **THE COMPANY ACCOUNT, WITH ITS OWN WITNESSES.** A raise and an approval
         * are built with the record handed to each call as a value; this object
         * is given no store to read a record from.
         */
        accountCompiled: CompiledContract.make('ConfidentialAccount', (account as any).Contract).pipe(
          CompiledContract.withWitnesses((accountWitnesses as any).witnesses)),
        accountZkConfig: zkConfig,
        accountPure: (account as any).pureCircuits,
        accountKeys: checkedAccountKeys(
          (c) => httpKeyMaterialSource(`${VAULT_ARTEFACT_BASE}/account`, options).artefact('verifier', c),
          (account as any).expectedVk, sha256),
        vaultKeys: checkedAccountKeys(
          (c) => httpKeyMaterialSource(VAULT_ARTEFACT_BASE, options).artefact('verifier', c),
          (vault as any).expectedVk, sha256, 'the vault'),
        accountLedger: (account as any).ledger,
        /* The vault's two details circuits, paired once: what a payee's leaf is made with when a run is rebuilt here. */
        vaultDetails: detailsOfKind((vault as any).pureCircuits),
        vaultPure: (vault as any).pureCircuits,
        prove: async (unproven: any, circuit?: string) =>
          (await (prover as any).proveTx(unproven, circuit === undefined ? undefined : { circuitId: circuit })) as { serialize(): Uint8Array },
      };
    })();
    loaded.catch(() => { loaded = null; });
    return loaded;
  };
};

/**
 * **THE CONTRACT RUNTIME REACHES FOR NODE'S `Buffer`, WHICH A BROWSER DOES NOT
 * HAVE.** Every coin a vault circuit makes - the vault's note in a private
 * deposit, the payee's coin and any change in a private payment out, both
 * halves of a split - has its commitment turned into hex with `Buffer`, and in
 * a browser's worker that stopped the deposit circuit with `Buffer is not
 * defined` before the wallet was asked. So every
 * ask puts one where the runtime looks first. Nothing is replaced where one is
 * already there, as in Node.
 */
const giveTheRuntimeABuffer = (): void => ensureBuffer();

/** One answer for one ask. Exported so it can be driven without a Worker. */
export const answerVaultAsk = async (
  deps: () => Promise<WorkerDeps>,
  ask: VaultAsk,
): Promise<VaultAnswer> => {
  giveTheRuntimeABuffer();
  const d = await deps();
  const withNetwork = { ...d, network: ask.network } as VaultBuilderDeps;
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId(ask.network as never);
  switch (ask.ask) {
    case 'deploy': {
      const built = await buildVaultDeploy(withNetwork, { account: ask.account });
      return { id: ask.id, ok: true, ask: 'deploy', vault: built.vault, temporaryKey: built.temporaryKey, tx: toBase64(built.proven) };
    }
    case 'account-deploy': {
      const built = await buildAccountDeploy({ ...withNetwork, accountKeys: d.accountKeys } as never, {
        foundingLeaf: ask.foundingLeaf, label: ask.label, foundingKey: ask.foundingKey,
      });
      const insert = await d.accountKeys.getVerifierKeys(CREATION_STEPS.second);
      return {
        id: ask.id, ok: true, ask: 'account-deploy', account: built.address, tx: toBase64(built.proven),
        insert: insert.map(([circuit, key]) => ({ circuit, key: toBase64(key) })),
      };
    }
    case 'finished-creation': {
      const keys = new Map(await d.accountKeys.getVerifierKeys(CREATION_STEPS.second));
      const built = await finishedCreation(withNetwork, { account: ask.account, keys, signature: ask.signature });
      return { id: ask.id, ok: true, ask: 'finished-creation', tx: toBase64(built.proven) };
    }
    case 'born-held-vault': {
      const built = await buildVaultBornHeld(withNetwork, { account: ask.account, holders: ask.holders });
      return { id: ask.id, ok: true, ask: 'born-held-vault', vault: built.address, tx: toBase64(built.proven) };
    }
    case 'vault-as-deployed': {
      /* The deploy as the chain holds it, from the indexer the wallet names, read here and never served by anybody. */
      const { vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'vault-as-deployed', refusal: await vaultAsDeployed(d, ask, source) };
    }
    case 'handover': {
      const built = await buildCommitteeHandover(withNetwork, {
        vault: ask.vault, counter: BigInt(ask.counter), temporaryKey: ask.temporaryKey, to: ask.to,
      });
      return { id: ask.id, ok: true, ask: 'handover', tx: toBase64(built.proven) };
    }
    case 'deposit': {
      const built = await buildDeposit(withNetwork, {
        vault: ask.vault,
        coin: { nonce: ask.coin.nonce, token: ask.coin.token, value: BigInt(ask.coin.value) },
        state: fromBase64(ask.state),
        /* An ask with no parameters is passed on empty, so the builder's refusal names what is missing. */
        parameters: typeof ask.parameters === 'string' ? fromBase64(ask.parameters) : new Uint8Array(0),
      });
      return { id: ask.id, ok: true, ask: 'deposit', tx: toBase64(built.proven) };
    }
    case 'public-deposit': {
      const amount = typeof ask.amount === 'string' && /^[0-9]+$/u.test(ask.amount) ? BigInt(ask.amount) : 0n;
      const built = await buildPublicDeposit(withNetwork, {
        vault: ask.vault,
        token: ask.token,
        amount,
        state: fromBase64(ask.state),
        parameters: typeof ask.parameters === 'string' ? fromBase64(ask.parameters) : new Uint8Array(0),
      });
      return { id: ask.id, ok: true, ask: 'public-deposit', tx: toBase64(built.proven) };
    }
    case 'notes-for-payment': {
      const notes = notesForPayment({ notes: ask.notes, token: ask.token, amount: ask.amount });
      return { id: ask.id, ok: true, ask: 'notes-for-payment', notes };
    }
    case 'payments-fit': {
      return { id: ask.id, ok: true, ask: 'payments-fit', answer: paymentsFitNotes({ notes: ask.notes, payments: ask.payments }) };
    }
    case 'after-payment': {
      const notes = poolAfterPayment({
        notes: ask.notes, spent: ask.spent, ...(ask.further === undefined ? {} : { further: ask.further }),
        amount: ask.amount, change: ask.change, createdIn: ask.createdIn,
      });
      return { id: ask.id, ok: true, ask: 'after-payment', notes };
    }
    case 'confirm-payment': {
      const confirmation = await confirmPayment({
        vault: ask.vault, transactionHash: ask.transactionHash, change: ask.change, events: ask.events,
        ...(ask.merge === true ? { merge: true as const } : {}),
      });
      return { id: ask.id, ok: true, ask: 'confirm-payment', confirmation };
    }
    case 'creating-transaction': {
      const answer = creatingTransactionOfNote({
        vault: ask.vault, commitment: ask.commitment, transactionHash: ask.transactionHash, events: ask.events,
      });
      return { id: ask.id, ok: true, ask: 'creating-transaction', answer };
    }
    case 'payout': {
      const built = await buildPayout(withNetwork, {
        vault: ask.vault, account: ask.account, order: ask.order, payment: ask.payment,
        note: ask.note, events: ask.events, ...(ask.further === undefined ? {} : { further: ask.further }), secret: ask.secret,
        chain: {
          blockHash: ask.chain.blockHash,
          vaultState: fromBase64(ask.chain.vaultState),
          zswapState: fromBase64(ask.chain.zswapState),
          parameters: fromBase64(ask.chain.parameters),
          accountState: fromBase64(ask.chain.accountState),
        },
      });
      return { id: ask.id, ok: true, ask: 'payout', tx: toBase64(built.proven), spent: built.spent, change: built.change };
    }
    case 'merge': {
      const built = await buildMerge(withNetwork, {
        vault: ask.vault, notes: ask.notes, secret: ask.secret,
        chain: {
          blockHash: ask.chain.blockHash,
          vaultState: fromBase64(ask.chain.vaultState),
          zswapState: fromBase64(ask.chain.zswapState),
          parameters: fromBase64(ask.chain.parameters),
          accountState: fromBase64(ask.chain.accountState),
        },
      });
      return { id: ask.id, ok: true, ask: 'merge', tx: toBase64(built.proven), spent: built.spent, kept: built.kept };
    }
    case 'payout-publicly': {
      const built = await buildPublicPayout(withNetwork, {
        vault: ask.vault, account: ask.account, order: ask.order, payment: ask.payment,
        chain: {
          blockHash: ask.chain.blockHash,
          vaultState: fromBase64(ask.chain.vaultState),
          zswapState: fromBase64(ask.chain.zswapState),
          parameters: fromBase64(ask.chain.parameters),
          accountState: fromBase64(ask.chain.accountState),
        },
      });
      return { id: ask.id, ok: true, ask: 'payout-publicly', tx: toBase64(built.proven) };
    }
    case 'company-wide': {
      const v = (d.accountPure as unknown as { companyWide(): Uint8Array }).companyWide();
      return { id: ask.id, ok: true, ask: 'company-wide', value: Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('') };
    }
    case 'policy-bar-key': {
      const { policyBarKey } = d.accountPure as unknown as { policyBarKey?: () => Uint8Array };
      if (typeof policyBarKey !== 'function') {
        throw new Error('this device was not given the account\'s function for the key its policy bar is kept under, so nothing was read.');
      }
      const v = policyBarKey();
      return { id: ask.id, ok: true, ask: 'policy-bar-key', value: Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('') };
    }
    case 'spending-policy-keys':
      return {
        id: ask.id, ok: true, ask: 'spending-policy-keys',
        keys: spendingPolicyKeysOf(d, { vault: ask.vault, asset: ask.asset, assetBlinding: ask.assetBlinding,
          ...(ask.policy === undefined ? {} : { policy: ask.policy }), ...(ask.total === undefined ? {} : { total: ask.total }) }),
      };
    case 'proposal-identity':
      return { id: ask.id, ok: true, ask: 'proposal-identity', identity: identityOfAChange(d, ask.change, ask.salt) };
    case 'governed-call': {
      const built = await buildGovernedCall(d, {
        account: ask.account,
        order: ask.order,
        material: ask.material,
        chain: { accountState: fromBase64(ask.chain.accountState), parameters: fromBase64(ask.chain.parameters) },
        opened: ask.opened,
      });
      return { id: ask.id, ok: true, ask: 'governed-call', tx: toBase64(built.proven) };
    }
    case 'clear-run': {
      /* The charge and the period's total it is charged against are worked out from one block's state, never kept. */
      const built = await buildClearRun(d, {
        account: ask.account, run: ask.run, runs: ask.runs,
        chain: { accountState: fromBase64(ask.chain.accountState), parameters: fromBase64(ask.chain.parameters) },
      });
      return {
        id: ask.id, ok: true, ask: 'clear-run',
        tx: built.proven === null ? null : toBase64(built.proven), spent: built.spent === null ? null : built.spent.toString(),
      };
    }
    case 'period-total':
      return {
        id: ask.id, ok: true, ask: 'period-total',
        spent: periodTotalOf(d, { accountState: fromBase64(ask.accountState), ask: ask.total }).toString(),
      };
    case 'run-charged':
      return {
        id: ask.id, ok: true, ask: 'run-charged',
        standing: runChargeStandingOf(d, { accountState: fromBase64(ask.accountState), proposal: ask.proposal }),
      };
    case 'start-standing': {
      /*
       * **HOW FAR A VAULT'S START HAS GOT, READ HERE FROM BOTH CONTRACTS AS ONE
       * BLOCK SAW THEM.** With the secret the page opened from the company's
       * record, the first secret run is made here too, with the contracts' own
       * functions, and handed back for the steps the page then asks for.
       */
      const circuits = { vault: d.vault.pureCircuits as VaultStartPure, account: d.accountPure as unknown as AccountStartPure };
      const run = ask.secret === undefined
        ? undefined
        : firstSecretRunOf(circuits, { vault: ask.vault, secret: ask.secret, readers: ask.readers ?? [] });
      const ledgerOf = (b64: string, read: (data: unknown) => unknown) =>
        read((d.runtimeState.deserialize(fromBase64(b64)) as { data: unknown }).data);
      const standing = startStandingOf(circuits, {
        vault: ask.vault,
        account: ledgerOf(ask.accountState, d.accountLedger) as AccountLedgerForAStart,
        vaultLedger: ledgerOf(ask.vaultState, d.vault.ledger) as VaultLedgerForAStart,
        ...(run === undefined ? {} : { run }),
        now: BigInt(ask.now),
        ...(ask.window === undefined ? {} : { window: { opensAt: BigInt(ask.window.opensAt), closesAt: BigInt(ask.window.closesAt) } }),
      });
      return {
        id: ask.id, ok: true, ask: 'start-standing', standing: standingToWire(standing),
        ...(run === undefined ? {} : { run: secretRunToWire(run) }),
      };
    }
    case 'set-nonce-secret': {
      const built = await buildSetNonceSecret(withNetwork, {
        vault: ask.vault, account: ask.account, run: ask.run, secret: ask.secret, proposal: ask.proposal, opensAt: ask.opensAt, closesAt: ask.closesAt,
        chain: {
          blockHash: ask.chain.blockHash,
          vaultState: fromBase64(ask.chain.vaultState),
          zswapState: fromBase64(ask.chain.zswapState),
          parameters: fromBase64(ask.chain.parameters),
          accountState: fromBase64(ask.chain.accountState),
        },
      });
      return { id: ask.id, ok: true, ask: 'set-nonce-secret', tx: toBase64(built.proven) };
    }
    case 'write-secret-copy': {
      const built = await buildWriteSecretCopy(withNetwork, {
        vault: ask.vault, run: ask.run, place: ask.place, state: fromBase64(ask.state),
        parameters: typeof ask.parameters === 'string' ? fromBase64(ask.parameters) : new Uint8Array(0),
      });
      return { id: ask.id, ok: true, ask: 'write-secret-copy', tx: toBase64(built.proven) };
    }
    case 'own-seat': {
      /* The one definition of a signer's leaf, the one every writer of a seat calls, over this signer's own material. */
      const [{ storedSignerLeaf }, { MidnightCommitments }] = await Promise.all([
        import('../../../src/core/signer-leaf.js'),
        import('../../../src/midnight/commitments.js'),
      ]);
      const m = ask.material;
      if (!/^[0-9a-f]{64}$/iu.test(m?.signingSecret ?? '') || !/^[0-9a-f]{64}$/iu.test(m?.blinding ?? '')) {
        throw new Error('this device holds no usable key for its seat, so its seat cannot be worked out.');
      }
      return { id: ask.id, ok: true, ask: 'own-seat', seat: storedSignerLeaf(m, MidnightCommitments).toLowerCase() };
    }
    case 'founding-seat': {
      /* The same definition as a seat already held, over keys made on this device, under the scope every new seat takes. */
      const [{ storedSignerLeaf }, { MidnightCommitments }] = await Promise.all([
        import('../../../src/core/signer-leaf.js'),
        import('../../../src/midnight/commitments.js'),
      ]);
      const m = ask.material;
      if (!/^[0-9a-f]{64}$/iu.test(m?.signingSecret ?? '') || !/^[0-9a-f]{64}$/iu.test(m?.blinding ?? '')) {
        throw new Error('this device made no usable key for its seat, so its seat cannot be worked out.');
      }
      const scope = MidnightCommitments.allVaults().toLowerCase();
      const seat = storedSignerLeaf({ signingSecret: m.signingSecret, blinding: m.blinding, scope }, MidnightCommitments).toLowerCase();
      return { id: ask.id, ok: true, ask: 'founding-seat', seat, scope };
    }
    case 'creation-again': {
      const again = await creationCarriedAgain(withNetwork, { deploy: fromBase64(ask.deploy), insert: fromBase64(ask.insert) });
      return { id: ask.id, ok: true, ask: 'creation-again', account: again.account, deploy: toBase64(again.deploy), insert: toBase64(again.insert) };
    }
    case 'pay-key-standing': {
      /* Read with the account's own functions; the key and the secret only work keys out and seal, and go nowhere. */
      const [{ payKeyStandingOf }, { sealPayKeyTo }] = await Promise.all([
        import('../../../src/midnight/pay-key-round.js'),
        import('../../../src/midnight/run-keys.js'),
      ]);
      const hex = /^[0-9a-f]{64}$/iu;
      if (!hex.test(ask.account) || !hex.test(ask.key) || !hex.test(ask.signingSecret) || !hex.test(ask.wrappingPublicKey)) {
        throw new Error('that is not an account, a pay-record key, a signer\'s key and a wrapping key, so nothing was read.');
      }
      const P = d.accountPure as unknown as Parameters<typeof payKeyStandingOf>[0];
      const ledger = d.accountLedger((d.runtimeState.deserialize(fromBase64(ask.accountState)) as { data: unknown }).data);
      const s = payKeyStandingOf(P, {
        address: ask.account.toLowerCase(), account: ledger as never, key: ask.key.toLowerCase(), secretKey: ask.signingSecret.toLowerCase(),
      });
      return {
        id: ask.id, ok: true, ask: 'pay-key-standing',
        standing: {
          committed: s.committed, isThisKey: s.isThisKey, sealedMine: s.sealedMine,
          round: {
            commitment: s.round.commitment, payload: s.round.payload, salt: s.round.salt, proposal: s.round.proposal,
            open: s.round.open, approvals: s.round.approvals, needed: s.round.needed, stale: s.round.stale,
          },
          noVault: Array.from(P.noVault(), (b: number) => b.toString(16).padStart(2, '0')).join(''),
          wrap: sealPayKeyTo(ask.key.toLowerCase(), ask.wrappingPublicKey.toLowerCase()),
        },
      };
    }
    case 'secret-is-the-vaults': {
      /* The vault's own commitment function over the secret, against the commitment the vault's state holds. */
      const hex = /^[0-9a-f]{64}$/iu;
      if (!hex.test(ask.vault) || !hex.test(ask.secret)) throw new Error('that is not a vault and a secret, so nothing was compared.');
      const bytes = (h: string) => Uint8Array.from(h.match(/../gu)!, (x) => Number.parseInt(x, 16));
      const held = (d.vault.ledger((d.runtimeState.deserialize(fromBase64(ask.state)) as { data: unknown }).data) as { nonceCommitment: Uint8Array }).nonceCommitment;
      const worked = (d.vault.pureCircuits as { secretCommitmentOf(v: Uint8Array, s: Uint8Array): Uint8Array })
        .secretCommitmentOf(bytes(ask.vault), bytes(ask.secret));
      const matches = held.length === worked.length && held.every((b, i) => b === worked[i]) && held.some((b) => b !== 0);
      return { id: ask.id, ok: true, ask: 'secret-is-the-vaults', matches };
    }
    case 'vault-on-chain': {
      /* The vault as the chain holds it, from the indexer the wallet names, read here and never by the page or the service. */
      const { readVaultOnChain, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'vault-on-chain', read: await readVaultOnChain(d, source, ask.vault) };
    }
    case 'chain-at-one-block': {
      /* What a step out of the vault is built on, at one block, from the indexer the wallet names: never the service's. */
      const { readChainAtOneBlock, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'chain-at-one-block', chain: await readChainAtOneBlock(source, ask.vault, ask.account) };
    }
    case 'events-of': {
      const { readEventsOf, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'events-of', events: await readEventsOf(source, ask.transactionHash) };
    }
    case 'created-by': {
      const { readCreatedBy, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'created-by', found: await readCreatedBy(source, ask.vault, ask.commitment) };
    }
    case 'step-kept': {
      /* The coin a journalled step kept, worked out with the vault's own functions: a merge's, or a payment's change. */
      const [{ keptByAStep }, { nonceCircuitsFrom }] = await Promise.all([
        import('../../../src/midnight/vault-recovery.js'),
        import('../../../src/midnight/vault-coin-nonces.js'),
      ]);
      const coinOf = (n: { nonce: string; token: string; value: string }) => {
        const c = n as unknown as { readonly nonce: Hex; readonly token: Hex; readonly value: string };
        return { nonce: c.nonce, token: c.token, value: BigInt(c.value) };
      };
      const kept = keptByAStep({
        spent: coinOf(ask.step.spent), further: (ask.step.further ?? []).map(coinOf),
        amount: BigInt(ask.step.amount), ...(ask.step.merge === true ? { merge: true } : {}),
      }, { circuits: nonceCircuitsFrom(d.vault.pureCircuits as never), vault: ask.vault as Hex, secret: ask.secret as Hex });
      return {
        id: ask.id, ok: true, ask: 'step-kept',
        kept: kept === undefined ? null : { nonce: kept.nonce, token: kept.token, value: kept.value.toString() },
      };
    }
    case 'commitments': {
      /* The two commitments a coin has: as an output the ledger records, and as the note the vault holds. */
      const [{ compiledOutputCommitment }, { commitmentForNote }] = await Promise.all([
        import('../../../src/midnight/rebuild-from-records.js'),
        import('../../../src/midnight/vault-recovery.js'),
      ]);
      const handed = ask.coin as unknown as Record<'nonce' | 'token', never> & { readonly value: string };
      const coin = { nonce: handed.nonce, token: handed.token, value: BigInt(handed.value) };
      const output = (await compiledOutputCommitment())(coin, ask.vault as never);
      const held = commitmentForNote(d.vault.pureCircuits, ask.vault as never, coin);
      return { id: ask.id, ok: true, ask: 'commitments', output, held };
    }
    default:
      return { id: (ask as { id: number }).id, ok: false, error: 'this worker was asked for something it does not build.' };
  }
};

/**
 * Starts answering the page. `deps` is what every ask is built with, and is
 * the worker's own loader unless a test hands in another.
 *
 * **A FAILURE GOES BACK AS ITS WHOLE CHAIN OF REASONS, NOT ITS OUTER MESSAGE.**
 * Only text crosses to the page, so what is not said here is lost for good:
 * the contract runtime's own failure arrives as "Error executing circuit
 * 'deposit'" with the reason that matters kept only underneath it.
 */
const startVaultWorker = (scope: any, deps: () => Promise<WorkerDeps> = loadDeps(scope)): void => {
  scope.addEventListener('message', (event: MessageEvent) => {
    const ask = event.data as VaultAsk;
    if (typeof ask !== 'object' || ask === null || typeof ask.id !== 'number') return;
    void answerVaultAsk(deps, ask).then(
      (answer) => scope.postMessage(answer),
      (e: unknown) => scope.postMessage({ id: ask.id, ok: false, error: whyItFailed(e) }),
    );
  });
  scope.postMessage({ kind: 'vault-worker-ready' });
};

declare const self: any;
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof self.window === 'undefined') {
  startVaultWorker(self);
}

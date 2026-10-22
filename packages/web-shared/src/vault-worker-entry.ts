/**
 * **THE WORKER A COMPANY VAULT'S TRANSACTIONS ARE BUILT AND PROVED IN, AND THE
 * COMPANY ACCOUNT'S RAISES AND APPROVALS BESIDE THEM.**
 *
 * The ledger, the contract runtime and the prover are WebAssembly and are not
 * allowed on the page; this thread is where they load, and only once something
 * asks. The page talks to it through `vault-worker-client.ts`: each request
 * gets one answer carrying the id it answers, several may be in hand at once,
 * and the worker tells the page as each proof and each fetch of proving
 * material starts and ends, so the page can time it and show it.
 *
 * Nothing this worker is asked for leaves it except the answer and those words
 * to the page: its only requests are for the vault's public proving material, from this
 * application's own origin, and the reads of the chain it is asked for, at the indexer the
 * person's own wallet names. It proves only with material that hashes to
 * what this build was compiled with (`thisBuildsSources`): the service serves the
 * files, and is never trusted to say which ones are right.
 */
import {
  buildAccountDeploy, buildVaultBornHeld, buildCommitteeHandover, buildDeposit, buildPayout, creationCarriedAgain, finishedCreation, newestTimeToLive, buildPublicDeposit, buildPublicPayout, buildSetNonceSecret, buildVaultDeploy,
  buildWriteSecretCopy, notesForPayment, confirmPayment, paymentsFitNotes, poolAfterPayment, buildMerge,
  type SecretRunOnTheWire, type VaultBuilderDeps,
} from './vault-builder.js';
import {
  firstSecretRunOf, startStandingOf, type AccountLedgerForAStart, type AccountStartPure, type SecretRun,
  type StartStanding, type VaultLedgerForAStart, type VaultStartPure,
} from '../../../src/midnight/vault-start.js';
import {
  accountDeployedIn, anchorHeadsAfter, anchorsLandedIn, anchorTagIn, seatOpeningsIn, batchHoldersIn, buildAnchorCall, buildRecoverAnchorCall, lastRecoveryIn, seatsNamedBy, buildGovernedCall, identityOfAChange, roundsOnChainIn, vouchingRunsIn, vouchedRunIdentityOf,
  spendingPolicyKeysOf, type AnchorsOnChain, type GovernedCallDeps, type RoundOnChain,
} from './governed-call-builder.js';
import { buildClearRun, periodTotalOf, runChargeStandingOf } from './run-charge-builder.js';
import { detailsOfKind } from '../../../src/midnight/vault-details.js';
import {
  circuitOf, contractPins, httpKeyMaterialSource, IndexedDbArtefactCache, networkPins, ProvingMaterialRefused,
  type ArtefactSource, type CompiledManifest, type HttpKeyMaterialOptions, type NetworkKeyPins,
} from './key-material.js';
import { publishedByMidnight } from '../../../src/midnight/proving-parameter-digests.js';
import { ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE } from '../../../src/midnight/vault-contract.js';
import { zkConfigOver, byCircuitName } from './zk-config.js';
import type {
  CreatingTransactionAnswer, StartStandingOnTheWire, VaultAsk, VaultAnswer, VaultRebuildAsked, VaultRebuilt,
} from './vault-worker-client.js';
import type { EventOnTheWire } from './vault-builder.js';
import {
  establishCreatingTransaction, indexerTransactionsByIdentifier, NoteIndexRefused, publicDepositLandedAmong, type ServedEvent,
} from '../../../src/midnight/note-index.js';
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

/** The folder the network's own shielded circuits are served from and pinned under, the same name in both. */
const NETWORK_KEYS_FOLDER = 'zswap/9';

/** The network's own shielded circuits a device proves, as the network's folder names them. */
const NETWORK_SHIELDED_CIRCUITS = ['output', 'spend', 'sign'] as const;

/**
 * **A PRIVATE DEPOSIT OR PAYMENT ALSO PROVES THE NETWORK'S OWN SHIELDED CIRCUITS**
 * (`spend`, `output`, `sign`), asked for as `midnight/zswap/<circuit>`. They are
 * served beside the vault's own, and every other name goes to the vault's.
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
    /**
     * The compiled account's own digest of each of its circuits' verifying keys:
     * what a vault's account is held against before money goes in or out. Absent,
     * every such read refuses.
     */
    accountExpectedVk?: Readonly<Record<string, string>>;
    /** Every vault circuit's verifying key, checked the same way against the compiled vault's own digests. */
    vaultKeys: { getVerifierKey(c: string): Promise<Uint8Array>; getVerifierKeys(cs: readonly string[]): Promise<Array<[string, Uint8Array]>> };
    /** Fetches and checks the public parameters every circuit this app proves needs, and a deposit's keys, ahead of any proof. */
    provingWarmed: () => Promise<void>;
    /** Where a vault is read from, at the indexer the wallet names; absent, the indexer itself. A test hands its own. */
    chainSourceAt?: (indexer: { indexerUri: string; indexerWsUri: string }) => import('./vault-on-chain-here.js').VaultChainSource;
    /** Where an account's history is read from, at the indexer the wallet names; absent, the indexer itself. A test hands its own. */
    historyAt?: (indexer: { indexerUri: string; indexerWsUri: string }) => import('../../../src/midnight/contract-history.js').ContractHistory;
    /** Where transactions are looked up by identifier: the indexer the wallet names, unless a test stands one in. */
    transactionsAt?: (indexer: { indexerUri: string; indexerWsUri: string }) => ReturnType<typeof indexerTransactionsByIdentifier>;
  };

/*
 * An account's history as last read, per indexer and account, with the latest
 * transaction it was read up to and the anchors read off it: read again in
 * full only when the account has acted since, because a history only ever
 * grows.
 */
type HistorySteps = Awaited<ReturnType<import('../../../src/midnight/contract-history.js').ContractHistory['of']>>;
const historiesRead = new Map<string, { readonly latest: string; readonly steps: HistorySteps; anchors?: AnchorsOnChain }>();

/**
 * **THE ACCOUNT'S HISTORY, READ HERE AT THE INDEXER THE PERSON'S OWN WALLET
 * NAMES**, every step oldest first: the one read the anchors and where the
 * company's proposals stand are both made from.
 */
async function historyHere(
  d: Pick<WorkerDeps, 'historyAt'>,
  ask: { readonly account: string; readonly indexer: { indexerUri: string; indexerWsUri: string } },
  what: string,
): Promise<{ readonly latest: string; readonly steps: HistorySteps; anchors?: AnchorsOnChain }> {
  const account = String(ask.account).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(account)) throw new Error(`${what} not read: that is not a company account this device can name.`);
  const { indexerContractHistory } = await import('../../../src/midnight/contract-history.js');
  const history = (d.historyAt ?? ((i) => indexerContractHistory(i.indexerUri, i.indexerWsUri)))(ask.indexer);
  const key = `${ask.indexer.indexerUri}|${account}`;
  const latest = await history.latest(account);
  const known = historiesRead.get(key);
  if (known !== undefined && known.latest === latest) return known;
  const steps = await history.of(account);
  if (steps.length === 0) throw new Error(`${what} not read: its history at the indexer your wallet names is empty.`);
  const read = { latest, steps };
  historiesRead.set(key, read);
  return read;
}

/**
 * **EVERY HEAD THE ACCOUNT'S HISTORY SHOWS, ONE PER BLOCK, AND WHO HOLDS IT NOW, READ
 * HERE** from its history at the indexer the person's own wallet names, each
 * state read with the account's own functions: who holds it in the latest
 * state as a batch's header names them (`batchHoldersIn`), how it was
 * deployed, its committee then read the one way a wallet reads it
 * (`accountDeployedIn`, `seatsInAccountState`), and the seat bar in each
 * head's state read the one way a wallet reads it (`governanceInAccountState`,
 * under the key the account's own `policyBarKey` makes).
 */
async function anchorsOnChainHere(
  d: Pick<WorkerDeps, 'accountPure' | 'accountLedger' | 'runtimeState' | 'historyAt'>,
  ask: { readonly account: string; readonly indexer: { indexerUri: string; indexerWsUri: string } },
): Promise<AnchorsOnChain> {
  const history = await historyHere(d, ask, 'the account\'s anchors were');
  if (history.anchors !== undefined) return history.anchors;
  const { steps } = history;
  const { governanceInAccountState, seatsInAccountState } = await import('midnight-identity/profile/account-state');
  const { policyBarKey } = d.accountPure as unknown as { policyBarKey?: () => Uint8Array };
  if (typeof policyBarKey !== 'function') {
    throw new Error('this device was not given the account\'s function for the key its policy bar is kept under, so its anchors were not read.');
  }
  const barKey = Array.from(policyBarKey(), (b) => b.toString(16).padStart(2, '0')).join('');
  const landed = anchorsLandedIn(d, steps, (state) => governanceInAccountState(state, barKey).seatBar);
  const now = batchHoldersIn(d, steps[steps.length - 1]!.state);
  const deployed = accountDeployedIn(d, steps, seatsInAccountState);
  const read: AnchorsOnChain = { landed, now, seatsNow: seatsNamedBy(d, now.signers), deployed, vouching: vouchingRunsIn(d, steps) };
  history.anchors = read;
  return read;
}

/**
 * **WHERE EACH OF THE COMPANY'S PROPOSALS STANDS ON THE CHAIN, READ HERE** from
 * the account's history at the indexer the person's own wallet names
 * (`roundsOnChainIn`), never from the company's service.
 */
async function roundsOnChainHere(
  d: Pick<WorkerDeps, 'accountPure' | 'accountLedger' | 'runtimeState' | 'historyAt'>,
  ask: { readonly account: string; readonly indexer: { indexerUri: string; indexerWsUri: string }; readonly chainIds: readonly string[] },
): Promise<Record<string, RoundOnChain>> {
  const { steps } = await historyHere(d, ask, 'where the company\'s proposals stand on the chain was');
  return Object.fromEntries(roundsOnChainIn(d, steps, ask.chainIds));
}
/** What this copy of the app was compiled with, read from its own files and never from the service. */
export interface ThisBuild {
  readonly vault: { readonly expectedVk: Readonly<Record<string, string>>; readonly manifest: CompiledManifest };
  readonly account: { readonly expectedVk: Readonly<Record<string, string>>; readonly manifest: CompiledManifest };
  readonly network: NetworkKeyPins;
}

/**
 * **THE ONE SOURCE EVERY PROOF, DEPLOY AND KEY CHECK IN THIS WORKER READS ITS
 * MATERIAL FROM**, each folder checked against this build: the vault's and the
 * company account's against their compiled digests, the network's shielded
 * circuits against their pins, and the public parameters against Midnight's
 * published digests. `source` is what the prover and the deploys read; `vault`
 * and `account` are the same checked sources, for the verifying keys a creation
 * reads on its own.
 */
export const thisBuildsSources = (options: Omit<HttpKeyMaterialOptions, 'pins'>, build: ThisBuild) => {
  const vault = httpKeyMaterialSource(VAULT_ARTEFACT_BASE, {
    ...options, pins: contractPins('the vault', build.vault.expectedVk, build.vault.manifest, publishedByMidnight),
  });
  const account = httpKeyMaterialSource(`${VAULT_ARTEFACT_BASE}/account`, {
    ...options, pins: contractPins('the company account', build.account.expectedVk, build.account.manifest),
  });
  const network = httpKeyMaterialSource(`${VAULT_ARTEFACT_BASE}/builtin/${NETWORK_KEYS_FOLDER}`, {
    ...options, pins: networkPins('the network\'s shielded transfers', build.network, NETWORK_KEYS_FOLDER),
  });
  return { source: networkCircuitsBeside(accountCircuitsBeside(vault, account), network), vault, account };
};

/**
 * The circuits a deposit proves on this device: the vault's private and public
 * deposit, and the network's shielded output that carries a private deposit's
 * coin into the vault. They are warmed first, with their proving and verifying
 * keys (about 11 MB together), so even a first deposit reads nothing from the
 * network; the other circuits' proving keys run to hundreds of MB and are
 * fetched when a proof first needs them.
 */
const CIRCUITS_A_DEPOSIT_PROVES = ['deposit', 'depositUnshielded', 'midnight/zswap/output'] as const;

/**
 * **THE PUBLIC PARAMETERS EVERY CIRCUIT THIS APP PROVES NEEDS, AND A DEPOSIT'S
 * KEYS, FETCHED AND CHECKED BEFORE ANY PROOF ASKS FOR THEM.** Works in two
 * stages. First a deposit's own circuits, whole: each one's circuit, its size
 * read off it, its proving and verifying keys, then the parameters for those
 * sizes. Only then every other circuit of the vault, of the company account and
 * of the network's shielded transfers, and the parameters for the sizes not yet
 * held. Reading a size means parsing the circuit on this worker's one thread,
 * over a minute for every circuit together, so a deposit asked for right after
 * sign-in finds its files held instead of queueing behind those parses. Each
 * stage asks for its sizes smallest first, each once. `source` is the prover's
 * own checked source, so a file the service sends that is not the published one
 * is refused by name and not kept. Every file is tried even when one fails; it
 * then refuses with the first failure.
 */
export const provingWarmed = async (
  source: ArtefactSource, sizeOf: (circuit: Uint8Array) => number | Promise<number>,
): Promise<void> => {
  const fetchedSizes = new Set<number>();
  const failures: unknown[] = [];
  const stage = async (circuits: readonly string[], keysToo: boolean): Promise<void> => {
    const sizes = new Set<number>();
    await Promise.all(circuits.flatMap((location) => [
      (async () => {
        try {
          sizes.add(await sizeOf(await source.artefact('ir', location)));
        } catch (e) { failures.push(e); }
      })(),
      ...(keysToo ? (['prover', 'verifier'] as const) : []).map(async (kind) => {
        try { await source.artefact(kind, location); } catch (e) { failures.push(e); }
      }),
    ]));
    for (const k of [...sizes].filter((k) => !fetchedSizes.has(k)).sort((a, b) => a - b)) {
      fetchedSizes.add(k);
      try { await source.getParams(k); } catch (e) { failures.push(e); }
    }
  };
  await stage(CIRCUITS_A_DEPOSIT_PROVES, true);
  await stage([
    ...VAULT_CIRCUITS, ...ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE, ...NETWORK_SHIELDED_CIRCUITS.map((c) => `midnight/zswap/${c}`),
  ].filter((location) => !(CIRCUITS_A_DEPOSIT_PROVES as readonly string[]).includes(location)), false);
  if (failures.length > 0) throw failures[0];
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

/** Posts a word to the page; a word that cannot be posted is dropped, since a word is never an answer. */
const toldThePage = (scope: { postMessage(m: unknown): void }, word: unknown): void => {
  try { scope.postMessage(word); } catch { /* the next word or the answer still reaches the page */ }
};

/**
 * **THE REFUSALS OF PROVING MATERIAL THIS WORKER SAW**, newest last, each with
 * the number it was seen at. The prover runs its key fetches inside the
 * WebAssembly, which hands a refusal back to the proof as text only, so a proof
 * that failed is matched to the refusal it carries by that refusal's whole
 * message (`provingToldOf`). Only the most recent are kept.
 */
const refusals: Array<{ readonly seen: number; readonly refusal: ProvingMaterialRefused }> = [];
let refusalsSeen = 0;
const KEPT_REFUSALS = 32;
const refusedLately = (refusal: ProvingMaterialRefused): void => {
  refusalsSeen += 1;
  refusals.push({ seen: refusalsSeen, refusal });
  if (refusals.length > KEPT_REFUSALS) refusals.shift();
};
/** The refusal seen since `since` whose whole message, its final full stop aside, is in the text of `e`, or null. */
const refusalCarriedBy = (e: unknown, since: number): ProvingMaterialRefused | null => {
  if (e instanceof ProvingMaterialRefused) return null;
  const text = `${typeof e === 'string' ? e : ''} ${whyItFailed(e)}`;
  for (let i = refusals.length - 1; i >= 0; i -= 1) {
    const { seen, refusal } = refusals[i]!;
    /* The prover's own check passes a refusal on without its final full stop; the rest of the sentence must be there whole. */
    const whole = refusal.message.trim().replace(/\.$/u, '').trimEnd();
    if (seen > since && whole.length > 0 && text.includes(whole)) return refusal;
  }
  return null;
};

/**
 * **A SOURCE OF PROVING MATERIAL THAT SAYS WHEN IT IS WORKING**: `word` is
 * called once as each fetch of a key, a file or the parameters starts and once
 * as it ends, refused or not. The page's time limit restarts at each word.
 */
export const toldOfEachCall = (source: ArtefactSource, word: () => void): ArtefactSource => {
  const told = async <T>(work: () => Promise<T>): Promise<T> => {
    word();
    try {
      return await work();
    } catch (e) {
      if (e instanceof ProvingMaterialRefused) refusedLately(e);
      throw e;
    } finally { word(); }
  };
  return {
    lookupKey: (keyLocation) => told(() => source.lookupKey(keyLocation)),
    getParams: (k) => told(() => source.getParams(k)),
    artefact: (kind, keyLocation) => told(() => source.artefact(kind, keyLocation)),
  };
};

/**
 * What one ask is built with: `deps`, with each proof told to the page as it
 * starts and as it ends, under the ask's own id. Asks run at the same time in
 * this worker, so each ask carries its own. A proof that fails carrying the
 * whole message of a refusal of proving material seen while it ran fails as
 * that refusal.
 */
export const provingToldOf = (
  deps: () => Promise<WorkerDeps>, ask: Pick<VaultAsk, 'id' | 'ask'>, say: (word: unknown) => void,
): (() => Promise<WorkerDeps>) => () => deps().then((d) => ({
  ...d,
  prove: async (unproven: any, circuit?: string) => {
    const word = (state: 'started' | 'ended') => say({ kind: 'vault-proof', id: ask.id, ask: ask.ask, circuit: circuit ?? null, state });
    const since = refusalsSeen;
    word('started');
    try {
      return await d.prove(unproven, circuit);
    } catch (e) {
      /* A refusal the prover passed on as text is answered as that refusal, with its kind, and what the prover said beneath it. */
      const refused = refusalCarriedBy(e, since);
      if (refused === null) throw e;
      const again = new ProvingMaterialRefused(refused.kind, refused.keyLocation, refused.message);
      Object.defineProperty(again, 'cause', { value: e, enumerable: false, writable: true, configurable: true });
      throw again;
    } finally { word('ended'); }
  },
}));

/**
 * A failure as it crosses to the page: its whole chain of reasons, the name of
 * the error when it has one of its own, and how proving material was refused
 * when anything in the chain was such a refusal.
 */
const failureFor = (id: number, e: unknown): { id: number; ok: false; error: string; name?: string; kind?: string } => {
  const name = (e as { name?: unknown } | null)?.name;
  let kind: string | undefined;
  const seen = new Set<unknown>();
  for (let at: unknown = e; at !== null && typeof at === 'object' && !seen.has(at) && kind === undefined; at = (at as { cause?: unknown }).cause) {
    seen.add(at);
    const k = (at as { name?: unknown; kind?: unknown });
    if (k.name === 'ProvingMaterialRefused' && typeof k.kind === 'string') kind = k.kind;
  }
  return {
    id, ok: false, error: whyItFailed(e),
    ...(typeof name === 'string' && name !== 'Error' ? { name } : {}),
    ...(kind === undefined ? {} : { kind }),
  };
};

/** Everything heavy, loaded the first time it is needed and kept. */
export const loadDeps = (scope: any) => {
  let loaded: Promise<WorkerDeps> | null = null;
  return (): Promise<WorkerDeps> => {
    loaded ??= (async () => {
      const [
        ledger, runtime, contracts, compactJs, vault, proving, account, accountWitnesses, vaultManifest, accountManifest, networkKeys,
      ] = await Promise.all([
        import('@midnightntwrk/ledger-v9'),
        import('@midnight-ntwrk/compact-runtime'),
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/compact-js'),
        import('../../../contracts/managed-vault/contract/index.js'),
        import('../../../src/midnight/wasm-proving.js'),
        import('../../../contracts/managed/contract/index.js'),
        import('../../../contracts/src/witnesses.js'),
        import('../../../contracts/managed-vault/compiler/contract-manifest.json'),
        import('../../../contracts/managed/compiler/contract-manifest.json'),
        import('../../../apps/wallet/public/keys/manifest.json'),
      ]);
      const options = {
        /* A store that will not keep a file costs a download; it is said in this thread's console. */
        cache: new IndexedDbArtefactCache(scope.indexedDB, undefined, (why: string) => scope.console?.warn?.(why)),
        fetchImpl: scope.fetch.bind(scope),
      };
      const built = thisBuildsSources(options, {
        vault: { expectedVk: (vault as any).expectedVk, manifest: (vaultManifest as any).default ?? vaultManifest },
        account: { expectedVk: (account as any).expectedVk, manifest: (accountManifest as any).default ?? accountManifest },
        network: (networkKeys as any).default ?? networkKeys,
      });
      /* Every fetch of proving material is told to the page as it starts and ends, so a long download is not taken for a worker gone quiet. */
      const busy = () => toldThePage(scope, { kind: 'vault-worker-busy' });
      const source = toldOfEachCall(built.source, busy);
      const vaultFolder = toldOfEachCall(built.vault, busy);
      const accountFolder = toldOfEachCall(built.account, busy);
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
        /* The signer-tree pieces a batch's holders are read off, and checked against the root they name, with. */
        accountTree: {
          StateBoundedMerkleTree: (runtime as any).StateBoundedMerkleTree,
          CompactTypeBytes: (runtime as any).CompactTypeBytes,
          CompactTypeMerkleTreeDigest: (runtime as any).CompactTypeMerkleTreeDigest,
        },
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
          (c) => accountFolder.artefact('verifier', c), (account as any).expectedVk, sha256),
        accountExpectedVk: (account as any).expectedVk,
        provingWarmed: () => provingWarmed(source, async (circuit) =>
          Number(((await import('@midnight-ntwrk/zkir-v2')) as any).Zkir.deserialize(circuit).getK())),
        vaultKeys: checkedAccountKeys(
          (c) => vaultFolder.artefact('verifier', c), (vault as any).expectedVk, sha256, 'the vault'),
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
 * halves of a split - has its commitment turned into hex with `Buffer`. A
 * browser's worker has none, so a deposit circuit would stop with `Buffer is
 * not defined` before the wallet was asked; every ask puts one where the
 * runtime looks first, and nothing is replaced where one is already there, as
 * in Node.
 */
const giveTheRuntimeABuffer = (): void => ensureBuffer();



type RebuildAsk = Extract<VaultAsk, { ask: 'vault-rebuilt' }> & VaultRebuildAsked;
const HEX64_ASKED = /^[0-9a-f]{64}$/u;

/**
 * **THE VAULT'S NOTES, REBUILT IN THIS WORKER**, the one place the compact runtime and the vault's compiled circuits
 * are loaded. The records' coins are believed only where the chain holds their commitment (`reconcileVaultPool`), and
 * the walk's only where the chain made them (`walkCompanyRecords`). A secret that is not the vault's current one, a
 * note described two ways, or nothing to reconcile at all is said, never taken as a vault holding nothing. When
 * `copyFor` is given, this signer's sealed copy of the vault's secret is read off the vault's state and handed back
 * sealed: only the page holds the key that opens it.
 */
async function vaultRebuiltHere(d: WorkerDeps, ask: RebuildAsk): Promise<VaultRebuilt> {
  const vault = String(ask.vault).toLowerCase() as Hex;
  if (!HEX64_ASKED.test(vault)) throw new Error('that is not a vault, so nothing was rebuilt.');
  if (ask.chain.nonceCommitment === undefined || ask.chain.splitJournal === undefined) {
    throw new Error('the vault was read without its secret\'s commitment or its split journal, so nothing was rebuilt: a journal not read '
      + 'is not an empty one.');
  }
  const [{ walkCompanyRecords, compiledOutputCommitment }, recovery, { depositNonceKeyFor }, copies, runtime] = await Promise.all([
    import('../../../src/midnight/rebuild-from-records.js'),
    import('../../../src/midnight/vault-recovery.js'),
    import('../../../src/midnight/deposit-nonce.js'),
    import('../../../src/midnight/sealed-secret-copy.js'),
    import('@midnight-ntwrk/compact-runtime'),
  ]);
  const said: string[] = [];
  const hexToBytes = (h: string) => Uint8Array.from(h.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
  const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const coinOf = (c: { nonce: string; token: string; value: string }) =>
    ({ nonce: String(c.nonce).toLowerCase(), token: c.token, value: BigInt(c.value) }) as { nonce: Hex; token: Hex; value: bigint };
  const circuits = d.vault.pureCircuits;

  let copy: string[] | null = null;
  if (ask.copyFor !== undefined && ask.state !== undefined && HEX64_ASKED.test(String(ask.chain.nonceCommitment ?? ''))) {
    try {
      const ledger = d.vault.ledger((d.runtimeState.deserialize(fromBase64(ask.state)) as { data: unknown }).data) as {
        secretCopies: { member(k: Uint8Array): boolean; lookup(k: Uint8Array): Uint8Array };
      };
      const commitment = hexToBytes(ask.chain.nonceCommitment!);
      const countKey = circuits.copiesCountKeyOf(commitment) as Uint8Array;
      const count = ledger.secretCopies.member(countKey) ? runtime.degradeToTransient(ledger.secretCopies.lookup(countKey)) : 0n;
      const parts = copies.secretCopyOnTheChain(ledger.secretCopies,
        (c, r, place, part) => circuits.copyKeyOf(c, r, place, part) as Uint8Array,
        { commitment: ask.chain.nonceCommitment as Hex, reader: String(ask.copyFor).toLowerCase() as Hex, count: BigInt(count) });
      copy = parts === null ? null : parts.map(bytesToHex);
    } catch (e) {
      said.push(`this signer's sealed copy of the vault's secret could not be read off the chain: ${(e as Error)?.message ?? e}`);
    }
  }

  const chainNotes = ask.chain.notes.map((n) => String(n).toLowerCase() as Hex);
  const secrets = ask.secrets.map((x) => String(x).toLowerCase() as Hex).filter((x) => HEX64_ASKED.test(x));
  const splitJournal = new Map<Hex, Hex>(ask.chain.splitJournal.map(([k, v]) => [String(k).toLowerCase() as Hex, String(v).toLowerCase() as Hex]));
  const naming = secrets.length > 0 && HEX64_ASKED.test(String(ask.chain.nonceCommitment ?? ''))
    ? { nonceSecrets: { secrets, commitment: String(ask.chain.nonceCommitment).toLowerCase() as Hex }, splitJournal }
    : null;
  if (naming === null && splitJournal.size > 0) {
    said.push(`the vault's split journal holds ${splitJournal.size} split(s), and no secret was read to name their pieces`);
  }

  const output = await compiledOutputCommitment();
  const rebuild = async (withNaming: typeof naming) => {
    let named = (ask.named ?? []).map(coinOf);
    if (ask.walk !== undefined) {
      const walked = await walkCompanyRecords({
        vault,
        keys: withNaming === null ? [] : withNaming.nonceSecrets.secrets.map((x) => depositNonceKeyFor(hexToBytes(x), vault)),
        records: {
          deposited: (ask.walk.deposited.map((x) => ({ token: x.token, value: BigInt(x.value) })) as Array<{ token: Hex; value: bigint }>).filter((x) => x.value > 0n),
          paid: withNaming === null ? [] : (ask.walk.paid.map((x) => ({ token: x.token, amount: BigInt(x.amount) })) as Array<{ token: Hex; amount: bigint }>).filter((x) => x.amount > 0n),
        },
        everCreated: new Set(ask.chain.everCreated.map((c) => String(c).toLowerCase().replace(/^0x/u, ''))),
        commitmentOf: output,
        ...(withNaming === null ? {} : { nonceSecrets: withNaming.nonceSecrets, splitJournal: withNaming.splitJournal }),
        circuits,
      });
      named = [...named, ...walked.coins];
    }
    return recovery.reconcileVaultPool({
      vault, chain: chainNotes,
      versions: ask.versions.map((v) => ({ version: v.version, notes: v.notes.map(coinOf) })),
      attempted: {
        deposits: ask.attempted.deposits.map(coinOf),
        payments: ask.attempted.payments.map((p) => ({
          spent: coinOf(p.spent), amount: BigInt(p.amount),
          ...(p.further === undefined || p.further.length === 0 ? {} : { further: p.further.map(coinOf) }),
          ...(p.merge === true ? { merge: true } : {}),
        })),
      },
      named, circuits,
      ...(withNaming === null ? {} : { nonceSecrets: withNaming.nonceSecrets, splitJournal: withNaming.splitJournal }),
    });
  };
  const nothingHeld = { held: [], unexplained: chainNotes, copy, said };
  let result: Awaited<ReturnType<typeof rebuild>>;
  try {
    result = await rebuild(naming);
  } catch (e) {
    const name = (e as Error)?.name;
    if (naming !== null && (name === 'NonceSecretNotTheVaults' || name === 'NonceSecretNeeded')) {
      said.push(`${(e as Error).message} The notes the records name are still read without it.`);
      try {
        result = await rebuild(null);
      } catch (again) {
        said.push((again as Error)?.message ?? String(again));
        return nothingHeld;
      }
    } else {
      said.push((e as Error)?.message ?? String(e));
      return nothingHeld;
    }
  }
  if ((result.unnamedWithoutTheSecret?.length ?? 0) > 0) {
    said.push(`${result.unnamedWithoutTheSecret!.length} step(s) the journals name kept coins that are named only with the vault's secret, which was not read`);
  }
  return {
    held: result.held.map((n) => ({
      nonce: n.nonce, token: n.token, value: n.value.toString(), held: n.commitment, output: output(n, vault),
    })),
    unexplained: result.unexplained,
    copy,
    said,
  };
}
/** One answer for one ask, built with `deps`; `startVaultWorker` turns a throw into a failure carrying its whole chain of reasons. Exported so it can be driven without a Worker. */
export const answerVaultAsk = async (
  deps: () => Promise<WorkerDeps>,
  ask: VaultAsk,
): Promise<VaultAnswer> => {
  giveTheRuntimeABuffer();
  const d = await deps();
  /*
   * A time to live is stamped from the builder's clock and judged by the node's. An ask that carries the difference the
   * service measured between this device's clock and its own is built by the service's: a device whose clock is slow
   * does not build steps that are short of life from the moment they are made.
   */
  const offset = (ask as { clockOffsetMs?: unknown }).clockOffsetMs;
  const byTheirClock = typeof offset === 'number' && Number.isFinite(offset) && offset !== 0 ? { now: () => Date.now() + offset } : {};
  const withNetwork = { ...d, network: ask.network, ...byTheirClock } as VaultBuilderDeps;
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
    case 'vouched-run-identity':
      return { id: ask.id, ok: true, ask: 'vouched-run-identity', chainId: vouchedRunIdentityOf(d, ask.run) };
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
    case 'anchor-heads':
      return { id: ask.id, ok: true, ask: 'anchor-heads', ...anchorHeadsAfter(d, { after: ask.after, holders: ask.holders ?? [] }) };
    case 'seat-openings':
      return { id: ask.id, ok: true, ask: 'seat-openings', ...seatOpeningsIn(d, { account: ask.account, openings: ask.openings, ...(ask.own === undefined ? {} : { own: ask.own }) }) };
    case 'anchor-tag':
      return { id: ask.id, ok: true, ask: 'anchor-tag', tag: anchorTagIn(d, ask.account, ask.material) };
    case 'anchors-on-chain':
      return { id: ask.id, ok: true, ask: 'anchors-on-chain', ...(await anchorsOnChainHere(d, ask)) };
    case 'rounds-on-chain':
      return { id: ask.id, ok: true, ask: 'rounds-on-chain', rounds: await roundsOnChainHere(d, ask) };
    case 'anchor': {
      const built = await buildAnchorCall(d, {
        account: ask.account, material: ask.material, previous: ask.previous, batch: ask.batch, held: ask.held,
        chain: { accountState: fromBase64(ask.chain.accountState), parameters: fromBase64(ask.chain.parameters) },
      });
      return { id: ask.id, ok: true, ask: 'anchor', tx: toBase64(built.proven) };
    }
    case 'recover-anchor': {
      const built = await buildRecoverAnchorCall(d, {
        account: ask.account, material: ask.material, previous: ask.previous, batch: ask.batch, held: ask.held,
        resumesFrom: ask.resumesFrom, latest: ask.latest, lastRecovery: ask.lastRecovery, proposal: ask.proposal, proposalSalt: ask.proposalSalt,
        chain: { accountState: fromBase64(ask.chain.accountState), parameters: fromBase64(ask.chain.parameters) },
      });
      return { id: ask.id, ok: true, ask: 'recover-anchor', tx: toBase64(built.proven), placement: built.placement };
    }
    case 'account-call-chain': {
      /* What a call to the account alone is built on, at one block, from the indexer the wallet names: never the service's. */
      const { readAccountCallChain, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'account-call-chain', chain: await readAccountCallChain(source, ask.account) };
    }
    case 'account-presence': {
      /* Read from the indexer the wallet names; the time to live comes from the bytes kept, the time from the chain. */
      const { readAccountPresence, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      const seen = await readAccountPresence(source, ask.account);
      const ttl = newestTimeToLive(withNetwork, ask.transactions.map(fromBase64));
      return { id: ask.id, ok: true, ask: 'account-presence', presence: { held: seen.held, blockHeight: seen.blockHeight, blockTime: seen.blockTime, ttl } };
    }
    case 'last-recovery':
      return { id: ask.id, ok: true, ask: 'last-recovery', head: lastRecoveryIn(d, fromBase64(ask.accountState)) };
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
    case 'warm-proving': {
      await d.provingWarmed();
      return { id: ask.id, ok: true, ask: 'warm-proving' };
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
      /* The public key the leaf is made over: the seat's opening names it beside the blinding and the scope. */
      const publicKey = MidnightCommitments.signerPublicKey(m.signingSecret.toLowerCase() as Hex).toLowerCase();
      return { id: ask.id, ok: true, ask: 'founding-seat', seat, scope, publicKey };
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
      /*
       * The vault as the chain holds it, and with `account` that account's circuits, from the indexer the wallet names,
       * read here and never by the page or the service.
       */
      const { readVaultOnChain, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'vault-on-chain', read: await readVaultOnChain(d, source, ask.vault, ask.account) };
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
    case 'public-deposit-landed': {
      /*
       * The deposit is looked for by the identifiers of the transaction the person's wallet signed, worked out here from
       * its bytes. The wallet hands back a bound transaction; the service merges its fee in as a separate intent, which
       * changes the hash and leaves every identifier as it was, so the service's hash is never needed and never believed.
       */
      if (!/^[0-9a-f]{64}$/iu.test(ask.vault)) throw new Error('that is not a vault, so no deposit into it was looked for.');
      const { refuseEndpointsThatCannotWork } = await import('./public-data.js');
      refuseEndpointsThatCannotWork(ask.indexer);
      const signed = d.ledger.Transaction.deserialize('signature', 'proof', 'binding', fromBase64(ask.transaction));
      const identifiers = (signed.identifiers() as unknown[]).map(String);
      if (identifiers.length === 0) throw new Error('the deposit your wallet signed names no identifier, so it cannot be looked for on the chain.');
      const reader = (d.transactionsAt ?? ((i) => indexerTransactionsByIdentifier(i.indexerUri)))(ask.indexer);
      for (const identifier of identifiers) {
        const transactionHash = publicDepositLandedAmong(ask.vault, await reader.byIdentifier(identifier));
        if (transactionHash !== null) return { id: ask.id, ok: true, ask: 'public-deposit-landed', found: { transactionHash } };
      }
      return { id: ask.id, ok: true, ask: 'public-deposit-landed', found: null };
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
    case 'vault-rebuilt': {
      /*
       * Every note the vault holds that the records handed in, the chain and the company's own amounts name: reconcile
       * over what was read, with the walk's coins named when the walk is asked. Only the chain decides what is held.
       */
      const rebuilt = await vaultRebuiltHere(d, ask);
      return { id: ask.id, ok: true, ask: 'vault-rebuilt', ...rebuilt };
    }
    default:
      return { id: (ask as { id: number }).id, ok: false, error: 'this worker was asked for something it does not build.' };
  }
};

/**
 * Starts answering the page. `deps` is what every ask is built with, and is
 * the worker's own loader unless a test hands in another. Each proof is told to
 * the page as it starts and ends (`provingToldOf`).
 *
 * **A FAILURE GOES BACK AS ITS WHOLE CHAIN OF REASONS, NOT ITS OUTER MESSAGE**,
 * with its name and its kind (`failureFor`). Only text crosses to the page, so
 * what is not said here is lost for good: the contract runtime's own failure
 * arrives as "Error executing circuit 'deposit'" with the reason that matters
 * kept only underneath it. An answer that cannot be copied to the page goes
 * back as a failure, so no ask is left unanswered.
 */
export const startVaultWorker = (scope: any, deps: () => Promise<WorkerDeps> = loadDeps(scope)): void => {
  const say = (word: unknown) => toldThePage(scope, word);
  scope.addEventListener('message', (event: MessageEvent) => {
    const ask = event.data as VaultAsk;
    if (typeof ask !== 'object' || ask === null || typeof ask.id !== 'number') return;
    void answerVaultAsk(provingToldOf(deps, ask, say), ask).then(
      (answer) => {
        try { scope.postMessage(answer); } catch (e) { say(failureFor(ask.id, e)); }
      },
      (e: unknown) => say(failureFor(ask.id, e)),
    );
  });
  scope.postMessage({ kind: 'vault-worker-ready' });
};

declare const self: any;
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof self.window === 'undefined') {
  startVaultWorker(self);
}

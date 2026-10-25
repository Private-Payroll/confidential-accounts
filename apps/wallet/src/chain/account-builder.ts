import {
  buildAnchorCall, buildGovernedCall, buildRecoverAnchorCall,
  type AnchorPlacement, type GovernedCallDeps, type GovernedCallOrder, type OpenedRound, type SignerMaterial,
} from '../../../../packages/web-shared/src/governed-call-builder.js';
import { ACCOUNT_CIRCUITS_THE_WALLET_PROVES } from './account-circuits.js';
import { makePinnedKeyMaterialProvider, type PinnedKeyMaterialOptions } from './key-material.js';
import { keptProvers, makeBrowserProvingService, type ProofEvent } from './proving.js';
import { describeFailure } from '../lib/failure-text.js';
import { buildAccountDeploy, creationCarriedAgain, finishedCreation } from '../../../../packages/web-shared/src/vault-builder.js';
import { zkConfigOver } from '../../../../packages/web-shared/src/zk-config.js';

/**
 * THE WALLET'S ACCOUNT BUILDER: a signer's call to the company account, built
 * and proved in the wallet. It raises, approves and withdraws proposals, seats
 * a signer, changes a threshold, adopts a vault, seals the pay-record key, sets
 * a spending policy and anchors the company's records, and it reads where the
 * pay-record key stands. It also builds a new company's account: its deploy,
 * its second step with the founding key's signature in it, and both carried
 * again when they ran out before they landed; none of those has a proof.
 *
 * Everything a call is built from arrives with the ask: the account's state and
 * the chain's parameters as the wallet read them, the proposal as the company's
 * record holds it, the seat's secrets from the wallet's own keyring, and for a
 * new account the verifier keys this wallet was built with. It
 * fetches nothing but its proving keys, from the wallet's own origin, each
 * verified against the wallet's pins and against the key the call names. The
 * proof is made by the wallet's own prover; the transaction it answers with is
 * proved and ready to relay.
 *
 * It refuses an ask it does not build, a call the account's own checks refuse
 * (the builder's), and any key that is not this build's.
 */

/** The account's state and the chain's parameters a call is built against, each base64. */
export interface CallChainOnTheWire {
  readonly accountState: string;
  readonly parameters: string;
}

/** What the account required when a batch of records was judged, as an anchor carries it. */
export interface HeldOnTheWire {
  readonly approvals: number;
  readonly signerRoot: string;
}

interface AnchorAsked {
  readonly network: string; readonly account: string; readonly material: SignerMaterial; readonly chain: CallChainOnTheWire;
  readonly previous: string; readonly batch: string; readonly held: HeldOnTheWire;
}

export type AccountBuilderAsk =
  | {
    readonly id: number; readonly ask: 'governed-call'; readonly network: string; readonly account: string;
    readonly order: GovernedCallOrder; readonly material: SignerMaterial; readonly chain: CallChainOnTheWire; readonly opened: OpenedRound;
  }
  | ({ readonly id: number; readonly ask: 'anchor' } & AnchorAsked)
  | ({
    readonly id: number; readonly ask: 'recover-anchor';
    readonly resumesFrom: string; readonly latest: string; readonly lastRecovery: string; readonly proposal: string; readonly proposalSalt: string;
  } & AnchorAsked)
  | {
    readonly id: number; readonly ask: 'pay-key-standing'; readonly account: string; readonly accountState: string;
    readonly key: string; readonly signingSecret: string; readonly wrappingPublicKey: string;
  }
  | {
    readonly id: number; readonly ask: 'account-deploy'; readonly network: string; readonly foundingLeaf: string;
    readonly label: string; readonly foundingKey: { readonly tag: string; readonly value: string };
    /** The chain's time the steps are built by, in milliseconds; this device's clock when absent. */
    readonly now?: number;
    /** The verifier key of every circuit of the account, base64, as this wallet was built with them: the deploy is
     * built from them all and carries the first step's. */
    readonly verifiers: ReadonlyArray<readonly [string, string]>;
  }
  | {
    readonly id: number; readonly ask: 'finished-creation'; readonly network: string; readonly account: string;
    readonly signature: { readonly tag: string; readonly value: string };
    readonly now?: number;
    /** The verifier key of each circuit the second step inserts, base64, as this wallet was built with them. */
    readonly verifiers: ReadonlyArray<readonly [string, string]>;
  }
  | { readonly id: number; readonly ask: 'creation-again'; readonly network: string; readonly deploy: string; readonly insert: string; readonly now?: number };

/** Where the company's pay-record key stands, read from the account's state. */
export interface PayKeyStandingAnswered {
  readonly committed: string | null;
  readonly isThisKey: boolean;
  readonly sealedMine: boolean;
  readonly round: {
    readonly commitment: string; readonly payload: string; readonly salt: string; readonly proposal: string;
    readonly open: boolean; readonly approvals: string; readonly needed: string; readonly stale: boolean;
  };
  readonly noVault: string;
  readonly wrap: readonly string[];
}

export type AccountBuilderAnswer =
  | { readonly id: number; readonly ok: true; readonly ask: 'governed-call' | 'anchor'; readonly tx: string }
  | { readonly id: number; readonly ok: true; readonly ask: 'recover-anchor'; readonly tx: string; readonly placement: AnchorPlacement }
  | { readonly id: number; readonly ok: true; readonly ask: 'pay-key-standing'; readonly standing: PayKeyStandingAnswered }
  | { readonly id: number; readonly ok: true; readonly ask: 'account-deploy'; readonly account: string; readonly tx: string }
  | { readonly id: number; readonly ok: true; readonly ask: 'finished-creation'; readonly tx: string }
  | { readonly id: number; readonly ok: true; readonly ask: 'creation-again'; readonly account: string; readonly deploy: string; readonly insert: string }
  | { readonly id: number; readonly ok: false; readonly error: string; readonly name?: string };

/** What the builder tells the thread that started it while it works. */
export type AccountBuilderWord =
  | { readonly kind: 'account-proof'; readonly id: number; readonly state: 'started' | 'ended' }
  | { readonly kind: 'keys-not-kept'; readonly file: string; readonly why: string };

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
const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const HEX64 = /^[0-9a-f]{64}$/iu;

export interface AccountBuilderOptions {
  /** Where the wallet's own key material is read from, and who is told when it is not kept. */
  readonly keyMaterial?: Omit<PinnedKeyMaterialOptions, 'accountCircuits' | 'compiledVerifierKeys'>;
  /** The wallet's proving workers; the browser's own when not given. */
  readonly provers?: ReturnType<typeof keptProvers>;
  /** Told as each proof starts and ends. */
  readonly onProof?: (event: ProofEvent) => void;
}

/**
 * The builder's dependencies, loaded once: the ledger, the contract runtime,
 * the account as this build compiled it, and the wallet's prover over the
 * wallet's own key material, serving the account circuits the wallet proves
 * and no other, and only keys whose verifier is the one this build's account
 * was compiled with: a proof with keys from another compile is refused before
 * it starts.
 */
export const accountBuilderDeps = (options: AccountBuilderOptions = {}): (() => Promise<GovernedCallDeps>) => {
  let loaded: Promise<GovernedCallDeps> | null = null;
  return () => {
    loaded ??= (async () => {
      const [ledger, runtime, contracts, compactJs, account, accountWitnesses] = await Promise.all([
        import('@midnightntwrk/ledger-v9'),
        import('@midnight-ntwrk/compact-runtime'),
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/compact-js'),
        import('../../../../contracts/managed/contract/index.js'),
        import('../../../../contracts/src/witnesses.js'),
      ]);
      const keyMaterial = makePinnedKeyMaterialProvider({
        ...options.keyMaterial,
        accountCircuits: ACCOUNT_CIRCUITS_THE_WALLET_PROVES,
        compiledVerifierKeys: (account as unknown as { expectedVk: Readonly<Record<string, string>> }).expectedVk,
      });
      const service = makeBrowserProvingService(keyMaterial, {
        ...(options.provers === undefined ? {} : { provers: options.provers }),
        ...(options.onProof === undefined ? {} : { onProof: options.onProof }),
      });
      const CompiledContract = (compactJs as unknown as { CompiledContract: any }).CompiledContract;
      return {
        ledger,
        runtimeState: (runtime as any).ContractState,
        accountTree: {
          StateBoundedMerkleTree: (runtime as any).StateBoundedMerkleTree,
          CompactTypeBytes: (runtime as any).CompactTypeBytes,
          CompactTypeMerkleTreeDigest: (runtime as any).CompactTypeMerkleTreeDigest,
        },
        contracts: contracts as any,
        accountCompiled: CompiledContract.make('ConfidentialAccount', (account as any).Contract).pipe(
          CompiledContract.withWitnesses((accountWitnesses as any).witnesses)),
        accountZkConfig: {
          getVerifierKey: (circuit: string) => keyMaterial.accountVerifierKey(circuit),
          getVerifierKeys: async (circuits: readonly string[]) =>
            Promise.all(circuits.map(async (c): Promise<[string, Uint8Array]> => [c, await keyMaterial.accountVerifierKey(c)])),
        },
        accountPure: (account as any).pureCircuits,
        accountLedger: (account as any).ledger,
        prove: async (unproven: any) => service.prove(unproven) as Promise<{ serialize(): Uint8Array }>,
      } as GovernedCallDeps;
    })();
    loaded.catch(() => { loaded = null; });
    return loaded;
  };
};

/*
 * The clock a creation's time to live is built by: the chain's time the action
 * read, carried forward by this device's clock while it is built. A time that is
 * not a plain positive number is refused rather than built by.
 */
const clockOf = (at: number | undefined): (() => number) => {
  if (at === undefined) return Date.now;
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error('that is not a time to build by, so nothing was built.');
  const from = Date.now();
  return () => at + (Date.now() - from);
};

const chainOf = (chain: CallChainOnTheWire) => ({ accountState: fromBase64(chain.accountState), parameters: fromBase64(chain.parameters) });

/* The verifier keys an ask carries, served to the builder by circuit name and by nothing else. */
const verifiersOf = (verifiers: ReadonlyArray<readonly [string, string]>) => {
  const keys = new Map(verifiers.map(([c, k]) => [c, fromBase64(k)] as [string, Uint8Array]));
  return {
    keys,
    zkConfig: zkConfigOver({
      artefact: async (kind: string, circuit: string) => {
        const key = keys.get(circuit);
        if (kind !== 'verifier' || key === undefined) throw new Error(`this wallet holds no ${kind} for "${circuit}" to build the account with.`);
        return key;
      },
    } as never, (circuit) => circuit),
  };
};

/**
 * ANSWER ONE ASK. Builds and proves the call the ask names, or reads where the
 * pay-record key stands, and answers with the proved transaction or the
 * reading. A refusal answers `ok: false` with the builder's own reason, and
 * nothing is proved.
 */
export const answerAccountAsk = async (
  deps: () => Promise<GovernedCallDeps>,
  ask: AccountBuilderAsk,
): Promise<AccountBuilderAnswer> => {
  try {
    const d = await deps();
    if (ask.ask !== 'pay-key-standing') {
      const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
      setNetworkId(ask.network as never);
    }
    switch (ask.ask) {
      case 'governed-call': {
        const built = await buildGovernedCall(d, {
          account: ask.account, order: ask.order, material: ask.material, chain: chainOf(ask.chain), opened: ask.opened,
        });
        return { id: ask.id, ok: true, ask: 'governed-call', tx: toBase64(built.proven) };
      }
      case 'anchor': {
        const built = await buildAnchorCall(d, {
          account: ask.account, material: ask.material, previous: ask.previous, batch: ask.batch, held: ask.held, chain: chainOf(ask.chain),
        });
        return { id: ask.id, ok: true, ask: 'anchor', tx: toBase64(built.proven) };
      }
      case 'recover-anchor': {
        const built = await buildRecoverAnchorCall(d, {
          account: ask.account, material: ask.material, previous: ask.previous, batch: ask.batch, held: ask.held,
          resumesFrom: ask.resumesFrom, latest: ask.latest, lastRecovery: ask.lastRecovery, proposal: ask.proposal,
          proposalSalt: ask.proposalSalt, chain: chainOf(ask.chain),
        });
        return { id: ask.id, ok: true, ask: 'recover-anchor', tx: toBase64(built.proven), placement: built.placement };
      }
      case 'pay-key-standing': {
        if (![ask.account, ask.key, ask.signingSecret, ask.wrappingPublicKey].every((h) => HEX64.test(String(h)))) {
          throw new Error('that is not an account, a pay-record key, a signer\'s key and a wrapping key, so nothing was read.');
        }
        const [{ payKeyStandingOf }, { sealPayKeyTo }] = await Promise.all([
          import('../../../../src/midnight/pay-key-round.js'),
          import('../../../../src/midnight/run-keys.js'),
        ]);
        const P = d.accountPure as unknown as Parameters<typeof payKeyStandingOf>[0];
        const ledger = d.accountLedger!((d.runtimeState.deserialize(fromBase64(ask.accountState)) as { data: unknown }).data);
        const s = payKeyStandingOf(P, {
          address: ask.account.toLowerCase(), account: ledger as never, key: ask.key.toLowerCase() as never,
          secretKey: ask.signingSecret.toLowerCase() as never,
        });
        return {
          id: ask.id, ok: true, ask: 'pay-key-standing',
          standing: {
            committed: s.committed, isThisKey: s.isThisKey, sealedMine: s.sealedMine,
            round: {
              commitment: s.round.commitment, payload: s.round.payload, salt: s.round.salt, proposal: s.round.proposal,
              open: s.round.open, approvals: String(s.round.approvals), needed: String(s.round.needed), stale: s.round.stale,
            },
            noVault: hexOf(P.noVault()),
            wrap: sealPayKeyTo(ask.key.toLowerCase() as never, ask.wrappingPublicKey.toLowerCase() as never),
          },
        };
      }
      case 'account-deploy': {
        const built = await buildAccountDeploy({
          ledger: d.ledger, runtimeState: d.runtimeState, contracts: d.contracts as never, prove: d.prove, network: ask.network,
          accountCompiled: d.accountCompiled, accountKeys: verifiersOf(ask.verifiers).zkConfig, now: clockOf(ask.now),
        } as never, { foundingLeaf: ask.foundingLeaf, label: ask.label, foundingKey: ask.foundingKey });
        return { id: ask.id, ok: true, ask: 'account-deploy', account: built.address, tx: toBase64(built.proven) };
      }
      case 'finished-creation': {
        const built = await finishedCreation({ ledger: d.ledger, prove: d.prove, network: ask.network, now: clockOf(ask.now) } as never, {
          account: ask.account, keys: verifiersOf(ask.verifiers).keys, signature: ask.signature,
        });
        return { id: ask.id, ok: true, ask: 'finished-creation', tx: toBase64(built.proven) };
      }
      case 'creation-again': {
        const again = await creationCarriedAgain({ ledger: d.ledger, prove: d.prove, network: ask.network, now: clockOf(ask.now) } as never, {
          deploy: fromBase64(ask.deploy), insert: fromBase64(ask.insert),
        });
        return { id: ask.id, ok: true, ask: 'creation-again', account: again.account, deploy: toBase64(again.deploy), insert: toBase64(again.insert) };
      }
      default:
        return { id: (ask as { id: number }).id, ok: false, error: 'the wallet\'s account builder was asked for something it does not build.' };
    }
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    return { id: ask.id, ok: false, error: describeFailure(e), ...(typeof name === 'string' && name !== 'Error' ? { name } : {}) };
  }
};

/** Anything a worker can be told and can tell. */
export interface WorkerScopeLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/**
 * START THE BUILDER IN A WORKER SCOPE: answers each ask posted to it, tells
 * the thread that started it as each proof starts and ends and when a key could
 * not be kept on this device, and says `ready` only once it is listening, so no
 * ask is posted into a worker that would drop it.
 */
export const startAccountBuilder = (
  scope: WorkerScopeLike,
  deps?: () => Promise<GovernedCallDeps>,
): void => {
  let current: number | null = null;
  const say = (word: AccountBuilderWord): void => { try { scope.postMessage(word); } catch { /* the starter has gone */ } };
  const loaded = deps ?? accountBuilderDeps({
    keyMaterial: { onNotKept: (file, why) => say({ kind: 'keys-not-kept', file, why }) },
    onProof: (event) => { if (current !== null) say({ kind: 'account-proof', id: current, state: event.at === 'start' ? 'started' : 'ended' }); },
  });
  let queue: Promise<unknown> = Promise.resolve();
  scope.addEventListener('message', ({ data }) => {
    const ask = data as AccountBuilderAsk;
    if (typeof ask !== 'object' || ask === null || typeof ask.id !== 'number') return;
    queue = queue.then(async () => {
      current = ask.id;
      const answer = await answerAccountAsk(loaded, ask);
      current = null;
      try {
        scope.postMessage(answer);
      } catch (e) {
        scope.postMessage({ id: ask.id, ok: false, error: `the builder could not hand back what it built (${describeFailure(e)}).` });
      }
    }).catch(() => { /* the starter has gone; the next ask is still answered */ });
  });
  scope.postMessage({ kind: 'account-builder-ready' });
};

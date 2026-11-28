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
import { readTransaction, type VaultBuilderDeps } from './vault-builder.js';
import { setNonceSecretAnswered, startStandingAnswered, writeSecretCopyAnswered } from './vault-worker-start.js';
import { fromBase64 } from './base64-bytes.js';
import { retireAnswered } from './vault-retire-built.js';
import { roundsOnChainIn, type RoundOnChain } from './governed-call-builder.js';
import type { VaultAsk, VaultAnswer } from './vault-worker-client.js';
import { ASK_STARTED, CHAIN_READS, WALLET_VAULT_BUILDER } from './vault-worker-client.js';
import { SERVICE_READ_BOUND_MS } from './read-bound.js';
import type { Hex } from '../../../src/core/crypto.js';
import { ensureBuffer } from 'midnight-identity/browser';
import { whyItFailed } from './why-it-failed.js';
import { vaultCallOnChainAnswered } from './vault-call-on-chain-answered.js';
import { superAdminAnswered } from './super-admins-answered.js';
import { loadDeps, type WorkerDeps } from './vault-worker-deps.js';
import { aReadArrived, aReadEnded } from './reads-go-first.js';
import { provingToldOf, toldThePage } from './proving-told-to-the-page.js';
import { accountHistoryAnswered, historyHere } from './account-history-here.js';
import { vaultNotesAnswered } from './vault-notes-rebuilt-here.js';
import { depositsAndNotesAnswered } from './deposits-and-notes-answered.js';
import { payoutsAnswered } from './payouts-answered.js';
import { creationAnswered } from './creation-answered.js';
import { accountCallsAnswered } from './account-calls-answered.js';
import { accountReadsAnswered } from './account-reads-answered.js';
import { chainReadsAnswered } from './chain-reads-answered.js';

export { loadDeps, type WorkerDeps } from './vault-worker-deps.js';
export {
  VAULT_ARTEFACT_BASE,
  checkedAccountKeys,
  provingWarmed,
  thisBuildsSources,
  type ThisBuild
} from './this-builds-proving-material.js';
export { readsGoFirst } from './reads-go-first.js';
export { provingToldOf, toldOfEachCall } from './proving-told-to-the-page.js';
export { creatingTransactionOfNote } from './deposits-and-notes-answered.js';

/** Every answerer an ask not answered in this file is handed to, in turn, until one answers it. */
const ANSWERED_ELSEWHERE = [
  creationAnswered,
  chainReadsAnswered,
  depositsAndNotesAnswered,
  payoutsAnswered,
  accountReadsAnswered,
  accountCallsAnswered,
  accountHistoryAnswered,
  vaultNotesAnswered
] as const;

/**
 * **WHERE EACH OF THE COMPANY'S PROPOSALS STANDS ON THE CHAIN, READ HERE** from
 * the account's history at the indexer the person's own wallet names
 * (`roundsOnChainIn`), never from the company's service; which call raised or
 * closed each is read from its transaction's bytes with the ledger this worker
 * holds, only the calls to the account asked about counting. With `seat`, the
 * signing secret of the seat this device holds, each also says whether that
 * seat's approval marker is in the latest state and, while held, whether that
 * seat raised it; the secret stays in this worker.
 */
async function roundsOnChainHere(
  d: Pick<WorkerDeps, 'accountPure' | 'accountLedger' | 'runtimeState' | 'historyAt' | 'ledger'>,
  ask: {
    readonly account: string;
    readonly indexer: { indexerUri: string; indexerWsUri: string };
    readonly chainIds: readonly string[];
    readonly seat?: string;
  }
): Promise<Record<string, RoundOnChain>> {
  const { steps } = await historyHere(d, ask, "where the company's proposals stand on the chain was");
  return Object.fromEntries(
    roundsOnChainIn(
      d,
      steps,
      ask.chainIds,
      ask.seat === undefined ? undefined : { account: ask.account, signingSecret: ask.seat },
      ask.account
    )
  );
}

/**
 * A failure as it crosses to the page: its whole chain of reasons, the name of
 * the error when it has one of its own, and how proving material was refused
 * when anything in the chain was such a refusal.
 */
const failureFor = (id: number, e: unknown): { id: number; ok: false; error: string; name?: string; kind?: string } => {
  const name = (e as { name?: unknown } | null)?.name;
  let kind: string | undefined;
  const seen = new Set<unknown>();
  for (
    let at: unknown = e;
    at !== null && typeof at === 'object' && !seen.has(at) && kind === undefined;
    at = (at as { cause?: unknown }).cause
  ) {
    seen.add(at);
    const k = at as { name?: unknown; kind?: unknown };
    if (k.name === 'ProvingMaterialRefused' && typeof k.kind === 'string') kind = k.kind;
  }
  return {
    id,
    ok: false,
    error: whyItFailed(e),
    ...(typeof name === 'string' && name !== 'Error' ? { name } : {}),
    ...(kind === undefined ? {} : { kind })
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

/** One answer for one ask, built with `deps`; `startVaultWorker` turns a throw into a failure carrying its whole chain of reasons. Exported so it can be driven without a Worker. */
export const answerVaultAsk = async (deps: () => Promise<WorkerDeps>, ask: VaultAsk): Promise<VaultAnswer> => {
  giveTheRuntimeABuffer();
  const d = await deps();
  /*
   * A time to live is stamped from the builder's clock and judged by the node's. An ask that carries the difference the
   * service measured between this device's clock and its own is built by the service's: a device whose clock is slow
   * does not build steps that are short of life from the moment they are made.
   */
  const offset = (ask as { clockOffsetMs?: unknown }).clockOffsetMs;
  const byTheirClock =
    typeof offset === 'number' && Number.isFinite(offset) && offset !== 0 ? { now: () => Date.now() + offset } : {};
  /* The network travels with each ask into what it builds; nothing in this worker holds a network of its own. */
  const withNetwork = { ...d, network: ask.network, ...byTheirClock } as VaultBuilderDeps;
  switch (ask.ask) {
    case 'address-claim-refusal': {
      const { signedClaimRefusal } = await import('./signed-claim-refusal.js');
      return {
        id: ask.id,
        ok: true,
        ask: 'address-claim-refusal',
        refusal: await signedClaimRefusal(ask.claim, ask.for)
      };
    }
    case 'one-off-opened': {
      const [{ openOneOff }, { oneOffBuiltHere }, { buildOneOffRun }] = await Promise.all([
        import('../../../src/midnight/one-off-record.js'),
        import('./one-off-here.js'),
        import('../../../src/midnight/payout-tree.js')
      ]);
      const o = openOneOff(ask.rec, ask.key as Hex);
      const leaf =
        d.vaultDetails === undefined
          ? null
          : (oneOffBuiltHere(o, {
              detailsOf: d.vaultDetails,
              treeOf: buildOneOffRun
            }).tree.tree.leaves[0]?.toLowerCase() ?? null);
      return {
        id: ask.id,
        ok: true,
        ask: 'one-off-opened',
        oneOff: {
          vault: o.vault,
          asset: o.asset,
          token: o.token,
          amount: o.amount.toString(),
          reason: o.reason,
          payee: { ref: o.payee.ref, name: o.payee.name, address: o.payee.address },
          proposal: { id: o.proposal.id, chainId: o.proposal.chainId },
          leaf
        }
      };
    }
    case 'rounds-on-chain':
      return { id: ask.id, ok: true, ask: 'rounds-on-chain', rounds: await roundsOnChainHere(d, ask) };
    case 'start-standing':
      return startStandingAnswered(d, ask);
    case 'set-nonce-secret':
      return setNonceSecretAnswered(withNetwork, ask);
    case 'write-secret-copy':
      return writeSecretCopyAnswered(withNetwork, ask);
    case 'retire':
      return retireAnswered(withNetwork, ask);
    case 'warm-proving': {
      await d.provingWarmed();
      return { id: ask.id, ok: true, ask: 'warm-proving' };
    }
    case 'own-seat': {
      /* The one definition of a signer's leaf, the one every writer of a seat calls, over this signer's own material. */
      const [{ storedSignerLeaf }, { MidnightCommitments }] = await Promise.all([
        import('../../../src/core/signer-leaf.js'),
        import('../../../src/midnight/commitments.js')
      ]);
      const m = ask.material;
      if (!/^[0-9a-f]{64}$/iu.test(m?.signingSecret ?? '') || !/^[0-9a-f]{64}$/iu.test(m?.blinding ?? '')) {
        throw new Error('this device holds no usable key for its seat, so its seat cannot be worked out.');
      }
      return { id: ask.id, ok: true, ask: 'own-seat', seat: storedSignerLeaf(m, MidnightCommitments).toLowerCase() };
    }
    case 'vault-call-on-chain':
      return vaultCallOnChainAnswered(d, withNetwork, ask);
    case 'account-committee':
    case 'contract-authority':
    case 'super-admin-update':
    case 'super-admin-signed':
    case 'super-admin-joined':
      return superAdminAnswered(d, ask);
    case 'transaction-read':
      return {
        id: ask.id,
        ok: true,
        ask: 'transaction-read',
        read: readTransaction(withNetwork, fromBase64(ask.transaction))
      };
    default: {
      for (const answered of ANSWERED_ELSEWHERE) {
        const answer = await answered(d, withNetwork, ask);
        if (answer !== undefined) return answer;
      }
      return {
        id: (ask as { id: number }).id,
        ok: false,
        error: 'this worker was asked for something it does not build.'
      };
    }
  }
};

/**
 * Starts answering the page. `deps` is what every ask is built with, and is
 * the worker's own loader unless a test hands in another. Each proof is told to
 * the page as it starts and ends (`provingToldOf`).
 *
 * **EACH ASK IS TOLD TO THE PAGE AS IT STARTS, ITS CODE LOADED** (`ASK_STARTED`):
 * the code loads on the first ask, and a read's time limit on the page counts
 * from here, so loading does not use it up. A read of the network is counted
 * from when it arrives until it is answered or the page has stopped waiting for
 * it, so the proving warm-up lets it go first (`readsGoFirst`).
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
    let counted = CHAIN_READS.has(ask.ask);
    let bound: ReturnType<typeof setTimeout> | undefined;
    const noLongerCounted = (): void => {
      clearTimeout(bound);
      if (counted) {
        counted = false;
        aReadEnded();
      }
    };
    if (counted) aReadArrived();
    let told = false;
    const loaded = (): Promise<WorkerDeps> =>
      deps().then((d) => {
        if (!told) {
          told = true;
          say({ kind: ASK_STARTED, started: ask.id });
          if (counted) bound = setTimeout(noLongerCounted, SERVICE_READ_BOUND_MS);
        }
        return d;
      });
    void answerVaultAsk(provingToldOf(loaded, ask, say), ask)
      .then(
        (answer) => {
          try {
            scope.postMessage(answer);
          } catch (e) {
            say(failureFor(ask.id, e));
          }
        },
        (e: unknown) => say(failureFor(ask.id, e))
      )
      .finally(noLongerCounted);
  });
  scope.postMessage({ kind: 'vault-worker-ready' });
};

/* A worker the person's wallet starts under its own builder's name starts this builder itself, with the wallet's own keys and prover, so it is not also started here with the page's. */
declare const self: any;
if (
  typeof self !== 'undefined' &&
  typeof self.postMessage === 'function' &&
  typeof self.window === 'undefined' &&
  self.name !== WALLET_VAULT_BUILDER
) {
  startVaultWorker(self);
}

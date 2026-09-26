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
  buildCommitteeHandover, buildDeposit, buildPayout, buildPublicDeposit, buildPublicPayout, buildVaultDeploy, chooseNoteForPayment, confirmPayment, paymentsFitNotes,
  poolAfterPayment,
  type VaultBuilderDeps,
} from './vault-builder.js';
import { buildGovernedCall, type GovernedCallDeps } from './governed-call-builder.js';
import { circuitOf, httpKeyMaterialSource, IndexedDbArtefactCache, type ArtefactSource } from './key-material.js';
import { ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE } from '../midnight/vault-contract.js';
import { zkConfigOver, byCircuitName } from './zk-config.js';
import type { CreatingTransactionAnswer, VaultAsk, VaultAnswer } from './vault-worker-client.js';
import type { EventOnTheWire } from './vault-builder.js';
import { establishCreatingTransaction, NoteIndexRefused, type ServedEvent } from '../midnight/note-index.js';
import type { Hex } from '../core/crypto.js';

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

/** What this worker builds with: the vault's builder, and the account's two circuits beside it. */
export type WorkerDeps = Omit<VaultBuilderDeps, 'network'> & { vault: any } & Omit<GovernedCallDeps, 'random'>;

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
        import('../../contracts/managed-vault/contract/index.js'),
        import('../midnight/wasm-proving.js'),
        import('../../contracts/managed/contract/index.js'),
        import('../../contracts/src/witnesses.js'),
      ]);
      const options = {
        cache: new IndexedDbArtefactCache(scope.indexedDB),
        fetchImpl: scope.fetch.bind(scope),
      };
      const source = networkCircuitsBeside(
        accountCircuitsBeside(
          httpKeyMaterialSource(VAULT_ARTEFACT_BASE, options),
          httpKeyMaterialSource(`${VAULT_ARTEFACT_BASE}/account`, options)),
        httpKeyMaterialSource(`${VAULT_ARTEFACT_BASE}/builtin/zswap/9`, options));
      const prover = await proving.wasmProofProvider(source);
      const CompiledContract = (compactJs as any).CompiledContract;
      const zkConfig = zkConfigOver(source, byCircuitName);
      const compiled = CompiledContract.make('Vault', (vault as any).Contract).pipe(
        CompiledContract.withWitnesses({
          /* No transaction built here spends a note, so nothing may ask for one. */
          noteToSpend: () => { throw new Error('a vault transaction built on this device spends no note.'); },
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
        prove: async (unproven: any, circuit?: string) =>
          (await (prover as any).proveTx(unproven, circuit === undefined ? undefined : { circuitId: circuit })) as { serialize(): Uint8Array },
      };
    })();
    loaded.catch(() => { loaded = null; });
    return loaded;
  };
};

/** One answer for one ask. Exported so it can be driven without a Worker. */
export const answerVaultAsk = async (
  deps: () => Promise<WorkerDeps>,
  ask: VaultAsk,
): Promise<VaultAnswer> => {
  const d = await deps();
  const withNetwork = { ...d, network: ask.network } as VaultBuilderDeps;
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId(ask.network as never);
  switch (ask.ask) {
    case 'deploy': {
      const built = await buildVaultDeploy(withNetwork, { account: ask.account });
      return { id: ask.id, ok: true, ask: 'deploy', vault: built.vault, temporaryKey: built.temporaryKey, tx: toBase64(built.proven) };
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
    case 'choose-note': {
      const note = chooseNoteForPayment({ notes: ask.notes, token: ask.token, amount: ask.amount });
      return { id: ask.id, ok: true, ask: 'choose-note', note };
    }
    case 'payments-fit': {
      return { id: ask.id, ok: true, ask: 'payments-fit', answer: paymentsFitNotes({ notes: ask.notes, payments: ask.payments }) };
    }
    case 'after-payment': {
      const notes = poolAfterPayment({
        notes: ask.notes, spent: ask.spent, amount: ask.amount, change: ask.change, createdIn: ask.createdIn,
      });
      return { id: ask.id, ok: true, ask: 'after-payment', notes };
    }
    case 'confirm-payment': {
      const confirmation = await confirmPayment({
        vault: ask.vault, transactionHash: ask.transactionHash, change: ask.change, events: ask.events,
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
        note: ask.note, events: ask.events,
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
    case 'commitments': {
      /* The two commitments a coin has: as an output the ledger records, and as the note the vault holds. */
      const [{ compiledOutputCommitment }, { commitmentForNote }] = await Promise.all([
        import('../midnight/rebuild-from-records.js'),
        import('../midnight/vault-recovery.js'),
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

export const startVaultWorker = (scope: any): void => {
  const deps = loadDeps(scope);
  scope.addEventListener('message', (event: MessageEvent) => {
    const ask = event.data as VaultAsk;
    if (typeof ask !== 'object' || ask === null || typeof ask.id !== 'number') return;
    void answerVaultAsk(deps, ask).then(
      (answer) => scope.postMessage(answer),
      (e: unknown) => scope.postMessage({ id: ask.id, ok: false, error: String((e as { message?: unknown })?.message ?? e) }),
    );
  });
  scope.postMessage({ kind: 'vault-worker-ready' });
};

declare const self: any;
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof self.window === 'undefined') {
  startVaultWorker(self);
}

/**
 * **THE PAGE'S SIDE OF THE VAULT WORKER.** One request, one answer, matched by
 * id. The page never loads what the worker loads; it only sends what to build
 * and receives proven bytes back.
 */
import type { Committee } from '../midnight/vault-committee.js';

export interface SigningKeyOnTheWire { readonly tag: string; readonly value: string }
export interface CoinOnTheWire { readonly nonce: string; readonly token: string; readonly value: string }

export type VaultAsk =
  | { id: number; network: string; ask: 'deploy'; account: string }
  | { id: number; network: string; ask: 'handover'; vault: string; counter: string; temporaryKey: SigningKeyOnTheWire; to: Committee }
  | { id: number; network: string; ask: 'deposit'; vault: string; coin: CoinOnTheWire; state: string }
  | { id: number; network: string; ask: 'commitments'; vault: string; coin: CoinOnTheWire };

type Answered<A extends VaultAsk['ask'], T> = { id: number; ok: true; ask: A } & T;

export type VaultAnswer =
  | Answered<'deploy', { vault: string; temporaryKey: SigningKeyOnTheWire; tx: string }>
  | Answered<'handover', { tx: string }>
  | Answered<'deposit', { tx: string }>
  | Answered<'commitments', { output: string; held: string }>
  | { id: number; ok: false; error: string };

type Without<T> = T extends unknown ? Omit<T, 'id' | 'network'> : never;
export type VaultRequest = Without<VaultAsk>;

/** What the page needs from wherever vault transactions are built. */
export interface VaultBuilderClient {
  deploy(account: string): Promise<{ vault: string; temporaryKey: SigningKeyOnTheWire; tx: string }>;
  handover(input: { vault: string; counter: bigint; temporaryKey: SigningKeyOnTheWire; to: Committee }): Promise<{ tx: string }>;
  deposit(input: { vault: string; coin: CoinOnTheWire; state: string }): Promise<{ tx: string }>;
  commitments(input: { vault: string; coin: CoinOnTheWire }): Promise<{ output: string; held: string }>;
}

interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** A client over a started worker. `network` is the deployment's own network name. */
export function vaultBuilderOver(worker: WorkerLike, network: string): VaultBuilderClient {
  let next = 1;
  const waiting = new Map<number, { resolve: (a: VaultAnswer) => void }>();
  worker.addEventListener('message', (event) => {
    const a = event.data as VaultAnswer;
    if (typeof a !== 'object' || a === null || typeof (a as { id?: unknown }).id !== 'number') return;
    const w = waiting.get(a.id);
    if (w === undefined) return;
    waiting.delete(a.id);
    w.resolve(a);
  });
  const ask = async <A extends VaultAsk['ask']>(request: VaultRequest & { ask: A }) => {
    const id = next;
    next += 1;
    const answered = new Promise<VaultAnswer>((resolve) => waiting.set(id, { resolve }));
    worker.postMessage({ ...request, id, network });
    const a = await answered;
    if (a.ok !== true) throw new Error((a as { error: string }).error);
    if (a.ask !== request.ask) throw new Error('the vault worker answered a different question.');
    return a as Extract<VaultAnswer, { ask: A }>;
  };
  return {
    deploy: async (account) => {
      const a = await ask({ ask: 'deploy', account });
      return { vault: a.vault, temporaryKey: a.temporaryKey, tx: a.tx };
    },
    handover: async (input) => {
      const a = await ask({
        ask: 'handover', vault: input.vault, counter: input.counter.toString(),
        temporaryKey: input.temporaryKey, to: input.to,
      });
      return { tx: a.tx };
    },
    deposit: async (input) => {
      const a = await ask({ ask: 'deposit', ...input });
      return { tx: a.tx };
    },
    commitments: async (input) => {
      const a = await ask({ ask: 'commitments', ...input });
      return { output: a.output, held: a.held };
    },
  };
}

/** The worker, started the way the page starts it, and a client over it once it says it is ready. */
export function startVaultBuilder(network: string): Promise<VaultBuilderClient> {
  const worker = new Worker(new URL('./vault-worker-entry.js', import.meta.url), { type: 'module', name: 'vault-builder' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the part of this page that builds vault transactions did not start.')), 30_000);
    worker.addEventListener('message', function ready(event: MessageEvent) {
      if ((event.data as { kind?: unknown } | null)?.kind !== 'vault-worker-ready') return;
      clearTimeout(timer);
      worker.removeEventListener('message', ready);
      resolve(vaultBuilderOver(worker as unknown as WorkerLike, network));
    });
    worker.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the part of this page that builds vault transactions stopped before it started.'));
    });
  });
}

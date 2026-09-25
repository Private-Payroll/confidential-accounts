/**
 * **THE PAGE'S SIDE OF THE PAYSLIP READER.** One question, one answer, matched
 * by id. The page never loads what the worker loads; it sends a company's
 * address, the payments it opened on this device, and the indexer the payee's
 * wallet named, and receives back which of those payments the company's
 * account records as made. The worker builds each payment's leaf from what is
 * sent, with the contract's own circuits; nothing it tests is taken as given.
 *
 * Nothing here talks to this application's service.
 */
import type { Hex } from '../core/crypto.js';
import type { WalletIndexer } from 'midnight-identity/profile/unlock';

/**
 * One payment as the payee's device knows it: the address its wallet
 * confirmed, the slip's ledger token and amount, and the payee's own nonce and
 * blinding. The amount travels as decimal text.
 */
export interface PayslipPayment {
  paidTo: string;
  token: Hex;
  amount: string;
  nonce: Hex;
  blinding: Hex;
}

export interface PayslipAsk {
  id: number;
  indexer: WalletIndexer;
  company: string;
  payments: PayslipPayment[];
}

/** `recorded` lines up with the payments asked about; `null` when any could not be worked out or read. */
export interface PayslipAnswer {
  id: number;
  recorded: boolean[] | null;
}

/** What the page asks the device's own reader. */
export interface ChainReader {
  recorded(indexer: WalletIndexer, company: string, payments: PayslipPayment[]): Promise<boolean[] | null>;
}

interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** A reader over a started worker. Every answer that is not a well-formed list reads as `null`. */
export function readerOver(worker: WorkerLike): ChainReader {
  let next = 1;
  const waiting = new Map<number, (recorded: boolean[] | null) => void>();
  worker.addEventListener('message', (event) => {
    const a = event.data as PayslipAnswer | null;
    if (typeof a !== 'object' || a === null || typeof a.id !== 'number') return;
    const resolve = waiting.get(a.id);
    if (resolve === undefined) return;
    waiting.delete(a.id);
    resolve(Array.isArray(a.recorded) && a.recorded.every(r => typeof r === 'boolean') ? a.recorded : null);
  });
  return {
    recorded: (indexer, company, payments) => {
      const id = next;
      next += 1;
      const answered = new Promise<boolean[] | null>((resolve) => waiting.set(id, resolve));
      worker.postMessage({ id, indexer, company, payments } satisfies PayslipAsk);
      return answered.then(r => (r !== null && r.length === payments.length ? r : null));
    },
  };
}

/** How long a read may take before the page says it cannot tell. */
export const READ_WAIT_MS = 60_000;

/**
 * The reader this page uses, started the first time it is asked for and kept.
 * A worker that does not start, or does not answer in time, answers `null`.
 */
let started: Promise<ChainReader> | null = null;
export function payslipReader(): ChainReader {
  return {
    recorded: async (indexer, company, payments) => {
      try {
        started ??= startPayslipReader();
        const reader = await started;
        return await Promise.race([
          reader.recorded(indexer, company, payments),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_WAIT_MS)),
        ]);
      } catch {
        started = null;
        return null;
      }
    },
  };
}

function startPayslipReader(): Promise<ChainReader> {
  const worker = new Worker(new URL('./payslip-worker-entry.js', import.meta.url), { type: 'module', name: 'payslip-reader' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the payslip reader did not start.')), 30_000);
    worker.addEventListener('message', function ready(event: MessageEvent) {
      if ((event.data as { kind?: unknown } | null)?.kind !== 'payslip-reader-ready') return;
      clearTimeout(timer);
      worker.removeEventListener('message', ready);
      resolve(readerOver(worker as unknown as WorkerLike));
    });
    worker.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the payslip reader stopped before it started.'));
    });
  });
}

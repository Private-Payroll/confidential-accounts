/**
 * **THE THREAD A PAYEE'S DEVICE READS ITS COMPANY'S CONTRACT ON.**
 *
 * The indexer reader and the contract's decoder are WebAssembly and are not
 * allowed on the page; they load here, the first time something is asked. The
 * page talks to it through `payslip-worker-client.ts`, one question and one
 * answer at a time, each carrying the id it answers.
 *
 * It reads from the indexer the payee's own wallet named, and sends nothing
 * anywhere else: the payments it is asked about arrive from the page, the
 * value each is recorded under is built here with the contract's own circuits
 * (`payslip-movement.ts`) and tested here, and only the contract's address
 * goes to the indexer - which does see that this device asked about it.
 */
import { publicDataProviderFor, type IndexerEndpoints } from './public-data.js';
import { recordedAt, type ContractStateSource, type ReadLedger } from './recorded-payments.js';
import type { PayslipAsk, PayslipAnswer, PayslipPayment } from './payslip-worker-client.js';
import type { Hex } from '../core/crypto.js';

/** What the answer is read with. Injectable so it can be driven without a Worker or a network. */
export interface PayslipReaderDeps {
  sourceFor(indexer: IndexerEndpoints): Promise<ContractStateSource>;
  readLedger(): Promise<ReadLedger>;
  /** The value the account records when this payment is made. */
  movementOf(payment: PayslipPayment): Promise<Hex>;
}

/* One reader per indexer for the life of the thread, rather than one per question. */
const readers = new Map<string, Promise<ContractStateSource>>();
/** What the worker reads with on a device: the indexer the wallet named, the contract's decoder, the contracts' circuits. */
export const realDeps: PayslipReaderDeps = {
  sourceFor: (indexer) => {
    const which = `${indexer.indexerUri} ${indexer.indexerWsUri}`;
    let reader = readers.get(which);
    if (reader === undefined) {
      reader = publicDataProviderFor(indexer) as unknown as Promise<ContractStateSource>;
      reader.catch(() => readers.delete(which));
      readers.set(which, reader);
    }
    return reader;
  },
  readLedger: async () => (await import('../../contracts/managed/contract/index.js')).ledger as ReadLedger,
  movementOf: async (payment) => {
    const { contractCircuits, movementOfPayslip } = await import('./payslip-movement.js');
    return movementOfPayslip(await contractCircuits(), payment);
  },
};

/** One answer for one ask. A failure of any kind answers `null`, never "not recorded". */
export const answerPayslipAsk = async (deps: PayslipReaderDeps, ask: PayslipAsk): Promise<PayslipAnswer> => {
  try {
    if (!Array.isArray(ask.payments)) return { id: ask.id, recorded: null };
    const movements: Hex[] = [];
    for (const payment of ask.payments) movements.push(await deps.movementOf(payment));
    const source = await deps.sourceFor(ask.indexer);
    const recorded = await recordedAt(source, await deps.readLedger(), ask.company, movements);
    return { id: ask.id, recorded };
  } catch {
    return { id: ask.id, recorded: null };
  }
};

export const startPayslipWorker = (scope: any, deps: PayslipReaderDeps = realDeps): void => {
  scope.addEventListener('message', (event: MessageEvent) => {
    const ask = event.data as PayslipAsk;
    if (typeof ask !== 'object' || ask === null || typeof ask.id !== 'number') return;
    void answerPayslipAsk(deps, ask).then((answer) => scope.postMessage(answer));
  });
  scope.postMessage({ kind: 'payslip-reader-ready' });
};

declare const self: any;
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof self.window === 'undefined') {
  startPayslipWorker(self);
}

/**
 * Where this browser keeps a deposit, a payment or a charge on its way, until it sees it land: sealed records in the
 * browser's own IndexedDB, each sealed under the signer's own key before it reaches the store, so the store reads none
 * of them. Each change reads and writes inside one transaction, so two tabs never keep two records in one place.
 */
import type { DepositInFlight, DepositsInFlight, PaymentInFlight, PaymentsInFlight } from './vault-operation.js';
import { sealedOnThisDevice, type InFlightOpener, type InFlightRecords, type SealedInFlight } from './in-flight-on-this-device.js';
import type { ChargeInFlight, ChargesInFlight } from './run-charged-here.js';
/**
 * **WHERE THIS BROWSER KEEPS A DEPOSIT, A PAYMENT OR A CHARGE ON ITS WAY: SEALED RECORDS
 * IN INDEXEDDB, EACH CHANGE ONE TRANSACTION.**
 *
 * Every record is sealed before it reaches here (`in-flight-on-this-device.ts`),
 * so this store holds nothing it could read. Keeping a record where none is,
 * replacing one under its claim, and forgetting one under its claim each read
 * and write inside one IndexedDB transaction, and IndexedDB runs two
 * transactions on one store one after the other, so two tabs cannot both keep
 * a record in one place or lose each other's.
 */
export function browserInFlightRecords(factory: IDBFactory = indexedDB): InFlightRecords {
  const STORE = 'sealed';
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open('vault-operations-in-flight', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('this browser would not open its record of deposits, payments and charges on their way, '
      + 'so nothing was sent and no money moved. Check that this browser lets this site store data (a private window '
      + 'may not), then try again.', { cause: req.error }));
  });
  /** One read, then at most one write, inside one transaction. */
  const step = async <T>(slot: string, decide: (there: SealedInFlight | null) => { write?: SealedInFlight | 'delete'; answer: T }): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        let answer: T;
        const read = store.get(slot);
        read.onsuccess = () => {
          const decided = decide((read.result as SealedInFlight | undefined) ?? null);
          answer = decided.answer;
          if (decided.write === 'delete') store.delete(slot);
          else if (decided.write !== undefined) store.put({ ...decided.write }, slot);
        };
        tx.oncomplete = () => resolve(answer);
        const failed = () => reject(new Error('this browser could not read or keep its record of a deposit, a payment or a charge on '
          + 'its way, so nothing was sent and no money moved. Check that this browser lets this site store data (a '
          + 'private window may not), then try again.', { cause: tx.error }));
        tx.onerror = failed;
        tx.onabort = failed;
      });
    } finally {
      db.close();
    }
  };
  return {
    get: (slot) => step(slot, (there) => ({ answer: there })),
    add: (slot, record) => step(slot, (there) => (there === null ? { write: record, answer: true } : { answer: false })),
    replace: (slot, claim, record) => step(slot, (there) => (there?.claim === claim ? { write: record, answer: true } : { answer: false })),
    remove: async (slot, claim) => { await step(slot, (there) => (there?.claim === claim ? { write: 'delete' as const, answer: undefined } : { answer: undefined })); },
  };
}

/** A deposit this signer sent from this browser and has not yet seen land, sealed under their own key. */
export const browserDepositsInFlight = (me: InFlightOpener, factory: IDBFactory = indexedDB): DepositsInFlight =>
  sealedOnThisDevice<DepositInFlight>(browserInFlightRecords(factory), me, 'deposit');

/** A payment this signer sent from this browser and has not yet seen land, sealed under their own key. */
export const browserPaymentsInFlight = (me: InFlightOpener, factory: IDBFactory = indexedDB): PaymentsInFlight =>
  sealedOnThisDevice<PaymentInFlight>(browserInFlightRecords(factory), me, 'payment');

/** A charge of a run to its vault's period this signer sent from this browser and has not yet seen land, sealed under their own key. */
export const browserChargesInFlight = (me: InFlightOpener, factory: IDBFactory = indexedDB): ChargesInFlight =>
  sealedOnThisDevice<ChargeInFlight>(browserInFlightRecords(factory), me, 'charge');

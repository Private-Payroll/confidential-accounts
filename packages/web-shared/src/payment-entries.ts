/**
 * **THE ENTRIES OF THE ACCOUNT'S RECORD OF PAYMENTS A PAYROLL RUN IS CHECKED
 * AGAINST**, worked out from the run as a device made it again. The account's
 * own circuit an entry is made with is handed in, so this loads no contract.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { payRecordNonceOf } from '../../../src/midnight/run-keys.js';
import type { RaisingHere, RunMadeHere } from './what-this-device-made.js';

/**
 * **THE ENTRIES A RUN IS CHECKED AGAINST**:
 * for each person it pays, the entry the account records once they are paid
 * for that month and kind of pay, and for an extra payment the entry of the
 * payment before it. Made with the account's own circuit (`paidOnceOf`).
 */
export const paymentEntriesOf = (
  made: Pick<RunMadeHere, 'payKey' | 'records' | 'facts' | 'retry'>, paidOnceOf: (nonce: Uint8Array) => Uint8Array,
): string[] => {
  const entry = (record: (typeof made.records)[number]): string =>
    Array.from(paidOnceOf(bytesOfHex(payRecordNonceOf(made.payKey as Hex, record))), (b) => b.toString(16).padStart(2, '0')).join('');
  const positions = made.retry ?? made.facts.map((_, i) => i);
  const out = new Set<string>();
  for (const i of positions) {
    const record = made.records[i];
    if (record === undefined) continue;
    out.add(entry(record));
    if (record.occurrence > 0) out.add(entry({ ...record, occurrence: record.occurrence - 1 }));
  }
  return [...out];
};

const bytesOfHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));


/**
 * **THE ENTRIES THE ACCOUNT RECORDS FOR EVERY PAYMENT THE COMPANY'S RECORDS
 * KNOW ABOUT**: for each leaf of every leg they hold, the entry recorded when
 * that leaf is paid, and for each person-month nonce, the entry recorded once
 * they are paid for it. Made with the account's own circuits, handed in, so
 * this loads no contract. In the order the records hold them, each once.
 */
export const knownEntriesOf = (
  raising: Pick<RaisingHere, 'knownLeaves' | 'knownNonces'>,
  circuits: { readonly paidMovementOf: (leaf: Uint8Array) => Uint8Array; readonly paidOnceOf: (nonce: Uint8Array) => Uint8Array },
): string[] => {
  const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return [...new Set([
    ...raising.knownLeaves.map((l) => hex(circuits.paidMovementOf(bytesOfHex(l.toLowerCase())))),
    ...raising.knownNonces.map((n) => hex(circuits.paidOnceOf(bytesOfHex(n.toLowerCase())))),
  ])];
};

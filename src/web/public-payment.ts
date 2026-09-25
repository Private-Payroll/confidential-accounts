import { PUBLIC_PAYMENT_SAYS } from '../core/movement.js';

/**
 * **WHETHER AN ADDRESS IS PAID PUBLICLY, READ OFF THE ADDRESS ITSELF.**
 *
 * A run pays each person in the form their address is, so the page asks the
 * address rather than any field beside it: the type segment the platform put in
 * front of the string is what the payment follows, `mn_addr` for a public
 * address and `mn_shield-addr` for a private one.
 *
 * **ONLY THE TYPE SEGMENT IS READ HERE, AND THAT IS ENOUGH FOR WHAT IT DECIDES.**
 * This chooses words on a screen, and which form of an asset's token the
 * payslips page asks about a payment in; never where money goes: every payment
 * is built from an address decoded in full, checksum and network, by the
 * service and by the device that builds it. The full decode is not done here
 * because it would put the platform's WebAssembly on the page. On the payslips
 * page the device's reader then decodes the same address in full and builds
 * the value with the details commitment of the kind it finds.
 */
export function paidPublicly(address: string | null | undefined): boolean {
  if (typeof address !== 'string') return false;
  const text = address.trim().toLowerCase();
  const separator = text.lastIndexOf('1');
  if (separator <= 0) return false;
  const type = text.slice(0, separator);
  return type === 'mn_addr' || type.startsWith('mn_addr_');
}

/** Whether a person on the roster is set up to be paid publicly. */
export const setUpPublicly = (person: { readonly address?: { readonly bech32?: string } | null }): boolean =>
  paidPublicly(person.address?.bech32);

/** Whether a run pays anybody on it publicly, by the address each payslip names. */
export const runPaysAnyonePublicly = (run: { readonly employees: ReadonlyArray<{ readonly paidTo?: string }> }): boolean =>
  run.employees.some(e => paidPublicly(e.paidTo));

/** The sentence the page shows wherever a person is set up, or a run pays anybody, publicly. */
export const PUBLIC_PAYMENT = PUBLIC_PAYMENT_SAYS;

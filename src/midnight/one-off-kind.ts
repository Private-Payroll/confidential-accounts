/**
 * **WHAT NAMES A ONE-OFF PAYMENT'S RECORD, AND ITS REFUSAL**, with nothing that
 * reads an address or the chain. The page reads one-off payments' kind and
 * version and refuses in these words, and loads none of what opening one needs
 * (`one-off-record.ts`, which decodes the payee's address), so these live here.
 */

/** The kind a one-off payment is filed under, in the company's records. */
export const ONE_OFF_KIND = 'transfer' as const;

/** A one-off is filed once, so its only version is one: every device reads that version, and believes no later one. */
export const ONE_OFF_VERSION = 1;

export class OneOffRefused extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(why, options);
    this.name = 'OneOffRefused';
  }
}

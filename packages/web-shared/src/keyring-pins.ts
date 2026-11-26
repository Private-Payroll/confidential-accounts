/*
 * THE ACCOUNT EACH COMPANY IS PINNED TO, IN THE PERSON'S SAVED KEYS: what a pin is and its one write.
 * A label does not name an account on its own: anyone can deploy a second account carrying a label they learned. So the
 * wallet pins, once, the account it read off the deploy it signed (`created`), the account the joining person confirmed
 * by comparing its fingerprint with the one their inviter gave them (`invited`), or the account its own entry in the
 * network's private registry names (`restored`), and acts for that account alone. Kept sealed with the seats, so it
 * travels with them to every device and a service holding the copy can neither read nor change it.
 */
import { isCompanyLabel } from 'midnight-identity/profile/company-label';
import type { Keyring } from './keyring-blob.js';

/** How the account was learned: off the deploy this wallet signed, confirmed by the joining person, or from the registry. */
export type PinFrom = 'created' | 'invited' | 'restored';

/** One company's account as this wallet pinned it, and when. */
export interface KeptPin {
  readonly account: string;
  readonly from: PinFrom;
  readonly at: string;
}

const HEX64 = /^[0-9a-f]{64}$/u;

/** The pin kept for `label`, or null when none is: read as kept, a malformed entry is no pin of this wallet's. */
export function pinIn(k: Keyring, label: string): KeptPin | null {
  const kept = Object.prototype.hasOwnProperty.call(k.pins ?? {}, label) ? k.pins![label] : undefined;
  if (kept === undefined || typeof kept.account !== 'string' || !HEX64.test(kept.account)) return null;
  return kept;
}

/**
 * **PINS `account` AS THE COMPANY `label`'S, ONCE.** Read inside the write: saved keys already pinning the label, to
 * this account or another, are returned as they are, so a write never moves a pin and the caller reads afterwards which
 * account holds it. Refuses only what is not a label or an account.
 */
export function withPin(k: Keyring, label: string, account: string, from: PinFrom, at: string): Keyring {
  const lower = account.toLowerCase();
  if (!isCompanyLabel(label) || !HEX64.test(lower)) throw new Error('that is not a company\'s label and account, so nothing was pinned. Nothing was changed.');
  if (pinIn(k, label) !== null) return k;
  return { ...k, pins: { ...(k.pins ?? {}), [label]: { account: lower, from, at } } };
}

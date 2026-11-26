/*
 * THE ONE READER AND THE ONE WRITER OF THE ACCOUNT A COMPANY IS PINNED TO, over the person's saved keys as the step
 * holds them. A pin is read only from the saved keys this action opened, and written only through their keep, which
 * applies the write to the copy held at that moment; a write never moves a pin, and pinning another account for a
 * label already pinned answers `another` rather than throwing in the middle of a step. A joining person's seat is
 * pinned only once they confirmed the company's fingerprint and the chain seats its leaf (`pinTheJoiner`).
 */
import { readAccountAddress, readCompanyLabel, type AccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import { pinIn, withPin, type Keyring, type PendingSeat, type PinFrom } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { StepContext } from './definition.js';

/** What the saved keys say of a label: pinned to an account, and how; no pin; or no saved keys open to say. */
export type PinRead =
  | { readonly of: 'pinned'; readonly account: AccountAddress; readonly from: PinFrom }
  | { readonly of: 'none' }
  | { readonly of: 'not-open' };

/** That the saved keys pin `label` to `account`: made only by this file, from the saved keys. */
export interface PinHeld {
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
  readonly from: PinFrom;
}

/** How a pin's write ended: the pin now held, another account already pinned for the label, or nothing to write it in. */
export type PinWritten =
  | { readonly of: 'pinned'; readonly held: PinHeld }
  | { readonly of: 'another'; readonly account: AccountAddress }
  | { readonly of: 'not-open' };

type Keys = Pick<StepContext, 'keyring'>;

const readIn = (k: Keyring, label: string): PinRead => {
  const kept = pinIn(k, label);
  const account = kept === null ? null : readAccountAddress(kept.account);
  return kept === null || account === null ? { of: 'none' } : { of: 'pinned', account, from: kept.from };
};

/** The pin the saved keys hold for `label`. */
export function pinnedFor(ctx: Keys, label: string): PinRead {
  if (ctx.keyring === null) return { of: 'not-open' };
  return readIn(ctx.keyring.open().read(), label);
}

/** The saved keys' word that `label` is pinned to `account`, or null when they pin no account or another one. */
export function pinHeldFor(ctx: Keys, label: CompanyLabel, account: AccountAddress): PinHeld | null {
  const read = pinnedFor(ctx, label);
  return read.of === 'pinned' && read.account === account.toLowerCase() ? { label, account: read.account, from: read.from } : null;
}

/**
 * **PINS `account` AS THE COMPANY `label`'S, ONCE**, kept in the saved keys before this resolves. The same pin again
 * writes nothing. A label already pinned to another account is left as it is and answered `another`.
 */
export async function pinCompany(ctx: Keys, label: string, account: string, from: PinFrom, now: () => number = Date.now): Promise<PinWritten> {
  const keyring = ctx.keyring;
  const company = readCompanyLabel(label);
  const address = readAccountAddress(String(account).toLowerCase());
  if (keyring === null || company === null || address === null) return { of: 'not-open' };
  const before = readIn(keyring.open().read(), company);
  if (before.of === 'none') await keyring.keep((k) => withPin(k, company, address, from, new Date(now()).toISOString()));
  const after = readIn(keyring.open().read(), company);
  if (after.of !== 'pinned') return { of: 'not-open' };
  return after.account === address ? { of: 'pinned', held: { label: company, account: address, from: after.from } } : { of: 'another', account: after.account };
}

/** How pinning a joining seat ended, when it did not write a pin: not confirmed by the person, or its leaf not seated. */
export type JoinerPinned = PinWritten | { readonly of: 'not-confirmed' } | { readonly of: 'not-seated' };

/**
 * **PINS THE COMPANY A JOINING SEAT WAS CONFIRMED FOR** (`invited`), with the pending seat's own label and account, once
 * the chain seats its leaf on that account: `leaf` is the seat's leaf, `leaves` the seats of `readFrom` as read. Seats
 * read from any other account pin nothing, and a pending seat the person never confirmed is never pinned.
 */
export async function pinTheJoiner(ctx: Keys, pending: PendingSeat, leaf: string, leaves: readonly string[], readFrom: string): Promise<JoinerPinned> {
  const joining = pending.joining;
  if (joining === undefined || joining.confirmed !== true) return { of: 'not-confirmed' };
  if (String(joining.account).toLowerCase() !== readFrom.toLowerCase()) return { of: 'not-seated' };
  if (!leaves.some((l) => l.toLowerCase() === leaf.toLowerCase())) return { of: 'not-seated' };
  return pinCompany(ctx, joining.label, joining.account, 'invited');
}

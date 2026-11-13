import type { ActEnded } from 'midnight-identity/profile/channel';
import { readReleasedReadKeys } from 'midnight-identity/profile/act-channel';
import type { Hex } from '../../../src/core/crypto.js';
import { isPurpose, type Purpose } from '../../../src/core/sealed-records.js';
import { actOnACompanyInTheWallet, currentUser, isSignedIn } from './keyring.js';
import type { PurposeWrapsHeld } from './purpose-wraps.js';

/**
 * **THE READ KEYS A READER'S WALLET GAVE THIS PAGE, PER COMPANY, FOR THIS VISIT.**
 *
 * A reader's page asks its wallet (`readerKeysFromTheWallet`), which believes the company's read grant in force and
 * hands over only the keys that grant wraps to the reader, for that one company. They are held here, in this tab
 * alone, for the person they were given to, and are let go as soon as nobody or somebody else is signed in. Nothing
 * here holds a company key or a reader's own key; what a page caught here opens what the grant named and no grant
 * made after it.
 */
type ReadKeys = NonNullable<ActEnded['readKeys']>;

/** The company a reader's page names: its record id, its label and the account that carries it. */
export interface ReadCompany {
  readonly accountId: string;
  readonly label: string;
  readonly account: string;
}

let heldFor: { readonly person: string; readonly byCompany: Map<string, PurposeWrapsHeld> } | null = null;

/** What is held, only while the person it was given to is signed in; anything held for another is let go first. */
const heldNow = (): Map<string, PurposeWrapsHeld> | null => {
  const person = isSignedIn() ? currentUser()?.id ?? null : null;
  if (heldFor !== null && heldFor.person !== person) heldFor = null;
  return person === null ? null : (heldFor ??= { person, byCompany: new Map() }).byCompany;
};

/**
 * The keys a wallet gave, as the reading code takes them, or null when they are for another company or name a kind of
 * record this page does not know: a page reads nothing on a release it cannot place whole.
 */
export function heldFromRelease(given: ReadKeys, accountId: string): PurposeWrapsHeld | null {
  const released = readReleasedReadKeys(given, isPurpose);
  if (released === null || released.accountId !== accountId) return null;
  const byEpoch = new Map<number, Map<Purpose, Hex>>();
  for (const [epoch, keys] of Object.entries(released.byEpoch)) {
    const at = new Map<Purpose, Hex>();
    for (const [purpose, key] of Object.entries(keys)) {
      if (!isPurpose(purpose)) return null;
      at.set(purpose, key);
    }
    byEpoch.set(Number(epoch), at);
  }
  return Object.freeze({ kind: 'purpose-wraps' as const, accountId, byEpoch, unopened: [] });
}

export type ReaderKeysAsked =
  | { readonly of: 'held'; readonly held: PurposeWrapsHeld }
  | { readonly of: 'none'; readonly refused: string | null; readonly code: string | null };

/**
 * **ASKS THE READER'S WALLET FOR THE READ KEYS ITS GRANT IN FORCE NAMES FOR `company`**, and holds them for this visit.
 * The keys are held and returned whole, or the answer is nothing: no grant in force for this reader, or the action
 * stopped, with the key of the words the wallet refused in. The wallet shows those words in its own window.
 */
export async function readerKeysFromTheWallet(company: ReadCompany, walletOrigin: string): Promise<ReaderKeysAsked> {
  const ended = await actOnACompanyInTheWallet(
    { name: 'reader-keys', record: company.accountId, company: company.label, account: company.account }, walletOrigin,
  );
  const held = ended.of === 'done' && ended.readKeys !== undefined ? heldFromRelease(ended.readKeys, company.accountId) : null;
  const none: ReaderKeysAsked = { of: 'none', refused: ended.of === 'stopped' ? ended.refused ?? null : null, code: ended.of === 'stopped' ? ended.code ?? null : null };
  const slot = heldNow();
  if (slot === null) return none;
  if (held === null) { slot.delete(company.accountId); return none; }
  slot.set(company.accountId, held);
  return { of: 'held', held };
}


export const readerKeysReleasedFor = (accountId: string): PurposeWrapsHeld | null => heldNow()?.get(accountId) ?? null;

/** The companies whose read keys the reader's wallet gave this visit: who this page may show a reader's view of. */
export const companiesReadThisVisit = (): readonly string[] => [...(heldNow()?.keys() ?? [])];

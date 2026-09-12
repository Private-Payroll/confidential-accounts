/**
 * **WHICH PARTS OF THE RECORD A CIRCUIT READS MAY BE WRITTEN DOWN, AND WHICH
 * FIVE MAY NOT.**
 *
 * -- THE RULE --------------------------------------------------------------
 *
 * The record a governed call runs against has two halves with two different
 * origins, and only one of them may ever reach a store:
 *
 *   THE SIGNER'S OWN MATERIAL   `secretKey`, `blinding`, `scope`. One person's.
 *                       It lives once, in that person's own encrypted keyring,
 *                       and is composed into the record in memory at the moment
 *                       a circuit asks for it. **It is never persisted, on any
 *                       machine, including this one.**
 *
 *   THE ACCOUNT'S HALF  which asset a call concerns, the account's asset
 *                       blinding, the salt and the change a proposal commits
 *                       to. These are staged before a call and have to survive
 *                       a proof that takes minutes and a page that may be
 *                       reloaded in the middle of it, so something durable
 *                       holds them.
 *
 * A single secret in the wrong half is a second copy of a signing key, and a
 * second copy is the thing that does not exist anywhere in this system.
 *
 * -- AND TWO MORE THAT ARE NEITHER, AND MUST NOT BE STORED EITHER ----------
 *
 * `pinnedPath` and `pinAnyLeaf` are not anybody's secret. They are the seam
 * that makes a witness answer with a membership path it was handed instead of
 * one it found, so that the contract's own checks against a forged path can be
 * exercised at all.
 *
 * **A PIN THAT OUTLIVES THE TREE IT WAS TAKEN FROM IS NOT A WRONG VALUE. IT IS
 * A SIGNER WHO CANNOT PROVE THEY ARE ONE.** The signer tree accepts only its
 * current root, so a path captured before the tree moved stops verifying, and
 * what the circuit reports is "you are not a signer on this account" - to
 * somebody who is, on a device that looks completely healthy, for as long as
 * the record survives. And a record composed partly from material another party
 * holds is a record another party can put a pin into.
 *
 * So the two are on the same list as the three, for a different reason, and the
 * list says which reason each is on it for.
 *
 * -- WHY IT IS A MODULE AND NOT A SENTENCE IN A COMMENT --------------------
 *
 * The write that would break the rule is not a write anybody would set out to
 * make. The SDK puts the record a call ran with back into the store the call
 * was configured against, after a transaction that succeeded entirely. That is
 * correct behaviour and it is invisible: nothing in this repository calls it,
 * nothing logs it, and it happens after the money has moved and the screen has
 * said so. A store handed the whole record therefore acquires a signing key on
 * the first successful call, silently, and nothing anywhere goes red.
 *
 * So the five are named ONCE, here, with the check beside them, and the
 * function that drops them returns a type that no longer has them.
 *
 * -- WHAT THIS DOES NOT DO, STATED SO NOBODY READS MORE INTO IT ------------
 *
 * **IT IS NOT A STORE, IT REACHES NONE, AND IT CANNOT STOP A WRITER THAT CALLS
 * NEITHER FUNCTION.** Nothing in this repository can notice such a writer,
 * because there is no writer of a device-side record at all yet. What this
 * removes is the possibility of a writer that MEANT to drop them and got the
 * list wrong, and it makes the day somebody adds a field to the record a day
 * something asks which half it belongs to.
 */
import type { AccountPrivateState } from '../../contracts/src/witnesses.js';

/**
 * The three that are one person's and are composed rather than stored.
 *
 * Constrained to the record's own field names, so a rename of any of them in
 * the contract's private half is a type error here rather than a list that has
 * quietly stopped naming anything.
 */
export type SignerOnlyField = Extract<keyof AccountPrivateState, 'secretKey' | 'blinding' | 'scope'>;

/** The two that forge a membership path, and must not survive a call either. */
export type ForgedPathField = Extract<keyof AccountPrivateState, 'pinnedPath' | 'pinAnyLeaf'>;

/** Everything a device may hold in memory and must never write down. */
export type NeverPersistedField = SignerOnlyField | ForgedPathField;

/**
 * The five, each with the reason it is on this list.
 *
 * A `Record` over the union rather than an array: a member added to the type
 * without a reason here does not compile, and the reason is what a later reader
 * needs in order not to move one of them back.
 */
export const NEVER_PERSISTED_FIELDS: Record<NeverPersistedField, string> = {
  /*
   * **NOT "MEMORY ONLY", AND THE DIFFERENCE MATTERS TO WHOEVER READS THIS
   * REFUSAL.** These three are written down - once - in the signer's own
   * encrypted keyring, which is where they live. What must not exist is a
   * SECOND copy of them, in the store a call's record is written to. A message
   * saying they may never be stored at all sends the next reader looking, and
   * what they find is the keyring writing one.
   */
  secretKey: "the signer's own material, which lives only in their keyring",
  blinding: "the signer's own material, which lives only in their keyring",
  scope: "the signer's own material, which lives only in their keyring",
  pinnedPath: 'a membership path that stops verifying when the signer tree moves',
  pinAnyLeaf: 'a membership path that stops verifying when the signer tree moves',
};

/** Which of the five are the signer's own material, for a refusal that says so. */
export const SIGNER_ONLY_FIELDS: Record<SignerOnlyField, true> = {
  secretKey: true,
  blinding: true,
  scope: true,
};

/** The record as it may be written down: the account's half and nothing else. */
export type PersistableAccountHalf = Omit<AccountPrivateState, NeverPersistedField>;

const ALL = Object.keys(NEVER_PERSISTED_FIELDS) as NeverPersistedField[];
const SECRETS = Object.keys(SIGNER_ONLY_FIELDS) as SignerOnlyField[];

const present = <K extends string>(record: unknown, names: readonly K[]): K[] => {
  if (record === null || typeof record !== 'object') return [];
  return names.filter((name) => Object.prototype.hasOwnProperty.call(record, name));
};

/**
 * Which of the signer's three a record still carries, in the order they are
 * declared.
 *
 * **PRESENCE, NOT TRUTHINESS.** A field that is present and empty, or present
 * and undefined, is still a field a store has been handed, and a check written
 * the obvious way lets exactly those through.
 */
export const signerSecretsIn = (record: unknown): SignerOnlyField[] => present(record, SECRETS);

/** Which of the five a record still carries. */
export const neverPersistedFieldsIn = (record: unknown): NeverPersistedField[] =>
  present(record, ALL);

/**
 * The record with everything that must not be written down removed.
 *
 * Returns a new object rather than mutating the one it was given: the record
 * passed in is the one the circuit is still reading from, and emptying it would
 * take a signer's key away from the call that is using it.
 */
export const persistableAccountHalf = <T extends object>(
  record: T,
): Omit<T, NeverPersistedField> => {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!Object.prototype.hasOwnProperty.call(NEVER_PERSISTED_FIELDS, key)) kept[key] = value;
  }
  return kept as Omit<T, NeverPersistedField>;
};

/**
 * Refuses a record that still carries any of the five, naming them, saying why
 * each one is refused, and naming what resolves it.
 *
 * `where` is what the caller was about to do, in the reader's own terms, so the
 * message says which write was stopped rather than that a rule exists.
 */
export const refuseToPersistWhatMustNotBeStored = (record: unknown, where: string): void => {
  const carried = neverPersistedFieldsIn(record);
  if (carried.length === 0) return;
  const named = carried.map((name) => `${name} (${NEVER_PERSISTED_FIELDS[name]})`).join(', ');
  throw new Error(
    `${where} was about to write something to storage that must not have a second copy there: ` +
      `${named}. Write the account half instead, with persistableAccountHalf().`,
  );
};

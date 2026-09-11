import type { Identity } from '../keys/derivation.js';
import { emptyProfile } from './model.js';
import type { Profile } from './model.js';
import { open, profileKey, profileRecordTag, seal } from './seal.js';
import type { Opened, SealedProfile } from './seal.js';

/**
 * WHERE THE SEALED PROFILE SITS.
 *
 * A `Storage`-shaped port rather than `localStorage` directly, for one reason
 * that is not testing: **`travel.ts` moves the same blob through pairing**, so
 * the reader and the writer must not know they are talking to a browser. The
 * test injecting a map is a consequence of that, not the cause of it.
 *
 * NOTHING ABOUT WHICH ACCOUNT A RECORD BELONGS TO IS WRITTEN IN THE CLEAR.
 * `storage.ts`'s subwallet record names its account with a FINGERPRINT in the
 * clear, because a wrong-account label is worse than a leaked fingerprint.
 * Here the key IS the discriminator: a blob from another account fails to
 * decrypt, so the account never has to be written down.
 *
 * ── ONE RECORD PER WALLET, AND THE ONE RECORD THAT CAME BEFORE ───────────
 *
 * This used to be ONE record per browser, at one fixed name. That was the
 * shape of a browser holding one wallet, and a browser now holds several.
 * With one record, the first wallet to save anything owned it: every other
 * wallet read a record that would not open with its key, was refused a save
 * over it, and so could never record an approval - and nothing removed the
 * record, so when the wallet that sealed it was gone, nobody could.
 *
 * So each wallet keeps its own record, under a name derived from its own
 * profile key (`profileRecordTag`). **THE RECORD AT THE OLD NAME IS NOT MOVED,
 * RE-SEALED OR DELETED.** Which wallet it belongs to is answered the only way
 * it can be, by opening it: the wallet whose key opens it goes on reading and
 * writing it exactly where it is, and for every other wallet it is somebody
 * else's and is left alone. No migration, so no moment where a record is in
 * neither place, and no record that something could open before and nothing
 * can open after.
 *
 * WHAT THIS COSTS, said rather than left to be found: a person can tell from
 * the names how many wallets in this browser have saved details, which the list
 * of wallets held here already tells them; and a record at the old name that
 * this wallet cannot open may be another wallet's or may be this wallet's own,
 * altered - AES-GCM cannot tell the two apart - so it is reported beside the
 * profile (`othersHere`) rather than as this wallet's state.
 */

const SHARED_NAME = 'midnight-identity:profile';
/** No record name this library has ever written begins with this and is not a wallet's own. */
const OWN_NAME_PREFIX = 'midnight-identity:profile:';

/** The two methods this needs. `localStorage` satisfies it as it stands. */
export interface Port {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const browserPort = (): Port => localStorage;

const parse = (raw: string): SealedProfile | null => {
  try {
    const parsed = JSON.parse(raw) as SealedProfile;
    return (typeof parsed === 'object' && parsed !== null) ? parsed : null;
  } catch {
    return null;
  }
};

const readAt = (port: Port, name: string): SealedProfile | null => {
  const raw = port.getItem(name);
  return raw === null ? null : parse(raw);
};

/** The name `identity`'s own record is kept under. */
export const recordNameFor = async (identity: Identity): Promise<string> =>
  `${OWN_NAME_PREFIX}${await profileRecordTag(identity)}`;

/**
 * The record at the name every wallet in a browser used to share, untouched.
 * **Not this wallet's record** unless it opens with this wallet's key; use
 * `sealedFor` for the blob a wallet actually reads.
 */
export const sealedIn = (port: Port): SealedProfile | null => readAt(port, SHARED_NAME);

/** Writes the record at the shared name. A test's way to put an older browser's record in place. */
export function putSealed(port: Port, blob: SealedProfile): void {
  port.setItem(SHARED_NAME, JSON.stringify(blob));
}

/**
 * **WHETHER AN OPENED RECORD IS PROVABLY THIS WALLET'S.** A profile that
 * opened is. So is a blob that DECRYPTED and then did not read as a profile:
 * AES-GCM authenticated it under this wallet's key, so this wallet sealed it.
 * A blob that did not decrypt, or is not an envelope this wallet writes, is
 * not provably anybody's.
 */
const provablyThisWallets = (state: Opened): boolean =>
  state.of === 'profile'
  || (state.of === 'unopenable' && (state.cause === 'unreadable' || state.cause === 'not-a-profile'));

/**
 * **WHERE THIS WALLET'S PROFILE IS, AND WHAT IS THERE.** The shared name when
 * the record there is provably this wallet's; otherwise this wallet's own name.
 */
async function locate(port: Port, identity: Identity, key: CryptoKey): Promise<{
  readonly name: string;
  readonly blob: SealedProfile | null;
  readonly state: Opened;
  readonly othersHere: boolean;
}> {
  const shared = sealedIn(port);
  if (shared !== null) {
    const state = await open(key, shared);
    if (provablyThisWallets(state)) return { name: SHARED_NAME, blob: shared, state, othersHere: false };
  }
  const name = await recordNameFor(identity);
  const blob = readAt(port, name);
  if (blob === null) return { name, blob, state: { of: 'none' }, othersHere: shared !== null };
  const opened = await open(key, blob);
  /*
   * A RECORD UNDER THIS WALLET'S OWN NAME THAT WILL NOT OPEN IS NOT ANOTHER
   * WALLET'S. Only a wallet holding this secret arrives at this name, so the
   * library's *belong to another account* is not the likely reading here.
   */
  const state: Opened = opened.of === 'unopenable' && opened.cause === 'another-key'
    ? {
      of: 'unopenable',
      cause: 'another-key',
      why: 'the details saved for this wallet here will not open with its key, so they are not '
        + 'what it saved: they have been changed since.',
    }
    : opened;
  return { name, blob, state, othersHere: shared !== null };
}

/**
 * What a read found: this wallet's own state, and whether the record at the
 * shared name is one this wallet cannot open. That record is reported and never
 * acted on - it may be another wallet's, and nothing here may decide it is not.
 */
export type Loaded = Opened & { readonly othersHere?: true };

export async function load(port: Port, identity: Identity): Promise<Loaded> {
  const found = await locate(port, identity, await profileKey(identity));
  return found.othersHere ? { ...found.state, othersHere: true } : found.state;
}

/** The blob this wallet reads, untouched - what `travel.ts` puts on the wire. */
export async function sealedFor(port: Port, identity: Identity): Promise<SealedProfile | null> {
  return (await locate(port, identity, await profileKey(identity))).blob;
}

/**
 * WRITING, AND THE ONE THING IT REFUSES.
 *
 * **A save over an `unopenable` record is refused unless it is asked for by
 * name.** The rule: a read that turns damage into absence lets the next write
 * destroy what it could not read. Here that would be somebody's whole profile —
 * their own facts, and any attestation that cost them money and time — replaced
 * by an empty one because a key did not match. The person is shown the state
 * and decides; the code does not decide for them.
 *
 * **AND A SAVE NEVER WRITES ANOTHER WALLET'S RECORD, ASKED FOR OR NOT.** It
 * writes the shared name only when the record there is provably this wallet's,
 * and otherwise this wallet's own name, which no other wallet reads.
 * `replacingUnopenable` can replace this wallet's own damaged record and
 * nothing else.
 */
export type SaveFailure = 'would-overwrite-unopenable';

export class StoreError extends Error {
  readonly code: SaveFailure;
  constructor(code: SaveFailure, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export async function save(
  port: Port, identity: Identity, profile: Profile,
  options: { readonly replacingUnopenable?: boolean } = {},
): Promise<void> {
  const key = await profileKey(identity);
  const found = await locate(port, identity, key);
  if (found.state.of === 'unopenable' && options.replacingUnopenable !== true) {
    throw new StoreError(
      'would-overwrite-unopenable',
      'there are details stored here that this account cannot open. Saving over them '
      + 'would destroy them. Nothing has been written.');
  }
  port.setItem(found.name, JSON.stringify(await seal(key, profile)));
}

/**
 * Listed in the danger section's *what this clears* — §4's table, last row.
 * Clears THIS wallet's profile: its own record, and the shared one only when
 * that is provably this wallet's. Another wallet's record is not this wallet's
 * to clear.
 */
export async function forgetProfile(port: Port, identity: Identity): Promise<void> {
  const key = await profileKey(identity);
  const shared = sealedIn(port);
  if (shared !== null && provablyThisWallets(await open(key, shared))) port.removeItem(SHARED_NAME);
  port.removeItem(await recordNameFor(identity));
}

/**
 * The profile to work from: what is stored, or a new empty one. **Never called
 * on an `unopenable` record** — the screen shows that state rather than
 * quietly starting again.
 */
export async function loadOrEmpty(
  port: Port, identity: Identity, now: number,
): Promise<{ readonly profile: Profile; readonly state: Loaded }> {
  const state = await load(port, identity);
  return {
    state,
    profile: state.of === 'profile' ? state.profile : emptyProfile(now),
  };
}

import type { Identity } from '../keys/derivation.js';
import { emptyProfile } from './model.js';
import type { Profile } from './model.js';
import { open, profileKey, seal } from './seal.js';
import type { Opened, SealedProfile } from './seal.js';

/**
 * WHERE THE SEALED PROFILE SITS.
 *
 * A `Storage`-shaped port rather than `localStorage` directly, for one reason
 * that is not testing: **`travel.ts` moves the same blob through pairing**, so
 * the reader and the writer must not know they are talking to a browser. The
 * test injecting a map is a consequence of that, not the cause of it.
 *
 * ONE RECORD PER BROWSER, NOT ONE PER ACCOUNT — and this is the discipline
 * applied honestly rather than copied. `storage.ts`'s subwallet record names
 * its account with a FINGERPRINT in the clear, because a wrong-account label is
 * worse than a leaked fingerprint. Here the key IS the discriminator: a blob
 * from another account fails to decrypt, so nothing about which account this is
 * has to be written down in the clear at all. The cost is that *another
 * account's* and *damaged* are one state (`unopenable`), which `seal.ts`'s
 * header argues is the right trade because a person is told the same sentence
 * either way.
 */

const KEY = 'midnight-identity:profile';

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

/** The stored blob, untouched — what `travel.ts` puts on the wire. */
export const sealedIn = (port: Port): SealedProfile | null => {
  const raw = port.getItem(KEY);
  return raw === null ? null : parse(raw);
};

export function putSealed(port: Port, blob: SealedProfile): void {
  port.setItem(KEY, JSON.stringify(blob));
}

export async function load(port: Port, identity: Identity): Promise<Opened> {
  const blob = sealedIn(port);
  if (blob === null) return { of: 'none' };
  return open(await profileKey(identity), blob);
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
  const existing = sealedIn(port);
  if (existing !== null && options.replacingUnopenable !== true) {
    const state = await open(key, existing);
    if (state.of === 'unopenable') {
      throw new StoreError(
        'would-overwrite-unopenable',
        'there are details stored here that this account cannot open. Saving over them '
        + 'would destroy them. Nothing has been written.');
    }
  }
  putSealed(port, await seal(key, profile));
}

/** Listed in the danger section's *what this clears* — §4's table, last row. */
export const forgetProfile = (port: Port): void => port.removeItem(KEY);

/**
 * The profile to work from: what is stored, or a new empty one. **Never called
 * on an `unopenable` record** — the screen shows that state rather than
 * quietly starting again.
 */
export async function loadOrEmpty(
  port: Port, identity: Identity, now: number,
): Promise<{ readonly profile: Profile; readonly state: Opened }> {
  const state = await load(port, identity);
  return {
    state,
    profile: state.of === 'profile' ? state.profile : emptyProfile(now),
  };
}

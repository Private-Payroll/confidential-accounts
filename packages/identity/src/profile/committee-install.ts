/**
 * Which committee may be installed on a contract: the one rule every wallet, device and service door asks.
 */
import { schnorr } from '@noble/curves/secp256k1.js';

export const COMMITTEE_KEY = /^[0-9a-fA-F]{64}$/u;

/** One reason a committee may not be installed on a contract: a code a caller compares and the sentence a person reads. */
export interface CommitteeInstallRefusal {
  readonly code:
    | 'malformed-committee-key'
    | 'repeated-committee-member'
    | 'threshold-below-one'
    | 'threshold-above-committee'
    | 'committee-emptied';
  /** Starts in lower case and ends with a full stop, so a caller can put its own words in front of it. */
  readonly why: string;
}

/**
 * Whether `value` is a key the chain builds a committee with and a wallet
 * derives: a schnorr key, thirty-two bytes of hex that name a point on the
 * curve. The chain refuses any other length, and an x with no point, when the
 * authority is built; it would take an ecdsa key too, but no wallet derives
 * one, so no wallet could sign for it or for a committee holding it.
 */
const isWalletCommitteeKey = (tag: string, value: string): boolean => {
  if (tag !== 'schnorr' || !COMMITTEE_KEY.test(value)) return false;
  try {
    schnorr.utils.lift_x(BigInt(`0x${value}`));
    return true;
  } catch {
    /* lift_x throws only for an x that names no point on the curve, which is the answer: not a key a wallet derives. */
    return false;
  }
};

/**
 * **THE ONE RULE FOR WHICH COMMITTEE MAY BE INSTALLED ON A CONTRACT.** This
 * wallet asks it before it signs a committee change, and every device and
 * service door that builds, checks or pays for a change of who holds a
 * contract asks it too, so no door installs or funds what another refuses.
 *
 * A committee may be installed when every key is a schnorr key a wallet
 * derives (sixty-four hex digits naming a point on the curve), no key appears
 * twice (compared by digits, case folded), and the threshold is a whole number
 * from one to the number of keys. Several keys at a threshold of one are allowed:
 * which of the company's super admins may act alone is the company's choice.
 *
 * The chain checks none of this but the key's length and point when it
 * installs a committee: at a threshold of zero anybody can change the contract
 * with no signature at all; at a threshold above the number of keys nobody ever
 * can again; and a key listed twice signs once and counts at every place it
 * holds. Returns every reason at once, so a person fixes them
 * together, and an empty list when the committee may be installed. Anything at
 * all may be passed: a value that is not a list of keys, or a key that is not
 * a pair of strings, is a refusal and never a thrown error.
 */
export function committeeInstallRefusals(committee: unknown, threshold: unknown): readonly CommitteeInstallRefusal[] {
  const out: CommitteeInstallRefusal[] = [];
  const keys: readonly unknown[] = Array.isArray(committee) ? committee : [];
  if (!Array.isArray(committee)) {
    out.push({ code: 'malformed-committee-key', why: 'the committee is not a list of keys. Name the keys that are to hold the contract.' });
  }
  const seen = new Map<string, number>();
  keys.forEach((k, i) => {
    const key = k as { tag?: unknown; value?: unknown } | null;
    const tag = typeof key === 'object' && key !== null && typeof key.tag === 'string' ? key.tag : null;
    const value = typeof key === 'object' && key !== null && typeof key.value === 'string' ? key.value : null;
    if (tag === null || value === null || !isWalletCommitteeKey(tag, value)) {
      out.push({
        code: 'malformed-committee-key',
        why: `key ${i + 1} is not a schnorr key a wallet derives - sixty-four hex digits naming a point on the curve - so `
          + 'nobody could sign for that place. Name it by the key its holder\'s wallet gives.',
      });
    }
    if (tag === null || value === null) return;
    const id = `${tag.toLowerCase()}:${value.toLowerCase()}`;
    const first = seen.get(id);
    if (first === undefined) { seen.set(id, i); return; }
    out.push({
      code: 'repeated-committee-member',
      why: `keys ${first + 1} and ${i + 1} are the same key, so its holder would sign once and count at both places, and `
        + 'the threshold would need fewer people than it reads as. Name each key once.',
    });
  });
  const whole = typeof threshold === 'number' && Number.isInteger(threshold);
  if (!whole || (threshold as number) < 1) {
    out.push({
      code: 'threshold-below-one',
      why: `a threshold of ${String(threshold)} is not a whole number of at least one, and at zero anybody could change the `
        + 'contract\'s rules with no signature at all. Choose a whole number from 1 to the number of keys.',
    });
  }
  if (keys.length === 0) {
    out.push({
      code: 'committee-emptied',
      why: 'the committee holds no keys, so nobody could ever change the contract\'s rules again. Name at least one key.',
    });
  }
  if (whole && (threshold as number) > keys.length) {
    out.push({
      code: 'threshold-above-committee',
      why: `a threshold of ${threshold as number} over ${keys.length} key${keys.length === 1 ? '' : 's'} can never be met, so nobody `
        + `could ever change the contract's rules again. Choose a threshold from 1 to ${keys.length}.`,
    });
  }
  return out;
}

/**
 * **THE FIRST REASON `committeeInstallRefusals` GIVES FOR A COMMITTEE VALUE**, or
 * null when it may be installed: `committeeInstallRefusals` for a door that
 * puts one sentence in front of a person and stops.
 */
export const whyNotInstallable = (c: { readonly committee: unknown; readonly threshold: unknown }): string | null =>
  committeeInstallRefusals(c.committee, c.threshold)[0]?.why ?? null;

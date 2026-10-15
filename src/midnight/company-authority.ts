/**
 * **WHO HOLDS A COMPANY'S RULES: ITS ACCOUNT AND EVERY VAULT, AS THE CHAIN
 * SAYS, AND ONE CONTRACT'S COMMITTEE UPDATE PUT TOGETHER FROM ITS COMMITTEE'S
 * OWN SIGNATURES.**
 *
 * Every contract a company has carries its own maintenance authority: a list of
 * signature keys and how many of them must sign a change to the contract's
 * rules. Whoever meets that threshold can replace the proofs the contract
 * accepts. On the company account that is every vault's money at once, because
 * a vault pays out on the account's approval and the account's approval is a
 * proof the account's rules decide.
 *
 * The committee holding the company's account on the chain is its super
 * admins' keys at their own threshold, and every vault is to hold the same one.
 * This file answers, per contract and from the chain alone, whether a contract
 * holds that committee, and which places on it are held by keys that committee
 * does not have. No signer, seat or roster is read.
 *
 * **WHAT NOTHING HERE CAN MAKE TRUE.** The chain checks only signatures. A
 * change the super admins agreed to and a change enough key-holders signed
 * without asking anybody look the same to it. No sentence built from this file
 * may say the chain required the company's approval.
 *
 * Imports nothing that loads WebAssembly: the ledger's classes are handed in.
 */
import type { AuthorityRead, AuthorityShape, MaintenanceSignature } from './ledger.js';
import { compareAuthority } from './ledger.js';
import type { Committee, CommitteeKey } from './vault-committee.js';
import { committeeUpdateOf, type CommitteeUpdateLedger } from 'midnight-identity/profile/committee-sign';
import { whyNotInstallable } from 'midnight-identity/profile/request';

const idOf = (k: { tag: string; value: string }): string => `${k.tag.toLowerCase()}:${k.value.toLowerCase()}`;

/* ------------------------------------------------------------- the seats */

/** One seat on a contract's committee, as the chain holds it. */
export interface Seat {
  readonly key: CommitteeKey;
  /** The signer who gave this key for this company and is on it now, or `null` when nobody on the company did. */
  readonly holder: string | null;
  /** Whether this is the temporary key this service itself keeps. */
  readonly thisService: boolean;
  /** Whether this key is on the company's committee as it stands now. */
  readonly onTheCompanysCommittee: boolean;
}

export type ContractKind = 'account' | 'vault';

/** What a company is shown about one of its contracts. */
export interface ContractAuthorityView {
  readonly contract: ContractKind;
  readonly address: string;
  /** Whether the chain answered, and the answer could be read. */
  readonly read: AuthorityRead['state'];
  readonly seats: readonly Seat[];
  readonly threshold: number | null;
  /** How many times this contract's rules have been changed. */
  readonly changes: string | null;
  readonly shape: AuthorityShape | null;
  /** `true` only when the chain carries exactly the company's committee. */
  readonly heldByTheCompany: boolean;
  /**
   * **SEATS HELD BY A KEY THE COMPANY'S COMMITTEE DOES NOT HAVE.** A signer who
   * has left keeps their seat on every contract nobody has changed since, and
   * the chain accepts their signature there exactly as before.
   */
  readonly seatsOutsideTheCommittee: number;
  readonly why: string;
}

/**
 * **ONE CONTRACT'S AUTHORITY, AS A COMPANY READS IT.**
 *
 * `holders` maps a committee key to the signer on the company now who gave it.
 * A seat whose key nobody on the company now gave - a signer who has left, or
 * a key nobody here ever gave - has no holder, and is counted as outside the
 * committee. `serviceKey` is the temporary key this service keeps, when it
 * keeps one, so that seat is named as this service's rather than as nobody's.
 */
export function authorityView(
  contract: ContractKind,
  read: AuthorityRead,
  committee: Committee | null,
  holders: ReadonlyMap<string, string>,
  serviceKey: CommitteeKey | null = null,
): ContractAuthorityView {
  const base = { contract, address: read.address, read: read.state };
  if (read.state !== 'read') {
    return {
      ...base, seats: [], threshold: null, changes: null, shape: null, heldByTheCompany: false,
      seatsOutsideTheCommittee: 0,
      why: `the chain could not be asked who holds this ${contract}'s rules: ${read.why}`,
    };
  }
  const current = new Set((committee?.committee ?? []).map(idOf));
  const seats = read.authority.committee.map((k) => ({
    key: { tag: k.tag, value: k.value },
    holder: holders.get(idOf(k)) ?? null,
    thisService: serviceKey !== null && idOf(serviceKey) === idOf(k),
    onTheCompanysCommittee: current.has(idOf(k)),
  }));
  const outside = seats.filter((s) => !s.onTheCompanysCommittee).length;
  const ours = seats.some((s) => s.thisService);
  const verdict = committee === null
    ? null
    : compareAuthority(read, { committee: committee.committee.map((k) => ({ ...k })), threshold: committee.threshold });
  const held = verdict?.verdict === 'agree';
  const why = read.authority.shape === 'anyone'
    ? `ANYBODY can change this ${contract}'s rules: its threshold is ${read.authority.threshold}, so a change `
      + 'needs no signature at all.'
    : held
      ? `the company's committee holds this ${contract}: ${committee!.committee.length} key(s), `
        + `${committee!.threshold} of them needed to change its rules.`
      : ours
        ? `THIS SERVICE'S temporary key holds this ${contract}'s rules, so this service could change them `
          + (contract === 'account' ? 'and with them what every vault of the company pays out. ' : 'on its own. ')
          + 'Hand it to the company\'s committee.'
        : committee === null
          ? `no committee holds this company's account on the chain yet, so nothing can be compared with this ${contract}.`
        : outside > 0
          ? `${outside} seat(s) on this ${contract} are held by a key that is not on the company's committee now. `
            + 'Whoever holds those keys can still sign changes to its rules, alone or with others, until the '
            + `${contract} is changed.`
          : `this ${contract} is not held by the company's committee as it stands now: ${verdict!.why}`;
  return {
    ...base,
    seats,
    threshold: read.authority.threshold,
    changes: String(read.authority.counter),
    shape: read.authority.shape,
    heldByTheCompany: held,
    seatsOutsideTheCommittee: outside,
    why,
  };
}

/* ------------------------------------------------ one update, as the wallet signs it */

/** A committee update as the ledger's class makes it: the bytes signed over, and a copy with one more signature. */
interface SignableUpdate {
  readonly dataToSign: Uint8Array;
  addSignature(index: bigint, signature: MaintenanceSignature): SignableUpdate;
}

/** The ledger a committee update is put together and checked with. `@midnightntwrk/ledger-v9` satisfies it. */
export interface CommitteeChangeLedger extends CommitteeUpdateLedger {
  verifySignature(key: never, data: Uint8Array, signature: never): boolean;
  Intent: { new: (ttl: Date) => { addMaintenanceUpdate(update: unknown): unknown } };
  Transaction: { fromParts(network: string, guaranteed: undefined, fallible: undefined, intent: unknown): unknown };
}

/** One signature on a contract's update: the place on the committee holding the contract now, and what was signed there. */
export interface PlaceSignature {
  readonly index: number;
  readonly signature: MaintenanceSignature;
}

/**
 * **THE SIGNATURES THAT COUNT ON ONE UPDATE**: each at a place on `holders` -
 * the committee holding the contract on the chain now - that verifies under
 * that place's key over `data`, one per place, in increasing order of place,
 * which is the only order the ledger takes. A signature at a place outside the
 * committee, a second one at a place, or one that does not verify counts for
 * nothing, so a list a fee is paid for never carries an entry the chain would
 * refuse it for.
 */
export function signaturesThatCount(
  L: Pick<CommitteeChangeLedger, 'verifySignature'>, data: Uint8Array,
  holders: readonly CommitteeKey[], signatures: readonly PlaceSignature[],
): PlaceSignature[] {
  const byPlace = new Map<number, MaintenanceSignature>();
  for (const s of signatures) {
    if (!Number.isSafeInteger(s.index) || s.index < 0 || byPlace.has(s.index)) continue;
    const key = holders[s.index];
    if (key === undefined) continue;
    let good = false;
    try { good = L.verifySignature(key as never, data, { tag: s.signature.tag, value: s.signature.value } as never); } catch { good = false; }
    if (good) byPlace.set(s.index, { tag: s.signature.tag, value: s.signature.value });
  }
  return [...byPlace].sort(([a], [b]) => a - b).map(([index, signature]) => ({ index, signature }));
}

/* ----------------------------------------------- a committee changed after */

/**
 * **ONE CONTRACT'S COMMITTEE UPDATE, PUT TOGETHER FROM THE SIGNATURES ITS
 * COMMITTEE'S WALLETS MADE.** The update is `committeeUpdateOf`'s: `to`
 * installed at the counter the chain holds the contract at now, the bytes every
 * wallet signs. Only the signatures that verify under the committee holding
 * the contract on the chain count (`signaturesThatCount`), and the transaction
 * comes back, unproven, only once they reach that committee's threshold on the
 * chain - the only count the ledger makes. A contract that already holds `to`
 * is built for like any other, so a change moves its counter too.
 *
 * **NO KEY IS A PARAMETER OF THIS FUNCTION**, and no signer, seat, bar or band
 * is read: who may change a contract is its committee's alone. Refused before
 * anything is built: a contract the chain could not be asked about, and a
 * committee the one install rule refuses.
 */
export function buildCommitteeChange(
  L: CommitteeChangeLedger,
  input: {
    readonly read: AuthorityRead;
    readonly to: Committee;
    readonly signatures: readonly PlaceSignature[];
    readonly network: string;
    readonly ttl: Date;
    readonly label: string;
  },
): {
  readonly have: number;
  readonly required: number;
  readonly indexesSigned: number[];
  /** The signatures that count, one per place, in increasing order of place. */
  readonly counted: PlaceSignature[];
  readonly unproven: unknown | null;
} {
  const { read } = input;
  if (read.state !== 'read') {
    throw new Error(`the chain could not be asked who holds ${input.label}'s rules (${read.why}), so nothing was built.`);
  }
  const notInstallable = whyNotInstallable({ committee: input.to.committee, threshold: input.to.threshold });
  if (notInstallable !== null) throw new Error(`the committee will not be changed: ${notInstallable}`);
  let update = committeeUpdateOf(L, {
    address: read.address, counter: read.authority.counter,
    to: { committee: input.to.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: input.to.threshold },
  }) as unknown as SignableUpdate;
  const counted = signaturesThatCount(L, update.dataToSign, read.authority.committee, input.signatures);
  for (const s of counted) update = update.addSignature(BigInt(s.index), s.signature);
  const required = read.authority.threshold;
  return {
    have: counted.length,
    required,
    indexesSigned: counted.map((s) => s.index),
    counted,
    unproven: counted.length >= required
      ? L.Transaction.fromParts(input.network, undefined, undefined, L.Intent.new(input.ttl).addMaintenanceUpdate(update))
      : null,
  };
}

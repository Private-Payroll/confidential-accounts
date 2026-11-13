/**
 * **A CHANGE OF THE READ GRANTS, SIGNED AND FILED BY A SEAT'S WALLET, AND THE GRANTS WRAPPED AGAIN.** The filing half of
 * the grants: it signs with the seat's filing key, so only the wallet runs it, never the page. Reading and judging the
 * grants is `purpose-wraps.ts`'s.
 */
import { canonical, sign, signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import { purposeKey } from '../../../src/core/sealed-records.js';
import {
  carriedFrom, entriesInOrder, grantsMessage, purposeWrapsFor, readersHandedInFor, sealGrants, takesAway, type GrantEntry, type ReadersHandedIn,
} from '../../../src/midnight/grants-record.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { barReadable, quorumOf } from '../../../src/midnight/seat-quorum.js';
import type { PoolSigner } from '../../../src/midnight/vault-pool.js';
import type { CompanyKeyHere } from './company-key-here.js';
import { grantsHere, type GrantsDoors } from './purpose-wraps.js';

/** What filing a version of the grants needs beyond reading them: this seat's filing key, the company's keys, the seats it is sealed to, and its filing. */
export interface GrantsFilingDoors extends GrantsDoors {
  readonly signingSecret: Hex;
  readonly keys: Pick<CompanyKeyHere, 'epoch' | 'newest' | 'keyAt'>;
  /** The seats this device believes, each with its records key: every version is sealed to them. */
  readonly seats: () => Promise<readonly PoolSigner[]>;
  /** Signs, files and enters one version; throws with the service's words when it is not filed. */
  readonly file: (rec: SealedCompanyRecord) => Promise<void>;
}

/** Why this device files no version of the grants, in words that say what puts it right. */
export class GrantsNotFiled extends Error {
  constructor(why: string) {
    super(`${why}. Nothing was filed.`);
    this.name = 'GrantsNotFiled';
  }
}

/** What a seat asks: give a read grant, or take one away from the recipient named. */
export type GrantsAsked = { readonly give: GrantEntry } | { readonly takeAway: string };

/** What filing a change of the grants came to: in force, or waiting for more signers; or nothing to change. */
export interface GrantsChangeFiled {
  readonly state: 'in-force' | 'waiting-for-signers' | 'already';
  /** How many signers' wallets have signed it, and how many it needs: the chain's seat bar. */
  readonly by: number;
  readonly needed: number;
  /** Whether it takes anything away: the company's key is then owed a change. */
  readonly takesAway: boolean;
  /** The list of readers the service keeps for it, with the signatures that put it in force. */
  readonly readers: ReadersHandedIn;
}

const wrapsOf = (doors: Pick<GrantsFilingDoors, 'accountId' | 'keys'>, entries: readonly GrantEntry[]) =>
  purposeWrapsFor(entries, (epoch, purpose) => purposeKey(doors.keys.keyAt(epoch), doors.accountId, purpose), doors.keys.newest);

const UNREAD_BAR = 'who holds the company\'s account was read without the approvals a change of who is seated needs, so no signature '
  + 'is counted. Reload the page';
const NOT_SIGNED = 'a signature gathered on this change of the read grants does not verify, or one seat signed it twice, so this seat '
  + 'does not add its own. Reload the page and sign the change again from your wallet';
const NO_NEWEST_KEY = 'this seat holds no copy of the company\'s newest key, so it wraps no purpose key of it to a reader; a signer who holds it files the grants';

/**
 * **A CHANGE OF THE READ GRANTS, SIGNED IN THIS SEAT'S WALLET AND FILED.** The change asked of the grants in force: when
 * a change still gathering signatures asks exactly the same, this seat's signature joins its signatures; otherwise this
 * seat's alone starts it. Once its signatures reach the bar, every purpose key each entry reads is wrapped to it for
 * every key epoch up to the newest; below the bar, only entries already in force are, so a recipient the quorum has not
 * agreed to holds no key. The version is sealed to every seat this device believes, every recipient it wraps keys
 * to, and, once the change is in force, every recipient it takes away, with no key, so that reader's own wallet can
 * tell it is taken away. Refused while this seat holds no copy of the newest key (what clears that is a signer who holds it), while the
 * chain's bar is not read, or when a signature gathered on the change does not verify (a reload clears both: the read
 * drops a version whose signatures do not verify).
 */
export async function grantsChangeFiledHere(doors: GrantsFilingDoors, asked: GrantsAsked): Promise<GrantsChangeFiled> {
  const g = await grantsHere(doors);
  const base = g.inForce?.grants.entries ?? [];
  const entries = entriesInOrder('give' in asked
    ? [...base.filter((e) => e.recipient !== asked.give.recipient && e.person !== asked.give.person), asked.give]
    : base.filter((e) => e.recipient !== asked.takeAway.toLowerCase()));
  /* `grantsHere` read the grants only with a readable bar; one never counts as 1 here either. */
  if (!barReadable(g.here.holders)) throw new GrantsNotFiled(UNREAD_BAR);
  const needed = Number(g.here.holders.seatBar);
  const sequence = (g.inForce?.grants.sequence ?? 0) + 1;
  if (canonical(entries) === canonical(base)) {
    const now = { sequence: g.inForce?.grants.sequence ?? 0, entries: base };
    return { state: 'already', by: needed, needed, takesAway: false, readers: readersHandedInFor(now, g.inForce?.grants.signatures ?? []) };
  }
  if (doors.keys.epoch < doors.keys.newest) throw new GrantsNotFiled(NO_NEWEST_KEY);
  const message = grantsMessage(doors.accountId, { sequence, entries });
  const mine = { publicKey: signingPublicKeyOf(doors.signingSecret).toLowerCase() as Hex, signature: sign(message, doors.signingSecret) };
  const waiting = g.waiting?.grants;
  const gathered = waiting !== undefined && waiting.sequence === sequence && canonical(waiting.entries) === canonical(entries)
    ? waiting.signatures.filter((x) => x.publicKey !== mine.publicKey) : [];
  const signatures = [...gathered, mine];
  const counted = quorumOf(g.here.dir.seats, message, signatures, (seat) => g.here.holders.seats.includes(seat.seat));
  if (typeof counted === 'string') throw new GrantsNotFiled(NOT_SIGNED);
  const by = counted;
  /* Below the bar, keys go only to the entries already in force: the signer whose signature reaches it wraps a new recipient's. */
  const grants = { sequence, entries, signatures, wraps: wrapsOf(doors, by >= needed ? entries : carriedFrom(base, entries)) };
  /* A reader taken away is sealed the change only once it is in force, so a change still waiting tells it nothing. */
  const told = by >= needed ? base.filter((b) => !entries.some((e) => e.recipient === b.recipient)) : [];
  await doors.file(sealGrants({ company: doors.accountId, version: g.highest + 1, keyEpoch: doors.keys.newest, grants, seats: await doors.seats(), told }));
  return {
    state: by >= needed ? 'in-force' : 'waiting-for-signers', by, needed, takesAway: takesAway(base, entries),
    readers: readersHandedInFor(grants, grants.signatures),
  };
}

/** What re-wrapping the grants in force came to. */
type GrantsWrappedAgain = { readonly state: 'not-needed' | 'filed' } | { readonly state: 'not-wrapped'; readonly why: string };

/**
 * **THE GRANTS IN FORCE, WRAPPED AGAIN AFTER THE COMPANY'S KEY CHANGES OR A SEAT IS SEATED.** Owed when the version in
 * force wraps no key of the newest epoch, or is not sealed to every seat this device believes: the same
 * entries and signatures are filed again, wrapped up to the newest epoch and sealed to every seat. No wait follows a
 * missing re-wrap: a reader missing its newest wraps reads nothing new, and is told why, until one is filed.
 */
export async function grantsWrappedAgainHere(doors: GrantsFilingDoors): Promise<GrantsWrappedAgain> {
  /* With no version served there is nothing to wrap again; whether one was withheld is the readers' and the pause's question. */
  const served = await doors.versions();
  if (served.length === 0) return { state: 'not-needed' };
  const g = await grantsHere({ ...doors, versions: async () => served });
  const inForce = g.inForce;
  if (inForce === null || inForce.grants.entries.length === 0) return { state: 'not-needed' };
  const seats = await doors.seats();
  const owed = inForce.keyEpoch < doors.keys.newest || seats.some((x) => !g.inForceSealedTo.includes(x.id.toLowerCase()));
  if (!owed) return { state: 'not-needed' };
  if (doors.keys.epoch < doors.keys.newest) return { state: 'not-wrapped', why: NO_NEWEST_KEY };
  const grants = { ...inForce.grants, wraps: wrapsOf(doors, inForce.grants.entries) };
  await doors.file(sealGrants({ company: doors.accountId, version: g.highest + 1, keyEpoch: doors.keys.newest, grants, seats }));
  return { state: 'filed' };
}

import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import {
  believedSigners, foundingRosterRefusal, ROSTER_ID, type DirectoryWitness, type RosterWitnesses,
} from '../../../src/core/roster-record.js';
import type { Account, Signer } from '../../../src/core/types.js';
import { verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import { companyRecordKey, seatsWithAnotherRecordsKey, type DirectorySeat } from '../../../src/midnight/seat-directory.js';
import {
  attestedIn, directoryHere, foundingRecordRefusalHere, judgeIn, newerNamedRefusal, type DirectoryHere,
} from './vault-page-doors.js';

/**
 * **WHO FILED THE COMPANY'S ROSTER, JUDGED, AND WHICH OF ITS ENTRIES' RECORDS-KEY STATEMENTS COUNT.**
 *
 * Every device that reads the company's records needs the records keys the seats' own wallets attested, or no filing
 * of theirs is believed; those statements are in the roster, and they are taken only from the entries this device
 * believes, each held to its own signer's witnesses (`believedSigners`): the directory this device read with the chain,
 * and this device's own key where it holds a seat. A seat's device and a reader's wallet both come here, so the rule is
 * held once. The roster's own filer is then judged against the directory read with those statements; a refusal is
 * returned as words, for the caller to refuse with.
 */
/**
 * The seats of a directory this device believes whose entry it opened and
 * believed: only those carry a wallet key to witness a roster entry with, and
 * only those are believed to have signed an invitation.
 */
export const provedSeatsOf = (seats: readonly DirectorySeat[]): DirectoryWitness[] =>
  seats.flatMap((x) => (x.committeeKey === undefined ? [] : [{
    seat: x.seat, signingKey: x.signingKey, committeeKey: x.committeeKey, retired: x.retired !== null, role: x.role, person: x.person, ...(x.rights === undefined ? {} : { rights: x.rights }),
  }]));

/**
 * The seats a retirement anchored in the company's records retired, as the directory stood at the newest version the
 * anchor holds: one retired by a version filed and not yet anchored still has its entry, until that version is anchored.
 */
const retiredAsAnchored = (read: { readonly records: { readonly directory: ReadonlyMap<number, unknown> }; readonly at: DirectoryHere['at'] }): string[] => {
  const newest = Math.max(0, ...read.records.directory.keys());
  if (newest === 0) return [];
  return (read.at(newest)?.dir.seats ?? []).filter((x) => x.retired !== null).map((x) => x.seat.toLowerCase());
};

/**
 * Why this device does not believe a company's first roster, or null when it
 * does. It is filed with the company by its founding signer's device and
 * anchored in the company's first batch, so it is believed by the rule the
 * first state is (`foundingRecordRefusalHere`), and only while no newer version
 * is named. On the founding signer's own device, on its own signing key, it is
 * believed before that first anchor too, while nothing is anchored and no newer
 * version is named: that device made it.
 */
const firstRosterRefusal = (
  here: Awaited<ReturnType<typeof directoryHere>>, roster: SealedCompanyRecord, accountId: string,
  own: { readonly signingPublicKey: string } | null,
): string | null => {
  const filer = verifiedCompanyFiler(roster);
  const read = { ...companyRecordEntry(roster), version: roster.version };
  const nothingAnchored = here.records.reached.seq < 0 && here.records.stopped === null;
  if (nothingAnchored && filer !== null && own !== null && filer.toLowerCase() === own.signingPublicKey.toLowerCase()) {
    return foundingRosterRefusal(roster, accountId, own.signingPublicKey) ?? newerNamedRefusal(here, read);
  }
  return foundingRecordRefusalHere(here, roster, (key) => foundingRosterRefusal(roster, accountId, key))
    ?? newerNamedRefusal(here, read);
};

/** The directory as read to judge the roster, with the chain's holders and the records it anchored. */
type RosterDirectoryRead = Awaited<ReturnType<typeof directoryHere>>;

/**
 * The roster's entries (`opened`, as this device opened them) held to their witnesses, the directory with the statements of those believed (`here`), and why
 * the roster's filer is not believed, or null when it is. Trusts only `read`, which the caller made from the chain and
 * the company's directory with no statements, and this device's own key.
 */
export function rosterFilerJudged(
  opened: Pick<Account, 'signers'>, read: RosterDirectoryRead, roster: SealedCompanyRecord,
  d: { readonly accountId: string; readonly label: CompanyLabel; readonly account: AccountAddress; readonly own?: { readonly signerId?: string | null; readonly signingPublicKey: string } | null },
): {
  readonly witnesses: RosterWitnesses; readonly believed: Signer[]; readonly refused: ReturnType<typeof believedSigners>['refused'];
  readonly attesting: Signer[]; readonly here: RosterDirectoryRead & { readonly another: ReadonlySet<string> }; readonly why: string | null;
} {
  const witnesses: RosterWitnesses = {
    accountId: d.accountId, label: d.label, account: d.account, seatsOnTheChain: read.holders.seats,
    directory: provedSeatsOf(read.dir.seats),
    own: d.own ?? null,
    retired: retiredAsAnchored(read),
  };
  const { believed, refused, attesting } = believedSigners(opened.signers, witnesses);
  const here = { ...read, another: seatsWithAnotherRecordsKey(read.dir, d.label, read.holders.account, attestedIn({ signers: attesting })) };
  const why = roster.version === 1 ? firstRosterRefusal(here, roster, d.accountId, d.own ?? null)
    : judgeIn(here)(verifiedCompanyFiler(roster), 'roster', companyRecordKey('roster', ROSTER_ID), companyRecordEntry(roster), true, roster.keyEpoch);
  return { witnesses, believed, refused, attesting, here, why };
}

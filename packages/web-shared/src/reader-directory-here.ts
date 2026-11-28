import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead, RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import { openRoster, ROSTER_ID } from '../../../src/core/roster-record.js';
import type { Signer } from '../../../src/core/types.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { CommitteeKey } from '../../../src/midnight/seat-directory.js';
import { purposeKeysAt, type PurposeWrapsHeld } from './purpose-wraps.js';
import { rosterFilerJudged } from './roster-filer-here.js';
import { attestedIn, directoryHere, type DirectoryHereDeps, type DirectoryRead } from './vault-page-doors.js';
import type { CompanyView } from './company-view.js';

type Attested = readonly { committeeKey: CommitteeKey; statement: RecordsKeyStatement }[];

/**
 * **THE COMPANY'S DIRECTORY AS A READER'S WALLET BELIEVES IT, OPENED WITH THE KEYS ITS READ GRANT WRAPS.**
 *
 * A reader holds no seat and no company key, so it reads the directory with the keys its grant wraps to it, the chain's
 * holders, and the anchor of the company's records, as any device does. The records keys the seats' own wallets
 * attested are what lets any filing of theirs be believed; they are taken from the company's roster, opened with the
 * reader's roster key and believed entry by entry on the same rule a seat's device holds (`rosterFilerJudged`). A
 * roster that cannot be opened or whose filer is not believed gives no statements, so no filing is believed and the
 * reader is given nothing: it is never read as if the seats had attested what the service says.
 */
export interface ReaderDirectoryDoors {
  /**
   * The reader's one view of the company: its account and directory filings as the service keeps them, every answer
   * of which is judged here, and who holds the company's account, read off the chain.
   */
  readonly view: Pick<CompanyView<AccountHoldersRead>, 'company' | 'account' | 'filings' | 'holders'>;
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
  /** Each seat opening's leaf, worked out as the chain does. */
  readonly leaves: DirectoryHereDeps['leaves'];
  /** The company's records as their anchor on the chain holds them. */
  readonly anchored: DirectoryHereDeps['anchored'];
  /** The seat each signer invitation took, as the account's history on the chain shows it. */
  readonly invitedSeats: NonNullable<DirectoryHereDeps['invitedSeats']>;
  /** Each invitation's proposal identity, as the account's own functions make it. */
  readonly proposalIdentity: NonNullable<DirectoryHereDeps['proposalIdentity']>;
}

/** The statements of the roster's believed entries, or none when the roster is not opened or not believed. */
async function rosterAttestedHere(
  base: Omit<DirectoryHereDeps, 'attested'>,
  held: PurposeWrapsHeld,
  d: ReaderDirectoryDoors
): Promise<Attested> {
  const account = (await d.view.account()) as { roster?: SealedCompanyRecord | null } | null;
  const roster = account?.roster ?? null;
  if (roster === null || roster.company !== d.view.company || roster.kind !== 'roster' || roster.id !== ROSTER_ID)
    return [];
  let signers: Signer[];
  try {
    signers = openRoster(roster, purposeKeysAt(held, roster.keyEpoch)).signers;
  } catch {
    /* A roster this reader's keys do not open names no statement: nothing filed is then believed, and nothing released. */
    return [];
  }
  const read = await directoryHere(
    { ...base, attested: async () => [] },
    {
      records: [{ store: 'company', kind: 'roster', id: ROSTER_ID }],
      founding: roster.version === 1
    }
  );
  const judged = rosterFilerJudged({ signers }, read, roster, {
    accountId: d.view.company,
    label: d.label,
    account: d.account,
    own: null
  });
  return judged.why === null ? attestedIn({ signers: judged.attesting }) : [];
}

/** The directory a reader's wallet or page reads with the keys `held` its grant wraps (`readerKeysHere`, the reader's page). */
export const readerDirectoryFor =
  (d: ReaderDirectoryDoors) =>
  (held: PurposeWrapsHeld): DirectoryRead =>
  (asked) => {
    const base: Omit<DirectoryHereDeps, 'attested'> = {
      accountId: d.view.company,
      label: d.label,
      viewingKey: held,
      filings: () => d.view.filings(),
      holders: () => d.view.holders(),
      leaves: d.leaves,
      anchored: d.anchored,
      invitedSeats: d.invitedSeats,
      proposalIdentity: d.proposalIdentity
    };
    return directoryHere({ ...base, attested: () => rosterAttestedHere(base, held, d) }, asked);
  };

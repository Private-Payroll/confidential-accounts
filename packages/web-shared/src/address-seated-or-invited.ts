/**
 * Whether a wallet typed by its address may be invited to a seat on a company: refused when a seat on the chain, an
 * invitation the chain holds open, or one written down whose raise may still land already names that wallet's coin key.
 * The facts come from the company's proposals as the service lists them, judged against its anchored records, and from
 * the chain as the person's own wallet reads it; a fact this device cannot read refuses rather than lets the address through.
 */
import type { Hex } from '../../../src/core/crypto.js';
import type { KeysHeld } from '../../../src/core/company-key.js';
import type { SealedProposal } from '../../../src/core/types.js';
import { addressesInvitedIn, raiseHoldsWhatItNamesAt, type AddressInvited } from '../../../src/core/proposal-filing.js';
import { kindAsked, listedHere } from './vault-page-doors.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import { rosterHere, type RosterDoors, type RosterReads } from './roster-here.js';
import { seatsTakenAsked } from './seat-not-read-on-the-chain.js';
import type { GovernanceDoors } from './governed-call-on-device.js';
/** Why nobody is invited when the chain could not be read for the seat an earlier invitation of the address took. */
const NOT_READ = 'this device could not read from the network which seat an earlier invitation of this address took, so it invites nobody. '
  + 'Reload the page and try again';

/** What makes the commitment to an address from its coin key and a salt, as the account makes it. */
export type InviteAddressOf = (coinPublicKey: Hex, salt: Hex) => Hex;

/**
 * **WHY AN ADDRESS MAY NOT BE INVITED TO A SEAT HERE AGAIN, OR NULL.** The words returned complete a sentence that
 * begins "this invitation was not made:". The coin key of the address typed is named by a proposal of the company's to
 * add a seat (`addressesInvitedIn`, each bound to its own commitment, read from the list the service gives only once
 * every proposal the company's anchored records name is in it, `listedHere`) whose seat the chain holds (`invitedSeats`,
 * asked through `seatsTakenAsked`, then the account's holders as that one directory read read them), or whose proposal
 * the chain holds open, approved or not (`roundsOnChain`), or whose proposal is written down and not yet on the chain
 * while its raise may still land, by the chain's time (`chainTime`), within one raise window
 * (`raiseHoldsWhatItNamesAt`). One wallet seated twice approves twice, and the approving devices see only a commitment
 * under a fresh salt, so the refusal is made here, from the company's own proposals and the chain. A proposal the chain
 * closed without a seat, never held past its raise's deadline, whose record does not say when it was written, or whose
 * seat has since left the account, holds the address no more. A coin key the roster this device believes records for a
 * seat (`seated`, read from the roster here) is held too, whatever the proposals served say. `except` is the proposal
 * this device is raising again or approving. Refuses to say yes when this device cannot read the chain for it; a seat
 * read not made or refused throws what `seatsTakenAsked` throws.
 */
export async function addressSeatedOrInvitedRefusal(
  reads: {
    readonly proposals?: () => Promise<readonly SealedProposal[]>;
    readonly directory?: CompanyRecordsHere['directory'];
    readonly roundsOnChain?: CompanyRecordsHere['roundsOnChain'];
    readonly invitedSeats?: RosterReads['invitedSeats'];
    /** The coin keys the roster this device believes records for its seats. */
    readonly seated?: () => Promise<readonly string[]>;
    /** The time of the newest block, in milliseconds, at the indexer this device reads the chain from. */
    readonly chainTime?: () => Promise<number>;
  },
  accountId: string, viewingKey: KeysHeld, inviteAddressOf: InviteAddressOf, coinPublicKey: Hex, except?: string,
): Promise<string | null> {
  const cannot = 'this device cannot read which addresses the company\'s proposals have seated or invited, so it invites nobody '
    + 'by address. Reload the page and try again';
  if (reads.proposals === undefined || reads.directory === undefined || reads.roundsOnChain === undefined) return cannot;
  const coin = coinPublicKey.toLowerCase();
  const twice = 'that address already has a seat on this company, and one address can hold only one seat. Invite a different address';
  /* A proposal the company's records name and the service left out is refused here (`listedHere`), never read as none. */
  const here = await reads.directory(kindAsked('proposal'));
  const listed = listedHere(here, 'proposal', await reads.proposals(), 'proposal');
  if (reads.seated !== undefined && (await reads.seated()).some((x) => x.toLowerCase() === coin)) return twice;
  const invited = addressesInvitedIn([...listed, ...listed.setAside], accountId, viewingKey, inviteAddressOf)
    .filter((x) => x.coinPublicKey === coin && x.chainId !== except?.toLowerCase());
  const same = invited.map((x) => x.chainId);
  if (same.length === 0) return null;
  const [seated, rounds] = await Promise.all([seatsTakenAsked(reads.invitedSeats, same, NOT_READ), reads.roundsOnChain(same)]);
  const onTheChain = new Set(here.holders.seats.map((x) => x.toLowerCase()));
  if (same.some((id) => { const leaf = seated[id]; return typeof leaf === 'string' && onTheChain.has(leaf.toLowerCase()); })) return twice;
  if (same.some((id) => (seated[id] ?? null) === null && (rounds[id]?.held === 'open' || rounds[id]?.held === 'cleared'))) {
    return 'another invitation for this address is still open on the network. Wait until it is taken, or the signer who raised it '
      + 'withdraws it from the Proposals page, before you invite this address again';
  }
  const filed = invited.filter((x) => (seated[x.chainId] ?? null) === null && rounds[x.chainId]?.held === 'never');
  if (filed.length === 0) return null;
  const sitting = new Set(here.dir.seats.filter((x) => x.retired === null && onTheChain.has(String(x.seat).toLowerCase()))
    .map((x) => String(x.signingKey).toLowerCase()));
  return filedInvitationRefusal(filed.filter((x) => x.filedBy !== undefined && sitting.has(x.filedBy)), reads.chainTime);
}

/**
 * Why an invitation written down and not yet on the chain still holds its address, or null: one of `filed` (each filed by
 * a seat that sits now, so a seat since removed cannot keep refiling to hold an address) whose raise may still land by
 * the chain's time, within one raise window (`raiseHoldsWhatItNamesAt`). A record that does not say
 * when it was written holds nothing, since no deadline can be read from it. When the chain's time cannot be read while
 * a record with a deadline is waiting, it refuses with words to try again rather than letting the address through.
 */
const filedInvitationRefusal = async (
  filed: readonly AddressInvited[], chainTime: (() => Promise<number>) | undefined,
): Promise<string | null> => {
  const dated = filed.filter((x) => x.raiseBy !== undefined);
  if (dated.length === 0) return null;
  const at = chainTime === undefined ? undefined : await chainTime().catch(() => {
    /* A chain time not read is refused below with words to try again, never let through. */
    return undefined;
  });
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) {
    return 'the network\'s time could not be read to tell whether another invitation for this address, written down but not yet '
      + 'on the network, may still reach it. Try again in a minute';
  }
  const holding = dated.filter((x) => raiseHoldsWhatItNamesAt(x.raiseBy!, at));
  if (holding.length === 0) return null;
  const until = new Date(Math.max(...holding.map((x) => Number(x.raiseBy) * 1000))).toISOString().slice(0, 16).replace('T', ' ');
  return 'another invitation for this address was written down but is not on the network yet, and it may still reach the network '
    + `until ${until} UTC, by the network's clock. Try again after that time. If it shows on the network first, the signer who `
    + 'raised it withdraws it from the Proposals page before you invite this address again';
};

/** The coin keys the roster this device believes records for the seats it holds active. */
const coinKeysSeatedHere = (roster: RosterDoors) => async (): Promise<string[]> =>
  (await rosterHere(roster)).account.signers.filter((x) => x.status === 'active' && typeof x.coinPublicKey === 'string')
    .map((x) => x.coinPublicKey!.toLowerCase());

/**
 * What `addressSeatedOrInvitedRefusal` reads, from a seat's governance doors: the company's proposals and anchored
 * records with the chain's holders they were read against, the chain's rounds and seats, the coin keys the roster here
 * records, and the chain's time when given.
 */
export const addressReadsOf = (
  doors: GovernanceDoors & { readonly roster: RosterDoors }, chainTime: (() => Promise<number>) | undefined,
): Parameters<typeof addressSeatedOrInvitedRefusal>[0] => ({
  ...(doors.records?.proposals === undefined ? {} : { proposals: doors.records.proposals }),
  ...(doors.records === undefined ? {} : { directory: doors.records.directory }),
  ...(doors.records?.roundsOnChain === undefined ? {} : { roundsOnChain: doors.records.roundsOnChain }),
  ...(doors.roster.reads.invitedSeats === undefined ? {} : { invitedSeats: doors.roster.reads.invitedSeats }),
  seated: coinKeysSeatedHere(doors.roster),
  ...(chainTime === undefined ? {} : { chainTime }),
});

import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { api, holdersFromTheWallet } from 'vaults-web-shared/keyring.js';
import { approversFrom, rightsBelievedIn, seatAndThreshold, unnamedSeatsRefusal } from 'vaults-web-shared/approvers-read.js';
import type { SealedAccount } from '../../../../src/core/types.js';
import { isSignerRole } from '../../../../src/core/roles.js';
import { invitedSeatRightsOf, scopeOfRole } from '../../../../src/core/seat-rights.js';
import { refusalSaid, seatThresholdRefusal } from '../../../../src/core/vault-approvers.js';
import { companyKeysQuietlyFor, directoryHereFor, openedQuietly } from './filing-judge.js';
import { companyRoute } from './handover-state.js';
import { keysOnTheWayIn } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { theVaultBuilder } from './vault-builder.js';

/*
 * THE CHECK OF AN INVITATION'S THRESHOLD THE WALLET WILL MAKE, MADE ON THE PAGE FIRST, from what this page reads with its
 * own read key and its own wallet: the roster it opens, each seat's rights as the directory it believes holds them, and the
 * seats the chain holds. It is the same function the wallet calls (`seatThresholdRefusal`) over the same count
 * (`approversFrom`), so the page refuses the invitation the wallet refuses and says it in the same sentence, naming the vault.
 *
 * One difference, and it only ever lets more through to the wallet: the page does not read the runs open on the chain, so it
 * does not count the approvals a removal adds to a run raised before it; the wallet does, and stays the final check.
 */

/** The signer an invitation seats, as the form asks it, and the approvals the company would then need. */
interface SeatAsked {
  readonly role: string;
  readonly threshold: number;
}

/** What the count needs, as this page reads it with its own read key and its own wallet. */
type CountRead = Omit<Parameters<typeof approversFrom>[0], 'rights'> & { readonly believed: Parameters<typeof rightsBelievedIn>[0] };

/**
 * What the roster is counted from, read here, or null when this page cannot read them: no saved keys here, the
 * roster, the directory or the chain not read, or a seat the roster names no one for. Only the reads are caught; the
 * count is made outside, so a fault in it is never taken for a read that failed.
 */
async function countReadHere(companyId: string): Promise<CountRead | null> {
  try {
    const sealed = await api(companyRoute(companyId)) as SealedAccount;
    const label = sealed.companyLabel as CompanyLabel | undefined;
    const address = sealed.contractAddress as AccountAddress | undefined;
    const keys = await keysOnTheWayIn(companyId);
    if (label === undefined || address === undefined || keys === null) return null;
    const account = await openedQuietly(sealed);
    if (account === null || unnamedSeatsRefusal(account) !== null) return null;
    const viewingKey = await companyKeysQuietlyFor(companyId, sealed, { signingPublicKey: keys.signingPublicKey });
    const [{ holders }, here, wide] = await Promise.all([
      holdersFromTheWallet(ACCOUNT_ORIGIN, { company: label, account: address }),
      directoryHereFor(companyId, label, address, viewingKey, async () => account)(),
      theVaultBuilder().then((builder) => builder.companyWide()),
    ]);
    return { account, held: holders, companyWide: wide, believed: here.dir.seats };
  } catch {
    /* A read this page could not make is not a refusal: the wallet reads the same things at its own doors and refuses there. */
    return null;
  }
}

/**
 * Why the wallet would refuse to seat `asked`, in the sentence it would say it in, or null when it would not.
 * **NULL ALSO WHEN THIS PAGE CANNOT READ WHAT THE COUNT NEEDS** (`countReadHere`), and for a role no signer's seat
 * holds, which the wallet refuses on its own: the page then refuses nothing and the wallet, which reads it all itself,
 * stays the final check.
 */
export async function seatThresholdRefusedOnThePage(companyId: string, asked: SeatAsked): Promise<string | null> {
  const role = asked.role;
  if (!isSignerRole(role)) return null;
  const read = await countReadHere(companyId);
  if (read === null) return null;
  const rights = invitedSeatRightsOf({ role }, scopeOfRole(role));
  const { believed, ...from } = read;
  const roster = approversFrom({ ...from, rights: rightsBelievedIn(believed) });
  const no = seatThresholdRefusal(roster, { seats: read.held.seats.length }, seatAndThreshold(rights, asked.threshold));
  return no === null ? null : refusalSaid(no);
}

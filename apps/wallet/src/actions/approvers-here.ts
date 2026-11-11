/*
 * Who may approve each vault's runs, counted on this wallet from the company's roster and directory and the seats the
 * chain holds, and the open run the most removals have outrun.
 */
import type { ApproverRoster, SeatRights } from '../../../../src/core/vault-approvers.js';
import { activeSeatsOnTheChain, approversFrom, rightsBelievedIn, unnamedSeatsRefusal } from '../../../../packages/web-shared/src/approvers-read.js';
import { governedCallServiceFor } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import type { CompanyReach } from './company-reach.js';

type DirectoryReach = Pick<CompanyReach, 'roster' | 'judges' | 'accountId' | 'label' | 'account' | 'companyKeys'>;

/** Each seat's rights as the directory this wallet believes holds them, by its leaf. */
const rightsBelievedHere = async (r: DirectoryReach): Promise<ReadonlyMap<string, SeatRights>> => {
  const here = await r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster)();
  return rightsBelievedIn(here.dir.seats);
};

/**
 * The seats the chain holds and the roster names whose directory entry this wallet does not believe yet, so whose
 * rights it counts on no vault: each one's own wallet files its entry when its holder next opens the company there,
 * or the company removes the seat.
 */
export const seatsWithNoRightsRead = async (r: DirectoryReach & Pick<CompanyReach, 'holders'>): Promise<string[]> => {
  const [account, held, rightsOf] = await Promise.all([r.roster(), r.holders(), rightsBelievedHere(r)]);
  return activeSeatsOnTheChain(account.signers, held.seats).filter((leaf) => !rightsOf.has(leaf.toLowerCase()));
};

/**
 * Who may approve each vault's runs, counted from the roster this wallet believes, each seat's rights as its
 * directory entry holds them (`rightsBelievedHere`) and the seats the chain holds, for the check that a change leaves
 * no vault unable to pay. The count itself is `approversFrom` (packages/web-shared/src/approvers-read.ts), the one the
 * page makes too. Refused while the roster names no signer for a seat the chain holds (`unnamedSeatsRefusal`). With
 * `removals`, the signers removed since the open run they outran most was raised are counted against every vault the
 * account holds; for a removal (`o.removal`), so is the one approval more it adds to every open run.
 */
export const approversHere = async (
  r: Pick<CompanyReach, 'roster' | 'holders' | 'builder' | 'judges' | 'accountId' | 'label' | 'account' | 'companyKeys'>,
  removals?: () => Promise<{ readonly removals: number; readonly run: string | null; readonly open?: string | null }>,
  o: { readonly removal?: boolean } = {},
): Promise<ApproverRoster> => {
  const [account, held, wide] = await Promise.all([r.roster(), r.holders(), r.builder.companyWide()]);
  const unnamed = unnamedSeatsRefusal(account);
  if (unnamed !== null) throw new Error(unnamed);
  const outrun = removals === undefined ? undefined : await removals();
  return approversFrom({
    account, held, companyWide: wide, rights: await rightsBelievedHere(r),
    ...(outrun === undefined ? {} : { outrun }), ...(o.removal === true ? { removal: true } : {}),
  });
};

/**
 * **THE RUN OPEN NOW THAT THE MOST REMOVALS HAVE OUTRUN**, and how many signers were removed or replaced since it was
 * raised, read from the chain's open proposals at the indexer this wallet names (`runsOutrun`), so a run the service
 * or the records leave out is still counted; and `open`, one run open on the chain whether or not any removal has
 * outrun it, or null when none is. Each run is named as the company's records name it where the service lists it, and
 * by its identity on the chain otherwise, so a refusal can say which run to withdraw, pay out or raise again.
 */
export const runsOutrunHere = async (r: CompanyReach): Promise<{ readonly removals: number; readonly run: string | null; readonly open: string | null }> => {
  const runs = await r.builder.runsOutrun({ account: r.account, indexer: r.chain.indexer });
  let most: { removals: number; chainId: string | null } = { removals: 0, chainId: null };
  for (const [chainId, removals] of Object.entries(runs)) if (removals > most.removals) most = { removals, chainId: chainId.toLowerCase() };
  const first = Object.keys(runs).map((x) => x.toLowerCase()).sort()[0] ?? null;
  if (most.chainId === null && first === null) return { removals: 0, run: null, open: null };
  const listed = await governedCallServiceFor(r.api).sealedProposals!(r.accountId).catch(() => [] as readonly { id: string; chainId: string }[]);
  const nameOf = (chainId: string): string => {
    const named = (listed as readonly { id: string; chainId: string }[]).find((p) => String(p.chainId).toLowerCase() === chainId);
    return named === undefined ? chainId : `${named.id} (${chainId})`;
  };
  const open = nameOf(most.chainId ?? first!);
  return { removals: most.removals, run: most.chainId === null ? null : nameOf(most.chainId), open };
};

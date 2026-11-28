import type { Account, Proposal, ProposalStatus, SealedAccount, SealedProposal } from '../../../../src/core/types.js';
import { filingJudgeFor, rosterReadsIn, storeReachIn, walletIndexerIn, type PageView } from './filing-judge.js';
import type { RoundOnChain } from 'vaults-web-shared/governed-call-builder.js';
import { shownStatus, statusOnChain, type ClosingRead, type ProposalStanding } from './proposal-standing-on-chain.js';
import type { DirectoryRead } from 'vaults-web-shared/vault-page-doors.js';
import type { CompanyKeys } from '../../../../src/core/company-key.js';
import { theVaultBuilder } from './vault-builder.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { WalletIndexer } from 'midnight-identity/profile/unlock';
import { alone, READ, type Read } from './reads.js';
import { seatsTakenAsked } from 'vaults-web-shared/seat-not-read-on-the-chain.js';
import { Fault, FAULT } from '../faults.js';
import { openProposal } from './runs-and-proposals-opened.js';
import { HttpCompanyRecordStore } from 'vaults-web-shared/http-sealed-pool-store.js';
import { oneOffHere } from 'vaults-web-shared/one-off-here.js';
import type { OneOffHere } from 'vaults-web-shared/proposal-asks-here.js';
import {
  SERVICE,
  PAID_STATE,
  UNREADABLE,
  type PaidState,
  type RunLegRetry,
  type ProposalRow,
  type RunRow,
  type RunLeg
} from './company-rows.js';

/*
 * THE PROPOSALS AND THE RUNS OF A COMPANY, READ AS THE CHAIN HOLDS THEM.
 *
 * Where each proposal stands, how many have approved it and what a run's payments show as paid are asked of this
 * device's own vault worker, at the indexer the person's wallet names, and the company's records are opened and
 * believed here. A proposal this device does not believe or cannot open is listed by its id as unreadable, and a read
 * that fails leaves a run or a payment unread, never paid and never unpaid.
 */

/** Whose proposals and payments are read on the chain, and the indexer they are read at: the one the person's own wallet named, or null when it named none. */
export interface ChainReadAt {
  readonly company: string;
  readonly indexer: () => Promise<WalletIndexer | null>;
}

/** The chain as a member's page reads it for the company of `view`: at the indexer the wallet named when the view asked it who holds the company. */
export const chainReadIn = (view: PageView): ChainReadAt => ({
  company: view.company,
  indexer: () => walletIndexerIn(view)
});

/**
 * HOW MUCH OF SOME PAYMENTS THE CHAIN SHOWS PAID, from the answer to `paidLeaves`: all of them, none, or some. A leaf the
 * answer does not name, or no leaves at all, is not read, never "none". `none` is only "not seen in the newest state the
 * indexer holds".
 */
function paidStateOf(
  leaves: readonly string[] | undefined,
  paid: Readonly<Record<string, boolean>>
): PaidState | undefined {
  if (leaves === undefined || leaves.length === 0 || leaves.some((l) => typeof paid[l] !== 'boolean')) return undefined;
  const seen = leaves.filter((l) => paid[l] === true).length;
  return seen === leaves.length ? PAID_STATE.all : seen === 0 ? PAID_STATE.none : PAID_STATE.some;
}

const allOf = (states: readonly (PaidState | undefined)[]): PaidState | undefined => {
  if (states.length === 0 || states.some((x) => x === undefined)) return undefined;
  return states.every((x) => x === PAID_STATE.all)
    ? PAID_STATE.all
    : states.every((x) => x === PAID_STATE.none)
      ? PAID_STATE.none
      : PAID_STATE.some;
};

/** The runs with what the chain shows paid of each leg, retry and run, from the answer to `paidLeaves`. Nothing a run's record or the service says of it is used. */
function runsPaidOnChain(runs: readonly RunRow[], paid: Readonly<Record<string, boolean>>): RunRow[] {
  return runs.map((run) => {
    const legs = run.legs.map((leg): RunLeg => {
      const retries = leg.retries?.map((r): RunLegRetry => ({ ...r, paidOnChain: paidStateOf(r.leaves, paid) }));
      const paidOnChain = paidStateOf(leg.leaves, paid);
      const unpaid =
        paidOnChain === undefined ? undefined : (leg.leaves ?? []).flatMap((l, i) => (paid[l] === true ? [] : [i]));
      return {
        ...leg,
        ...(retries === undefined ? {} : { retries }),
        paidOnChain,
        ...(unpaid === undefined ? {} : { unpaid })
      };
    });
    return { ...run, legs, paidOnChain: allOf(legs.map((l) => l.paidOnChain)) };
  });
}

/**
 * **WHICH OF A COMPANY'S PAYMENTS THE CHAIN SHOWS PAID**, asked of this device's own worker, which reads the account's
 * newest state at the indexer the person's wallet names. When it cannot be read, the runs come back unread, never as
 * unpaid and never as paid.
 */
export async function runsPaidFromTheChain(
  at: ChainReadAt,
  sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>,
  runs: readonly RunRow[]
): Promise<RunRow[]> {
  const label = sealed.companyLabel ?? null;
  const address = sealed.contractAddress ?? null;
  const leaves = [
    ...new Set(
      runs.flatMap((r) =>
        r.legs.flatMap((l) => [...(l.leaves ?? []), ...(l.retries ?? []).flatMap((x) => x.leaves ?? [])])
      )
    )
  ];
  if (label === null || address === null || leaves.length === 0) return [...runs];
  try {
    const indexer = await at.indexer();
    if (indexer === null) return [...runs];
    return runsPaidOnChain(runs, await (await theVaultBuilder()).paidLeaves({ account: address, indexer, leaves }));
  } catch {
    return [...runs];
  }
}

/**
 * **WHETHER THE CHAIN SHOWS EACH APPROVED ONE-OFF PAYMENT PAID**, by the payment leaf the worker built from its record (`leaves`, by
 * proposal), through the same read as the runs'. A row whose leaf the answer does not name true or false, or a read that fails, is left
 * without `paidOnChain`: unread, never paid and never unpaid.
 */
export async function oneOffsPaidFromTheChain(
  at: ChainReadAt,
  sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>,
  rows: readonly ProposalRow[],
  leaves: ReadonlyMap<string, string>
): Promise<ProposalRow[]> {
  const label = sealed.companyLabel ?? null;
  const address = sealed.contractAddress ?? null;
  if (label === null || address === null || leaves.size === 0) return [...rows];
  try {
    const indexer = await at.indexer();
    if (indexer === null) return [...rows];
    const paid = await (
      await theVaultBuilder()
    ).paidLeaves({ account: address, indexer, leaves: [...new Set(leaves.values())] });
    return rows.map((r) => {
      const leaf = leaves.get(r.id);
      const shown = leaf === undefined ? undefined : paid[leaf];
      return typeof shown === 'boolean' ? { ...r, paidOnChain: shown } : r;
    });
  } catch {
    return [...rows];
  }
}

/** A proposal listed by its id alone: this device does not believe it, or cannot open it, so nothing is read from it. */
const unreadableRow = (id: string, raisedAt: string): ProposalRow => ({
  id,
  kind: UNREADABLE,
  status: UNREADABLE,
  raisedBy: null,
  raiserNotBelieved: null,
  approvals: 0,
  needed: null,
  raisedAt,
  pays: null
});

/** A proposal opened and believed on this device, with where the chain holds it. */
interface ProposalHere {
  readonly rec: SealedProposal;
  readonly opened: Proposal;
  readonly status: ProposalStatus;
  readonly approvals: number;
}

/**
 * **THE COMPANY'S PROPOSALS AS THE CHAIN HOLDS THEM AND THIS DEVICE BELIEVES THEM**: the service's list, checked
 * against the company's records and read where each stands at the indexer the person's own wallet names
 * (`proposalsListedHere`, in the page's vault worker); then each one the company's records name, whose filing this
 * device believes (`believedFilerHere`) and whose record it opens, is a row, and every other one is listed as
 * unreadable by its id: one the records name that the service did not give (with no date, since nothing of it was
 * read; the rest are still checked and read without it), one the records name under an older key, one they do not
 * name, one whose filing does not check, one that does not open. Refused, so the proposals read as unreadable, when the company has no account on the
 * network, the wallet names no indexer, or the chain or the records cannot be read.
 */
export async function proposalsHere(
  at: ChainReadAt,
  sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>,
  served: readonly SealedProposal[],
  directory: DirectoryRead | null,
  readWith: Parameters<typeof openProposal>[1]
): Promise<{
  readonly believed: readonly (ProposalHere & { readonly standing: ProposalStanding })[];
  readonly unreadable: readonly ProposalRow[];
}> {
  const label = sealed.companyLabel ?? null;
  const address = sealed.contractAddress ?? null;
  if (label === null || address === null || directory === null) throw new Fault(FAULT.noAccountToReadProposalsFrom);
  const indexer = await at.indexer();
  if (indexer === null) throw new Fault(FAULT.noIndexerToReadProposalsAt);
  const [
    builder,
    { proposalsListedHere, closedAs, statusOfAClose },
    { believedFilerHere },
    { kindAsked, namedHere },
    { recordKeyOf }
  ] = await Promise.all([
    theVaultBuilder(),
    import('vaults-web-shared/run-rebuilt-here.js'),
    import('vaults-web-shared/round-opened-here.js'),
    import('vaults-web-shared/vault-page-doors.js'),
    import('../../../../src/midnight/record-manifest.js')
  ]);
  /* Every proposal's record is proven in this one read of the kind, and each proposal's filer is judged against it. */
  const ofTheKind = await directory(kindAsked(SERVICE.proposalKind));
  const named = new Set(namedHere(ofTheKind, SERVICE.proposalKind, SERVICE.proposalKind));
  const given = new Set(served.map((p) => p.id));
  /* Each proposal the company's records name and the service did not give: listed unreadable, and the rest still read. */
  const withheld = [...named].filter((id) => !given.has(id));
  const withheldKeys = new Set(
    withheld.map((id) => recordKeyOf({ store: SERVICE.proposalKind, kind: SERVICE.proposalKind, id }))
  );
  const withoutWithheld: DirectoryRead =
    withheld.length === 0
      ? directory
      : async (asked) => {
          const here = await directory(asked);
          return {
            ...here,
            records: {
              ...here.records,
              history: new Map([...here.records.history].filter(([key]) => !withheldKeys.has(key))),
              notYetAnchored: here.records.notYetAnchored.filter((e) => !withheldKeys.has(recordKeyOf(e)))
            }
          };
        };
  let onChain: Readonly<Record<string, RoundOnChain>> = {};
  const listed = await proposalsListedHere({
    directory: withoutWithheld,
    roundsOnChain: async (chainIds) => {
      onChain = await builder.roundsOnChain({ account: address, indexer, chainIds });
      return onChain;
    },
    proposals: async () => served
  });
  const unreadable: ProposalRow[] = [
    ...withheld.map((id) => unreadableRow(id, '')),
    ...[...listed.setAside].map((rec) => unreadableRow(rec.id, rec.createdAt))
  ];
  const believed: (ProposalHere & { readonly standing: ProposalStanding })[] = [];
  for (const rec of listed) {
    if (!named.has(rec.id)) {
      unreadable.push(unreadableRow(rec.id, rec.createdAt));
      continue;
    }
    let opened: Proposal;
    let filer: string | null;
    try {
      filer = await believedFilerHere({ directory: async () => ofTheKind }, at.company, rec);
      opened = openProposal(rec, readWith);
    } catch {
      unreadable.push(unreadableRow(rec.id, rec.createdAt));
      continue;
    }
    const r = onChain[rec.chainId.toLowerCase()];
    /* Where it stands and its count are the chain's round, read above; nothing of either is taken from the service's list. */
    const closing: ClosingRead = { closedAs, statusOfAClose };
    const status = statusOnChain(rec.status, r, closing);
    const standing: ProposalStanding = {
      status,
      shown: shownStatus(status, r, closing),
      approvals: r?.approvals ?? 0,
      needed: r?.needed ?? null,
      raisedAt: rec.raisedAt ?? rec.createdAt,
      filer,
      raised: r !== undefined && r.held !== 'never',
      outrun: r !== undefined && r.held !== 'closed' && r.outrun === true
    };
    believed.push({ rec, opened, status: standing.status, approvals: standing.approvals, standing });
  }
  return { believed, unreadable };
}

/**
 * The seat each add-signer proposal took, as the chain says through the person's own indexer, by the proposal's identity on
 * the chain, read once for the page. Only an identity of thirty-two bytes is asked about: the read is one ask for every
 * proposal, and a record naming any other identity must not fail it for the rest. Unreadable when the company names no
 * account or the read is not made or refused (`seatsTakenAsked`): a seat not read is never shown as no seat taken.
 */
export const seatsTakenOnChain = async (
  view: PageView,
  sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>,
  served: readonly { readonly rec: SealedProposal; readonly opened: Proposal }[]
): Promise<Read<Readonly<Record<string, string | null>>>> => {
  const ids = [
    ...new Set(
      served
        .filter(({ opened }) => opened.kind === 'add-signer')
        .flatMap(({ rec }) => (typeof rec.chainId === 'string' ? [rec.chainId.toLowerCase()] : []))
        .filter((id) => /^[0-9a-f]{64}$/u.test(id))
    )
  ];
  if (ids.length === 0) return { of: READ.read, value: {} };
  if (sealed.companyLabel == null || sealed.contractAddress == null) return { of: READ.unreadable };
  const { invitedSeats } = rosterReadsIn(view, {
    company: sealed.companyLabel as CompanyLabel,
    account: sealed.contractAddress as AccountAddress
  });
  return alone(() => seatsTakenAsked(invitedSeats, ids));
};

/**
 * The one-off payment named `id`, as this device believes its record: fetched by its name alone, judged against the
 * company's records and opened with the company's key here; null when it is not given, not believed or does not open.
 */
export async function oneOffHereFor(
  view: PageView,
  sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>,
  account: Account,
  viewingKey: CompanyKeys,
  directory: DirectoryRead | null,
  id: string
): Promise<OneOffHere | null> {
  const label = sealed.companyLabel ?? null;
  const address = sealed.contractAddress ?? null;
  if (label === null || address === null || directory === null) return null;
  try {
    const store = new HttpCompanyRecordStore(
      view.company,
      storeReachIn(view),
      null,
      filingJudgeFor(view, label as CompanyLabel, address as AccountAddress, viewingKey, async () => account)
    );
    /* Opened in the page's vault worker, where the payee's address is decoded: the page itself loads no address decoder. */
    const { openOneOff } = await theVaultBuilder();
    if (openOneOff === undefined) return null;
    const read = await oneOffHere(
      {
        accountId: view.company,
        directory,
        records: { at: (kind, at, version) => store.at(kind, at, version) },
        keys: viewingKey,
        open: openOneOff
      },
      id
    );
    return read.state === 'read' ? read : null;
  } catch {
    return null;
  }
}

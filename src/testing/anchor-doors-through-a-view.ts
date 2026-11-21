/**
 * **A TEST'S ANCHOR DOORS, GIVEN THE STEP'S VIEW AS THE WALLET GIVES IT.** The
 * view is the device's own (`companyViewFor`), over a source that is the very
 * services, directory, chain and stores the test stands in: what a test makes
 * those do (a header lost, an entry dropped, a page short, a forged founding
 * record) is what the view reads and writes, and every check the view makes
 * before a write runs. The company's standing on the chain is held still here:
 * a test that moves it does so through `holders`.
 */
import type { HoldersStanding } from 'vaults-web-shared/company-view-probe.js';
import { companyViewFor, viewHeldOver, type HeldReader } from 'vaults-web-shared/company-view.js';
import type { AnchorDoors } from 'vaults-web-shared/records-anchored-here.js';
import { recordsHeldHere } from 'vaults-web-shared/records-held-here.js';
import type { CompanyRecordAsked, RecordSource, RecordWrite } from 'vaults-web-shared/records-source.js';
import type { TreeKept } from 'vaults-web-shared/tree-kept-here.js';
import { FOUNDING_KEY_EPOCH, stateRecordId } from '../core/founding-state.js';
import { ROSTER_ID } from '../core/roster-record.js';
import { toCompanyWire, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';

/** A test's anchor doors before the step's view is opened over them. */
export type AnchorDoorsBare = Omit<AnchorDoors, 'view'>;

/** Who holds the company, as a test that does not move it reads it: the same at every check. */
const HELD_STILL: HoldersStanding = Object.freeze({
  seats: [], approvals: 1, adoptedVaults: [], threshold: 1, committee: [], vaultThresholds: [], policyBar: null,
});

const notStoodIn = (what: string) => async (): Promise<never> => {
  throw new Error(`the anchor asked the view for ${what}, which this test's doors do not stand in for`);
};

/* The founding versions of the state and the roster, as the service answers an ask for every version of each. */
const foundingAsked = (asked: readonly CompanyRecordAsked[]): boolean =>
  asked.length === 2 && asked[0]!.kind === 'state' && asked[0]!.id === stateRecordId(FOUNDING_KEY_EPOCH) && asked[0]!.every === true
  && asked[1]!.kind === 'roster' && asked[1]!.id === ROSTER_ID && asked[1]!.every === true;

const versionsOf = (rec: SealedCompanyRecord | null) => ({ versions: rec === null ? [] : [toCompanyWire(rec)] });

/** The company as the test's doors serve it, read and written as a source. */
const sourceOf = (doors: AnchorDoorsBare): RecordSource => {
  const co = doors.accountId;
  const write = async (w: RecordWrite): Promise<unknown> => {
    if (w.to === 'entries') return doors.manifest.enter(co, w.entries);
    if (w.to === 'header') return doors.tree.fileHeader(co, w.header, w.entries);
    if (w.to === 'proven') return doors.service.sendProven(co, w.tx);
    if (w.to === 'directory' && doors.fileDirectory !== undefined) return doors.fileDirectory(w.filing);
    return notStoodIn(`a write to ${w.to}`)();
  };
  return {
    company: co,
    filings: () => doors.directoryFilings(),
    newest: (names) => doors.manifest.newest(co, names),
    pending: (root) => doors.tree.pending(co, root),
    proofs: (ask) => doors.tree.proofs(co, ask),
    headers: (after, limit) => doors.tree.headersAfter(co, after, limit),
    records: async (asked) => {
      if (!foundingAsked(asked)) return notStoodIn('a record other than the founding state and roster')();
      const { state, roster } = await doors.service.foundingRecords(co);
      return [versionsOf(state), versionsOf(roster)];
    },
    list: async (kind) => (kind === 'proposals' ? doors.service.sealedProposals(co) : notStoodIn(`the list of ${kind}`)()),
    write,
    account: notStoodIn('the account'), vaultRecords: notStoodIn('a vault record'), handovers: notStoodIn('a handover'),
    vendorHandovers: notStoodIn('a vendor handover'), standing: notStoodIn('a standing'), callState: notStoodIn('the call state'),
    vaultChain: notStoodIn('a vault on the chain'), payoutState: notStoodIn('a payout'), authority: notStoodIn('the authority'),
    committeeChange: notStoodIn('a committee change'), vaultKeys: notStoodIn('the vault keys'),
  };
};

/** The stores the test's doors keep, as the view hands them back. */
const storesOf = (doors: AnchorDoorsBare): Partial<TreeKept> => ({
  ...(doors.headers === undefined ? {} : { headers: doors.headers }),
  ...(doors.checked === undefined ? {} : { checked: doors.checked }),
  ...(doors.changes === undefined ? {} : { changes: doors.changes }),
});

/** `doors` with the step's view over them; `holders`, who holds the company at each check (still, unless given). */
export const throughAView = (
  doors: AnchorDoorsBare, holders: () => Promise<HoldersStanding> = async () => HELD_STILL,
): AnchorDoors => {
  /* Held, read as the device reads it with no judges of its own: the test's doors, through the view's tree and stores. */
  const held: HeldReader = (view, asked) => recordsHeldHere({
    ...doors, ...view.stores, tree: view.tree, manifest: view.manifest, onChain: () => view.doors.onChain(), directory: () => view.directory(),
  }, asked);
  const open = (from?: Parameters<typeof companyViewFor>[3]) => companyViewFor(sourceOf(doors), {
    holders, onChain: doors.onChain, builder: { anchorHeads: (ask) => doors.builder.anchorHeads(ask) },
    kept: () => storesOf(doors), directory: () => doors.directory(),
  }, held, from);
  return { ...doors, view: viewHeldOver(open) };
};

/**
 * The company's writes, its lists and records read, and a code's acceptance, for a test that sends to the service's routes in memory by its own
 * send: each write goes through that company's source over the send, as a device's writes go through its source.
 */
import type { InvitationSend } from 'vaults-web-shared/invitation-on-device.js';
import type { CodeAsks } from 'vaults-web-shared/invitation-by-code.js';
import { invitationSource, serviceCallOf, serviceSource, type CompanyWrites, type ServiceCall } from 'vaults-web-shared/records-source.js';
import { companyViewFor, viewHeldOver, type ViewHeld } from 'vaults-web-shared/company-view.js';
import type { HoldersStanding } from 'vaults-web-shared/company-view-probe.js';
import { treeKeptInMemory } from 'vaults-web-shared/tree-kept-here.js';
import { firstOf } from 'vaults-web-shared/roster-through-the-view.js';
import { FOUNDING_KEY_EPOCH, stateRecordId } from '../core/founding-state.js';
import { ROSTER_ID } from '../core/roster-record.js';
import type { SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import type { ListsView } from 'vaults-web-shared/people-read-here.js';
import type { Roster } from 'vaults-web-shared/handover-check.js';
import type { VaultService } from 'vaults-web-shared/vault-service.js';
import { keysCheckedAgainst } from 'vaults-web-shared/vault-service-doors.js';
import { readsJoinedIn, type ThroughTheView } from 'vaults-web-shared/http-sealed-pool-store.js';
import type { Filed, ManifestService, RecordsEntered } from 'vaults-web-shared/record-entered-here.js';
import { enteredHere } from './records-entered.js';
import { readRoutesOverSend, type RoutesKept } from './service-routes-in-memory.js';
import { vaultServiceThrough } from 'vaults-web-shared/vault-service-through-the-view.js';

/** The routes a test's stand-in service leaves to the routes in memory: the company has filed nothing and entered no record. */
export const NOTHING_FILED: RoutesKept = Object.freeze({ directory: 'empty', newest: 'none-entered' });

/**
 * The company's writes made over `send`, each through a view of that company opened anew for it, which checks the company
 * has not moved before the write is sent: another seat's filing in the directory or a newer entered version stops it, while who
 * holds the company on the chain is held still. `send` answers the view's read routes itself, as the service does; a stand-in
 * that answers only some of them gets the rest by `kept` (`readRoutesOverSend`).
 */
export const writesOver = (send: InvitationSend, kept?: RoutesKept): CompanyWrites => async (company, w) => {
  const reached = kept === undefined ? send : readRoutesOverSend(send, kept);
  const [answer] = await viewOpenedEachTime(serviceCallOf(reached), company).current().write([w]);
  return answer;
};

/** A code's person added over `send`: the company's writes, and the invitation's own acceptance asked by its route. */
export const codeAsksOver = (send: InvitationSend): CodeAsks => ({
  writes: writesOver(send),
  invitations: invitationSource((method, path, body) => send(path, { method, ...(body === undefined ? {} : { body }) })),
});

/**
 * The company's lists, records and hand-overs read over `send`, through that company's source itself, not a view: the
 * service tests that take it check what the routes keep and answer, so their device reads the lists as the routes
 * serve them; the product reads every list only through the company's view, which the one-way check holds.
 */
export const listsOver = (send: InvitationSend, company: string): ListsView => serviceSource(serviceCallOf(send), company);

/** Who holds the company, as a test that does not move it reads it: the same at every check. */
const HELD_STILL: HoldersStanding = Object.freeze({
  seats: [], approvals: 1, adoptedVaults: [], threshold: 1, committee: [], vaultThresholds: [], policyBar: null,
});

/** Who holds the company, held still, with the vaults at `addresses` adopted by its account: for a test that sends into a vault. */
export const holdersAdopting = (...addresses: readonly string[]) => async (): Promise<HoldersStanding> => ({ ...HELD_STILL, adoptedVaults: addresses });

const notStoodIn = (what: string) => async (): Promise<never> => {
  throw new Error(`this test's view of the company reads no ${what}`);
};

/**
 * A step's view of `company` over `call`, as a device opens it: the product's own view over that company's source, each
 * write checked just before it is sent. The company's standing on the chain is held still, unless `holders` says otherwise.
 * `call` is a test's service in memory: one that stands in for only some routes is given the read routes the view asks
 * by `readRoutesOver`.
 */
export const viewOver = (call: ServiceCall, company: string, holders: () => Promise<HoldersStanding> = async () => HELD_STILL): ViewHeld<HoldersStanding> =>
  viewHeldOver((from) => companyViewFor(serviceSource(call, company), {
    holders, onChain: notStoodIn('anchors'), builder: { anchorHeads: notStoodIn('heads') }, kept: () => treeKeptInMemory(),
  }, notStoodIn('held records'), from));

/**
 * `viewOver`, opened anew for each use: for a test's device whose other doors write to the company through views of their
 * own, so a view kept across them would read the company as it was before those writes.
 */
export const viewOpenedEachTime = (call: ServiceCall, company: string, holders?: () => Promise<HoldersStanding>): ViewHeld<HoldersStanding> =>
  Object.freeze({ current: () => viewOver(call, company, holders).current(), again: () => viewOver(call, company, holders).current() });

/**
 * The first state and roster `company` was founded with, read over `call` through the company's source itself, as an
 * anchor reads them before it has a view: they are the records the view's own proofs start from.
 */
export const foundingRecordsOver = (call: ServiceCall, company: string) => async (): Promise<{ readonly state: SealedCompanyRecord | null; readonly roster: SealedCompanyRecord | null }> => {
  const state = stateRecordId(FOUNDING_KEY_EPOCH);
  const [s, r] = await serviceSource(call, company).records([{ kind: 'state', id: state, every: true }, { kind: 'roster', id: ROSTER_ID, every: true }]);
  return { state: firstOf(s, company, 'state', state), roster: firstOf(r, company, 'roster', ROSTER_ID) };
};

/**
 * Whether a request a test logged as `METHOD path [body]` only reads the company: a GET, or a POST to one of the
 * company's read routes (its records, its vaults' records, what its people and vendors handed over, or the newest
 * version entered of each record).
 */
export const onlyReads = (logged: string): boolean =>
  /^(GET |POST \/api\/accounts\/[^/ ]+\/(records\/read|vault-records\/read|handovers|manifest\/newest)( |$))/u.test(logged);

/**
 * The company's vault routes over `call`, as a device takes them: each send a write through that company's view, its chain
 * and payout state and its vault keys read through it, the keys checked against the roster `roster` opens. A send into a vault
 * goes only to one `holders` shows the company's account adopting.
 */
export const vaultServiceOver = (
  call: ServiceCall, company: string, roster: () => Promise<Roster>, holders?: () => Promise<HoldersStanding>,
): VaultService => {
  const held = viewOver(call, company, holders);
  return {
    keys: () => keysCheckedAgainst(async () => await held.current().vaultKeys() as Awaited<ReturnType<VaultService['keys']>>, roster),
    ...vaultServiceThrough(held),
  };
};

const reachThrough = (held: ViewHeld<HoldersStanding>, manifest: ManifestService | undefined): ThroughTheView => {
  const reach = readsJoinedIn(held);
  return manifest === undefined ? reach : Object.freeze({ ...reach, manifest });
};

/**
 * A store's reach over a test's own `send` for the company `company`: the company's view over it, each read joined as the
 * view reads and each filing checked and written through it. A filing is entered through `manifest`, or through the
 * view's own manifest when none is given.
 */
export const storeReachOver = (send: InvitationSend, company: string, manifest?: ManifestService): ThroughTheView =>
  reachThrough(viewOver(serviceCallOf(send), company), manifest);

/**
 * `storeReachOver`, with a view opened anew for each read and each filing: for a test's stores that live across steps
 * of one device, which would otherwise read the company as it was when the device last read it.
 */
export const storeReachOpenedEachTime = (send: InvitationSend, company: string, manifest?: ManifestService): ThroughTheView =>
  reachThrough(viewOpenedEachTime(serviceCallOf(send), company), manifest);

/** A manifest that enters each entry through `entered`, as the body its seat signed, and says no record was entered before. */
export const manifestInto = (entered: Pick<RecordsEntered, 'enter'>): ManifestService => ({
  newest: async (_company, names) => names.map(() => 0),
  enter: async (_company, entries) => entered.enter(entries.map(({ filedBy: _signed, ...body }) => body)),
});

/** A manifest that keeps every entry entered through it, as the body each seat signed (`filed`). */
export const manifestKept = (): { readonly filed: Filed[][]; readonly manifest: ManifestService } => {
  const kept = enteredHere();
  return { filed: kept.filed, manifest: manifestInto(kept) };
};

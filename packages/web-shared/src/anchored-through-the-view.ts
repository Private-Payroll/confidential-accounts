/**
 * **WHAT AN ANCHOR READS AND WRITES THROUGH: THE STEP'S ONE READ OF THE COMPANY.**
 * Given the step's view (`AnchorDoors.view`), every read - held, the directory
 * with its records, its filings, the manifest's newest, the record tree, the
 * account's anchors, the company's proposals and founding records - goes
 * through its current view, the device's stores are the view's, and every write
 * - an entry, a header, a directory filing, the anchor sent through the service -
 * goes through the view's one write, so the check that the company has not
 * changed runs before each and the view forgets every answer the write can
 * change. A write refused, or whose outcome is not known, ends the view.
 */
import { FOUNDING_KEY_EPOCH, stateRecordId } from '../../../src/core/founding-state.js';
import { ROSTER_ID } from '../../../src/core/roster-record.js';
import type { SealedProposal } from '../../../src/core/types.js';
import type { RecordsAsked } from '../../../src/midnight/records-held.js';
import type { CompanyView } from './company-view.js';
import type { AnchorsOnChain } from './governed-call-builder.js';
import { governedCallServiceThrough, type GovernedView } from './governed-call-through-the-view.js';
import type { AnchorDoors } from './records-anchored-here.js';
import type { ReadHere } from './records-as-anchored.js';
import { firstOf } from './roster-through-the-view.js';

/** The service's reads and the anchor's send, through the view: the proposals and founding records read, the send written. */
const serviceThrough = (view: CompanyView<unknown>, service: AnchorDoors['service']): AnchorDoors['service'] => ({
  ...service,
  sealedProposals: async () => {
    const listed = await view.list('proposals');
    if (!Array.isArray(listed)) throw new Error("the service did not answer with the company's proposals");
    return listed as SealedProposal[];
  },
  foundingRecords: async () => {
    const state = stateRecordId(FOUNDING_KEY_EPOCH);
    const [s, r] = await view.records([
      { kind: 'state', id: state, every: true },
      { kind: 'roster', id: ROSTER_ID, every: true }
    ]);
    return { state: firstOf(s, view.company, 'state', state), roster: firstOf(r, view.company, 'roster', ROSTER_ID) };
  },
  sendProven: async (_accountId, tx) => (await view.write([{ to: 'proven', tx }]))[0]
});

/** Refused: what each anchoring attempt reads and sends through its own view (`throughTheView`), never through this door. */
const throughEachAttempt = (what: string) => async (): Promise<never> => {
  throw new Error(
    `the anchor's ${what} goes through each attempt's own view of the company, so nothing was read or sent here`
  );
};

/**
 * The anchor's service for a step that holds a view of the company: the account's calls on the chain, read through the
 * step's current view. The proposals, the founding records and the anchor's send are each attempt's own view's
 * (`throughTheView` puts them in), so here they refuse.
 */
export const anchorServiceThrough = (held: GovernedView): AnchorDoors['service'] => ({
  callState: governedCallServiceThrough(held).callState,
  sealedProposals: throughEachAttempt('read of the proposals'),
  foundingRecords: throughEachAttempt('read of its founding records'),
  sendProven: throughEachAttempt('send')
});

/** The doors one attempt reads and writes through: the step's current view's. */
export const throughTheView = (doors: AnchorDoors): AnchorDoors => {
  const view = doors.view.current();
  const { headers: _headers, checked: _checked, changes: _changes, ...given } = doors;
  const { headers, checked, changes } = view.stores;
  return {
    ...given,
    manifest: view.manifest,
    tree: view.tree,
    directory: () => view.directory(),
    directoryFilings: () => view.filings(),
    onChain: () => view.doors.onChain(),
    service: serviceThrough(view, doors.service),
    ...(headers === undefined ? {} : { headers }),
    ...(checked === undefined ? {} : { checked }),
    ...(changes === undefined ? {} : { changes }),
    ...(doors.fileDirectory === undefined
      ? {}
      : {
          fileDirectory: async (filing) => {
            await view.write([{ to: 'directory', filing }]);
          }
        })
  };
};

/**
 * **THE RECORDS AS THE HEAD ON CHAIN HOLDS THEM, FOR WHAT AN ANCHOR ASKS.** Through the view: what it asks is declared
 * first, then the view's directory is read (which hands it to the held read), then held - one held
 * answer for both while nothing was written, and a fresh one after the view's own writes, which drop it.
 */
export const heldHere = async (doors: AnchorDoors, asked: RecordsAsked): Promise<ReadHere> => {
  const view = doors.view.current();
  view.declare({
    ...(asked.records === undefined ? {} : { records: asked.records }),
    ...(asked.kinds === undefined ? {} : { kinds: asked.kinds }),
    ...(asked.everyPending === true ? { everyPending: true } : {})
  });
  await view.directory();
  return view.held(asked);
};

/**
 * The account's anchors read again now, never from a kept answer: what a send is watched by. Through the step's
 * current view, counted there.
 */
export const chainNowOf = (doors: AnchorDoors): (() => Promise<AnchorsOnChain>) => {
  const held = doors.view;
  return () => held.current().doors.onChainNow();
};

/**
 * After a race, or a send refused or of unknown outcome: the step's view is ended and a fresh one opened in its place,
 * and the account's anchors are read through the fresh one. The next attempt reads from it.
 */
export const chainAfterARace = (doors: AnchorDoors, why: string): Promise<AnchorsOnChain> => {
  return doors.view.again(why).doors.onChainNow();
};

/** After a swallowed refusal, or a race found before anything was sent: the step goes on from a fresh view. */
export const freshViewAfter = (doors: AnchorDoors, why: string): void => {
  doors.view.again(why);
};

/**
 * **WHAT THE JUDGES READ A COMPANY THROUGH, AND THE ONE ORDER IN WHICH WHAT IS BUILT ON ITS DIRECTORY IS BUILT.** A
 * judge reads a company's account, directory, lists, read grants, who holds it on the chain and what its records
 * anchor through `JudgeReads`, over the company's view (company-view.ts), so every judge of one step or one screen
 * shares one read of each.
 *
 * What is built on the directory's filings is built in one order, each part resting on the one before: the directory
 * with an empty roster (read only to open the company's keys), the company's keys, the roster, then the directory with
 * the roster and its judge (`inOrder`). In a view each is built once, and forgotten with the filings.
 */
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import type { Account } from '../../../src/core/types.js';
import type { RecordsAsked } from '../../../src/midnight/records-held.js';
import type { DirectoryFiling } from '../../../src/midnight/seat-directory.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { CompanyKeyHere } from './company-key-here.js';
import type { CompanyView, HeldReader } from './company-view.js';
import type { AnchorsOnChain } from './governed-call-builder.js';
import type { FreshJudge } from './http-sealed-pool-store.js';
import { grantsReadWith } from './purpose-wraps.js';
import type { ManifestService, TreeService } from './record-entered-here.js';
import type { AnchorDoors } from './records-anchored-here.js';
import { heldFor, recordsHeldHere } from './records-held-here.js';
import type { ListKind } from './records-source.js';
import type { TreeKept } from './tree-kept-here.js';
import {
  directoryHere, directoryJudge, type DirectoryBelieved, type DirectoryHereDeps, type DirectoryRead, type RecordsHeldHere,
} from './vault-page-doors.js';
import type { VaultBuilderClient } from './vault-worker-client.js';

/** A company's view as the judges read it: who holds the company is read as the person's own chain read gives it. */
export type JudgeView = CompanyView<AccountHoldersRead>;

/** What of who holds the company another signer's change moves: its seats, the approvals it needs, its adopted vaults. */

/** Everything a judge reads of one company. */
export interface JudgeReads {
  readonly company: string;
  account(): Promise<unknown>;
  filings(): Promise<readonly DirectoryFiling[]>;
  list(kind: ListKind): Promise<unknown>;
  holders(): Promise<AccountHoldersRead>;
  /** Every version of the company's read grants. */
  grants(): Promise<readonly SealedCompanyRecord[]>;
  /** Which records the company's anchor holds, read against `directory`. */
  anchored(directory: DirectoryBelieved, asked: RecordsAsked): Promise<RecordsHeldHere>;
  /** What `build` makes, once for each `name` in the view. */
  layer<T>(name: string, build: () => Promise<T>): Promise<T>;
  readonly tree: TreeService;
  readonly manifest: ManifestService;
  readonly onChain: () => Promise<AnchorsOnChain>;
  /** The builder's heads, counted with the view's reads. */
  readonly anchorHeads: VaultBuilderClient['anchorHeads'];
}

/** What a read of the anchored records needs besides the company's reads: the device's own stores and builder. */
export interface HeldDoorsHere {
  /** The device's own checked heads and kept headers, or a set kept in memory for one read alone; a read through a view uses the view's. */
  readonly kept: () => Partial<TreeKept>;
  readonly builder: () => Promise<VaultBuilderClient>;
  readonly vouching?: AnchorDoors['vouching'];
  readonly tagSeats?: AnchorDoors['tagSeats'];
}

type HeldReads = Pick<JudgeReads, 'company' | 'tree' | 'manifest' | 'onChain' | 'anchorHeads'>;

/** What a held read is given: `reads`' tree, manifest and anchors, the device's stores and its builder `b`. */
const heldDoorsOf = (reads: HeldReads, doors: HeldDoorsHere, b: VaultBuilderClient) => {
  return {
    accountId: reads.company, tree: reads.tree, manifest: reads.manifest, ...doors.kept(), onChain: reads.onChain,
    builder: { anchorHeads: reads.anchorHeads, anchor: (input: Parameters<VaultBuilderClient['anchor']>[0]) => b.anchor(input),
      anchorTag: (input: Parameters<VaultBuilderClient['anchorTag']>[0]) => b.anchorTag(input) },
    ...(doors.vouching === undefined ? {} : { vouching: doors.vouching }),
    ...(doors.tagSeats === undefined ? {} : { tagSeats: doors.tagSeats }),
  };
};

/** Reads which records the company's anchor holds, through `reads`, with the device's stores and builder, judged against `directory`. */
export const heldThrough = async (reads: HeldReads, doors: HeldDoorsHere, directory: DirectoryBelieved, asked: RecordsAsked): Promise<RecordsHeldHere> => {
  const kept = doors.kept();
  return heldFor(heldDoorsOf(reads, { ...doors, kept: () => kept }, await doors.builder()))(directory, asked);
};

/**
 * What a held read of a directory depends on, written so two directories compare equal exactly when a held read
 * judged against one holds for the other: the seats it believes (their keys, rights and retirements) and its key
 * changes, and who holds the account.
 */
const judgedAs = (directory: DirectoryBelieved): string => JSON.stringify([directory.dir, directory.holders], (_k, v: unknown) =>
  (v instanceof Map ? [...v] : v instanceof Set ? [...v] : typeof v === 'bigint' ? v.toString() : v));

/** The directory a view's kept held read is judged against, with the filings it was built on and what it was judged as. */
interface Handed {
  readonly directory: DirectoryBelieved;
  readonly filings: readonly DirectoryFiling[];
  readonly as: string;
}
const handed = new WeakMap<object, Handed>();

const STALE_DIRECTORY = 'the company\'s directory changed since the directory these records would be judged against was read, '
  + 'so none of them is believed. Read the directory again';

/** The view's reads a held read goes through. */
const heldReadsOf = (view: Pick<CompanyView<unknown>, 'company' | 'tree' | 'manifest' | 'doors'>): HeldReads => ({
  company: view.company, tree: view.tree, manifest: view.manifest, onChain: () => view.doors.onChain(), anchorHeads: (ask) => view.doors.builder.anchorHeads(ask),
});

/** The same filings: read again after a write that did not change them (a header filed again), they are still the ones the directory was read from. */
const sameFilings = (now: readonly DirectoryFiling[], then: readonly DirectoryFiling[]): boolean =>
  now === then || JSON.stringify(now) === JSON.stringify(then);

/**
 * How a view reads held, for the code that opens a view for the judges: against the directory a directory read
 * handed it, and refused when the view's filings have changed since that directory was read from them. It keeps and
 * files again from the view's own stores (`CompanyView.stores`), the ones an anchor through the same view signs into.
 */
export const heldReaderOver = (doors: HeldDoorsHere): HeldReader => async (view, asked) => {
  const kept = handed.get(view);
  if (kept === undefined) throw new Error('the company\'s records were asked for before its directory was read, so none of them is believed.');
  if (!sameFilings(await view.filings(), kept.filings)) throw new Error(STALE_DIRECTORY);
  const held = heldDoorsOf(heldReadsOf(view), { ...doors, kept: () => view.stores }, await doors.builder());
  return recordsHeldHere({ ...held, directory: async () => kept.directory }, asked);
};

/**
 * Which records the company's anchor holds, judged against `directory`: the view's one kept held read when the
 * directory is judged as the one that read was judged against, read afresh from the same filings; otherwise a held
 * read of its own, kept by nobody, with `doors`.
 */
const anchoredInTheView = async (
  view: JudgeView, doors: HeldDoorsHere | undefined, directory: DirectoryBelieved, asked: RecordsAsked,
): Promise<RecordsHeldHere> => {
  const filings = await view.filings();
  const as = judgedAs(directory);
  const kept = handed.get(view);
  if (kept === undefined || kept.filings !== filings || kept.as === as) {
    handed.set(view, { directory, filings, as });
    return (await view.held(asked)).records;
  }
  if (doors === undefined) return notGiven('what its records anchor')();
  return heldThrough(heldReadsOf(view), doors, directory, asked);
};

/** The judges' reads through `view`: one read of each thing for every judge of the step or screen. */
const readsOfTheView = (view: JudgeView, held?: HeldDoorsHere): JudgeReads => Object.freeze<JudgeReads>({
  company: view.company,
  account: () => view.account(),
  filings: () => view.filings(),
  list: (kind) => view.list(kind),
  holders: () => view.holders(),
  grants: grantsReadWith((asked) => view.records(asked), view.company),
  anchored: (directory, asked) => anchoredInTheView(view, held, directory, asked),
  layer: (name, build) => view.layer(name, () => build()),
  tree: view.tree,
  manifest: view.manifest,
  onChain: () => view.doors.onChain(),
  anchorHeads: (ask) => view.doors.builder.anchorHeads(ask),
});

const notGiven = (what: string) => async (): Promise<never> => {
  throw new Error(`this read of the company was given no way to read ${what}, so it reads none.`);
};

/** The judges' reads of company `companyId` through its view, which every judge of the step or screen shares. */
export const judgeReadsOf = (
  d: { readonly view: (companyId: string) => JudgeView }, companyId: string, held?: HeldDoorsHere,
): JudgeReads => {
  const view = d.view(companyId);
  if (view.company !== companyId) {
    throw new Error(`the read of company ${view.company} was handed in for company ${companyId}, so nothing of either is read through it.`);
  }
  return readsOfTheView(view, held);
};

/** How each part built on the directory's filings is built, given the parts it rests on. */
interface OpeningSteps<R> {
  /** The directory with an empty roster, read only to open the company's keys. */
  readonly directoryForKeys: () => Promise<DirectoryHereDeps>;
  readonly companyKeys: (directoryForKeys: DirectoryRead) => Promise<CompanyKeyHere>;
  readonly roster: (companyKeys: () => Promise<CompanyKeyHere>) => Promise<R>;
  /** The directory with the roster, which its judge uses to name a seat holding another records key. */
  readonly directory: (companyKeys: CompanyKeyHere, roster: () => Promise<R>) => DirectoryHereDeps;
}

/** The parts built on the directory's filings, each built when first asked, after the parts it rests on. */
export interface OpenedInOrder<R> {
  directoryForKeys(): Promise<DirectoryRead>;
  companyKeys(): Promise<CompanyKeyHere>;
  roster(): Promise<R>;
  directory(): Promise<DirectoryRead>;
  judge(): Promise<FreshJudge>;
}

const readOf = (deps: DirectoryHereDeps): DirectoryRead => (asked) => directoryHere(deps, asked);

/** The parts built on `reads`' filings in the one order, each under `name` (the seat and how its keys are asked for). */
export function inOrder<R extends Pick<Account, 'signers'> | null>(
  reads: Pick<JudgeReads, 'layer'>, name: string, steps: OpeningSteps<R>,
): OpenedInOrder<R> {
  const part = <T>(which: string, build: () => Promise<T>): Promise<T> => reads.layer(`${name}:${which}`, build);
  const forKeys = () => part('directory-for-keys', steps.directoryForKeys);
  const companyKeys = () => part('company-keys', async () => steps.companyKeys(readOf(await forKeys())));
  const roster = () => part('roster', () => steps.roster(companyKeys));
  const directory = () => part('directory', async () => steps.directory(await companyKeys(), roster));
  return Object.freeze({
    directoryForKeys: async () => readOf(await forKeys()),
    companyKeys,
    roster,
    directory: async () => readOf(await directory()),
    judge: async () => directoryJudge(await directory()),
  });
}

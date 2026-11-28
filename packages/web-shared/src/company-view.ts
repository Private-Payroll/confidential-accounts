/**
 * **ONE READ OF A COMPANY, KEPT FOR ONE STEP OR ONE OPENING OF A SCREEN.** A view asks its source (records-source.ts)
 * and its doors (company-view-doors.ts) for what the step or screen needs, joins the asks made together into one
 * request for each kind of thing asked (company-view-batch.ts), and keeps every answer until it ends: what was read
 * once is never read again by the same view, however many callers ask. A step or screen names what it will read
 * (`declare`) so the records it needs are proven in one held read. A device that reads the company on the chain
 * itself gives the view those reads as a door (`ViewDoors.chain`), and the view asks the source for none of them.
 *
 * Every write goes through `write`, which first checks the company has not changed since the view read it
 * (company-view-probe.ts), then sends, then forgets every answer the write can change: a record's own answers for a
 * record, and for an entry, a header or a directory filing, the held answer, the filings and everything built on them;
 * for a proven call sent through the service, the account's anchors and the held answer.
 * A write the service refused, or whose outcome is not known, ends the view: nothing is retried from a kept answer.
 *
 * Before it answers its first read, a view reads what the check compares: the directory, who holds the company and the
 * read grants. Every record it then serves by name (`newest`, `records`, `vaultRecords`, and each record a held read
 * was asked for) is read with its newest version, and the check asks again about each. The people list is compared by
 * the records it names (`listedRecords`). Of the answers that carry no version, the check compares the facts a write is
 * built from (`servedFactsOf`): the account's roster, waiting signers and wrapped keys, the invitations, and each handover served. The
 * view's own write lets go of the facts it changes with the answers it forgets (`STALE_AFTER`), and the next read of
 * one serves it afresh; so a step never writes after its own write from an answer of that kind it read before it.
 * The other lists are not compared, for the reasons `servedFactsOf` gives.
 *
 * What is built on the filings (the directory used to open the company's keys, the keys, the roster, the directory
 * with the roster, the judge of every filing) is built once per view by the code that knows how (`layer`), and
 * forgotten with the filings.
 */
import type { AccountRoleEntry } from 'midnight-identity/profile/records-key';
import type { Hex } from '../../../src/core/crypto.js';
import { recordKeyOf } from '../../../src/midnight/record-manifest.js';
import type { HeadersPage, KindAsked, ProofsAsk, ProofsGiven, RecordName } from '../../../src/midnight/record-tree.js';
import type { RecordsAsked } from '../../../src/midnight/records-held.js';
import type { DirectoryFiling } from '../../../src/midnight/seat-directory.js';
import { JoinedAsks } from './company-view-batch.js';
import { countedDoors, once, Tally, type RolesRead, type ViewCounts, type ViewDoors } from './company-view-doors.js';
import type { AnchorsOnChain } from './governed-call-builder.js';
import { treeKeptInMemory, type TreeKept } from './tree-kept-here.js';
import type { DirectoryBelieved } from './vault-page-doors.js';
import {
  adopts,
  Baseline,
  CompanyChangedMeanwhile,
  directoryVersionOf,
  ENDED_BY_ANOTHER_SIGNER,
  FACT_KEY,
  GRANTS_NAME,
  holdersStandingOf,
  probe,
  VaultNotAdopted,
  type HoldersStanding
} from './company-view-probe.js';
import type { ManifestService, TreeService } from './record-entered-here.js';
import type { ReadHere } from './records-anchored-here.js';
import {
  LIST_FACT,
  listedRecords,
  manifestServiceOf,
  servedFactsOf,
  treeServiceOf,
  type CompanyRecordAsked,
  type ListKind,
  type RecordSource,
  type RecordWrite,
  type VaultRecordAsked
} from './records-source.js';

/** Why a view ended: this side's own send, another signer's change found, a write refused or not known, or any other end. */
type ViewEndedAs = 'sent' | 'changed' | 'refused' | 'not-adopted' | 'ended';

/** The view has ended (a write refused or not known, a reload, a sign-out, another company): nothing more is read from it. */
export class ViewEnded extends Error {
  constructor(readonly why: string) {
    super(`this read of the company has ended (${why}), so nothing more is read or written through it. Open it again.`);
  }
}

/** Why a view ends when its own side sent to the chain: what it read is stale until the company is read again. */
export const THE_STEP_SENT = 'the step sent to the chain, so the company is read again before it is used';

/** What a step or screen will read, named before it reads: records by name, whole kinds, and every entry not yet anchored. */
export interface Declared {
  readonly records?: readonly RecordName[];
  readonly kinds?: readonly KindAsked[];
  /** The record of every entry not yet anchored, as an anchor reads them: declared before the directory is read, one held read serves both. */
  readonly everyPending?: true;
}

/** A record named with the newest version a read of it found. */
export interface RecordReadAt {
  readonly name: RecordName;
  readonly version: number;
}

/** How the view reads held: the read of the records the company anchored and has not anchored yet (`recordsHeldHere`). */
export type HeldReader = (view: CompanyView<unknown>, asked: RecordsAsked) => Promise<ReadHere>;

/** The source's reads a view answers, each read once until a write that can change it (`STALE_AFTER`). */
type ReadsOnce = Pick<
  RecordSource,
  | 'account'
  | 'filings'
  | 'records'
  | 'vaultRecords'
  | 'handovers'
  | 'vendorHandovers'
  | 'list'
  | 'standing'
  | 'callState'
  | 'vaultChain'
  | 'payoutState'
  | 'authority'
  | 'committeeChange'
  | 'vaultKeys'
>;

/** One company, read once. `H` is how this device reads who holds it. */
export interface CompanyView<H> extends ReadsOnce {
  readonly company: string;
  /** Names what will be read, so the next held read proves it together with everything declared before. */
  declare(asks: Declared): void;
  /** The newest version entered of each record named; each record answered is one the check before a write asks about again. */
  newest(names: readonly RecordName[]): Promise<readonly number[]>;
  /** The account's roles asked, as the chain holds them: each key read once, and the keys not yet read asked together. */
  roles(asked: readonly string[]): Promise<RolesRead>;
  holders(): Promise<H>;
  /** Every declared record and kind, proven in one held read; a read declaring nothing new answers from the last. */
  held(more?: RecordsAsked): Promise<ReadHere>;
  /**
   * Lets go of the held answer and all it was built from, as an entries write does, with the chain's head and the
   * newest versions, so the next held read is made afresh: for a body read after the held answer was, which it does
   * not name. Once a view: true when it let go, false when this view already read held again.
   */
  heldAgain(): Promise<boolean>;
  /** What is built once per view on the filings, by `build`, under `name`; forgotten with the filings. */
  layer<T>(name: string, build: (view: CompanyView<H>) => Promise<T>): Promise<T>;
  /** The record tree and the manifest, as the code that anchors and files asks them, through this view. */
  readonly tree: TreeService;
  readonly manifest: ManifestService;
  /** A new round of reading again for one press of the person's, counted by the view from 1; no write drops the count. */
  nextRound(): number;
  readonly doors: Pick<ViewDoors<H>, 'onChain'> & {
    /** The builder's reads through the view; the vaults on the chain refuse when the opener gave no way to read them. */
    readonly builder: Required<ViewDoors<H>['builder']>;
    /** The account's anchors read again now, counted, never from a kept answer: what a send is watched and a race judged by. */
    readonly onChainNow: () => Promise<AnchorsOnChain>;
    /**
     * The account, as the view reads it once: what a door needs before the view's first read (where the company is on
     * the chain), so it does not wait for that read. The same answer `account()` gives.
     */
    readonly account: () => Promise<unknown>;
  };
  /** The device's own stores every read and anchor through this view shares (`ViewDoors.kept`). */
  readonly stores: Partial<TreeKept>;
  /** The company's directory with its records, believed over this view (`ViewDoors.directory`), once until a write drops it. */
  directory(): Promise<DirectoryBelieved>;
  /** Checks nothing moved, then sends each write in order; the service's answer to each. */
  write(batch: readonly RecordWrite[]): Promise<readonly unknown[]>;
  /**
   * Records a step before this one read, each at the newest version it read: the check before this view's next write
   * asks for each again and stops when any moved since (`Baseline.readBefore`).
   */
  readBefore(read: readonly RecordReadAt[]): void;
  /**
   * The check alone, for a send that leaves the device straight for the chain, read through `through` when given (the
   * same company's records by another way to its service); who holds the company, as the check read it.
   */
  stillAsRead(through?: RecordSource): Promise<H>;
  /** Ends the view; `as` says why, so whoever holds it knows whether to open it again. */
  end(why: string, as?: ViewEndedAs): void;
  readonly ended: string | null;
  readonly endedAs: ViewEndedAs | null;
  /** What the view read, as its check compares it, for a view opened again after this side's own send. */
  carried(): Baseline;
  counts(): ViewCounts;
}

const kindKey = (k: KindAsked): string => `${k.store}:${k.kind}`;

/** The source with every ask counted in `tally`. */
const countedSource = (source: RecordSource, tally: Tally): RecordSource => {
  const counted =
    <A extends unknown[], R>(name: string, f: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      tally.add(name);
      return f(...a);
    };
  return Object.freeze({
    company: source.company,
    account: counted('account', source.account),
    filings: counted('filings', source.filings),
    newest: counted('newest', source.newest),
    pending: counted('pending', source.pending),
    proofs: counted('proofs', source.proofs),
    headers: counted('headers', source.headers),
    records: counted('records', source.records),
    vaultRecords: counted('vaultRecords', source.vaultRecords),
    handovers: counted('handovers', source.handovers),
    vendorHandovers: counted('vendorHandovers', source.vendorHandovers),
    list: counted('list', source.list),
    standing: counted('standing', source.standing),
    callState: counted('callState', source.callState),
    vaultChain: counted('vaultChain', source.vaultChain),
    payoutState: counted('payoutState', source.payoutState),
    write: counted('write', source.write),
    authority: counted('authority', source.authority),
    committeeChange: counted('committeeChange', source.committeeChange),
    vaultKeys: counted('vaultKeys', source.vaultKeys),
    ...(source.movesOf === undefined ? {} : { movesOf: source.movesOf })
  });
};

/** The answers a view keeps, in one place, so a write knows what to forget. */
class Kept {
  readonly answers = new Map<string, Promise<unknown>>();
  get<T>(key: string, read: () => Promise<T>): Promise<T> {
    const there = this.answers.get(key);
    if (there !== undefined) return there as Promise<T>;
    const answer = read();
    this.answers.set(key, answer);
    answer.catch(() => {
      if (this.answers.get(key) === answer) this.answers.delete(key);
    });
    return answer;
  }
  drop(match: (key: string) => boolean): void {
    for (const key of [...this.answers.keys()]) if (match(key)) this.answers.delete(key);
  }
}

/** An answer from the chain that did not name a key it was asked about: no key of it is kept, and the ask is answered with no roles. */
class RoleNotNamed extends Error {}

/**
 * The account's roles asked, each key's answer kept on its own: an ask whose keys are all kept is answered from them with
 * no new read, and the keys not kept are asked together in one read. An answer that does not name every key it was
 * asked, in order, keeps none of them and is given back with no roles, so the caller refuses it as it would the chain's.
 */
const rolesKept = async <H>(st: ViewState<H>, asked: readonly string[]): Promise<RolesRead> => {
  const keyOf = (k: string): string => `roles:${k}`;
  const missing = [...new Set(asked)].filter((k) => !st.kept.answers.has(keyOf(k)));
  if (missing.length > 0) {
    const read = st.door.roles(missing);
    missing.forEach(
      (k, i) =>
        void st.kept
          .get(keyOf(k), async () => {
            const entry = (await read).roles;
            if (entry === undefined || entry.length !== missing.length || entry[i]?.key !== k) throw new RoleNotNamed();
            return entry[i]!;
          })
          .catch(() => {
            /* Seen below, through the same kept answer, where the ask is answered. */
          })
    );
  }
  const settled = await Promise.allSettled(
    asked.map((k) => st.kept.answers.get(keyOf(k)) as Promise<AccountRoleEntry>)
  );
  const failed = settled.find(
    (r): r is PromiseRejectedResult => r.status === 'rejected' && !(r.reason instanceof RoleNotNamed)
  );
  if (failed !== undefined) throw failed.reason;
  if (settled.some((r) => r.status === 'rejected')) return {};
  return { roles: settled.map((r) => (r as PromiseFulfilledResult<AccountRoleEntry>).value) };
};

/** Everything one view holds: its counted source and doors, what it read, what it was asked to read, whether it ended. */
interface ViewState<H> {
  readonly src: RecordSource;
  readonly door: ReturnType<typeof countedDoors<H>>;
  readonly doors: ViewDoors<H>;
  readonly tally: Tally;
  readonly base: Baseline;
  readonly kept: Kept;
  readonly declared: {
    readonly records: Map<string, RecordName>;
    readonly kinds: Map<string, KindAsked>;
    founding: boolean;
    everyPending: boolean;
  };
  heldAsked: string;
  /** Whether the held answer was let go once already for a body newer than it (`heldAgain`). */
  heldReadAgain: boolean;
  /** How many rounds of reading again the view has handed out (`nextRound`). */
  rounds: number;
  ended: string | null;
  endedAs: ViewEndedAs | null;
  /** The view's first read of what the check compares (the directory, who holds the company, the read grants), once. */
  started: Promise<void> | null;
  readonly holdersRead: () => Promise<H>;
  readonly newest: JoinedAsks<RecordName, number>;
  readonly records: JoinedAsks<CompanyRecordAsked, unknown>;
  readonly vaultRecords: JoinedAsks<VaultRecordAsked, unknown>;
  readonly handovers: JoinedAsks<string, unknown>;
  readonly vendorHandovers: JoinedAsks<string, unknown>;
}

const stateOf = <H extends HoldersStanding>(
  source: RecordSource,
  doors: ViewDoors<H>,
  from?: Baseline
): ViewState<H> => {
  const tally = new Tally();
  const src = countedSource(doors.chain === undefined ? source : { ...source, ...doors.chain }, tally);
  const door = countedDoors(doors, tally);
  const base = from?.copy() ?? new Baseline();
  return {
    src,
    door,
    doors,
    tally,
    base,
    kept: new Kept(),
    declared: { records: new Map(), kinds: new Map(), founding: false, everyPending: false },
    heldAsked: '',
    heldReadAgain: false,
    rounds: 0,
    ended: null,
    endedAs: null,
    started: null,
    holdersRead: once(async () => {
      const h = await door.holders();
      base.holders ??= holdersStandingOf(h);
      return h;
    }),
    newest: new JoinedAsks<RecordName, number>(recordKeyOf, (part) => src.newest(part)),
    records: new JoinedAsks<CompanyRecordAsked, unknown>(
      (r) => `${r.kind}:${r.id}:${r.every === true}`,
      (part) => src.records(part)
    ),
    vaultRecords: new JoinedAsks<VaultRecordAsked, unknown>(
      (r) => `${r.vault}:${r.record}:${r.every === true}`,
      (part) => src.vaultRecords(part)
    ),
    handovers: new JoinedAsks<string, unknown>(
      (p) => p,
      (part) => src.handovers(part)
    ),
    vendorHandovers: new JoinedAsks<string, unknown>(
      (v) => v,
      (part) => src.vendorHandovers(part)
    )
  };
};

const live = <H>(st: ViewState<H>): void => {
  if (st.ended !== null) throw new ViewEnded(st.ended);
};

/**
 * The view's first read: the directory, who holds the company and the read grants' newest version, taken before any
 * answer is given, so the check before a write compares every one of them with what was true when the view began.
 */
const started = <H>(st: ViewState<H>, src: RecordSource = st.src): Promise<void> => {
  if (st.started !== null) return st.started;
  const grants = src === st.src ? st.newest.get(GRANTS_NAME) : src.newest([GRANTS_NAME]).then((v) => v[0]!);
  const first = Promise.all([filingsOf(st, src), st.holdersRead(), grants]).then(([, , grants]) => {
    st.base.served(GRANTS_NAME, grants);
  });
  st.started = first;
  first.catch(() => {
    if (st.started === first) st.started = null;
  });
  return first;
};

/** `read` once the view has begun, or a refusal when it has ended: a read of an ended view never reaches the source. */
const guarded = <H, T>(st: ViewState<H>, read: () => Promise<T>): Promise<T> =>
  st.ended !== null
    ? Promise.reject(new ViewEnded(st.ended))
    : started(st).then(() => {
        live(st);
        return read();
      });

/**
 * The newest version entered of each record named, read with the records themselves and kept as what the view served,
 * so the check before a write stops when any of them moved.
 */
const servedNow = <H>(st: ViewState<H>, names: readonly RecordName[]): Promise<void> =>
  st.newest.many(names).then((versions) => names.forEach((n, i) => st.base.served(n, versions[i]!)));

/**
 * A list as it was answered, its facts kept when it is compared by them (`LIST_FACT`), with every record it names kept as served, so the check before a write stops when another
 * signer enters a newer version of a person a payment was built from (`listedRecords`). Each is kept at the newest
 * version entered, read with the list, or at the version the list gave if that is older: a version filed and not yet
 * entered is not taken as anyone's change, and one entered after the list was read is.
 */
const listServed = async <H>(st: ViewState<H>, kind: ListKind, answer: unknown): Promise<unknown> => {
  const fact = LIST_FACT[kind];
  if (fact !== undefined) st.base.servedAs(`list:${kind}`, servedFactsOf(fact, answer));
  const listed = listedRecords(kind, answer);
  if (listed.length === 0) return answer;
  const entered = await st.newest.many(listed.map((l) => l.name));
  listed.forEach((l, i) => st.base.served(l.name, Math.min(l.version, entered[i]!)));
  return answer;
};

const filingsOf = <H>(st: ViewState<H>, src: RecordSource = st.src): Promise<readonly DirectoryFiling[]> =>
  st.kept.get('filings', async () => {
    const f = await src.filings();
    st.base.directory ??= directoryVersionOf(f);
    return f;
  });

/**
 * Adds `more` to what is declared, and the records and kinds a held read is asked for, with the key that tells two
 * apart. A record of a kind already declared is not named again: the kind's read proves every record of it, and such a
 * record is given back (`ofKinds`) to be kept as served from that read.
 */
const heldAskedOf = <H>(
  st: ViewState<H>,
  more: RecordsAsked | undefined
): {
  readonly asked: RecordsAsked;
  readonly key: string;
  readonly ofKinds: readonly RecordName[];
} => {
  const d = st.declared;
  for (const k of more?.kinds ?? []) d.kinds.set(kindKey(k), k);
  const ofKinds: RecordName[] = [];
  for (const r of more?.records ?? []) {
    if (d.kinds.has(kindKey(r))) ofKinds.push(r);
    else d.records.set(recordKeyOf(r), r);
  }
  d.founding ||= more?.founding === true;
  d.everyPending ||= more?.everyPending === true;
  return {
    asked: {
      records: [...d.records.values()],
      kinds: [...d.kinds.values()],
      ...(d.founding ? { founding: true } : {}),
      ...(d.everyPending ? { everyPending: true } : {})
    },
    key: JSON.stringify([[...d.records.keys()], [...d.kinds.keys()], d.founding, d.everyPending]),
    ofKinds
  };
};

/**
 * Keeps as served each record `names` holds of a kind the held read proved whole, at the newest version that read saw
 * of it: anchored, or waiting whether the read believed that entry or left it out (`seenWaiting`), and none when it saw
 * none. No ask of its own, and never a later read of the newest, so an entry made after the read still stops the next
 * write and one the read saw and set aside does not. A held answer that carries no records is refused.
 */
const servedFromHeld = <H>(st: ViewState<H>, read: ReadHere, names: readonly RecordName[]): void => {
  if (names.length === 0) return;
  const records = (read as Partial<ReadHere>).records;
  if (records === undefined)
    throw new Error('the held read answered no records, so a record it was asked to prove is not checked against it.');
  for (const name of names) {
    const key = recordKeyOf(name);
    st.base.served(
      name,
      Math.max(
        0,
        ...(records.history.get(key) ?? []).map((v) => v.version),
        ...records.notYetAnchored.filter((e) => recordKeyOf(e) === key).map((e) => e.version),
        records.seenWaiting?.get(key) ?? 0
      )
    );
  }
};

/** What a proposal's filing or step can change: its lists, and, when it sends a call, the chain and what is believed from it. */
const proposalMoved = (k: string): boolean =>
  k === 'list:proposals' ||
  k === 'list:runs' ||
  k === 'account' ||
  k === 'onChain' ||
  k === 'held' ||
  k === 'callState' ||
  k === 'authority' ||
  k === 'committee-change' ||
  k.startsWith('roles:') ||
  k.startsWith('standing:') ||
  k.startsWith('layer:') ||
  k.startsWith('pending:') ||
  k.startsWith('proofs:') ||
  k.startsWith('headers:');

/** What a call sent to the chain can change: the chain's own answers, and everything proven or built on them. */
const chainMoved = (k: string): boolean =>
  k === 'onChain' ||
  k === 'held' ||
  k === 'callState' ||
  k === 'authority' ||
  k === 'committee-change' ||
  k.startsWith('roles:') ||
  k.startsWith('standing:') ||
  k.startsWith('vault:') ||
  k.startsWith('layer:') ||
  k.startsWith('pending:') ||
  k.startsWith('proofs:') ||
  k.startsWith('headers:');

/** What each write can change, as the kept answers it makes stale. */
const STALE_AFTER: Readonly<Record<RecordWrite['to'], (k: string) => boolean>> = Object.freeze({
  record: () => false,
  'vault-record': () => false,
  roster: (k: string) =>
    k === 'account' || k === 'list:vault-key-offers' || k === 'vault-keys' || k.startsWith('layer:'),
  'vault-keys': (k: string) =>
    k === 'account' || k === 'list:vault-key-offers' || k === 'vault-keys' || k.startsWith('layer:'),
  admission: (k: string) =>
    k === 'account' || k === 'list:vault-key-offers' || k === 'vault-keys' || k.startsWith('layer:'),
  readers: (k: string) => k === 'account' || k.startsWith('layer:'),
  'proposal-filed': (k: string) => proposalMoved(k),
  proposal: (k: string) => proposalMoved(k),
  carried: (k: string) => proposalMoved(k),
  invitation: (k: string) => k === 'list:invites' || k === 'list:people',
  'signer-withdrawn': (k: string) => k === 'account' || k === 'list:invites' || k.startsWith('layer:'),
  person: (k: string) => k === 'list:people',
  'vendor-admitted': () => false,
  'self-payee': (k: string) => k === 'list:people',
  run: (k: string) => k === 'list:runs',
  fee: () => false,
  'fee-done': () => false,
  entries: (k: string) =>
    k === 'filings' ||
    k === 'held' ||
    k.startsWith('layer:') ||
    k.startsWith('pending:') ||
    k.startsWith('proofs:') ||
    k.startsWith('headers:'),
  header: (k: string) =>
    k === 'filings' ||
    k === 'held' ||
    k.startsWith('layer:') ||
    k.startsWith('pending:') ||
    k.startsWith('proofs:') ||
    k.startsWith('headers:'),
  proven: chainMoved,
  /* A vault send can adopt or hand over a vault, so the account and its list of vaults are read again too. */
  'vault-send': (k: string) => chainMoved(k) || k === 'account' || k === 'list:vaults',
  'vault-start': (k: string) => chainMoved(k) || k === 'account' || k === 'list:vaults',
  /* Signatures given or an update sent: the change owed, who holds the account as the service reads it, and the chain's answers are read again. */
  'committee-change': (k: string) => k === 'committee-change' || k === 'authority' || chainMoved(k),
  directory: (k: string) =>
    k === 'filings' ||
    k === 'held' ||
    k.startsWith('layer:') ||
    k.startsWith('pending:') ||
    k.startsWith('proofs:') ||
    k.startsWith('headers:')
});

/**
 * Forgets what one write can change: the kept answers `STALE_AFTER` names, the records it filed or entered, and,
 * whatever was written, every read of the chain kept for the step (`chain-read:`).
 */
const forget = <H>(st: ViewState<H>, w: RecordWrite): void => {
  st.kept.drop(STALE_AFTER[w.to]);
  st.base.forgetFacts(STALE_AFTER[w.to]);
  st.kept.drop((k) => k.startsWith('layer:chain-read:'));
  if (STALE_AFTER[w.to]('held')) st.heldAsked = '';
  if (w.to === 'record') {
    st.records.drop((k) => k.startsWith(`${w.kind}:${w.id}:`));
    st.newest.drop((k) => k === recordKeyOf({ store: 'company', kind: w.kind, id: w.id }));
    /* The read grants decide who the company's keys are sealed to: what was opened under the old grants is built again. */
    if (w.kind === GRANTS_NAME.kind) st.kept.drop((k) => k.startsWith('layer:'));
  }
  if (w.to === 'vault-record') {
    st.vaultRecords.drop((k) => k.startsWith(`${w.vault}:${w.record}:`));
    st.newest.drop((k) => k === recordKeyOf({ store: 'vault', kind: w.record, id: w.vault }));
  }
  if (w.to === 'roster' || w.to === 'admission') st.records.drop((k) => k.startsWith('roster:'));
  if (w.to === 'person' || w.to === 'vendor-admitted') {
    const kind = w.to === 'person' ? 'person' : 'vendor';
    st.records.drop((k) => k.startsWith(`${kind}:${w.id}:`));
    st.newest.drop((k) => k === recordKeyOf({ store: 'company', kind, id: w.id }));
  }
  /* An admission: the service lets the subject's handover go and the offer of their invitation with it. */
  if ((w.to === 'person' && w.act === 'admit') || w.to === 'vendor-admitted') {
    const handover = w.to === 'person' ? FACT_KEY.handover(w.id) : FACT_KEY.vendorHandover(w.id);
    (w.to === 'person' ? st.handovers : st.vendorHandovers).drop((k) => k === w.id);
    st.kept.drop((k) => k === FACT_KEY.invites);
    st.base.forgetFacts((k) => k === handover || k === FACT_KEY.invites);
  }
  if (w.to === 'vault-start') st.vaultRecords.drop((k) => k.startsWith(`${w.vault}:`));
  if (w.to === 'vault-send')
    for (const c of w.calls) if (c.vault !== undefined) st.vaultRecords.drop((k) => k.startsWith(`${c.vault}:`));
  if (w.to === 'entries' || w.to === 'header')
    for (const e of w.entries ?? []) st.newest.drop((k) => k === recordKeyOf(e));
};

const endOn = <H>(st: ViewState<H>, why: string, as: ViewEndedAs = 'ended'): void => {
  if (st.ended !== null) return;
  st.ended = why;
  st.endedAs = as;
  /* Nothing more is read through it, so it lets go of every answer it kept, the keys its layers opened among them. */
  st.kept.drop(() => true);
  for (const asks of [st.newest, st.records, st.vaultRecords, st.handovers, st.vendorHandovers]) asks.drop(() => true);
};

/** The check before a write or a send; a change found, or the company not read again, ends the view. */
const checked = async <H extends HoldersStanding>(st: ViewState<H>, through?: RecordSource): Promise<H> => {
  live(st);
  const source = through === undefined ? st.src : countedSource(through, st.tally);
  await started(st, source);
  try {
    return await probe(
      {
        source,
        holdersNow: () => st.door.freshHolders(),
        ...(st.doors.pause === undefined ? {} : { pause: st.doors.pause })
      },
      st.base
    );
  } catch (e) {
    if (e instanceof CompanyChangedMeanwhile) endOn(st, ENDED_BY_ANOTHER_SIGNER, 'changed');
    else endOn(st, 'the company could not be read again before a write', 'refused');
    throw e;
  }
};

/* Money goes into a vault only while the holders the check just read adopt it, which a vault's own deposits do not check. */
const DEPOSITS: ReadonlySet<string> = new Set(['deposit', 'public-deposit']);

/** The vault a deposit among the calls of `w` goes into that `holders` do not adopt, if any. */
const notAdoptedIn = (w: RecordWrite, holders: HoldersStanding): string | null => {
  if (w.to !== 'vault-send') return null;
  for (const c of w.calls) if (DEPOSITS.has(c.act) && !adopts(holders, c.vault!)) return c.vault!;
  return null;
};

/**
 * The check, then each write in order; a write refused or not known ends the view. A deposit into a vault the checked
 * holders do not adopt sends nothing, and a deposit into a vault an earlier write of the batch stopped adopting is not
 * sent. A send into a vault, or a write its source says moves who holds the company, ends the view as sent: its next
 * use reads again from this reading, moved by exactly what the writes that landed said, a batch stopped part way too.
 */
const written = async <H extends HoldersStanding>(
  st: ViewState<H>,
  batch: readonly RecordWrite[]
): Promise<readonly unknown[]> => {
  let holders: H;
  try {
    holders = await checked(st);
  } catch (e) {
    /* The check stops before the first write: nothing of the batch was sent, whatever stopped it. */
    if (e !== null && typeof e === 'object') Object.assign(e, { nothingWasSent: true, thisSendNotSent: true });
    throw e;
  }
  const answers: unknown[] = [];
  let sent = false;
  /* What landed before a write that did not still moved who holds the company: the next view reads on from that. */
  const settled = (): void => {
    if (sent) st.base.moveHolders(holdersStandingOf(holders));
  };
  const notAdopted = (vault: string): never => {
    settled();
    endOn(st, 'a deposit was asked into a vault the company does not adopt', 'not-adopted');
    throw Object.assign(new VaultNotAdopted(vault), {
      thisSendNotSent: true,
      ...(answers.length === 0 ? { nothingWasSent: true } : {})
    });
  };
  for (const w of batch) {
    const refused = notAdoptedIn(w, holders);
    if (refused !== null) notAdopted(refused);
  }
  for (const w of batch) {
    /* Each deposit again, against the holders as the writes before it in the batch moved them. */
    const refused = notAdoptedIn(w, holders);
    if (refused !== null) notAdopted(refused);
    try {
      answers.push(await st.src.write(w));
    } catch (e) {
      settled();
      endOn(st, 'a write was refused, or its outcome is not known', 'refused');
      /*
       * Which write of the batch failed, so whoever watches the sends counts that one and not the others, and the
       * answers of the writes before it, which landed.
       */
      if (e !== null && typeof e === 'object') Object.assign(e, { failedWrite: w, answered: [...answers] });
      throw e;
    }
    st.base.acknowledged(w, st.doors.filer?.() ?? null);
    forget(st, w);
    const moves = st.src.movesOf?.(w);
    if (moves !== undefined) holders = moves(holders);
    sent ||= w.to === 'vault-send' || w.to === 'vault-start' || moves !== undefined;
  }
  if (sent) {
    settled();
    endOn(st, THE_STEP_SENT, 'sent');
  }
  return answers;
};

/**
 * **A HEADER FILED AGAIN AS A REPAIR** (`TreeService.refileHeader`): it changes nothing a step read (a header this
 * device already kept, its entries already entered), so it is sent without the check and never ends the view, and the
 * view lets go of what a header write changes. Only a filing the service answered as kept is taken as this device's
 * own: one refused or unanswered is not, so a change by another seat it might stand in front of still stops the next
 * write, and a re-file that landed unanswered can stop it once, which is safe.
 */
const refiled = async <H>(st: ViewState<H>, w: RecordWrite): Promise<boolean> => {
  if (st.ended !== null) return false;
  let kept = true;
  try {
    await st.src.write(w);
  } catch {
    kept = false;
  }
  if (kept) st.base.acknowledged(w, st.doors.filer?.() ?? null);
  forget(st, w);
  return kept;
};

/** Handovers asked together, each served with its facts. */
const handedOver = async <H>(
  st: ViewState<H>,
  ids: readonly string[],
  asks: JoinedAsks<string, unknown>,
  keyOf: (id: string) => string,
  fact: 'handover' | 'vendor-handover'
): Promise<unknown[]> => {
  const answers = await asks.many(ids);
  ids.forEach((id, i) => st.base.servedAs(keyOf(id), servedFactsOf(fact, answers[i])));
  return answers;
};

/** The record tree and the manifest through the view: kept answers, its newest versions, and writes through its one write. */
const servicesOf = <H extends HoldersStanding>(
  st: ViewState<H>,
  newest: CompanyView<H>['newest']
): Pick<CompanyView<H>, 'tree' | 'manifest'> => {
  const one = (w: RecordWrite) => written(st, [w]).then((a) => a[0]);
  return {
    tree: {
      ...treeServiceOf({
        ...st.src,
        write: one,
        headers: (after: number, limit: number): Promise<HeadersPage> =>
          guarded(st, () => st.kept.get(`headers:${after}:${limit}`, () => st.src.headers(after, limit))),
        proofs: (ask: ProofsAsk): Promise<ProofsGiven | null> =>
          guarded(st, () => st.kept.get(`proofs:${JSON.stringify(ask)}`, () => st.src.proofs(ask))),
        pending: (root: Hex) => guarded(st, () => st.kept.get(`pending:${root}`, () => st.src.pending(root)))
      }),
      refileHeader: async (accountId, header, entries) => {
        let kept = false;
        await treeServiceOf({
          ...st.src,
          write: async (w) => {
            kept = await refiled(st, w);
          }
        }).fileHeader(accountId, header, entries);
        return kept;
      }
    },
    manifest: manifestServiceOf({ ...st.src, newest, write: one })
  };
};

/** Opens a view of `source`'s company, reading outside the service through `doors`, and reading held through `held`. */
export function companyViewFor<H extends HoldersStanding>(
  source: RecordSource,
  doors: ViewDoors<H>,
  held: HeldReader,
  from?: Baseline
): CompanyView<H> {
  const st = stateOf(source, doors, from);
  /* The one read of the account a view makes, until a write changes it: its own readers and its doors share it. */
  const accountRead = (): Promise<unknown> =>
    st.kept.get(FACT_KEY.account, () =>
      st.src.account().then((answer) => {
        st.base.servedAs(FACT_KEY.account, servedFactsOf('account', answer));
        return answer;
      })
    );
  const newest: CompanyView<H>['newest'] = (names) =>
    guarded(st, async () => {
      const versions = await st.newest.many(names);
      names.forEach((n, i) => st.base.served(n, versions[i]!));
      return versions;
    });
  const view: CompanyView<H> = {
    company: source.company,
    get ended() {
      return st.ended;
    },
    get endedAs() {
      return st.endedAs;
    },
    carried: () => st.base.copy(),
    declare: (asks) => {
      heldAskedOf(st, asks);
    },
    account: () => guarded(st, accountRead),
    filings: () => guarded(st, () => filingsOf(st)),
    newest,
    records: (asked) =>
      guarded(
        st,
        async () =>
          (
            await Promise.all([
              st.records.many(asked),
              servedNow(
                st,
                asked.map((r) => ({ store: 'company' as const, kind: r.kind, id: r.id }))
              )
            ])
          )[0]
      ),
    vaultRecords: (asked) =>
      guarded(
        st,
        async () =>
          (
            await Promise.all([
              st.vaultRecords.many(asked),
              servedNow(
                st,
                asked.map((r) => ({ store: 'vault' as const, kind: r.record, id: r.vault }))
              )
            ])
          )[0]
      ),
    handovers: (people) => guarded(st, () => handedOver(st, people, st.handovers, FACT_KEY.handover, 'handover')),
    vendorHandovers: (vendors) =>
      guarded(st, () => handedOver(st, vendors, st.vendorHandovers, FACT_KEY.vendorHandover, 'vendor-handover')),
    list: (kind) =>
      guarded(st, () =>
        st.kept.get(`list:${kind}`, () => st.src.list(kind).then((answer) => listServed(st, kind, answer)))
      ),
    standing: (proposal) => guarded(st, () => st.kept.get(`standing:${proposal}`, () => st.src.standing(proposal))),
    callState: () => guarded(st, () => st.kept.get('callState', () => st.src.callState())),
    vaultChain: (vault) => guarded(st, () => st.kept.get(`vault:${vault}:chain`, () => st.src.vaultChain(vault))),
    payoutState: (vault) => guarded(st, () => st.kept.get(`vault:${vault}:payout`, () => st.src.payoutState(vault))),
    authority: () => guarded(st, () => st.kept.get('authority', () => st.src.authority())),
    committeeChange: () => guarded(st, () => st.kept.get('committee-change', () => st.src.committeeChange())),
    vaultKeys: () => guarded(st, () => st.kept.get('vault-keys', () => st.src.vaultKeys())),
    roles: (asked) => guarded(st, () => rolesKept(st, asked)),
    holders: () => guarded(st, () => st.holdersRead()),
    held: (more) =>
      guarded(st, async () => {
        const { asked, key, ofKinds } = heldAskedOf(st, more);
        if (key !== st.heldAsked) {
          st.kept.drop((k) => k === 'held');
          st.heldAsked = key;
        }
        const read = await st.kept.get(
          'held',
          async () =>
            (await Promise.all([held(view as CompanyView<unknown>, asked), servedNow(st, asked.records ?? [])]))[0]
        );
        servedFromHeld(st, read, ofKinds);
        return read;
      }),
    heldAgain: () =>
      guarded(st, async () => {
        if (st.heldReadAgain) return false;
        st.heldReadAgain = true;
        /* What an entries write lets go of, and the chain's head and the newest versions the held read is judged with. */
        st.kept.drop((k) => STALE_AFTER.entries(k) || k === 'onChain');
        st.newest.drop(() => true);
        return true;
      }),
    layer: (name, build) => guarded(st, () => st.kept.get(`layer:${name}`, () => build(view))),
    nextRound: () => {
      st.rounds += 1;
      return st.rounds;
    },
    ...servicesOf(st, newest),
    doors: {
      onChain: () => guarded(st, () => st.kept.get('onChain', st.door.onChain)),
      onChainNow: () => (st.ended !== null ? Promise.reject(new ViewEnded(st.ended)) : st.door.onChain()),
      account: () => (st.ended !== null ? Promise.reject(new ViewEnded(st.ended)) : accountRead()),
      builder: {
        anchorHeads: (ask) => guarded(st, () => st.door.builder.anchorHeads(ask)),
        vaultsOnChain: (ask) =>
          guarded(st, () =>
            st.door.builder.vaultsOnChain === undefined
              ? Promise.reject(
                  new Error(
                    "this read of the company was given no way to read its vaults on the chain (the builder's vaultsOnChain door)."
                  )
                )
              : st.door.builder.vaultsOnChain(ask)
          )
      }
    },
    stores: doors.kept?.() ?? treeKeptInMemory(),
    directory: () =>
      guarded(st, () =>
        st.kept.get('layer:directory-believed', () =>
          doors.directory === undefined
            ? Promise.reject(
                new Error('this read of the company was given no way to believe its directory, so it believes none.')
              )
            : doors.directory(view)
        )
      ),
    stillAsRead: (through) => checked(st, through),
    write: (batch) => written(st, batch),
    readBefore: (read) => {
      for (const r of read) st.base.readBefore(r.name, r.version);
    },
    end: (why, as) => endOn(st, why, as),
    counts: () => st.tally.counts
  };
  return view;
}

/**
 * **A STEP'S ONE READ OF THE COMPANY AT A TIME.** `current` is the view the step reads and writes through now; `again`
 * ends it and opens a fresh one in its place, for an attempt that follows a race (another device anchored first, or who
 * holds the company moved), so nothing of the attempt before is read from a kept answer.
 */
export interface ViewHeld<H> {
  current(): CompanyView<H>;
  again(why: string): CompanyView<H>;
}

/**
 * The step's view, opened by `open`, held one at a time. A view ended by this side's own send (`end(why, 'sent')`), or
 * by a write refused or not known, is opened again on its next use from what it read (`carried`), so the next check,
 * a send around the failed write included, still compares against the reading taken before; `again` opens a fresh
 * reading.
 */
export const viewHeldOver = <H>(open: (from?: Baseline) => CompanyView<H>): ViewHeld<H> => {
  let view = open();
  return Object.freeze<ViewHeld<H>>({
    current: () => {
      if (view.endedAs === 'sent' || view.endedAs === 'refused') view = open(view.carried());
      return view;
    },
    again: (why) => {
      view.end(why);
      view = open();
      return view;
    }
  });
};

/**
 * **A COMPANY'S RECORD TREE FOR A TEST, AND WHAT A DEVICE HOLDS OF IT**: the
 * service that keeps its headers and the chain that holds its head, built the
 * way devices build them - every header made by `nextTreeHeader` from the
 * leaves before it, every head by the account's own functions - so a test reads
 * exactly what a device would be served, and can withhold, change or race any
 * of it; and what one read holds of it: produced by the device's own read
 * (`recordsHeldHere`) over this chain and the filings the test names, so the
 * leaves of what it asked, every older version, and the filings waiting for the
 * next anchor are what a device holds. Each record read is then judged exactly
 * as a device judges it; one the test does not name is not entered, and no
 * device believes it.
 */
import {
  companyRecordEntry, directoryEntry, EMPTY_HEAD, entryIdOf, proposalEntry, runEntry, signManifestEntry,
  type BatchHolders, type ManifestEntry, type ManifestEntryBody,
} from '../midnight/record-manifest.js';
import {
  checkedAfter, GENESIS, headersPageOf, headStepOf, leafHashOf, nextTreeHeader, pendingAt, proofsOf, SparseTree,
  treeHeaderFilingRefusal, treeKeyOf, TreeKept, type CheckedHead, type HeadStep, type KindAsked, type TreeHeader, type TreeLeaf,
} from '../midnight/record-tree.js';
import type { RecordsAsked } from '../midnight/records-held.js';
import { CompactTypeBytes, CompactTypeMerkleTreeDigest, StateBoundedMerkleTree } from '@midnight-ntwrk/compact-runtime';
import { signingPublicKeyOf, type Hex } from '../core/crypto.js';
import type { SealedProposal, SealedRun } from '../core/types.js';
import { COMPANY_RECORD_KINDS, WIRE_RECORDS, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import type { Filed, RecordsEntered, TreeService } from 'vaults-web-shared/record-entered-here.js';
import type { CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import type { CheckedHeads, CheckedHeadsStore } from 'vaults-web-shared/tree-kept-here.js';
import type { DirectoryBelieved, DirectoryHereDeps, RecordsHeldHere } from 'vaults-web-shared/vault-page-doors.js';
import { treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import { heldFor, recordsHeldHere } from 'vaults-web-shared/records-anchored-here.js';
import type { AccountHeld, CommitteeKey, DirectoryFiling } from '../midnight/seat-directory.js';
import { seatBarOf } from 'midnight-identity/profile/records-key';
import {
  type AccountDeployed, anchorHeadsAfter, anchorTagIn, seatOpeningsIn, signerRootOf, type AnchorLanded, type HeadStepAsked, type SignerMaterial, type AnchorsOnChain, type GovernedCallDeps, type RoundOnChain, type VouchingRun,
} from 'vaults-web-shared/governed-call-builder.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';

/** The account's own functions and signer tree, as a test's worker holds them. */
const accountHere = {
  accountPure: pureCircuits as unknown as GovernedCallDeps['accountPure'],
  accountTree: { StateBoundedMerkleTree, CompactTypeBytes, CompactTypeMerkleTreeDigest } as unknown as GovernedCallDeps['accountTree'],
};

/** The account a test's own headers are anchored in, where a test names none: what each seat's tag is worked out over. */
export const ACCOUNT_IN_A_TEST: Hex = 'ac'.repeat(32);
/** **A STAND-IN, NAMED**: the blinding a test's seat known only by its signing secret anchors with. */
const BLINDING_IN_A_TEST: Hex = '0b'.repeat(32);

/**
 * The tag a test's seat anchors under, by the worker's own `anchorTagIn` over its signing secret and blinding, in
 * `account` (by default `ACCOUNT_IN_A_TEST`, and the stand-in blinding): what its headers name.
 */
export const tagInATest = (signingSecret: Hex, account: Hex = ACCOUNT_IN_A_TEST, blinding: Hex = BLINDING_IN_A_TEST): Hex =>
  anchorTagIn(accountHere, account, { signingSecret, blinding }) as Hex;

/**
 * Who held a test company's account, as a batch's header names them: its seats
 * in slots 0, 1, 2 ... in the order the test lists them, and the root a signer
 * tree holding them has.
 */
export const holdersOf = (h: Pick<AccountHeld, 'approvals' | 'seats'>): BatchHolders => {
  const signers = h.seats.map((x) => x.toLowerCase() as Hex);
  return { approvals: h.approvals, signerRoot: signerRootOf(accountHere, signers) as Hex, signers };
};

/**
 * The approvals a change of who is seated needs on a test's chain, as it holds
 * them: refused where the test names none, never read as no bar.
 */
export const barOnATestChain = (held: { readonly seatBar?: number }): number => {
  if (!Number.isSafeInteger(held.seatBar) || (held.seatBar as number) < 1) {
    throw new Error('the test\'s chain names no seat bar: a test says what its chain holds');
  }
  return held.seatBar as number;
};

/** One filing, as the entry naming it and the signing secret of the seat that filed it. */
export interface FiledBy { readonly entry: ManifestEntryBody; readonly signingSecret: Hex }

/**
 * **WHAT A TEST COMPANY WAS FOUNDED WITH ON ITS CHAIN**: its founding seat's
 * leaf and filing key, the company records its first header anchors - its
 * first state and its first roster - and the directory versions anchored with
 * them, all entered by that seat, which anchored the batch while it was the
 * account's only seat.
 */
export interface FoundedWith {
  readonly seat: string;
  readonly signingSecret: Hex;
  readonly records: readonly SealedCompanyRecord[];
  readonly directory?: readonly DirectoryFiling[];
  /** The founding seat's committee key alone: the account is deployed held by it (`deployedOnTheDevice`). */
  readonly committee?: readonly CommitteeKey[];
  /** The key that signed the entries of `records`, when another seat's than the founding one: what no device believes as founding. */
  readonly enteredBy?: Hex;
  /** Company records the same seat anchored in a second batch, after the first: never records the company was founded with. */
  readonly thenAnchored?: readonly SealedCompanyRecord[];
  /** The leaves the founding header names in place of the founding seat's, over the same root: leaves that do not make it. */
  readonly leaves?: readonly string[];
  /** How the account was deployed, when not on the founding signer's device (`deployedOnTheDevice`): what founds nothing. */
  readonly deployed?: AccountDeployed | null;
  /** Who holds the account now, as the wallet's read of the chain shows it; absent, the founding seat alone at one approval. */
  readonly account?: AccountHeld;
}

/** Every kind a company's records hold: what a test's records are proven for when a read names none of its own. */
const EVERY_KIND: readonly KindAsked[] = [
  ...COMPANY_RECORD_KINDS.map((kind) => ({ store: 'company' as const, kind })),
  ...WIRE_RECORDS.map((kind) => ({ store: 'vault' as const, kind })),
  { store: 'run', kind: 'run' }, { store: 'proposal', kind: 'proposal' }, { store: 'directory', kind: 'directory' },
];

/** **A COMPANY'S RECORD TREE AS DEVICES BUILD IT**, for a test: each header made from the leaves before it and proven against them. */
const aTreeBuilt = (company: string) => {
  const tree = new SparseTree();
  const current = new Map<Hex, TreeLeaf>();
  const byHash = new Map<Hex, TreeLeaf>();
  const headers: TreeHeader[] = [];
  const entries: ManifestEntry[] = [];
  /** The head the chain moved to after each header, in order. */
  const heads: Hex[] = [];
  let at: CheckedHead = GENESIS;
  return {
    current, byHash, headers, entries, heads,
    get at(): CheckedHead { return at; },
    /** Anchors `es`, signed by `secret`, judged against `held`: the header an honest anchoring device makes. */
    anchor: (es: readonly ManifestEntry[], secret: Hex, held: BatchHolders, when: string): void => {
      const keys = [...new Set(es.map(treeKeyOf))];
      const made = nextTreeHeader({
        company, before: at, entries: es, current: new Map(keys.map((k) => [k, current.get(k) ?? null])), proof: tree.proofFor({ keys }),
        priorChain: (h) => byHash.get(h), held, at: when, tag: tagInATest(secret),
      }, secret);
      if (made === null) return;
      for (const c of made.header.changes) {
        current.set(treeKeyOf(c.leaf), c.leaf);
        tree.set(treeKeyOf(c.leaf), leafHashOf(c.leaf));
        byHash.set(leafHashOf(c.leaf), c.leaf);
      }
      entries.push(...es);
      headers.push(made.header);
      at = checkedAfter(made.header, headAfterStep(headStepOf(made.header)));
      heads.push(at.head);
    },
  };
};

/** The company's first header as its founding seat anchored it: its entries, the header, and the head it left. */
export const firstBatchOf = (company: string, f: FoundedWith): { readonly entries: readonly ManifestEntry[]; readonly header: TreeHeader; readonly head: Hex } => {
  const built = foundedTree(company, { ...f, thenAnchored: [] });
  return { entries: built.entries, header: built.headers[0]!, head: built.at.head };
};

/** A test company's tree: its first header, and the second its founding seat anchored after it; empty when not founded. */
const foundedTree = (company: string, f?: FoundedWith) => {
  const built = aTreeBuilt(company);
  if (f === undefined) return built;
  const held = holdersOf({ approvals: 1, seats: [f.seat] });
  built.anchor([
    ...(f.directory ?? []).map((d) => signManifestEntry(company, directoryEntry(d), f.signingSecret)),
    ...f.records.map((r) => signManifestEntry(company, companyRecordEntry(r), f.enteredBy ?? f.signingSecret)),
  ], f.signingSecret, f.leaves === undefined ? held : { ...held, signers: f.leaves.map((l) => l.toLowerCase() as Hex) }, '2026-10-01T00:00:00.000Z');
  if ((f.thenAnchored ?? []).length > 0) {
    built.anchor(f.thenAnchored!.map((r) => signManifestEntry(company, companyRecordEntry(r), f.signingSecret)), f.signingSecret, held,
      '2026-10-02T00:00:00.000Z');
  }
  return built;
};

/**
 * **THE DIRECTORY A READ IS JUDGED BY WHERE A TEST HANDS NONE: NOBODY'S.** A read with no filing and no founded
 * company has nothing to judge, so an empty directory serves it. A read that has either is refused here: the double
 * never invents the seats that filed (it once made every named filer an admin), so a test hands the directory the
 * real reader built (`reader`), and the read judges each filing by that directory's own rules.
 */
const directoryOfNobody = (company: string, founded: FoundedWith | undefined, filed: readonly FiledBy[]): DirectoryBelieved => {
  if (founded !== undefined || filed.length > 0) {
    throw new Error('a read of filings, or of a founded company, hands its directory: the double judges them by no directory of its own');
  }
  const dir = { company, version: 0, seats: [] };
  const holders = {
    seats: [], committee: [], approvals: 1, vaultThresholds: [], policyBar: null, seatBar: seatBarOf(1, null), adoptedVaults: [], account: ACCOUNT_IN_A_TEST,
  };
  return { dir, holders: holders as never, another: new Set(), leafOf: () => null, at: (version) => (version === 0 ? { dir, digests: [] } : null) };
};

/**
 * **A STAND-IN, NAMED: A DIRECTORY A TEST WROTE OUT BY HAND**, which replays no filings and so cannot say what it held at an
 * earlier version (`at` gives null at every version, or is absent). It is read as that same directory at every version up to its own,
 * with the digests of the directory versions the company was founded with. A directory whose `at` answers is left as it is.
 */
const handMade = (reader: DirectoryBelieved, digests: readonly Hex[]): DirectoryBelieved => {
  if (typeof reader.at === 'function' && reader.at(0) !== null) return reader;
  const last = Math.max(reader.dir.version, digests.length);
  return { ...reader, at: (version) => (version < 0 || version > last ? null : { dir: reader.dir, digests: digests.slice(0, version) }) };
};

/**
 * **WHAT ONE READ HOLDS OF A TEST COMPANY'S RECORDS**, for what it `asked`
 * (`'every'`: every kind, for a test that hands a directory its records by
 * hand): produced by the device's own read (`recordsHeldHere`) over the test's
 * chain - every header of `founded`, each head the account's own functions
 * make, landed - and a service that keeps those headers, proves against them,
 * and lists every filing the test names, entered by its own filer, as waiting
 * for the next anchor. The read judges each filing by `reader`'s directory,
 * which seat may file it now, and stops where a device stops; it
 * keeps nothing but what `checked` is given to keep. For a company `founded` on
 * the test's chain, its first header with the seat it names, and who held the
 * account as each directory version it anchors was anchored: that seat alone.
 */
const heldAsAsked = async (
  company: string, filed: readonly FiledBy[], founded: FoundedWith | undefined, asked: RecordsAsked | 'every', reader?: DirectoryBelieved,
  checked?: CheckedHeadsStore,
  /** What a lying service lists as not yet anchored, given what an honest one would and every entry it holds: the read must still drop what is not waiting. */
  lists?: (honest: readonly ManifestEntry[], everyEntry: readonly ManifestEntry[]) => readonly ManifestEntry[],
): Promise<RecordsHeldHere> => {
  const built = foundedTree(company, founded);
  const kept = new TreeKept(built.headers);
  const entered = new Map<Hex, ManifestEntry>(built.entries.map((e) => [entryIdOf(e), e]));
  const waiting = filed.map((f) => signManifestEntry(company, f.entry, f.signingSecret));
  const tree: TreeService = {
    headersAfter: async (_, seq, limit) => headersPageOf(kept, (id) => entered.get(id), seq, limit),
    fileHeader: async () => { throw new Error('a read files no header'); },
    proofs: async (_, ask) => proofsOf(kept, ask),
    pending: async (_, root) => {
      const every = [...built.entries, ...waiting];
      const honest = pendingAt(kept, every, root);
      return honest === null || lists === undefined ? honest : [...lists(honest, every)];
    },
  };
  /* **A STAND-IN, NAMED**: who holds the account now is the founding seat alone at one approval, unless the test names others (`account`). */
  const now = holdersOf(founded?.account ?? { approvals: 1, seats: founded === undefined ? [] : [founded.seat] });
  const onChain = async (): Promise<AnchorsOnChain> => ({
    /* Each founding header landed while the founding seat alone held the account, with no policy bar stored. */
    landed: built.headers.map((h, i) => ({ head: built.heads[i]!, seatBar: seatBarOf(h.held.approvals, null), tag: h.tag, height: i + 1, at: Date.parse(h.at) })),
    now, seatsNow: [...now.signers], deployed: founded === undefined ? null : deployedAs(founded), vouching: [],
  });
  const directory = reader === undefined ? directoryOfNobody(company, founded, filed)
    : handMade(reader, (founded?.directory ?? []).map((d) => directoryEntry(d).digest as Hex));
  const read = await recordsHeldHere({
    accountId: company, tree, onChain, builder: anchorFunctions, directory: async () => directory, ...(checked === undefined ? {} : { checked }),
  }, asked === 'every' ? { kinds: EVERY_KIND, founding: true } : asked);
  return read.records;
};

/**
 * Every filing the test names entered by its own filer and waiting for the
 * next anchor, every kind proven; and, for a company `founded` on the test's
 * chain, its first header anchored before them (`heldAsAsked`).
 */
export const heldEntering = (
  company: string, filed: readonly FiledBy[] = [], founded?: FoundedWith, reader?: DirectoryBelieved, lists?: Parameters<typeof heldAsAsked>[6],
): Promise<RecordsHeldHere> => heldAsAsked(company, filed, founded, 'every', reader, undefined, lists);

/**
 * **AN ACCOUNT DEPLOYED ON ITS FOUNDING SIGNER'S DEVICE**, as its history's
 * first step shows it: their seat alone, held by their own committee key alone
 * at a threshold of one, no update made yet, and no second-step circuit.
 */
export const deployedOnTheDevice = (seat: string, committee: readonly CommitteeKey[]): AccountDeployed => ({
  seats: [seat.toLowerCase()], committee: committee.map((k) => ({ tag: k.tag, value: k.value.toLowerCase() })), threshold: 1, updates: 0, ranSecondStep: false,
});

/** How a test's `founded` company's account was deployed: on its founding signer's device, unless the test says otherwise. */
const deployedAs = (founded: FoundedWith): AccountDeployed | null =>
  (founded.deployed !== undefined ? founded.deployed : deployedOnTheDevice(founded.seat, founded.committee ?? []));

/** For a directory's reads: what each read holds of the records `heldEntering` builds, for what that read asked, worked out again at each read. */
export const anchoredEntering = (company: string, filed: () => readonly FiledBy[] = () => [], founded?: FoundedWith): DirectoryHereDeps['anchored'] =>
  async (directory, asked) => heldAsAsked(company, filed(), founded, asked ?? {}, directory);

/**
 * **ONE COMPANY'S RECORDS AS A TEST KEEPS THEM**: every filing entered by the
 * seat that filed it, through the one filing call each filer is handed
 * (`enteredBy`), and held for every read as nothing anchored yet (`anchored`)
 * but, for a company `founded` on the test's chain, its first header. A run's
 * version is its count of entries, as the company's records count it.
 */
export const aCompanysRecords = (company: string, founded?: FoundedWith) => {
  const filed: FiledBy[] = [];
  const enteredBy = (signingSecret: Hex): RecordsEntered & { readonly filed: Filed[][] } => {
    const mine: Filed[][] = [];
    return {
      filed: mine,
      enter: async (batch) => {
        mine.push([...batch]);
        for (const f of batch) {
          const entry = 'run' in f
            ? runEntry(company, f.run, filed.filter((x) => x.entry.store === 'run' && x.entry.id === f.run.id).length + 1)
            : f;
          filed.push({ entry, signingSecret });
        }
      },
    };
  };
  return { filed, enteredBy, anchored: anchoredEntering(company, () => filed, founded) };
};

/** The entries of every run and proposal served whose filer's secret is among `secrets`, each entered by that filer. */
const servedFiledBy = (
  company: string, served: { readonly runs?: readonly SealedRun[]; readonly proposals?: readonly SealedProposal[] }, secrets: readonly Hex[],
): FiledBy[] => {
  const secretOf = new Map(secrets.map((s) => [signingPublicKeyOf(s), s] as const));
  const filed: FiledBy[] = [];
  for (const run of served.runs ?? []) {
    const s = run.filedBy === undefined ? undefined : secretOf.get(run.filedBy.publicKey.toLowerCase() as Hex);
    if (s !== undefined) filed.push({ entry: runEntry(company, run, 1), signingSecret: s });
  }
  for (const p of served.proposals ?? []) {
    const s = p.filedBy === undefined ? undefined : secretOf.get(p.filedBy.publicKey.toLowerCase() as Hex);
    if (s !== undefined) filed.push({ entry: proposalEntry(company, p), signingSecret: s });
  }
  return filed;
};

/**
 * **EVERY RUN AND PROPOSAL A TEST SERVES, ENTERED BY ITS OWN FILER**, and
 * nothing anchored, every kind proven: for a test whose directory is written
 * out by hand and whose runs and proposals are served as they are filed.
 * `secrets` are the signing secrets of the seats that filed them; one filed
 * under any other key is left out, and no device believes it.
 */
export const heldServing = (
  company: string, served: { readonly runs?: readonly SealedRun[]; readonly proposals?: readonly SealedProposal[] }, secrets: readonly Hex[],
  founded?: FoundedWith, reader?: DirectoryBelieved,
): Promise<RecordsHeldHere> => heldEntering(company, servedFiledBy(company, served, secrets), founded, reader);

/**
 * A company's records as a device reads a run from them, with every run and
 * proposal they serve entered by the seat that filed it (`heldServing`),
 * worked out again from what they serve at each read of the directory, for
 * what that read asked.
 */
export const everyRunAndProposalEntered = (
  records: CompanyRecordsHere, company: string, secrets: readonly Hex[], founded?: FoundedWith,
): CompanyRecordsHere => ({
  ...records,
  directory: async (asked) => {
    const read = await records.directory(asked);
    return {
      ...read,
      records: await heldAsAsked(company, servedFiledBy(company, { runs: await records.runs(), proposals: await records.proposals?.() ?? [] }, secrets),
        founded, asked ?? {}, read),
    };
  },
});

/**
 * **ONE ACCOUNT'S ANCHOR ON A TEST'S CHAIN**: moved on only by a call naming
 * the head it holds and who holds the account (`held()`, the test's own
 * wallet's account) as the account's circuit refuses otherwise, with the
 * account's own `anchorHeadOf` over `anchorHeldOf`; each call that lands is
 * kept with its block, at the time `clock()`
 * says. What the account's history holds at the indexer a wallet names
 * (`onChain`).
 */
export const aChainAnchor = (
  held: () => HeldOnATestChain, clock: () => number = () => Date.now(),
  /** How the account was deployed; absent, on the device of the seat that holds it when the test's chain is first read. */
  deployed?: () => AccountDeployed | null,
) => {
  const landed: AnchorLanded[] = [];
  let first: AccountDeployed | null | undefined;
  const deployedNow = (): AccountDeployed | null => {
    if (deployed !== undefined) return deployed();
    if (first === undefined) {
      const h = held();
      first = h.seats.length === 1 ? deployedOnTheDevice(h.seats[0]!, h.committee) : null;
    }
    return first;
  };
  const head = (): Hex => (landed.length === 0 ? EMPTY_HEAD : landed[landed.length - 1]!.head as Hex);
  /** The runs the account's history shows vouching for a head, as a case sets them. */
  const vouching: VouchingRun[] = [];
  return {
    landed,
    vouching,
    head,
    /**
     * One anchor call sent, by the seat whose tag is `tag`: refused unless it names the head and the holders the
     * account holds, as the account's circuit refuses it; the head binds the tag, and the account keeps it beside the head.
     */
    move: (previous: string, batch: string, named: Pick<BatchHolders, 'approvals' | 'signerRoot'>, tag: string): void => {
      if (previous !== head()) throw new Error('the transaction was refused: a read did not match');
      const h = held();
      const now = holdersOf(h);
      if (named.approvals !== now.approvals) throw new Error('the approvals the account requires changed after this device judged the batch');
      if (named.signerRoot !== now.signerRoot) throw new Error('the account\'s signers changed after this device judged the batch');
      landed.push({ head: headAfter(previous, batch, now, tag), seatBar: barOnATestChain(h), tag: tag.toLowerCase(), height: landed.length + 1, at: clock() });
    },
    /**
     * One approved recovery carried out by the seat whose tag is `tag`: refused as `move` refuses, its head folded as a
     * recovery's - resuming from `resumesFrom` - and kept beside its tag.
     */
    recover: (previous: string, batch: string, named: Pick<BatchHolders, 'approvals' | 'signerRoot'>, tag: string, resumesFrom: string): void => {
      if (previous !== head()) throw new Error('the transaction was refused: a read did not match');
      const h = held();
      const now = holdersOf(h);
      if (named.approvals !== now.approvals || named.signerRoot !== now.signerRoot) throw new Error('the account\'s signers changed after this device judged the batch');
      landed.push({ head: headAfterStep({ previous, batch, held: now, tag, resumesFrom }), seatBar: barOnATestChain(h), tag: tag.toLowerCase(), height: landed.length + 1, at: clock() });
    },
    /** A call that lands at `next` whatever head it names: what a test's signer outside the device's rules does. */
    landAt: (next: string): void => {
      landed.push({ head: next, seatBar: barOnATestChain(held()), height: landed.length + 1, at: clock() });
    },
    /** The account's history now, as a wallet's indexer shows it. */
    read: (): AnchorsOnChain => onChainOf([...landed], held(), deployedNow(), [...vouching]),
    onChain: async (): Promise<AnchorsOnChain> => onChainOf([...landed], held(), deployedNow(), [...vouching]),
  };
};

/** The account's history as a wallet's indexer shows it: the heads that landed, and who holds the account now. */
export const onChainOf = (
  landed: readonly AnchorLanded[], held: Pick<AccountHeld, 'approvals' | 'seats'>, deployed: AccountDeployed | null = null,
  vouching: readonly VouchingRun[] = [],
): AnchorsOnChain => {
  const now = holdersOf(held);
  return { landed, now, seatsNow: [...now.signers], deployed, vouching };
};

/**
 * Who held a test company's account, as its wallet's read of the chain holds it:
 * the approvals and seats the signers' rules count, and the committee keys a
 * test's chain deploys the account held by (`aChainAnchor`).
 */
export type HeldOnATestChain = AccountHeld & { readonly committee: readonly CommitteeKey[] };

/** Who held a test company's account, as its wallet's read of the chain holds it. */
export const heldBy = (chain: {
  readonly seats: { readonly seats: readonly string[]; readonly committee: readonly CommitteeKey[] }; readonly approvals: number; readonly seatBar: number;
}): HeldOnATestChain =>
  ({ approvals: chain.approvals, seats: [...chain.seats.seats], committee: [...chain.seats.committee], seatBar: barOnATestChain(chain) });

/**
 * **THE COMPANY'S RECORDS AS A DEVICE READS THEM OVER A SERVICE'S OWN TREE
 * ROUTES**, the test's chain holding the anchors `onChain()` shows - none,
 * unless the test anchors - with the account's own `anchorHeadOf` for every
 * header. For a company `founded` on the test's chain whose founding header the
 * service does not keep, that header is the test's own, served with every
 * header filed after it and proven from them, and the test's chain holds its
 * head first; the entries are the service's, beside the founding ones.
 * `besides` are filings a test keeps outside the service's stores, given as
 * not yet anchored beside what the service gives. `checked` is where the
 * device keeps the heads its reads checked (`checkedHeadsInMemory`); absent, it
 * keeps none and every read checks from the company's first header.
 */
export const anchoredOver = (
  api: (path: string, init?: RequestInit) => Promise<any>, company: string, onChain: () => AnchorsOnChain = () => onChainOf([], { approvals: 1, seats: [] }),
  besides: () => readonly FiledBy[] = () => [],
  founded?: FoundedWith & { readonly committee: readonly CommitteeKey[] },
  checked?: CheckedHeadsStore,
): DirectoryHereDeps['anchored'] => {
  const service = treeServiceFor(api);
  const first = founded === undefined ? null : firstBatchOf(company, founded);
  const besideOf = (c: string) => besides().map((f) => signManifestEntry(c, f.entry, f.signingSecret));
  const tree: TreeService = first === null
    ? { ...service, pending: async (c, root) => { const p = await service.pending(c, root); return p === null ? null : [...p, ...besideOf(c)]; } }
    : (() => {
      /* The test's own tree: the founding header, and every header a device files after it. */
      const kept = new TreeKept([first.header]);
      const entered = async (c: string): Promise<ManifestEntry[]> => [
        ...first.entries, ...((await service.pending(c, GENESIS.root)) ?? []) as ManifestEntry[], ...besideOf(c),
      ];
      const byId = async (c: string) => new Map((await entered(c)).map((e) => [entryIdOf(e), e] as const));
      return {
        headersAfter: async (c, seq, limit) => { const ids = await byId(c); return headersPageOf(kept, (id) => ids.get(id), seq, limit); },
        fileHeader: async (c, h) => {
          const ids = await byId(c);
          const why = treeHeaderFilingRefusal(kept, (id) => ids.get(id), h);
          if (why !== null) throw new Error(why);
          kept.keep(h);
        },
        proofs: async (_, ask) => proofsOf(kept, ask),
        pending: async (c, root) => pendingAt(kept, await entered(c), root),
      };
    })();
  return heldFor({
    accountId: company, tree,
    onChain: async () => {
      const read = onChain();
      return first === null ? read
        : {
          ...read, landed: [{ head: first.head, seatBar: seatBarOf(first.header.held.approvals, null), height: 0, at: 0 }, ...read.landed],
          deployed: deployedAs(founded!),
        };
    },
    builder: anchorFunctions,
    ...(checked === undefined ? {} : { checked }),
  });
};

/**
 * The account's own functions for its anchor, as a test's worker answers them (`anchorHeadsAfter`, the worker's own):
 * the head after each batch and the seats its holders name, and no call built.
 */
export const anchorFunctions = {
  anchorHeads: async ({ after, holders }: { after: readonly HeadStepAsked[]; holders?: readonly BatchHolders[] }) =>
    anchorHeadsAfter(accountHere, { after, holders: holders ?? [] }),
  anchorTag: async ({ account, material }: { account: string; material: Pick<SignerMaterial, 'signingSecret' | 'blinding'> }) =>
    anchorTagIn(accountHere, account, material),
  seatOpenings: async (input: Parameters<typeof seatOpeningsIn>[1]) => seatOpeningsIn(accountHere, input),
  anchor: async (): Promise<{ tx: string }> => { throw new Error('a read anchors nothing'); },
};

/**
 * **AN ANCHOR CALL AS A TEST'S WORKER BUILDS IT**: no proof, the call's own fields and the tag the account's circuit
 * would work out from the seat it proves (`anchorTagIn`), which a test's chain moves on with (`aChainAnchor.move`).
 */
export const anchorSentInATest = async (
  { account, material, previous, batch, held }: { account: string; material: Pick<SignerMaterial, 'signingSecret' | 'blinding'>; previous: string; batch: string; held: Pick<BatchHolders, 'approvals' | 'signerRoot'> },
): Promise<{ tx: string }> => ({ tx: JSON.stringify({ previous, batch, held, tag: anchorTagIn(accountHere, account, material) }) });

/** The head the account moves to from `previous` with `batch` judged against `held` by the seat whose tag is `tag`, by the worker's own `anchorHeadsAfter`. */
export const headAfter = (previous: string, batch: string, held: BatchHolders, tag: string): Hex =>
  headAfterStep({ previous, batch, held, tag });

/** The head one step makes, by the worker's own `anchorHeadsAfter`. */
export const headAfterStep = (step: HeadStepAsked): Hex => anchorHeadsAfter(accountHere, { after: [step] }).after[0]! as Hex;

/** Company records filed by the seats whose signing secrets are `secrets`, each entered by its own filer; nothing anchored but what `founded` founded the company with. */
export const heldFiledBy = (
  company: string, recs: readonly SealedCompanyRecord[], secrets: readonly Hex[], founded?: FoundedWith, reader?: DirectoryBelieved,
): Promise<RecordsHeldHere> => {
  const secretOf = new Map(secrets.map((s) => [signingPublicKeyOf(s), s] as const));
  return heldEntering(company, recs.flatMap((r) => {
    const s = r.filedBy === undefined ? undefined : secretOf.get(r.filedBy.publicKey.toLowerCase() as Hex);
    return s === undefined ? [] : [{ entry: companyRecordEntry(r), signingSecret: s }];
  }), founded, reader);
};

/**
 * **WHERE EACH PROPOSAL STANDS ON A TEST'S CHAIN**, as a wallet's indexer
 * would show it to a device that has watched the chain since this was made:
 * `openNow` is every proposal the test's chain holds open now, by its identity
 * on chain, with its approvals. A proposal is raised at the first read that
 * finds it held, its call to `propose` named by its identity; one held before
 * and gone now is closed by the calls `closedBy` names for it - by default one
 * this test does not name, which reads as carried out; one never found held
 * was never held. **A STAND-IN, NAMED**: the test's chain keeps no history, so
 * a proposal raised and closed between two reads reads as never held.
 */
export const roundsOnATestChain = (
  openNow: () => Promise<ReadonlyArray<{ readonly id: string; readonly approvals: number }>>,
  closedBy: (chainId: string) => readonly string[] = () => ['a call this test does not name'],
): ((chainIds: readonly string[]) => Promise<Record<string, RoundOnChain>>) => {
  const raised = new Map<string, number>();
  return async (chainIds) => {
    const open = new Map((await openNow()).map((p) => [p.id.toLowerCase(), p.approvals] as const));
    const at = Date.now();
    for (const id of open.keys()) if (!raised.has(id)) raised.set(id, at);
    return Object.fromEntries(chainIds.map((asked) => {
      const id = asked.toLowerCase();
      const first = raised.get(id);
      const approvals = open.get(id);
      const round: RoundOnChain = first === undefined ? { held: 'never', approvals: 0 }
        : approvals !== undefined ? { held: 'open', approvals, raisedAt: first, txRef: id }
          : { held: 'closed', approvals: 0, raisedAt: first, txRef: id, closedBy: closedBy(id) };
      return [id, round];
    }));
  };
};

/** A test's chain holding open, unapproved, every proposal asked about, each raised in the block it was first asked about. */
export const everyRoundHeldOpen = async (chainIds: readonly string[]): Promise<Record<string, RoundOnChain>> =>
  Object.fromEntries(chainIds.map((id) => [id.toLowerCase(), { held: 'open', approvals: 0, raisedAt: 1_800_000_000_000, txRef: id.toLowerCase() }]));

/** A test's chain that has never held any proposal asked about. */
export const noRoundHeld = async (chainIds: readonly string[]): Promise<Record<string, RoundOnChain>> =>
  Object.fromEntries(chainIds.map((id) => [id.toLowerCase(), { held: 'never', approvals: 0 }]));

/* ------------------------------------------------------------------ the service and the chain, header by header */


/** Who held a test company's account as each batch was judged, unless a test names others. */
export const HELD_IN_A_TEST: BatchHolders = { approvals: 1, signerRoot: '0a'.repeat(32), signers: ['cd'.repeat(32)] };

/** The head after each step, by the account's own functions, as a test's worker answers them. */
export const headsByTheAccount = async (steps: readonly HeadStep[]): Promise<readonly Hex[]> =>
  (await anchorFunctions.anchorHeads({ after: steps })).after as Hex[];

export const aTreeCompany = (
  company: string, held: BatchHolders = HELD_IN_A_TEST,
  /** The approvals a policy change needs as the test's chain stores them; none stored, the threshold stands in. */
  policyBar: number | null = null,
) => {
  const headers: TreeHeader[] = [];
  const entries = new Map<Hex, ManifestEntry>();
  const landed: AnchorLanded[] = [];
  const checked: CheckedHead[] = [];
  /* What the service keeps: every header kept, with the tree's nodes as each was kept. */
  const tree = new TreeKept();
  const kept = (): TreeKept => tree;
  let head: CheckedHead = GENESIS;

  /** Anchors `es` from the device holding `secret`, as an honest anchoring device does, and lands it on the chain. */
  const anchor = async (es: readonly ManifestEntry[], secret: Hex, at = new Date('2026-10-10T00:00:00Z')): Promise<TreeHeader> => {
    for (const e of es) entries.set(entryIdOf(e), e);
    const records = [...new Map(es.map((e) => [treeKeyOf(e), { store: e.store, kind: e.kind, id: e.id }])).values()];
    const given = proofsOf(kept(), { root: head.root, records, kinds: [] })!;
    const made = nextTreeHeader({
      company, before: head, entries: es,
      current: new Map(records.map((r, i) => [treeKeyOf(r), given.records[i]!])), proof: given.proof,
      priorChain: (h) => kept().leaf(h), held, at: at.toISOString(), tag: tagInATest(secret),
    }, secret);
    if (made === null) throw new Error('nothing to anchor');
    return land(made.header, at);
  };
  /** Keeps a header and lands it: the head the account moves to from the head before. */
  const land = async (h: TreeHeader, at = new Date('2026-10-10T00:00:00Z')): Promise<TreeHeader> => {
    const [next] = await headsByTheAccount([{ ...headStepOf(h), previous: head.head }]);
    headers.push(h);
    tree.keep(h);
    head = checkedAfter(h, next!);
    checked.push(head);
    landed.push({ head: next!, seatBar: seatBarOf(held.approvals, policyBar), tag: h.tag, height: landed.length + 1, at: at.getTime() });
    return h;
  };

  const service: TreeService = {
    headersAfter: async (_, seq, limit) => headersPageOf(kept(), (id) => entries.get(id), seq, limit),
    fileHeader: async (_, h) => {
      const why = treeHeaderFilingRefusal(kept(), (id) => entries.get(id), h);
      if (why !== null) throw new Error(why);
    },
    proofs: async (_, ask) => proofsOf(kept(), ask),
    pending: async (_, root) => pendingAt(kept(), [...entries.values()], root),
  };
  /** The runs the account's history shows vouching for a head, as a case sets them. */
  const vouching: VouchingRun[] = [];
  const onChain = async (): Promise<AnchorsOnChain> => ({ landed: [...landed], now: held, seatsNow: [], deployed: null, vouching: [...vouching] });
  /** Keeps a header filed, as the service keeps one that follows a header it keeps; refused as the service refuses. */
  const keep = async (h: TreeHeader): Promise<void> => {
    const why = treeHeaderFilingRefusal(kept(), (id) => entries.get(id), h);
    if (why !== null) throw new Error(why);
    headers.push(h);
    tree.keep(h);
  };
  return {
    headers, entries, landed, service, onChain, anchor, land, keep, vouching,
    /** The head after the header at `seq`, as the chain moved to it. */
    checkedAt: (seq: number): CheckedHead => checked[seq]!,
    get head(): CheckedHead { return head; },
  };
};

/**
 * **WHAT A DEVICE THAT CHECKED THESE HEADS KEEPS OF THEM**, as its own database
 * would (`treeKeptHere`), checked from the company's first header: the last is
 * the latest. **A STAND-IN, NAMED: heads a test names by hand**, for a case that needs a record of heads no read
 * reached; a raise or an approval that is not about such a record reads what its own read kept (`anchoredOver`'s `checked`).
 */
export const headsCheckedHere = (...heads: readonly Hex[]): CheckedHeads => {
  const seq = heads.length - 1;
  const latest = { seq, head: heads[seq]!.toLowerCase() as Hex, root: '00'.repeat(32), dirVersion: 0 };
  return { latest, fromZero: latest, heads: heads.map((h) => h.toLowerCase() as Hex) };
};

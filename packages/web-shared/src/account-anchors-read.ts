/**
 * **THE COMPANY'S RECORD ANCHOR, READ OFF THE ACCOUNT'S OWN STATE AND HISTORY**: the signers' root, who holds
 * a batch, the heads after a batch, the last recovery, each anchor that landed and how the account was deployed.
 */
import { HEX64 } from '../../../src/midnight/directory-change-shape.js';
import { CREATION_STEPS } from '../../../src/midnight/deferral.js';
import type { BatchHolders } from '../../../src/midnight/record-manifest.js';
import type { CommitteeKey } from '../../../src/midnight/seat-directory.js';
import { authorityIn } from 'midnight-identity/profile/contract-authority';
import { bytesOf, hexOf } from './governance-payload.js';
import { type GovernedCallDeps, ZERO_32 } from './governed-call-builder.js';
import type { VouchingRun } from './account-calls-read.js';

/* ── THE COMPANY'S RECORD ANCHOR, MOVED ON FROM THIS DEVICE ──────────────────── */

/** Thrown, with nothing built or sent, when an anchor call - or a recovery, `recovery` - cannot be made as this device would send it. */
export class AnchorNotBuilt extends Error {
  constructor(why: string, options?: { cause?: unknown; recovery?: boolean }) {
    super(
      `${options?.recovery === true ? "the recovery of the company's records was not carried out" : "the company's records were not anchored"}: ${why}. ` +
        'Nothing was built or sent.',
      options
    );
    this.name = 'AnchorNotBuilt';
  }
}

export const anchorPure = (deps: Pick<GovernedCallDeps, 'accountPure'>) => {
  const {
    anchorKey,
    anchorHeadOf,
    anchorHeldOf,
    anchorRecoveredOf,
    anchorTagOf,
    anchorSeatKey,
    signerPublicKey,
    vacantSlot,
    slotOf
  } = deps.accountPure;
  if (
    typeof anchorKey !== 'function' ||
    typeof anchorHeadOf !== 'function' ||
    typeof anchorHeldOf !== 'function' ||
    typeof anchorRecoveredOf !== 'function' ||
    typeof anchorTagOf !== 'function' ||
    typeof anchorSeatKey !== 'function' ||
    typeof signerPublicKey !== 'function' ||
    typeof vacantSlot !== 'function' ||
    typeof slotOf !== 'function'
  ) {
    throw new AnchorNotBuilt(
      "this device was not given the account's functions for its record anchor. Reload the page to use the " +
        'current build'
    );
  }
  return {
    anchorKey,
    anchorHeadOf,
    anchorHeldOf,
    anchorRecoveredOf,
    anchorTagOf,
    anchorSeatKey,
    signerPublicKey,
    vacantSlot,
    slotOf
  };
};

/** A signer tree's root as a header names it: the field, as 64 hex digits, big-endian. */
const rootHexOf = (field: bigint): string => field.toString(16).padStart(64, '0');
export const rootOfHex = (hex: string): { field: bigint } => {
  const h = String(hex).toLowerCase();
  if (!HEX64.test(h))
    throw new AnchorNotBuilt("the batch does not name the root of the account's signers as it was judged");
  return { field: BigInt(`0x${h}`) };
};

/**
 * The root of a signer tree holding `signers`, slot by slot from slot 0, as a
 * header names a root; the tree the account's own signer tree is, a tree of
 * height ten with each leaf hashed as the chain hashes it.
 */
export function signerRootOf(deps: Pick<GovernedCallDeps, 'accountTree'>, signers: readonly string[]): string {
  const T = deps.accountTree;
  if (T === undefined)
    throw new AnchorNotBuilt(
      "this device was not given the account's signer tree. Reload the page to use the current build"
    );
  const bytes = new T.CompactTypeBytes(32);
  let tree = new T.StateBoundedMerkleTree(10) as { update(index: bigint, leaf: unknown): unknown };
  signers.forEach((leaf, slot) => {
    const b = bytesOf('leaf', String(leaf).toLowerCase());
    tree = tree.update(BigInt(slot), { value: bytes.toValue(b), alignment: bytes.alignment() }) as typeof tree;
  });
  const root = (tree as unknown as { rehash(): { root(): { value: unknown } | undefined } }).rehash().root();
  if (root === undefined) throw new AnchorNotBuilt("the root of the account's signers could not be worked out");
  return rootHexOf(T.CompactTypeMerkleTreeDigest.fromValue(root.value).field);
}

/** Whether a header's leaves, slot by slot, make the signer-tree root it names: only then are they the account's. */
export function signersMakeTheirRoot(deps: Pick<GovernedCallDeps, 'accountTree'>, held: BatchHolders): boolean {
  if (deps.accountTree === undefined) signerRootOf(deps, []);
  try {
    return signerRootOf(deps, held.signers) === String(held.signerRoot).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * **WHO HOLDS THE ACCOUNT IN ONE OF ITS STATES, AS A BATCH'S HEADER NAMES
 * THEM**: the approvals it requires, its signer tree's root, and the leaf in
 * each slot up to the tree's first free one - a seated signer's leaf where its
 * path leads, the account's vacant-slot leaf in every other.
 */
export function batchHoldersIn(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'>,
  accountState: Uint8Array
): BatchHolders {
  const P = anchorPure(deps);
  if (deps.accountLedger === undefined) throw new AnchorNotBuilt("this device was not given the account's reader");
  const view = deps.accountLedger((deps.runtimeState.deserialize(accountState) as { data: unknown }).data) as {
    threshold: bigint;
    signers: { root(): { field: bigint } | undefined; firstFree(): bigint; findPathForLeaf(leaf: Uint8Array): unknown };
    signerLeaves: Iterable<Uint8Array>;
  };
  const root = view.signers.root();
  if (root === undefined) throw new AnchorNotBuilt("the account's signers could not be read from its state");
  const free = Number(view.signers.firstFree());
  const vacant = hexOf(P.vacantSlot());
  const signers: string[] = Array.from({ length: free }, () => vacant);
  for (const leaf of view.signerLeaves) {
    const path = view.signers.findPathForLeaf(leaf);
    const slot = path === undefined ? -1 : Number(P.slotOf(path));
    if (!(slot >= 0 && slot < free))
      throw new AnchorNotBuilt("a seated signer's slot could not be read from the account's state");
    signers[slot] = hexOf(leaf);
  }
  return { approvals: Number(view.threshold), signerRoot: rootHexOf(root.field), signers };
}

/**
 * The head an account's state holds under the anchor's own key - the empty
 * head, thirty-two zero bytes, before its first anchor - and the tag of the
 * seat that moved it there, null before the first.
 */
const headInState = (
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'>,
  accountState: Uint8Array
): { readonly head: string; readonly tag: string | null } => {
  const P = anchorPure(deps);
  if (deps.accountLedger === undefined) throw new AnchorNotBuilt("this device was not given the account's reader");
  const view = deps.accountLedger((deps.runtimeState.deserialize(accountState) as { data: unknown }).data) as {
    signerRoles: { member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array };
  };
  const key = P.anchorKey();
  const seat = P.anchorSeatKey();
  return {
    head: view.signerRoles.member(key) ? hexOf(view.signerRoles.lookup(key)) : hexOf(ZERO_32),
    tag: view.signerRoles.member(seat) ? hexOf(view.signerRoles.lookup(seat)) : null
  };
};

/**
 * **THE HEAD THE LATEST RECOVERY CARRIED OUT WROTE, AS ONE STATE OF THE ACCOUNT
 * HOLDS IT** (hex): thirty-two zero bytes before any recovery is carried out.
 * Read with the account's own reader and key, from a state the caller read at
 * the indexer the person's own wallet names. A recovery is raised naming it and
 * carried out only while the account still holds the head it names, since the
 * account refuses any other - and that refusal lands after the fee is paid.
 */
export function lastRecoveryIn(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'>,
  accountState: Uint8Array
): string {
  const key = deps.accountPure.lastRecoveryKey;
  if (deps.accountLedger === undefined || typeof key !== 'function') {
    throw new Error(
      "this device was not given the account's reader for its latest recovery, so no recovery was raised or carried out. " +
        'Reload the page to use the current build'
    );
  }
  const view = deps.accountLedger((deps.runtimeState.deserialize(accountState) as { data: unknown }).data) as {
    signerRoles: { member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array };
  };
  const at = key.call(deps.accountPure);
  return view.signerRoles.member(at) ? hexOf(view.signerRoles.lookup(at)) : hexOf(ZERO_32);
}

/** The seats a header's leaves name: every leaf but the account's vacant-slot one. */
export function seatsNamedBy(deps: Pick<GovernedCallDeps, 'accountPure'>, signers: readonly string[]): string[] {
  const vacant = hexOf(anchorPure(deps).vacantSlot());
  return signers.map((l) => String(l).toLowerCase()).filter((l) => l !== vacant);
}

/**
 * One step of the account's head as asked: the head before, a header's digest,
 * who held the account as it was judged, the anchoring seat's tag, and - for a
 * recovery - the head it resumes from.
 */
export interface HeadStepAsked {
  readonly previous: string;
  readonly batch: string;
  readonly held: BatchHolders;
  readonly tag: string;
  readonly resumesFrom?: string;
}

/**
 * **THE HEAD AFTER EACH BATCH ASKED ABOUT**, each made with the account's own
 * `anchorHeadOf` over `anchorHeldOf` (a recovery's, `anchorRecoveredOf`) of the batch, the tag and the holders its header
 * names; and the seats those holders' leaves name - every leaf but the
 * vacant-slot one - when they make the root the header names, null when they
 * do not; and the same seats for each of `holders`, as a directory version's
 * leaf names who held the account. Reads no chain.
 */
export function anchorHeadsAfter(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountTree'>,
  input: {
    readonly after: readonly HeadStepAsked[];
    readonly holders?: readonly BatchHolders[];
  }
): { after: string[]; seats: (string[] | null)[]; holderSeats: (string[] | null)[] } {
  const P = anchorPure(deps);
  /* A batch whose holders the account's own functions refuse - a root that is no field element - folds to the empty head, which no batch on the chain's path ever leaves, so it is passed over and never believed. */
  const seatsOf = (held: BatchHolders): string[] | null =>
    signersMakeTheirRoot(deps, held) ? seatsNamedBy(deps, held.signers) : null;
  const headAfter = (x: HeadStepAsked): string => {
    try {
      const previous = bytesOf('head', String(x.previous).toLowerCase());
      const batch = bytesOf('batch', String(x.batch).toLowerCase());
      const tag = bytesOf('tag', String(x.tag).toLowerCase());
      const approvals = BigInt(x.held.approvals);
      const root = rootOfHex(x.held.signerRoot);
      return hexOf(
        P.anchorHeadOf(
          previous,
          x.resumesFrom === undefined
            ? P.anchorHeldOf(batch, approvals, root, tag)
            : P.anchorRecoveredOf(batch, approvals, root, tag, bytesOf('head', String(x.resumesFrom).toLowerCase()))
        )
      );
    } catch {
      return hexOf(ZERO_32);
    }
  };
  return {
    after: input.after.map(headAfter),
    seats: input.after.map((x) => seatsOf(x.held)),
    holderSeats: (input.holders ?? []).map(seatsOf)
  };
}

/**
 * **ONE HEAD THE ACCOUNT'S HISTORY SHOWS**: the head the last anchor call of a
 * block left, and the block - its height and the time its author set, in
 * milliseconds. A head another anchor of the same block moved on from is never
 * shown, and the next head shown is that block's. The approvals and seats a
 * batch was judged against are never read off these states: they are what the
 * batch's header names, which the call checked.
 */
export interface AnchorLanded {
  readonly head: string;
  /**
   * The approvals a change of who is seated needed in the state this head's
   * block left (`seatBarOf`): what a demotion or retirement the batch anchored
   * is held to. A bar changed in the same block shows here as changed.
   */
  readonly seatBar: number;
  /** The tag of the seat that moved the head there, as the account wrote it beside the head; absent where a test's chain names none. */
  readonly tag?: string;
  readonly height: number;
  readonly at: number;
  /**
   * How many calls to move the anchor - `anchor` or `recoverAnchor` - this
   * head's block held, whatever their transactions' results, where the history
   * names its calls. The indexer keeps one state a block, so with more
   * than one the tag is the block's last anchoring seat's, not surely the one
   * that moved the head past any one head of that block.
   */
  readonly anchorsInBlock?: number;
  /** A recovery the quorum approved moved the anchor in this head's block, where the history names its calls. */
  readonly recovered?: boolean;
}

/**
 * **WHAT A DEVICE READS OF THE ACCOUNT'S HISTORY**: every head it shows,
 * oldest first, and who holds the account in its latest state as a batch's
 * header names them - what an anchoring device judges its batch against.
 */
export interface AnchorsOnChain {
  readonly landed: readonly AnchorLanded[];
  readonly now: BatchHolders;
  /** The seats `now` names: every leaf but the vacant-slot one. */
  readonly seatsNow: readonly string[];
  /** How the account was deployed (`accountDeployedIn`); null when its history does not open with its deploy. */
  readonly deployed: AccountDeployed | null;
  /** Every payroll run whose approvals vouch for the head its raiser sealed (`vouchingRunsIn`), oldest first. */
  readonly vouching: readonly VouchingRun[];
}

/**
 * **HOW THE ACCOUNT WAS DEPLOYED, AS THE FIRST STEP OF ITS HISTORY SHOWS IT**:
 * the seats, the maintenance committee, its threshold and its update counter
 * that step's state lists, and whether the account already ran a circuit the
 * second creation step inserts - the record anchor among them. An account
 * deployed held by one key alone at a threshold of one, with no second-step
 * circuit, gains `anchor` only through an update that key signs. The state is
 * the one after the whole block the deploy is in: an update in that block
 * shows here as a counter above zero, read as not deployed so.
 */
export interface AccountDeployed {
  readonly seats: readonly string[];
  readonly committee: readonly CommitteeKey[];
  readonly threshold: number;
  /** How many updates the maintenance committee had made by then: zero for the deploy's own state. */
  readonly updates: number;
  readonly ranSecondStep: boolean;
}

/**
 * **HOW THE ACCOUNT WAS DEPLOYED**, from the first step of its history (oldest
 * first): null unless that step is the deploy. Who held it is read with the
 * account's seats reader the caller hands in (`seatsIn`, the one way a wallet
 * reads them); its operations with the contract runtime's own reader; its
 * update counter through the one reader of a contract's authority
 * (`authorityIn`); the second step's circuits from the one list of them
 * (`CREATION_STEPS`). Throws when that reader refuses the deploy's authority:
 * a counter that cannot be read is not one no update touched, and a null here
 * would say the history does not open with a deploy, which is not what was
 * found, so the device refuses the whole reading rather than believe either.
 */
export function accountDeployedIn(
  deps: Pick<GovernedCallDeps, 'runtimeState'>,
  steps: ReadonlyArray<{ readonly kind: string; readonly state: Uint8Array }>,
  seatsIn: (state: Uint8Array) => {
    readonly seats: readonly string[];
    readonly committee: readonly CommitteeKey[];
    readonly threshold: number;
  }
): AccountDeployed | null {
  const first = steps[0];
  if (first === undefined || first.kind !== 'deploy') return null;
  const held = seatsIn(first.state);
  const state = deps.runtimeState.deserialize(first.state) as { operations(): Array<string | Uint8Array> };
  const authority = authorityIn(state);
  if ('why' in authority) throw new Error(`how the company's account was deployed cannot be read: ${authority.why}`);
  const second = new Set<string>(CREATION_STEPS.second);
  const ranSecondStep = state
    .operations()
    .some((op) => second.has(typeof op === 'string' ? op : new TextDecoder().decode(op)));
  return {
    seats: held.seats.map((s) => String(s).toLowerCase()),
    committee: held.committee.map((k) => ({ tag: String(k.tag), value: String(k.value).toLowerCase() })),
    threshold: Number(held.threshold),
    updates: Number(authority.counter),
    ranSecondStep
  };
}

/**
 * **EVERY HEAD THE ACCOUNT'S HISTORY SHOWS, OLDEST FIRST**: each step of the
 * history whose state holds a head other than the step before it, with the
 * head and its block; where the history names each step's call, how many
 * calls moved the anchor in that block and whether a recovery was one of them.
 * The head before the first step is the empty head. Each head's seat bar is
 * read from that step's state with `seatBarIn`, the one reader of the
 * account's approvals a wallet reads them with.
 */
export function anchorsLandedIn(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'>,
  steps: ReadonlyArray<{
    readonly state: Uint8Array;
    readonly block: { readonly height: number; readonly at: number };
    readonly entryPoint?: string;
    readonly succeeded?: boolean;
  }>,
  seatBarIn: (state: Uint8Array) => number
): AnchorLanded[] {
  const landed: AnchorLanded[] = [];
  const blocks = new Map<number, (typeof steps)[number][]>();
  for (const x of steps) blocks.set(x.block.height, [...(blocks.get(x.block.height) ?? []), x]);
  let before = hexOf(ZERO_32);
  for (const step of steps) {
    const { head, tag } = headInState(deps, step.state);
    if (head === before) continue;
    /*
     * One state a block. Every call to move the anchor in it is counted, whatever its transaction's result - one in a
     * guaranteed section moves the head even where the transaction succeeded only in part - so the count errs only on
     * the side of naming no seat; a recovery is read only from a call whose transaction succeeded in full.
     */
    const block = blocks.get(step.block.height)!;
    const named = block.some((x) => x.entryPoint !== undefined);
    const calls = block.filter((x) => x.entryPoint === 'anchor' || x.entryPoint === 'recoverAnchor');
    const seatBar = seatBarIn(step.state);
    if (!Number.isSafeInteger(seatBar) || seatBar < 1)
      throw new AnchorNotBuilt(
        "the approvals a change of who is seated needs could not be read from the account's state"
      );
    landed.push({
      head,
      seatBar,
      ...(tag === null ? {} : { tag }),
      height: step.block.height,
      at: step.block.at,
      ...(named
        ? {
            anchorsInBlock: calls.length,
            recovered: calls.some((x) => x.entryPoint === 'recoverAnchor' && x.succeeded === true)
          }
        : {})
    });
    before = head;
  }
  return landed;
}

/**
 * Where the account's map of open proposals sits among the fields of its public state: the slot the compiled account's
 * own reader of `openProposals` reads, which a test asks of that reader for every slot.
 */
export const OPEN_PROPOSALS_FIELD = 2;

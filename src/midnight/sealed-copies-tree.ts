/**
 * **THE TREE OF A SECRET'S SEALED COPIES, AS SIGNERS APPROVE IT AND AS EACH
 * COPY IS WRITTEN AGAINST IT.**
 *
 * When a vault's nonce secret is set, every signer is given a copy of it sealed
 * to a key their own recovery words derive, and each copy is kept on the
 * chain, so a signer with nothing but their words can open the secret again.
 * The signers approve one root over all of the copies and how many there are;
 * then each copy is written on its own, by anyone, and the vault checks it
 * against that root. One copy that cannot be written holds up no other, and
 * the vault takes no money until every one is in.
 *
 * The tree has ten levels, as deep as the account's own tree of signers, so it
 * holds one copy for every signer the account can seat. Places past the last
 * copy hold zero, which no copy's leaf can equal, so nothing can be written
 * there; the run is set with the path to the first of them (`edge`), which
 * shows the vault every place from the count on is empty, so no copy sits past
 * the count and none can be left unwritten when the count reaches zero.
 *
 * The leaf and node functions are the vault's own (`copyLeafOf`,
 * `copyNodeOf`), run here exactly as the circuit runs them, so a root built
 * here is the root the vault checks.
 */

/** How many levels the tree of copies has. The vault's `writeSecretCopy` takes a path of exactly this many steps. */
export const COPIES_TREE_DEPTH = 10;

/** The most copies one secret's tree holds. */
export const MOST_COPIES = 2 ** COPIES_TREE_DEPTH;

/** One signer's sealed copy, as the vault stores it: four parts, found by the reader's key. */
export interface SealedCopy {
  readonly reader: Uint8Array;
  readonly parts: readonly Uint8Array[];
}

/** One level of a copy's path: the node beside it, and whether the copy's side is the left one. */
export interface CopyStep {
  readonly sibling: bigint;
  readonly goesLeft: boolean;
}

/** What the signers approve, and what each copy is written with. */
export interface CopiesTree {
  /** The root the secret run approves. */
  readonly root: Uint8Array;
  /** How many copies the run approves, so the vault knows when every one is in. */
  readonly count: bigint;
  /** Each copy's path, in the order the copies were given. */
  readonly paths: readonly (readonly CopyStep[])[];
  /**
   * The path to the first place past the last copy, which the vault checks is empty with
   * everything to its right. A tree with every place full has no such place, and the vault
   * reads no edge for it; this is then the path to place 0, which it does not check.
   */
  readonly edge: readonly CopyStep[];
}

/** The vault's own functions this tree is built from. */
export interface CopiesTreeCircuits {
  copyLeafOf(commitment: Uint8Array, reader: Uint8Array, parts: Uint8Array[]): bigint;
  copyNodeOf(left: bigint, right: bigint): bigint;
  copiesRootOf(leaf: bigint, path: CopyStep[]): Uint8Array;
}

/**
 * **THE TREE OVER `copies`, FOR THE SECRET `commitment` NAMES.** Refuses no
 * copies and more than the tree holds, and a copy that is not four parts of
 * thirty-two bytes, before anything is approved.
 */
export function copiesTreeOf(
  circuits: CopiesTreeCircuits,
  commitment: Uint8Array,
  copies: readonly SealedCopy[],
): CopiesTree {
  if (copies.length === 0) {
    throw new Error('a secret with no sealed copy can be opened by nobody. Nothing is approved.');
  }
  if (copies.length > MOST_COPIES) {
    throw new Error(`the tree of sealed copies holds at most ${MOST_COPIES}, one for each signer the account can seat, `
      + `and ${copies.length} were given. Nothing is approved.`);
  }
  for (const c of copies) {
    if (!(c.reader instanceof Uint8Array) || c.reader.length !== 32
      || c.parts.length !== 4 || c.parts.some((p) => !(p instanceof Uint8Array) || p.length !== 32)) {
      throw new Error('a sealed copy is a 32-byte reader key and four 32-byte parts, and this is not one. Nothing is approved.');
    }
  }
  /* The empty subtree at each level: zero leaves, then each level's node over two of the level below. */
  const empty: bigint[] = [0n];
  for (let l = 0; l < COPIES_TREE_DEPTH; l++) empty.push(circuits.copyNodeOf(empty[l]!, empty[l]!));

  const levels: bigint[][] = [copies.map((c) => circuits.copyLeafOf(commitment, c.reader, [...c.parts]))];
  for (let l = 0; l < COPIES_TREE_DEPTH; l++) {
    const below = levels[l]!;
    const here: bigint[] = [];
    for (let i = 0; i < below.length; i += 2) {
      here.push(circuits.copyNodeOf(below[i]!, i + 1 < below.length ? below[i + 1]! : empty[l]!));
    }
    levels.push(here);
  }
  const pathTo = (index: number): CopyStep[] => {
    const path: CopyStep[] = [];
    let at = index;
    for (let l = 0; l < COPIES_TREE_DEPTH; l++) {
      const level = levels[l]!;
      const beside = at ^ 1;
      path.push({ sibling: beside < level.length ? level[beside]! : empty[l]!, goesLeft: (at & 1) === 0 });
      at >>= 1;
    }
    return path;
  };
  const paths = copies.map((_, index) => pathTo(index));
  const root = circuits.copiesRootOf(levels[0]![0]!, paths[0]!);
  const edge = pathTo(copies.length < MOST_COPIES ? copies.length : 0);
  return { root, count: BigInt(copies.length), paths, edge };
}

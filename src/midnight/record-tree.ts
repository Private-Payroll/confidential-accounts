/**
 * **THE COMPANY'S RECORDS AS ONE TREE, AND EVERY BATCH CHECKED AGAINST THE ONE
 * BEFORE IT.**
 *
 * Each record a company files - in any of the five stores its manifest enters
 * - has one leaf: its latest anchored version, with the entry its filer signed,
 * the batch that anchored it, the directory version anchored through that
 * batch and the hash of the record's previous leaf, so every older version is
 * on a chain behind the newest. The leaves sit in a sparse Merkle tree of
 * height 256 over SHA-256. A leaf's position is the first eight bytes of the
 * hash of its store and kind, then the first twenty-four of the hash of its
 * id: every record of one kind sits under one subtree, so a kind's whole list
 * is proven by recomputing that subtree.
 *
 * A batch's header names the head it follows, the root before it, the root
 * after it, the changes it makes in filing order - each with the leaf it
 * replaces - and the proof that takes the one root to the other. It is signed
 * by the anchoring seat, and the account's `anchor` call folds its digest
 * (`treeBatchOf`) into the head on chain, so a header is the one the chain
 * holds exactly when it folds to that head.
 *
 * **A HEADER IS CHECKED AGAINST THE ONE BEFORE IT, NEVER BY REPLAYING EVERY
 * BATCH (`transitionRefusal`).** It stops in one of two ways, never confused:
 *   · `dishonest` - the header's own message fails against the one before
 *     it: its seat, a filing no seat may file, a version that does not follow
 *     the one before it, bytes rolled back, or roots its changes do not make.
 *     The head binds that message whatever signature is beside it, so it is
 *     dishonest whatever the signature. It names the key that signed it when
 *     the signature verifies; when it does not, it names no key, since a seat
 *     can name another seat's key and nothing then proves who signed.
 *   · `not-given` - a header, an entry or an older leaf the header needs was
 *     not given, or a header whose message holds came with a signature that
 *     fails. That is the service's doing, and blames no seat: the head binds
 *     what the seat signed, not the signature itself, so the service may have
 *     swapped it, and a device that kept the header files it again.
 *
 * Pure, and loads no WebAssembly: the server and the page both import it. The
 * one function of the account a device needs - the head after a header - is
 * the caller's.
 */
export {
  EMPTY_ROOT, HEADERS_AT_ONCE, type KindAsked, PROVEN_AT_ONCE, type ProvenAsk, type RecordName, SparseTree, TREE_HEIGHT, type TreeLeaf, type TreeProof, type TreeSibling, ZERO, kindListRefusal, kindPrefixOf, leafHashOf, provenRefusal, rootFrom, treeKeyOf, treeLeafRefusal,
} from './record-tree-leaves.js';
export {
  type CheckedHead, EVERY_VERSION_KEPT, GENESIS, type NextHeaderInput, type ResumesFrom, type TransitionInput, type TransitionStop, type TreeChange, type TreeHeader, type Vouched, checkedAfter, nextTreeHeader, recoveredSaid, signTreeHeader, transitionRefusal, transitionStopSaid, treeBatchOf, treeHeaderMessage, treeHeaderReadable, treeHeaderShapeRefusal, treeHeaderSigned, vouchedFreshOf, vouchedRefusal,
} from './record-tree-headers.js';
export {
  type ForwardInput, type HeadStep, type HeadersPage, checkForward, headStepOf,
} from './record-tree-checked-forward.js';
export {
  type KeptTree, type ProofsAsk, type ProofsGiven, TreeKept, type TreeNode, headersPageOf, leavesNamedBy, pendingAt, proofsOf, treeHeaderFilingRefusal,
} from './record-tree-kept.js';

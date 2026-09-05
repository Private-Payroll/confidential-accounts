# 0010 — Revoking a signer without saying who they are

*14 Aug 2026. Status: **decided and built — one slot per signer.***

*Superseded twice on one day. The first version of this document proposed a
`revoked` set and was wrong. The second recommended re-seating every survivor
behind a cap of sixteen, which was built and worked. Both are kept below, in
short, because the reasons they were wrong are the reasons the current design is
shaped the way it is.*

## The problem

Removing a signer has two halves. **Reading** is done: K-4 changes the locks, and
a departing signer's copy of the old viewing key opens nothing new.

**Acting could not be done off chain at all.** Every circuit begins with
`requireSigner()`, which proves a Merkle path into `signers`. That tree was a
`HistoricMerkleTree`, whose `checkRoot` accepts any root it has ever held — on
purpose, so a path taken before other signers joined stays valid. Measured, not
assumed: a removed signer could approve, open a round of their own, and settle a
spend (`contracts/test/signer-governance.test.ts`).

## The fix that does not work, and why it is worth writing down

The obvious shape is a set of revoked leaves checked in `requireSigner`:

```
export ledger revoked: Set<Bytes<32>>;
assert(!revoked.member(disclose(leaf)), "that signer has been removed");
```

**Membership in a Compact `Set` requires disclosing the element.** `requireSigner`
runs at the head of every circuit, so this publishes the caller's leaf on every
action. Every leaf is already public in `signerLeaves`, so the chain would then
record *which* signer did each thing — rebuilding the membership graph M-36 was
raised and fixed to prevent, and destroying the property the product is sold on.

**Guard rail:** `an approval publishes nothing that identifies which signer made
it` counts each leaf and public key in the serialised public state before and
after an approval and asserts the count does not rise. Mutation-tested.

**So revocation must change what the tree contains, not add a check beside it.**

## The decision: one slot per signer

`signers` is a plain `MerkleTree<10, Bytes<32>>`. Each signer occupies one slot.
Removing somebody clears that slot and touches nobody else.

```
removeSigner(removedLeaf):
  requireSigner()                       # prove I am a signer — not which one
  <the round named this exact leaf, and reached the threshold>
  path = signerPath(removedLeaf)        # prove the tree holds that leaf
  signers.insertIndexDefault(slotOf(path))
```

Three things make it work, and each was answered by compiling rather than by
reasoning:

1. **A plain `MerkleTree` can be a ledger field.** Giving up historic roots is
   not a cost paid for the feature — it *is* the feature. A tree that accepts
   every root it has ever held is a tree that can never forget anybody.
2. **`insertIndexDefault` exists**, so one slot can be emptied.
3. **`MerkleTreePath` has no index — but it has `goes_left` per level, and
   those flags are the slot number in binary.** `slotOf` reads it out.

**The slot is derived, never supplied.** The flags are inputs to
`merkleTreePathRoot`, so flipping one changes the root and fails `checkRoot` —
the slot is bound by the same proof that binds the leaf. A slot passed in as an
argument would be bound to nothing, and a wrong one would clear a different
person's slot: the contract would remove a signer nobody voted to remove, and it
would look like a clean success.

**`requireSigner` must never call `slotOf`.** A slot names its occupant. Every
ordinary action has to stay unlinkable, so only `removeSigner` (which already
names the leaf being removed, because that is what was approved) and `addSigner`
(which names an *empty* slot, belonging to nobody) may derive one.

**Slots are reused, and reuse needs no free-list.** To take a slot, prove it is
empty — the same proof a removal makes about its own slot, with the empty value
in place of your leaf. One rule applied twice. Without reuse the tree would bound
the number of *additions* an account can ever make rather than the number of
signers it can hold, which is the tree-exhaustion trap the re-seating design had.

**Do not deepen the tree.** Depth is the length of the membership proof, checked
on every single transaction. A deeper tree taxes all of them forever, in exchange
for slots that reuse already provides.

## What it costs, and it is accepted

Dropping historic roots means **a membership change invalidates proofs already in
flight**, and proving takes ~82 seconds in a browser (M-78).

In practice this costs very little. `addSigner` and `removeSigner` each consume
the account's one open proposal and bump the round — and a round bump already
invalidated every in-flight approval under the historic tree. The case that
genuinely changes is a `credit` being proven while a membership change settles:
refused rather than mis-applied, and retried by the durable-job layer
(decision 0008). A cached path is re-derived from public data, so nothing is lost
but a cached value.

The M-13 test that asserted a stale path still verifies is **inverted, not
deleted**, with this reason recorded next to it.

## Why it beats what it replaced

The measurement, on the compiled circuits:

| circuit | zkir bytes |
| --- | --- |
| `removeSigner`, re-seating 16 survivors | 135,167 |
| `addSigner` | 31,770 |
| `execute` | 23,557 |
| `approve` | 12,392 |
| vacate one slot | 10,264 |
| take an empty slot | 10,251 |

13x cheaper, and removal stops being the heaviest circuit in the contract —
it becomes cheaper than approving a payment.

**But the cost was never the main argument.** Re-seating forced three things
that are worse than the cycles:

- **A hard cap on the approver set.** The survivor list was a statically sized
  vector, so a circuit is a fixed shape and every removal paid for all sixteen
  slots whether the account had three signers or sixteen. The cap is gone.
- **Every signer's blinding factor in the sealed roster.** A survivor's new leaf
  is `commit((publicKey, generation), blinding)`, and the account cannot compute
  one without the blinding — so a removal would have needed every remaining
  signer online, and the blindings were collected centrally instead. That is a
  deliberate breach of decision 0003, and **M-106 undoes it**: the blinding is
  back on one device and nowhere else, and the API that used to accept one no
  longer exists.
- **A rule computed on both sides.** The generation had to be derived
  identically in Compact and in TypeScript. It was not — M-104, chained with two
  different domain tags, invisible to both typecheckers and to the simulation,
  and it would have locked every surviving signer out of an account with money in
  it. Nothing re-seats anybody now, so there is no such rule. The safest version
  of a shared rule turned out to be no shared rule.

## The options that were rejected

- **Epoch-bound leaves, re-seated one at a time.** N−1 approval rounds per
  removal, with a window in the middle where the tree and `signerCount` disagree
  — the M-37 bootstrap hole, reopened.
- **Rebuild the tree in one circuit** (what was built, and is now replaced).
  Correct, proven against the compiled circuits, and carrying all three costs
  above.
- **Migrate the account.** No contract change, but the account's on-chain
  identity changes, every integration pointing at the old address breaks, and
  attestations issued against the old contract no longer describe the live
  account.

**The cap question this document used to raise — "is sixteen signers
acceptable?" — no longer exists.** It was an artefact of the survivor vector.

## Order of operations

1. **Revoke on chain first, then rotate** (K-4). The other order leaves a window
   where the leaver can still read *and* still act.
2. **The account may not be left below its own threshold.** Below it, nothing can
   ever be approved again — including a proposal to add somebody back — so the
   account is finished with the balance inside it.
3. **That refusal is also what keeps the bootstrap window shut.** `addSigner`
   lets one signer seat another unilaterally exactly while
   `signerCount < threshold`, and the refusal above is the precise complement of
   that condition. The two must stay complements: weaken the refusal and a
   removal hands the next single signer the power to seat their own. This is what
   the old warning "do not decrement `signerCount` naively" was pointing at, and
   it is now a named test rather than a note.

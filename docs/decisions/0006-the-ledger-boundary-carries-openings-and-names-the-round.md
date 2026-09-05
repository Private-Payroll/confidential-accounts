# 6. The ledger boundary carries openings, and names the round

## Decision

The `Ledger` interface no longer has a `publish` method. It has `open`,
`status`, `propose`, `approve`, `execute`, `cancel` and `credit` — one for one
with the contract's circuits — and the state-changing ones take the **opening**
of a commitment, never a commitment.

```ts
interface StateOpening { balance: number; entriesDigest: Hex; salt: Hex; }

execute(accountId, next: StateOpening, sealedState: Sealed, by: SignerRef): Promise<TxRef>
```

## Why

The old signature was `publish(accountId, commitment, sealedState)`: a hash and
a ciphertext. It was implementable exactly once, by the implementation it was
designed against.

The Compact contract does this:

```
stateCommitment =
  disclose(stateCommitmentOf(nextBalance(), nextEntriesDigest(), nextStateSalt()));
```

`execute()` takes no arguments and *derives* the commitment from three witnesses
supplied by the calling device. That is deliberate — decision 0004 — because a
public `Uint<64>` parameter would publish the balance of every company on the
network. So a commitment handed in from outside is a number the circuit cannot
check and cannot reproduce. `MidnightLedger` could open neither of the two
arguments it was given, and therefore could not make the contract commit to the
state it had been asked to publish.

The second half was worse and quieter. `SimulatedLedger.publish` wrote state
unconditionally. On Midnight, moving the state **is** the last step of an
approval round, legal only when a proposal is open and the threshold is met. The
boundary elided the entire lifecycle, so `core/account.ts` could be driving a
sequence the chain would reject with every test green.

Same root cause as M-12: an interface coherent on one side and impossible on the
other, which compiles perfectly.

## What changed

**The opening crosses the boundary, not the commitment.** `{ balance,
entriesDigest, salt }` is exactly what the witnesses want. The implementation
computes the commitment — `MidnightLedger` by calling the contract's own
exported `stateCommitmentOf`, not by rehashing the three values in TypeScript,
which would be the third definition of one scheme that decision 0004 exists to
prevent.

**The sealed blob now carries the opening.** It has to: the next call proves what
the *current* state is, and the salt is unrecoverable from the state alone.
Before this the blob held a nonce nothing ever read again.

**`SimulatedLedger` enforces instead of recording.** It refuses acting as a
non-signer, opening a second proposal, approving twice in one round, and
executing below the threshold. It starts at round 1, because the constructor does
`round.increment(1)` and a simulation starting at 0 would be off by one against
the real chain forever. The nullifier stand-in is `leaf@round` rather than
`H(domain, address, round, secretKey)` — it does not hide *which* signer
approved, and that is the one deliberate difference. It is a privacy property,
not a rule: both burn exactly once per signer per round, so both accept and
reject the same sequences.

**`credit` is a separate method.** Value arriving is not an approval round —
nobody needs permission to be paid — and keeping it separate is what made the
gap visible.

## Consequences

- **A deposit has no circuit, and now says so.** `execute` is the only thing that
  moves `stateCommitment`. `MidnightLedger.credit` refuses by name. This was
  always true; it was invisible while both paths went through `publish`, and
  would have surfaced on a live chain as a deposit that silently never settled.
  M-67.
- **One open proposal at a time is now a product constraint, not a footnote.**
  The contract permits exactly one. `cancel` exists on the boundary, in
  `AccountService`, and as an HTTP endpoint, because without it a single
  proposal that will never reach its threshold wedges the account permanently.
- **A blocked proposal never reaches the ledger.** Opening a round for something
  policy already refused would wedge the account with a proposal nobody wants.
- **The approval reaches the chain before it reaches our records.** The chain
  holds the nullifier set and is the only party that can say whether this
  approval counts. Writing locally first is how a UI comes to show two approvals
  where the chain holds one.
- **`grantAccess` is revealed as incomplete.** A granted signer can read and
  cannot act, because nothing adds their leaf to the tree. And after M-37,
  adding a signer past the bootstrap window is *itself* an approval round — so
  it is not one operation, and the product has to show it as one. M-69.
- **Deployment still lives in the script.** `MidnightLedger.open` throws and
  points at `scripts/deploy-preview.ts`. A second deploy path is the single most
  expensive place for the duplication failure this project keeps hitting — M-50,
  M-55, M-58, M-61, M-65 were each one rule written twice. M-68.

## How it was checked

Not by the suite going green. Each new guard was removed in turn and the test
that claims to cover it was confirmed to fail: the three in `SimulatedLedger`
(membership, one open proposal, threshold) and the two in `MidnightLedger`
(staging the next state, refusing without private state). 124 tests pass across
7 files.

One limit worth naming: the test for "the commitment comes from the contract"
stubs `stateCommitmentOf`, so it proves the ledger *asks* rather than that the
answer is right. Proving the answer needs the runtime, which is the contract
test suite's job, not this one's.

## Status

Accepted and implemented. `MidnightLedger` still has never run against a node —
this changes what it can express, not what it has proven.

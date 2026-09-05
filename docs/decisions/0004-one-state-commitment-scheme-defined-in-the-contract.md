# 4. One state commitment scheme, defined in the contract

## Decision

`stateCommitment` commits to the balance and a digest of everything else, under a salt:

```compact
export circuit stateCommitmentOf(balance: Uint<64>, entriesDigest: Bytes<32>, salt: Bytes<32>): Bytes<32> {
  return persistentCommit<Vector<2, Bytes<32>>>([balance as Field as Bytes<32>, entriesDigest], salt);
}
```

That circuit is the only definition. Every circuit that reads or writes `stateCommitment` calls it, and so does the Midnight adapter, via the generated pure circuit.

## Why this was needed

The first version of the contract had three incompatible schemes for one field:

| Where | Scheme |
| --- | --- |
| `execute()` | accepted arbitrary `Bytes<32>` from the caller |
| `attestSolvency()` | expected `persistentCommit<Uint<64>>(balance, salt)` |
| `core/crypto.ts` | sha256 over the whole canonicalised sealed state |

`attestSolvency` could therefore never have verified against a commitment the system actually produced. The contract compiled cleanly and the 46 tests passed, because nothing had ever executed the circuit.

A commitment scheme spread across three files is three schemes.

## Consequences

- **`execute()` takes no arguments.** The next balance arrives as a witness. A public `Uint<64>` parameter would publish the balance of every company on the network, which is the thing the product exists to prevent. Only the resulting commitment is disclosed.
- **The constructor computes the opening commitment** rather than accepting one, for the same reason.
- **`attestSolvency` verifies before it believes.** It recomputes the commitment from the witness and asserts equality against the ledger before disclosing anything. Without that step the caller could claim any balance they liked. It then returns `balance >= floor` and never the balance.
- **`core/` keeps its own commitment for `SimulatedLedger`.** It must stay isomorphic and free of Midnight dependencies, so it cannot call the generated circuit. The alignment happens in `src/midnight/`, which is the correct side of the boundary. A test at that seam is required and does not exist yet.
- **The balance is now `Uint<64>`, in minor units.** Anything needing more range or a decimal type changes this scheme and therefore every historical commitment.

## Related

The same test pass that forced this decision also found an authentication bypass in `requireSigner`, recorded in [decision 3](0003-signers-are-merkle-leaves-and-approvals-are-nullifiers.md). Both were invisible to the compiler and to the existing suite.

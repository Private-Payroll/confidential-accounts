# 2. Shared confidential state is built at the account layer

## Decision

Account state is sealed under a viewing key, the key is wrapped to each active signer's x25519 public key, and only a commitment goes on chain. The ciphertext lives off chain in a sealed state store.

## Why

Midnight private state is per party and client held. A witness is a TypeScript function running on one device against that device's own store. There is no protocol primitive that lets N signers read the same confidential value, and there is no plan for one.

An M-of-N account is meaningless if the signers cannot see the same balance, so the account layer supplies what the protocol does not.

## How

1. State is sealed with AES-256-GCM under a viewing key.
2. The viewing key is wrapped to each active signer.
3. `stateCommitment` on the contract commits to the sealed state.
4. Adding a signer is two steps: they join `pending`, then an existing signer re-wraps the viewing key to them.

Step 4 cannot be done by the server, which is why there is a real waiting state in the product rather than an instant one.

## Consequences

- **The server never holds anything that decrypts.** This is the constraint the whole codebase is built around. A change that puts a viewing key or signer secret on the server is wrong, not merely untidy.
- **The commitment makes the blob tamper evident, not available.** Whoever stores the ciphertext can withhold it. They cannot alter it undetected.
- **The sealed state store is behind an interface** (`SealedStateStore` in `src/midnight/ledger.ts`) so that moving to content-addressed storage later removes the withholding risk without touching anything above it. The on-chain commitment is already the pointer.
- **Write the blob before the commitment.** A blob with no commitment is garbage we can collect. A commitment with no blob is an account nobody can open.
- **Losing every wrapped copy of a viewing key loses the account.** Key custody is unfinished and this is why it matters.

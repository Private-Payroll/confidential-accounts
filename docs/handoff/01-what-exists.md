# What exists

One line each, and where the truth is. Nothing here is a specification.

## On chain

| | | Truth |
|---|---|---|
| **The account** | Signers in a merkle tree, M-of-N approval, proposals, per-vault thresholds. Holds no money | `contracts/src/ConfidentialAccount.compact` |
| **The vault** | Holds money, decides nothing. Calls the account to ask whether a payment was approved | `contracts/src/Vault.compact` |

The vault calls the account, never the reverse: a cross-contract callee may not read a witness, and
a vault must read one to spend a coin. The direction is forced, not chosen.

## The client

| | | |
|---|---|---|
| `src/midnight/ledger.ts` | Raising, approving, executing, sweeping — the account | |
| `src/midnight/vault-ledger.ts` | Deposit and payout — the vault | |
| `src/midnight/vault-notes.ts` | The note pool. **This is the money**: the chain holds only commitments | |
| `src/midnight/run-keys.ts` | A payroll run's per-payee secrets, derived so any admin can rebuild them | |
| `src/midnight/payout-tree.ts` | The merkle tree a run's approval covers, and retry runs | |
| `src/midnight/run-status.ts` | Who has been paid, read from the chain | |
| `src/midnight/vault-recovery.ts` | Rebuilding a vault's coin, and a payee's, from history | |
| `src/core/` | The simulated ledger, account records, sealed storage. Predates the chain work | |

## The shape of a payroll run

A run is **one proposal covering many payments**. Signers approve a merkle root over the payments
plus a window. Each payment is its own transaction proving one payee belongs to that root.

Five people cost five payments; two hundred cost two hundred. A run ends when its window closes and
by nothing else — see `02-decisions.md`.

## Tests and their guards

`contracts/test/` and `src/**/*.test.ts` — ~650 tests. `MUTATE.command` breaks the contracts 61 ways
and requires a named test to notice. There is **no equivalent for TypeScript** (T-11), which matters
because the client is the larger money surface.

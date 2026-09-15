# LEDGER FIELDS — WHO WRITES EACH ONE, WHO READS IT, AND WHAT THE PAYMENT PATH REACHES

**THIS FILE IS GENERATED. `npm run docs` WRITES IT AND NOTHING ELSE MAY.**

A reference, like `docs/design/circuits.md`, and searched rather than read.

**THE TWO COLUMNS ANSWER TWO DIFFERENT QUESTIONS AND THEY ARE KEPT APART ON
PURPOSE.** A field with many writers is where a change could let one circuit write a
value only another may write. A cold field sharing storage with a hot one is
contention on the spend path. Merging the columns into one *touched by* set answers
neither.

The machine-readable form of everything below, plus the client-side and witness
edges, is `docs/design/edges.json`, which `WHAT-BREAKS.command` queries.

<!-- GENERATED:BEGIN id="ledger-fields" door="npm run docs" -->

Every ledger field on both contracts, with **who writes it**, **who reads it**, and
whether the **payment path** reaches it. **Generated — nothing here is hand-written.**

`hot` means the field is read or written by a circuit reachable from `ConfidentialAccount.recordPayment`, `Vault.payout`, `Vault.payoutUnshielded`.

**A field with many writers is where a merge can let one circuit write a value only
another may write.** Reading down the writers column answers that.

**`hot` DOES NOT MEAN "SAFE TO MERGE WITH ANOTHER HOT FIELD", AND `cold` DOES NOT MEAN
"SAFE TO MERGE".** Contention is created by a writer in ANOTHER transaction touching
what a payment reads, and heat as measured here is within-transaction reachability, so
it is neither necessary nor sufficient for that. Two fields in this table make the
point: `Vault.account` is hot and no circuit writes it, so it can never contend; and
`openProposals` is hot and is written by `closeExpiredRun`, which anyone may call. The
column is evidence for a merge question, not an answer to one.

**`written by circuits` EXCLUDES THE CONSTRUCTOR, WHICH WRITES EVERY FIELD** because it
initialises them — a column that said so on every row would say nothing. `NO CIRCUIT`
therefore means exactly that, and not that the field is never written: in Compact a
record or map value is written whole, so a field no circuit writes today acquires every
writer of any record it is merged into.

## ConfidentialAccount

| # | field | storage | heat | written by circuits | read by circuits | constructor |
|---|---|---|---|---|---|---|
| 0 | `signers` | MerkleTree | cold | `amendSigner` | `adopt` `amendSigner` `approve` `cancel` `propose` `setThreshold` `setVaultThreshold` | writes it |
| 1 | `approvals` | Set | cold | `approve` | `approve` | writes it |
| 2 | `openProposals` | Map | **hot** | `adopt` `amendSigner` `cancel` `closeExpiredRun` `propose` `retireVault` `setThreshold` `setVaultThreshold` | `adopt` `amendSigner` `approve` `cancel` `closeExpiredRun` `propose` `recordPayment` `retireVault` `setThreshold` `setVaultThreshold` | writes it |
| 3 | `approvalCounts` | Map | **hot** | `adopt` `amendSigner` `approve` `cancel` `closeExpiredRun` `propose` `retireVault` `setThreshold` `setVaultThreshold` | `adopt` `amendSigner` `approve` `recordPayment` `retireVault` `setThreshold` `setVaultThreshold` | writes it |
| 4 | `movements` | Set | **hot** | `recordPayment` | `recordPayment` | writes it |
| 5 | `threshold` | Cell | **hot** | `setThreshold` | `adopt` `amendSigner` `recordPayment` `retireVault` `setThreshold` `setVaultThreshold` | writes it |
| 6 | `thresholds` | Map | **hot** | `setVaultThreshold` | `recordPayment` | writes it |
| 7 | `vaults` | Set | cold | `adopt` `retireVault` | `adopt` `retireVault` | writes it |
| 8 | `runWindow` | Map | cold | `adopt` `amendSigner` `cancel` `closeExpiredRun` `propose` `retireVault` `setThreshold` `setVaultThreshold` | `cancel` `closeExpiredRun` | writes it |
| 9 | `signerLeaves` | Set | cold | `amendSigner` | `amendSigner` `setThreshold` | writes it |
| 10 | `retiredAt` | Map | cold | `retireVault` | **NO CIRCUIT** | writes it |
| 11 | `proposalHolds` | Map | cold | **NO CIRCUIT** | **NO CIRCUIT** | writes it |
| 12 | `successor` | Cell | cold | **NO CIRCUIT** | **NO CIRCUIT** | writes it |
| 13 | `signerRoles` | Map | cold | **NO CIRCUIT** | **NO CIRCUIT** | writes it |

## Vault

| # | field | storage | heat | written by circuits | read by circuits | constructor |
|---|---|---|---|---|---|---|
| 0 | `account` | Cell | **hot** | **NO CIRCUIT** | `payout` `payoutUnshielded` `retire` | writes it |
| 1 | `notes` | Set | **hot** | `deposit` `payout` `splitNote` | `payout` `retire` `splitNote` | writes it |
| 2 | `unshieldedTokens` | Set | cold | `depositUnshielded` `forgetUnshielded` | `retire` | writes it |
| 3 | `payments` | Counter | **hot** | `payout` `payoutUnshielded` | **NO CIRCUIT** | writes it |
| 4 | `spendingCaps` | Map | cold | **NO CIRCUIT** | **NO CIRCUIT** | writes it |

## Cross-contract calls

| caller | callee |
|---|---|
| `Vault.payout` | `ConfidentialAccount.recordPayment` |
| `Vault.payoutUnshielded` | `ConfidentialAccount.recordPayment` |
| `Vault.retire` | `ConfidentialAccount.retireVault` |

## What the client-side scan does NOT know

Scanned 432 files; 541 invocations carry a literal circuit name and 9 do not.

Five layers stand between a product call and a circuit, three of which rename:

- src/midnight/ledger.ts — MidnightLedger: addSigner/removeSigner both reach amendSigner; proposeRun reaches propose
- src/midnight/commitments.ts — MidnightCommitments: assetKey/proposalId/changeCommitment rename assetKeyOf/proposalIdOf/changeCommitmentOf
- contracts/test/simulator.ts — AccountSimulator: addSigner/removeSigner reach amendSigner; proposeRun reaches propose
- src/core/ledger.ts — LedgerPort/SimulatedLedger: method names SHADOW circuit names and reach no circuit at all
- src/midnight/vault-recovery.ts, src/midnight/payout-tree.ts — circuits passed as function-valued parameters; no name at the call site

Unresolved call sites, named rather than dropped:

- `src/midnight/governed-call.test.ts:138` — callTx[<expr>]: the circuit is a runtime string; there is no name at this call site
- `src/midnight/governed-call.test.ts:146` — callTx[<expr>]: the circuit is a runtime string; there is no name at this call site
- `src/midnight/governed-call.test.ts:158` — callTx[<expr>]: the circuit is a runtime string; there is no name at this call site
- `src/midnight/governed-call.test.ts:161` — callTx[<expr>]: the circuit is a runtime string; there is no name at this call site
- `src/midnight/governed-call.test.ts:312` — callTx[<expr>]: the circuit is a runtime string; there is no name at this call site
- `src/midnight/governed-call.test.ts:330` — callTx[<expr>]: the circuit is a runtime string; there is no name at this call site
- `src/midnight/ledger.ts:2109` — callTx[<expr>]: the circuit is a runtime string; there is no name at this call site
- `src/midnight/vault-ledger.ts:798` — callTx[<expr>]: the circuit is a runtime string; there is no name at this call site
- `scripts/sponsor-test.ts:472` — callTx[<expr>]: the circuit is a runtime string; there is no name at this call site
<!-- GENERATED:END id="ledger-fields" body="49f921585a5cf723" -->

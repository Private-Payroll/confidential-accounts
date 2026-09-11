# MODULES — THE DECLARED MONEY-PATH SET, AND THE IMPORT GRAPH AROUND IT

**EVERYTHING BETWEEN THE TWO `GENERATED` MARKERS BELOW IS MACHINE-WRITTEN, AND
NOTHING ELSE MAY WRITE IT.** These four paragraphs are not: they are the only part of
this file a person typed. Editing inside the markers is caught by the suite, and a
regeneration would overwrite it anyway. To change what the block says, change the code
and run `npm run docs`.

It is a REFERENCE, not a document: nobody opens it to read it, they search it. The
reasoning — why a module exists, what it protects, what was rejected — belongs with
the design documents and none of it belongs here.

**WHAT THIS ANSWERS THAT NOTHING ELSE DID.** The machine-readable edge list ran from
a TypeScript file to a CIRCUIT and nowhere else, so it could say what calls the chain
and could not say what calls what. A reader asking *what breaks if I change this
module* had no list to read, and an audit of a contract had no way to ask which
product code reaches a given circuit without walking the tree by hand.

**THE TWO HALVES ARE DIFFERENT SIZES ON PURPOSE.** The import graph covers every
`.ts`, `.tsx` and `.mjs` module in the three client trees, because a reachability
question answered over part of a graph is worse than one not answered at all. The full
reference — exported surface, refusals, fixed widths — covers only the declared
money-path set, because that is the set whose changes can force a contract change.

**IT IS NOT A COMPLETE PICTURE OF THE PRODUCT AND DOES NOT CLAIM TO BE.** A module
outside those three trees is not a node here however often it is imported, and the
generated table below counts how many such imports there are. Read that row before
concluding that anything is unreached.

<!-- GENERATED:BEGIN id="modules" door="npm run docs" -->

Every module the money path is declared over, in full, and the import graph of the
whole client tree around them. **Generated — nothing in this block is hand-written.**

**THIS CARRIES NO DESCRIPTION OF WHAT A MODULE IS FOR, AND THE OMISSION IS THE DESIGN.**
A description is prose, the generator writes none, and a sentence copied out of a
source comment is a sentence nothing keeps true. What a module IS, here, is its
exported surface, what it refuses, where it fixes a width, and what it can reach.

**THE IMPORT GRAPH IS MATCHED, NOT PARSED, AND THE SHAPES ARE NAMED BELOW.** A
specifier built from a variable has no name at its site and is invisible to all of
them — the same limit the circuit scan carries, for the same reason. What the walk
could not read or could not resolve is COUNTED here and NAMED in the machine-
readable edge list beside this document, never dropped: a module missing from a
graph looks exactly like a module nothing imports, and *nothing imports this* is a
conclusion somebody acts on.

**`reaches` IS NOT A CALL GRAPH AND MUST NOT BE READ AS ONE.** It is two closures,
one after the other: forward along imports, importer to imported; then forward along
what those circuits themselves run, including across the contract boundary. So a
module that imports a boundary reaches every circuit that boundary names, whether or
not any particular function of it does, and reaches whatever those circuits land on
chain. Within the import graph it is an upper bound.

**IT IS STILL NOT A LOWER BOUND ON WHAT REACHES THE CHAIN**, and the gap is named
rather than left: a call made through a runtime string has no circuit name at its
site, so a module whose only route to a circuit runs through one of those does not
show it here. Those sites are counted and named in the field reference beside this
one — **not in the table below**, whose zero is about import specifiers and is a
different question.

**AND TWO TABLES BELOW ARE MATCHED RATHER THAN UNDERSTOOD, WHICH IS SAID HERE
BECAUSE AN EMPTY CELL IN EITHER WOULD OTHERWISE READ AS A GUARANTEE.** *What it
refuses* finds a `throw`, an `assert` and an `invariant` whose message is written
from literals; a refusal raised some other way, or carrying no literal at all, is
not here. *Where a width is fixed* finds a width written as a number or as a
capitalised constant; a width arriving in a variable is not here. **AND IT
OVER-MATCHES AS WELL AS UNDER-MATCHING** — a length compared against a small
number, or a slice taken of a string, looks the same to a matcher as a byte width
and appears here. A row is a site the shapes matched, never a byte width
confirmed. Neither table is a proof that a module refuses nothing or fixes
nothing.

## What the walk covered

| | |
|---|---|
| modules walked | 381 |
| module-to-module import sites | 1288 |
| modules that could not be read | 0 |
| specifiers that resolved to nothing | 0 |
| specifiers naming a real file outside the walked set | 82 |
| call sites carrying a literal circuit name | 468 |

The last row counts a SITE once. A site whose text answers to more than one of the
circuit-scan shapes is one call, and counting it twice would overstate how much of
the product this list has actually seen.

The shapes an import is recognised by:

- `import/export ... from 'X'`
- `import 'X'`
- `import('X')`
- `require('X')`

What the import walk cannot see, named rather than implied complete:

- a specifier built from a variable — there is no name at the site, exactly as at a dynamic circuit dispatch
- a multi-line import whose brace list carries a semicolon inside a comment — measured at zero occurrences here
- the second and any later static import statement written on one physical line — this occurs ONCE in this tree and costs two platform modules
- an indented static import — measured at zero occurrences here; the column-zero anchor is what keeps prose out of the graph
- a dynamic import written on a line this treats as a comment line
- the text of a dynamic import written inside a string is MATCHED rather than missed — it invents a dependency, and the two shapes that can do it now refuse a match preceded by a dot, a quote, a backtick or a word character
- re-exports are edges to the module named, never to wherever the name was originally declared
- a specifier naming a real file outside these three trees — a compiled contract module, a config, a probe tree — is counted above and is not an edge

## The declared set, at a glance

| module | tier | imports | imported by | exports | refuses | fixed widths | reaches |
|---|---|---|---|---|---|---|---|
| `src/midnight/payout-tree.ts` | 1 | 3 | 27 | 14 | 13 | 0 | 1 |
| `src/midnight/run-keys.ts` | 1 | 1 | 9 | 8 | 4 | 0 | 0 |
| `src/midnight/commitments.ts` | 1 | 3 | 16 | 2 | 3 | 0 | 12 |
| `src/core/signer-leaf.ts` | 1 | 2 | 7 | 9 | 2 | 1 | 0 |
| `src/core/crypto.ts` | 1 | 0 | 111 | 28 | 2 | 7 | 0 |
| `src/midnight/payee-address.ts` | 1 | 2 | 19 | 12 | 11 | 1 | 0 |
| `src/core/payslip-key.ts` | 1 | 3 | 3 | 2 | 1 | 0 | 0 |
| `src/core/payslip-key-derive.ts` | 1 | 1 | 3 | 1 | 1 | 3 | 0 |
| `src/midnight/ledger.ts` | 2 | 9 | 13 | 44 | 46 | 5 | 22 |
| `src/midnight/vault-ledger.ts` | 2 | 10 | 11 | 12 | 24 | 0 | 32 |
| `src/midnight/vault-notes.ts` | 2 | 3 | 11 | 10 | 15 | 0 | 32 |
| `src/midnight/vault-coins.ts` | 2 | 1 | 7 | 4 | 7 | 0 | 0 |
| `src/core/movement.ts` | 2 | 4 | 5 | 9 | 6 | 0 | 1 |
| `src/midnight/run-status.ts` | 2 | 3 | 8 | 12 | 2 | 0 | 0 |

## Every circuit, and what reaches it

**THIS IS THE COLUMN AN AUDIT OF A CONTRACT ARRIVES WANTING.**

**THE TWO COLUMNS ANSWER DIFFERENT QUESTIONS AND A ROW CAN BE EMPTY IN THE FIRST
AND NOT THE SECOND.** *Naming* means a TypeScript file writes that circuit's name at
a call site. *Reaching* includes a circuit that another circuit runs, across the
contract boundary — so **NONE** in the first column does not mean the circuit is
never invoked here, only that no TypeScript names it directly. Read the two
together: **NONE** with a reaching count above zero is a circuit only ever entered
through another contract, which is a fact about the design and not a dead circuit.

| circuit | modules naming it | modules reaching it |
|---|---|---|
| `ConfidentialAccount.signerPublicKey` | `contracts/test/one-definition.test.ts` `contracts/test/simulator.ts` `contracts/test/what-a-signer-is.test.ts` `scripts/diagnose-state.ts` `scripts/governance-steps.ts` `scripts/mutate-authority.mjs` `scripts/prove-compare.ts` `scripts/run-preview.ts` `src/midnight/commitments.ts` | 107 |
| `ConfidentialAccount.signerLeaf` | `contracts/test/commitments.test.ts` `contracts/test/one-definition.test.ts` `contracts/test/simulator.ts` `contracts/test/what-a-signer-is.test.ts` `scripts/diagnose-state.ts` `scripts/governance-steps.ts` `scripts/prove-compare.ts` `scripts/run-preview.ts` `src/midnight/commitments.ts` | 106 |
| `ConfidentialAccount.assetKeyOf` | `contracts/test/commitments.test.ts` `contracts/test/one-definition.test.ts` `contracts/test/simulator.ts` `scripts/run-preview.ts` `src/midnight/commitments.ts` | 103 |
| `ConfidentialAccount.changeCommitmentOf` | `contracts/test/commitments.test.ts` `contracts/test/one-definition.test.ts` `contracts/test/the-service-layer-meets-the-chain.test.ts` `src/midnight/commitments.ts` `src/midnight/ledger.ts` | 103 |
| `ConfidentialAccount.proposalIdOf` | `contracts/test/commitments.test.ts` `contracts/test/one-definition.test.ts` `contracts/test/simulator.ts` `contracts/test/the-payroll-run-meets-the-chain.test.ts` `contracts/test/the-service-layer-meets-the-chain.test.ts` `scripts/governance-steps.ts` `scripts/run-preview.ts` `src/midnight/commitments.ts` | 104 |
| `ConfidentialAccount.signerAddPayload` | `contracts/test/commitments.test.ts` `contracts/test/one-definition.test.ts` `contracts/test/payout-runs.test.ts` `contracts/test/signer-governance.test.ts` `contracts/test/simulator.ts` `contracts/test/vault-threshold-recovery.test.ts` `scripts/governance-steps.ts` `scripts/measure-call-cost.ts` `scripts/run-preview.ts` `src/midnight/commitments.ts` | 102 |
| `ConfidentialAccount.removeSignerPayload` | `contracts/test/one-definition.test.ts` `contracts/test/signer-governance.test.ts` `contracts/test/vault-threshold-recovery.test.ts` `scripts/governance-steps.ts` `scripts/measure-call-cost.ts` `src/midnight/commitments.ts` | 102 |
| `ConfidentialAccount.setThresholdPayload` | `contracts/test/one-definition.test.ts` `contracts/test/payout-runs.test.ts` `contracts/test/signer-governance.test.ts` `contracts/test/simulator.ts` `contracts/test/the-service-layer-meets-the-chain.test.ts` `contracts/test/vault-threshold-recovery.test.ts` `scripts/governance-steps.ts` `scripts/measure-call-cost.ts` `src/midnight/commitments.ts` | 101 |
| `ConfidentialAccount.allVaults` | `contracts/test/one-definition.test.ts` `contracts/test/vault-scoping.test.ts` `scripts/diagnose-state.ts` `scripts/prove-compare.ts` `scripts/run-preview.ts` `scripts/sponsor-test.ts` `src/midnight/commitments.ts` | 88 |
| `ConfidentialAccount.noVault` | `contracts/test/one-definition.test.ts` `contracts/test/payout-runs.test.ts` `contracts/test/vault-scoping.test.ts` `contracts/test/vault-threshold-recovery.test.ts` `scripts/governance-steps.ts` `scripts/run-preview.ts` `src/midnight/commitments.ts` `src/midnight/ledger.test.ts` | 104 |
| `ConfidentialAccount.paidMovementOf` | `contracts/test/a-retry-lives-on-the-leg-it-retries.test.ts` `contracts/test/one-definition.test.ts` `contracts/test/payout-runs.test.ts` `contracts/test/the-payroll-run-meets-the-chain.test.ts` `contracts/test/transcript.test.ts` `contracts/test/vault-client.test.ts` `contracts/test/vault-payout.test.ts` `contracts/test/vault-scoping.test.ts` `contracts/test/vault-threshold-recovery.test.ts` `contracts/test/vault-unshielded.test.ts` `src/midnight/ledger.ts` | 90 |
| `ConfidentialAccount.runPayload` | `contracts/test/approvals.test.ts` `contracts/test/one-definition.test.ts` `contracts/test/payout-runs.test.ts` `contracts/test/run-status.test.ts` `contracts/test/the-payroll-run-meets-the-chain.test.ts` `contracts/test/transcript.test.ts` `contracts/test/vault-client.test.ts` `contracts/test/vault-payout.test.ts` `contracts/test/vault-recovery.test.ts` `contracts/test/vault-registry.test.ts` `contracts/test/vault-scoping.test.ts` `contracts/test/vault-split.test.ts` `contracts/test/vault-threshold-recovery.test.ts` `contracts/test/vault-unshielded.test.ts` `scripts/measure-call-cost.ts` `src/midnight/commitments.ts` | 103 |
| `ConfidentialAccount.payoutLeaf` | `contracts/test/one-definition.test.ts` `contracts/test/payout-runs.test.ts` `contracts/test/vault-scoping.test.ts` `src/midnight/payout-tree.ts` | 122 |
| `ConfidentialAccount.setVaultThresholdPayload` | `contracts/test/one-definition.test.ts` `contracts/test/vault-registry.test.ts` `contracts/test/vault-scoping.test.ts` `contracts/test/vault-threshold-recovery.test.ts` `scripts/measure-call-cost.ts` `src/midnight/commitments.ts` | 100 |
| `ConfidentialAccount.vacantSlot` | `contracts/test/one-definition.test.ts` `contracts/test/simulator.ts` `contracts/test/what-a-signer-is.test.ts` `scripts/governance-steps.ts` `src/midnight/ledger.test.ts` `src/midnight/ledger.ts` | 91 |
| `ConfidentialAccount.adoptVaultPayload` | `contracts/test/one-definition.test.ts` `contracts/test/vault-registry.test.ts` `scripts/measure-call-cost.ts` | 24 |
| `ConfidentialAccount.retireVaultPayload` | `contracts/test/one-definition.test.ts` `contracts/test/vault-registry.test.ts` `scripts/measure-call-cost.ts` | 4 |
| `ConfidentialAccount.slotOf` | `contracts/test/one-definition.test.ts` `contracts/test/signer-governance.test.ts` `contracts/test/simulator.ts` `scripts/governance-steps.ts` | 91 |
| `ConfidentialAccount.amendSigner` | `contracts/test/simulator.ts` `scripts/governance-steps.ts` `scripts/measure-call-cost.ts` `scripts/prove-compare.ts` `scripts/run-preview.ts` `src/midnight/ledger.ts` | 90 |
| `ConfidentialAccount.setThreshold` | `contracts/test/simulator.ts` `scripts/governance-steps.ts` `scripts/measure-call-cost.ts` `src/midnight/ledger.ts` | 89 |
| `ConfidentialAccount.propose` | `contracts/test/simulator.ts` `scripts/cross-contract-spike.ts` `scripts/governance-steps.ts` `scripts/measure-call-cost.ts` `scripts/run-preview.ts` `src/midnight/ledger.ts` `src/web/proving-runner.test.ts` | 91 |
| `ConfidentialAccount.approve` | `contracts/test/simulator.ts` `scripts/governance-steps.ts` `scripts/measure-call-cost.ts` `scripts/run-preview.ts` `src/midnight/job-runner.test.ts` `src/midnight/ledger.ts` `src/midnight/what-a-balance-books.test.ts` | 90 |
| `ConfidentialAccount.cancel` | `contracts/test/simulator.ts` `scripts/governance-steps.ts` `scripts/measure-call-cost.ts` `scripts/run-preview.ts` `src/midnight/ledger.ts` | 89 |
| `ConfidentialAccount.closeExpiredRun` | `contracts/test/simulator.ts` `scripts/measure-call-cost.ts` `src/midnight/ledger.ts` | 88 |
| `ConfidentialAccount.recordPayment` | `contracts/test/simulator.ts` `scripts/measure-call-cost.ts` | 43 |
| `ConfidentialAccount.setVaultThreshold` | `contracts/test/simulator.ts` `scripts/measure-call-cost.ts` `src/midnight/ledger.ts` | 88 |
| `ConfidentialAccount.adopt` | `contracts/test/simulator.ts` `scripts/measure-call-cost.ts` | 23 |
| `ConfidentialAccount.retireVault` | **NONE** | 3 |
| `Vault.payoutDetails` | `contracts/test/transcript.test.ts` `contracts/test/vault-client.test.ts` `contracts/test/vault-payout.test.ts` `contracts/test/vault-recovery.test.ts` `contracts/test/vault-registry.test.ts` `contracts/test/vault-split.test.ts` `contracts/test/vault-threshold-recovery.test.ts` `scripts/measure-call-cost.ts` | 29 |
| `Vault.unshieldedPayoutDetails` | `contracts/test/vault-client.test.ts` | 23 |
| `Vault.heldCommitmentOf` | `contracts/test/vault-payout.test.ts` `contracts/test/vault-split.test.ts` `src/midnight/vault-ledger.test.ts` | 30 |
| `Vault.noteBlindingOf` | `contracts/test/vault-payout.test.ts` `contracts/test/vault-split.test.ts` `src/midnight/vault-ledger.test.ts` | 30 |
| `Vault.deposit` | `contracts/test/transcript.test.ts` `contracts/test/vault-client.test.ts` `contracts/test/vault-payout.test.ts` `contracts/test/vault-recovery.test.ts` `contracts/test/vault-registry.test.ts` `contracts/test/vault-split.test.ts` `contracts/test/vault-threshold-recovery.test.ts` `contracts/test/vault-unshielded.test.ts` `scripts/chain-probe.ts` `scripts/measure-call-cost.ts` `src/midnight/vault-call-convention.test.ts` `src/midnight/vault-ledger.test.ts` `src/midnight/vault-ledger.ts` | 29 |
| `Vault.depositUnshielded` | `contracts/test/vault-client.test.ts` `contracts/test/vault-unshielded.test.ts` `src/midnight/vault-ledger.test.ts` `src/midnight/vault-ledger.ts` | 23 |
| `Vault.payout` | `contracts/test/transcript.test.ts` `contracts/test/vault-client.test.ts` `contracts/test/vault-payout.test.ts` `contracts/test/vault-recovery.test.ts` `contracts/test/vault-registry.test.ts` `contracts/test/vault-split.test.ts` `contracts/test/vault-threshold-recovery.test.ts` `contracts/test/vault-unshielded.test.ts` `scripts/cross-contract-spike.ts` `scripts/measure-call-cost.ts` `src/midnight/vault-call-convention.test.ts` `src/midnight/vault-ledger.test.ts` `src/midnight/vault-ledger.ts` | 29 |
| `Vault.payoutUnshielded` | `contracts/test/vault-client.test.ts` `contracts/test/vault-unshielded.test.ts` `src/midnight/vault-ledger.test.ts` `src/midnight/vault-ledger.ts` | 23 |
| `Vault.splitNote` | `contracts/test/vault-recovery.test.ts` `contracts/test/vault-split.test.ts` `scripts/measure-call-cost.ts` | 3 |
| `Vault.forgetUnshielded` | `contracts/test/vault-unshielded.test.ts` | 1 |
| `Vault.retire` | `contracts/test/vault-registry.test.ts` `contracts/test/vault-unshielded.test.ts` `scripts/measure-call-cost.ts` | 3 |

## `src/midnight/payout-tree.ts`

Tier 1 of the declared set.

- **imports** — `src/core/crypto.ts`, `src/midnight/payee-address.ts`, `src/midnight/run-keys.ts`
- **imported by** — `contracts/test/a-retry-lives-on-the-leg-it-retries.test.ts`, `contracts/test/a-run-carries-its-own-material.test.ts`, `contracts/test/approvals.test.ts`, `contracts/test/one-definition.test.ts`, `contracts/test/payout-runs.test.ts`, `contracts/test/run-keys.test.ts`, `contracts/test/run-status.test.ts`, `contracts/test/the-payroll-run-meets-the-chain.test.ts`, `contracts/test/transcript.test.ts`, `contracts/test/vault-client.test.ts`, `contracts/test/vault-payout.test.ts`, `contracts/test/vault-recovery.test.ts`, `contracts/test/vault-registry.test.ts`, `contracts/test/vault-scoping.test.ts`, `contracts/test/vault-split.test.ts`, `contracts/test/vault-threshold-recovery.test.ts`, `contracts/test/vault-unshielded.test.ts`, `scripts/measure-call-cost.ts`, `src/core/a-payroll-run-is-always-private.test.ts`, `src/core/movement.ts`, `src/core/payroll.ts`, `src/core/types.ts`, `src/midnight/run-material.ts`, `src/midnight/vault-details.ts`, `src/server/index.ts`, `src/standalone/main.tsx`, `src/testing/vault-details.ts`
- **outside packages** — `@midnight-ntwrk/compact-runtime`
- **platform modules** — *none*
- **circuits named here** — `ConfidentialAccount.payoutLeaf`
- **circuits reached** — *through imports, then through what those circuits themselves run* — `ConfidentialAccount.payoutLeaf`

### `src/midnight/payout-tree.ts` — exported surface

| line | name | as written |
|---|---|---|
| 39 | `PAYOUT_TREE_DEPTH` | `export const PAYOUT_TREE_DEPTH = 16;` |
| 99 | `PayoutLeafInput` | `export interface PayoutLeafInput` |
| 134 | `PayoutTree` | `export interface PayoutTree` |
| 161 | `payoutLeafOf` | `export const payoutLeafOf = (p: PayoutLeafInput): Hex =>` |
| 183 | `rootOfLeaves` | `export const rootOfLeaves = (leaves: Hex[]): Hex =>` |
| 195 | `buildPayoutTree` | `export const buildPayoutTree = (payments: PayoutLeafInput[]): PayoutTree =>` |
| 285 | `PaymentFacts` | `export interface PaymentFacts` |
| 320 | `ShieldedPaymentFacts` | `export type ShieldedPaymentFacts = PaymentFacts & { payee: PayeeAddress };` |
| 323 | `PayeeArgs` | `export interface PayeeArgs extends PaymentFacts` |
| 334 | `PayrollRun` | `export interface PayrollRun` |
| 355 | `DetailsOf` | `export type DetailsOf = (` |
| 379 | `DetailsOfKind` | `export type DetailsOfKind = Readonly<Record<PayeeKind, DetailsOf>>;` |
| 428 | `buildRun` | `export const buildRun = (` |
| 485 | `buildRetryRun` | `export const buildRetryRun = (original: PayrollRun, indices: number[]): PayrollRun =>` |

### `src/midnight/payout-tree.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 90 | throw | the payout tree hashed to [value] bytes; a run's root is [value] |
| 184 | throw | a payroll run needs at least one payee |
| 186 | throw | a run holds at most [value] payees |
| 191 | throw | the payout tree did not hash |
| 203 | throw | a payroll run needs at least one payee |
| 206 | throw | a run holds at most [value] payees; this one has [value] |
| 229 | throw | payees [value] and [value] have the same leaf — a nonce has been reused, and the second of them could never be paid |
| 241 | throw | the payout tree did not hash |
| 259 | throw | no path for payee [value] |
| 397 | throw | this run has [value] payees; there is no payee [value] |
| 486 | throw | nothing outstanding to retry |
| 491 | throw | payee [value] is not in the original run |
| 493 | throw | payee [value] listed twice |

### `src/midnight/payout-tree.ts` — where a width is fixed

*No width here matches the shapes above.* A width this module works to may
arrive in a variable, and this list sees only a number or a capitalised constant.

## `src/midnight/run-keys.ts`

Tier 1 of the declared set.

- **imports** — `src/core/crypto.ts`
- **imported by** — `contracts/test/a-run-carries-its-own-material.test.ts`, `contracts/test/run-keys.test.ts`, `contracts/test/vault-client.test.ts`, `contracts/test/vault-payout.test.ts`, `src/core/a-payroll-run-is-always-private.test.ts`, `src/core/payroll.ts`, `src/core/types.ts`, `src/midnight/payout-tree.ts`, `src/midnight/run-material.ts`
- **outside packages** — `@noble/hashes`
- **platform modules** — *none*
- **circuits named here** — *none*
- **circuits reached** — *through imports, then through what those circuits themselves run* — *none*

### `src/midnight/run-keys.ts` — exported surface

| line | name | as written |
|---|---|---|
| 68 | `PayoutSeed` | `export interface PayoutSeed` |
| 74 | `RunIdentity` | `export interface RunIdentity` |
| 93 | `currentPayoutSeed` | `export const currentPayoutSeed = (seeds: PayoutSeed[]): PayoutSeed =>` |
| 107 | `payoutSeedAt` | `export const payoutSeedAt = (seeds: PayoutSeed[], epoch: number): PayoutSeed =>` |
| 123 | `runKeyOf` | `export const runKeyOf = (seed: Hex, id: RunIdentity): Hex =>` |
| 127 | `PayeeSecrets` | `export interface PayeeSecrets` |
| 143 | `payeeSecretsOf` | `export const payeeSecretsOf = (runKey: Hex, index: number): PayeeSecrets =>` |
| 160 | `runSecrets` | `export const runSecrets = (` |

### `src/midnight/run-keys.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 95 | throw | this account has no payout seed; it cannot raise a payroll run |
| 110 | throw | no payout seed for epoch [value]; this run cannot be rebuilt from this account's state |
| 145 | throw | a payee index is a non-negative integer; got [value] |
| 166 | throw | a run has at least one payee; got [value] |

### `src/midnight/run-keys.ts` — where a width is fixed

*No width here matches the shapes above.* A width this module works to may
arrive in a variable, and this list sees only a number or a capitalised constant.

## `src/midnight/commitments.ts`

Tier 1 of the declared set.

- **imports** — `src/core/assets.ts`, `src/core/crypto.ts`, `src/core/ledger.ts`
- **imported by** — `contracts/test/a-leg-is-raised-again-as-itself.test.ts`, `contracts/test/a-payroll-the-vault-cannot-pay-is-not-raised.test.ts`, `contracts/test/a-retry-lives-on-the-leg-it-retries.test.ts`, `contracts/test/a-run-carries-its-own-material.test.ts`, `contracts/test/commitments.test.ts`, `contracts/test/one-definition.test.ts`, `contracts/test/the-payroll-run-meets-the-chain.test.ts`, `contracts/test/the-service-layer-meets-the-chain.test.ts`, `contracts/test/what-a-signer-is.test.ts`, `scripts/deploy-preview.ts`, `src/midnight/ledger.test.ts`, `src/midnight/ledger.ts`, `src/web/the-page-renders.test.tsx`, `src/wiring/chain.ts`, `src/wiring/one-wiring-point.test.ts`, `src/wiring/selection.ts`
- **outside packages** — *none*
- **platform modules** — *none*
- **circuits named here** — `ConfidentialAccount.allVaults`, `ConfidentialAccount.assetKeyOf`, `ConfidentialAccount.changeCommitmentOf`, `ConfidentialAccount.noVault`, `ConfidentialAccount.proposalIdOf`, `ConfidentialAccount.removeSignerPayload`, `ConfidentialAccount.runPayload`, `ConfidentialAccount.setThresholdPayload`, `ConfidentialAccount.setVaultThresholdPayload`, `ConfidentialAccount.signerAddPayload`, `ConfidentialAccount.signerLeaf`, `ConfidentialAccount.signerPublicKey`
- **circuits reached** — *through imports, then through what those circuits themselves run* — `ConfidentialAccount.allVaults`, `ConfidentialAccount.assetKeyOf`, `ConfidentialAccount.changeCommitmentOf`, `ConfidentialAccount.noVault`, `ConfidentialAccount.proposalIdOf`, `ConfidentialAccount.removeSignerPayload`, `ConfidentialAccount.runPayload`, `ConfidentialAccount.setThresholdPayload`, `ConfidentialAccount.setVaultThresholdPayload`, `ConfidentialAccount.signerAddPayload`, `ConfidentialAccount.signerLeaf`, `ConfidentialAccount.signerPublicKey`

### `src/midnight/commitments.ts` — exported surface

| line | name | as written |
|---|---|---|
| 50 | `MAX_AMOUNT` | `export const MAX_AMOUNT = MAX_CHANGE_AMOUNT;` |
| 95 | `MidnightCommitments` | `export const MidnightCommitments: CommitmentScheme` |

### `src/midnight/commitments.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 54 | throw | [value] must be a bigint in the asset's smallest unit, got [value] |
| 56 | throw | [value] must not be negative, got [value] |
| 58 | throw | [value] of [value] does not fit in the contract's Uint<128>. The largest amount this contract can hold is [value]. |

### `src/midnight/commitments.ts` — where a width is fixed

*No width here matches the shapes above.* A width this module works to may
arrive in a variable, and this list sees only a number or a capitalised constant.

## `src/core/signer-leaf.ts`

Tier 1 of the declared set.

- **imports** — `src/core/crypto.ts`, `src/core/ledger.ts`
- **imported by** — `contracts/test/what-a-signer-is.test.ts`, `scripts/deploy-preview.ts`, `src/core/account.ts`, `src/core/signer-leaf.test.ts`, `src/web/App.tsx`, `src/web/accept-seat.test.ts`, `src/web/accept-seat.ts`
- **outside packages** — *none*
- **platform modules** — *none*
- **circuits named here** — *none*
- **circuits reached** — *through imports, then through what those circuits themselves run* — *none*

### `src/core/signer-leaf.ts` — exported surface

| line | name | as written |
|---|---|---|
| 97 | `LeafScheme` | `export type LeafScheme = Pick<CommitmentScheme, 'signerLeaf' \| 'signerPublicKey' \| 'allVaults'>;` |
| 112 | `DeviceLeafMaterial` | `export interface DeviceLeafMaterial` |
| 141 | `OwnLeafVerdict` | `export type OwnLeafVerdict` |
| 149 | `OwnLeafReading` | `export interface OwnLeafReading` |
| 181 | `storedSignerLeaf` | `export function storedSignerLeaf(` |
| 213 | `ownLeafReading` | `export function ownLeafReading(` |
| 268 | `requireOwnLeaf` | `export function requireOwnLeaf(reading: OwnLeafReading): void` |
| 358 | `SeatOnThisDevice` | `export interface SeatOnThisDevice` |
| 371 | `seatOnThisDevice` | `export function seatOnThisDevice(` |

### `src/core/signer-leaf.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 270 | throw | THE KEY MATERIAL THIS DEVICE HOLDS FOR THIS SEAT IS NOT A SIGNING SECRET AND A BLINDING.nThis is NOT the case of no keys being saved for this company — there is an entry here for this seat — and it is not a mismatch either, because nothing can be derived from what is here to mismatch with.n [value]nWHAT IT MEANS. A leaf is computed from the signing secret and the blinding, and the blinding is as precious as the key: without it this device cannot reproduce its own leaf and cannot prove membership on the contract, holding a valid signing key (decision 0003). Carrying on would show an active seat whose every approval fails inside a proof.nWHAT RESOLVES IT. Enrolling this device again from a machine that has the whole entry, or restoring it from a backup of the key bundle. If no machine has it, the seat has to be replaced by an approved round from another signerx27s device.nNOTHING WAS PROVED, NOTHING WAS SUBMITTED AND NOTHING WAS WRITTEN. |
| 291 | throw | THIS DEVICE COMPUTES A DIFFERENT LEAF THAN THE ONE RECORDED FOR THIS SEAT.nThis is NOT the case of no keys being saved for this company and it is NOT x27this seat has no leafx27. There is key material here, there is a leaf on the record, and they are two different values. The three have different remedies, which is why they are three sentences.n [value]n the accountx27s roster records [value]n this device computes [value]nWHAT IT MEANS. Seating publishes the RECORDED value into the on-chain signer tree, and the circuits that gate acting recompute the leaf from this devicex27s own witnesses. Those two are the values above. A proof built here would look for a path to the second while the tree holds the first, so every approval from this device would be refused inside the proof — and the seat would still count towards the threshold. On an M of N account, enough seats like this one and nobody can move the money.nWHAT RESOLVES IT, AND THERE IS NO DOOR THAT REPAIRS A RECORDED LEAF IN PLACE. If this devicex27s original blinding still exists somewhere, restoring the key bundle from a machine or a backup that has it resolves it and nothing else needs to happen. Otherwise the seat is replaced: another signer, on a device this is not happening on, proposes and the account approves a new leaf computed here. IF EVERY DEVICE ON THIS ACCOUNT REPORTS THIS, neither remedy applies — the derivation itself has moved, which is a defect in the software and not something any door on this account can undo.nNOTHING WAS PROVED, NOTHING WAS SUBMITTED AND NOTHING WAS WRITTEN. |

### `src/core/signer-leaf.ts` — where a width is fixed

| line | site | what fixes it |
|---|---|---|
| 159 | `.slice(0, 16)` | a fixed-width slice |

## `src/core/crypto.ts`

Tier 1 of the declared set.

- **imports** — *nothing in these trees*
- **imported by** — `contracts/test/a-leg-is-raised-again-as-itself.test.ts`, `contracts/test/a-payroll-the-vault-cannot-pay-is-not-raised.test.ts`, `contracts/test/a-retry-lives-on-the-leg-it-retries.test.ts`, `contracts/test/a-run-carries-its-own-material.test.ts`, `contracts/test/approvals.test.ts`, `contracts/test/commitments.test.ts`, `contracts/test/one-definition.test.ts`, `contracts/test/payout-runs.test.ts`, `contracts/test/run-keys.test.ts`, `contracts/test/run-status.test.ts`, `contracts/test/the-payroll-run-meets-the-chain.test.ts`, `contracts/test/the-service-layer-meets-the-chain.test.ts`, `contracts/test/transcript.test.ts`, `contracts/test/vault-client.test.ts`, `contracts/test/vault-payout.test.ts`, `contracts/test/vault-recovery.test.ts`, `contracts/test/vault-registry.test.ts`, `contracts/test/vault-scoping.test.ts`, `contracts/test/vault-split.test.ts`, `contracts/test/vault-threshold-recovery.test.ts`, `contracts/test/vault-unshielded.test.ts`, `contracts/test/what-a-signer-is.test.ts`, `scripts/deploy-preview.ts`, `scripts/deposit-to-vault.ts`, `scripts/fund-vault.ts`, `scripts/measure-call-cost.ts`, `scripts/preview-signers.test.ts`, `scripts/preview-signers.ts`, `scripts/transfer-from-vault.test.ts`, `scripts/transfer-from-vault.ts`, `scripts/vault-pool-file.test.ts`, `src/core/a-payroll-run-is-always-private.test.ts`, `src/core/a-run-is-not-a-governance-round.test.ts`, `src/core/a-vault-must-hold-what-a-round-pays.test.ts`, `src/core/a-vault-s-own-threshold.test.ts`, `src/core/account.ts`, `src/core/challenges.ts`, `src/core/core.test.ts`, `src/core/create-company.test.ts`, `src/core/crypto.test.ts`, `src/core/demo.ts`, `src/core/identity.ts`, `src/core/invite-handover.ts`, `src/core/jobs.ts`, `src/core/ledger-token.test.ts`, `src/core/ledger.ts`, `src/core/one-pending-employee-does-not-refuse-the-run.test.ts`, `src/core/payroll.ts`, `src/core/payslip-key-derive.ts`, `src/core/payslip-key.test.ts`, `src/core/payslip-key.ts`, `src/core/plugins.ts`, `src/core/principal.test.ts`, `src/core/principal.ts`, `src/core/sealed-records.test.ts`, `src/core/sealed-records.ts`, `src/core/sessions.ts`, `src/core/signer-leaf.ts`, `src/core/store-file.test.ts`, `src/core/store-file.ts`, `src/core/store.ts`, `src/core/the-threshold-is-the-chain-s.test.ts`, `src/core/types.ts`, `src/core/wallet-identity.ts`, `src/core/wallet-unlock.test.ts`, `src/core/which-seat-is-yours.test.ts`, `src/midnight/commitments.ts`, `src/midnight/job-runner.test.ts`, `src/midnight/job-runner.ts`, `src/midnight/ledger.test.ts`, `src/midnight/ledger.ts`, `src/midnight/note-index.ts`, `src/midnight/payee-address.ts`, `src/midnight/payout-tree.ts`, `src/midnight/private-state-addressing.test.ts`, `src/midnight/run-keys.ts`, `src/midnight/run-material.ts`, `src/midnight/run-skips.ts`, `src/midnight/run-status.ts`, `src/midnight/sealed-store.test.ts`, `src/midnight/sealed-store.ts`, `src/midnight/vault-coins.test.ts`, `src/midnight/vault-coins.ts`, `src/midnight/vault-holdings.test.ts`, `src/midnight/vault-holdings.ts`, `src/midnight/vault-ledger.test.ts`, `src/midnight/vault-ledger.ts`, `src/midnight/vault-notes.test.ts`, `src/midnight/vault-notes.ts`, `src/midnight/vault-pool.test.ts`, `src/midnight/vault-pool.ts`, `src/midnight/vault-recovery.ts`, `src/server/approval-signature.test.ts`, `src/server/index.ts`, `src/server/invitations.test.ts`, `src/server/self-payee.test.ts`, `src/standalone/main.tsx`, `src/testing/payees.ts`, `src/web/App.tsx`, `src/web/Join.tsx`, `src/web/accept-seat.test.ts`, `src/web/accept-seat.ts`, `src/web/accepted-address.ts`, `src/web/after-a-company-is-unlocked.test.tsx`, `src/web/connector-wallet.ts`, `src/web/keyring.ts`, `src/web/seat-repair.test.ts`, `src/web/seat-repair.ts`, `src/web/wallet-unlock.ts`, `src/wiring/a-chain-selection-needs-marked-records.test.ts`, `src/wiring/chain.ts`
- **outside packages** — `@noble/ciphers`, `@noble/curves`, `@noble/hashes`
- **platform modules** — *none*
- **circuits named here** — *none*
- **circuits reached** — *through imports, then through what those circuits themselves run* — *none*

### `src/core/crypto.ts` — exported surface

| line | name | as written |
|---|---|---|
| 16 | `Hex` | `export type Hex = string;` |
| 18 | `toHex` | `export const toHex = (b: Uint8Array): Hex => bytesToHex(b);` |
| 19 | `fromHex` | `export const fromHex = (h: Hex): Uint8Array => hexToBytes(h);` |
| 20 | `utf8` | `export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);` |
| 23 | `SigningKeypair` | `export interface SigningKeypair { secret: Hex; publicKey: Hex; }` |
| 24 | `WrappingKeypair` | `export interface WrappingKeypair { secret: Hex; publicKey: Hex; }` |
| 26 | `newSigningKeypair` | `export function newSigningKeypair(): SigningKeypair` |
| 31 | `newWrappingKeypair` | `export function newWrappingKeypair(): WrappingKeypair` |
| 56 | `proofKeypairFor` | `export function proofKeypairFor(symmetricKey: Hex): SigningKeypair` |
| 76 | `signingPublicKeyOf` | `export function signingPublicKeyOf(secret: Hex): Hex` |
| 80 | `sign` | `export function sign(message: string, secret: Hex): Hex` |
| 84 | `verify` | `export function verify(message: string, signature: Hex, publicKey: Hex): boolean` |
| 93 | `commit` | `export function commit(plaintext: string, nonce: Hex): Hex` |
| 98 | `newSymmetricKey` | `export const newSymmetricKey = (): Hex => toHex(randomBytes(32));` |
| 158 | `PROPOSAL_SALT_BYTES` | `export const PROPOSAL_SALT_BYTES = 32;` |
| 160 | `newProposalSalt` | `export const newProposalSalt = (): Hex =>` |
| 214 | `BLINDING_BYTES` | `export const BLINDING_BYTES = 32;` |
| 216 | `newBlinding` | `export const newBlinding = (): Hex =>` |
| 235 | `Sealed` | `export interface Sealed { iv: Hex; tag: Hex; body: Hex; }` |
| 237 | `seal` | `export function seal(plaintext: string, key: Hex): Sealed` |
| 243 | `unseal` | `export function unseal(sealed: Sealed, key: Hex): string` |
| 257 | `wrapKey` | `export function wrapKey(plaintext: string, recipientPublicKey: Hex): { ephemeral: Hex } & Sealed` |
| 264 | `unwrapKey` | `export function unwrapKey(wrapped: { ephemeral: Hex } & Sealed, recipientSecret: Hex): string` |
| 291 | `canonical` | `export function canonical(value: unknown): string` |
| 349 | `bigintJsonReplacer` | `export const bigintJsonReplacer = (_key: string, value: unknown): unknown =>` |
| 353 | `reviveBigints` | `export function reviveBigints(value: unknown): unknown` |
| 372 | `parseCanonical` | `export const parseCanonical = <T>(json: string): T => reviveBigints(JSON.parse(json)) as T;` |
| 374 | `randomBytes` | `export { randomBytes }` |

### `src/core/crypto.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 163 | throw | a proposal salt is [value] bytes and this one is [value]. It is the third argument of proposalIdOf and the fourth of changeCommitmentOf, both Bytes<32>, which refuse any other length — so a salt of this width is a governance round and a payroll run that cannot be raised at all. C371. |
| 219 | throw | a blinding is [value] bytes and this one is [value]: the platform's random source returned short, and no account may be created, no key rotated and no payout run until it stops doing so. This value does three jobs — the account's payout seed, written when the account is created and again at every key rotation; the account's asset blinding; and a signer blinding. THE PAYOUT SEED IS THE SILENT ONE: `runKeyOf` expands the seed with HKDF, which accepts a seed of any width and returns a well-formed 32 bytes from all of them, so a short seed weakens every per-payee nonce in every payout run while nothing on chain and nothing downstream can see that it happened. |

### `src/core/crypto.ts` — where a width is fixed

| line | site | what fixes it |
|---|---|---|
| 98 | `randomBytes(32)` | a fixed-width random draw |
| 158 | `export const PROPOSAL_SALT_BYTES = 32` | a declared byte-width constant |
| 162 | `.length !== PROPOSAL_SALT_BYTES` | a width compared against a named constant |
| 214 | `export const BLINDING_BYTES = 32` | a declared byte-width constant |
| 218 | `.length !== BLINDING_BYTES` | a width compared against a named constant |
| 238 | `randomBytes(12)` | a fixed-width random draw |
| 333 | `.length === 1` | a width compared |

## `src/midnight/payee-address.ts`

Tier 1 of the declared set.

- **imports** — `src/core/crypto.ts`, `src/midnight/network.ts`
- **imported by** — `contracts/test/vault-client.test.ts`, `contracts/test/vault-payout.test.ts`, `scripts/transfer-from-vault.test.ts`, `scripts/transfer-from-vault.ts`, `src/core/a-payroll-run-is-always-private.test.ts`, `src/core/core.test.ts`, `src/core/movement.ts`, `src/core/one-pending-employee-does-not-refuse-the-run.test.ts`, `src/core/payroll.ts`, `src/core/payslip-key.test.ts`, `src/core/principal.ts`, `src/core/types.ts`, `src/core/wallet-payee.ts`, `src/midnight/payee-address.test.ts`, `src/midnight/payout-tree.ts`, `src/midnight/vault-holdings.ts`, `src/midnight/vault-ledger.ts`, `src/server/index.ts`, `src/testing/payees.ts`
- **outside packages** — `@midnightntwrk/wallet-sdk-address-format`
- **platform modules** — *none*
- **circuits named here** — *none*
- **circuits reached** — *through imports, then through what those circuits themselves run* — *none*

### `src/midnight/payee-address.ts` — exported surface

| line | name | as written |
|---|---|---|
| 60 | `PayeeAddress` | `export interface PayeeAddress` |
| 175 | `payeeAddress` | `export function payeeAddress(bech32: string, network: NetworkName): PayeeAddress` |
| 232 | `payeeAddressFromKeys` | `export function payeeAddressFromKeys(` |
| 288 | `UnshieldedPayeeAddress` | `export interface UnshieldedPayeeAddress` |
| 314 | `Payee` | `export type Payee = PayeeAddress \| UnshieldedPayeeAddress;` |
| 317 | `PayeeKind` | `export type PayeeKind = Payee['kind'];` |
| 328 | `recipientOf` | `export const recipientOf = (p: Payee): Hex =>` |
| 342 | `unshieldedPayeeAddress` | `export function unshieldedPayeeAddress(` |
| 401 | `unshieldedPayeeAddressFromKeys` | `export function unshieldedPayeeAddressFromKeys(` |
| 430 | `payeeOf` | `export function payeeOf(bech32: string, network: NetworkName): Payee` |
| 464 | `samePayee` | `export const samePayee = (a: Payee, b: Payee): boolean => a.bech32 === b.bech32;` |
| 473 | `shortPayee` | `export const shortPayee = (a: Payee): string =>` |

### `src/midnight/payee-address.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 158 | throw | the [value] must be 32 bytes of lowercase hex; got [value] |
| 177 | throw | a payee address is required, and this one is empty |
| 188 | throw | "[value]" is not a Midnight address: [value]. A payee address looks like mn_shield-addr_<network>1... and carries its own checksum. |
| 197 | throw | "[value]" is not a payee address for [value]: [value]. It must be a shield-addr — a coin public key on its own is not enough to pay somebody, because it does not say who may READ the payment. |
| 346 | throw | a payee address is required, and this one is empty |
| 352 | throw | "[value]" is not a Midnight address: [value]. A public payee address looks like mn_addr_<network>1... and carries its own checksum. |
| 373 | throw | "[value]" is not a public payee address for [value]: [value]. A public payee address starts with mn_addr_ and is for one network only. An mn_shield-addr_ is a private payee and cannot be paid this way. The money would go to an address nobody holds the key for, and nothing can bring it back. |
| 406 | throw | the user address must be 32 bytes of lowercase hex; got "[value]"nothing |
| 432 | throw | a payee address is required, and this one is empty |
| 438 | throw | "[value]" is not a Midnight address: [value]. A payee address looks like mn_shield-addr_<network>1... (private) or mn_addr_<network>1... (public), and carries its own checksum. |
| 457 | throw | "[value]" is a Midnight [value] address, and it is not a payee. A payee address starts with mn_shield-addr_ for a private payment, or mn_addr_ for a public one. Nothing else can receive money. |

### `src/midnight/payee-address.ts` — where a width is fixed

| line | site | what fixes it |
|---|---|---|
| 474 | `.slice(0, 18)` | a fixed-width slice |

## `src/core/payslip-key.ts`

Tier 1 of the declared set.

- **imports** — `src/core/crypto.ts`, `src/core/payslip-key-derive.ts`, `src/core/wallet-unlock.ts`
- **imported by** — `src/core/founder-payslip.test.ts`, `src/core/payroll.ts`, `src/core/payslip-key.test.ts`
- **outside packages** — `midnight-identity`
- **platform modules** — *none*
- **circuits named here** — *none*
- **circuits reached** — *through imports, then through what those circuits themselves run* — *none*

### `src/core/payslip-key.ts` — exported surface

| line | name | as written |
|---|---|---|
| 17 | `payslipKeypairFrom` | `export { payslipKeypairFrom }` |
| 35 | `payslipKeypairForWallet` | `export function payslipKeypairForWallet(` |

### `src/core/payslip-key.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 56 | throw | built a [value], not an unlock |

### `src/core/payslip-key.ts` — where a width is fixed

*No width here matches the shapes above.* A width this module works to may
arrive in a variable, and this list sees only a number or a capitalised constant.

## `src/core/payslip-key-derive.ts`

Tier 1 of the declared set.

- **imports** — `src/core/crypto.ts`
- **imported by** — `src/core/payslip-key.ts`, `src/web/App.tsx`, `src/web/Join.tsx`
- **outside packages** — `@noble/curves`, `@noble/hashes`
- **platform modules** — *none*
- **circuits named here** — *none*
- **circuits reached** — *through imports, then through what those circuits themselves run* — *none*

### `src/core/payslip-key-derive.ts` — exported surface

| line | name | as written |
|---|---|---|
| 120 | `payslipKeypairFrom` | `export function payslipKeypairFrom(companyKey: Uint8Array): WrappingKeypair` |

### `src/core/payslip-key-derive.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 128 | throw | a payslip key is derived from the [value]-byte key the wallet releases for a company, and that was [value] bytes |

### `src/core/payslip-key-derive.ts` — where a width is fixed

| line | site | what fixes it |
|---|---|---|
| 106 | `new Uint8Array(0)` | a fixed-width buffer |
| 109 | `const KEY_BYTES = 32` | a declared byte-width constant |
| 121 | `.length !== KEY_BYTES` | a width compared against a named constant |

## `src/midnight/ledger.ts`

Tier 2 of the declared set.

- **imports** — `src/core/assets.ts`, `src/core/crypto.ts`, `src/core/ledger.ts`, `src/midnight/circuit-arity.ts`, `src/midnight/commitments.ts`, `src/midnight/deferral.ts`, `src/midnight/network.ts`, `src/midnight/partial-contract.ts`, `src/midnight/retry.ts`
- **imported by** — `scripts/deploy-preview.ts`, `scripts/run-preview.ts`, `scripts/sponsor-test.ts`, `src/midnight/ledger.test.ts`, `src/midnight/private-state-addressing.test.ts`, `src/midnight/providers.ts`, `src/midnight/sealed-store.ts`, `src/midnight/sponsor.ts`, `src/midnight/vault-ledger.ts`, `src/midnight/what-a-balance-books.test.ts`, `src/wiring/chain.ts`, `src/wiring/write-capability-for-deployment.ts`, `src/wiring/write-capability.ts`
- **outside packages** — *none*
- **platform modules** — *none*
- **circuits named here** — `ConfidentialAccount.amendSigner`, `ConfidentialAccount.approve`, `ConfidentialAccount.cancel`, `ConfidentialAccount.changeCommitmentOf`, `ConfidentialAccount.closeExpiredRun`, `ConfidentialAccount.paidMovementOf`, `ConfidentialAccount.propose`, `ConfidentialAccount.setThreshold`, `ConfidentialAccount.setVaultThreshold`, `ConfidentialAccount.vacantSlot`
- **circuits reached** — *through imports, then through what those circuits themselves run* — `ConfidentialAccount.allVaults`, `ConfidentialAccount.amendSigner`, `ConfidentialAccount.approve`, `ConfidentialAccount.assetKeyOf`, `ConfidentialAccount.cancel`, `ConfidentialAccount.changeCommitmentOf`, `ConfidentialAccount.closeExpiredRun`, `ConfidentialAccount.noVault`, `ConfidentialAccount.paidMovementOf`, `ConfidentialAccount.proposalIdOf`, `ConfidentialAccount.propose`, `ConfidentialAccount.removeSignerPayload`, `ConfidentialAccount.runPayload`, `ConfidentialAccount.setThreshold`, `ConfidentialAccount.setThresholdPayload`, `ConfidentialAccount.setVaultThreshold`, `ConfidentialAccount.setVaultThresholdPayload`, `ConfidentialAccount.signerAddPayload`, `ConfidentialAccount.signerLeaf`, `ConfidentialAccount.signerPublicKey`, `ConfidentialAccount.slotOf`, `ConfidentialAccount.vacantSlot`

### `src/midnight/ledger.ts` — exported surface

| line | name | as written |
|---|---|---|
| 101 | `PreparedStep` | `export type PreparedStep` |
| 148 | `PreparedCall` | `export interface PreparedCall` |
| 156 | `MidnightConfig` | `export interface MidnightConfig` |
| 194 | `FeeSponsor` | `export interface FeeSponsor` |
| 276 | `SealedStateStore` | `export interface SealedStateStore` |
| 304 | `privateStateKey` | `export const privateStateKey = (base: string, accountId: string): string =>` |
| 339 | `MidnightLedger` | `export class MidnightLedger implements Ledger` |
| 2166 | `UndecodedLedgerField` | `export class UndecodedLedgerField extends Error` |
| 2260 | `MidnightProofSystem` | `export class MidnightProofSystem implements ProofSystem` |
| 2437 | `AuthorityShape` | `export type AuthorityShape = 'anyone' \| 'no-one' \| 'one-key' \| 'committee';` |
| 2443 | `OnChainAuthority` | `export interface OnChainAuthority` |
| 2478 | `AuthorityRead` | `export type AuthorityRead` |
| 2500 | `authorityShapeOf` | `export function authorityShapeOf(` |
| 2520 | `authorityFromContractState` | `export function authorityFromContractState(` |
| 2552 | `ContractStateReader` | `export type ContractStateReader = (address: string) => Promise<unknown>;` |
| 2561 | `readContractAuthority` | `export async function readContractAuthority(` |
| 2597 | `intendedAuthorityValue` | `export function intendedAuthorityValue(` |
| 2651 | `AuthorityVerdict` | `export type AuthorityVerdict = 'agree' \| 'disagree' \| 'unknown';` |
| 2653 | `AuthorityComparison` | `export interface AuthorityComparison` |
| 2688 | `compareAuthority` | `export function compareAuthority(` |
| 2873 | `MaintenanceRefusal` | `export interface MaintenanceRefusal` |
| 2913 | `verifierKeyRefusals` | `export function verifierKeyRefusals(` |
| 2973 | `authorityValueRefusals` | `export function authorityValueRefusals(` |
| 3075 | `requireBuildableAuthority` | `export function requireBuildableAuthority(` |
| 3098 | `MaintenancePlan` | `export type MaintenancePlan` |
| 3135 | `planAuthorityReplacement` | `export function planAuthorityReplacement(` |
| 3225 | `MaintenanceEndStateRecord` | `export interface MaintenanceEndStateRecord` |
| 3262 | `EndStateVerdict` | `export type EndStateVerdict = 'settled' \| 'not-yet' \| 'unexplained' \| 'unknown';` |
| 3264 | `EndStateCheck` | `export interface EndStateCheck` |
| 3279 | `checkEndState` | `export function checkEndState(` |
| 3320 | `MaintenanceSignature` | `export type MaintenanceSignature = AuthorityKey;` |
| 3335 | `MaintenanceUpdateLike` | `export interface MaintenanceUpdateLike` |
| 3342 | `MaintenancePrimitives` | `export interface MaintenancePrimitives` |
| 3358 | `VerifierKeyWrite` | `export interface VerifierKeyWrite` |
| 3385 | `BuiltMaintenanceInstruction` | `export interface BuiltMaintenanceInstruction` |
| 3459 | `buildMaintenanceInstruction` | `export function buildMaintenanceInstruction(` |
| 3558 | `attachMaintenanceSignature` | `export function attachMaintenanceSignature(` |
| 3592 | `signatureProgress` | `export function signatureProgress(` |
| 3645 | `OnChainOperation` | `export interface OnChainOperation` |
| 3652 | `OperationsRead` | `export type OperationsRead` |
| 3663 | `operationsFromContractState` | `export function operationsFromContractState(` |
| 3713 | `VerifierKeyVerdict` | `export type VerifierKeyVerdict = 'agree' \| 'disagree' \| 'unknown';` |
| 3715 | `VerifierKeyComparison` | `export interface VerifierKeyComparison` |
| 3756 | `compareVerifierKeys` | `export function compareVerifierKeys(` |

### `src/midnight/ledger.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 429 | throw | cannot open "[value]": this MidnightLedger was built without deployment credentials. Deploying needs a maintenance authority and somewhere to record the address the chain assigns, and a client that only calls an existing account has no business holding either. |
| 466 | throw | cannot open "[value]": the opening names no founding signer. The account's first seat is the leaf handed to the constructor, and an account deployed without one can never have a signer added — `amendSigner` requires an existing signer, so there would be nobody able to seat the first. |
| 494 | throw | cannot open "[value]": the opening names [value] founding signers and this path can seat exactly one. The constructor creates the founder's seat; every seat after it is `amendSigner`, which requires an existing signer to call it AND, since the constructor stopped taking a threshold, an approved proposal behind it — so the rest are proposed, approved and seated by the founder from their own device, and there is no screen for that yet. Open with the founding signer alone. |
| 549 | throw | cannot open "[value]": a threshold of [value] is not a rule. It is refused here because it would enter our own record of the account as its policy. The chain never sees it: since `C340` the constructor takes no threshold and founds every account at one, raised afterwards through the ordinary approval path. |
| 828 | throw | movementsset |
| 895 | throw | propose succeeded but the account state could not be read back, so it is unknown whether the proposal is open. Approvals gathered against it may be unusable.n looked for id: [value]n state read back: none |
| 903 | throw | propose succeeded but the chain has no open proposal with this id. Approvals gathered against it would be unusable.n looked for id: [value]n ids on chain ([value]): none, |
| 914 | throw | propose succeeded but the chain recorded a different change than the one supplied.n on chain: [value]n supplied: [value]nEvery approval gathered against this proposal would be unusable. |
| 957 | throw | a payroll run must name the vault that will pay it: the vault is folded into the proposal id and recordPayment recomputes the id from the vault it is handed, so a run raised at the no-vault sentinel is one no vault can ever present. |
| 973 | throw | proposeRun succeeded but the chain has no open proposal with this run's id. Approvals gathered against it would be unusable, and no payment could ever match it. |
| 980 | throw | proposeRun succeeded but the chain recorded a different change than the one supplied.n on chain: [value]n supplied: [value]nEvery approval gathered against this run would be unusable. |
| 1235 | throw | a governance round cannot name a vault |
| 1264 | throw | a payroll run needs at least one payee |
| 1267 | throw | this run's window closes at [value] and opens at [value], so no payment could ever fall inside it |
| 1279 | throw | [value] is not a time in seconds — that is the year [value]. Block time is seconds since the Unix epoch, not milliseconds. |
| 1332 | throw | the contract has no state on chain |
| 1342 | throw | adding a signer to a live account needs an approved proposal. Propose the signer, reach the threshold, then add them. M-37. |
| 1382 | throw | the contract has no state on chain |
| 1395 | throw | the threshold must be at least one, and a whole number |
| 1403 | throw | the threshold cannot exceed the [value] signers on this account, or one signer could seat their own. |
| 1451 | throw | a vault threshold of zero would authorise anything |
| 1463 | throw | the contract has no state on chain |
| 1466 | throw | that would leave [value] signers against a threshold of [value], and the account could never approve anything again. |
| 1534 | throw | [value] is thirty-two zero bytes. Supply a signer leaf that is neither thirty-two zero bytes nor the vacancy marker. The contract refuses this value — it answers "that is not a usable signer leaf", in its constructor for a founding leaf and in `amendSigner` for a leaf being seated — because thirty-two zero bytes is what an empty slot reads as, so a seat holding it is a seat nothing can ever prove. |
| 1543 | throw | [value] is the vacancy marker itself. Supply a signer leaf that is neither thirty-two zero bytes nor the vacancy marker. The contract refuses this value — it answers "that is not a usable signer leaf", in its constructor for a founding leaf and in `amendSigner` for a leaf being seated — because the tree uses the marker to mean THIS SLOT IS EMPTY, so seating it makes a slot that is simultaneously taken and free. |
| 1575 | throw | the contract has no state on chain |
| 1578 | throw | cannot [value]: there is no open proposal [value] on this account. It has either settled, been cancelled, or was never raised here. |
| 1597 | throw | cannot [value]: that proposal has [value] of [value] approvals. The contract would reject it. |
| 1631 | throw | account not found on this ledger |
| 1633 | throw | account not found on this ledger |
| 1637 | throw | the state for "[value]" is already sealed at key epoch [value]. Re-sealing over an existing epoch would destroy the only copy under that key. |
| 1656 | throw | committed state could not be retrieved for "[value]" at key epoch [value]. Either the blob is missing (M-73), or the account record and the state store disagree about which viewing key is current, which is what a half-finished rotation looks like (K-4). |
| 1692 | throw | account "[value]" is not deployed on Midnight |
| 1765 | throw | no asset blinding in the private state for "[value]" on this device. It is written when the account is opened and every signer needs the same one — without it this device cannot derive the account's asset key, and so cannot compute or check the change commitment a proposal carries. |
| 1909 | throw | the deployed contract has no circuit "[value]" |
| 2231 | throw | set |
| 2265 | throw | no Compact circuit for "[value]" yet |
| 2266 | throw | not implemented: requires the proof server at |
| 2270 | throw | not implemented: verification happens on chain |
| 2617 | throw | a maintenance authority at threshold [value] is not a committee. Set the threshold to at least one and no more than the number of keys in the committee. A threshold ABOVE the committee size is the unmaintainable state — say { kind: "unmaintainable" } deliberately if that is the intent, rather than reaching it by arithmetic. A threshold BELOW one is WORLD-WRITABLE, not unmaintainable: MEASURED on `@midnightntwrk/ledger-v9@1.0.0-rc.3`, a maintenance update carrying NO SIGNATURES AT ALL is well-formed against an authority at threshold zero, so anybody at all could replace this contract's verifier keys while holding nothing. Committee membership IS still checked — a signature at an out-of-range seat is refused, and so is a wrong signature at a valid seat — what is missing is any requirement to attach one. This refuses rather than comparing the value against the chain. |
| 3082 | throw | this maintenance authority will not be built:n - [[value]] [value]n |
| 3471 | throw | this plan carries no on-chain authority, so there is nothing to say who must sign the update it describes. A `build` plan always carries one; a plan that does not is a defect in this module rather than a fact about the contract, and building anyway would produce an instruction nobody can be told how to sign. |
| 3485 | throw | these verifier-key writes will not be built:n - [[value]] [value]n |
| 3565 | throw | seat [value] is not a seat on the committee that currently maintains [value]: it holds [value] seat(s), numbered 0 to [value]. The signatures on a maintenance update are checked against the CURRENT committee, not the one being installed. |
| 3573 | throw | seat [value] has already signed this update. A second signature at the same index is refused by the chain as a malformed transaction, and attaching it here would waste a submission rather than add a vote. |
| 3581 | throw | this signature does not verify against the key in seat [value] of [value]'s current committee. Either it was made by a different key, or it was made over different data — a signature is bound to (contract address, exact update list, counter), so one collected for another contract, or before the counter moved, is dead. |

### `src/midnight/ledger.ts` — where a width is fixed

| line | site | what fixes it |
|---|---|---|
| 590 | `randomBytes(32)` | a fixed-width random draw |
| 1579 | `.slice(0, 12)` | a fixed-width slice |
| 2508 | `.length === 1` | a width compared |
| 3522 | `.slice(0, 8)` | a fixed-width slice |
| 3768 | `.slice(0, 8)` | a fixed-width slice |

## `src/midnight/vault-ledger.ts`

Tier 2 of the declared set.

- **imports** — `src/core/crypto.ts`, `src/core/ledger.ts`, `src/midnight/circuit-arity.ts`, `src/midnight/ledger.ts`, `src/midnight/note-index.ts`, `src/midnight/payee-address.ts`, `src/midnight/vault-coins.ts`, `src/midnight/vault-contract.ts`, `src/midnight/vault-notes.ts`, `src/midnight/vault-recovery.ts`
- **imported by** — `scripts/deposit-to-vault.ts`, `scripts/fund-vault.ts`, `scripts/open-vault-pool.ts`, `src/midnight/note-index.test.ts`, `src/midnight/note-index.ts`, `src/midnight/vault-call-convention.test.ts`, `src/midnight/vault-holdings.test.ts`, `src/midnight/vault-holdings.ts`, `src/midnight/vault-ledger.test.ts`, `src/midnight/vault-pool.ts`, `src/midnight/vault-witness-binding.test.ts`
- **outside packages** — `@midnight-ntwrk/compact-js`, `@midnight-ntwrk/midnight-js-contracts`
- **platform modules** — *none*
- **circuits named here** — `Vault.deposit`, `Vault.depositUnshielded`, `Vault.payout`, `Vault.payoutUnshielded`
- **circuits reached** — *through imports, then through what those circuits themselves run* — `ConfidentialAccount.allVaults`, `ConfidentialAccount.amendSigner`, `ConfidentialAccount.approve`, `ConfidentialAccount.assetKeyOf`, `ConfidentialAccount.cancel`, `ConfidentialAccount.changeCommitmentOf`, `ConfidentialAccount.closeExpiredRun`, `ConfidentialAccount.noVault`, `ConfidentialAccount.paidMovementOf`, `ConfidentialAccount.payoutLeaf`, `ConfidentialAccount.proposalIdOf`, `ConfidentialAccount.propose`, `ConfidentialAccount.recordPayment`, `ConfidentialAccount.removeSignerPayload`, `ConfidentialAccount.runPayload`, `ConfidentialAccount.setThreshold`, `ConfidentialAccount.setThresholdPayload`, `ConfidentialAccount.setVaultThreshold`, `ConfidentialAccount.setVaultThresholdPayload`, `ConfidentialAccount.signerAddPayload`, `ConfidentialAccount.signerLeaf`, `ConfidentialAccount.signerPublicKey`, `ConfidentialAccount.slotOf`, `ConfidentialAccount.vacantSlot`, `Vault.deposit`, `Vault.depositUnshielded`, `Vault.heldCommitmentOf`, `Vault.noteBlindingOf`, `Vault.payout`, `Vault.payoutDetails`, `Vault.payoutUnshielded`, `Vault.unshieldedPayoutDetails`

### `src/midnight/vault-ledger.ts` — exported surface

| line | name | as written |
|---|---|---|
| 46 | `VaultPayment` | `export interface VaultPayment` |
| 107 | `VaultPaid` | `export type VaultPaid` |
| 128 | `NotePool` | `export interface NotePool` |
| 157 | `CallPlan` | `export interface CallPlan` |
| 179 | `planCall` | `export const planCall = (` |
| 225 | `VaultChainUnreadable` | `export class VaultChainUnreadable extends Error` |
| 268 | `VaultPoolDisagreesWithChain` | `export class VaultPoolDisagreesWithChain extends Error` |
| 291 | `VaultCannotAfford` | `export class VaultCannotAfford extends Error` |
| 332 | `VaultAlreadyHoldsNotes` | `export class VaultAlreadyHoldsNotes extends Error` |
| 346 | `VaultLedger` | `export class VaultLedger` |
| 1572 | `toNote` | `export const toNote = (` |
| 1576 | `toHex` | `export { toHex }` |

### `src/midnight/vault-ledger.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 473 | throw | the vault's note [value] changed or left the pool while its place in the chainx27s commitment tree was being read. Nothing is proved or paid. Pay again, and the note will be chosen and read afresh. |
| 566 | throw | the deployed vault has no circuit "[value]" |
| 759 | throw | a run with no payments is not a run |
| 786 | throw | chain-unreadablethe chain could not be read, so nothing has confirmed what this vault holds. THIS IS NOT THE CHAIN SAYING NO and it is still not a reason to pay: an unconfirmed balance is one a run would be sized against |
| 794 | throw | pool-disagreesthe pool and the chain disagree, so this vault has no balance. [value] |
| 806 | throw | notes-do-not-cover |
| 823 | throw | chain-unreadablethe chain could not be read, so nothing has confirmed what this vault holds in public money. THIS IS NOT THE CHAIN SAYING NO, and it is still not a reason to start paying people |
| 840 | throw | public-balance-shortthis run pays [value] of a public token the chain says this vault holds [value] of. A public balance is one number the ledger subtracts from, so the payees before the shortfall settle and the ones after do not |
| 885 | throw | a note of nothing is not a deposit |
| 987 | throw | a deposit of nothing is not a deposit. It moves no money and would seat a colour in this vault's unshielded token set, which retire then refuses to pass — a way to jam a vault's retirement for free, by anybody, since a deposit needs no approval. |
| 1064 | throw | this payee's address is for [value] and this vault is on [value]. The [value] would be accepted either way, so nothing further down would notice. |
| 1141 | throw | a private payment spends a note, and a note is spent by its place in the chainx27s commitment tree, which is read from the chain just before the payment. No source of the chainx27s events was given, so nothing is proved or paid. Pass the indexerx27s events to payout and pay again. |
| 1176 | throw | the vault paid without asking for a note. The pool cannot be advanced safely; rebuild it from the chain with replayVault before paying again. |
| 1367 | throw | this provider bundle has no queryUnshieldedBalances, so nothing here can say what the chain published for this contractpublic-balance |
| 1378 | throw | the read itself failed: [value]public-balance |
| 1384 | throw | the indexer has no contract action for this address, so it has not published a balance for it yet. That is not a vault holding nothingpublic-balance |
| 1391 | throw | the indexer answered with [value] rather than a list of balances. A shape this client cannot read is our ignorance, not an empty treasurypublic-balance |
| 1409 | throw | one of the indexer's balance rows is not { tokenType: string, balance: bigint }. Skipping it would understate a treasury, so nothing is returnedpublic-balance |
| 1463 | throw | [value] of [value] note(s) in this pool are NOT in the vault's on-chain set, worth [value] between them. The pool claims MORE than the chain will honour, and every one of those notes would be refused at payment time. Unknown to the chain: [value] |
| 1479 | throw | the chain holds [value] note(s) and this pool holds [value]. Every note the pool knows about IS on chain, so the pool claims LESS than the vault holds — a note reached the vault and was never recorded, which is what a crash between a call and the pool write leaves behind. The amount cannot be stated from here, because a commitment discloses nothing. Rebuild the pool from the chain with replayVault. |
| 1502 | throw | the read itself failed: [value] |
| 1512 | throw | the indexer returned no state for this address |
| 1521 | throw | the state did not decode: [value] |
| 1534 | throw | the decoded state has no readable "notes" set. That is not an empty vault — an empty set is a true statement about the vault and a missing one is our ignorance |

### `src/midnight/vault-ledger.ts` — where a width is fixed

*No width here matches the shapes above.* A width this module works to may
arrive in a variable, and this list sees only a number or a capitalised constant.

## `src/midnight/vault-notes.ts`

Tier 2 of the declared set.

- **imports** — `src/core/crypto.ts`, `src/midnight/note-index.ts`, `src/midnight/vault-coins.ts`
- **imported by** — `contracts/test/vault-client.test.ts`, `contracts/test/vault-recovery.test.ts`, `scripts/measure-call-cost.ts`, `src/midnight/note-index.test.ts`, `src/midnight/note-index.ts`, `src/midnight/vault-holdings.test.ts`, `src/midnight/vault-ledger.test.ts`, `src/midnight/vault-ledger.ts`, `src/midnight/vault-notes.test.ts`, `src/midnight/vault-pool.test.ts`, `src/midnight/vault-pool.ts`
- **outside packages** — *none*
- **platform modules** — *none*
- **circuits named here** — *none*
- **circuits reached** — *through imports, then through what those circuits themselves run* — `ConfidentialAccount.allVaults`, `ConfidentialAccount.amendSigner`, `ConfidentialAccount.approve`, `ConfidentialAccount.assetKeyOf`, `ConfidentialAccount.cancel`, `ConfidentialAccount.changeCommitmentOf`, `ConfidentialAccount.closeExpiredRun`, `ConfidentialAccount.noVault`, `ConfidentialAccount.paidMovementOf`, `ConfidentialAccount.payoutLeaf`, `ConfidentialAccount.proposalIdOf`, `ConfidentialAccount.propose`, `ConfidentialAccount.recordPayment`, `ConfidentialAccount.removeSignerPayload`, `ConfidentialAccount.runPayload`, `ConfidentialAccount.setThreshold`, `ConfidentialAccount.setThresholdPayload`, `ConfidentialAccount.setVaultThreshold`, `ConfidentialAccount.setVaultThresholdPayload`, `ConfidentialAccount.signerAddPayload`, `ConfidentialAccount.signerLeaf`, `ConfidentialAccount.signerPublicKey`, `ConfidentialAccount.slotOf`, `ConfidentialAccount.vacantSlot`, `Vault.deposit`, `Vault.depositUnshielded`, `Vault.heldCommitmentOf`, `Vault.noteBlindingOf`, `Vault.payout`, `Vault.payoutDetails`, `Vault.payoutUnshielded`, `Vault.unshieldedPayoutDetails`

### `src/midnight/vault-notes.ts` — exported surface

| line | name | as written |
|---|---|---|
| 55 | `Note` | `export interface Note` |
| 152 | `VaultNotes` | `export interface VaultNotes` |
| 174 | `noteToSpend` | `export const noteToSpend = (notes: Note[], token: Hex, amount: bigint): Note =>` |
| 230 | `afterPayment` | `export const afterPayment = (` |
| 337 | `paymentsFit` | `export const paymentsFit = (` |
| 366 | `afterDeposit` | `export const afterDeposit = (state: VaultNotes, note: Note): VaultNotes =>` |
| 392 | `withIndexRead` | `export const withIndexRead = (state: VaultNotes, nonce: Hex, index: ChainReadIndex): VaultNotes =>` |
| 406 | `balanceOf` | `export const balanceOf = (state: VaultNotes, token: Hex): bigint =>` |
| 436 | `witnessesWithoutAPool` | `export const witnessesWithoutAPool = () => (` |
| 447 | `witnessesOver` | `export const witnessesOver = (get: () => VaultNotes, pending: { spending?: Hex }) => (` |

### `src/midnight/vault-notes.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 177 | throw | this vault holds no notes of [value] |
| 183 | throw | no single note covers [value]: the largest is [value] and the pool holds [value] across [value] notes. Merge them first — a payment cannot. |
| 250 | throw | this vault has no note [value] to spend; its pool and the chain disagree |
| 254 | throw | note [value] holds [value] and the payment is [value] |
| 267 | throw | note [value] was spent exactly and the contract emits no change for that, but the call's outputs carry a coin of [value] coming back to the vault. The pool cannot be advanced from two answers about the same money — rebuild it from the chain with replayVault. |
| 284 | throw | note [value] holds [value] and the payment is [value], so the vault kept [value] — but the call's outputs carry no coin coming back to it. Something is being read that is not this payout. The pool is NOT advanced: the change is on chain and a guess at its nonce is a note nobody can spend. |
| 291 | throw | the coin coming back to this vault is worth [value] and the arithmetic says [value] (note [value] of [value], paying [value]). These are two claims about the same money and there is no correct way to pick one. |
| 297 | throw | the coin coming back to this vault is of [value] and the note spent was of [value]. That is not this payout's change. |
| 347 | throw | payment [value] of [value] cannot be made out of this vault: [value] |
| 368 | throw | this vault already holds a note [value] |
| 370 | throw | a note of nothing is not a deposit |
| 377 | throw | note [value] arrives at a deposit already carrying an index. A deposit cannot know where the chain will file it, so that number was not read from the chain and is not recorded. Record the deposit without it; the index is read from the transaction later. |
| 395 | throw | this vault's pool has no note [value], so there is nothing to record an index against. The pool may have moved on since the note was chosen; choose again. |
| 438 | throw | this vault was asked which note to spend for [value] on a call that has no note pool. The unshielded circuits move a LEDGER BALANCE and read no witness, so either the contract has changed or this call was routed to the wrong circuit. Nothing is substituted: a note handed over here would be one this path never established the vault holds. |
| 470 | throw | the vault's note [value] is the one to spend for [value], and its position in the chainx27s commitment tree has not been read for this call. It cannot be spent until it is: the transaction would carry a merkle path for a different leaf. The note is safe, because an index is not part of a commitment. Its index is read from the events of the transaction that created it, which a private payment does before it calls. NOTHING HERE MAY SUBSTITUTE A NUMBER. |

### `src/midnight/vault-notes.ts` — where a width is fixed

*No width here matches the shapes above.* A width this module works to may
arrive in a variable, and this list sees only a number or a capitalised constant.

## `src/midnight/vault-coins.ts`

Tier 2 of the declared set.

- **imports** — `src/core/crypto.ts`
- **imported by** — `contracts/test/vault-client.test.ts`, `contracts/test/vault-payout.test.ts`, `contracts/test/vault-recovery.test.ts`, `src/midnight/vault-coins.test.ts`, `src/midnight/vault-ledger.ts`, `src/midnight/vault-notes.ts`, `src/midnight/vault-recovery.ts`
- **outside packages** — *none*
- **platform modules** — *none*
- **circuits named here** — *none*
- **circuits reached** — *through imports, then through what those circuits themselves run* — *none*

### `src/midnight/vault-coins.ts` — exported surface

| line | name | as written |
|---|---|---|
| 26 | `VaultCoin` | `export interface VaultCoin` |
| 62 | `UnreadableZswapState` | `export class UnreadableZswapState extends Error` |
| 212 | `changeCoinOf` | `export const changeCoinOf = (zswap: unknown, vaultAddress: Hex): VaultCoin \| undefined =>` |
| 266 | `paidCoinTo` | `export const paidCoinTo = (zswap: unknown, recipient: Hex): VaultCoin \| undefined =>` |

### `src/midnight/vault-coins.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 84 | throw | [value], outputs=[value] |
| 149 | throw | [value] is a [value] in neither spelling |
| 164 | throw | an output whose recipient has no is_left ([value]) |
| 199 | throw | an output whose coin carries BOTH color and type, which is neither spelling |
| 204 | throw | an output whose coin is not readable (nonce [value], token [value], value [value]) |
| 248 | throw | expected at most one coin returning to the vault, found [value] |
| 284 | throw | expected one coin for [value], found [value] |

### `src/midnight/vault-coins.ts` — where a width is fixed

*No width here matches the shapes above.* A width this module works to may
arrive in a variable, and this list sees only a number or a capitalised constant.

## `src/core/movement.ts`

Tier 2 of the declared set.

- **imports** — `src/core/assets.ts`, `src/core/types.ts`, `src/midnight/payee-address.ts`, `src/midnight/payout-tree.ts`
- **imported by** — `scripts/transfer-from-vault.test.ts`, `scripts/transfer-from-vault.ts`, `src/core/a-payroll-run-is-always-private.test.ts`, `src/core/ledger-token.test.ts`, `src/core/payroll.ts`
- **outside packages** — `nanoid`
- **platform modules** — *none*
- **circuits named here** — *none*
- **circuits reached** — *through imports, then through what those circuits themselves run* — `ConfidentialAccount.payoutLeaf`

### `src/core/movement.ts` — exported surface

| line | name | as written |
|---|---|---|
| 56 | `MovementKind` | `export type MovementKind = 'payroll' \| 'transfer';` |
| 69 | `Privacy` | `export type Privacy = 'private' \| 'public';` |
| 82 | `privacyOf` | `export const privacyOf = (p: Payee): Privacy =>` |
| 98 | `entryKindOf` | `export const entryKindOf = (m: MovementKind): EntryKind => m;` |
| 140 | `payrollPayee` | `export function payrollPayee(name: string, payee: Payee): PayeeAddress` |
| 164 | `Transfer` | `export interface Transfer` |
| 209 | `TransferSpec` | `export interface TransferSpec` |
| 261 | `transferOf` | `export function transferOf(spec: TransferSpec): Transfer` |
| 353 | `transferFacts` | `export const transferFacts = (t: Transfer, registry: AssetRegistry = defaultAssets): PaymentFacts => (` |

### `src/core/movement.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 142 | throw | [value] is set up to be paid publicly. A public payment puts the address and the amount on a record anyone can read. An employee is never paid that way, so a payroll run will not accept a public address. To pay a public address, use a one-off transfer. |
| 266 | throw | a transfer amount is a whole number in the asset's smallest unit |
| 268 | throw | a transfer has to move a positive amount |
| 272 | throw | this transfer is set to [value] and the address is a [value] one. An address decides which way it is paid, and this choice cannot change that. Either switch this transfer to [value], or use a [value] address. |
| 291 | throw | this address is on the payroll roster. A public payment puts the address and the amount on a record anyone can read. An employee is never paid that way, so pay them through payroll instead. |
| 304 | throw | give this transfer a reference, so it can be recognised later |

### `src/core/movement.ts` — where a width is fixed

*No width here matches the shapes above.* A width this module works to may
arrive in a variable, and this list sees only a number or a capitalised constant.

## `src/midnight/run-status.ts`

Tier 2 of the declared set.

- **imports** — `src/core/crypto.ts`, `src/core/ledger.ts`, `src/midnight/run-skips.ts`
- **imported by** — `contracts/test/a-retry-lives-on-the-leg-it-retries.test.ts`, `contracts/test/a-run-carries-its-own-material.test.ts`, `contracts/test/run-status.test.ts`, `src/core/core.test.ts`, `src/core/payroll.ts`, `src/server/index.ts`, `src/standalone/main.tsx`, `src/web/App.tsx`
- **outside packages** — *none*
- **platform modules** — *none*
- **circuits named here** — *none*
- **circuits reached** — *through imports, then through what those circuits themselves run* — *none*

### `src/midnight/run-status.ts` — exported surface

| line | name | as written |
|---|---|---|
| 46 | `PayeeStatus` | `export interface PayeeStatus` |
| 72 | `PayeeAttempts` | `export interface PayeeAttempts` |
| 79 | `RunPhase` | `export type RunPhase = 'not started' \| 'open' \| 'closed';` |
| 81 | `RunStatus` | `export interface RunStatus` |
| 118 | `ChainView` | `export interface ChainView` |
| 123 | `RunWindow` | `export interface RunWindow` |
| 128 | `RunInputs` | `export interface RunInputs` |
| 212 | `runStatus` | `export const runStatus = (` |
| 312 | `stillToPay` | `export const stillToPay = (status: RunStatus): number[] =>` |
| 316 | `describeRun` | `export const describeRun = (status: RunStatus): string =>` |
| 381 | `RunPayments` | `export type RunPayments` |
| 399 | `runPayments` | `export const runPayments = (` |

### `src/midnight/run-status.ts` — what it refuses

| line | kind | message |
|---|---|---|
| 229 | throw | these are not that run's payees: the proposal id rebuilt from these leaves is [value], and the run on chain is [value]. Reporting on them would describe a different payroll. |
| 475 | throw | the ledger answered with a payment that is not one of this run's payees, so this view would be describing something other than this run. Nothing is being reported. |

### `src/midnight/run-status.ts` — where a width is fixed

*No width here matches the shapes above.* A width this module works to may
arrive in a variable, and this list sees only a number or a capitalised constant.
<!-- GENERATED:END id="modules" body="8b9aa232cc382508" -->

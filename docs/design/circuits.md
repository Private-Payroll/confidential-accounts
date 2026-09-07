# CIRCUITS — EVERY CIRCUIT ON BOTH CONTRACTS

**THIS FILE IS GENERATED. `DOCS.command` WRITES IT AND NOTHING ELSE MAY.**

It is a REFERENCE, not a document: nobody opens it to read it, they search it.
The reasoning — why a circuit exists, what it protects, what was rejected — is in
`docs/design/account.md`, `docs/design/vault.md`, `docs/design/money-path.md` and
`docs/design/authority.md`, and none of it belongs here.

**Everything between the two `GENERATED` markers below is machine-written from the
compiled artifacts and the `.compact` sources.** Editing inside it is caught by the
suite, and a regeneration would overwrite it anyway. To change what it says, change
the contract and run `DOCS.command`.

**AN `asserts` COLUMN IS A MEASUREMENT AND NOT ONLY A LIST.** A provable circuit
that moves money with a low count next to a sibling with a higher one is a question
worth asking on sight. **A `writes` entry with no matching reader is another.**

<!-- GENERATED:BEGIN id="circuits" door="DOCS.command" -->

Every circuit on both contracts. **Generated — nothing in this block is hand-written.**

**THE CONSTRUCTOR IS THE FIRST ROW OF EACH CONTRACT AND IT IS NOT A CIRCUIT.**
`compiler/contract-info.json` has no entry for it and its emitted body is named
`initialState`, so a scan over circuits alone reports that fields only it writes have
no writer at all. It writes every field, because it initialises them.

`READS`, `WRITES`, `ASSERTS` and the cross-contract calls are read off the compiled
module and are TRANSITIVE: a circuit that reaches a ledger field through a private
helper is shown as reaching it, with the helper named. `DISCLOSES` is read off the
`.compact` SOURCE, because the compiler erases `disclose()` and the artifact contains
none — the freshness gate is what keeps the two in step.

**`DISCLOSES` IS NOT A LIST OF WHAT IS PUBLIC, AND MUST NOT BE READ AS ONE.**
`disclose()` has no runtime effect whatsoever; it tells the COMPILER to stop treating
an expression as witness-derived. Around a circuit argument — which the caller already
supplies in the clear — it publishes nothing at all and only silences a check. It is
therefore neither necessary nor sufficient for a value being observable on chain: a
ledger field written in the clear is public with no `disclose()` anywhere near it, and
the shape of a transaction leaks things no marker mentions. What this column IS is the
exact set of places the contract asserts that witness-derived data may cross into
public state — which is the trust boundary, and a different question. The enumeration
of what is actually public belongs in `docs/design/privacy.md` and is not this.

## ConfidentialAccount

`contracts/src/ConfidentialAccount.compact` → `contracts/managed/contract/index.js` · compactc 0.33.0 · language 0.25.0 · runtime 0.18.0-rc.1

| circuit | kind | reads | writes | asserts | discloses | calls | verifier key |
|---|---|---|---|---|---|---|---|
| `constructor` | **constructor** | — | approvalCounts, approvals, movements, openProposals, proposalHolds, retiredAt, runWindow, signerLeaves, signerRoles, signers, successor, threshold, thresholds, vaults | 1 | 1 | — | — (not a circuit) |
| `signerPublicKey` | pure | — | — | 0 | 0 | — | — (pure) |
| `signerLeaf` | pure | — | — | 0 | 0 | — | — (pure) |
| `assetKeyOf` | pure | — | — | 0 | 0 | — | — (pure) |
| `changeCommitmentOf` | pure | — | — | 0 | 0 | — | — (pure) |
| `proposalIdOf` | pure | — | — | 0 | 0 | — | — (pure) |
| `signerAddPayload` | pure | — | — | 0 | 0 | — | — (pure) |
| `removeSignerPayload` | pure | — | — | 0 | 0 | — | — (pure) |
| `setThresholdPayload` | pure | — | — | 0 | 0 | — | — (pure) |
| `allVaults` | pure | — | — | 0 | 0 | — | — (pure) |
| `noVault` | pure | — | — | 0 | 0 | — | — (pure) |
| `paidMovementOf` | pure | — | — | 0 | 0 | — | — (pure) |
| `runPayload` | pure | — | — | 0 | 0 | — | — (pure) |
| `payoutLeaf` | pure | — | — | 0 | 0 | — | — (pure) |
| `setVaultThresholdPayload` | pure | — | — | 0 | 0 | — | — (pure) |
| `vacantSlot` | pure | — | — | 0 | 0 | — | — (pure) |
| `adoptVaultPayload` | pure | — | — | 0 | 0 | — | — (pure) |
| `retireVaultPayload` | pure | — | — | 0 | 0 | — | — (pure) |
| `slotOf` | pure | — | — | 0 | 0 | — | — (pure) |
| `amendSigner` | provable | approvalCounts, openProposals, signerLeaves, signers, threshold | approvalCounts, openProposals, runWindow, signerLeaves, signers | 13 | 16 | — | 2,119 B `cb38e9b31d5f` |
| `setThreshold` | provable | approvalCounts, openProposals, signerLeaves, signers, threshold | approvalCounts, openProposals, runWindow, threshold | 7 | 7 | — | 2,119 B `51bf0a8c90d3` |
| `propose` | provable | openProposals, signers | approvalCounts, openProposals, runWindow | 7 | 19 | — | 2,119 B `97d704dee942` |
| `approve` | provable | approvalCounts, approvals, openProposals, signers | approvalCounts, approvals | 4 | 3 | — | 2,119 B `0103a77296e6` |
| `cancel` | provable | openProposals, runWindow, signers | approvalCounts, openProposals, runWindow | 4 | 2 | — | 2,119 B `f1cc6a9bbaa3` |
| `closeExpiredRun` | provable | openProposals, runWindow | approvalCounts, openProposals, runWindow | 3 | 1 | — | 1,351 B `ba3755a6770c` |
| `recordPayment` | provable | approvalCounts, movements, openProposals, threshold, thresholds | movements | 8 | 11 | — | 2,119 B `14b4de421ecf` |
| `setVaultThreshold` | provable | approvalCounts, openProposals, signers, threshold | approvalCounts, openProposals, runWindow, thresholds | 6 | 5 | — | 2,119 B `88f1c2ccae90` |
| `adopt` | provable | approvalCounts, openProposals, signers, threshold, vaults | approvalCounts, openProposals, runWindow, vaults | 6 | 5 | — | 2,119 B `7bf55bcf7b39` |
| `retireVault` | provable | approvalCounts, openProposals, threshold, vaults | approvalCounts, openProposals, retiredAt, runWindow, vaults | 4 | 4 | — | 2,119 B `e3bf78cdbe7f` |

### ConfidentialAccount — per circuit, in full

#### `constructor`

```
constructor(foundingLeaf: Bytes<32>)
```

- **reads** — *nothing*
- **writes** — `approvalCounts`; `approvals`; `movements`; `openProposals`; `proposalHolds`; `retiredAt`; `runWindow`; `signerLeaves`; `signerRoles`; `signers`; `successor`; `threshold`; `thresholds`; `vaults`
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — `vacantSlot`
- **asserts**
    - "that is not a usable signer leaf"
- **discloses** — 1 site
    - `contracts/src/ConfidentialAccount.compact:1696` — `foundingLeaf`

#### `signerPublicKey`

```
signerPublicKey(sk: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `signerLeaf`

```
signerLeaf(pk: Bytes<32>, blinding: Bytes<32>, scope: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `assetKeyOf`

```
assetKeyOf(asset: Bytes<32>, blinding: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `changeCommitmentOf`

```
changeCommitmentOf(assetKey: Bytes<32>, amount: Uint<0..340282366920938463463374607431768211455>, batch: Bytes<32>, salt: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `proposalIdOf`

```
proposalIdOf(payloadHash: Bytes<32>, vault: Bytes<32>, salt: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `signerAddPayload`

```
signerAddPayload(newSignerLeaf: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `removeSignerPayload`

```
removeSignerPayload(removedLeaf: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `setThresholdPayload`

```
setThresholdPayload(newThreshold: Uint<0..18446744073709551615>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `allVaults`

```
allVaults(): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `noVault`

```
noVault(): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `paidMovementOf`

```
paidMovementOf(leaf: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `runPayload`

```
runPayload(root: Bytes<32>, payees: Uint<0..18446744073709551615>, opensAt: Uint<0..18446744073709551615>, closesAt: Uint<0..18446744073709551615>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `payoutLeaf`

```
payoutLeaf(details: Bytes<32>, nonce: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `setVaultThresholdPayload`

```
setVaultThresholdPayload(vault: Bytes<32>, newThreshold: Uint<0..18446744073709551615>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `vacantSlot`

```
vacantSlot(): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `adoptVaultPayload`

```
adoptVaultPayload(vault: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `retireVaultPayload`

```
retireVaultPayload(vault: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `slotOf`

```
slotOf(path: struct MerkleTreePath): Uint<0..18446744073709551615>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `amendSigner`

```
amendSigner(leaf: Bytes<32>, proposal: Bytes<32>, intoVacatedSlot: Boolean, removing: Boolean): []
```

- **reads** — `approvalCounts` *(through `_requireApproved_0`)*; `openProposals` *(through `_requireApproved_0`)*; `signerLeaves`; `signers`; `threshold`
- **writes** — `approvalCounts` *(through `_closeProposal_0`)*; `openProposals` *(through `_closeProposal_0`)*; `runWindow` *(through `_closeProposal_0`)*; `signerLeaves`; `signers`
- **witnesses** — `localSecretKey` *(through `_requireSigner_0` → `_localSecretKey_0`)*; `proposalSalt` *(through `_proposalSalt_0`)*; `signerBlinding` *(through `_requireSigner_0` → `_signerBlinding_0`)*; `signerPath` *(through `_requireSigner_0` → `_signerPath_0`)*; `signerScope` *(through `_requireSigner_0` → `_signerScope_0`)*
- **kernel** — *none*
- **calls** — *none*
- **uses** — `noVault`; `proposalIdOf`; `removeSignerPayload`; `signerAddPayload`; `signerLeaf` *(through `_requireSigner_0`)*; `signerPublicKey` *(through `_requireSigner_0`)*; `slotOf`; `vacantSlot`
- **asserts**
    - "that proposal is not for this removal"
    - "that path is not for the leaf being removed"
    - "that signer is not on this account"
    - "that would leave fewer signers than the threshold, and the account could never approve again"
    - "that is not a usable signer leaf"
    - "that signer is already on this account"
    - "that proposal is not for this signer"
    - "that membership path is not yours" *(through `_requireSigner_0`)*
    - "not a signer on this account" *(through `_requireSigner_0`)*
    - "there is no open proposal with that id" *(through `_requireApproved_0`)*
    - "not enough approvals yet" *(through `_requireApproved_0`)*
    - "that slot has not been vacated" *(through `_takeVacatedSlot_0`)*
    - "that path is not from this tree" *(through `_takeVacatedSlot_0`)*
- **discloses** — 16 sites
    - `contracts/src/ConfidentialAccount.compact:1857` — `removing`
    - `contracts/src/ConfidentialAccount.compact:1860` — `proposal`
    - `contracts/src/ConfidentialAccount.compact:1863` — `proposalIdOf(removeSignerPayload(removedLeaf), noVault(), proposalSalt()) == proposal`
    - `contracts/src/ConfidentialAccount.compact:1874` — `merkleTreePathRoot<10, Bytes<32>>(path)`
    - `contracts/src/ConfidentialAccount.compact:1886` — `slotOf(path)`
    - `contracts/src/ConfidentialAccount.compact:1895` — `removedLeaf`
    - `contracts/src/ConfidentialAccount.compact:1989` — `newSignerLeaf`
    - `contracts/src/ConfidentialAccount.compact:2025` — `proposal`
    - `contracts/src/ConfidentialAccount.compact:2031` — `proposalIdOf(signerAddPayload(newSignerLeaf), noVault(), proposalSalt()) == proposal`
    - `contracts/src/ConfidentialAccount.compact:2060` — `intoVacatedSlot`
    - `contracts/src/ConfidentialAccount.compact:2061` — `newSignerLeaf`
    - `contracts/src/ConfidentialAccount.compact:2061` — `takeVacatedSlot()`
    - `contracts/src/ConfidentialAccount.compact:2063` — `newSignerLeaf`
    - `contracts/src/ConfidentialAccount.compact:2065` — `newSignerLeaf`
    - `contracts/src/ConfidentialAccount.compact:1323` — `root` *(through `requireSigner`)*
    - `contracts/src/ConfidentialAccount.compact:1538` — `root` *(through `takeVacatedSlot`)*

#### `setThreshold`

```
setThreshold(newThreshold: Uint<0..18446744073709551615>, proposal: Bytes<32>): []
```

- **reads** — `approvalCounts` *(through `_requireApproved_0`)*; `openProposals` *(through `_requireApproved_0`)*; `signerLeaves`; `signers` *(through `_requireSigner_0`)*; `threshold` *(through `_requireApproved_0`)*
- **writes** — `approvalCounts` *(through `_closeProposal_0`)*; `openProposals` *(through `_closeProposal_0`)*; `runWindow` *(through `_closeProposal_0`)*; `threshold`
- **witnesses** — `localSecretKey` *(through `_requireSigner_0` → `_localSecretKey_0`)*; `proposalSalt` *(through `_proposalSalt_0`)*; `signerBlinding` *(through `_requireSigner_0` → `_signerBlinding_0`)*; `signerPath` *(through `_requireSigner_0` → `_signerPath_0`)*; `signerScope` *(through `_requireSigner_0` → `_signerScope_0`)*
- **kernel** — *none*
- **calls** — *none*
- **uses** — `noVault`; `proposalIdOf`; `setThresholdPayload`; `signerLeaf` *(through `_requireSigner_0`)*; `signerPublicKey` *(through `_requireSigner_0`)*
- **asserts**
    - "that proposal is not for this threshold"
    - "the threshold must be at least one"
    - "the threshold cannot exceed the number of signers, or one signer could seat their own"
    - "that membership path is not yours" *(through `_requireSigner_0`)*
    - "not a signer on this account" *(through `_requireSigner_0`)*
    - "there is no open proposal with that id" *(through `_requireApproved_0`)*
    - "not enough approvals yet" *(through `_requireApproved_0`)*
- **discloses** — 7 sites
    - `contracts/src/ConfidentialAccount.compact:2118` — `proposal`
    - `contracts/src/ConfidentialAccount.compact:2121` — `proposalIdOf(setThresholdPayload(newThreshold), noVault(), proposalSalt()) == proposal`
    - `contracts/src/ConfidentialAccount.compact:2127` — `newThreshold`
    - `contracts/src/ConfidentialAccount.compact:2134` — `newThreshold`
    - `contracts/src/ConfidentialAccount.compact:2137` — `newThreshold`
    - `contracts/src/ConfidentialAccount.compact:2149` — `proposal`
    - `contracts/src/ConfidentialAccount.compact:1323` — `root` *(through `requireSigner`)*

#### `propose`

```
propose(payloadHash: Bytes<32>, root: Bytes<32>, payees: Uint<0..18446744073709551615>, opensAt: Uint<0..18446744073709551615>, closesAt: Uint<0..18446744073709551615>, isRun: Boolean, vault: Bytes<32>): []
```

- **reads** — `openProposals`; `signers` *(through `_requireSigner_0`)*
- **writes** — `approvalCounts`; `openProposals`; `runWindow`
- **witnesses** — `assetBlinding` *(through `_assetBlinding_0`)*; `assetId` *(through `_assetId_0`)*; `changeAmount` *(through `_changeAmount_0`)*; `changeBatchDigest` *(through `_changeBatchDigest_0`)*; `localSecretKey` *(through `_requireSigner_0` → `_localSecretKey_0`)*; `proposalSalt` *(through `_proposalSalt_0`)*; `signerBlinding` *(through `_requireSigner_0` → `_signerBlinding_0`)*; `signerPath` *(through `_requireSigner_0` → `_signerPath_0`)*; `signerScope` *(through `_requireSigner_0` → `_signerScope_0`)*
- **kernel** — *none*
- **calls** — *none*
- **uses** — `assetKeyOf`; `changeCommitmentOf`; `noVault`; `proposalIdOf`; `runPayload`; `signerLeaf` *(through `_requireSigner_0`)*; `signerPublicKey` *(through `_requireSigner_0`)*
- **asserts**
    - "a run with no payees"
    - "a run window ends before it opens"
    - "a run must name the vault that will pay it"
    - "that proposal is already open"
    - "a governance proposal cannot name a vault"
    - "that membership path is not yours" *(through `_requireSigner_0`)*
    - "not a signer on this account" *(through `_requireSigner_0`)*
- **discloses** — 19 sites
    - `contracts/src/ConfidentialAccount.compact:2224` — `isRun`
    - `contracts/src/ConfidentialAccount.compact:2231` — `payees`
    - `contracts/src/ConfidentialAccount.compact:2232` — `opensAt`
    - `contracts/src/ConfidentialAccount.compact:2232` — `closesAt`
    - `contracts/src/ConfidentialAccount.compact:2297` — `vault`
    - `contracts/src/ConfidentialAccount.compact:2300` — `changeCommitmentOf( assetKeyOf(assetId(), assetBlinding()), changeAmount(), changeBatchDigest(), salt)`
    - `contracts/src/ConfidentialAccount.compact:2303` — `proposalIdOf( runPayload(disclose(root), disclose(payees), disclose(opensAt), disclose(closesAt)), disclose(vault), salt)`
    - `contracts/src/ConfidentialAccount.compact:2304` — `root`
    - `contracts/src/ConfidentialAccount.compact:2304` — `payees`
    - `contracts/src/ConfidentialAccount.compact:2304` — `opensAt`
    - `contracts/src/ConfidentialAccount.compact:2304` — `closesAt`
    - `contracts/src/ConfidentialAccount.compact:2305` — `vault`
    - `contracts/src/ConfidentialAccount.compact:2326` — `opensAt`
    - `contracts/src/ConfidentialAccount.compact:2326` — `closesAt`
    - `contracts/src/ConfidentialAccount.compact:2424` — `vault`
    - `contracts/src/ConfidentialAccount.compact:2453` — `changeCommitmentOf( assetKeyOf(assetId(), assetBlinding()), changeAmount(), changeBatchDigest(), salt)`
    - `contracts/src/ConfidentialAccount.compact:2480` — `proposalIdOf(payloadHash, disclose(vault), salt)`
    - `contracts/src/ConfidentialAccount.compact:2480` — `vault`
    - `contracts/src/ConfidentialAccount.compact:1323` — `root` *(through `requireSigner`)*

#### `approve`

```
approve(proposal: Bytes<32>): []
```

- **reads** — `approvalCounts`; `approvals`; `openProposals`; `signers` *(through `_requireSigner_0`)*
- **writes** — `approvalCounts`; `approvals`
- **witnesses** — `localSecretKey` *(through `_requireSigner_0` → `_localSecretKey_0`)*; `signerBlinding` *(through `_requireSigner_0` → `_signerBlinding_0`)*; `signerPath` *(through `_requireSigner_0` → `_signerPath_0`)*; `signerScope` *(through `_requireSigner_0` → `_signerScope_0`)*
- **kernel** — reads slot 0 through `_approvalNullifier_0`
- **calls** — *none*
- **uses** — `signerLeaf` *(through `_requireSigner_0`)*; `signerPublicKey` *(through `_requireSigner_0`)*
- **asserts**
    - "there is no open proposal with that id"
    - "you have already approved this proposal"
    - "that membership path is not yours" *(through `_requireSigner_0`)*
    - "not a signer on this account" *(through `_requireSigner_0`)*
- **discloses** — 3 sites
    - `contracts/src/ConfidentialAccount.compact:2502` — `proposal`
    - `contracts/src/ConfidentialAccount.compact:2505` — `approvalNullifier(sk, id)`
    - `contracts/src/ConfidentialAccount.compact:1323` — `root` *(through `requireSigner`)*

#### `cancel`

```
cancel(proposal: Bytes<32>): []
```

- **reads** — `openProposals`; `runWindow`; `signers` *(through `_requireSigner_0`)*
- **writes** — `approvalCounts` *(through `_closeProposal_0`)*; `openProposals` *(through `_closeProposal_0`)*; `runWindow` *(through `_closeProposal_0`)*
- **witnesses** — `localSecretKey` *(through `_requireSigner_0` → `_localSecretKey_0`)*; `signerBlinding` *(through `_requireSigner_0` → `_signerBlinding_0`)*; `signerPath` *(through `_requireSigner_0` → `_signerPath_0`)*; `signerScope` *(through `_requireSigner_0` → `_signerScope_0`)*
- **kernel** — reads slot 2 through `_blockTimeLt_0`
- **calls** — *none*
- **uses** — `signerLeaf` *(through `_requireSigner_0`)*; `signerPublicKey` *(through `_requireSigner_0`)*
- **asserts**
    - "there is no open proposal with that id"
    - "that run has already started; it can no longer be cancelled"
    - "that membership path is not yours" *(through `_requireSigner_0`)*
    - "not a signer on this account" *(through `_requireSigner_0`)*
- **discloses** — 2 sites
    - `contracts/src/ConfidentialAccount.compact:2527` — `proposal`
    - `contracts/src/ConfidentialAccount.compact:1323` — `root` *(through `requireSigner`)*

#### `closeExpiredRun`

```
closeExpiredRun(proposal: Bytes<32>): []
```

- **reads** — `openProposals`; `runWindow`
- **writes** — `approvalCounts` *(through `_closeProposal_0`)*; `openProposals` *(through `_closeProposal_0`)*; `runWindow` *(through `_closeProposal_0`)*
- **witnesses** — *none*
- **kernel** — reads slot 2 through `_blockTimeLt_0`
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts**
    - "there is no open proposal with that id"
    - "that is not a run"
    - "the payment window for this run has not closed yet"
- **discloses** — 1 site
    - `contracts/src/ConfidentialAccount.compact:2602` — `proposal`

#### `recordPayment`

```
recordPayment(proposal: Bytes<32>, vault: Bytes<32>, root: Bytes<32>, payees: Uint<0..18446744073709551615>, opensAt: Uint<0..18446744073709551615>, closesAt: Uint<0..18446744073709551615>, salt: Bytes<32>, details: Bytes<32>, nonce: Bytes<32>, path: struct MerkleTreePath): Bytes<32>
```

- **reads** — `approvalCounts` *(through `_requireApprovedForVault_0`)*; `movements`; `openProposals` *(through `_requireApprovedForVault_0`)*; `threshold` *(through `_requireApprovedForVault_0` → `_thresholdFor_0`)*; `thresholds` *(through `_requireApprovedForVault_0` → `_thresholdFor_0`)*
- **writes** — `movements`
- **witnesses** — *none*
- **kernel** — reads slot 2 through `_blockTimeLt_0`
- **calls** — *none*
- **uses** — `paidMovementOf`; `payoutLeaf`; `proposalIdOf`; `runPayload`
- **asserts**
    - "that is not this proposal, or you were not given it"
    - "that run has not started yet"
    - "the payment window for this run has closed"
    - "that path is not for this payee"
    - "that payee is not in the approved run"
    - "that payment has already been made"
    - "there is no open proposal with that id" *(through `_requireApprovedForVault_0`)*
    - "not enough approvals yet" *(through `_requireApprovedForVault_0`)*
- **discloses** — 11 sites
    - `contracts/src/ConfidentialAccount.compact:2756` — `proposal`
    - `contracts/src/ConfidentialAccount.compact:2757` — `vault`
    - `contracts/src/ConfidentialAccount.compact:2777` — `proposalIdOf( runPayload(disclose(root), disclose(payees), disclose(opensAt), disclose(closesAt)), forVault, disclose(salt)) == id`
    - `contracts/src/ConfidentialAccount.compact:2778` — `root`
    - `contracts/src/ConfidentialAccount.compact:2778` — `payees`
    - `contracts/src/ConfidentialAccount.compact:2778` — `opensAt`
    - `contracts/src/ConfidentialAccount.compact:2778` — `closesAt`
    - `contracts/src/ConfidentialAccount.compact:2779` — `salt`
    - `contracts/src/ConfidentialAccount.compact:2799` — `opensAt`
    - `contracts/src/ConfidentialAccount.compact:2800` — `closesAt`
    - `contracts/src/ConfidentialAccount.compact:2831` — `paidMovementOf(leaf)`

#### `setVaultThreshold`

```
setVaultThreshold(vault: Bytes<32>, newThreshold: Uint<0..18446744073709551615>, proposal: Bytes<32>): []
```

- **reads** — `approvalCounts` *(through `_requireApproved_0`)*; `openProposals` *(through `_requireApproved_0`)*; `signers` *(through `_requireSigner_0`)*; `threshold` *(through `_requireApproved_0`)*
- **writes** — `approvalCounts` *(through `_closeProposal_0`)*; `openProposals` *(through `_closeProposal_0`)*; `runWindow` *(through `_closeProposal_0`)*; `thresholds`
- **witnesses** — `localSecretKey` *(through `_requireSigner_0` → `_localSecretKey_0`)*; `proposalSalt` *(through `_proposalSalt_0`)*; `signerBlinding` *(through `_requireSigner_0` → `_signerBlinding_0`)*; `signerPath` *(through `_requireSigner_0` → `_signerPath_0`)*; `signerScope` *(through `_requireSigner_0` → `_signerScope_0`)*
- **kernel** — *none*
- **calls** — *none*
- **uses** — `noVault`; `proposalIdOf`; `setVaultThresholdPayload`; `signerLeaf` *(through `_requireSigner_0`)*; `signerPublicKey` *(through `_requireSigner_0`)*
- **asserts**
    - "that proposal does not authorise this vault threshold"
    - "a vault threshold of zero would authorise anything"
    - "that membership path is not yours" *(through `_requireSigner_0`)*
    - "not a signer on this account" *(through `_requireSigner_0`)*
    - "there is no open proposal with that id" *(through `_requireApproved_0`)*
    - "not enough approvals yet" *(through `_requireApproved_0`)*
- **discloses** — 5 sites
    - `contracts/src/ConfidentialAccount.compact:2939` — `proposal`
    - `contracts/src/ConfidentialAccount.compact:2941` — `proposalIdOf( setVaultThresholdPayload(vault, newThreshold), noVault(), proposalSalt()) == id`
    - `contracts/src/ConfidentialAccount.compact:2947` — `vault`
    - `contracts/src/ConfidentialAccount.compact:2947` — `newThreshold`
    - `contracts/src/ConfidentialAccount.compact:1323` — `root` *(through `requireSigner`)*

#### `adopt`

```
adopt(vault: Bytes<32>, proposal: Bytes<32>): []
```

- **reads** — `approvalCounts` *(through `_requireApproved_0`)*; `openProposals` *(through `_requireApproved_0`)*; `signers` *(through `_requireSigner_0`)*; `threshold` *(through `_requireApproved_0`)*; `vaults`
- **writes** — `approvalCounts` *(through `_closeProposal_0`)*; `openProposals` *(through `_closeProposal_0`)*; `runWindow` *(through `_closeProposal_0`)*; `vaults`
- **witnesses** — `localSecretKey` *(through `_requireSigner_0` → `_localSecretKey_0`)*; `proposalSalt` *(through `_proposalSalt_0`)*; `signerBlinding` *(through `_requireSigner_0` → `_signerBlinding_0`)*; `signerPath` *(through `_requireSigner_0` → `_signerPath_0`)*; `signerScope` *(through `_requireSigner_0` → `_signerScope_0`)*
- **kernel** — *none*
- **calls** — *none*
- **uses** — `adoptVaultPayload`; `noVault`; `proposalIdOf`; `signerLeaf` *(through `_requireSigner_0`)*; `signerPublicKey` *(through `_requireSigner_0`)*
- **asserts**
    - "that proposal does not authorise adopting this vault"
    - "this account has already adopted that vault"
    - "that membership path is not yours" *(through `_requireSigner_0`)*
    - "not a signer on this account" *(through `_requireSigner_0`)*
    - "there is no open proposal with that id" *(through `_requireApproved_0`)*
    - "not enough approvals yet" *(through `_requireApproved_0`)*
- **discloses** — 5 sites
    - `contracts/src/ConfidentialAccount.compact:2974` — `proposal`
    - `contracts/src/ConfidentialAccount.compact:2976` — `proposalIdOf( adoptVaultPayload(vault), noVault(), proposalSalt()) == id`
    - `contracts/src/ConfidentialAccount.compact:2988` — `vault`
    - `contracts/src/ConfidentialAccount.compact:2989` — `vault`
    - `contracts/src/ConfidentialAccount.compact:1323` — `root` *(through `requireSigner`)*

#### `retireVault`

```
retireVault(proposal: Bytes<32>, vault: Bytes<32>, salt: Bytes<32>): []
```

- **reads** — `approvalCounts` *(through `_requireApproved_0`)*; `openProposals` *(through `_requireApproved_0`)*; `threshold` *(through `_requireApproved_0`)*; `vaults`
- **writes** — `approvalCounts` *(through `_closeProposal_0`)*; `openProposals` *(through `_closeProposal_0`)*; `retiredAt`; `runWindow` *(through `_closeProposal_0`)*; `vaults`
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — `noVault`; `proposalIdOf`; `retireVaultPayload`
- **asserts**
    - "that proposal does not authorise retiring this vault"
    - "this account has not adopted that vault"
    - "there is no open proposal with that id" *(through `_requireApproved_0`)*
    - "not enough approvals yet" *(through `_requireApproved_0`)*
- **discloses** — 4 sites
    - `contracts/src/ConfidentialAccount.compact:3033` — `proposal`
    - `contracts/src/ConfidentialAccount.compact:3034` — `vault`
    - `contracts/src/ConfidentialAccount.compact:3036` — `proposalIdOf(retireVaultPayload(forVault), noVault(), disclose(salt)) == id`
    - `contracts/src/ConfidentialAccount.compact:3036` — `salt`

## Vault

`contracts/src/Vault.compact` → `contracts/managed-vault/contract/index.js` · compactc 0.33.0 · language 0.25.0 · runtime 0.18.0-rc.1

| circuit | kind | reads | writes | asserts | discloses | calls | verifier key |
|---|---|---|---|---|---|---|---|
| `constructor` | **constructor** | — | account, notes, payments, spendingCaps, unshieldedTokens | 0 | 1 | — | — (not a circuit) |
| `payoutDetails` | pure | — | — | 0 | 0 | — | — (pure) |
| `unshieldedPayoutDetails` | pure | — | — | 0 | 0 | — | — (pure) |
| `heldCommitmentOf` | pure | — | — | 0 | 0 | — | — (pure) |
| `noteBlindingOf` | pure | — | — | 0 | 0 | — | — (pure) |
| `deposit` | provable | — | notes | 0 | 2 | — | 2,119 B `fcd735b0a085` |
| `depositUnshielded` | provable | — | unshieldedTokens | 1 | 3 | — | 1,351 B `9027c53fec59` |
| `payout` | provable | account, notes | notes, payments | 4 | 16 | recordPayment | 2,119 B `0d5f30177995` |
| `payoutUnshielded` | provable | account | payments | 1 | 15 | recordPayment | 2,119 B `2f6ee61a8ff2` |
| `splitNote` | provable | notes | notes | 5 | 6 | — | 2,119 B `abe237593b76` |
| `forgetUnshielded` | provable | — | unshieldedTokens | 1 | 2 | — | 1,351 B `5c97e5981254` |
| `retire` | provable | account, notes, unshieldedTokens | — | 2 | 3 | retireVault | 1,351 B `6862578d6436` |

### Vault — per circuit, in full

#### `constructor`

```
constructor(a: contract Acct[recordPayment(Bytes<32>, Bytes<32>, Bytes<32>, Uint<0..18446744073709551616>, Uint<0..18446744073709551616>, Uint<0..18446744073709551616>, Bytes<32>, Bytes<32>, Bytes<32>, struct MerkleTreePath<leaf: Bytes<32>, path: Vector<16, struct MerkleTreePathEntry<sibling: struct MerkleTreeDigest<field: Field>, goes_left: Boolean>>>): Bytes<32>, retireVault(Bytes<32>, Bytes<32>, Bytes<32>): []])
```

- **reads** — *nothing*
- **writes** — `account`; `notes`; `payments`; `spendingCaps`; `unshieldedTokens`
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — 1 site
    - `contracts/src/Vault.compact:347` — `a`

#### `payoutDetails`

```
payoutDetails(recipient: Bytes<32>, token: Bytes<32>, amount: Uint<0..340282366920938463463374607431768211455>, blinding: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `unshieldedPayoutDetails`

```
unshieldedPayoutDetails(recipient: Bytes<32>, token: Bytes<32>, amount: Uint<0..340282366920938463463374607431768211455>, blinding: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `heldCommitmentOf`

```
heldCommitmentOf(coin: struct ShieldedCoinInfo, blinding: Bytes<32>): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `noteBlindingOf`

```
noteBlindingOf(vault: Bytes<32>, coin: struct ShieldedCoinInfo): Bytes<32>
```

- **reads** — *nothing*
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — *none*
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts** — *none*
- **discloses** — *nothing*

#### `deposit`

```
deposit(coin: struct ShieldedCoinInfo): []
```

- **reads** — *nothing*
- **writes** — `notes`
- **witnesses** — *none*
- **kernel** — reads slot 0 through `_deposit_0`; reads slot 0 through `_receiveShielded_0`; writes slot 1 through `_receiveShielded_0`
- **calls** — *none*
- **uses** — `heldCommitmentOf`; `noteBlindingOf`
- **asserts** — *none*
- **discloses** — 2 sites
    - `contracts/src/Vault.compact:558` — `coin`
    - `contracts/src/Vault.compact:584` — `heldCommitmentOf(coin, noteBlindingOf(kernel.self().bytes, coin))`

#### `depositUnshielded`

```
depositUnshielded(token: Bytes<32>, amount: Uint<0..340282366920938463463374607431768211455>): []
```

- **reads** — *nothing*
- **writes** — `unshieldedTokens`
- **witnesses** — *none*
- **kernel** — writes slot 6 through `_receiveUnshielded_0`
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts**
    - "a deposit of nothing is not a deposit"
- **discloses** — 3 sites
    - `contracts/src/Vault.compact:625` — `token`
    - `contracts/src/Vault.compact:625` — `amount`
    - `contracts/src/Vault.compact:626` — `token`

#### `payout`

```
payout(proposal: Bytes<32>, root: Bytes<32>, payees: Uint<0..18446744073709551615>, opensAt: Uint<0..18446744073709551615>, closesAt: Uint<0..18446744073709551615>, salt: Bytes<32>, recipient: Bytes<32>, token: Bytes<32>, amount: Uint<0..340282366920938463463374607431768211455>, blinding: Bytes<32>, nonce: Bytes<32>, path: struct MerkleTreePath): []
```

- **reads** — `account`; `notes`
- **writes** — `notes`; `payments`
- **witnesses** — `noteToSpend` *(through `_noteToSpend_0`)*
- **kernel** — reads slot 0 through `_payout_0`; reads slot 0 through `_sendShielded_0`; writes slot 0 through `_sendShielded_0`; writes slot 2 through `_sendShielded_0`; writes slot 1 through `_sendShielded_0`
- **calls** — `Acct.recordPayment`
- **uses** — `heldCommitmentOf`; `noteBlindingOf`; `payoutDetails`
- **asserts**
    - "that is not a note of the token being paid"
    - "that note does not hold enough to make this payment"
    - "that note is not in this vault's pool"
    - "result of subtraction would be negative" *(through `_sendShielded_0`)*
- **discloses** — 16 sites
    - `contracts/src/Vault.compact:682` — `proposal`
    - `contracts/src/Vault.compact:683` — `kernel.self().bytes`
    - `contracts/src/Vault.compact:684` — `root`
    - `contracts/src/Vault.compact:685` — `payees`
    - `contracts/src/Vault.compact:686` — `opensAt`
    - `contracts/src/Vault.compact:687` — `closesAt`
    - `contracts/src/Vault.compact:688` — `salt`
    - `contracts/src/Vault.compact:689` — `details`
    - `contracts/src/Vault.compact:690` — `nonce`
    - `contracts/src/Vault.compact:691` — `path`
    - `contracts/src/Vault.compact:728` — `heldCommitmentOf( unqualified, noteBlindingOf(kernel.self().bytes, unqualified))`
    - `contracts/src/Vault.compact:734` — `coin`
    - `contracts/src/Vault.compact:735` — `recipient`
    - `contracts/src/Vault.compact:736` — `amount`
    - `contracts/src/Vault.compact:767` — `result.change.is_some`
    - `contracts/src/Vault.compact:768` — `heldCommitmentOf( result.change.value, noteBlindingOf(kernel.self().bytes, result.change.value))`

#### `payoutUnshielded`

```
payoutUnshielded(proposal: Bytes<32>, root: Bytes<32>, payees: Uint<0..18446744073709551615>, opensAt: Uint<0..18446744073709551615>, closesAt: Uint<0..18446744073709551615>, salt: Bytes<32>, recipient: Bytes<32>, token: Bytes<32>, amount: Uint<0..340282366920938463463374607431768211455>, blinding: Bytes<32>, nonce: Bytes<32>, path: struct MerkleTreePath): []
```

- **reads** — `account`
- **writes** — `payments`
- **witnesses** — *none*
- **kernel** — reads slot 0 through `_payoutUnshielded_0`; reads slot 5 through `_unshieldedBalanceLt_0`; writes slot 7 through `_sendUnshielded_0`; writes slot 8 through `_sendUnshielded_0`; reads slot 0 through `_sendUnshielded_0`; writes slot 6 through `_sendUnshielded_0`
- **calls** — `Acct.recordPayment`
- **uses** — `unshieldedPayoutDetails`
- **asserts**
    - "this vault does not hold enough of that token to make this payment"
- **discloses** — 15 sites
    - `contracts/src/Vault.compact:855` — `proposal`
    - `contracts/src/Vault.compact:856` — `kernel.self().bytes`
    - `contracts/src/Vault.compact:857` — `root`
    - `contracts/src/Vault.compact:858` — `payees`
    - `contracts/src/Vault.compact:859` — `opensAt`
    - `contracts/src/Vault.compact:860` — `closesAt`
    - `contracts/src/Vault.compact:861` — `salt`
    - `contracts/src/Vault.compact:862` — `details`
    - `contracts/src/Vault.compact:863` — `nonce`
    - `contracts/src/Vault.compact:864` — `path`
    - `contracts/src/Vault.compact:887` — `token`
    - `contracts/src/Vault.compact:887` — `amount`
    - `contracts/src/Vault.compact:909` — `token`
    - `contracts/src/Vault.compact:909` — `amount`
    - `contracts/src/Vault.compact:910` — `recipient`

#### `splitNote`

```
splitNote(token: Bytes<32>, amount: Uint<0..340282366920938463463374607431768211455>): []
```

- **reads** — `notes`
- **writes** — `notes`
- **witnesses** — `noteToSpend` *(through `_noteToSpend_0`)*
- **kernel** — reads slot 0 through `_splitNote_0`; reads slot 0 through `_sendShielded_0`; writes slot 0 through `_sendShielded_0`; writes slot 2 through `_sendShielded_0`; writes slot 1 through `_sendShielded_0`
- **calls** — *none*
- **uses** — `heldCommitmentOf`; `noteBlindingOf`
- **asserts**
    - "that is not a note of the token being split"
    - "a split has to leave something behind; that note is not bigger than the piece asked for"
    - "that note is not one this vault holds"
    - "a split produced no remainder, which the size check forbids"
    - "result of subtraction would be negative" *(through `_sendShielded_0`)*
- **discloses** — 6 sites
    - `contracts/src/Vault.compact:994` — `kernel.self().bytes`
    - `contracts/src/Vault.compact:1005` — `heldCommitmentOf( unqualified, noteBlindingOf(self, unqualified))`
    - `contracts/src/Vault.compact:1023` — `coin`
    - `contracts/src/Vault.compact:1025` — `amount`
    - `contracts/src/Vault.compact:1028` — `heldCommitmentOf( result.sent, noteBlindingOf(self, result.sent))`
    - `contracts/src/Vault.compact:1039` — `heldCommitmentOf( result.change.value, noteBlindingOf(self, result.change.value))`

#### `forgetUnshielded`

```
forgetUnshielded(token: Bytes<32>): []
```

- **reads** — *nothing*
- **writes** — `unshieldedTokens`
- **witnesses** — *none*
- **kernel** — reads slot 5 through `_unshieldedBalanceGt_0`
- **calls** — *none*
- **uses** — *no other circuit*
- **asserts**
    - "this vault still holds some of that token"
- **discloses** — 2 sites
    - `contracts/src/Vault.compact:1073` — `token`
    - `contracts/src/Vault.compact:1075` — `token`

#### `retire`

```
retire(proposal: Bytes<32>, salt: Bytes<32>): []
```

- **reads** — `account`; `notes`; `unshieldedTokens`
- **writes** — *nothing*
- **witnesses** — *none*
- **kernel** — reads slot 0 through `_retire_0`
- **calls** — `Acct.retireVault`
- **uses** — *no other circuit*
- **asserts**
    - "this vault still holds notes, and retiring it would strand them"
    - "this vault still holds public money, and retiring it would strand that too"
- **discloses** — 3 sites
    - `contracts/src/Vault.compact:1176` — `proposal`
    - `contracts/src/Vault.compact:1183` — `kernel.self().bytes`
    - `contracts/src/Vault.compact:1184` — `salt`
<!-- GENERATED:END id="circuits" body="476abe57d14f05fc" -->

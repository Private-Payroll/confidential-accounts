# 3. Signers are Merkle leaves and approvals are nullifiers

## Decision

`ConfidentialAccount.compact` stores the signer set as a `HistoricMerkleTree` and records approvals as nullifiers. It does not use a public `Set` of signers or a `Map` of approvals keyed by public key.

**Do not simplify this.** It looks like unnecessary machinery and it is the product.

## Why

The ecosystem's documented multisig pattern uses `Set<Bytes<32>> signers` and `Map<Bytes<32>, Boolean> approvals`. Its own privacy notes state the consequence: all signer identities are public, who approved and when is visible on chain, and the proposal data is public.

That is a Safe with extra steps. On a chain that exists to hide things, publishing the cap table of a company treasury is the entire problem restated.

| Reference pattern | Here |
| --- | --- |
| `Set<Bytes<32>> signers`, public | `HistoricMerkleTree<10, Bytes<32>>` of blinded commitments; only the root on chain |
| approvals keyed by public key | `Set<Bytes<32>>` of nullifiers |
| `proposalData`, public | `persistentCommit` of the payload |
| balance public | `stateCommitment` only |

An observer sees that a distinct authorised signer approved. They do not see which one.

## Details that are load-bearing

- **~~`HistoricMerkleTree`, not `MerkleTree`.~~ Reversed by M-106, and the reversal is the point.** This said: signers get added over a company's life, a plain tree changes root on every insertion and invalidates every membership proof already generated, so `checkRoot` should accept prior roots. All true — and it is also exactly why a signer could never be removed, because a tree that accepts every root it has ever held is a tree that can never forget anybody. `signers` is now a plain `MerkleTree<10, Bytes<32>>` with **one slot per signer**; a removal clears one slot. The cost is that a membership change invalidates in-flight proofs, which turns out to be nearly free because `addSigner` and `removeSigner` both bump the round, and a round bump already invalidated them. See decision 0010.
- **Depth 10 gives 1024 signers.** A treasury with more signers than that is not a treasury, and a shallower tree keeps proving cheap.
- **The nullifier binds to both the signer's secret and the round.** Bound to the secret so nobody else can generate it. Bound to the round so a signer who approved proposal 4 can still approve proposal 5.
- **`requireSigner` discloses only the computed root.** Disclosing the leaf, or asserting membership on a `Set`, names the signer and gives away exactly what the contract exists to protect.
- **Domain separation in `signerPublicKey`.** The same device secret used with another Midnight contract must not produce the same identity, or the same human is correlatable across contracts.

## The two mistakes this design invites

Both were made in the first version. Both compiled. Neither was caught by any test until the circuits were actually executed.

### Binding the path to the caller

`merkleTreePathRoot` derives the root from `path.leaf`, and the path arrives from a witness. A witness is whatever the caller says it is. So computing the caller's public key and then using it only to *look up* a path leaves the leaf unbound, and anyone holding any real member's path can act as them.

```compact
assert(path.leaf == pk, "that membership path is not yours");
```

That line is the difference between authentication and decoration. Do not remove it.

### Leaves must be blinded, not raw key hashes

The first version had `addSigner(newSignerPk)` take the key as a public argument and insert it with `disclose`. Every signer's identity was therefore published on chain when they joined, and the whole set was reconstructable from transaction history.

Authentication was never affected, because inverting `signerPublicKey` is not feasible. The privacy claim was simply false.

The leaf is now a blinded commitment:

```compact
export circuit signerLeaf(pk: Bytes<32>, blinding: Bytes<32>): Bytes<32> {
  return persistentCommit<Bytes<32>>(pk, blinding);
}
```

`addSigner` still publishes what it is given, and that is now safe because what it is given is inert: it identifies nobody and confirms no guess.

**The blinding factor is as precious as the signing key.** A signer who loses it cannot reproduce their own leaf and cannot act on the account, even though their key is intact. Recovery must cover both.

**It lives on that signer's device and nowhere else — and this rule was broken once, deliberately, and then restored.** M-99's removal design re-seated every surviving signer at a new generation, and a survivor's new leaf is `commit((publicKey, generation), blinding)`, which the account cannot compute without their blinding. Removing somebody would therefore have required every remaining signer to be online at that moment — the worst possible requirement for an operation that usually happens because somebody left abruptly. So the blindings were collected into the sealed roster instead, and this document was contradicted in a comment on `Signer.blinding`.

M-106 removed the need rather than the objection. A signer holds a slot, a removal clears that one slot, and nobody is re-seated — so no leaf but the departing one is ever recomputed. The blinding is out of the roster, out of the pending-signer drop box, and out of the API that used to accept it: the server can no longer receive one at all, which is a better guarantee than a promise not to keep it. **A test asserts the value appears nowhere in the store, ciphertext included.**

## What stays public, deliberately

Threshold, approval count, and the existence of an open proposal. These are what make the account auditable. Hiding them would break the product rather than improve it.

## Consequences

- Circuit cost is higher than a `Set` lookup. Accepted.
- The number of signers is observable from tree insertions. Accepted.
- An observer sees when signers were added, and how many. Not who. Accepted.
- If the plausible signer set is very small, an observer can test guesses against leaves. Mitigate by committing leaves with randomness rather than storing raw public key hashes, if this ever matters for a customer.

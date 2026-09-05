# 5. Approvals are gathered in parallel and submitted once

## Decision

Signers approve **off chain and in parallel**. Each approval is a signed intent held by the account service. Only when the threshold is met does anything reach the chain, as a single `execute`.

The chain keeps its role: it verifies M distinct authorised signers agreed, and learns neither who they were nor what the payload was.

## Why

The current flow puts one transaction on chain per approval — `propose`, `approve`, `approve`, `execute`. Measured, on both stacks:

| stack | per circuit |
| --- | --- |
| preview, ledger 8, Midnight.js 4.1.1 | 21.6s – 25.5s |
| Stagenet, ledger 9, Midnight.js 5.0 | 23.5s – 26.1s |

**None of that is ours to optimise.** Proving measures 1.4s and balancing 0.2–0.7s; the remaining ~22s is submission and waiting for the indexer to confirm — block time. Two different ledgers, two different fee models, and the number does not move.

So the cost is roughly linear in signers:

| signers | on-chain transactions | wall clock |
| --- | --- | --- |
| 2 of 3 | 4 | ~95s |
| 3 of 5 | 5 | ~120s |
| 4 of 7 | 6 | ~145s |

That is the whole cost of a payroll run, and it is spent on *coordination*, not on the payment. A CFO approving from a phone waits behind a colleague who has not opened the app yet.

The sequencing is also an artefact rather than a requirement. **Approvals are commutative.** Each is a nullifier derived from `(secret key, round, account)`; the contract inserts them into a set and counts. Nothing reads the order, nothing depends on B preceding C. The chain only cares that the count reaches the threshold before `execute`.

There is a real constraint underneath, and it is not ordering: **every approval must be for the same round**, because the nullifier is bound to it. Anything that rotates the round — `execute`, `cancel` — invalidates approvals already given. That is a correctness property worth keeping; it is what stops an approval being replayed against a different proposal.

## What this changes

Today the round is rotated by on-chain state, so gathering approvals means touching the chain. Under this decision the account service holds an open proposal and its collected approvals, and submits once:

- Signers see the payload (they hold the viewing key already, per decision 0002) and approve locally.
- The service collects approvals until the threshold is met. Signers never wait for each other.
- `execute` is submitted once, carrying the approvals. One block time, not N.

Fees move the same way: **one transaction instead of four**. On Stagenet a circuit costs 7.5e13 to 4.6e14 DUST, so this is a 4x reduction in the DUST budget for a 2-of-3 account, and more as the signer count grows.

## Consequences

- **The contract has to accept a batch.** `approve` currently burns one nullifier per transaction. Verifying M nullifiers inside `execute` is a larger circuit and a slower proof. Proving is 1.4s today against ~22s of block time, so there is a lot of headroom — but this needs measuring before it is believed, and it is the main technical risk in this decision.
- **The service becomes a coordination point, and therefore a censor.** It can withhold a collected approval. It cannot forge one — the nullifier requires the signer's secret — but it can stall. Decision 0001 already accepts this for the sponsor; this widens it. Signers need a path to submit their own approval on chain when they do not trust the service, which is exactly today's flow, kept as a fallback rather than deleted.
- **An approval in flight is now off-chain state that matters.** Today an approval is durable the moment it lands. Under this decision it is a signed object the service holds, and losing it means asking a signer again. It must be persisted and it must be authenticated.
- **"How many have approved" stops being publicly auditable in real time.** Today `approvalCount` is on chain and anyone can watch it. Under this decision the world learns nothing until execution. That is a privacy improvement and an auditability loss, and which one matters depends on the customer. Worth asking a design partner rather than assuming.
- **The round-binding constraint gets stricter, not looser.** Collected approvals are invalidated by anything that rotates the round. The service has to detect that and discard, or it will submit approvals the chain has already burned.

## Alternatives considered

**Keep it sequential.** Correct today, needs no contract change, and is the flow already proven on chain twice. It costs ~24s per signer and a transaction per approval. Fine for a pilot with two signers; poor for a treasury with five.

**Parallel submission of individual approvals.** Signers submit their own `approve` concurrently rather than in turn. Removes the queueing without a contract change — but they contend for the same wallet and the same DUST, and each still pays block time. It shortens the wall clock without reducing transactions or fees. A cheap intermediate step if the batch circuit proves expensive.

**Off-chain aggregation with a single signature.** Aggregate the M approvals cryptographically so `execute` verifies one object rather than M. Smallest circuit, most work, and it needs a scheme the Compact standard library supports. Worth revisiting once ECDSA support lands (SOW-02), not before.

## Status

Proposed. Not implemented. The sequential flow stays until the batch-verification circuit is measured, because the current one is proven on two stacks and this one is not.

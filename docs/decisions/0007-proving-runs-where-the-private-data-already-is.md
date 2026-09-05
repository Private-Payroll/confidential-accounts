# 7. Proving runs where the private data already is

## Decision

**We will never host a proof server that customers' transactions pass through.**
Proving happens on the customer's own device, or on infrastructure they control.

This is a product constraint, not an implementation preference. It outranks
convenience, onboarding friction, and our own operational cost.

## Why this was ever in question

Proving looked slow. `addSigner` sat for 369 seconds and never finished (M-34),
and the obvious answer to slow proving is a proving pool: bigger machines, warm
caches, work queued across many customers. It is what every other stack does.

Two things are wrong with it, and only one of them is about privacy.

## What a hosted prover would actually see

The SDK says it plainly. From `@midnight-ntwrk/midnight-js-types`:

> Interface for a proof server running in **a trusted environment**.

And the call itself, from `midnight-js-http-client-proof-provider`:

```ts
prove(serializedPreimage: Uint8Array, keyLocation: string, ...): Promise<Uint8Array>
```

**The preimage is the private input.** Not a commitment to it, not a blinded
form of it — the values themselves, serialised and sent. For this contract that
means a hosted prover would receive, per call:

| witness | what it is |
| --- | --- |
| `localSecretKey` | the signer's secret key |
| `signerBlinding` | the factor that hides them in the tree |
| `stateBalance`, `nextBalance` | **the account balance, before and after** |
| `changeAmount` | **the amount being paid** |
| `stateSalt`, `nextStateSalt`, `proposalSalt` | every blinding factor |

That is the entire product. A hosted proving service would hold the balance, the
payment amounts, and enough key material to act as the signer. "The server never
holds anything that decrypts" is the sentence the whole codebase is built around
— decision 0002 puts the viewing key on the client for exactly this reason, and
`SealedStateStore` is deliberately unable to read what it stores. Hosting proving
would make all of that theatre.

It would also be worse than a normal SaaS trust assumption, because the customer
cannot tell. A commitment on chain looks identical whether the proof was built on
their laptop or on our server.

## The performance argument no longer exists

This is the part worth being precise about, because it is what makes the decision
cheap rather than a sacrifice.

**Measured on Stagenet, 13 August, eleven circuits:**

| | |
| --- | --- |
| Total per circuit | 22.2s – 26.8s |
| Still proving at | ~2s |
| Already submitting by | 6s – 11s |
| Remainder | waiting for the indexer to confirm — **block time** |

Proving is not the bottleneck. It is a small fraction of a wall clock dominated
by consensus, and no amount of hardware moves the other ~20 seconds.

**The 369 seconds was never proving.** It was the dust wallet's fee balancer
looping on the main thread — 71,013 iterations, 1.4 GB — because
`computeBalancingRecipe` passed a fee as a positive imbalance where a shortfall
must be negative (M-46, M-48). It is fixed by a local patch, and `addSigner` now
settles in 22–27 seconds like everything else.

So the proving pool would have solved a problem we did not have, at the cost of
the only thing we actually sell.

## What this commits us to

**Proving keys must reach the device.** They are not small, but they are not
prohibitive:

| circuit | proving key |
| --- | --- |
| `attestSolvency` | 2.7 MB |
| `cancel` | 5.0 MB |
| `approve`, `credit` | 9.6 MB |
| `addSigner`, `execute`, `propose` | 11 MB |
| **total** | **57 MB** |

Downloaded once and cached. Verifier keys are 4 KB and live on chain.

**It is a swap, not a rewrite.** `ProvingProvider` is a two-method interface —
`check` and `prove` — and `createProofProvider(provingProvider)` builds the rest.
Today we pass `httpClientProvingProvider(localhost:6301)`. Anything implementing
those two methods drops in.

**We can still host everything that sees nothing.** The indexer reads public
chain state. The fee sponsor (decision 0001, M-4) receives an already-finalised
transaction: proven, with the values inside commitments. Neither is a privacy
boundary, and both are the parts that genuinely benefit from being centralised.

## What we cannot offer, and should stop implying

A zero-install, works-in-any-browser-tab product where we do the cryptography.
If a customer asks for that, they are asking us to see their payroll. The honest
answer is that the thing making this worth buying is the same thing that stops us
building it that way.

## Consequences

- **Onboarding gains a step.** A desktop application, a browser build that proves
  locally, or the customer running the proof server themselves. That is a real
  cost and it belongs in the pricing conversation, not hidden.
- **We cannot debug a customer's failing proof by reproducing it.** We will never
  hold the inputs. Diagnostics have to be built from what the device can safely
  report — which is a design constraint on error handling from now on.
- **The claim gets stronger, not weaker.** "We could not read your balance if we
  wanted to" is a sentence very few competitors can say, and it survives
  subpoena, breach and acquisition. It is worth more than the friction costs.

## Open, and deliberately not answered here

**Does browser-based proving actually work today?** The seam exists and the keys
are a downloadable size, but nothing in this repo has proved a transaction
outside the Docker proof server. That needs measuring before any commitment is
made to a browser product — an 11 MB key and a WASM prover on a mid-range laptop
is a very different measurement from a container on a developer's Mac.

That is the next question, and it is a measurement, not a decision.

## Status

Accepted. The performance evidence is measured; the privacy analysis is read from
the SDK's own types and documentation. The delivery mechanism for device-side
proving is open.

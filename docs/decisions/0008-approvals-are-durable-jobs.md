# 8. Approvals are durable jobs, not function calls

## Decision

Every slow action — approve, execute, credit, propose — is a **persisted job**
with a state machine, worked off the interaction thread, resumable after a
crash, and safe to interrupt.

This holds regardless of how fast proving gets.

## Why, and why it is not about the 108 seconds

M-78 measured in-process proving at ~82 seconds against the single-threaded WASM
prover, against ~0.9s for the containerised one. It would be easy to read this
decision as a workaround for that gap, and to expect it to become unnecessary if
the Foundation ships a threaded build.

It would not. Four of the five reasons survive any speed:

1. **Proving cannot run on the UI thread.** WASM proving does not make a page
   feel slow, it freezes it — no scrolling, no cancel button, the spinner itself
   stops animating. That is true at 3 seconds as much as at 108.
2. **Work must survive a closed tab.** Losing an approval because someone
   switched apps is data loss, not latency.
3. **There is always a gap between "you approved" and "the chain agrees."**
   Block time is ~23 seconds and is not ours to remove. Even a perfect prover
   leaves a wait that has to be represented honestly.
4. **Somebody has to be told when it finishes** if they looked away.
5. Only the fifth — batch queue management — is genuinely about slowness.

So the architecture is async-first because the *domain* is asynchronous, not
because the current prover is slow.

**Consequence worth stating plainly: the Foundation's answer stops being a
blocker.** Build now, and a threaded build later turns a 108-second bar into a
20-second one with nothing rewritten.

## The states

Named for what is true **on chain**, not for what the code is doing, because
that is what someone looking at the screen is actually asking.

| state | meaning |
| --- | --- |
| `queued` | accepted and durable, not started |
| `proving` | the expensive part |
| `proven` | proof in hand, not yet sent |
| `submitting` | sent, outcome unknown |
| `settled` | the chain agrees. Terminal |
| `failed` | terminal, with a reason a person can act on |
| `cancelled` | withdrawn before it settled |

## The split that matters

**Proving is pure. Submitting is not.**

A proof is a function of its inputs with no effect on chain, so an interrupted
proof can simply be redone — it costs time and nothing else.

A submitted transaction may settle whether or not we are still listening. So a
job found in `submitting` after a crash is in a genuinely unknown state, and the
two wrong answers are symmetrical:

- retry blindly → risk paying twice
- assume it failed → hide a payment that actually happened

The queue asks the chain instead, via `JobRunner.recover`. **Where no `recover`
is available it refuses to guess**, marks the job failed, and says what to check.
That is deliberately the least convenient option: an incorrect automatic answer
here is money.

## Concurrency is one

Not laziness. The prover is single-threaded, so two proofs in parallel
take twice as long each and nothing finishes sooner — the user watches two
spinners instead of one. Serial is simpler *and* faster.

Revisit only if a threaded prover arrives, and even then measure before changing
it.

## Isomorphic, deliberately

No DOM, no Node, no timers of its own. Storage and clock are injected. The same
file runs in a browser tab, in a Worker, in the macOS and iOS apps, and in tests.

A job model that only works in one of those is how the web and native clients
drift into disagreeing about what "approved" means — and this project already
has seven recorded instances of one rule written twice.

## Consequences

- **Notifications and optimistic UI hang off the change stream.** `onChange`
  fires on every transition, so both are subscribers rather than new mechanisms.
- **A reloaded tab resumes by reading `pending()`.** No special path.
- **Cancelling after submission is refused**, because a local "cancelled" on a
  transaction the chain may hold is a lie the UI would then tell the customer.
- **Proofs are not persisted.** They are large and reproducible; storing them
  trades a cheap recomputation for permanent storage on every device.
- **`recover` becomes a requirement on every real runner.** The simulated one
  can omit it and get the honest failure.

## Storage

`src/core/jobs-store.ts`. The backend interface is `get`, `set`, and
`keys(prefix)` — the largest thing IndexedDB, a file, `localStorage`, SQLite and
a Map can *all* provide. Not SQL, not queries, not indexes, because anything
richer would mean a second implementation for whichever environment could not
manage it, and the failure this project keeps repeating is one rule written
twice.

Values are strings rather than objects, so serialisation happens once, here, and
the on-disk shape cannot drift between a browser and a phone.

Jobs are per account and finish quickly, so there are tens of them rather than
millions. Reading all of them to find the pending ones is fine, and staying that
simple is what keeps the browser and native stores identical.

Three invariants worth naming, because each is a quiet failure rather than a
loud one:

- **Order is by `createdAt`, never by key.** Ids are opaque, so key order says
  nothing, and `pending()` takes the first — getting this wrong makes the queue
  unfair without ever erroring.
- **A corrupt record is skipped, not thrown**, and left on disk rather than
  deleted. One half-written job must not make every other pending approval
  unreadable, and the bad record may be the only trace of what someone tried.
- **Non-job keys are ignored.** Browser storage is shared with everything else
  the application keeps there.

## Status

Accepted and implemented in `src/core/jobs.ts` and `src/core/jobs-store.ts`.
Thirty-three tests, mutation-tested: removing the recovery check, the
blind-resubmit guard, the concurrency guard, the cancel guard, the `createdAt`
ordering, the corrupt-record tolerance, or the key prefix each fails a test.

Mutation also found a real defect: a store that fails to overwrite in
place made `drain()` loop forever rather than fail. It now stops after eight
steps on one job and throws, because a store that is not saving progress would
not save a `failed` state either.

Storage done. **Worker next.** UI deferred — infrastructure first.

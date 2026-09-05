# Decisions, and why

**This is the only file here that contains something not written down elsewhere.** A decision's
reasoning survives nowhere but in the head of whoever made it, and heads are not a storage medium.
Each links to its backlog entry for the argument in full.

## Money

**A vault holds money and decides nothing; an account decides and holds none.** An account is a
rulebook that outlives any particular pot of money. Also forced: a vault reads witnesses to spend,
and a cross-contract callee may not, so a vault can only ever be the caller. `V-1`, `V-39`

**A run ends by TIME, and nothing else ends it.** The obvious design — count the unpaid and close on
the last payment — is a read-modify-write of one entry by every payment of the run, which serialises
the exact thing the design exists to parallelise. So a run carries a window, payments assert they
fall inside it, and **completion is derived from what the chain recorded rather than asserted by
it.** No flag means no flag anybody can set wrongly. `V-61`, `V-67`

**A payment can happen at most once in ANY run, not once per proposal.** Keyed on the payee's leaf.
This is what lets a retry run reuse leaves and be submitted while the original is still open —
whichever lands first wins. Without it, safe retries and generous windows are mutually exclusive.
`V-64`

**`cancel` is refused once a run's window has OPENED**, not once it is approved. Before it opens
nothing has been paid, so cancelling strands nobody — which is what keeps a pre-approved future
month changeable. `V-52`, `V-67`

**Nothing about a run is random.** Per-payee secrets are derived from a payout seed in the account's
sealed state, so any admin rebuilds any run byte for byte. A five-signer account whose payroll
depends on one laptop being awake is a single point of failure wearing a multisig costume. `V-63`

**A note's blinding is derived from its nonce; nothing is stored.** A stored blinding is a second
copy of what the money depends on. `V-74`

## Reporting

**Four states, not two: paid, skipped, failed, unsent.** The chain records what was paid and cannot
record an intention not to pay, so a deliberately skipped leaver and a payment that failed four
times look identical on chain. On a hundred-person run that is how somebody goes unpaid for a month
without anyone noticing. `V-68`

**Skips are an append-only log with an author, a time and a reason.** A payroll decision with no name
on it is nobody's fault afterwards. `V-68`

## Governance

**Raising a proposal is not approving it, and `propose` will not be changed to auto-approve.** It
would quietly turn a three-of-five into a two-of-five — a security change made for a
user-interface convenience, and the kind nobody spots because nothing about it looks like a change
to the threshold. The client offers both as one action instead. `V-66`

## Delivery

**We do not tell payees they were paid. The platform does.** A shielded output to a user carries a
coin ciphertext attached at transaction assembly, and midnight-js **refuses to build the transaction**
if the payee's encryption key cannot be resolved. A delivery layer was built on the belief that it
did not — see `04-what-we-got-wrong.md`. `V-77`

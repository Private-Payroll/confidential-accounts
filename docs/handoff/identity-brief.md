# Identity — the brief

> **17 Aug: the shape decision below has been TAKEN, and the scope is written.**
> One shape was chosen for everybody — a set of factors, a rule, and one address — with a contract on
> chain as a switch. **`docs/scope-identity.md` is now the document to read**, and `A-1`/`A-2`/`A-3`
> in `BACKLOG.md` are the work. This brief stays as the statement of the problem.

You own identity. This says what it has to solve and where it plugs in. It does not say how.

Read `00-START-HERE.md` and `04-what-we-got-wrong.md` first. They are shorter than this.

## Why identity is next rather than more payroll

Payroll works and is tested. What it lacks is **people**. Today a "signer" is a keypair a test made
up, and a "payee" is 32 bytes somebody typed. Three open problems are parked behind identity rather
than behind effort — they are in `03-open-questions.md` — and every one of them is the same shape:
**a value that must belong to a real person is currently supplied by whoever happens to be building
the transaction.**

## What has to exist

**A company account somebody can create and operate.** The contract already does signers, M-of-N
thresholds, per-vault thresholds, adding and removing signers, and a viewing key that rotates when
somebody leaves. What does not exist is any of that reaching a human — invitations, devices,
recovery, or knowing which person a signer leaf belongs to.

**An employee who exists before they are paid.** Payroll needs two keys per payee and they are
different keys: the **coin public key** (who may spend it) and the **encryption public key** (who may
read about it). Both come out of a wallet. Neither has an origin story today.

**The seam that matters most: `PaymentFacts.payslipKey`.** It is the payee's encryption key, it
rides on the transaction rather than the circuit, and **a wrong one pays somebody a coin their wallet
will never show them, with nothing objecting anywhere.** `C7` in the money-loss register, `V-78`.
The fix is for that key to come from the payee's own onboarded account rather than an input. **This
is the single strongest reason identity is next.**

## What already exists that you should not rebuild

- **Sealed records with a key per purpose** — `src/core/sealed-records.ts`. Roster, policy, payroll,
  audit, inbox, proposals. Rotation re-seals everything.
- **A viewing key wrapped to each signer**, rotated on removal, with superseded epochs kept.
- **A payout seed in the account's sealed state** that every signer can derive run secrets from
  (`V-63`) — the pattern to copy when something must be shared among admins and nobody else.
- **A pending-signer inbox** for onboarding somebody who does not have the key yet.

## Constraints you cannot design around

- **An employee holds no DUST and must never need any.** They receive a first payment holding
  nothing. `V-5`
- **A contract cannot see its caller.** Scoping lives in identities and commitments, never in an
  access check.
- **Signers are an append-only merkle tree.** Removal clears a slot; it does not shrink the tree.
- **Anything touching an asset is P0**, and a failure mode goes in
  `docs/how-money-can-be-lost.md` when it is FOUND, not when it is fixed.

## Worth deciding early, because it changes the shape

An observation worth acting on: **this vault design generalises to individuals.** The extra
signers become a person's own devices, passkey, email or backup account — the same contract with a
different story around it. If that is real, identity is not "employees of a company", it is
"principals with multiple factors", and a company is one shape of principal. **Decide that before
modelling anything**, because retrofitting it means rewriting whatever you build first.

## How to work

Three standing audits are defined in `.claude/agents/` — a platform fact-checker, a money-safety
auditor and a test auditor. **Run the fact-checker before designing anything that assumes what
Midnight can or cannot do.** The most expensive mistake in this repo would have been caught by one
question to it.

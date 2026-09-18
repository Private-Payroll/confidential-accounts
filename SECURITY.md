# Security

This repository holds an M-of-N account layer and a payroll product built on it. **It moves other
people's salaries, and the privacy of a payment is part of what it promises.** A defect here can lose
money or disclose who was paid what.

`packages/identity/SECURITY.md` is the security policy for the key library specifically — key
derivation, recovery, pairing, passkeys, and where key material lives. **If your report concerns
keys, read that one too: it states its claims with the test that pins each, and says plainly which
claims nothing pins.**

## Reporting a vulnerability

**Please do not open a public issue, and please do not raise it in a pull request.**

Use GitHub's private vulnerability reporting on this repository — the **Security** tab, **Report a
vulnerability**. That opens an advisory visible only to you and the maintainers. How GitHub handles
the advisory is GitHub's behaviour, not this repository's.

**There is no security email address for this project.** The advisory flow above is the only channel
that is monitored. That is a fact about this project's process rather than a property of its code,
so nothing in the suite pins it and nothing can.

**Say so in the title if your report concerns any of these**, because they are the ones that are
acted on first:

- money that can be lost, on either the account path or the vault path
- a screen that promises more privacy than the settlement behind it delivers
- anything that lets a party learn who was paid, how much, or by whom
- key material reaching a place the documentation says it does not

## What we will do

We will acknowledge a report through the advisory. We will tell you what we found, whether we agree
it is a defect, and what we changed. **We do not currently offer a bounty, and we do not commit to a
fix deadline** — saying otherwise would be a promise nobody here has the standing to make.

If we disagree that something is a defect, you will get the argument rather than a decline.

## Scope

**In scope:** everything in this repository — the contracts under `contracts/src/`, the product under
`src/`, the wallet under `apps/wallet/`, the key library under `packages/identity/`, and the checks
under `.github/`.

**Out of scope, and said rather than implied:** the Midnight Network itself, the Compact compiler,
the proof server, the indexer, and the SDK packages this project depends on. If you find something in
one of those, it is worth reporting to the people who wrote it; we would be glad to know as well, but
we cannot fix it.

## What you should assume about this repository today

**The commit history has not been scanned end to end for secrets.** That is stated because the
absence of such a scan is exactly the thing a security page usually implies it has done.

What goes in from here is checked before a commit is made, against the secret files in the working
copy. **That check is not in this repository and you cannot audit it from anything you can read
here** — it is named only so that its absence from the published tree does not read as its absence
altogether. It is a control on what goes in from now on. **It is not a statement about what is
already there.**

**If you believe something sensitive is present in the history, report it through the advisory flow,
treat it as compromised, and rotate. Do not assume a rewrite has removed it.**

**Neither set of key material is in this repository, and only one of the two is pinned.**

The wallet's proving keys and BLS parameters are fetched from the wallet's own origin and checked
against SHA-256 pins in `apps/wallet/public/keys/manifest.json`, on every use, cached copies
included. **DESCRIPTION - CHECK BY READING** `apps/wallet/src/chain/key-material.ts`. A report that
those digests do not match what a build produces is a report we want.

**The contract's own proving and verifier keys are pinned by nothing.** They are built locally by
`npm run compact` and `npm run compact:vault -- --full`, neither of which writes a digest, and the
assertions that need them read them off disk. **That is a gap. It is written here rather than left
to be inferred from the paragraph above it, and it is not closed today.**

## A note on how claims are written here

`packages/identity/SECURITY.md` sets the standard this project holds security prose to: **every claim
is either pinned by a named test that goes red when it stops being true, or it is marked as a
description you can check by reading a named file.** Sentences that could be neither were removed
rather than softened, and where an earlier version of that document was wrong, the correction is left
in place rather than quietly deleted.

Hold anything written here to the same standard. A `file:line` in this project's documentation is a
place you can go and look, and one that does not resolve is a defect worth reporting on its own.

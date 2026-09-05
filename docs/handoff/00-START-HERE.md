# Start here

You are picking up a system that moves other people's salaries. Read this file, then
`01-what-exists.md`. Nothing else until you need it.

## The one rule for this folder

**These documents contain almost no facts of their own.** They are a map, the decisions and why they
were made, and what is still unknown. Everything factual is a pointer.

**If a document in this folder disagrees with the thing it points at, the thing it points at wins,
and the document is wrong and should be fixed.**

This is not tidiness. On 17 August a whole delivery feature — a contract change, two client modules,
two probes, a retention policy and a row in the money-loss register — was built on a *paraphrase* of
one sentence in our own reference. The sentence was true and narrow; the paraphrase was false and
general. The correct answer was two greps away the whole time. Once a fact stops looking like a
quotation, nobody re-checks it. See `04-what-we-got-wrong.md`.

## Where truth actually lives

| Question | Open |
|---|---|
| What can Compact / Midnight / the ledger / the indexer actually do? | `docs/midnight/00-INDEX.md` — start at its §1a contradictions table |
| How can money or access to money be lost? | `docs/how-money-can-be-lost.md` — the standing register |
| What is open, decided, or already tried? | `BACKLOG.md` — 273 entries, ids are permanent |
| Working rules for this repo | `CLAUDE.md` |
| Why the vault and account are shaped as they are | `docs/scope-vaults-and-settlement.md` |
| What identity is, and what a company and a person have in common | `docs/scope-identity.md` |
| **Why the vault client cannot talk to midnight-js, and the fix — `V-82`, the most urgent open item** | `docs/scope-vault-call-convention.md` |
| What the contracts do | the contracts. They are commented to be read |

## Before you build anything

1. **Ask whether the platform already does it.** Use the `platform-fact-checker` agent. This is not a
   formality — it is the specific failure this project has paid most for.
2. **Read the register.** If your change touches an asset, it belongs in
   `docs/how-money-can-be-lost.md` **when you find the failure, not when you fix it.**
3. **Check `BACKLOG.md`** for the id. Most things have been thought about; some have been decided
   and reversed.

## How to be trusted

Run it, do not reason about it. Every claim in this repo that turned out to be wrong was one
somebody was confident about. `./scripts/test-loop.sh N` for the suite, `MUTATE.command` for the
contracts (anything needing `compactc` or a chain runs against the real toolchain).

**Never pipe a test run into a filter without keeping the output.** Two intermittent failures were
lost that way before one was finally read — and it was a real defect, not flakiness.

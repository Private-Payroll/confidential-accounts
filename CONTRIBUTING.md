# Contributing

This is software that moves other people's salaries. The checks here are unusually strict and they
refuse rather than warn. That is deliberate, and the point of this page is that you meet each refusal
here rather than ten minutes into a run on somebody else's machine.

**Everything below was true of this repository when it was written, and every claim names the file
that decides it.** If a command here does not do what it says, that is a defect worth reporting.

## A clone, from nothing to a green suite

```bash
npm install
node .github/checks/fetch-compiler.mjs   # the compiler is a release asset, not a dependency
npm run compact:fast                     # the account contract
npm run compact:vault                    # the vault, second: its generated caller reaches the account's
npm run identity:build                   # the key library, consumed at its built output
npm test
```

**The middle four are the ones people miss, and each produces something this repository does not
carry.** `contracts/managed/`, `contracts/managed-vault/` and `packages/identity/lib/` are all build
output and none is committed. `npm test` re-runs the first of them through `pretest` and none of the
others, so a clone that skips them fails in a typecheck with a message about a missing module — and
the paragraph below has already taught you to read a missing module as a missing compiler.

`.github/actions/build/action.yml` is the same list in the same order, and it is what runs on a
machine that has never built this before.

**The compiler version is decided in one place: `.github/checks/toolchain.mjs`.** The fetch script
installs that version, `scripts/compile-contract.sh` reads the expected version out of that file
rather than repeating it, and the automated checks fetch it on every push. Nothing else may decide
it; anything else that states a version is a copy, and a copy is a thing that goes stale. The compiler's own version number and the
language version it accepts are different numbers, and a mismatch reports the second, which is why
nothing here is allowed to write the version down twice.

`npm test` is `vitest run`, and `pretest` runs ahead of it: `npm run compact:fast`, then all four
typechecks. So the single command compiles, typechecks four projects and runs the suite.

## Why there are four typechecks

There are four TypeScript projects, and a change that satisfies one can break another:

| command | project |
| --- | --- |
| `npm run typecheck` | `tsconfig.json` — the product: `src/`, `contracts/test/` |
| `npm run typecheck:scripts` | `tsconfig.scripts.json` — `scripts/` |
| `npm run typecheck:identity` | `packages/identity/tsconfig.json` — the key library |
| `npm run typecheck:wallet` | `apps/wallet/tsconfig.json` — the wallet application |

Run all four before you open a pull request. The automated checks run them as a four-way matrix, so
the page shows four marks and a failure names the project rather than a file in a list of four
thousand.

## Where a test goes

**Beside the source it exercises, in the same folder.** There is no top-level `test/` tree: a module
and its assertions move together, and a reader who opens one finds the other without looking.
`contracts/test/` is the exception and is not really one — those files drive compiled Compact
circuits in process rather than a TypeScript module, so they have no module to sit beside.

**Two naming shapes, and both are used on purpose.** A file that exercises one module takes that
module's name: `src/core/crypto.ts` and `src/core/crypto.test.ts`. A file that pins a property across
several modules is named after the property instead, as a sentence that reads like the thing that
must stay true — `src/core/nobody-is-paid-twice-by-a-retyped-month.test.ts`. **Prefer the second when
the assertion is the point.** A name that says what breaks is worth more in a list of failures than a
name that says which file somebody had open.

The suite collects from `src/`, `scripts/`, `contracts/test/`, `packages/identity/src/` and
`apps/wallet/`. `vitest.config.ts` is the one file that decides that.

## What the suite cannot do in a clone, and what is done instead

Some assertions read the proving and verifier keys, which an ordinary compile does not produce —
building them takes minutes and the artefacts are measured in megabytes, so they are not committed.
A separate job on every push builds those keys and runs exactly the eight files that need them.
`SECURITY.md` says which key material is checked against a digest and which is not.

**And about ten assertions read a module map that is derived rather than committed.** Without it they
stand down silently, so a local `npm test` is quieter than the one on the pull request. Derive it
first and they run:

```bash
npx tsx scripts/edge-list-run.ts
```

The order matters on the automated run and is worth knowing: `scripts/what-breaks.test.ts` is run
first and alone, while no map is on disk, because one of its assertions only means anything where
there is nothing to query. `README.md` records how many files and assertions a clone runs, and how
many do not run in one.

## Proposing a change

Open a pull request against `main`. Nothing is committed to `main` directly.

**A branch is `kind/some-short-name`**, kebab-case, at most 60 characters, where the kind is one of
`chore`, `docs`, `feat`, `fix`, `refactor`, `test`.

**A subject line is `kind(scope): what changed`**, imperative, at most 72 characters. The kinds a
subject may use are three wider than a branch's: `build`, `chore`, `ci`, `docs`, `feat`, `fix`,
`perf`, `refactor`, `test`. The scope is optional. Seventy-two counts the `(#123)` that is appended
when the pull request is merged, so a title that fits exactly will not.

**Both of those are decided by `.github/checks/commit.mjs` and nowhere else**, including the two
limits above. `npm run test:checks` runs two things: the rules' own tests, and
`.github/checks/watch-rules-refuse.mjs`, which takes each clause out one at a time on a copy and
requires the run to go red. **A clause whose removal changes nothing is a clause nothing is holding**
— and a run that collected no cases at all is named as such rather than counted as a success.

### What a message may not carry

**A change is described by what it does, not by who or what had a hand in it.** Attribution trailers
of every shape — `Signed-off-by:`, `Co-authored-by:`, anything matching `something-by:` at the start
of a line — are refused, as are lines saying what produced the change and the marks tools leave on
text they wrote.

**And three more that catch honest messages rather than careless ones**, so they are worth knowing
before you write rather than after: an email address anywhere in the subject or body; a path under a
home directory (`/Users/…`, `/home/…`, `~/…`, `C:\Users\…`), matched wherever it appears, including
inside backticks and inside a URL; and any dash that is not a plain hyphen — an em dash, an en dash
or a minus sign, which most editors will insert for you without being asked. The patterns are all in
`.github/checks/commit.mjs`, and every refusal names what resolves it.

This is not a style preference. The history of this repository is read by people deciding whether to
trust it with money, and a log that records provenance instead of behaviour tells them nothing they
can check.

## What runs, and when

On a pull request, and on a push to `main`, as separate jobs so a failure names itself: **compile**
the contracts, **typecheck** each of the four projects, **test** the suite, **keys** (build the
proving and verifier keys and run the eight files that need them), and **rules** (the checks' own
tests).

**On a pull request only: message**, which reads the title and body as the commit a squashed merge
will write, and the branch name with them. It is gated on the pull request event because there is no
title to read without one.

**Nothing runs on a push to your own branch.** `.github/workflows/ci.yml` decides all of this.

## The shape a change is expected to have

- **An assertion names the change that turns it red.** A test that cannot fail is worse than no test,
  because it reports coverage that is not there. If you cannot say what breaks an assertion, it is
  not finished.
- **A rule lives in a file something can import.** A check whose logic is only reachable by running
  the whole check is a check nobody can test. Put the decision in a module, and let the runnable
  thing be a thin caller of it.
- **A number is derived, not written down.** An assertion that hardcodes a count of files, or a list
  of paths a walk produced, goes red the day somebody legitimately adds or removes one — and it goes
  red in a clone, blaming the wrong thing. Assert the property, or intersect the expectation with
  what the walk actually found.
- **A comment says what the code does and why, in the product's own terms.** It names nothing a
  reader of this repository cannot open.

## Reporting a security problem

Do not open a public issue. `SECURITY.md` has the route.

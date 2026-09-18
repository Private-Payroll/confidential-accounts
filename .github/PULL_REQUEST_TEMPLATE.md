<!--
  The title becomes the commit subject when this is squashed, so it is held to
  the same rule: `kind(scope): what changed`, imperative, at most 72 characters
  INCLUDING the `(#123)` appended on merge. Kinds: build, chore, ci, docs, feat,
  fix, perf, refactor, test.

  A message may not carry: an attribution trailer (anything shaped
  `something-by:` at the start of a line), a line saying what produced the
  change, a mark left by a tool, an email address, a path under a home directory
  (/Users/..., /home/..., ~/..., C:\Users\...) anywhere at all including inside
  backticks and URLs, or any dash that is not a plain hyphen - an em dash, an en
  dash or a minus sign, which most editors insert for you without being asked.

  .github/checks/commit.mjs decides all of this and the `message` job refuses a
  pull request that breaks it, so it is cheaper to read this than to find out on
  the run. The last three catch honest messages rather than careless ones.
-->

## What changed

<!-- What is different now, and why. Wrapped at 72. Under about twenty lines. -->

## What turns it red

<!--
  For each assertion this pull request adds or changes: the change that makes it
  fail, and that you have watched it fail.

  This is the one section that is not a formality. An assertion nobody has seen
  fail is coverage that is not there, and it is worse than no assertion because
  it reports the opposite. "It would obviously fail" is not a measurement.
-->

## Checked

- [ ] `npm test` is green in a clean clone — it compiles the contracts and runs all four typechecks first
- [ ] every assertion added or changed has been watched turning red, and the section above says how
- [ ] no number that a walk or a list could derive is written down as a literal
- [ ] no comment names anything a reader of this repository cannot open
- [ ] if this moves or renames a file, every reference moved with it and the suite is green afterwards

## If this touches money or privacy

<!--
  Delete this section if it does not. If it does, say which of these it touches
  and what holds the line: a payment path, a key, an approval, what a screen
  promises about who can see what.
-->

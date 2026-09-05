#!/usr/bin/env bash
#
# ONE BRANCH NAME, AND NOTHING ELSE.
#
#   ./scripts/check-branch-name.sh feat/take-list-and-secret-scan
#
# Exit 0 and print one line if the name conforms. Exit 1 and say what it got and
# what it expected if it does not. **Reads only. Nothing is written, and no git
# command is run — this file does not know whether a repository exists.**
#
# ── THE CONVENTION ────────────────────────────────────────────────────────
#
#     type/kebab-description
#
# `type` is one of six: feat fix chore docs refactor test. The description is
# lower case, digits and hyphens, and it describes THE CHANGE.
#
#     feat/take-list-and-secret-scan
#     fix/mutation-harness-journal
#     chore/editorconfig
#
# ── WHY A BRANCH NAME IS CHECKED AT ALL, WHICH IS NOT OBVIOUS ─────────────
#
# **A BRANCH NAME IS PERMANENT AND PUBLIC AND NO LATER SWEEP REACHES IT.** The
# source sweep that will take the work-session ids out of this repository walks
# files; it cannot walk the names of merged branches, and neither can anybody
# else. A commit body can be amended before a push and a file can be edited
# afterwards. A branch name that reached a pull request is in the record for as
# long as the repository exists.
#
# So this refuses the two spellings that would put the process into that record:
# a work-session id used as a word, and the vocabulary of how work is organised
# here. Both lists are narrow ON PURPOSE and both are the spellings this project
# actually produces, taken from `PUBLIC-REPO-CONFIG.json`'s `process.patterns`
# rather than invented here.
#
# ── AND ONE THING IT DOES NOT CHECK, SAID HERE RATHER THAN DISCOVERED ────
#
# **IT DOES NOT REFUSE A PERSON'S NAME.** `PUBLIC-REPO-CONFIG.json`'s `person`
# rules derive the name from the running machine's home directory, and this file
# reads no config and runs no git precisely so it can be exercised anywhere. So
# the one artefact this header calls permanent, public and beyond every sweep is
# unguarded for the one thing rule 10 names first. The branch file is written by
# hand, by one person, on a private repository, before any push — which is why
# this is written down rather than half-solved here.
#
# ── AND IT REFUSES `main` BY NAME, WHICH IS THE POINT OF THE WHOLE FILE ───
#
# `main` is protected, every change arrives by pull request, and **GitHub does
# not enforce a ruleset on a private repository on the free plan** — the API
# answers `403` and will not even let one be read. So that protection is held by
# this and by nothing else. A refusal here is the whole mechanism.
#
# ── WHY IT IS A FILE OF ITS OWN RATHER THAN A BLOCK IN `COMMIT.command` ───
#
# The same argument `scripts/check-commit-subject.sh` makes, and it is the
# reason that file exists: a guard living inside `COMMIT.command` can only be
# exercised by running `COMMIT.command`, which means running git and making a
# commit. As a separate script it can be pointed at any string, so a conforming
# name, `main`, an unknown type and a round id can each be demonstrated in a
# second and without a repository. **A guard that quietly stopped refusing
# passes every positive test there is.**
#
set -uo pipefail

TYPES="feat fix chore docs refactor test"
NAME="${1-}"

refuse() {
  echo "  THE BRANCH NAME DOES NOT FOLLOW THE CONVENTION."
  echo
  echo "      got:       ${NAME}"
  echo "      expected:  type/kebab-description"
  echo
  echo "  $*"
  echo
  echo "      types:  ${TYPES}"
  echo "      The description is lower case, digits and hyphens, and it describes"
  echo "      THE CHANGE — never the process. No work-session ids, no round"
  echo "      numbers. A branch name is permanent and public and no sweep reaches"
  echo "      it afterwards."
  echo
  echo "      feat/take-list-and-secret-scan"
  echo "      fix/mutation-harness-journal"
  echo "      chore/editorconfig"
  exit 1
}

if [ -z "$NAME" ]; then
  refuse "Nothing was handed to this check, so there is no name to judge."
fi

# `main` FIRST, BEFORE THE SHAPE, AND THE ORDER IS THE USEFULNESS. Told that
# `main` "is not of the form type/description" a person fixes the form. Told
# that `main` is the protected branch, they make a branch. Two different
# mistakes reported as one is how a guard gets a reputation for being unhelpful.
case "$NAME" in
  main|master|HEAD)
    echo "  THAT IS THE PROTECTED BRANCH, NOT A BRANCH FOR A CHANGE."
    echo
    echo "      got:  ${NAME}"
    echo
    echo "  Every change here arrives on its own short-lived branch and is merged"
    echo "  by pull request. Nothing is committed to \`main\` directly."
    echo
    echo "  Name the CHANGE and try again — for example \`fix/stale-probe-rules\`."
    exit 1
    ;;
esac

if ! printf '%s' "$NAME" | grep -Eq '^[a-z]+/[a-z0-9][a-z0-9-]*$'; then
  case "$NAME" in
    */*/*) refuse "It carries more than one \`/\`. The convention is exactly one: the type, then the description." ;;
    */*)   refuse "The part after the \`/\` is not kebab-case: lower case, digits and single hyphens, starting with a letter or a digit." ;;
    *)     refuse "It has no \`/\` at all, so it names no type." ;;
  esac
fi

TYPE="${NAME%%/*}"
REST="${NAME#*/}"

KNOWN=0
for t in $TYPES; do [ "$TYPE" = "$t" ] && KNOWN=1; done
if [ "$KNOWN" != "1" ]; then
  # A typo'd type is worse than no convention, because it looks conventional
  # and sorts wrongly for ever.
  refuse "\"${TYPE}\" is not one of the types. That includes a type in the wrong case: the convention is lower case."
fi

# A WORK-SESSION ID USED AS A WORD. The prefixes are this project's own, taken
# from `PUBLIC-REPO-CONFIG.json`'s `process.patterns` — `S`, `SC`, `PI`, `R`,
# `X`, `T`, `C`, `M` — plus `MG` for the repository work.
#
# IT MATCHES A WHOLE HYPHEN-SEPARATED WORD, so `s71`, `sc19`, `mg3` and `t348`
# are refused while `erc-8004-registry` and `sha-256` pass — the digits there
# are not a whole word behind one of those letters.
#
# **IT ALSO REFUSES `x86`, `m1`, `s3`, `c4` AND `t3`, AND THAT IS MEASURED
# RATHER THAN DENIED.** An earlier version of this comment claimed *a real
# number in a real name is not* refused, which is true of the two examples it
# named and not true in general. **The identifier prefixes are one and two
# letters long, so a chip name and an identifier are the same string and no
# matcher can separate them. There is nothing to measure that would.**
#
# THE DIRECTION OF THE ERROR IS WHY IT STAYS STRICT. A false refusal costs one
# rename before anything exists. A false acceptance is a branch name in a public
# record that no sweep reaches, for as long as the repository exists.
for w in ${REST//-/ }; do
  if printf '%s' "$w" | grep -Eq '^(s|sc|pi|r|x|t|c|m|mg)[0-9]{1,4}[a-z]?$'; then
    refuse "\"${w}\" reads as a work-session id. A branch name describes the change; the id belongs in the account, which is not published."
  fi
done

# THE VOCABULARY OF HOW WORK IS ORGANISED HERE — AND IT IS SHORTER THAN THE
# OBVIOUS LIST, WHICH IS THE WHOLE CARE IN IT.
#
# `round`, `session` and `founder` ARE DELIBERATELY NOT HERE. Every one is also
# a word this PRODUCT uses about itself: a governance round, a sign-in session,
# and a founder of a company using the payroll. `src/api/sessions.ts`,
# `src/core/founder-payslip.test.ts` and
# `src/core/a-run-is-not-a-governance-round.test.ts` are the three that settle
# it. A branch fixing any of them would be refused by a check that read the word
# and not the meaning, and **a guard that refuses correct work is a guard people
# route around** — which costs more than the thing it was catching.
#
# What is left is unambiguous: nothing in this product is a controller, an
# auditor, or a brief. The ambiguous half is the source sweep's job, on files,
# where a person reads the sentence.
#
# AND THE NAMES OF THE TOOLS THAT WRITE CODE ARE NOT IN THIS LIST, WHICH IS
# DELIBERATE AND IS THE ONLY PART OF THIS FILE THAT COST AN ARGUMENT. **A list
# of words a file forbids is a list that file contains**, and this one ships. A
# check whose data discloses the thing it exists to keep out has published it in
# the act of forbidding it. That half is held where it does not ship —
# `src/testing/no-attribution.test.ts` scans every `.command` at this root for
# exactly those words, and its matcher data is a test's, not a shipped tool's.
for w in ${REST//-/ }; do
  case "$w" in
    controller|auditor|auditors|brief|briefs)
      refuse "\"${w}\" describes how work is done here rather than what changed."
      ;;
  esac
done

echo "  branch name conforms:  ${NAME}"
exit 0

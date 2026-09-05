#!/usr/bin/env bash
#
# THE FIRST LINE OF A COMMIT MESSAGE, AND NOTHING ELSE.
#
#   ./scripts/check-commit-subject.sh COMMIT-MESSAGE.md
#
# Exit 0 and print one line if the subject conforms. Exit 1 and say what it got
# and what it expected if it does not. **Reads only. Nothing is written.**
#
# ── THE CONVENTION, DECIDED 28 AUG ───────────────────────────────────────
#
#     type(scope): subject
#
# `type` is one of nine. `scope` is optional and is A PART OF THE SYSTEM —
# `vault`, `ledger`, `profile`, `commands` — never a round number. The subject
# is imperative and carries no trailing full stop.
#
# **THE BODY IS NOT TOUCHED AND HAS NO RULES HERE.** These repositories write
# long, argued commit bodies and that is the practice worth keeping; the
# convention is about the first line, so this reads the first line.
#
# ── THE LENGTH LIMIT, AND THE ARGUMENT THAT USED TO BE HERE AGAINST IT ───
#
# **THIS FILE USED TO SAY THERE WAS NO LENGTH LIMIT**, on the ground that *a
# limit that truncates is worse than a long line, and a limit that refuses is a
# rule nobody agreed to*. **THE FIRST HALF STILL HOLDS AND IS WHY THIS REFUSES
# RATHER THAN TRUNCATING. THE SECOND HALF STOPPED BEING TRUE ON 5 Sep**, when
# the maximum was written down as a rule with the measurement that produced it:
# the last three subjects this project wrote were **108, 73 and 119**
# characters, and every one is unreadable in a `git log --oneline`, in a pull
# request list and in every review tool a stranger will read this repository
# through. **72 IS THE NUMBER THE REST OF THE WORLD WRAPS AT** and it is not
# ours to re-argue.
#
# **AND IT IS ENFORCED HERE RATHER THAN IN `COMMIT.command` FOR THIS FILE'S OWN
# REASON**: a limit that can only be exercised by making a commit is a limit
# nobody demonstrates.
#
# ── WHY IT IS A FILE OF ITS OWN RATHER THAN A BLOCK IN `COMMIT.command` ──
#
# `COMMIT.command` runs git, so exercising a guard living inside it means
# running git. This one is called BY that script and can be run against any
# file, so both directions — a conforming subject passing, a prose sentence and
# an unknown type each refusing — are demonstrable without a repository, a
# staged tree or a commit. **A guard that stopped refusing passes every positive
# test there is**, and the only defence against that is a negative control that
# is cheap enough to actually run.
#
set -uo pipefail

TYPES="feat fix chore docs test refactor perf build ci"
FILE="${1:-COMMIT-MESSAGE.md}"

if [ ! -f "$FILE" ]; then
  echo "  THERE IS NO MESSAGE FILE AT ${FILE}."
  exit 1
fi

# `head -n 1` and not `read`: a file with no trailing newline still has a first
# line, and `read` returns non-zero on one, which would refuse a perfectly good
# message for the way its last byte was written.
SUBJECT="$(head -n 1 "$FILE")"

refuse() {
  echo "  THE COMMIT SUBJECT DOES NOT FOLLOW THE CONVENTION."
  echo
  echo "      got:       ${SUBJECT}"
  echo "      expected:  type(scope): subject"
  echo
  echo "  $*"
  echo
  echo "      types:  ${TYPES}"
  echo "      scope is optional and names a PART OF THE SYSTEM — vault, ledger,"
  echo "      profile, commands. A round name is not a scope; it belongs in the body."
  echo "      The subject is imperative and takes no trailing full stop."
  echo
  echo "  The body of ${FILE} is not read by this check and has no rules here."
  exit 1
}

if [ -z "$SUBJECT" ]; then
  refuse "The first line is empty, so the message begins with its body."
fi

# THE SHAPE FIRST, THE TYPE SECOND, and the order is the whole usefulness of
# this. A prose sentence and a typo'd type are different mistakes and a single
# regex reports them as the same one — which is how a guard gets a reputation
# for being unhelpful and then gets worked around.
if ! printf '%s' "$SUBJECT" | grep -Eq '^[a-zA-Z]+(\([^()]*\))?!?: .+'; then
  refuse "It is not of that shape at all — a prose sentence, most likely, which is what both repositories drifted into."
fi

TYPE="$(printf '%s' "$SUBJECT" | sed -E 's/^([a-zA-Z]+).*/\1/')"
REST="$(printf '%s' "$SUBJECT" | sed -E 's/^[a-zA-Z]+(\([^()]*\))?!?: //')"
SCOPE="$(printf '%s' "$SUBJECT" | sed -nE 's/^[a-zA-Z]+\(([^()]*)\)!?: .*/\1/p')"

KNOWN=0
for t in $TYPES; do [ "$TYPE" = "$t" ] && KNOWN=1; done
if [ "$KNOWN" != "1" ]; then
  # Named, and the valid ones listed. **A typo'd type is worse than no
  # convention**, because it looks conventional and sorts wrongly forever.
  refuse "\"${TYPE}\" is not one of the types. That includes a type in the wrong case: the convention is lower case."
fi

if [ -n "$SCOPE" ]; then
  if ! printf '%s' "$SCOPE" | grep -Eq '^[a-z0-9][a-z0-9._/-]*$'; then
    refuse "\"${SCOPE}\" is not a usable scope: lower case, digits, and . _ - / only."
  fi
  # NARROW ON PURPOSE, and the narrowness is the point. This refuses a scope
  # that is ONLY a round number — `r1a`, `s6`, `x19` — and nothing else. It
  # cannot tell a round name from a system name in general and does not try;
  # what it catches is the one spelling both repositories actually produce.
  if printf '%s' "$SCOPE" | grep -Eq '^[a-z]{0,2}[0-9]+[a-z]?$'; then
    refuse "\"${SCOPE}\" reads as a round name rather than a part of the system."
  fi
fi

case "$REST" in
  *.) refuse "The subject ends in a full stop." ;;
esac

# MEASURED IN CHARACTERS, NOT BYTES, AND WITHOUT ASKING THE MACHINE WHAT ITS
# LOCALE IS.
#
# `wc -m` counts CHARACTERS under a UTF-8 locale and BYTES under `C`. These
# repositories write em dashes constantly — three bytes each — so a subject
# measured under an inherited `C` locale is refused several characters early for
# a reason nobody can see on the screen, and a `.command` double-clicked from
# Finder inherits whatever a terminal profile happens to set.
#
# **AND THE FIX IS NOT TO SET A LOCALE, WHICH WAS THE FIRST ANSWER AND WAS
# WRONG.** `C.UTF-8` exists on most Linux and not on macOS; `en_US.UTF-8` exists
# on macOS and not on every Linux. A check that picks whichever it finds gives
# TWO DIFFERENT ANSWERS ON TWO MACHINES for the same subject — which is a test
# that is red on one filesystem and green on another, and this project has twice
# already dismissed one of those as flakiness.
#
# SO THE COUNT IS ARITHMETIC AND NOT A SERVICE. In UTF-8 every code point is one
# leading byte plus zero or more CONTINUATION bytes, and a continuation byte is
# always in the range `0x80`-`0xBF` and a leading byte never is. Deleting the
# continuation bytes therefore leaves exactly one byte per character, and `wc -c`
# counts them. Both `tr` and `wc` are pinned to `C` so they work on bytes and
# nothing about the machine can change the answer.
#
# **AN EARLIER VERSION OF THIS COMMENT GAVE A DIFFERENT AND FALSE REASON** —
# that bash's `${#SUBJECT}` counts bytes while `wc -m` does not. MEASURED: the
# two agree in both locales; it was the LOCALE that decided, not the tool. The
# false sentence is recorded rather than quietly replaced.
LEN="$(printf '%s' "$SUBJECT" | LC_ALL=C tr -d '\200-\277' | LC_ALL=C wc -c | tr -d ' ')"

if [ "$LEN" -gt 72 ]; then
  refuse "It is ${LEN} characters, and the maximum is 72. The detail belongs in the body, which this check does not read."
fi

echo "  subject line conforms:  ${SUBJECT}  (${LEN} characters)"
exit 0

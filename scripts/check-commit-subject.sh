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
# convention is about the first line, so this reads the first line. There is no
# subject length limit either: a limit that truncates is worse than a long line,
# and a limit that refuses is a rule nobody agreed to.
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

echo "  subject line conforms:  ${SUBJECT}"
exit 0

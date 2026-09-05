#!/usr/bin/env bash
#
# Compiles the Compact contract into contracts/managed.
#
# Exists because `compactc` is not on a default PATH: the devtools install it
# under ~/.compact/versions/<version>/<platform>/. Rather than making every
# developer export COMPACT_HOME before they can run the tests, this finds it.
#
# Usage:
#   ./scripts/compile-contract.sh            # skip proving keys, seconds
#   ./scripts/compile-contract.sh --full     # with proving keys, minutes
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/contracts/src/ConfidentialAccount.compact"
OUT="$ROOT/contracts/managed"

COMPACTC="$("$ROOT/scripts/find-compactc.sh" || true)"

if [ -z "$COMPACTC" ]; then
  cat >&2 <<'EOF'
compactc not found.

The contract tests run the compiled circuits, so the compiler is required to
run the full suite. Install it with:

    ./scripts/clone-midnight-src.sh

Or, to run only the core tests and skip the contract:

    npx vitest run src

EOF
  exit 1
fi

# zkir lives beside the real compactc and is found via PATH, so put that
# directory first. Resolve symlinks: the devtools' ~/.compact/bin entry is a
# symlink, and zkir is not there.
REAL="$(cd "$(dirname "$COMPACTC")" && pwd -P)"
export PATH="$REAL:$PATH"

# The compiler version is pinned, like everything else.
#
# `find-compactc.sh` picks the newest installed version, which is right until
# two are installed and the newest is not the one this project targets. The
# runtime does catch a mismatch — "compiled code expects 0.16.0, runtime is
# 0.18.0-rc.1" — but only after a full build and only when a test runs. Saying
# it here costs nothing and says it in the right place.
#
# Override with COMPACT_EXPECTED_VERSION= to build with something else on purpose.
EXPECTED="${COMPACT_EXPECTED_VERSION-0.33.0}"
ACTUAL="$("$COMPACTC" --version 2>/dev/null)"
if [ -n "$EXPECTED" ] && [ "${ACTUAL#*$EXPECTED}" = "$ACTUAL" ]; then
  cat >&2 <<EOF

  This project targets compactc $EXPECTED and found:

      $ACTUAL
      $COMPACTC

  The Stagenet stack needs 0.33.0-rc.2; compiling with an older compiler
  produces a contract the 0.18 runtime refuses to load, and you will not find
  out until a test or a deploy runs.

  Install the right one, or set COMPACT_EXPECTED_VERSION= to build anyway.

EOF
  exit 1
fi

# ZKIR v3, off by default and deliberately explicit.
#
# compactc 0.33.0-rc.2 ships two backends side by side — `zkir` and `zkir-v3` —
# and `--feature-zkir-v3` chooses. It is not a free choice: every major ZKIR
# release changes the format, verifier keys carry a versioned header
# (verifier-key[v6], [v7]), and a proof server that does not handle that header
# rejects the proof. The Q2 document says contracts built with the flag require
# the experimental proof-server build; it does not say which header Stagenet's
# node accepts, and that question is open with the Foundation.
#
# So: default off, one environment variable to turn on, and the choice recorded
# next to the build rather than remembered.
#
#   COMPACT_ZKIR_V3=1 ./scripts/compile-contract.sh --full
#
# It only affects a full build. `--skip-zk` does not run zkir at all, which is
# why the quick compile can go ahead before the question is answered.
ZKIR_FLAG=()
if [ -n "${COMPACT_ZKIR_V3:-}" ]; then
  ZKIR_FLAG=(--feature-zkir-v3)
fi

if [ "${1:-}" = "--full" ]; then
  if [ ${#ZKIR_FLAG[@]} -gt 0 ]; then
    echo "compiling with proving keys, ZKIR v3 ($("$COMPACTC" --version))"
  else
    echo "compiling with proving keys, default ZKIR ($("$COMPACTC" --version))"
    echo "  set COMPACT_ZKIR_V3=1 if Stagenet needs v3 — see BACKLOG M-54"
  fi
  # Same idiom as compile-vault.sh, for the same reason. This line has run
  # many times without failing and the reason it survives is NOT established —
  # which is why it is being made unambiguously safe rather than left alone.
  exec "$COMPACTC" ${ZKIR_FLAG[@]+"${ZKIR_FLAG[@]}"} "$SRC" "$OUT"
else
  # --skip-zk runs no zkir backend, so the flag is irrelevant here.
  echo "compiling without proving keys ($("$COMPACTC" --version))"
  exec "$COMPACTC" --skip-zk "$SRC" "$OUT"
fi

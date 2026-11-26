#!/usr/bin/env bash
#
# Compiles the contracts named, or every contract in the table when none is
# named, each into its own folder, in the table's order. The table is
# CONTRACT_TABLE in scripts/contract-sources.mjs: each contract's main file,
# the folder its compile writes, and the generated modules it imports by
# folder name, which are linked here after it compiles.
#
# Usage:
#   ./scripts/compile-contracts.sh [--full] [<contract> ...]
#     no --full   skip proving keys, seconds; keys still built from this code are kept
#     --full      with proving and verifier keys, minutes
#
# A contract that links to another is compiled after it in the table, so name
# them in that order when naming more than one.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FULL=""
if [ "${1:-}" = "--full" ]; then FULL=1; shift; fi

TABLE="$(node scripts/contract-sources.mjs --table)"
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then
  while IFS=$'\t' read -r name _; do WANTED+=("$name"); done <<< "$TABLE"
fi
for name in "${WANTED[@]}"; do
  if ! grep -q "^$name"$'\t' <<< "$TABLE"; then
    echo "no contract called \"$name\" in the table (scripts/contract-sources.mjs); nothing was compiled." >&2
    exit 2
  fi
done

COMPACTC="$("$ROOT/scripts/find-compactc.sh" || true)"
if [ -z "$COMPACTC" ]; then
  cat >&2 <<'MSG'
compactc not found.

The contract tests run the compiled circuits, so the compiler is required to
run the full suite. Install it with:

    export $(node .github/checks/fetch-compiler.mjs)

Or, to run only the core tests and skip the contracts:

    npx vitest run src

MSG
  exit 1
fi

# zkir lives beside the real compactc and is found through PATH. The devtools'
# ~/.compact/bin entry is a symlink and zkir is not there, so resolve it.
REAL="$(cd "$(dirname "$COMPACTC")" && pwd -P)"
export PATH="$REAL:$PATH"

# The compiler version is read from .github/checks/toolchain.mjs, the one place
# this repository declares it. Contracts that call each other must come from one
# compiler, and a contract compiled by another is refused by the runtime only
# when a test or a deploy loads it. COMPACT_EXPECTED_VERSION= builds with
# another compiler on purpose.
PIN_FILE="$ROOT/.github/checks/toolchain.mjs"
EXPECTED="${COMPACT_EXPECTED_VERSION-$(node -e "import('file://$PIN_FILE').then(m=>process.stdout.write(m.COMPACTC_REPORTS))" 2>/dev/null)}"
if [ -z "$EXPECTED" ] && [ -z "${COMPACT_EXPECTED_VERSION+x}" ]; then
  echo "  COULD NOT READ THE PINNED COMPILER VERSION from .github/checks/toolchain.mjs. Nothing has been compiled." >&2
  exit 2
fi
ACTUAL="$("$COMPACTC" --version 2>/dev/null)"
if [ -n "$EXPECTED" ] && [ "${ACTUAL#*$EXPECTED}" = "$ACTUAL" ]; then
  cat >&2 <<MSG

  This project targets compactc $EXPECTED and found:

      $ACTUAL
      $COMPACTC

  A contract compiled with another compiler is one the installed runtime
  refuses to load. Install the right one, or set COMPACT_EXPECTED_VERSION=
  to build anyway.

MSG
  exit 1
fi

# The keys every creation and deployment uses are built under the default ZKIR.
# COMPACT_ZKIR_V3 builds under version 3 only so the two can be measured side by
# side; never set it for a build anything is created or deployed from. A quick
# compile runs no zkir backend, so it reads no flag.
ZKIR_FLAG=()
if [ -n "${COMPACT_ZKIR_V3:-}" ]; then ZKIR_FLAG=(--feature-zkir-v3); fi

# Links each generated module this contract imports by folder name to the
# compiled folder of the contract it names. Relative, so the link holds from
# every path this folder is reached by.
link_modules () { # <table row>
  local row="$1" field folder to target
  for field in $(cut -f4- <<< "$row" | tr '\t' ' '); do
    folder="${field%%=*}"; to="${field#*=}"
    target="$(grep "^$to"$'\t' <<< "$TABLE" | cut -f3)"
    rm -rf "$ROOT/contracts/$folder"
    ln -s "$(basename "$target")" "$ROOT/contracts/$folder"
  done
}

# A quick compile does not throw away keys that still match the code: they are
# set aside, and put back only when .keys-version shows they were built from
# this same code; otherwise they move to _to_delete/ and the key build is owed.
compile_quick () { # <source> <compiled folder>
  local SRC="$1" REL="$2" OUT="$ROOT/$2" KEPT=""
  echo "compiling $SRC without proving keys ($ACTUAL)"
  if [ -d "$OUT/keys" ] && [ -f "$OUT/.keys-version" ]; then
    KEPT="$ROOT/contracts/.keys-kept-$(basename "$OUT")"; mv "$OUT/keys" "$KEPT"; cp "$OUT/.keys-version" "$KEPT.version"
  fi
  "$COMPACTC" --skip-zk "$ROOT/$SRC" "$OUT" || { RC=$?; if [ -n "$KEPT" ]; then mv "$KEPT" "$OUT/keys"; fi; return $RC; }
  node scripts/contract-version.mjs --record "$REL"
  if [ -n "$KEPT" ]; then
    cp "$KEPT.version" "$OUT/.keys-version"
    if node scripts/contract-version.mjs --current "$REL" .keys-version; then
      mv "$KEPT" "$OUT/keys"; echo "  the proving keys still match the code and are kept"
    else
      mkdir -p "$ROOT/_to_delete"; mv "$KEPT" "$ROOT/_to_delete/keys-$(basename "$OUT")-$(date +%s)"
      echo "  the code, the compiler or the key format changed: the old proving keys are set aside; run the key build"
    fi
    mv "$KEPT.version" "$ROOT/_to_delete/" 2>/dev/null || true
  fi
}

compile_full () { # <source> <compiled folder>
  local SRC="$1" REL="$2" OUT="$ROOT/$2"
  if [ ${#ZKIR_FLAG[@]} -gt 0 ]; then
    echo "compiling $SRC with proving keys, ZKIR v3 ($ACTUAL): for measuring only, never for creating or deploying"
  else
    echo "compiling $SRC with proving keys, default ZKIR ($ACTUAL)"
  fi
  # ${arr[@]+"${arr[@]}"}: an empty array under set -u is an unbound-variable
  # error on the bash macOS ships; this expands to nothing instead.
  "$COMPACTC" ${ZKIR_FLAG[@]+"${ZKIR_FLAG[@]}"} "$ROOT/$SRC" "$OUT" || return $?
  node scripts/contract-version.mjs --record "$REL"; cp "$OUT/.version" "$OUT/.keys-version"
}

for name in "${WANTED[@]}"; do
  ROW="$(grep "^$name"$'\t' <<< "$TABLE")"
  SRC="$(cut -f2 <<< "$ROW")"; REL="$(cut -f3 <<< "$ROW")"
  if [ -n "$FULL" ]; then compile_full "$SRC" "$REL"; else compile_quick "$SRC" "$REL"; fi
  link_modules "$ROW"
done

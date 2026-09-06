#!/bin/bash
#
# Compiles the VAULT contract. The account has its own script; this one exists
# because they are two contracts with two outputs, and one script compiling
# "the contract" would have to be told which.
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/contracts/src/Vault.compact"
OUT="$ROOT/contracts/managed-vault"

COMPACTC="$("$ROOT/scripts/find-compactc.sh")"
REAL="$(cd "$(dirname "$COMPACTC")" && pwd -P)"
export PATH="$REAL:$PATH"

ZKIR_FLAG=()
if [ -n "${COMPACT_ZKIR_V3:-}" ]; then ZKIR_FLAG=(--feature-zkir-v3); fi

#
# THE ACCOUNT'S GENERATED MODULE HAS TO SIT AT `contracts/Acct/`.
#
# A generated caller imports its callee BY PATH — the vault's index.js begins
#
#     import * as __compactContractsImport_Acct from '../../Acct/contract/index.js';
#
# and that path is relative to `contracts/managed-vault/contract/`, so two
# levels up is `contracts/` — NOT `managed-vault/`. Reading it as the latter
# cost one test run; the error is unmistakable when it happens
# ("Cannot find module '../../Acct/contract/index.js'") and invisible before.
#
# because the contract type it declares is called `Acct`. So a cross-contract
# call resolves the callee's CODE by directory name, and the address only
# chooses whose STATE is used. Getting this wrong produced a false result in
# `cross-contract-spike.ts` once already: a probe that believed it was calling a
# witness-reading contract was running the same module against someone else's
# state.
#
# Linked rather than copied, so recompiling the account cannot leave a stale
# callee behind for the vault to call.
#
link_account_module () {
  rm -rf "$ROOT/contracts/Acct"
  #
  # RELATIVE, not absolute. An absolute link records the path of whichever
  # machine made it — and this repo is worked on from more than one path: the
  # folder itself, and mounted views of it where the same folder has an entirely
  # different path. An absolute link made from one is a dangling link on the
  # other.
  #
  ln -s managed "$ROOT/contracts/Acct"
}

if [ "${1:-}" = "--full" ]; then
  echo "compiling the vault with proving keys ($("$COMPACTC" --version))"
  # ${arr[@]+"${arr[@]}"} rather than "${arr[@]}": an EMPTY array expanded
  # under `set -u` is an unbound-variable error on the bash macOS ships, and
  # this line had never run — `--full` was invoked by nothing until 28 Aug
  # and it failed in under a second the first time it was.
  # The idiom expands to nothing when the array is empty and to the flag when
  # it is not, on every bash version.
  "$COMPACTC" ${ZKIR_FLAG[@]+"${ZKIR_FLAG[@]}"} "$SRC" "$OUT"
  link_account_module
else
  echo "compiling the vault without proving keys ($("$COMPACTC" --version))"
  "$COMPACTC" --skip-zk "$SRC" "$OUT"
  link_account_module
fi

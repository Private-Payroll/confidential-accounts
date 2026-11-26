#!/usr/bin/env bash
#
# Compiles the vault through the one compile script (scripts/compile-contracts.sh),
# which also links the account's generated module where the vault's imports it,
# so compile the account first.
#
#   ./scripts/compile-vault.sh            skip proving keys, seconds
#   ./scripts/compile-vault.sh --full     with proving keys, minutes
#
set -euo pipefail
FLAG=()
if [ "${1:-}" = "--full" ]; then FLAG=(--full); fi
exec "$(dirname "${BASH_SOURCE[0]}")/compile-contracts.sh" ${FLAG[@]+"${FLAG[@]}"} vault

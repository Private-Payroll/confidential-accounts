#!/usr/bin/env bash
#
# Compiles the account and the registry, each into its own folder, through the
# one compile script (scripts/compile-contracts.sh), which reads the contract
# table and keeps proving keys still built from this code.
#
#   ./scripts/compile-contract.sh            skip proving keys, seconds
#   ./scripts/compile-contract.sh --full     with proving keys, minutes
#
set -euo pipefail
FLAG=()
if [ "${1:-}" = "--full" ]; then FLAG=(--full); fi
exec "$(dirname "${BASH_SOURCE[0]}")/compile-contracts.sh" ${FLAG[@]+"${FLAG[@]}"} account registry

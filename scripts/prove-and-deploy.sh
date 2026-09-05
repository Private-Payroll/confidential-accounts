#!/usr/bin/env bash
#
# M-2 and M-3: generate proving keys, start the proof server, and settle one
# real transaction against a local node.
#
# This needs a normal machine with Docker and open egress. `zkir` fetches
# Midnight's BLS structured reference string from S3 on first use, and the
# proof server is a Docker image.
#
# Everything up to here has been tested without proofs: 29 contract tests run
# the circuits in process and check the logic. What this script tests is the
# other half, and it is the half that can still surprise us. A circuit can be
# logically correct and still fail to prove, usually because it is too
# expensive. Nothing before this point would have told us.
#
# Usage:
#   ./scripts/prove-and-deploy.sh              # keys and proof server
#   ./scripts/prove-and-deploy.sh --with-node  # also start a local node
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Stagenet's node is built from ledger release crate-ledger-9.1.0.0-rc.3, whose
# proof-server/Cargo.toml reads 9.0.0-rc.3. That is the pin, and it is derived
# from midnight-node@d9729c13/Cargo.toml:445, not from a document.
#
# WAS 9.0.0-rc.5_experimental until 28 Aug 2026, on the authority of the
# Foundation stagenet component list (midnight-docs PR 1162) — a draft edited
# forward of the running network. rc.5 was published 7 Jul between ledger
# releases and is built from no release this node uses. Before that this script
# was still on 8.1.0 while every .command had moved, so the one path that proves
# AND deploys was the one path using a prover behind the chain it deploys to.
# Verifier keys carry a versioned header and a prover that does not handle it
# has its proofs rejected. docs/stagenet.md; DEPLOY-PREVIEW.command:32.
PROOF_SERVER_IMAGE="${MIDNIGHT_PROOF_IMAGE:-midnightntwrk/proof-server:9.0.0-rc.3}"
# 6301, NOT 6300, and the container is named for its tag. M-144: an 8.1.0 server
# has answered on 6300 on this machine, and two stacks sharing one port means
# whichever ran last silently serves the other. DEPLOY-PREVIEW.command:38-52.
PROOF_PORT="${PROOF_PORT:-${MIDNIGHT_PROVER_PORT:-6301}}"
PROOF_TAG="${PROOF_SERVER_IMAGE##*:}"
PROOF_NAME="midnight-proof-server-${PROOF_TAG//[^a-zA-Z0-9_.-]/-}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

say "Preflight"

command -v docker >/dev/null 2>&1 || fail "docker not found. The proof server is a container."
docker info >/dev/null 2>&1 || fail "docker is installed but the daemon is not running."
echo "  docker ok"

# The SRS download is the step most likely to fail behind a corporate proxy,
# and its error message does not say so. Check it explicitly first.
SRS_URL="https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com/bls_midnight_2p14"
if curl -sfI --max-time 20 "$SRS_URL" >/dev/null 2>&1; then
  echo "  midnight SRS reachable"
else
  fail "cannot reach the Midnight SRS bucket.

Proving key generation downloads it on first run and will fail without it.
If you are behind a proxy or VPN, that is the likely cause.
  $SRS_URL"
fi

# ---------------------------------------------------------------- M-2

say "M-2: compiling with proving keys"
echo "  first run downloads the SRS and takes a few minutes"

time "$ROOT/scripts/compile-contract.sh" --full

KEYS="$ROOT/contracts/managed/keys"
if [ -d "$KEYS" ] && [ -n "$(ls -A "$KEYS" 2>/dev/null)" ]; then
  echo
  echo "  proving keys:"
  ls -lh "$KEYS" | tail -n +2 | awk '{print "    " $9 "  " $5}'
else
  fail "compile finished but no proving keys were produced in $KEYS"
fi

# Circuit cost is the thing to watch. A circuit that proves in 30 seconds on a
# laptop is a product that feels broken.
say "Circuit sizes"
find "$ROOT/contracts/managed" -name '*.zkir' -exec ls -lh {} \; \
  | awk '{print "  " $9 "  " $5}' || true

# ---------------------------------------------------------------- proof server

say "M-2: proof server"

if curl -sf --max-time 5 "http://localhost:$PROOF_PORT/health" >/dev/null 2>&1; then
  echo "  already running on :$PROOF_PORT"
else
  echo "  starting $PROOF_SERVER_IMAGE on :$PROOF_PORT"
  # NOT --rm, and reused rather than recreated: the server downloads a shared
  # reference string on its first proof and --rm throws it away every run.
  docker start "$PROOF_NAME" >/dev/null 2>&1 || \
    docker run -d --name "$PROOF_NAME" \
      -p "$PROOF_PORT:6300" "$PROOF_SERVER_IMAGE" midnight-proof-server -v >/dev/null
  for i in $(seq 1 30); do
    sleep 2
    if curl -sf --max-time 5 "http://localhost:$PROOF_PORT/health" >/dev/null 2>&1; then
      echo "  up after $((i * 2))s"; break
    fi
    [ "$i" = 30 ] && fail "proof server did not become healthy. Try: docker logs $PROOF_NAME"
  done
fi

# ---------------------------------------------------------------- M-3

if [ "${1:-}" != "--with-node" ]; then
  cat <<EOF

M-2 done. Proving keys exist and the proof server is up on :$PROOF_PORT.

M-3 needs a local node as well. Re-run with:

    ./scripts/prove-and-deploy.sh --with-node

The proof server is left running on purpose: it keeps the parameters it
downloaded, and every other script here reuses the same container.

EOF
  exit 0
fi

say "M-3: local node"
NODE_COMPOSE="$ROOT/../midnight-src/midnight-node-docker"
[ -d "$NODE_COMPOSE" ] || fail "midnight-node-docker not found at $NODE_COMPOSE.
Run ./scripts/clone-midnight-src.sh first."

echo "  compose files are in $NODE_COMPOSE"
echo "  deployment is not scripted yet: it needs the wallet and indexer wiring"
echo "  from M-4 and M-5, which are not written."

cat <<'EOF'

What is still missing before a transaction can settle:

  M-4  FeeSponsor. Two-phase balancing, per decision 0001. The customer
       balances shielded and unshielded, the sponsor balances dust only.
  M-5  MidnightLedger.buildCall and readContractState. Both throw today.

Neither is blocked by anything except being written. Report back what the
proving key step above cost in time and size, since that is the number that
decides whether in-browser proving is viable or whether every signer needs a
local proof server.
EOF

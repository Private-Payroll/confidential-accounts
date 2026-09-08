#!/usr/bin/env bash
#
# Reproduces the Midnight development environment: the Foundation's source
# repositories, the Compact toolchain, and the compiler.
#
# Why clone all of this rather than read the docs site: the docs site is a
# subset. The two questions that gated this project for months were both
# answered by files that are in these repos and not on the site, specifically
# the DUST sponsorship example and the wallet custody matrix. Having them local
# also means the build does not depend on the open internet.
#
# Usage:
#   ./scripts/clone-midnight-src.sh              # everything, about 1.2 GB
#   SLIM=1 ./scripts/clone-midnight-src.sh       # skip the heavy repos, about 180 MB
#   DEST=~/src/midnight ./scripts/clone-midnight-src.sh
#
set -euo pipefail

# The clone lands INSIDE this repository, and is gitignored. The folder is meant to be
# self-contained: everything needed is reachable from here, and nothing above
# this directory ever has to be opened. The wallet reaches it at `../midnight-src`.
DEST="${DEST:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/midnight-src}"
SLIM="${SLIM:-0}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

# ---------------------------------------------------------------- repos
#
# Marked heavy where a shallow clone still costs more than 100 MB. SLIM=1 skips
# those. The two you actually need for reference are midnight-docs and
# midnight-expert, and midnight-expert is small.

CORE=(
  "midnightntwrk/midnight-expert     plugins, skills and about 37k lines of reference docs"
  "midnightntwrk/example-bboard      the canonical tutorial DApp, end to end"
  "midnightntwrk/example-counter     the smallest complete example"
  "midnightntwrk/midnight-node-docker  compose files for a local node"
  "OpenZeppelin/compact-contracts    Ownable, Pausable, FungibleToken in Compact"
  "LFDT-Minokawa/compact             Compact compiler source, current home"
)

HEAVY=(
  "midnightntwrk/midnight-docs       docs source. has the DUST sponsorship example"
  "midnightntwrk/midnight-js         the SDK monorepo"
  "midnightntwrk/midnight-node       the node"
  "midnightntwrk/midnight-indexer    the indexer"
  "midnightntwrk/midnight-ledger     ledger internals"
  "midnightntwrk/compact             read-only archive. holds the compiler release artifacts"
)

clone_one() {
  local slug="${1%% *}" name
  name="$(basename "$slug")"
  if [ -d "$DEST/$name/.git" ]; then
    note "have  $name"
    return
  fi
  if git clone --depth 1 -q "https://github.com/$slug.git" "$DEST/$name" 2>/dev/null; then
    note "ok    $name"
  else
    note "FAIL  $name  (renamed, moved, or private now)"
  fi
}

say "Cloning Midnight sources into $DEST"
mkdir -p "$DEST"
for r in "${CORE[@]}"; do clone_one "$r"; done
if [ "$SLIM" = "1" ]; then
  note "skipping heavy repos (SLIM=1)"
else
  for r in "${HEAVY[@]}"; do clone_one "$r"; done
fi

# ---------------------------------------------------------------- toolchain

say "Compact toolchain"

# THE DEVTOOLS WRAPPER IS NOT INSTALLED HERE EITHER, AND FOR A SHARPER REASON
# THAN THE COMPILER BELOW: it was fetched from `latest`, which is not a pin at
# all, so what a stranger got depended on the day they ran this. Nothing in this
# repository calls it - every build step finds the compiler through
# `COMPACT_HOME` or `scripts/find-compactc.sh` - so it was installing an
# unpinned tool that nothing here uses.
if command -v compact >/dev/null 2>&1; then
  note "devtools present: $(compact --version), and nothing here uses them"
fi

# THE COMPILER IS NOT INSTALLED HERE ANY MORE, AND THAT IS THE FIX RATHER THAN
# THE OMISSION.
#
# This block used to download a compiler of its own: a version pinned here, from
# a publisher named here, unpacked to a path computed here. Three separate files
# then declared which compiler this repository is built with, they disagreed, and
# the one a reader was sent to - this one - installed a version the build script
# refused. Somebody following the instructions could not build.
#
# `.github/checks/toolchain.mjs` is the single declaration now, and
# `.github/checks/fetch-compiler.mjs` installs exactly what it names. Both ship,
# both run on every push, so the path a stranger is sent down is the path proven
# on a machine that has never built this before - and it covers one more kind of
# machine than the block that was here.
say "Compiler"
note "installing the pinned compiler with the program the checks use"
if node "$(dirname "${BASH_SOURCE[0]}")/../.github/checks/fetch-compiler.mjs"; then
  note "compiler ready"
else
  echo ""
  echo "  THE COMPILER WAS NOT INSTALLED, and its own words are above."
  echo "  Nothing else here depends on it, so the source clone below is unaffected."
  echo ""
fi

# ---------------------------------------------------------------- verify

say "Verifying"
# Deliberately not `command -v compactc`. The devtools leave a symlink at
# ~/.compact/bin/compactc whose launcher resolves its own directory with
# `dirname $0`, so through the symlink it cannot find its own binary. The
# compiler is fine; that entry point is not. find-compactc.sh verifies a
# candidate by running it.
RESOLVED="$("$(dirname "${BASH_SOURCE[0]}")/find-compactc.sh" 2>/dev/null || true)"
if [ -n "$RESOLVED" ]; then
  note "toolchain $("$RESOLVED" --version), language $("$RESOLVED" --language-version)"
  note "at $RESOLVED"
else
  note "no working compactc found. Re-run this script, or see the manual"
  note "installation notes in compact/prerelease/README.md."
fi

cat <<'EOF'

Next
----
  npm run compact:fast     compile the contract, skip proving keys (seconds)
  npm run compact          full compile with proving keys (minutes, needs egress
                           to Midnight's SRS bucket on first run)

  docker run -d --name midnight-proof-server-9.0.0-rc.3 -p 6301:6300 \
      midnightntwrk/proof-server:9.0.0-rc.3 midnight-proof-server -v
                           (6301, not 6300: an 8.1.0 server has answered on 6300
                            on this machine and the two must not share a port)

Worth reading first
-------------------
  midnight-docs/static/midnight-wallet/snippets/dust-sponsorship.ts
      Who pays fees for an account that is not a person. The whole answer.

  midnight-docs/sdks/community/wallets/wallets-overview.mdx
      The custody matrix. The account abstraction row is empty, which is the
      reason this project exists.

  midnight-expert/plugins/compact-core/skills/compact-patterns/references/
      Seven pattern files. governance-patterns.md is the reference multisig,
      and its own privacy notes explain why we did not use it.
EOF

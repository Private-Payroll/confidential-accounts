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

if command -v compact >/dev/null 2>&1; then
  note "devtools present: $(compact --version)"
else
  note "installing devtools"
  curl --proto '=https' --tlsv1.2 -LsSf \
    https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.compact/bin:$PATH"
fi

# The normal path. It queries the GitHub API, which is fine on a laptop and
# blocked in some CI and sandbox environments, hence the fallback below.
if compact update 2>/dev/null; then
  note "compiler installed via devtools"
else
  note "devtools update failed (usually GitHub API rate limiting)"
  note "falling back to a direct release download"

  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  PLAT=aarch64-darwin ;;
    Darwin-x86_64) PLAT=x86_64-darwin ;;
    Linux-x86_64)  PLAT=x86_64-unknown-linux-musl ;;
    *) echo "unsupported platform: $(uname -s)-$(uname -m)"; exit 1 ;;
  esac

  # Pin deliberately. The language version the compiler accepts is not the same
  # number as the toolchain version, and a mismatch fails with an unhelpful
  # "language version X mismatch". Toolchain 0.31.1 speaks language 0.23.0,
  # which is what contracts/src is written against.
  V="${COMPACTC_VERSION:-0.31.1}"
  URL="https://github.com/midnightntwrk/compact/releases/download/compactc-v$V/compactc_v${V}_${PLAT}.zip"

  TARGET="$HOME/.compact/versions/$V/$PLAT"
  mkdir -p "$TARGET"
  note "downloading compactc $V for $PLAT"
  curl -sL -o "$TARGET/c.zip" "$URL"
  unzip -oq "$TARGET/c.zip" -d "$TARGET"
  rm "$TARGET/c.zip"
  chmod +x "$TARGET"/* 2>/dev/null || true

  say "Add this to your shell profile"
  echo "  export COMPACT_HOME=\"$TARGET\""
  echo "  export PATH=\"\$COMPACT_HOME:\$PATH\""
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

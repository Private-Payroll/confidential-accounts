#!/usr/bin/env bash
#
# Prints a working path to compactc, or exits 1.
#
# Why this is not just `command -v compactc`:
#
# The Compact devtools put a symlink at ~/.compact/bin/compactc pointing at the
# real launcher under ~/.compact/versions/<version>/<platform>/. That launcher
# resolves its own directory with `dirname $0`, which does not follow symlinks,
# so invoked through the symlink it looks for compactc.bin next to the symlink
# and fails with:
#
#     ~/.compact/bin/compactc: line 4: ~/.compact/bin/compactc.bin: No such file
#
# The compiler is installed and fine. Only that one entry point is broken. So
# candidates are ordered real-paths-first, and every candidate is verified by
# running it rather than by existing.
#
set -uo pipefail

# Works, and reports a version. A launcher that runs but prints nothing is the
# broken symlink case and must not be accepted.
works() {
  [ -x "$1" ] || return 1
  local v
  v="$("$1" --version 2>/dev/null)" || return 1
  [ -n "$v" ]
}

candidates() {
  # Explicit override wins.
  [ -n "${COMPACT_HOME:-}" ] && echo "$COMPACT_HOME/compactc"
  # Real installed versions, newest first. -V so 0.31.1 sorts above 0.9.0.
  ls -d "$HOME"/.compact/versions/*/*/compactc 2>/dev/null | sort -Vr
  # PATH last, because that is where the broken symlink lives.
  command -v compactc 2>/dev/null
}

while IFS= read -r c; do
  [ -n "$c" ] || continue
  if works "$c"; then echo "$c"; exit 0; fi
done < <(candidates)

exit 1

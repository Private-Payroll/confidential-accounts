# shellcheck shell=bash
#
# THE PROOF SERVER, DECIDED BY WHAT THE PORT ANSWERS.
#
# SOURCED, NEVER EXECUTED. `. scripts/proof-server-lib.sh`
#
# ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
#
# On 28 Aug a deploy proved against `9.0.0-rc.5_experimental` and the report said
# it had proved against `9.0.0-rc.3`, under a tick, on adjacent lines:
#
#     OK: started
#     OK: the server on 6301 was started from the pinned image
#     image     midnightntwrk/proof-server:9.0.0-rc.3
#     /version  9.0.0-rc.5
#
# The mechanism: `MEASURE-PROVING.command` leaves its container running on
# purpose — stopping it discards the shared reference string it downloads on its
# first proof — so the rc.5 server still held 6301. `docker start` found no
# rc.3 container, `docker run` then failed with
#
#     Bind for 0.0.0.0:6301 failed: port is already allocated
#
# into the report and nowhere else, the 30x2s wait loop found `/health`
# answering — the OTHER server answering — and the post-start check compared
# `docker inspect` of the container the script MEANT to run against the image
# the script MEANT to use. Two beliefs agreeing with each other. Nothing in that
# chain ever asked the port.
#
# **THE ONLY THING THAT CAN SETTLE WHAT IS ON A PORT IS WHAT THE PORT ANSWERS.**
# So `/version` is asserted here, not printed, and a mismatch is a hard stop.
#
# ── WHAT IS COMPARED, AND WHAT IS DELIBERATELY IGNORED ───────────────────────
#
# COMPARED: the VERSION CORE — the image tag with any `_experimental` suffix
# removed, against `/version`'s first whitespace-separated token with any
# `_experimental` suffix removed. `9.0.0-rc.3` against `9.0.0-rc.3`.
#
# IGNORED: the `_experimental` suffix, on both sides, ON PURPOSE. `R1b`
# recorded that an exact string match is unsafe: the `9.0.0-rc.5_experimental`
# image answers `/version` with the bare `9.0.0-rc.5`, so requiring the suffix
# would refuse a server that is what it claims to be. The suffix is the
# `experimental` cargo feature — zkir-v3 — and this project compiles with
# default ZKIR with `COMPACT_ZKIR_V3` unset, so it is not a difference we can
# act on anyway. `docs/stagenet.md`, "The proof server, and why this is the
# suspect".
#
# THE COST OF IGNORING IT IS STATED RATHER THAN HIDDEN: an
# `X_experimental` server passes as `X`. That is accepted because no
# `9.0.0-rc.3_experimental` image exists, and because the failure this check
# exists to catch — rc.5 answering for rc.3 — differs in the core.
#
# NOT COMPARED: `docker inspect`'s image. It is still PRINTED, because knowing
# which container is there is useful, but it decides nothing. It is the belief
# that lied.
#
# ── OUTCOMES, EACH NAMED ─────────────────────────────────────────────────────
#
#   REUSED           the port already answers and its core is the pin. This is
#                    CORRECT and is not a fallback: restarting a matching server
#                    would discard its downloaded parameters for nothing.
#   STARTED          nothing answered, we started one, and it answers the pin.
#   PORT HELD        `port is already allocated` — NOT a failure to start.
#                    Something else is here. Its container, image and `/version`
#                    are printed and the run refuses.
#   WRONG SERVER     the port answers and its core is not the pin. Refuses.
#   NO ANSWER        started and never came up. Refuses.
#
# Every refusal names `STOP-PROVER.command`, because a stray proof server is now
# a routine state and "free the port" is not an instruction anybody can run.
#
# ── HOW TO PROVE THE ASSERTION REFUSES, WITHOUT DOCKER ───────────────────────
#
# Set `MIDNIGHT_PROOF_VERSION_PIN` to a core the running server cannot answer:
#
#     MIDNIGHT_PROOF_VERSION_PIN=0.0.0-never ./DEPLOY-PREVIEW.command
#
# It overrides ONLY the version core the check compares against; the image, the
# container name and the port are untouched. A run under it must stop in step 3
# with WRONG SERVER and must not reach the deploy.
#
# ── CALLERS ──────────────────────────────────────────────────────────────────
#
# `DEPLOY-PREVIEW.command` and `MEASURE-PROVING.command` both source this and
# both call `proof_server_ensure`. They had one copy of the hole each and `R1c`
# closes it once: SHARED, not fixed twice. The two files' proof-server blocks
# were already "copied rather than restated" (MEASURE-PROVING.command:74-76),
# which is the arrangement that let the same defect exist in both.
#
# Before sourcing, a caller sets: PROOF_IMAGE, PROOF_NAME, PROVER_PORT,
# PROVER_URL, and optionally REPORT plus `ok`/`bad` functions.

# The version core of a version-ish string: first token, no CR/LF, no
# `_experimental` suffix. Empty in, empty out.
proof_version_core() {
  printf '%s' "$1" | tr -d '\r\n' | awk '{print $1}' | sed 's/_experimental$//'
}

# What the port answers right now, raw and untouched. Empty means nothing
# answered — which is a different thing from answering something unexpected,
# and the caller must keep them apart.
proof_version_seen() {
  curl -s --max-time 5 "${PROVER_URL}/version" 2>/dev/null | tr -d '\r\n' | cut -c1-120
}

# Everything docker is publishing on a port, one row each. Not filtered to our
# container name on purpose: the whole point is what ELSE might be there.
proof_port_holders() {
  docker ps --filter "publish=$1" --format '{{.Names}}   {{.Image}}   {{.Ports}}' 2>/dev/null
}

# The container whose image `docker inspect` reports for our name. PRINTED,
# never compared. Kept so a report says which container was in the way.
proof_container_image() {
  docker inspect --format '{{.Config.Image}}' "$PROOF_NAME" 2>/dev/null
}

# Both fallbacks exist so this file can be sourced by a script that has not
# defined them, rather than failing in a way that names none of this. A caller
# that HAS defined them keeps its own, so the report keeps one voice.
if ! type ok >/dev/null 2>&1; then
  ok() { echo "  OK: $*"; }
fi
if ! type bad >/dev/null 2>&1; then
  bad() { echo "  PROBLEM: $*"; }
fi

# Says the same thing to the terminal and to the report, when there is one.
proof_say() {
  echo "$*"
  [ -n "${REPORT:-}" ] && echo "$*" >> "$REPORT"
  return 0
}

# Printed by every refusal. A refusal that cannot be acted on without a shell is
# not a refusal, it is a dead end.
proof_refusal_footer() {
  proof_say ""
  proof_say "  Nothing was proved and nothing was spent."
  proof_say ""
  proof_say "  Run STOP-PROVER.command. It lists every container publishing 6300 or"
  proof_say "  6301 with its image and its /version, asks once, stops those and stops"
  proof_say "  nothing else. Then run this file again."
  proof_say ""
  proof_say "  Or set MIDNIGHT_PROVER_PORT to a port nothing is using."
}

# The whole flow. 0 = a server matching the pin is on the port. 1 = refuse.
#
# THERE IS NO FALLBACK IN HERE AND THAT IS THE DESIGN. Not another port, not
# another image, not "start it and hope". A fallback is what this hole silently
# was: the wait loop treated somebody else's healthy server as our own.
proof_server_ensure() {
  local pin_core seen seen_core start_out
  # The pin comes from the image tag unless a run is deliberately forcing a
  # mismatch to prove this check refuses.
  pin_core="$(proof_version_core "${MIDNIGHT_PROOF_VERSION_PIN:-${PROOF_IMAGE##*:}}")"
  if [ -n "${MIDNIGHT_PROOF_VERSION_PIN:-}" ]; then
    proof_say "  MIDNIGHT_PROOF_VERSION_PIN is set: comparing against ${pin_core} instead of"
    proof_say "  the image tag. This is the forced-mismatch check; it must refuse."
  fi

  # ---------------------------------------------------------- ask the port
  seen="$(proof_version_seen)"
  if [ -n "$seen" ]; then
    seen_core="$(proof_version_core "$seen")"
    if [ "$seen_core" = "$pin_core" ]; then
      ok "REUSED: the server already on $PROVER_PORT answers $seen"
      proof_say "  compared  $seen_core  against the pin  $pin_core   (an _experimental suffix is ignored on both sides)"
      proof_say "  container $(proof_port_holders "$PROVER_PORT" | head -n 1)"
      proof_say "  Reuse is correct here: restarting a matching server would discard the"
      proof_say "  proving parameters it has already downloaded, for nothing."
      return 0
    fi
    bad "WRONG SERVER: $PROVER_PORT answers $seen, and the pin is $pin_core"
    proof_say ""
    proof_say "  compared  $seen_core  against  $pin_core   — these are different servers."
    proof_say "  Whatever is there would build every proof in this run, and a run against"
    proof_say "  a server nobody chose measures nothing at all. C180, C214."
    proof_say ""
    proof_say "  What is publishing $PROVER_PORT:"
    proof_port_holders "$PROVER_PORT" | sed 's/^/    /' | tee -a "${REPORT:-/dev/null}"
    proof_say "  docker inspect $PROOF_NAME says its image is: $(proof_container_image)"
    proof_say "  THAT LINE DECIDES NOTHING. It is the belief that lied on 28 Aug."
    proof_refusal_footer
    return 1
  fi

  # ------------------------------------------------------- nothing answers
  if ! docker info >/dev/null 2>&1; then
    bad "nothing answers on $PROVER_PORT and Docker is not running"
    proof_say ""
    proof_say "  Open Docker Desktop, wait until it says it is running, then run this again."
    proof_say "  Nothing was proved and nothing was estimated."
    return 1
  fi

  proof_say "  ${DIM:-}nothing answers on $PROVER_PORT — starting ${PROOF_IMAGE}${OFF:-}"
  # NOT --rm, and reused rather than recreated: the shared reference string the
  # server fetches on its first proof goes with the container.
  if start_out="$(docker start "$PROOF_NAME" 2>&1)"; then
    proof_say "  ${DIM:-}reusing the existing container (it keeps its downloaded parameters)${OFF:-}"
  else
    start_out="$(docker run -d --name "$PROOF_NAME" -p "${PROVER_PORT}:6300" \
      "$PROOF_IMAGE" midnight-proof-server -v 2>&1)"
  fi
  [ -n "${REPORT:-}" ] && printf '%s\n' "$start_out" >> "$REPORT"

  # PORT HELD IS ITS OWN OUTCOME. It is not a failure to start — it is
  # *something else is here*, and on 28 Aug it scrolled past into the report
  # while the run carried on against the other server.
  case "$start_out" in
    *"port is already allocated"*|*"address already in use"*|*"Bind for "*)
      bad "PORT HELD: docker could not bind $PROVER_PORT — something else is already there"
      proof_say ""
      proof_say "  Docker said, verbatim:"
      printf '%s\n' "$start_out" | sed 's/^/    /' | tee -a "${REPORT:-/dev/null}"
      proof_say ""
      proof_say "  What is publishing $PROVER_PORT:"
      proof_port_holders "$PROVER_PORT" | sed 's/^/    /' | tee -a "${REPORT:-/dev/null}"
      proof_say "  and it answers /version: $(proof_version_seen)"
      proof_say ""
      proof_say "  THIS IS NOT A FAILURE TO START AND IT IS NOT A REASON TO CARRY ON."
      proof_say "  On 28 Aug this exact line went into the report, the health check then"
      proof_say "  found the OTHER server answering, and the run reported the image it"
      proof_say "  had meant to use. C214."
      proof_refusal_footer
      return 1
      ;;
  esac

  # 30 x 2s. A server that has to pull an image can take most of that.
  #
  # Both numbers are overridable ONLY so that scripts/proof-server-lib.test.ts
  # can reach the NO ANSWER branch in a second instead of a minute. Nothing that
  # runs for real sets them, and the defaults are the behaviour.
  local i tries pause
  tries="${PROOF_WAIT_TRIES:-30}"
  pause="${PROOF_WAIT_SECONDS:-2}"
  for i in $(seq 1 "$tries"); do
    sleep "$pause"
    curl -sf --max-time 5 "${PROVER_URL}/health" >/dev/null 2>&1 && break
    if [ "$i" = "$tries" ]; then
      bad "NO ANSWER: the proof server did not come up on $PROVER_PORT in time"
      proof_say "  What is publishing $PROVER_PORT:"
      proof_port_holders "$PROVER_PORT" | sed 's/^/    /' | tee -a "${REPORT:-/dev/null}"
      proof_refusal_footer
      return 1
    fi
  done

  # HEALTH IS NOT IDENTITY, AND THAT WAS THE WHOLE BUG. Ask again, and assert.
  seen="$(proof_version_seen)"
  seen_core="$(proof_version_core "$seen")"
  if [ "$seen_core" != "$pin_core" ]; then
    bad "WRONG SERVER: $PROVER_PORT came up answering $seen, and the pin is $pin_core"
    proof_say ""
    proof_say "  /health answered, so something is there — but it is not what we pinned."
    proof_say "  A health check that passes is not proof the right image is behind it."
    proof_say ""
    proof_say "  What is publishing $PROVER_PORT:"
    proof_port_holders "$PROVER_PORT" | sed 's/^/    /' | tee -a "${REPORT:-/dev/null}"
    proof_refusal_footer
    return 1
  fi

  ok "STARTED: $PROVER_PORT answers $seen, which is the pin $pin_core"
  proof_say "  container $(proof_port_holders "$PROVER_PORT" | head -n 1)"
  return 0
}

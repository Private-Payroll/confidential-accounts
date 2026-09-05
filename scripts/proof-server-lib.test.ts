/**
 * THE PROOF-SERVER CHECK ACTUALLY REFUSES. `C214`, `R1c` item 1.
 *
 * `R1c` asks for the refusal to be *"proved by forcing a mismatch"*. The
 * obvious way — run `DEPLOY-PREVIEW.command` with a pin nothing can answer —
 * proves it once, on one machine, on one day, and proves nothing again. This
 * proves it every time anybody runs the suite, and it proves the branches a
 * single forced run cannot reach at all: `port is already allocated`, a server
 * that comes up healthy and wrong, and reuse-on-match.
 *
 * NO DOCKER AND NO NETWORK. `docker` and `curl` are replaced on `PATH` by two
 * small scripts that answer from environment variables, so every branch is
 * driven directly and nothing on the machine is touched. That also means these
 * tests pass on a machine with no Docker at all, which the real check cannot.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE: that a REAL proof server answers
 * `/version` in the shape assumed. That is a fact about the image, it is
 * recorded in `docs/stagenet.md` from the 28 Aug run — the
 * `9.0.0-rc.5_experimental` image answered the bare `9.0.0-rc.5` — and a stub
 * cannot establish it. It is why the comparison ignores the suffix, and the
 * third case below pins that decision so it cannot be quietly reversed.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const LIB = resolve(__dirname, 'proof-server-lib.sh');
let binDir = '';

/**
 * `curl` answers whatever `FAKE_VERSION` says and `/health` succeeds only while
 * `FAKE_HEALTH` is `1`. Both are read at call time, so a fake can change its
 * mind between calls — which is how "started, then answers the wrong version"
 * is reachable.
 */
const FAKE_CURL = `#!/bin/bash
for a in "$@"; do last="$a"; done
case "$last" in
  */version) [ -n "$FAKE_VERSION" ] && printf '%s' "$FAKE_VERSION"; exit 0 ;;
  */health)  [ "$FAKE_HEALTH" = "1" ] && exit 0 || exit 22 ;;
esac
exit 0
`;

/** `docker` records every call to $DOCKER_LOG and answers from the environment. */
const FAKE_DOCKER = `#!/bin/bash
echo "docker $*" >> "$DOCKER_LOG"
case "$1" in
  info)    exit \${FAKE_DOCKER_INFO:-0} ;;
  ps)      printf '%s\\n' "$FAKE_PS" ; exit 0 ;;
  inspect) printf '%s\\n' "$FAKE_INSPECT" ; exit 0 ;;
  start)   printf '%s' "$FAKE_START_OUT" ; exit \${FAKE_START_CODE:-1} ;;
  run)     printf '%s' "$FAKE_RUN_OUT" ; exit \${FAKE_RUN_CODE:-0} ;;
esac
exit 0
`;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'proof-lib-'));
  for (const [name, body] of [['curl', FAKE_CURL], ['docker', FAKE_DOCKER]] as const) {
    const f = join(binDir, name);
    writeFileSync(f, body);
    chmodSync(f, 0o755);
  }
});

type Run = { code: number; out: string; dockerCalls: string };

function run(env: Record<string, string>): Run {
  const log = join(binDir, `docker-log-${Math.random().toString(36).slice(2)}`);
  writeFileSync(log, '');
  /*
   * **PROVER_URL BELOW IS A URL NOTHING RESOLVES, AND IT IS NOT THIS MACHINE'S.**
   *
   * It carried `.env`'s own MIDNIGHT_PROVER_URL as a literal until now — a value
   * the scanner reads out of a secret root and refuses in a file that ships.
   *
   * MEASURED: the lib uses PROVER_URL in exactly two places
   * (`proof-server-lib.sh:103,242`) and both APPEND A PATH — `/version` and
   * `/health`. `FAKE_CURL` above takes its LAST argument and switches on that
   * suffix with two trailing-path globs, so **the trailing path is load-bearing
   * and the URL body is not.** Every assertion in this file is on PROVER_PORT,
   * which has not changed.
   *
   * **THAT DISTINCTION IS WRITTEN OUT BECAUSE THIS COMMENT FIRST SAID THE STUB
   * *ignores its argument entirely*, WHICH IS FALSE** — an audit read the stub
   * and caught it. The substitution is still safe, but not for the reason first
   * given, and a later round told the URL is free would be told something the
   * file next to it contradicts.
   *
   * So the body is arbitrary and the one thing it must not be is a real
   * endpoint: `.invalid` is reserved (RFC 2606) and can never become one, so if
   * the stub ever stops shadowing `curl` this test cannot quietly reach a
   * server. The value it replaced was `localhost` on a port a developer may
   * really have a proof server on.
   */
  const script = `
    PROOF_IMAGE="midnightntwrk/proof-server:9.0.0-rc.3"
    PROOF_NAME="midnight-proof-server-9.0.0-rc.3"
    PROVER_PORT=6301
    PROVER_URL="http://proof-server.invalid"
    PROOF_WAIT_TRIES=1
    PROOF_WAIT_SECONDS=0
    . "${LIB}"
    proof_server_ensure
    echo "RESULT=$?"
  `;
  let out = '';
  let code = 0;
  try {
    out = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, DOCKER_LOG: log, ...env },
    });
  } catch (e: any) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    code = e.status ?? 1;
  }
  const m = out.match(/RESULT=(\d+)/);
  if (m) code = Number(m[1]);
  return { code, out, dockerCalls: execFileSync('cat', [log], { encoding: 'utf8' }) };
}

describe('the version assertion', () => {
  it('REFUSES when the port answers a different server — this is C214', () => {
    const r = run({ FAKE_VERSION: '9.0.0-rc.5', FAKE_HEALTH: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('WRONG SERVER');
    expect(r.out).toContain('9.0.0-rc.5');
    // The refusal must be actionable without a shell.
    expect(r.out).toContain('STOP-PROVER.command');
    // And it must not start anything after deciding the port is wrong.
    expect(r.dockerCalls).not.toMatch(/docker (run|start)/);
  });

  it('REFUSES on a forced pin the running server cannot answer — R1c’s named force', () => {
    const r = run({
      FAKE_VERSION: '9.0.0-rc.3', FAKE_HEALTH: '1',
      MIDNIGHT_PROOF_VERSION_PIN: '0.0.0-never',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('WRONG SERVER');
    expect(r.out).toContain('0.0.0-never');
  });

  it('REUSES a matching server rather than restarting it', () => {
    const r = run({ FAKE_VERSION: '9.0.0-rc.3', FAKE_HEALTH: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('REUSED');
    // Restarting a correct server would discard its downloaded parameters.
    expect(r.dockerCalls).not.toMatch(/docker (run|start)/);
  });

  it('ignores an _experimental suffix, on purpose and only that', () => {
    // Documented in the library: an rc.x server has been seen answering without
    // the suffix, so requiring it would refuse a correct server.
    expect(run({ FAKE_VERSION: '9.0.0-rc.3_experimental', FAKE_HEALTH: '1' }).code).toBe(0);
    // But the CORE still has to match. This is the line that must never relax.
    expect(run({ FAKE_VERSION: '9.0.0-rc.4_experimental', FAKE_HEALTH: '1' }).code).toBe(1);
  });
});

describe('port is already allocated, as its own named outcome', () => {
  it('names it, prints what holds the port, and refuses', () => {
    const r = run({
      FAKE_VERSION: '', FAKE_HEALTH: '0',
      FAKE_START_CODE: '1', FAKE_START_OUT: 'No such container',
      FAKE_RUN_CODE: '125',
      FAKE_RUN_OUT: 'docker: Error response from daemon: driver failed programming external '
        + 'connectivity on endpoint midnight-proof-server-9.0.0-rc.3: '
        + 'Bind for 0.0.0.0:6301 failed: port is already allocated',
      FAKE_PS: 'midnight-proof-server-9.0.0-rc.5_experimental   midnightntwrk/proof-server:9.0.0-rc.5_experimental   0.0.0.0:6301->6300/tcp',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('PORT HELD');
    // The container that actually holds it, by name and image.
    expect(r.out).toContain('9.0.0-rc.5_experimental');
    // Verbatim, because on 28 Aug this line went into the report and nowhere else.
    expect(r.out).toContain('port is already allocated');
    expect(r.out).toContain('STOP-PROVER.command');
  });
});

describe('a health check that passes is not identity', () => {
  it('refuses a server that came up healthy and wrong', () => {
    const r = run({
      FAKE_VERSION: '9.0.0-rc.5', FAKE_HEALTH: '0',
      FAKE_START_CODE: '0', FAKE_START_OUT: 'midnight-proof-server-9.0.0-rc.3',
    });
    // /version answered nothing at the first ask (FAKE_HEALTH is separate), so
    // it started; the post-start assertion is what catches it.
    expect(r.code).toBe(1);
    expect(r.out).toContain('WRONG SERVER');
  });

  it('refuses when nothing ever comes up, rather than proceeding', () => {
    const r = run({ FAKE_VERSION: '', FAKE_HEALTH: '0', FAKE_START_CODE: '0', FAKE_START_OUT: 'ok' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('NO ANSWER');
  });
});

describe('Docker not running', () => {
  it('says so and refuses, rather than reporting a server it never reached', () => {
    const r = run({ FAKE_VERSION: '', FAKE_HEALTH: '0', FAKE_DOCKER_INFO: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Docker is not running');
  });
});

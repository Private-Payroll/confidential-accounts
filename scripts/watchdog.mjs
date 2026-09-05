/**
 * A watchdog that keeps working when the main thread does not.
 *
 * Why this exists: M-32 added a heartbeat and a timeout around every circuit
 * call, and on the next run a call hung producing *zero* heartbeat lines. Both
 * `setInterval` and `Promise.race` are scheduled on the event loop, so when the
 * loop is blocked — synchronous WASM in the compact runtime, most likely —
 * neither can fire. Every hang-detection mechanism written in plain JavaScript
 * shares that flaw.
 *
 * TWO THINGS THIS HAS TO GET RIGHT, and the first attempt got only one.
 *
 * 1. DETECT without the main thread. A worker thread has its own event loop,
 *    so it keeps ticking. The main thread stamps a timestamp into shared
 *    memory before each step; the gap between now and that stamp measures how
 *    long the main thread has been unresponsive, without its cooperation.
 *
 * 2. ACT without the main thread. The first version detected the stall
 *    correctly and then called `postMessage`, whose handler runs on the main
 *    thread — the blocked one. So it detected a hang and then queued its
 *    report behind the very thing it was reporting. It hung anyway.
 *
 *    So this writes with `fs.writeSync(1, …)`, a direct syscall on fd 1 that
 *    needs no event loop and no main thread, and kills the process with a
 *    signal rather than `process.exit`, which in a worker only ends the worker.
 *
 * The general lesson, which cost two runs: a watchdog that reports through the
 * thing it is watching is not a watchdog.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { writeSync, mkdirSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

const { sharedBuffer, timeoutMs, heartbeatMs, witnessNames = [] } = workerData;
/** Which step we are watching. Updated by the main thread while it can. */
let label = workerData.label || 'the current step';

/**
 * Layout of the shared buffer:
 *   [0] the main thread's liveness pulse, refreshed on a timer while the loop
 *       is free. A stale pulse means blocked, not merely slow.
 *   [1] 1 while a step is in flight, 0 when idle
 *   [2] a step counter, so a finished-and-restarted step is distinguishable
 *   [3] when the current step began, for the overall ceiling
 *
 * BigInt64Array rather than Float64Array: `Atomics` only accepts integer typed
 * arrays and throws "not an integer typed array" on a Float64Array. Caught by
 * running this, which is the only reason it is not still in here.
 */
const shared = new BigInt64Array(sharedBuffer);

const PULSE = 0;
const IN_FLIGHT = 1;
const STEP = 2;
const STEP_START = 3;
const PHASE = 4;
const WITNESS_CALLS = 5;
const LAST_WITNESS = 6;
/**
 * M-46. FEE_CALLS is the dust wallet's fee-convergence loop counter — that loop
 * calls `feesWithMargin` once per pass — and LAST_FEE is the value it last
 * produced. Reported from here because the main thread is blocked while the
 * loop spins, so nothing on it can print.
 *
 * Guarded: older scripts pass a seven-slot buffer.
 */
const FEE_CALLS = 7;
const LAST_FEE = 8;
const hasFeeSlots = shared.length > LAST_FEE;
const feeBit = () => {
  if (!hasFeeSlots) return '';
  const n = Atomics.load(shared, FEE_CALLS);
  if (n === 0n) return '';
  return `  fees ${n} (last ${Atomics.load(shared, LAST_FEE)})`;
};

/**
 * How many times the circuit has called back into our witness functions.
 *
 * Measured: `signerPath` costs 0.7ms. If this climbs into the hundreds of
 * thousands during a stall, the arithmetic accounts for the whole six minutes
 * and the cause is the SDK re-running the circuit, not anything exotic. If it
 * stays small, the time is inside WASM proper.
 */
let lastWitnessCount = 0n;

/**
 * Which SDK call the main thread entered last.
 *
 * `callTx` is one opaque call, so "it blocks" could not be narrowed further.
 * The main thread writes a code here before entering each provider method, and
 * because the watchdog reads shared memory rather than asking, it can still
 * report the phase after the main thread has stopped answering. That is the
 * whole point: the last phase entered before the stall is the culprit.
 */
const PHASES = [
  'idle',
  'building the unproven transaction (runs the circuit in WASM)',
  'reading the proving key from disk',
  'asking the proof server to prove',
  'submitting to the node',
  'waiting for the indexer to confirm',
  'reading contract state from the indexer',
  'reading or writing the private state store',
  'the wallet balancing the transaction (selecting coins, fees, signing)',
  // balanceTx is three SDK calls. Splitting them is the only way one phase
  // code can name which one blocks; the 40s stack sample could not.
  'balancing: balanceUnboundTransaction (choosing coins and dust to pay fees)',
  'balancing: signRecipe',
  'balancing: finalizeRecipe',
];
const phaseName = (i) => PHASES[i] ?? `phase ${i}`;

/** Straight to the file descriptor. No stream, no event loop, no main thread. */
const say = (s) => {
  try { writeSync(1, s + '\n'); } catch { /* nothing useful to do */ }
};

let reportedStall = false;
let lastStep = -1;

/* ------------------------------------------------------------------ sampling
 *
 * Take the stack sample automatically, the moment a stall is detected.
 *
 * `STALL-SNAPSHOT.command` does this already, but it has to be started by hand
 * during the stall. That dependency has now cost a run: the
 * one snapshot taken so far landed at 08:37:55, fifteen seconds into a 284s
 * wallet sync, and captured the wallet syncing rather than the stall. A
 * perfectly good tool, aimed at the wrong second.
 *
 * The worker thread is the one part of this process that still runs while the
 * main thread is blocked, so it is the only thing that can aim itself. macOS
 * `sample` attaches to a process the same user owns and needs no privileges.
 *
 * Everything here is wrapped: a watchdog that can fail while reporting a
 * failure is worse than no watchdog.
 */
/**
 * Node's --perf-basic-prof map: `<hex start> <hex size> <name>` per line,
 * covering every JIT-compiled JS function and every WASM function. Without it
 * a stack sample of a WASM stall is a wall of `???`.
 */
const loadPerfMap = () => {
  const path = process.env.MIDNIGHT_PERF_MAP || `/tmp/perf-${process.pid}.map`;
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const sp1 = line.indexOf(' ');
    const sp2 = line.indexOf(' ', sp1 + 1);
    if (sp1 < 1 || sp2 < 0) continue;
    try {
      const start = BigInt('0x' + line.slice(0, sp1));
      const size = BigInt('0x' + line.slice(sp1 + 1, sp2));
      out.push({ start, end: start + size, name: line.slice(sp2 + 1).trim() });
    } catch { /* a malformed line is not worth failing over */ }
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
};

const SAMPLER = process.env.MIDNIGHT_SAMPLER || (process.platform === 'darwin' ? 'sample' : null);
let sampled = false;

const sampleNow = (secs) => {
  if (sampled || !SAMPLER) return;
  sampled = true;
  const out = `logs/stall-auto-${process.pid}-${secs}s.txt`;
  try { mkdirSync('logs', { recursive: true }); } catch { /* already there */ }
  say(`        taking a stack sample of the stuck process, into ${out}`);
  execFile(SAMPLER, [String(process.pid), '5', '-f', out], { timeout: 60_000 }, (err) => {
    if (err) {
      say(`        could not sample: ${String(err.message || err).split('\n')[0]}`);
      return;
    }
    let text = '';
    try { text = readFileSync(out, 'utf8'); } catch { /* file may be empty */ }

    // `sample` prints JIT-compiled JavaScript and WebAssembly as
    // "???  (in <unknown binary>)". The 40s sample was almost entirely those,
    // which is why it could say "inside WASM, growing memory" and not which
    // function. Node writes /tmp/perf-<pid>.map under --perf-basic-prof:
    // one line per compiled function, `start size name`. Resolving the
    // addresses against it turns every ??? into a name.
    const symbols = loadPerfMap();
    const resolve = (line) => {
      const m = /\[0x([0-9a-f]+)\]/i.exec(line);
      if (!m || !symbols.length) return null;
      const addr = BigInt('0x' + m[1]);
      let lo = 0, hi = symbols.length - 1, hit = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const e = symbols[mid];
        if (addr < e.start) hi = mid - 1;
        else if (addr >= e.end) lo = mid + 1;
        else { hit = e; break; }
      }
      return hit ? hit.name : null;
    };

    // Follow the HEAVIEST PATH down the tree, not the tail of the file.
    //
    // The first version took the last twelve named lines in file order and
    // printed twelve garbage-collector frames from unrelated subtrees — true,
    // and useless. `sample` prints children in descending sample count, so the
    // heaviest path is simply the first line at each increasing depth.
    const rows = [];
    let inGraph = false;
    for (const line of text.split('\n')) {
      if (line.startsWith('Call graph:')) { inGraph = true; continue; }
      if (line.startsWith('Binary Images:')) break;
      if (!inGraph) continue;
      const m = /^([ +!:|]*)(\d+)\s+(.*)$/.exec(line);
      if (m) rows.push({ depth: m[1].length, count: m[2], text: m[3] });
    }
    const path = [];
    let depth = -1;
    for (const r of rows) {
      if (r.depth <= depth) continue;
      depth = r.depth;
      const name = r.text.includes('???') ? resolve(r.text) : null;
      path.push(`${String(r.count).padStart(6)}  ${name ? name + '   [resolved]' : r.text}`);
    }

    // Of that path, show the application frames — resolved JavaScript, WASM
    // functions, anything in node_modules. The V8 and libuv scaffolding above
    // and the garbage-collector frames below are the same in every stall and
    // crowd out the six lines that identify it.
    const app = path.filter((f) => /JS:|wasm-function|node_modules|\.js:|\.mjs:/.test(f));
    const leaf = path[path.length - 1];
    const interesting = (app.length ? app.slice(-22).concat(app.includes(leaf) ? [] : [`  leaf: ${leaf.trim()}`]) : path.filter((f) => !f.includes('???')).slice(-14));
    say('');
    if (symbols.length) say(`  \x1b[2m(resolved against ${symbols.length} JIT symbols)\x1b[0m`);
    else say('  \x1b[2m(no perf map: rerun with NODE_OPTIONS=--perf-basic-prof to name the ??? frames)\x1b[0m');
    say('  \x1b[1mDeepest named frames while stuck:\x1b[0m');
    for (const l of interesting) say(`    ${l.slice(0, 140)}`);
    say(`  Full sample: ${out} — send it back.`);
    say('');
  });
};

setInterval(() => {
  const inFlight = Atomics.load(shared, IN_FLIGHT) === 1n;
  const step = Number(Atomics.load(shared, STEP));

  if (step !== lastStep) {
    lastStep = step;
    reportedStall = false;
    // One sample per step, not one per process: the first stall to trip this
    // may be a legitimately slow step, and the interesting one comes later.
    sampled = false;
  }

  if (!inFlight) return;

  // Two different measurements, because they mean different things.
  //   stall   how long the main thread has been unresponsive (blocked)
  //   elapsed how long this step has taken overall (slow, blocked or not)
  // Reporting a slow-but-healthy call as "blocked" was a false alarm the
  // first version produced, because it only had one of these.
  const stall = Date.now() - Number(Atomics.load(shared, PULSE));
  const elapsed = Date.now() - Number(Atomics.load(shared, STEP_START));
  const secs = Math.round(elapsed / 1000);

  if (elapsed > timeoutMs) {
    say('');
    say(`\x1b[31m\x1b[1m  ${label} has run for ${secs}s without finishing. Stopping it.\x1b[0m`);
    if (stall > heartbeatMs * 2) {
      say(`  The main thread was unresponsive for the last ${Math.round(stall / 1000)}s, so nothing`);
      say('  inside the program could interrupt it. That is a synchronous stall');
      say('  inside the SDK, not a slow network. M-33.');
      say('');
      say(`  \x1b[1mThe useful numbers: ${secs}s total, ${Math.round(stall / 1000)}s of it blocked.\x1b[0m`);
      say(`  \x1b[1mBlocked inside: ${phaseName(Number(Atomics.load(shared, PHASE)))}\x1b[0m`);
    say(`  \x1b[1mWitness calls: ${Atomics.load(shared, WITNESS_CALLS)} (last: ${witnessNames[Number(Atomics.load(shared, LAST_WITNESS))] ?? '?'})\x1b[0m`);
    } else {
      say('  The main thread stayed responsive throughout, so this is a slow or');
      say('  unanswered call rather than a blocked one — most likely waiting on');
      say('  the network for a confirmation that never arrived. M-32.');
      say('');
      say(`  \x1b[1mThe useful number: ${secs}s, main thread never blocked.\x1b[0m`);
      say(`  \x1b[1mWaiting inside: ${phaseName(Number(Atomics.load(shared, PHASE)))}\x1b[0m`);
    }
    say('  Send this back.');
    say('');
    // SIGKILL, because the main thread cannot run an exit handler and
    // process.exit() inside a worker would only end this worker.
    try { process.kill(process.pid, 'SIGKILL'); } catch { /* fall through */ }
    return;
  }

  // A stamp that is not advancing while a step is in flight means the main
  // thread is unresponsive rather than merely slow. Those look identical from
  // outside and need opposite responses, so say which one it is.
  const stalled = stall > heartbeatMs * 2;
  if (stalled && !reportedStall) {
    reportedStall = true;
    say(`  \x1b[33m${secs}s — the main thread has stopped responding during ${label}.\x1b[0m`);
    say(`        Inside: ${phaseName(Number(Atomics.load(shared, PHASE)))}${feeBit()}`);
    sampleNow(secs);
  } else {
    const calls = Atomics.load(shared, WITNESS_CALLS);
    const delta = calls - lastWitnessCount;
    lastWitnessCount = calls;
    const witnessBit = calls > 0n
      ? `  witnesses ${calls} (+${delta}, last ${witnessNames[Number(Atomics.load(shared, LAST_WITNESS))] ?? '?'})`
      : '';
    const fees = feeBit();
    say(`  ${String(secs).padStart(3)}s  ${label} — ${phaseName(Number(Atomics.load(shared, PHASE)))}${stalled ? ' (blocked)' : ''}${witnessBit}${fees}`);
  }
}, heartbeatMs).unref?.();

// Kept only so the main thread can update the label when it is responsive.
parentPort?.on('message', (m) => {
  if (m && typeof m.label === 'string') label = m.label;
});

/**
 * THE CHAIN PROBE. Deploy ChainProbe to Stagenet, drive it once, and read the
 * payment transaction back with everything an observer would have.
 *
 *   npx tsx scripts/chain-probe.ts        (or CHAIN-PROBE.command)
 *
 * WHAT THIS IS FOR, in the contract's own words (contracts/chainprobe/ChainProbe.compact):
 *
 *   1. CAN AN OBSERVER READ A PAYOUT AMOUNT OFF THE CHAIN? Stage 7 makes the
 *      payment and then dumps the resulting transaction — raw, serialised,
 *      the contract state either side of it, and the indexer's own view — into
 *      logs/chain-probe-payment-tx.{json,txt}, and searches all of it for the
 *      amount this script knows it paid.
 *   2. DOES TAKING MONEY IN AND PAYING IT OUT IN ONE CIRCUIT SURVIVE PROVING?
 *      `wrap` and `unwrap` are that shape. A Midnight forum report says it
 *      compiles and then fails in the PROOF SERVER, so stage 5 reports a proof
 *      failure distinctly from every other kind — see `classifyFailure`.
 *
 * WHAT IT IS NOT. It is not the product, it deploys a throwaway contract that
 * mints its own tokens, and nothing real is at risk beyond the fees. The
 * account contract, its scripts and its deployment file are untouched: this
 * writes `.midnight/${NETWORK}-chainprobe.json` and nothing else in there.
 *
 * CONVENTIONS COPIED, NOT REINVENTED. Wallet bring-up is `bringUpWallet`, the
 * environment is `testEnvironmentFor` + `startEnvironment` (the M-116 retry),
 * the dust cache is `saveDustState`, and every circuit goes through the same
 * `callCircuit` with a landed-check and the same worker-thread watchdog as
 * `run-preview.ts`. Every one of those exists because a hand-written copy of it
 * cost a run — M-50, M-55, M-58, M-61, M-65, M-75, M-116, M-137.
 *
 * WHY tsx AND NOT node. It imports generated contract code through a .js
 * specifier, which is the TypeScript convention and which plain node cannot
 * resolve.
 *
 * IT HAS NEVER BEEN RUN. Everything below is written the way the working
 * scripts do it; the places where an SDK detail could not be verified offline
 * are marked UNCERTAIN and say what the fallback is.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from '@noble/hashes/utils.js';

import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import {
  StaticProofServerContainer,
  createDefaultTestLogger,
} from '@midnight-ntwrk/testkit-js';
import {
  deployContract,
  findDeployedContract,
  withContractScopedTransaction,
} from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

/*
 * The throwaway contract, from its own managed directory.
 *
 * `contracts/managed` is the ACCOUNT contract and must not be confused with
 * this one: they export the same three names and TypeScript would not complain.
 * Hence the explicit path everywhere below, and the artifact check in stage 1.
 */
/*
 * THE COMPILED PROBE CONTRACT IS LOADED AT RUN TIME, NOT AT IMPORT TIME.
 *
 * What it names is compiler output. It is not in this repository and no step
 * here builds it, so a static import makes this file unresolvable in any copy
 * that has not built it by hand: the typecheck fails, and every tool that only
 * had to READ this file fails with it. Loaded at run time, the file is readable
 * and checkable everywhere, and the thing that is missing is reported at the
 * moment it is actually needed, by the one function that needs it.
 *
 * The path is assembled rather than written into the call so that no build step
 * tries to resolve it either.
 */
const PROBE_CONTRACT = ['..', 'contracts', 'chainprobe', 'managed', 'contract', 'index.js'].join('/');

let Contract: any;
let readLedger: (data: unknown) => any;
let pureCircuits: any;

async function loadProbeContract(): Promise<void> {
  let mod: any;
  try {
    mod = await import(PROBE_CONTRACT);
  } catch (e: any) {
    throw new Error(
      `this probe reads a compiled contract at contracts/chainprobe/managed, and it is not there.\n` +
      `  That directory is compiler output for a throwaway contract; nothing in this repository builds it,\n` +
      `  and it is never committed. Compile contracts/chainprobe with the pinned compiler first.\n` +
      `  (${e?.message ?? e})`,
    );
  }
  ({ Contract, ledger: readLedger, pureCircuits } = mod);
}
import { applyNetworkId, networkFromEnv } from '../src/midnight/network.js';
import { explainNodeError } from './node-errors.js';
import {
  saveDustState, waitForDustCatchUp, dustCaughtUp, dustProgressOf, dustProgressKnown,
} from './dust-wallet.js';
import { bringUpWallet } from './wallet-bringup.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';

/* ------------------------------------------------------------------ */

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, '.midnight');
const LOG_DIR = join(ROOT, 'logs');

/**
 * The wallet, shared with the account scripts on purpose.
 *
 * It is the one that has already been funded and already has its NIGHT
 * registered for DUST generation, and DUST is the only thing this probe needs
 * from the outside world. A second wallet would mean a second faucet visit and
 * a second five-minute dust sync for no gain.
 */
const SEED_FILE = join(STATE_DIR, 'wallet.seed');
const NETWORK = networkFromEnv(process.env.MIDNIGHT_NETWORK_ID, 'stagenet');

/**
 * Where this probe's deployment is recorded — per network, like every other
 * address file in this project. On the default network that is exactly
 * `.midnight/stagenet-chainprobe.json`.
 *
 * A contract address is meaningless on another chain and Stagenet is wiped on a
 * schedule, so a stale address is a guaranteed confusing failure. Deliberately
 * NOT `${NETWORK}-contract.json`, which is the account contract: overwriting
 * that with a throwaway probe would leave the real deployment unreachable.
 */
const OUT_FILE = join(STATE_DIR, `${NETWORK}-chainprobe.json`);
const ARTIFACTS = join(ROOT, 'contracts', 'chainprobe', 'managed');

/**
 * A private-state store for a contract that has no private state.
 *
 * ChainProbe declares no witnesses, so nothing is ever read from or written to
 * it. The providers bundle still wants the field, and giving it its own name
 * keeps it from sharing a level-db store with the account contract's signer
 * secrets.
 */
const PRIVATE_STATE_ID = `chainprobe-${NETWORK}`;
const PRIVATE_STATE_PASSWORD =
  process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD || 'ConfidentialAccounts-Dev-2026';
/*
 * 6301, NOT 6300.
 *
 * Two proof servers run on this machine: `8.1.0` on 6300 and the pinned one on
 * 6301. The pinned image is `9.0.0-rc.3` — the prover built from the ledger
 * release the running node is built from
 * (midnight-node@d9729c13/Cargo.toml:445 -> crate-ledger-9.1.0.0-rc.3 ->
 * proof-server/Cargo.toml 9.0.0-rc.3), alongside ledger 1.0.0-rc.3, onchain
 * runtime 4.0.0-rc.3, midnight.js 5.0.0-beta.4 and compiler 0.33.0 — every one
 * of which we already match.
 *
 * IT SAID `9.0.0-rc.5_experimental` UNTIL 28 AUG 2026, on the authority of
 * Midnight's Stagenet delivery document — a draft edited forward of the running
 * network. rc.5 was published between ledger releases and is built from none
 * this node uses, which left the proof server as the single component pointed
 * at the wrong build. `docs/stagenet.md` carries the derivation;
 * `DEPLOY-PREVIEW.command:32` the full reason. The port was separately wrong in
 * every script except `sponsor-test.ts`.
 *
 * A proof server from a different line produces proofs the node's fee check
 * refuses, which is `InvalidDustSpendProof` — node error 170.
 */
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT || 6301);

/* ------------------------------------------------------------------ *
 * the amounts
 *
 * BIGINTS, ALL OF THEM, and never a JS number. `Uint<64>` and `Uint<128>` do
 * not fit in a double, the runtime rejects a number where it wants a bigint,
 * and a silently rounded amount is the one failure that would make this whole
 * probe answer the wrong question.
 * ------------------------------------------------------------------ */

/** How much private money one wrap creates. */
const WRAP_AMOUNT = BigInt(process.env.CHAINPROBE_WRAP_AMOUNT || 1_000_000n);

/**
 * What the contract pays out in stage 7 — THE NUMBER THE WHOLE PROBE IS ABOUT.
 *
 * Strictly less than `WRAP_AMOUNT`, so `sendShielded` returns change and the
 * `result.change.is_some` branch of `pay` is the one exercised. A payment that
 * emptied the coin would take the other branch and would also be the easy case
 * for an observer, since "the contract now holds nothing of that token" is
 * plainly readable.
 */
const PAY_AMOUNT = BigInt(process.env.CHAINPROBE_PAY_AMOUNT || 250_000n);

/**
 * How much public test token to mint ourselves.
 *
 * TWICE the wrap amount, and the reason is worth stating because it changes the
 * shape of the run. Stage 6 gives the contract the ticket that stage 5 minted,
 * so by stage 9 we are holding no ticket at all — and `unwrap` needs one in the
 * caller's hands, because it is the caller who sends it in to be burned. So
 * stage 9 wraps a SECOND time before unwrapping. That second wrap is not
 * padding: it is question 2 asked twice, which is worth having.
 */
const ISSUE_AMOUNT = WRAP_AMOUNT * 2n;

/* ------------------------------------------------------------------ *
 * fresh randomness, per run
 *
 * NEVER COMPILE-TIME CONSTANTS. A fixed salt is what M-137 cost this project:
 * the second run against the same deployment reproduces the first run's
 * commitments and dies on something the chain refuses to do twice. Here a fixed
 * coin nonce would be worse than that — two coins with the same nonce and the
 * same colour are the same coin, and the second mint would be unspendable.
 * ------------------------------------------------------------------ */
const freshBytes = (): Uint8Array => randomBytes(32);

/** One per wrap. Two wraps, two nonces, drawn now so they are in the report. */
const WRAP_NONCE_A = freshBytes();
const WRAP_NONCE_B = freshBytes();

/**
 * The second address, which we control because we just made its key.
 *
 * `pay` needs a recipient that is not us, or the test is "did the contract pay
 * itself". Deriving a whole second wallet would cost another dust sync for a
 * key we only need the public half of, so the keys are derived directly from a
 * fresh seed. We hold the secret, so this genuinely is an address we control —
 * it simply has no wallet watching it.
 *
 * Random per run rather than seeded: a seeded recipient across runs would let
 * anyone reading this file link every payment this probe has ever made, which
 * is precisely the property the probe is measuring.
 */
const RECIPIENT_SEED = freshBytes();

/* ------------------------------------------------------------------ *
 * output
 * ------------------------------------------------------------------ */

/**
 * The report, written as the run goes rather than at the end.
 *
 * Same convention as every REPORT-*.txt at the root, except that the .command
 * wrappers build theirs with `tee` and this one is written in process — because
 * the interesting half of this run is a dump that has to be correlated with the
 * lines around it, and a run that dies in stage 7 must still leave the stages
 * that passed behind it.
 */
const REPORT_FILE = join(ROOT, 'REPORT-CHAIN-PROBE.txt');
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

let stage = 'startup';
const say = (line = '') => {
  console.log(line);
  try { appendFileSync(REPORT_FILE, stripAnsi(line) + '\n'); } catch { /* the console is the copy that matters */ }
};
const begin = (n: number, of: number, name: string) => {
  stage = name;
  say(`\n\x1b[1m${n} of ${of}  ${name}\x1b[0m`);
};
const note = (s: string) => say(`  ${s}`);
const good = (s: string) => say(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s: string) => say(`  \x1b[33m! ${s}\x1b[0m`);

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/*
 * The rejection code arrives on the console, not in the exception. Copied from
 * deploy-preview.ts, for the same reason: Polkadot's RPC layer logs
 * `1010: Invalid Transaction: Custom error: 170` and then throws a
 * `SubmissionError` that carries none of it.
 */
let annotatedConsole = false;
function annotateNodeErrorsOnConsole() {
  if (annotatedConsole) return;
  annotatedConsole = true;
  for (const key of ['log', 'error', 'warn'] as const) {
    const original = console[key].bind(console);
    console[key] = (...args: unknown[]) => {
      original(...args);
      try {
        const explained = explainNodeError(args.map(String).join(' '));
        if (explained) original(`  \x1b[1m\x1b[33m^ ${explained}\x1b[0m`);
      } catch { /* never let annotation break logging */ }
    };
  }
}

/** Everything an error is actually carrying. Copied from deploy-preview.ts. */
function describeError(e: any, depth = 0): string {
  if (e == null || depth > 4) return String(e);
  const pad = '  '.repeat(depth);
  const bits: string[] = [];
  const msg = e.message ?? String(e);
  bits.push(`${pad}${e.name ? e.name + ': ' : ''}${msg}`);
  try {
    const explained = explainNodeError(String(msg));
    if (explained) bits.push(`${pad}  \x1b[1m${explained}\x1b[0m`);
  } catch { /* the annotation is a nicety */ }
  if (/normal closure|disconnected|socket hang up|ECONNRESET/i.test(String(msg))) {
    bits.push(`${pad}  \x1b[1mthe node websocket dropped — the transaction was never submitted, so this is worth retrying\x1b[0m`);
  }
  if (e.code) bits.push(`${pad}  code: ${e.code}`);
  const data = e.response?.data;
  if (data) bits.push(`${pad}  response: ${typeof data === 'string' ? data.slice(0, 400) : JSON.stringify(data).slice(0, 400)}`);
  if (Array.isArray(e.errors)) for (const sub of e.errors.slice(0, 3)) bits.push(describeError(sub, depth + 1));
  if (e.cause && e.cause !== e) bits.push(describeError(e.cause, depth + 1));
  return bits.join('\n');
}

/**
 * How far each sub-wallet has synced, as one line. Module scope, deliberately —
 * it is built in one stage and called from another, and the copy that lived
 * inside `main()` in an earlier script was a ReferenceError that fired inside a
 * provider wrapper and cost a run.
 */
const progressOf = (s: any): string => {
  const one = (p: any, name: string) => {
    if (!p) return `${name} —`;
    const applied = p.appliedIndex ?? p.appliedId ?? '?';
    const highest = p.highestRelevantIndex ?? p.highestIndex ?? p.highestTransactionId ?? '?';
    const conn = p.isConnected === false ? ' OFFLINE' : '';
    let done = '';
    try {
      if (typeof p.isCompleteWithin === 'function') done = p.isCompleteWithin(10n) ? '✓' : '';
      else if (typeof p.isStrictlyComplete === 'function') done = p.isStrictlyComplete() ? '✓' : '';
    } catch { /* a progress object that throws is still worth printing */ }
    return `${name} ${applied}/${highest}${done}${conn}`;
  };
  try {
    return [
      one(s?.unshielded?.progress ?? s?.unshielded?.state?.progress, 'unshielded'),
      one(s?.dust?.state?.progress ?? s?.dust?.progress, 'dust'),
      one(s?.shielded?.state?.progress ?? s?.shielded?.progress, 'shielded'),
    ].join('  ');
  } catch {
    return 'could not read sync state';
  }
};

/* ------------------------------------------------------------------ *
 * turning things into something a file can hold
 * ------------------------------------------------------------------ */

/**
 * JSON that survives bigints, byte arrays, maps and WASM objects.
 *
 * `JSON.stringify` throws on a bigint and silently produces `{}` for a WASM
 * handle, and both of those are exactly the values this dump exists to carry.
 * Anything with no own enumerable keys falls back to `String(v)`, which for the
 * ledger types is their `toString()` — the most informative thing they have.
 */
const jsonSafe = (v: any, depth = 0): any => {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Uint8Array) return hex(v);
  if (typeof v === 'function') return '(function)';
  if (depth > 8) return '(nested deeper than this dump follows)';
  if (Array.isArray(v)) return v.map((x) => jsonSafe(x, depth + 1));
  if (v instanceof Map) return [...v.entries()].map(([k, val]) => [jsonSafe(k, depth + 1), jsonSafe(val, depth + 1)]);
  if (v instanceof Set) return [...v].map((x) => jsonSafe(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v)) {
      try { out[k] = jsonSafe((v as any)[k], depth + 1); }
      catch (e: any) { out[k] = `(unreadable: ${String(e?.message ?? e).slice(0, 80)})`; }
    }
    if (Object.keys(out).length === 0) {
      try { return String(v); } catch { return '(opaque object)'; }
    }
    return out;
  }
  return String(v);
};

/** Calls something that may not exist on this build, and records why not. */
const attempt = <T>(what: string, fn: () => T): { ok: true; value: T } | { ok: false; why: string } => {
  try { return { ok: true, value: fn() }; }
  catch (e: any) { return { ok: false, why: `${what} failed: ${String(e?.message ?? e).slice(0, 200)}` }; }
};

/* ------------------------------------------------------------------ *
 * looking for a number in a pile of bytes
 *
 * The point of the whole probe, so it is written out rather than done with a
 * one-line `includes`. An amount can be written down in more than one way and
 * only finding the way you thought of is not a search.
 * ------------------------------------------------------------------ */

const beHex = (v: bigint, byteWidth?: number): string => {
  let s = v.toString(16);
  if (s.length % 2) s = '0' + s;
  if (byteWidth) s = s.padStart(byteWidth * 2, '0');
  return s;
};
const leHex = (v: bigint, byteWidth: number): string =>
  (beHex(v, byteWidth).match(/../g) ?? []).reverse().join('');
const bytesOfHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));

/** Every plausible written form of one amount. */
const encodingsOf = (v: bigint): Array<{ name: string; hex: string }> => {
  const out: Array<{ name: string; hex: string }> = [
    { name: 'big-endian, minimal', hex: beHex(v) },
  ];
  for (const width of [4, 8, 16, 32]) {
    if (BigInt(v) >= 1n << BigInt(width * 8)) continue;
    out.push({ name: `big-endian, ${width} bytes`, hex: beHex(v, width) });
    out.push({ name: `little-endian, ${width} bytes`, hex: leHex(v, width) });
  }
  // Duplicates are pointless noise in the report — a minimal encoding of a
  // small number is often the same string as its 4-byte form.
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.hex) ? false : (seen.add(e.hex), true)));
};

/** How many times `needle` occurs in `haystack`, as raw bytes. */
const countBytes = (haystack: Uint8Array, needle: Uint8Array): number => {
  if (needle.length === 0 || needle.length > haystack.length) return 0;
  let count = 0;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    count++;
  }
  return count;
};

const countText = (haystack: string, needle: string): number => {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + 1;
  }
};

type Corpus = { name: string; text?: string; bytes?: Uint8Array };
type Hit = { corpus: string; form: string; pattern: string; occurrences: number };

/**
 * Looks for one amount, every way it might be written, in every corpus.
 *
 * Text corpora are searched case-insensitively for the decimal form and each
 * hex form; byte corpora are searched for the actual byte sequence, which is
 * the only search that would find an amount the serialiser wrote without ever
 * printing.
 */
const searchFor = (amount: bigint, corpora: Corpus[]): Hit[] => {
  const hits: Hit[] = [];
  const decimal = amount.toString(10);
  for (const c of corpora) {
    if (c.text !== undefined) {
      const lower = c.text.toLowerCase();
      const n = countText(lower, decimal);
      if (n) hits.push({ corpus: c.name, form: 'decimal digits', pattern: decimal, occurrences: n });
      for (const enc of encodingsOf(amount)) {
        const m = countText(lower, enc.hex.toLowerCase());
        if (m) hits.push({ corpus: c.name, form: `hex text, ${enc.name}`, pattern: enc.hex, occurrences: m });
      }
    }
    if (c.bytes !== undefined) {
      for (const enc of encodingsOf(amount)) {
        const m = countBytes(c.bytes, bytesOfHex(enc.hex));
        if (m) hits.push({ corpus: c.name, form: `raw bytes, ${enc.name}`, pattern: enc.hex, occurrences: m });
      }
    }
  }
  return hits;
};

/* ------------------------------------------------------------------ */

/**
 * WHICH LAYER BROKE, and specifically: was it the proof server?
 *
 * Question 2 in the contract's header is "does this shape survive PROVING",
 * where the reported failure mode is a contract that compiles cleanly and then
 * fails in the proof server. So "it failed" is not the answer — "it failed
 * while proving" and "it failed while submitting" are different findings and
 * only one of them is the one being tested for.
 *
 * Two independent signals, because either alone is weak:
 *   - the phase the watchdog last recorded, which is set by the provider
 *     wrappers and is the strongest evidence available;
 *   - the text, for the case where the throw came from somewhere that never
 *     entered a wrapped provider at all.
 */
type Layer = 'the proof server' | 'the node' | 'the wallet or balancer' | 'the indexer' | 'somewhere else';
const classifyFailure = (e: any, phaseWasProving: boolean): Layer => {
  const text = describeError(e).toLowerCase();
  if (phaseWasProving) return 'the proof server';
  if (/proof server|proving|prove|prover|zkir|6300|proof provider/.test(text)) return 'the proof server';
  if (/1010|custom error|invalid transaction|submission|extrinsic/.test(text)) return 'the node';
  if (/balance dust|insufficient funds|could not balance|coin selection|balancer/.test(text)) return 'the wallet or balancer';
  if (/indexer|graphql|subscription/.test(text)) return 'the indexer';
  return 'somewhere else';
};

/* ------------------------------------------------------------------ */

async function main() {
  await loadProbeContract();
  annotateNodeErrorsOnConsole();
  writeFileSync(
    REPORT_FILE,
    `The chain probe — ${new Date().toISOString()}\n` +
      `network ${NETWORK}\n` +
      '────────────────────────────────────────────────────────────\n',
  );
  say('────────────────────────────────────────────────────────────');
  say(`  Driving ChainProbe on ${NETWORK}`);
  say('────────────────────────────────────────────────────────────');

  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

  /* ---------- the watchdog, before anything can hang ----------
   *
   * A worker thread, because the main thread cannot be relied upon to notice
   * its own problems: a circuit call blocks the event loop synchronously, so an
   * in-process timeout and an in-process heartbeat both simply never fire.
   * It reads a timestamp out of shared memory, so it can measure a stall
   * without the main thread participating.
   *
   * Same shared-buffer layout as run-preview.ts because it drives the same
   * `scripts/watchdog.mjs` — nine slots, BigInt64Array, and the phase codes
   * below match the table in that file.
   */
  const { Worker } = await import('node:worker_threads');
  const sharedBuffer = new SharedArrayBuffer(9 * 8);
  const shared = new BigInt64Array(sharedBuffer);
  const PULSE = 0, IN_FLIGHT = 1, STEP = 2, STEP_START = 3, PHASE = 4, WITNESS_CALLS = 5, LAST_WITNESS = 6;
  const FEE_CALLS = 7, LAST_FEE = 8;

  const PH = {
    idle: 0, build: 1, readKey: 2, prove: 3, submit: 4, confirm: 5,
    queryState: 6, privateState: 7, balance: 8,
    balanceUnbound: 9, signRecipe: 10, finalizeRecipe: 11,
  };
  const setPhase = (p: number) => Atomics.store(shared, PHASE, BigInt(p));
  let ambientPhase = PH.idle;
  const setAmbient = (p: number) => { ambientPhase = p; setPhase(p); };

  const pulse = () => Atomics.store(shared, PULSE, BigInt(Date.now()));
  pulse();
  setInterval(pulse, 2000).unref();

  const beginStep = () => {
    pulse();
    Atomics.store(shared, STEP_START, BigInt(Date.now()));
    Atomics.store(shared, IN_FLIGHT, 1n);
    Atomics.add(shared, STEP, 1n);
  };
  const endStep = () => { Atomics.store(shared, IN_FLIGHT, 0n); setAmbient(PH.idle); pulse(); };

  /**
   * Wraps a provider method so it records which phase it is in.
   *
   * Deliberately wrapping the providers rather than reassembling the call from
   * `createUnprovenCallTx` and `submitTx` by hand — hand-assembly is what M-16
   * lost six rounds to, and the point is to watch the SDK do its normal thing.
   * The prototype is preserved because this SDK does `instanceof` checks.
   */
  const timed = <T extends object>(obj: T, phases: Partial<Record<keyof T & string, number>>): T => {
    const proto = Object.getPrototypeOf(obj) ?? Object.prototype;
    const out: any = Object.create(proto);
    const protoKeys = proto === Object.prototype ? [] : Object.getOwnPropertyNames(proto);
    for (const key of new Set([...Object.keys(obj as any), ...protoKeys])) {
      if (key === 'constructor') continue;
      const v: any = (obj as any)[key];
      if (typeof v !== 'function') { try { out[key] = v; } catch { /* getters that throw are not our business */ } continue; }
      const phase = (phases as any)[key];
      out[key] = (...args: any[]) => {
        if (phase !== undefined) { setPhase(phase); pulse(); }
        const r = v.apply(obj, args);
        if (r && typeof r.then === 'function') {
          return r.finally(() => { pulse(); if (phase !== undefined) setPhase(ambientPhase); });
        }
        pulse();
        if (phase !== undefined) setPhase(ambientPhase);
        return r;
      };
    }
    return out;
  };

  /**
   * Three minutes per call, as run-preview.ts settled on.
   *
   * The first proof of a run may be slower than that if the proof server still
   * has to fetch its shared reference string, which is why the ceiling is an
   * environment variable rather than a constant — but a ceiling high enough for
   * the worst case makes every ordinary failure take half an hour to surface.
   */
  const CALL_TIMEOUT_MS = Number(process.env.MIDNIGHT_CALL_TIMEOUT_MS || 3 * 60_000);

  /*
   * Count every fee computation and record the last fee, so a stall
   * inside the dust wallet's fixed-point balancing loop is legible from the
   * watchdog thread while the main thread is blocked. Read-only: it calls
   * through and returns the real value.
   */
  try {
    const ledgerModule: any = await import('@midnightntwrk/ledger-v9');
    const txProto: any = ledgerModule?.Transaction?.prototype;
    if (typeof txProto?.feesWithMargin === 'function') {
      const original = txProto.feesWithMargin;
      txProto.feesWithMargin = function patched(this: any, ...args: any[]) {
        const fee = original.apply(this, args);
        try {
          Atomics.add(shared, FEE_CALLS, 1n);
          Atomics.store(shared, LAST_FEE, BigInt(fee));
        } catch { /* never let instrumentation break the call */ }
        return fee;
      };
    }
  } catch { /* the probe works without it; the stall diagnosis does not */ }

  const watchdog = new Worker(new URL('./watchdog.mjs', import.meta.url), {
    workerData: {
      sharedBuffer, timeoutMs: CALL_TIMEOUT_MS, heartbeatMs: 15_000,
      label: 'the current step',
      // ChainProbe declares no witnesses, so the witness counter stays at zero
      // and the watchdog has nothing to name. That is a fact about this
      // contract, not a gap: an empty list is the honest input.
      witnessNames: [],
    },
  });
  watchdog.unref();
  // No message handler: the watchdog writes straight to fd 1, because a handler
  // here would run on the very thread that is blocked.

  /* -------------------------------------------------- 1 */
  begin(1, 9, 'Checking what we need before touching the network');

  /*
   * The artifacts, by name, before anything else. A missing managed directory
   * currently surfaces as a module-resolution error at import time, which is
   * before this line runs — so this check is for the subtler case where the
   * directory exists but was never populated with keys, and the failure would
   * otherwise land inside the proof provider after the dust wait.
   */
  for (const needed of [
    join(ARTIFACTS, 'contract', 'index.js'),
    join(ARTIFACTS, 'keys'),
    join(ARTIFACTS, 'zkir'),
  ]) {
    if (!existsSync(needed)) {
      throw new Error(
        `${needed.replace(ROOT + '/', '')} is missing, so ChainProbe has not been compiled.\n` +
          '  Compile contracts/chainprobe/ChainProbe.compact into contracts/chainprobe/managed\n' +
          '  (COMPILE-CONTRACT.command, or compactc directly) and run this again.',
      );
    }
  }
  good('the compiled ChainProbe artifacts are where this script expects them');

  if (!existsSync(SEED_FILE)) {
    throw new Error(
      `no wallet seed at ${SEED_FILE.replace(ROOT + '/', '')}.\n` +
        '  This probe deliberately reuses the account scripts\' funded wallet rather than\n' +
        '  asking the faucet for a second one. Run DEPLOY-PREVIEW.command first.',
    );
  }
  const masterSeed = readFileSync(SEED_FILE, 'utf8').trim();
  good('reusing the funded wallet — its NIGHT is already registered for DUST');

  const { validatePassword } = await import('@midnight-ntwrk/midnight-js-utils');
  try { validatePassword(PRIVATE_STATE_PASSWORD); good('private state password meets the SDK rules'); }
  catch (e: any) { throw new Error(`the private state store password is not acceptable to the SDK: ${e?.message ?? e}`); }

  /*
   * The compiled contract, not a `new Contract(...)` instance. Handing the SDK
   * an instance is the mistake M-16 lost a round to.
   *
   * NO WITNESSES. ChainProbe reads nothing from a device — every input is a
   * circuit argument — so the witness object is empty and that is correct
   * rather than an omission.
   */
  const compiled = CompiledContract.make('ChainProbe', Contract as any).pipe(
    CompiledContract.withWitnesses({} as any),
    CompiledContract.withCompiledFileAssets(ARTIFACTS as never),
  ) as any;
  good(`compiled contract "${compiled.tag}", assets at contracts/chainprobe/managed`);

  say('');
  say('  \x1b[1mThe amounts this run uses\x1b[0m');
  say(`    public token minted to us      ${ISSUE_AMOUNT}`);
  say(`    wrapped into a private ticket  ${WRAP_AMOUNT}   (twice: stage 5 and stage 9)`);
  say(`    paid out of the contract       ${PAY_AMOUNT}   \x1b[1m← the number the dump is searched for\x1b[0m`);
  say('');
  note('every one of those is a bigint; none of them is a JavaScript number');
  note(`wrap nonce A ${hex(WRAP_NONCE_A).slice(0, 24)}…  B ${hex(WRAP_NONCE_B).slice(0, 24)}…  (fresh this run)`);

  if (PAY_AMOUNT >= WRAP_AMOUNT) {
    throw new Error(
      `the payout (${PAY_AMOUNT}) is not smaller than the wrapped amount (${WRAP_AMOUNT}).\n` +
        '  It has to be, or `pay` empties the coin and takes the branch that removes the\n' +
        '  entry instead of the branch that keeps change — and "the contract now holds\n' +
        '  nothing" is the easy case for an observer, which is not the case under test.',
    );
  }

  await applyNetworkId(NETWORK);
  good(`network id is the string "${NETWORK}"`);

  /* -------------------------------------------------- 2 */
  begin(2, 9, 'Connecting and starting the wallet');

  const logger = createDefaultTestLogger();
  const { env, how } = testEnvironmentFor(NETWORK, logger);
  note(`network ${NETWORK} — ${how}`);
  /*
   * Retried, because the testkit's own startup health check gives each endpoint
   * ONE SECOND, hardcoded in four places. Against public endpoints that is
   * marginal by design and a slow moment kills the run before it starts.
   */
  const cfg = await startEnvironment(env, new StaticProofServerContainer(PROVER_PORT), note);
  good(`node      ${cfg.node}`);
  good(`indexer   ${cfg.indexer}`);
  good(`prover    ${cfg.proofServer}`);

  const live = await bringUpWallet(logger, cfg, masterSeed, NETWORK, ROOT, {
    withDust: true,
    requireDust: true,
    onNote: note,
  });
  const wallet: any = live.wallet;
  good(`wallet ready — NIGHT ${live.night()}, DUST ${live.dust()}`);

  const unshieldedAddressBech32 = wallet.unshieldedKeystore?.getBech32Address?.()?.asString?.();
  if (unshieldedAddressBech32) good(`address  ${unshieldedAddressBech32}`);

  const { unshieldedToken } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  const NIGHT = (unshieldedToken() as any).raw;
  const dustOf = (s: any) => { try { return BigInt(s?.dust?.balance(new Date()) ?? 0n); } catch { return 0n; } };

  /*
   * Enough DUST for the whole run, not merely non-zero.
   *
   * `dust > 0` passed at 1.1e16 on a young Stagenet and the transaction then
   * died inside the coin selector with "Insufficient Funds: could not balance
   * dust". The target is measured against this chain rather than
   * constant, because ledger 8 quoted 0 and 1 for the same operations that
   * ledger 9 charges 1e14 for.
   *
   * SEVEN CIRCUITS on a fresh run: the deploy, issuePublic, wrap, deposit, pay,
   * the second wrap, and unwrap. Under-counting does not make the gate lenient
   * in a harmless way — it makes it pass and then run out on the last call,
   * which is the exact failure it exists to prevent.
   */
  {
    const CIRCUITS = 7;
    const nightUtxos = (live.state()?.unshielded?.availableCoins ?? []).filter((c: any) => c.utxo?.type === NIGHT);
    let target = 0n;
    try {
      const est: any = await wallet.wallet.estimateRegistration(nightUtxos);
      const per = BigInt(est.fee);
      target = per * BigInt(CIRCUITS + 3);
      good(`a transaction costs about ${per} here — ${CIRCUITS} circuits plus headroom needs ${target}`);
    } catch (e: any) {
      note(`  could not estimate the fee (${String(e?.message ?? e).slice(0, 90)}); not gating on it`);
    }
    if (target > 0n && dustOf(live.state()) < target) {
      note(`  ${dustOf(live.state())} is short of that — waiting for DUST to accrue`);
      try {
        await wallet.wallet.waitForGeneratedDust(nightUtxos, target, { timeoutMs: 10 * 60_000 });
        good(`DUST now ${dustOf(live.state())}`);
      } catch (e: any) {
        warn(`still short: ${String(e?.message ?? e).slice(0, 110)}`);
        warn('going ahead — if a circuit fails with "could not balance dust", that is why');
      }
    }
  }

  /*
   * WAIT FOR THE DUST WALLET TO CATCH UP BEFORE SUBMITTING ANYTHING.
   *
   * The first run of this script died here — three attempts, all rejected by
   * the node with `1010: Invalid Transaction: Custom error: 170`, which is
   * `InvalidDustSpendProof`. The gate above checks the dust BALANCE, and a
   * balance is not a synced wallet: the fee proof is built from the dust
   * wallet's view of generation state, and a view still catching up produces a
   * proof the node refuses.
   *
   * `deploy-preview.ts` already knew this. It carries a paragraph of comment
   * naming error 170 and the loop that prevents it. This script was written
   * fresh, copied the balance gate, did not copy the wait, and rediscovered the
   * failure at the cost of a run — one rule living in one file instead of one
   * place, which is the oldest and most expensive habit in this project.
   *
   * The wait now lives in `dust-wallet.ts` and both scripts call it.
   */
  await waitForDustCatchUp(live, note, progressOf);
  if (!dustProgressKnown(dustProgressOf(live.state()))) {
    // Not a tick. The wallet will not say how far behind it is, so claiming it
    // has caught up would be printing a fact nobody established.
    note(`the wallet does not report how far behind its dust view is — ${progressOf(live.state())}`);
    note('so nothing here can promise the fee proof will verify; the cache age limit is the guard');
  } else if (dustCaughtUp(dustProgressOf(live.state()))) {
    good(`dust wallet caught up — ${progressOf(live.state())}`);
  }

  // Cached immediately rather than at the end: a run that dies in stage 7 must
  // still leave a usable cache, or the next attempt pays the five-minute sync.
  {
    const cached = await saveDustState(wallet, masterSeed, NETWORK, ROOT);
    if (cached) good(`dust wallet state cached (${(cached / 1024).toFixed(0)} KB) — the next run skips the long sync`);
  }
  note(`sync: ${progressOf(live.state())}`);

  /* ---------- providers ---------- */

  const rawZkConfigProvider = new NodeZkConfigProvider<string>(ARTIFACTS);
  const zkConfigProvider = timed(rawZkConfigProvider, {
    getProverKey: PH.readKey, getVerifierKey: PH.readKey, getZKIR: PH.readKey,
    get: PH.readKey, getVerifierKeys: PH.readKey,
  } as any);

  const rawProofProvider = httpClientProofProvider(cfg.proofServer, rawZkConfigProvider);

  const providers: any = {
    zkConfigProvider,
    proofProvider: timed(rawProofProvider as any, { proveTx: PH.prove, check: PH.prove, prove: PH.prove } as any),
    privateStateProvider: timed(levelPrivateStateProvider({
      accountId: PRIVATE_STATE_ID,
      privateStateStoreName: PRIVATE_STATE_ID,
      privateStoragePasswordProvider: async () => PRIVATE_STATE_PASSWORD,
    } as any) as any, {
      get: PH.privateState, set: PH.privateState, remove: PH.privateState,
      clear: PH.privateState, getSigningKey: PH.privateState, setSigningKey: PH.privateState,
      setContractAddress: PH.privateState,
    } as any),
    publicDataProvider: timed(indexerPublicDataProvider(cfg.indexer, cfg.indexerWS) as any, {
      queryContractState: PH.queryState, watchForTxData: PH.confirm, watchForContractState: PH.confirm,
      queryZSwapAndContractState: PH.queryState, queryDeployContractState: PH.queryState,
      queryContractEvents: PH.queryState, queryUnshieldedBalances: PH.queryState,
    } as any),
    /*
     * The wallet's own balanceTx, decomposed so each of its three steps gets a
     * phase code. Copied from run-preview.ts, including the fallback: if any
     * field it needs is missing on this build, use the SDK's method rather than
     * failing.
     */
    walletProvider: timed({
      balanceTx: async (tx: any, ttl?: Date) => {
        try { note(`  balancing — wallet sync at this moment: ${live.state() ? progressOf(live.state()) : 'unknown'}`); }
        catch { /* reporting is not worth failing the call over */ }
        const inner = wallet.wallet;
        const zk = wallet.zswapSecretKeys;
        const dk = wallet.dustSecretKey;
        const ks = wallet.unshieldedKeystore;
        if (!inner?.balanceUnboundTransaction || !zk || !dk || !ks?.signDataAsync) {
          note('  (using the SDK balanceTx: the decomposed path is not available on this build)');
          return wallet.balanceTx(tx, ttl);
        }
        const deadline = ttl ?? new Date(Date.now() + 60 * 60_000);
        const at = Date.now();
        const lap = (what: string) => note(`    ${what} in ${((Date.now() - at) / 1000).toFixed(1)}s`);

        setAmbient(PH.balanceUnbound);
        const recipe = await inner.balanceUnboundTransaction(
          tx, { shieldedSecretKeys: zk, dustSecretKey: dk }, { ttl: deadline });
        lap('balanceUnboundTransaction');

        setAmbient(PH.signRecipe);
        // signDataAsync, not signData: the callback became async in wallet-sdk
        // 2.0, and the synchronous one still exists, which is why the wrong one
        // type-checks and then fails at runtime.
        const signed = await inner.signRecipe(recipe, (payload: any) => ks.signDataAsync(payload));
        lap('signRecipe');

        setAmbient(PH.finalizeRecipe);
        const done = await inner.finalizeRecipe(signed);
        lap('finalizeRecipe');

        setAmbient(PH.balance);
        return done;
      },
      getCoinPublicKey: () => wallet.getCoinPublicKey(),
      getEncryptionPublicKey: () => wallet.getEncryptionPublicKey(),
    } as any, { balanceTx: PH.balance } as any),
    midnightProvider: timed({ submitTx: (tx: any) => wallet.submitTx(tx) } as any, { submitTx: PH.submit } as any),
  };

  /* ---------- the call harness ---------- */

  const timings: Array<[string, number]> = [];

  /**
   * Runs a circuit call with an upper bound, a heartbeat, and a check before
   * any retry.
   *
   * `withRetry` alone is not enough: it catches a throw, and the failure this
   * guards against is a HANG — sixteen minutes of silence waiting on an indexer
   * subscription that had closed. A wait with no bound throws nothing and
   * retries never, so the watchdog thread is what bounds this.
   *
   * `landed()` is what makes retrying safe. A timeout waiting for confirmation
   * does not mean the transaction failed, and every circuit in this contract
   * has a visible effect worth checking: each one increments its own counter.
   */
  const callCircuit = async (
    name: string,
    fn: () => Promise<any>,
    landed?: () => Promise<boolean>,
    attempts = 3,
  ): Promise<any> => {
    const started = Date.now();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const t = Date.now();
      watchdog.postMessage({ label: name });
      beginStep();
      setAmbient(PH.build);
      try {
        // No Promise.race here, deliberately: a race needs a tick to resolve,
        // and the failure this guards against is the loop not ticking.
        const res = await fn();
        endStep();
        const secs = (Date.now() - t) / 1000;
        timings.push([name, secs]);
        good(`${name} settled in ${secs.toFixed(1)}s`);
        return res;
      } catch (e: any) {
        const phaseAtFailure = Number(Atomics.load(shared, PHASE));
        endStep();
        const layer = classifyFailure(e, phaseAtFailure === PH.prove);
        note(`${name} failed on attempt ${attempt} of ${attempts} in ${layer}: ${String(e?.message ?? e).split('\n')[0]}`);
        (e as any).probeLayer = layer;
        if (landed) {
          try {
            if (await landed()) {
              const secs = (Date.now() - started) / 1000;
              timings.push([name, secs]);
              good(`${name} actually landed on chain despite the error (${secs.toFixed(1)}s)`);
              return undefined;
            }
            note(`  checked the chain: ${name} did not take effect, so retrying is safe`);
          } catch { /* fall through to the retry */ }
        }
        if (attempt === attempts) throw e;
        await sleep(5000 * attempt);
      }
    }
    return undefined;
  };

  /* -------------------------------------------------- 3 */
  begin(3, 9, 'Deploying ChainProbe, or reusing the one from the last run');

  let contractAddress = '';
  let found: any;

  if (existsSync(OUT_FILE)) {
    /*
     * RE-RUNNABLE, deliberately. Every stage below costs a proof and several
     * minutes, and the interesting one is stage 7 — so a second attempt at the
     * dump must not have to pay for a fresh deployment first. The counters make
     * a reused contract legible: `wraps 2, payouts 1` is the state a completed
     * previous run leaves behind, and it is printed rather than hidden.
     */
    const saved = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
    if (saved.network !== NETWORK) {
      throw new Error(
        `${OUT_FILE.replace(ROOT + '/', '')} records a deployment on ${saved.network}, not ${NETWORK}.\n` +
          '  A contract address means nothing on another chain. Delete that file to redeploy.',
      );
    }
    contractAddress = String(saved.contractAddress);
    note(`reusing the ChainProbe deployed at ${new Date(saved.deployedAt).toISOString()}`);
    found = await findDeployedContract(providers as any, {
      compiledContract: compiled,
      contractAddress,
    } as any);
    good(`found on chain, verifier keys match — ${contractAddress.slice(0, 24)}…`);
  } else {
    note('this is the first proof for this contract on this network; give it a minute');
    /*
     * Settle before submitting. The node's websocket closes cleanly a few
     * seconds after the wallet connects, so submitting immediately is
     * submitting into the gap on purpose.
     */
    note('letting the node websocket settle before submitting');
    await sleep(6000);

    /*
     * NO `args`, NO `initialPrivateState`, NO `privateStateId`.
     *
     * ChainProbe's constructor takes nothing and it declares no witnesses, so
     * the generated `initialState` has no arguments and there is no private
     * state to seed. The SDK's options type is conditional on exactly that, so
     * the base form is the right one here — unlike the account contract, which
     * passes a threshold and a device's key material.
     */
    const deployed: any = await callCircuit('deploy', () =>
      deployContract(providers as any, { compiledContract: compiled } as any));
    if (!deployed) throw new Error('the deploy reported landed but returned nothing to continue from');
    found = deployed;
    contractAddress = String(deployed.deployTxData.public.contractAddress);
    good(`contract address  ${contractAddress}`);
    writeFileSync(
      OUT_FILE,
      JSON.stringify({
        network: NETWORK,
        contractAddress,
        deployedAt: new Date().toISOString(),
        // Recorded so a later reader can tell which run's numbers a state
        // belongs to without re-deriving them from the report.
        wrapAmount: String(WRAP_AMOUNT),
        payAmount: String(PAY_AMOUNT),
      }, null, 2),
    );
    good(`address written to ${OUT_FILE.replace(ROOT + '/', '')}`);
  }

  providers.privateStateProvider.setContractAddress?.(contractAddress);

  const readState = async () => {
    const st = await providers.publicDataProvider.queryContractState(contractAddress);
    if (!st) throw new Error('the indexer has no state for this contract');
    return readLedger(st.data);
  };
  /** The raw thing the indexer holds, kept alongside the decoded form. */
  const readRawState = async () => providers.publicDataProvider.queryContractState(contractAddress);

  /**
   * Everything the contract's PUBLIC state says, printed.
   *
   * `held` is a public map from token colour to the coin itself — values and
   * all. That is the published vault pattern, and the contract's own header
   * says it is used here on purpose so that a failure is attributable to the
   * question rather than to custody mechanics. It also means the coin's VALUE
   * is public, which stage 7 makes a great deal of.
   */
  const show = (l: any, label: string) => {
    say(`  \x1b[1m${label}\x1b[0m`);
    say(`    issued ${l.publicIssued}   wraps ${l.wraps}   deposits ${l.deposits}   payouts ${l.payouts}   unwraps ${l.unwraps}`);
    const entries = [...l.held] as Array<[Uint8Array, any]>;
    if (entries.length === 0) say('    holds no coins');
    for (const [colour, coin] of entries) {
      say(`    holds ${coin.value} of ${hex(colour).slice(0, 24)}…  (nonce ${hex(coin.nonce).slice(0, 16)}…, mt_index ${coin.mt_index})`);
    }
  };

  const heldValueOf = (l: any, colourHex: string): bigint | null => {
    for (const [colour, coin] of [...l.held] as Array<[Uint8Array, any]>) {
      if (hex(colour) === colourHex) return BigInt(coin.value);
    }
    return null;
  };

  const opening = await readState();
  show(opening, 'the contract, before this run');

  /* ---------- which tokens this contract issues ----------
   *
   * The contract derives them as `tokenType(pad(32, "probe-public"), kernel.self())`
   * and the same value has to be computed here to know which balance to wait
   * for. `rawTokenType(domainSeparator, contractAddress)` in ledger-v9 is the
   * same derivation from the outside.
   *
   * UNCERTAIN: whether Compact's `pad(32, "probe-public")` is the UTF-8 bytes
   * followed by zeros, which is what `domainSeparator` below assumes. It is not
   * verifiable offline, and getting it wrong would produce a token type that
   * matches nothing. So it is used as a HINT rather than as a fact: every wait
   * below falls back to "whichever token actually appeared", and the two are
   * compared out loud. That way a wrong guess costs a printed warning instead
   * of a hung run.
   */
  const { rawTokenType } = await import('@midnightntwrk/ledger-v9');
  const domainSeparator = (s: string): Uint8Array => {
    const out = new Uint8Array(32);
    const b = new TextEncoder().encode(s);
    if (b.length > 32) throw new Error(`"${s}" does not fit in a 32 byte domain separator`);
    out.set(b, 0);
    return out;
  };
  /*
   * If the compiler put `publicToken`/`privateToken` in `pureCircuits`, USE
   * THEM — the contract's own derivation cannot disagree with itself, which is
   * the same rule as `assetKeyOf` in run-preview.ts.
   *
   * It probably did not: both call `kernel.self()`, which needs a call context,
   * and a circuit that needs a context is not pure. Hence the fallback, and
   * hence checking rather than assuming either way.
   */
  const fromPureCircuits = (name: 'publicToken' | 'privateToken') =>
    typeof (pureCircuits as any)?.[name] === 'function'
      ? attempt(`pureCircuits.${name}()`, () => hex((pureCircuits as any)[name]() as Uint8Array))
      : null;

  const derived = {
    publicToken: fromPureCircuits('publicToken') ?? attempt('deriving the public token type', () =>
      String((rawTokenType as any)(domainSeparator('probe-public'), contractAddress))),
    privateToken: fromPureCircuits('privateToken') ?? attempt('deriving the private token type', () =>
      String((rawTokenType as any)(domainSeparator('probe-private'), contractAddress))),
  };
  note(
    (pureCircuits as any)?.publicToken
      ? '  token types came from the contract\'s own pure circuits'
      : '  the contract\'s token circuits are not pure (they read kernel.self()), so these are derived here',
  );
  const guessedPublicToken = derived.publicToken.ok ? derived.publicToken.value : null;
  const guessedPrivateToken = derived.privateToken.ok ? derived.privateToken.value : null;
  if (guessedPublicToken) note(`the public token should be  ${guessedPublicToken.slice(0, 32)}…`);
  else warn(`could not derive the public token type — ${(derived.publicToken as any).why}`);
  if (guessedPrivateToken) note(`the private token should be ${guessedPrivateToken.slice(0, 32)}…`);
  else warn(`could not derive the private token type — ${(derived.privateToken as any).why}`);
  note('  both are guesses until the coins actually appear; they are checked against reality below');

  /* ---------- our own keys, and the recipient's ---------- */

  const {
    encodeCoinPublicKey, encodeUserAddress, encodeShieldedCoinInfo,
  } = await import('@midnight-ntwrk/compact-runtime');

  /** `ZswapCoinPublicKey` in Compact is a one-field struct: `{ bytes }`. */
  const asCoinPublicKey = (cpk: string) => ({ bytes: (encodeCoinPublicKey as any)(cpk) as Uint8Array });
  /** `UserAddress` likewise. */
  const asUserAddress = (addr: string) => ({ bytes: (encodeUserAddress as any)(addr) as Uint8Array });
  /**
   * `ShieldedCoinInfo` is `{ nonce, color, value }` — the qualified form adds
   * `mt_index`, which `deposit` and `unwrap` do not take.
   */
  const asCoin = (ledgerCoin: any) =>
    (encodeShieldedCoinInfo as any)({ type: ledgerCoin.type, nonce: ledgerCoin.nonce, value: BigInt(ledgerCoin.value) });

  const ourCoinPublicKey: string = String(wallet.getCoinPublicKey());
  const ourUserAddress: string = String(wallet.unshieldedKeystore.getAddress());
  good(`our coin public key  ${ourCoinPublicKey.slice(0, 24)}…`);
  good(`our user address     ${ourUserAddress.slice(0, 24)}…`);

  /*
   * The second address, and the encryption key that makes paying to it possible.
   *
   * THIS IS NOT DECORATION. `createZswapOutput` resolves a recipient's
   * encryption public key from the wallet's own key, the burn address, and an
   * explicit mapping — and throws "Unable to resolve encryption public key for
   * recipient" for anything else. So a payment to an address that is not the
   * caller's cannot be built at all unless the caller supplies that mapping.
   * That is a genuine property of the SDK worth knowing, and it is why stage 7
   * goes through `withContractScopedTransaction` rather than `found.callTx.pay`
   * directly — the scoped form is the only one that takes the mapping.
   */
  const { ZswapSecretKeys } = await import('@midnightntwrk/ledger-v9');
  const recipientKeys: any = (ZswapSecretKeys as any).fromSeed(RECIPIENT_SEED);
  const recipientCoinPublicKey: string = String(recipientKeys.coinPublicKey);
  const recipientEncryptionPublicKey = recipientKeys.encryptionPublicKey;
  good(`recipient coin public key  ${recipientCoinPublicKey.slice(0, 24)}…  (a key we made this run, so we control it)`);

  /* ---------- waiting for the wallet to see things ---------- */

  const unshieldedBalanceOf = (raw: string): bigint => {
    try { return BigInt(live.state()?.unshielded?.balances?.[raw] ?? 0n); } catch { return 0n; }
  };
  const shieldedCoins = (): any[] => {
    try { return [...(live.state()?.shielded?.availableCoins ?? [])]; } catch { return []; }
  };

  /**
   * Waits for the wallet to see something, printing what it sees.
   *
   * Every stage below needs the PREVIOUS stage's money to be visible before it
   * can be balanced, and "the transaction landed" is not the same as "the
   * wallet has caught up with it". Skipping this wait is how a run fails inside
   * the coin selector with a message about funds that are plainly on chain.
   */
  const waitUntil = async (what: string, done: () => boolean, timeoutMs = 5 * 60_000): Promise<boolean> => {
    const started = Date.now();
    let printed = 0;
    for (;;) {
      if (done()) return true;
      const elapsed = Date.now() - started;
      if (elapsed > timeoutMs) {
        warn(`gave up waiting for ${what} after ${Math.round(timeoutMs / 1000)}s — going on anyway, because a`);
        warn('failure with a stated cause teaches more than a run that refuses to continue');
        return false;
      }
      if (elapsed - printed >= 10_000) {
        printed = elapsed;
        note(`  ${String(Math.round(elapsed / 1000)).padStart(3)}s waiting for ${what} — ${progressOf(live.state())}`);
      }
      await sleep(2000);
    }
  };

  /* -------------------------------------------------- 4 */
  begin(4, 9, 'Step 1 — issuePublic: minting a public test token to ourselves');
  note('nothing about this is private, and it is not meant to be. It stands in for a');
  note('company acquiring a public stablecoin, and it is the CONTROL for stage 7: the');
  note('same search that comes up empty on the payment must find this amount here.');

  const unshieldedBefore: Record<string, bigint> = {};
  for (const [raw, v] of Object.entries(live.state()?.unshielded?.balances ?? {})) unshieldedBefore[raw] = BigInt(v as any);

  const issuedBefore = BigInt(opening.publicIssued);
  const issueTx: any = await callCircuit(
    'issuePublic',
    () => found.callTx.issuePublic(ISSUE_AMOUNT, asUserAddress(ourUserAddress)),
    async () => BigInt((await readState()).publicIssued) > issuedBefore,
  );
  show(await readState(), 'after issuePublic');

  await waitUntil('the public token to appear in the wallet', () => {
    const balances = live.state()?.unshielded?.balances ?? {};
    for (const [raw, v] of Object.entries(balances)) {
      if (raw === NIGHT) continue;
      if (BigInt(v as any) > (unshieldedBefore[raw] ?? 0n)) return true;
    }
    return false;
  });

  /** Whichever unshielded token actually grew — reality, not the derivation. */
  let publicTokenRaw: string | null = null;
  for (const [raw, v] of Object.entries(live.state()?.unshielded?.balances ?? {})) {
    if (raw === NIGHT) continue;
    if (BigInt(v as any) > (unshieldedBefore[raw] ?? 0n)) { publicTokenRaw = raw; break; }
  }
  if (publicTokenRaw) {
    good(`the wallet now holds ${unshieldedBalanceOf(publicTokenRaw)} of ${publicTokenRaw.slice(0, 32)}…`);
    if (guessedPublicToken && guessedPublicToken !== publicTokenRaw) {
      warn('THE DERIVED PUBLIC TOKEN TYPE DOES NOT MATCH THE ONE THAT ARRIVED.');
      warn(`  derived ${guessedPublicToken}`);
      warn(`  arrived ${publicTokenRaw}`);
      warn('  That means the assumption about pad(32, "…") in this script is wrong. The run');
      warn('  continues on the token that actually arrived, which is the right one.');
    } else if (guessedPublicToken) {
      good('the derived public token type matches the one that arrived — pad(32, …) is as assumed');
    }
  } else {
    warn('no new unshielded token appeared. The wrap below will almost certainly fail to balance.');
    publicTokenRaw = guessedPublicToken;
  }

  /* -------------------------------------------------- 5 */
  begin(5, 9, 'Step 2 — wrap: public in, private ticket out, in ONE circuit');
  say('');
  say('  \x1b[1mThis is the first thing that can fail in the proof server rather than the compiler.\x1b[0m');
  note('A Midnight forum report says receiving and sending against the same balance in one');
  note('circuit compiles cleanly and then fails while proving. If that happens here it is');
  note('reported as such below, and it is a PRODUCT finding — converting becomes two steps');
  note('for a person rather than one — not merely a code change.');
  say('');

  const coinIdsBefore = new Set(shieldedCoins().map((c: any) => hex(c.commitment ?? new Uint8Array())));
  const wrapsBefore = BigInt((await readState()).wraps);

  try {
    await callCircuit(
      'wrap (first ticket)',
      () => found.callTx.wrap(WRAP_AMOUNT, asCoinPublicKey(ourCoinPublicKey), WRAP_NONCE_A),
      async () => BigInt((await readState()).wraps) > wrapsBefore,
    );
  } catch (e: any) {
    const layer: Layer = (e as any).probeLayer ?? classifyFailure(e, false);
    say('');
    if (layer === 'the proof server') {
      say('  \x1b[31m\x1b[1mWRAP FAILED IN THE PROOF SERVER.\x1b[0m');
      say('  \x1b[1mThat is the reported failure mode, reproduced.\x1b[0m');
      note('The contract compiled — the artifacts this script loaded are proof of that — and');
      note('the proof of the same circuit could not be produced. Receiving and sending');
      note('against one balance in a single circuit is therefore not usable as one action,');
      note('and the converter has to be two steps for a person: hand the money over, then');
      note('claim the ticket. That is a change to what the product does, not to how it is');
      note('written, and it is what this probe existed to find out.');
    } else {
      say(`  \x1b[31m\x1b[1mWRAP FAILED IN ${layer.toUpperCase()}, WHICH IS NOT THE QUESTION.\x1b[0m`);
      note('The forum report is about the proof server specifically. A failure anywhere else');
      note('says nothing about whether the shape survives proving — it has to be fixed and');
      note('the run repeated before question 2 has an answer either way.');
    }
    say('');
    say(describeError(e).split('\n').map((l) => '    ' + l).join('\n'));
    throw e;
  }
  good('wrap produced a proof and settled — receiving and sending in one circuit SURVIVES proving');
  note('  which means the converter can be one action for a person, at least on this shape');
  show(await readState(), 'after wrap');

  await waitUntil('the private ticket to appear in the wallet', () =>
    shieldedCoins().some((c: any) => !coinIdsBefore.has(hex(c.commitment ?? new Uint8Array()))));

  const newCoins = shieldedCoins().filter((c: any) => !coinIdsBefore.has(hex(c.commitment ?? new Uint8Array())));
  if (newCoins.length === 0) {
    throw new Error(
      'the wrap landed but no new shielded coin reached the wallet.\n' +
        '  Without the ticket in hand there is nothing to deposit, and every stage after\n' +
        '  this one is about that coin. The most likely cause is the shielded sub-wallet\n' +
        '  still catching up: wait a few minutes and run this again — the deployment is\n' +
        '  recorded, so it will be reused rather than redeployed.',
    );
  }
  const ticketA = newCoins[0].coin;
  const privateTokenRaw: string = String(ticketA.type);
  good(`ticket in hand: ${ticketA.value} of ${privateTokenRaw.slice(0, 32)}…`);
  if (guessedPrivateToken && guessedPrivateToken !== privateTokenRaw) {
    warn('the derived private token type does not match the ticket that arrived; using the ticket');
  }
  if (BigInt(ticketA.value) !== WRAP_AMOUNT) {
    warn(`the ticket is worth ${ticketA.value}, not the ${WRAP_AMOUNT} that was wrapped — the`);
    warn('wallet may have merged it with an earlier ticket from a previous run');
  }

  /* -------------------------------------------------- 6 */
  begin(6, 9, 'Step 3 — deposit: the private ticket goes into the contract');
  note('The published vault pattern verbatim: merge with what is held if the contract');
  note('already knows this token, otherwise store it as it is. The coin is held in a');
  note('PUBLIC map — values and all — which is deliberate, and which stage 7 returns to.');

  const depositsBefore = BigInt((await readState()).deposits);
  await callCircuit(
    'deposit',
    () => found.callTx.deposit(asCoin(ticketA)),
    async () => BigInt((await readState()).deposits) > depositsBefore,
  );
  const afterDeposit = await readState();
  show(afterDeposit, 'after deposit');

  const heldColourHex = (() => {
    // The colour the contract filed the coin under, read off the chain rather
    // than assumed — it is the key `pay` will look up, so a mismatch here is a
    // failed assert three minutes later.
    for (const [colour] of [...afterDeposit.held] as Array<[Uint8Array, any]>) {
      return hex(colour);
    }
    return null;
  })();
  if (!heldColourHex) throw new Error('the deposit landed but the contract holds nothing — there is nothing for `pay` to spend');
  const heldBeforePay = heldValueOf(afterDeposit, heldColourHex);
  good(`the contract publicly holds ${heldBeforePay} of ${heldColourHex.slice(0, 24)}…`);

  /* -------------------------------------------------- 7 */
  begin(7, 9, 'Step 4 — pay, and the dump this whole script exists for');

  const stateBeforePayRaw = await readRawState();
  const stateBeforePay = await readState();
  const payoutsBefore = BigInt(stateBeforePay.payouts);
  const blockBeforePay = await providers.publicDataProvider.queryBlock().catch(() => null);

  say('');
  note(`paying ${PAY_AMOUNT} to ${recipientCoinPublicKey.slice(0, 24)}… out of the ${heldBeforePay} the contract holds`);
  note('the change stays with the contract, which is the branch of `pay` under test');
  say('');

  /*
   * THE SCOPED TRANSACTION, and why this one call is not `found.callTx.pay(...)`.
   *
   * The recipient is not this wallet, so the SDK cannot resolve an encryption
   * public key for the shielded output it has to build, and
   * `createZswapOutput` throws rather than guessing. The only supported way to
   * supply one is `additionalCoinEncPublicKeyMappings`, which the plain
   * `callTx` interface has no parameter for and the scoped form does.
   *
   * UNCERTAIN: whether `withContractScopedTransaction` needs the circuit called
   * as `callTx.pay(txCtx, …)` on this exact build. That overload is in the
   * shipped types (`CircuitCallTxInterface` has both signatures) and the scope
   * returns the same `FinalizedCallTxData` the plain path does, so everything
   * downstream is unchanged — but it has not been executed. If it turns out to
   * be wrong the fallback is to pay to our OWN coin public key, which needs no
   * mapping and answers a slightly weaker version of the same question.
   */
  const payResult: any = await callCircuit(
    'pay',
    () => withContractScopedTransaction(
      providers as any,
      async (txCtx: any) => {
        await (found.callTx as any).pay(txCtx, PAY_AMOUNT, asCoinPublicKey(recipientCoinPublicKey));
      },
      {
        additionalCoinEncPublicKeyMappings: new Map([
          [recipientCoinPublicKey, recipientEncryptionPublicKey],
        ]) as any,
      } as any,
    ),
    async () => BigInt((await readState()).payouts) > payoutsBefore,
  );

  const stateAfterPayRaw = await readRawState();
  const stateAfterPay = await readState();
  show(stateAfterPay, 'after pay');
  const heldAfterPay = heldValueOf(stateAfterPay, heldColourHex);

  /* ---------- what the transaction actually was ---------- */

  /**
   * The finalized data, from two directions.
   *
   * `payResult.public` is what the call returned in this process. Asking the
   * indexer again for the same transaction id is what ANY observer would do
   * with nothing but the id, and the two being equal is itself worth recording
   * — if they differ, the thing an observer sees is the second one.
   */
  if (!payResult) {
    /*
     * `callCircuit` returns undefined when a call threw and the landed-check
     * then found the effect on chain anyway. For every other stage that is a
     * complete answer; for THIS one it is not, because the deliverable is the
     * transaction itself and we no longer hold a handle to it. Said out loud
     * rather than producing a dump full of nulls that reads like a finding.
     */
    warn('THE PAYMENT LANDED BUT THIS PROCESS LOST ITS HANDLE ON THE TRANSACTION.');
    warn('The counter moved, so the payout happened — but the call threw before returning,');
    warn('so there is no transaction id to ask the indexer about. The dump below will have');
    warn('the contract state either side of it and nothing else. Run this again: the');
    warn('deployment is recorded, and a second payment answers the same question.');
  }

  const localPublic: any = payResult?.public ?? null;
  const txId: string | null = localPublic?.txId ? String(localPublic.txId) : null;
  let observed: any = localPublic;
  if (txId) {
    note(`asking the indexer for ${txId.slice(0, 24)}… as an observer would`);
    try {
      // Bounded by hand: `watchForTxData` waits indefinitely by contract, and
      // the transaction is already known to have landed, so a wait here is a
      // hang and not a delay.
      observed = await Promise.race([
        providers.publicDataProvider.watchForTxData(txId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('the indexer did not answer within 90s')), 90_000)),
      ]);
      good('the indexer returned the same transaction from its id alone');
    } catch (e: any) {
      warn(`could not re-fetch the transaction from the indexer: ${String(e?.message ?? e).slice(0, 140)}`);
      warn('falling back to what the call itself returned, which is the same public data');
    }
  } else {
    warn('the call returned no transaction id, so the indexer could not be asked independently');
  }

  const tx: any = observed?.tx ?? null;

  /*
   * Everything the ledger's own Transaction type will tell us. Each in its own
   * `attempt`, because a build that renames one must not cost the other twelve
   * — the dump is the deliverable and a partial dump is still an answer.
   */
  const serialized = tx ? attempt('tx.serialize()', () => (tx.serialize() as Uint8Array)) : { ok: false as const, why: 'no transaction to serialize' };
  const serializedBytes = serialized.ok ? serialized.value : new Uint8Array();
  const serializedHex = serialized.ok ? hex(serializedBytes) : '';

  const txDetail = {
    toString: tx ? attempt('tx.toString(false)', () => String(tx.toString(false))) : { ok: false, why: 'no transaction' },
    toStringCompact: tx ? attempt('tx.toString(true)', () => String(tx.toString(true))) : { ok: false, why: 'no transaction' },
    transactionHash: tx ? attempt('tx.transactionHash()', () => String(tx.transactionHash())) : { ok: false, why: 'no transaction' },
    identifiers: tx ? attempt('tx.identifiers()', () => (tx.identifiers() as any[]).map(String)) : { ok: false, why: 'no transaction' },
    serializedBytes: serialized.ok ? serializedBytes.length : 0,
    serializedHex,
    // The imbalance per segment is the ledger's own summary of what a
    // transaction moves. For an UNSHIELDED movement it is a number; the whole
    // question is whether a shielded one shows up here too.
    imbalancesGuaranteed: tx ? attempt('tx.imbalances(0)', () => tx.imbalances(0)) : { ok: false, why: 'no transaction' },
    imbalancesFallible: tx ? attempt('tx.imbalances(1)', () => tx.imbalances(1)) : { ok: false, why: 'no transaction' },
    guaranteedOffer: tx ? attempt('tx.guaranteedOffer', () => tx.guaranteedOffer) : { ok: false, why: 'no transaction' },
    fallibleOffer: tx ? attempt('tx.fallibleOffer', () => tx.fallibleOffer) : { ok: false, why: 'no transaction' },
    intents: tx ? attempt('tx.intents', () => tx.intents) : { ok: false, why: 'no transaction' },
    bindingRandomness: tx ? attempt('tx.bindingRandomness', () => tx.bindingRandomness) : { ok: false, why: 'no transaction' },
    rewards: tx ? attempt('tx.rewards', () => tx.rewards) : { ok: false, why: 'no transaction' },
  };

  /* ---------- the indexer's own view ---------- */

  let events: any[] = [];
  const eventsResult = await (async () => {
    try {
      // Every event this contract has emitted, not just this transaction's, so
      // the payment's events can be compared with the issue and the wrap. The
      // block bound keeps a re-run from paging forever.
      events = await providers.publicDataProvider.queryContractEvents(
        { contractAddress },
        { limit: 200 },
      );
      return { ok: true as const, count: events.length };
    } catch (e: any) {
      return { ok: false as const, why: String(e?.message ?? e).slice(0, 300) };
    }
  })();
  if (eventsResult.ok) good(`the indexer has ${eventsResult.count} contract event(s) for this address`);
  else warn(`the indexer would not return contract events: ${eventsResult.why}`);

  const eventsForThisTx = txDetail.transactionHash && (txDetail.transactionHash as any).ok
    ? events.filter((ev: any) => String(ev.transactionHash ?? '') === String((txDetail.transactionHash as any).value))
    : [];

  const unshieldedForContract = await (async () => {
    try { return await providers.publicDataProvider.queryUnshieldedBalances(contractAddress); }
    catch (e: any) { return `(unavailable: ${String(e?.message ?? e).slice(0, 160)})`; }
  })();

  const zswapAndState = await (async () => {
    try { return await providers.publicDataProvider.queryZSwapAndContractState(contractAddress); }
    catch (e: any) { return `(unavailable: ${String(e?.message ?? e).slice(0, 160)})`; }
  })();

  /* ---------- the search ---------- */

  const dumpForSearch = {
    finalized: jsonSafe(observed),
    transaction: jsonSafe(txDetail),
    events: jsonSafe(events),
    stateBefore: jsonSafe(stateBeforePayRaw),
    stateAfter: jsonSafe(stateAfterPayRaw),
    zswapAndState: jsonSafe(zswapAndState),
    unshieldedBalances: jsonSafe(unshieldedForContract),
  };
  const dumpJsonText = JSON.stringify(dumpForSearch, null, 2);

  const corpora: Corpus[] = [
    { name: 'the serialised transaction (raw bytes)', bytes: serializedBytes },
    { name: 'the serialised transaction (hex text)', text: serializedHex },
    { name: 'the transaction printed by the ledger (tx.toString)', text: (txDetail.toString as any).ok ? (txDetail.toString as any).value : '' },
    { name: 'the indexer\'s contract events for this transaction', text: JSON.stringify(jsonSafe(eventsForThisTx)) },
    { name: 'the indexer\'s contract events for this contract', text: JSON.stringify(jsonSafe(events)) },
    { name: 'the contract state before the payment', text: JSON.stringify(jsonSafe(stateBeforePayRaw)) },
    { name: 'the contract state after the payment', text: JSON.stringify(jsonSafe(stateAfterPayRaw)) },
    { name: 'the whole dump', text: dumpJsonText },
  ];

  const payHits = searchFor(PAY_AMOUNT, corpora);

  /*
   * TWO CONTROLS, because a search that finds nothing has proved nothing until
   * it has been shown to be capable of finding something.
   *
   *   positive: the PUBLIC amount from stage 4. It is on the chain in the open
   *             by construction, so if the same search cannot find it in that
   *             transaction the search is broken and every other result here is
   *             worthless.
   *   negative: a number of the same magnitude that this run never used. Hits
   *             on it are the false-positive rate — with a 32-byte corpus and a
   *             four-byte needle, coincidences are expected.
   */
  const controlNumber = (PAY_AMOUNT * 7n) + 13n;
  const negativeHits = searchFor(controlNumber, corpora);

  const issueTxObj: any = issueTx?.public?.tx ?? null;
  const issueSerialized = issueTxObj ? attempt('issue tx.serialize()', () => issueTxObj.serialize() as Uint8Array) : { ok: false as const, why: 'the issuePublic result was not retained' };
  const issueCorpora: Corpus[] = issueSerialized.ok
    ? [
      { name: 'the issuePublic transaction (raw bytes)', bytes: issueSerialized.value },
      { name: 'the issuePublic transaction (hex text)', text: hex(issueSerialized.value) },
      { name: 'the issuePublic transaction (tx.toString)', text: attempt('issue toString', () => String(issueTxObj.toString(false))).ok ? String(issueTxObj.toString(false)) : '' },
    ]
    : [];
  const positiveHits = issueCorpora.length ? searchFor(ISSUE_AMOUNT, issueCorpora) : [];

  /* ---------- what the PUBLIC STATE alone gives away ----------
   *
   * The finding that does not depend on a single byte of the transaction.
   *
   * `held` is a public map from colour to the coin, and a coin carries its
   * value. So the contract's own state says, in the open, how much it held
   * before this transaction and how much it holds after. The difference is the
   * payout, exactly, to anyone who reads two blocks.
   *
   * That is not a defect in Midnight and it is not news to the contract: its
   * header says the storage is the published pattern on purpose, so that a
   * failure is attributable to the question rather than to custody. But it is
   * the first thing an observer would try, so it is measured rather than
   * waved away — and it means a real vault MUST hold a commitment instead.
   */
  const publicStateRecovery = (heldBeforePay !== null && heldAfterPay !== null)
    ? { before: heldBeforePay, after: heldAfterPay, difference: heldBeforePay - heldAfterPay }
    : null;

  /* ---------- write the dump ---------- */

  const dumpJsonPath = join(LOG_DIR, 'chain-probe-payment-tx.json');
  const dumpTextPath = join(LOG_DIR, 'chain-probe-payment-tx.txt');

  const dump = {
    question:
      'Can an observer recover the payout amount from anything this payment made public?',
    caveat:
      'The absence of a literal number is NOT proof of privacy. A value can be committed, ' +
      'encoded as a field element, compressed, encrypted to a recipient, or inferred from ' +
      'the size, the fee, the timing, or from other public state — none of which a byte ' +
      'search would find. This dump answers only "is it written down in the clear".',
    ranAt: new Date().toISOString(),
    network: NETWORK,
    contractAddress,
    amounts: {
      issuedPublicly: String(ISSUE_AMOUNT),
      wrapped: String(WRAP_AMOUNT),
      paid: String(PAY_AMOUNT),
      paidEncodings: encodingsOf(PAY_AMOUNT),
      negativeControl: String(controlNumber),
    },
    recipient: {
      coinPublicKey: recipientCoinPublicKey,
      note: 'a key generated in this process, so the payment goes somewhere we control but no wallet watches',
    },
    tokens: {
      publicTokenObserved: publicTokenRaw,
      publicTokenDerived: guessedPublicToken,
      privateTokenObserved: privateTokenRaw,
      privateTokenDerived: guessedPrivateToken,
    },
    finalizedTxData: jsonSafe(observed),
    finalizedTxDataFromTheCallItself: jsonSafe(localPublic),
    transaction: jsonSafe(txDetail),
    contractStateBefore: {
      raw: jsonSafe(stateBeforePayRaw),
      decoded: {
        publicIssued: String(stateBeforePay.publicIssued),
        wraps: String(stateBeforePay.wraps),
        deposits: String(stateBeforePay.deposits),
        payouts: String(stateBeforePay.payouts),
        unwraps: String(stateBeforePay.unwraps),
        held: [...stateBeforePay.held].map(([c, coin]: [Uint8Array, any]) => ({
          colour: hex(c), value: String(coin.value), nonce: hex(coin.nonce), mtIndex: String(coin.mt_index),
        })),
      },
      atBlock: jsonSafe(blockBeforePay),
    },
    contractStateAfter: {
      raw: jsonSafe(stateAfterPayRaw),
      decoded: {
        publicIssued: String(stateAfterPay.publicIssued),
        wraps: String(stateAfterPay.wraps),
        deposits: String(stateAfterPay.deposits),
        payouts: String(stateAfterPay.payouts),
        unwraps: String(stateAfterPay.unwraps),
        held: [...stateAfterPay.held].map(([c, coin]: [Uint8Array, any]) => ({
          colour: hex(c), value: String(coin.value), nonce: hex(coin.nonce), mtIndex: String(coin.mt_index),
        })),
      },
    },
    indexer: {
      contractEvents: jsonSafe(events),
      contractEventsForThisTransaction: jsonSafe(eventsForThisTx),
      unshieldedBalances: jsonSafe(unshieldedForContract),
      zswapAndContractState: jsonSafe(zswapAndState),
    },
    search: {
      payoutAmount: { value: String(PAY_AMOUNT), hits: payHits },
      negativeControl: { value: String(controlNumber), hits: negativeHits },
      positiveControl: {
        value: String(ISSUE_AMOUNT),
        searchedIn: issueCorpora.map((c) => c.name),
        hits: positiveHits,
      },
    },
    recoveryFromPublicStateAlone: publicStateRecovery
      ? {
        heldBefore: String(publicStateRecovery.before),
        heldAfter: String(publicStateRecovery.after),
        difference: String(publicStateRecovery.difference),
        equalsThePayout: publicStateRecovery.difference === PAY_AMOUNT,
        why:
          'ChainProbe stores its coin in a PUBLIC map, which carries the coin\'s value. ' +
          'This is the published vault pattern, used here on purpose. It means the payout ' +
          'is recoverable by subtraction regardless of what the transaction reveals — a ' +
          'real vault has to hold a commitment instead.',
      }
      : null,
  };

  writeFileSync(dumpJsonPath, JSON.stringify(dump, null, 2));

  const asText: string[] = [];
  asText.push('THE PAYMENT TRANSACTION, IN FULL');
  asText.push('');
  asText.push(dump.question);
  asText.push('');
  asText.push(dump.caveat);
  asText.push('');
  asText.push(`network            ${NETWORK}`);
  asText.push(`contract           ${contractAddress}`);
  asText.push(`amount paid        ${PAY_AMOUNT}`);
  asText.push(`recipient          ${recipientCoinPublicKey}`);
  asText.push(`transaction id     ${txId ?? '(none returned)'}`);
  asText.push(`transaction hash   ${(txDetail.transactionHash as any).ok ? (txDetail.transactionHash as any).value : '(unavailable)'}`);
  asText.push(`serialised size    ${serializedBytes.length} bytes`);
  asText.push('');
  asText.push('── THE TRANSACTION AS THE LEDGER PRINTS IT ──');
  asText.push((txDetail.toString as any).ok ? (txDetail.toString as any).value : `(unavailable: ${(txDetail.toString as any).why})`);
  asText.push('');
  asText.push('── THE SERIALISED TRANSACTION, HEX ──');
  asText.push(serializedHex || '(unavailable)');
  asText.push('');
  asText.push('── THE CONTRACT STATE EITHER SIDE OF IT ──');
  asText.push(JSON.stringify(dump.contractStateBefore.decoded, null, 2));
  asText.push(JSON.stringify(dump.contractStateAfter.decoded, null, 2));
  asText.push('');
  asText.push('── THE INDEXER\'S EVENTS ──');
  asText.push(JSON.stringify(jsonSafe(events), null, 2));
  asText.push('');
  asText.push('── THE SEARCH ──');
  asText.push(JSON.stringify(dump.search, null, 2));
  asText.push('');
  asText.push('── EVERYTHING ELSE ──');
  asText.push(dumpJsonText);
  writeFileSync(dumpTextPath, asText.join('\n'));

  good(`dump written to ${dumpJsonPath.replace(ROOT + '/', '')}`);
  good(`dump written to ${dumpTextPath.replace(ROOT + '/', '')}`);

  /* ---------- and what it says ---------- */

  say('');
  say('  \x1b[1mCAN AN OBSERVER READ THE PAYOUT AMOUNT?\x1b[0m');
  say('');
  say(`  Looking for ${PAY_AMOUNT} — as decimal digits, and as ${encodingsOf(PAY_AMOUNT).length} byte encodings —`);
  say(`  in ${corpora.length} places, totalling ${serializedBytes.length} bytes of transaction and`);
  say(`  ${dumpJsonText.length} characters of everything else.`);
  say('');

  if (positiveHits.length > 0) {
    good(`the same search DOES find the public amount ${ISSUE_AMOUNT} in the public issuePublic`);
    good(`transaction (${positiveHits.length} hit(s)) — so the search works, and a miss below means something`);
  } else if (issueCorpora.length === 0) {
    warn('the positive control could not run: the issuePublic transaction was not available to');
    warn('search. A miss below is therefore UNVERIFIED — the search has not been shown to work.');
  } else {
    warn('THE POSITIVE CONTROL FAILED. The search could not find the public amount in the');
    warn('public transaction either, so it is not capable of finding an amount that IS there.');
    warn('Every result below is worthless until that is understood.');
  }
  if (negativeHits.length > 0) {
    warn(`the negative control (${controlNumber}, never used) got ${negativeHits.length} hit(s), so short byte`);
    warn('patterns do collide by chance here — weigh the payout hits against that');
  } else {
    note(`the negative control (${controlNumber}, never used) got no hits, so a hit is not just noise`);
  }
  say('');

  if (payHits.length === 0) {
    say('  \x1b[32m\x1b[1mThe payout amount does not appear literally anywhere in the payment transaction,\x1b[0m');
    say('  \x1b[32m\x1b[1min its serialised bytes, or in the indexer\'s view of it.\x1b[0m');
    say('');
    warn('THAT IS NOT PROOF OF PRIVACY, and the report must not be written as though it were.');
    note('A search for a literal number cannot see a value that is committed, hashed, encoded');
    note('as a field element, compressed, or encrypted to the recipient — and none of those');
    note('are hypothetical, they are how this chain works. It also cannot see an amount that');
    note('is recoverable by INFERENCE: from the transaction size, the fee, the timing, the');
    note('set of plausible amounts, or from other public state. What this result supports is');
    note('the narrow claim that the amount is not written down in the clear. Anything');
    note('stronger needs a cryptographic argument, not a byte search.');
  } else {
    say('  \x1b[31m\x1b[1mTHE PAYOUT AMOUNT APPEARS IN PUBLIC DATA.\x1b[0m');
    say('');
    for (const h of payHits) {
      say(`    ${h.corpus}`);
      say(`      as ${h.form} (${h.pattern}) — ${h.occurrences} occurrence(s)`);
    }
    say('');
    note('Weigh each of these against the negative control above before concluding: a short');
    note('pattern in a long byte string can occur by chance, and a hit in a corpus that also');
    note('contains the contract state is not the same as a hit in the transaction itself.');
  }

  say('');
  if (publicStateRecovery) {
    say('  \x1b[1mAND SEPARATELY, WITHOUT READING THE TRANSACTION AT ALL:\x1b[0m');
    say(`    the contract publicly held ${publicStateRecovery.before} before, and ${publicStateRecovery.after} after.`);
    if (publicStateRecovery.difference === PAY_AMOUNT) {
      say(`    \x1b[31m\x1b[1mThe difference is ${publicStateRecovery.difference}, which is the payout, exactly.\x1b[0m`);
    } else {
      say(`    The difference is ${publicStateRecovery.difference}, against a payout of ${PAY_AMOUNT}.`);
    }
    note('ChainProbe stores its coin in a PUBLIC map, and a coin carries its value. That is');
    note('the published vault pattern and it is used here on purpose — the contract\'s own');
    note('header says so — because the two questions being asked are about what a PAYMENT');
    note('reveals and whether one circuit can do two things, and neither depends on how the');
    note('coin was stored. But it settles something on its own: a vault built this way');
    note('leaks every amount by subtraction no matter how private the transaction is, so the');
    note('real one has to hold a COMMITMENT. The private-storage variant needs its own run.');
  }

  /* -------------------------------------------------- 8 */
  begin(8, 9, 'Step 5, part one — a second wrap, so there is a ticket to unwrap');
  note('Stage 6 gave the contract the first ticket, and `unwrap` burns a ticket the CALLER');
  note('sends in — so one has to be in our hands. This is question 2 asked a second time,');
  note('which is worth having: one success could be luck about how the balancer happened');
  note('to lay the transaction out.');

  const coinIdsBeforeB = new Set(shieldedCoins().map((c: any) => hex(c.commitment ?? new Uint8Array())));
  const wrapsBeforeB = BigInt((await readState()).wraps);
  await callCircuit(
    'wrap (second ticket)',
    () => found.callTx.wrap(WRAP_AMOUNT, asCoinPublicKey(ourCoinPublicKey), WRAP_NONCE_B),
    async () => BigInt((await readState()).wraps) > wrapsBeforeB,
  );
  await waitUntil('the second ticket to appear in the wallet', () =>
    shieldedCoins().some((c: any) => !coinIdsBeforeB.has(hex(c.commitment ?? new Uint8Array()))));
  const newCoinsB = shieldedCoins().filter((c: any) => !coinIdsBeforeB.has(hex(c.commitment ?? new Uint8Array())));
  if (newCoinsB.length === 0) {
    throw new Error('the second wrap landed but no ticket reached the wallet, so there is nothing to unwrap');
  }
  const ticketB = newCoinsB[0].coin;
  good(`second ticket in hand: ${ticketB.value} of ${String(ticketB.type).slice(0, 32)}…`);

  /* -------------------------------------------------- 9 */
  begin(9, 9, 'Step 5 — unwrap: ticket burned, public money back, in ONE circuit');
  note('The second half of question 2, and the path a person uses to cash out. Solvency is');
  note('checked by asking the LEDGER what the contract really holds rather than by trusting');
  note('a number it wrote down itself — which is the whole reason the converter keeps no books.');

  const unwrapsBefore = BigInt((await readState()).unwraps);
  try {
    await callCircuit(
      'unwrap',
      () => found.callTx.unwrap(asCoin(ticketB), asUserAddress(ourUserAddress)),
      async () => BigInt((await readState()).unwraps) > unwrapsBefore,
    );
    good('unwrap produced a proof and settled — the second half of the converter survives proving too');
  } catch (e: any) {
    const layer: Layer = (e as any).probeLayer ?? classifyFailure(e, false);
    say('');
    if (layer === 'the proof server') {
      say('  \x1b[31m\x1b[1mUNWRAP FAILED IN THE PROOF SERVER, AND WRAP DID NOT.\x1b[0m');
      note('So the two halves are not symmetric. `unwrap` receives, burns and sends in one');
      note('circuit where `wrap` receives and mints — cashing out has to become two steps for');
      note('a person even though converting in does not. That asymmetry is a product finding.');
    } else {
      say(`  \x1b[31m\x1b[1mUNWRAP FAILED IN ${layer.toUpperCase()}.\x1b[0m`);
    }
    say('');
    say(describeError(e).split('\n').map((l) => '    ' + l).join('\n'));
    throw e;
  }

  const finalState = await readState();
  show(finalState, 'the contract, at the end');

  /* ---------- the summary ---------- */

  say('');
  say('────────────────────────────────────────────────────────────');
  say('  \x1b[1mWHAT THIS RUN ANSWERED\x1b[0m');
  say('────────────────────────────────────────────────────────────');
  say('');
  say('  \x1b[1mQuestion 2 — does one circuit survive taking in and paying out?\x1b[0m');
  say(`    wrap    ${BigInt(finalState.wraps) > 0n ? 'yes, twice' : 'no'}`);
  say(`    unwrap  ${BigInt(finalState.unwraps) > 0n ? 'yes' : 'no'}`);
  say('    So the converter can be ONE action for a person, on this shape, on this chain,');
  say('    with this proof server. That is what was tested and it is all that was tested.');
  say('');
  say('  \x1b[1mQuestion 1 — can an observer read the payout amount?\x1b[0m');
  say(`    in the transaction, literally      ${payHits.length === 0 ? 'not found' : `FOUND (${payHits.length} hit(s))`}`);
  if (publicStateRecovery) {
    say(`    by subtracting public state        ${publicStateRecovery.difference === PAY_AMOUNT ? 'RECOVERED EXACTLY' : `difference ${publicStateRecovery.difference}`}`);
  }
  say('');
  say('    The second line is the one that matters for the product, and it is a fact about');
  say('    THIS contract\'s storage rather than about Midnight: ChainProbe holds its coin in');
  say('    a public map on purpose. A vault that holds a commitment instead needs its own');
  say('    run and its own script before anything can be claimed about it.');
  say('');

  if (timings.length) {
    say('  \x1b[1mWhat each circuit cost\x1b[0m');
    for (const [name, secs] of timings) say(`    ${name.padEnd(24)} ${secs.toFixed(1)}s`);
    const fees = Number(Atomics.load(shared, FEE_CALLS));
    if (fees) say(`    the ledger was asked to price a transaction ${fees} time(s); the last answer was ${Atomics.load(shared, LAST_FEE)}`);
    say('');
  }

  say(`  The full dump is in ${dumpJsonPath.replace(ROOT + '/', '')}`);
  say(`  and ${dumpTextPath.replace(ROOT + '/', '')}.`);
  say(`  This report is ${REPORT_FILE.replace(ROOT + '/', '')}.`);
  say('');

  live.stop();
  await env.shutdown(false);
}

main().then(
  () => process.exit(0),
  (e) => {
    say('');
    say(`\x1b[31m\x1b[1m  Failed during: ${stage}\x1b[0m`);
    say(describeError(e).split('\n').map((l) => '  ' + l).join('\n'));
    if (e?.stack) say(`\n\x1b[2m${e.stack.split('\n').slice(1, 8).join('\n')}\x1b[0m`);
    say('');
    say('  Send this whole output back. The stage name above says which layer broke,');
    say('  so the next fix does not have to be a guess. The deployment is recorded in');
    say(`  ${OUT_FILE.replace(ROOT + '/', '')}, so running this again reuses the contract`);
    say('  rather than paying for a fresh one.');
    process.exit(1);
  },
);

/**
 * Preflight: does this machine have everything needed to settle a real
 * transaction on the target Midnight network?
 *
 * This answers, in order, the questions that have historically each cost a
 * round trip to discover one at a time. It changes nothing and deploys
 * nothing. Every check prints PASS or FAIL with the actual reason.
 *
 * Run it with PREFLIGHT.command, or: npx tsx scripts/preflight.ts
 *
 * The endpoints come from the one endpoint table in `src/midnight/network.ts`, and the
 * network is the one this build is compiled for, so nothing here keeps a table or a
 * network name of its own.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { ENDPOINTS as ENDPOINTS_BY_NAME, theNetwork } from '../src/midnight/network.js';
import { PROOF_SERVER_IMAGE } from '../.github/checks/toolchain.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const NET = theNetwork();
const E = ENDPOINTS_BY_NAME[NET];
const ENDPOINTS = E && { indexer: E.indexerUrl, node: E.nodeUrl, faucet: E.faucetUrl };

/**
 * The proof server image this stack expects: the one pin in
 * `.github/checks/toolchain.mjs`. `MIDNIGHT_PROOF_IMAGE` overrides it for one run.
 */
const PROOF_IMAGE = process.env.MIDNIGHT_PROOF_IMAGE || PROOF_SERVER_IMAGE;

let passed = 0;
let failed = 0;
const blockers = [];

const line = (s: string = '') => console.log(s);
const head = (s: string) => { line(); line(`\x1b[1m${s}\x1b[0m`); line('─'.repeat(64)); };

function check(name: string, fn: () => unknown, { blocking = true, hint = '' }: { blocking?: boolean; hint?: string } = {}) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      passed++;
      console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
    })
    .catch((e) => {
      failed++;
      console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
      console.log(`        ${String(e.message || e).split('\n')[0]}`);
      if (hint) console.log(`        \x1b[2m→ ${hint}\x1b[0m`);
      if (blocking) blockers.push(name);
    });
}

const fetchJson = async (url, init, timeoutMs = 20000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    return { status: r.status, ok: r.ok, text };
  } finally {
    clearTimeout(t);
  }
};

line();
line('\x1b[1m╭──────────────────────────────────────────────────────────────╮\x1b[0m');
line('\x1b[1m│  Confidential Accounts — preflight                            │\x1b[0m');
line(`\x1b[1m│  network: ${NET.padEnd(51)}│\x1b[0m`);
line('\x1b[1m╰──────────────────────────────────────────────────────────────╯\x1b[0m');

if (!ENDPOINTS) {
  line();
  line(`\x1b[31mNo endpoints are known for "${NET}".\x1b[0m`);
  line('Add them to src/midnight/network.ts — there is one table and this reads it.');
  process.exit(1);
}

/* ---------------------------------------------------------------- */
head('1. Toolchain');

await check('node is the major version .nvmrc names', () => {
  const want = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim();
  if (process.versions.node.split('.')[0] !== want.split('.')[0]) {
    throw new Error(`node ${process.versions.node} runs here and .nvmrc names ${want}; install Node ${want}`);
  }
  return `v${process.versions.node}`;
});

await check(
  'every package.json dependency is actually installed',
  () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const want = Object.keys(pkg.dependencies || {});
    const missing = want.filter((n) => !existsSync(join(ROOT, 'node_modules', ...n.split('/'))));
    if (missing.length) throw new Error(`not installed: ${missing.join(', ')}`);
    return `${want.length} packages`;
  },
  { hint: 'run: npm install' },
);

await check('contract is compiled', () => {
  const dir = join(ROOT, 'contracts', 'managed');
  if (!existsSync(dir)) throw new Error('contracts/managed does not exist');
  return dir.replace(ROOT + '/', '');
});

await check(
  'proving and verifier keys are built',
  () => {
    const base = join(ROOT, 'contracts', 'managed');
    const hits = [];
    const walk = (d, depth = 0) => {
      if (depth > 3 || !existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name), depth + 1);
        else if (/\.(prover|verifier|bzkir|zkir)$/.test(e.name)) hits.push(e.name);
      }
    };
    walk(base);
    if (!hits.length) throw new Error('no prover/verifier/zkir artefacts found under contracts/managed');
    return `${hits.length} artefacts`;
  },
  { hint: 'run: npm run compact' },
);

/* ---------------------------------------------------------------- */
head('2. Network id — the thing that broke every transaction');

await check('the address codec takes the network\'s lowercase name, not the ledger enum', async () => {
  const { parseCoinPublicKeyToHex } = await import('@midnight-ntwrk/midnight-js-utils');
  const { ShieldedCoinPublicKey } = await import('@midnightntwrk/wallet-sdk-address-format');

  const addr = String(
    ShieldedCoinPublicKey.codec.encode(NET, new ShieldedCoinPublicKey(Buffer.alloc(32, 7))),
  );
  parseCoinPublicKeyToHex(addr, NET); // throws if the id shape is wrong
  return addr.slice(0, 30) + '…';
});

/* ---------------------------------------------------------------- */
head('3. Can this machine reach the network?');

await check(
  'indexer answers a GraphQL query',
  async () => {
    const r = await fetchJson(ENDPOINTS.indexer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} — ${r.text.slice(0, 160)}`);
    return `HTTP ${r.status}`;
  },
  { hint: `check ${ENDPOINTS.indexer} in a browser` },
);

await check(
  'node RPC answers',
  async () => {
    const r = await fetchJson(ENDPOINTS.node, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_chain', params: [] }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} — ${r.text.slice(0, 160)}`);
    let chain = r.text.slice(0, 120);
    try { chain = JSON.parse(r.text).result ?? chain; } catch {}
    return String(chain);
  },
  { hint: `check ${ENDPOINTS.node} in a browser` },
);

await check('faucet host is reachable', async () => {
  const r = await fetchJson(ENDPOINTS.faucet, { method: 'GET' }, 15000);
  // Any HTTP answer proves reachability. 404/405 on GET is fine: it wants POST.
  return `HTTP ${r.status}`;
}, { blocking: false, hint: 'without a faucet the wallet cannot be funded' });

/* ---------------------------------------------------------------- */
head('4. Proof server (Docker)');

await check(
  'docker is installed and the daemon is running',
  () => {
    const out = execSync('docker version --format "{{.Server.Version}}"', {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
    })
      .toString()
      .trim();
    if (!out) throw new Error('no server version reported');
    return `server ${out}`;
  },
  { hint: 'open Docker Desktop and wait for it to say "Engine running"' },
);

await check(
  'proof server image is present locally',
  () => {
    const out = execSync('docker images --format "{{.Repository}}:{{.Tag}}"', {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
    }).toString();
    const hit = out.split('\n').find((l) => l.includes('proof-server'));
    // Not just "a proof server": the right one. Every major ZKIR release
    // changes the format and verifier keys carry a versioned header, so a
    // server of the wrong version rejects proofs it cannot read.
    if (!hit) throw new Error('no proof-server image pulled yet');
    if (!out.includes(PROOF_IMAGE)) {
      throw new Error(`${PROOF_IMAGE} is not pulled; found instead: ${hit.trim()}`);
    }
    return PROOF_IMAGE;
  },
  { blocking: false, hint: `run: docker pull ${PROOF_IMAGE}` },
);

/* ---------------------------------------------------------------- */
head('Result');

line(`  ${passed} passed, ${failed} failed`);
line();
if (blockers.length === 0) {
  line('  \x1b[32mEverything the deploy needs is present on this machine.\x1b[0m');
  line('  Next: the deploy script can run against ' + NET + '.');
} else {
  line('  \x1b[31mBlocked on:\x1b[0m');
  for (const b of blockers) line(`    • ${b}`);
  line();
  line('  Send me this whole output and I will fix the specific thing,');
  line('  rather than guessing at the next layer down.');
}
line();
process.exit(blockers.length ? 1 : 0);

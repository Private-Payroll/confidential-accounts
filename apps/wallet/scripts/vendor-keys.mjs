/*
 * VENDOR THE PROVING-KEY MATERIAL — the fix for the CORS bucket and the open half
 * of that problem.
 *
 * WHY. Proving needs circuit key material. The SDK's default provider
 * downloads it from a hardcoded Amazon bucket that has CORS disabled —
 * measured: Amazon's own words are
 * "CORSResponse: CORS is not enabled for this bucket" — so no web page can
 * fetch it, and nothing ever verified what came back. This script runs in
 * Node (no CORS applies), downloads every artefact a send can need, hashes
 * each one, and writes the files plus a manifest of SHA-256 pins into
 * apps/wallet/public/keys/ — which vite serves from the wallet's OWN origin at
 * /keys/. The app's provider (apps/wallet/key-material.ts) verifies every byte
 * against those pins before proving, and refuses loudly on any mismatch.
 *
 * THE PINS ARE TAKEN ONCE AND THEN DEFENDED. The first run writes the
 * manifest. Every later run re-downloads and compares against the EXISTING
 * pins: a source file that changed since vendoring is reported and NOT
 * accepted — because a silent change to a proving key is exactly what
 * pinning exists to catch. `--repin` accepts the new bytes deliberately,
 * after a person has read why.
 *
 * TWO SOURCES CROSS-CHECK THE PARAMETERS. The shared SRS parameters exist
 * on the S3 bucket AND at https://srs.midnight.network (the trusted-setup
 * publication host); both are downloaded and must hash identically, and
 * k=16 is additionally checked against a pin recorded 20 Aug 2026, when both
 * hosts were fetched in one run and served byte-identical files (see
 * KNOWN_PINS below). No published checksum exists for the circuit keys
 * themselves (still open on that half) — for those, the pin this run
 * takes IS the integrity anchor, which is why later runs defend it.
 *
 * WHAT IS COMMITTED AND WHAT IS NOT. The artefacts (~116 MB if every
 * parameter size is held) are gitignored — they re-download and re-verify.
 * The manifest of pins IS committed: it is small, and it is the thing that
 * makes the re-download trustworthy.
 *
 * Usage:  node scripts/vendor-keys.mjs [--k 14,16] [--repin]
 *   --k      vendor only these parameter sizes (default: all, 2p10–2p18 —
 *            a send needs one k, and the probe measures which; trim after).
 *   --repin  accept changed source bytes and take new pins. Read the
 *            refusal first.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYS_DIR = path.join(ROOT, 'apps/wallet/public/keys');
const MANIFEST = path.join(KEYS_DIR, 'manifest.json');

/* The SDK's own source host, read from the shipped source
 * (wallet-sdk-prover-client/dist/effect/WasmProver.js:148). Dialled by THIS
 * NODE SCRIPT only — the app itself never touches it. */
const S3 = 'https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com';
/* The trusted-setup publication host — midnightntwrk/midnight-trusted-setup
 * serves the SRS parameters here with published SHA-256s per size. */
const SRS = 'https://srs.midnight.network';

/* The four circuits the SDK maps (WasmProver.js:166–171), version-9 paths,
 * three files each. zswap/sign is included: it is mapped and real (2.68 MB,
 * measured 20 Aug) even though a plain transfer has not asked for it yet. */
const CIRCUITS = ['zswap/9/spend', 'zswap/9/output', 'zswap/9/sign', 'dust/9/spend'];
const SUFFIXES = ['.prover', '.verifier', '.bzkir'];

/* Every parameter size that exists on the bucket, weighed 20 Aug. */
const ALL_K = [10, 11, 12, 13, 14, 15, 16, 17, 18];

/* Independently measured pins — cross-checks this run must agree with.
 * k=16: fetched 20 Aug 2026 from BOTH hosts in one run — the S3 bucket and
 * the trusted-setup host — and each served byte-identical content, which is
 * what makes this a cross-check rather than a second copy of whatever one
 * bucket served that day. The trusted-setup catalog publishes a SHA-256 for
 * every size; SIZE was compared against it, the published digest was NOT,
 * so treat the two-host agreement as the evidence and not the catalog. */
const KNOWN_PINS = {
  bls_midnight_2p16: '09c877216d6589b370263e18af40a030a901b41a7a7c37ef58c9901db41f05c6',
};

const args = process.argv.slice(2);
const repin = args.includes('--repin');
const kArg = args.includes('--k') ? args[args.indexOf('--k') + 1] : null;
const sizes = kArg ? kArg.split(',').map((s) => Number(s.trim())) : ALL_K;
if (sizes.some((k) => !ALL_K.includes(k))) {
  console.log(`  --k must name sizes that exist: ${ALL_K.join(', ')}`);
  process.exit(1);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function download(url) {
  const started = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, ms: Date.now() - started };
}

const existing = existsSync(MANIFEST)
  ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
  : null;
if (existing) {
  console.log(`  A manifest already exists (made ${existing.generatedAt}). Its pins are`);
  console.log('  DEFENDED: a source file that hashes differently is refused, not repinned.');
  console.log('');
}

const artefacts = existing ? { ...existing.artefacts } : {};
let refused = 0;
let downloadedBytes = 0;

async function vendor(relPath, extraSources = []) {
  const { bytes, ms } = await download(`${S3}/${relPath}`);
  const hash = sha256(bytes);

  /* Cross-checks: every extra source must serve the identical file. */
  for (const source of extraSources) {
    const other = await download(source);
    if (sha256(other.bytes) !== hash) {
      console.log(`  !! REFUSED ${relPath}: ${S3} and ${source} serve DIFFERENT bytes`);
      console.log(`     (${hash} vs ${sha256(other.bytes)}). Neither can be trusted until`);
      console.log('     somebody explains the difference. Nothing was written for this file.');
      refused += 1;
      return;
    }
  }
  const name = relPath.split('/').pop();
  if (KNOWN_PINS[name] && KNOWN_PINS[name] !== hash) {
    console.log(`  !! REFUSED ${relPath}: hashes to ${hash}, but the independently`);
    console.log(`     measured pin from 20 Aug is ${KNOWN_PINS[name]}. The source changed.`);
    refused += 1;
    return;
  }

  /* The defence of pins already taken. */
  const pinned = artefacts[relPath];
  if (pinned && pinned.sha256 !== hash) {
    if (!repin) {
      console.log(`  !! REFUSED ${relPath}: the source now serves ${hash}, but this`);
      console.log(`     project pinned ${pinned.sha256} on ${existing?.generatedAt}. A proving`);
      console.log('     key that changes underneath you is the exact thing pinning exists to');
      console.log('     catch. Find out why it changed; re-run with --repin only on purpose.');
      refused += 1;
      return;
    }
    console.log(`  REPINNED ${relPath}: ${pinned.sha256} → ${hash} (--repin, deliberate)`);
  }

  const target = path.join(KEYS_DIR, relPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  artefacts[relPath] = { bytes: bytes.length, sha256: hash };
  downloadedBytes += bytes.length;
  console.log(`  ${relPath.padEnd(24)} ${String(bytes.length).padStart(10)} bytes  `
    + `${String(ms).padStart(6)}ms  sha256 ${hash}`);
}

console.log('  Circuit key material (prover, verifier, IR per circuit):');
for (const circuit of CIRCUITS) {
  for (const suffix of SUFFIXES) await vendor(`${circuit}${suffix}`);
}

console.log('');
console.log(`  Shared SRS parameters (sizes: ${sizes.map((k) => `2p${k}`).join(', ')}) —`);
console.log('  each downloaded from BOTH hosts and required to match:');
for (const k of sizes) {
  await vendor(`bls_midnight_2p${k}`, [`${SRS}/midnight-srs-2p${k}`]);
}

if (refused > 0) {
  console.log('');
  console.log(`  ${refused} artefact(s) REFUSED — read the lines above. The manifest was NOT`);
  console.log('  updated for them; everything accepted was written and pinned.');
}

const manifest = {
  version: 9,
  generatedAt: existing?.generatedAt && !repin ? existing.generatedAt : new Date().toISOString(),
  lastVendoredAt: new Date().toISOString(),
  sources: { circuits: S3, parameters: [S3, SRS] },
  artefacts,
};
mkdirSync(KEYS_DIR, { recursive: true });
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

console.log('');
console.log(`  Wrote ${Object.keys(artefacts).length} pins to apps/wallet/public/keys/manifest.json`);
console.log(`  (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB downloaded this run). The app now`);
console.log('  serves and verifies key material from its own origin at /keys/ — the');
console.log('  Foundation\'s bucket is never dialled by a page again.');
console.log('');
console.log('  A send needs ONE parameter size, not nine. The wallet\'s own probe screen');
console.log('  records which k a real send asks for (watch for "params k=" under THE');
console.log('  MEASUREMENT);');
console.log('  the production hosting decision should carry the circuits plus that k.');

process.exit(refused > 0 ? 1 : 0);

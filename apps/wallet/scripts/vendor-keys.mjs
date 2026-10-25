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
 * /keys/. The app's provider (apps/wallet/src/chain/key-material.ts) verifies every byte
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
 * THE COMPANY ACCOUNT'S CIRCUITS COME FROM THIS BUILD, NOT FROM A HOST.
 * `--account` copies the account circuits the wallet proves itself, and the
 * ones a vault circuit it proves calls in the same transaction (their
 * prover, verifier and circuit files), from the compiled contract in
 * contracts/managed into the wallet's public/keys, under the folder its key
 * material serves them from, and pins each one beside the
 * network's. A verifier key whose hash is not the one the compiled contract
 * expects is refused, so the keys copied are the keys the calls are built
 * against; a pin already taken is defended exactly as the network's are.
 * The same run copies the vault's circuits the wallet proves itself
 * (setting a new vault's first secret, writing each signer's copy of it, and
 * a private deposit) from contracts/managed-vault, and the verifier key alone of every other
 * vault circuit, which a vault's deploy installs; each checked against the
 * compiled vault's own keys the same way.
 * `npm run compact` and `npm run compact:vault -- --full` build the files;
 * `npm run vendor-keys:account` copies them.
 *
 * WHAT IS COMMITTED AND WHAT IS NOT. The artefacts (~116 MB if every
 * parameter size is held, about 248 MB more with the account's and the vault's circuits) are
 * gitignored - they re-download, or are rebuilt, and re-verify. The manifest
 * of pins IS committed: it is small, and it is the thing that makes the
 * re-download trustworthy.
 *
 * Usage:  node scripts/vendor-keys.mjs [--k 14,16] [--repin]
 *         node --import tsx scripts/vendor-keys.mjs --account [--repin]
 *   --k        vendor only these parameter sizes (default: all, 2p10-2p18 -
 *              a send needs one k, and the probe measures which; trim after).
 *   --account  copy the company account's circuits from contracts/managed,
 *              and the vault's from contracts/managed-vault, instead of
 *              downloading the network's; nothing is downloaded.
 *   --repin    accept changed source bytes and take new pins. Read the
 *              refusal first.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* This script sits in the wallet's own scripts folder: one level up is the
 * wallet, whose public folder is served at /keys/, and two more are the
 * repository, where the compiled contract is. */
export const WALLET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(WALLET_DIR, '..', '..');
export const KEYS_DIR = path.join(WALLET_DIR, 'public', 'keys');
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

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The three files each contract circuit is proved with, as the wallet serves
 * them (`<folder>/<circuit>.<kind>`, the folder its key material names) and
 * where the compile wrote them (`contracts/<compiled>`: `managed` for the
 * company account, `managed-vault` for the vault). With `verifierOnly`, the
 * verifier key alone: what a deploy installs, for a circuit the wallet never proves.
 */
export const accountFilesOf = (circuits, folder, compiled = 'managed', verifierOnly = false) => circuits.flatMap((circuit) => [
  ...(verifierOnly ? [] : [{ served: `${folder}/${circuit}.prover`, built: path.join('contracts', compiled, 'keys', `${circuit}.prover`), circuit }]),
  { served: `${folder}/${circuit}.verifier`, built: path.join('contracts', compiled, 'keys', `${circuit}.verifier`), circuit },
  ...(verifierOnly ? [] : [{ served: `${folder}/${circuit}.bzkir`, built: path.join('contracts', compiled, 'zkir', `${circuit}.bzkir`), circuit }]),
]);

/**
 * COPY AND PIN THE ACCOUNT'S CIRCUITS. Reads each file from the compile under
 * `repoRoot`, refuses a circuit whose files are missing, whose verifier key is
 * not the one the compiled contract expects (`expectedVk`), or whose bytes
 * differ from a pin already in `artefacts` (unless `repin`); writes the rest
 * under `keysDir` and pins them in `artefacts`. Returns how many it refused.
 * A refused circuit writes none of its three files, so a prover is never
 * served beside a verifier from another build.
 */
export function vendorAccountKeys({ repoRoot, keysDir, circuits, folder, expectedVk, artefacts, repin = false, log = console.log, compiled = 'managed', verifierOnly = false }) {
  let refused = 0;
  for (const circuit of circuits) {
    const files = accountFilesOf([circuit], folder, compiled, verifierOnly);
    const missing = files.filter((f) => !existsSync(path.join(repoRoot, f.built)));
    if (missing.length > 0) {
      log(`  !! REFUSED ${circuit}: ${missing.map((f) => f.built).join(', ')} not on disk. \`npm run compact\` builds them.`);
      refused += 1;
      continue;
    }
    const read = files.map((f) => ({ ...f, bytes: readFileSync(path.join(repoRoot, f.built)) }));
    const verifier = read.find((f) => f.served.endsWith('.verifier'));
    const wanted = typeof expectedVk?.[circuit] === 'string' ? expectedVk[circuit].toLowerCase() : undefined;
    if (wanted === undefined || sha256(verifier.bytes) !== wanted) {
      log(`  !! REFUSED ${circuit}: its verifier key hashes to ${sha256(verifier.bytes)}, but the compiled`);
      log(`     contract expects ${wanted ?? 'no key for it'}. The keys on disk are not this compile's; run`);
      log('     `npm run compact` again. Nothing was written for this circuit.');
      refused += 1;
      continue;
    }
    const changed = read.filter((f) => artefacts[f.served] && artefacts[f.served].sha256 !== sha256(f.bytes));
    if (changed.length > 0 && !repin) {
      for (const f of changed) {
        log(`  !! REFUSED ${f.served}: the compile now holds ${sha256(f.bytes)}, but this wallet pinned`);
        log(`     ${artefacts[f.served].sha256}. A proving key that changes underneath the wallet is the`);
        log('     thing pinning exists to catch. Re-run with --repin only on purpose, once the contract');
        log('     change that made new keys is known.');
      }
      refused += 1;
      continue;
    }
    for (const f of read) {
      if (artefacts[f.served] && artefacts[f.served].sha256 !== sha256(f.bytes)) {
        log(`  REPINNED ${f.served}: ${artefacts[f.served].sha256} -> ${sha256(f.bytes)} (--repin, deliberate)`);
      }
      const target = path.join(keysDir, f.served);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(repoRoot, f.built), target);
      artefacts[f.served] = { bytes: f.bytes.length, sha256: sha256(f.bytes) };
      log(`  ${f.served.padEnd(32)} ${String(f.bytes.length).padStart(10)} bytes  sha256 ${sha256(f.bytes)}`);
    }
  }
  return refused;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const repin = args.includes('--repin');
  const kArg = args.includes('--k') ? args[args.indexOf('--k') + 1] : null;
  const sizes = kArg ? kArg.split(',').map((s) => Number(s.trim())) : ALL_K;
  if (sizes.some((k) => !ALL_K.includes(k))) {
    console.log(`  --k must name sizes that exist: ${ALL_K.join(', ')}`);
    process.exit(1);
  }

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

  const accountOnly = args.includes('--account');
  if (accountOnly) {
    /* The set is the wallet's own, read from its TypeScript, and the expected
     * verifier keys are the compiled contract's own: neither is retyped here. */
    let circuits;
    let folder;
    try {
      ({ ACCOUNT_CIRCUITS_THE_WALLET_HOLDS_KEYS_FOR: circuits } = await import(
        pathToFileURL(path.join(WALLET_DIR, 'src', 'chain', 'account-circuits.ts')).href));
      ({ ACCOUNT_KEYS_FOLDER: folder } = await import(
        pathToFileURL(path.join(WALLET_DIR, 'src', 'chain', 'key-material.ts')).href));
    } catch (e) {
      console.log('  --account reads the wallet\'s list of account circuits, which is TypeScript, so it');
      console.log(`  runs as \`npm run vendor-keys:account\` (${e?.message ?? e}).`);
      process.exit(1);
    }
    const compiled = path.join(REPO_ROOT, 'contracts', 'managed', 'contract', 'index.js');
    if (!existsSync(compiled)) {
      console.log('  There is no compiled company account at contracts/managed, so there are no keys to copy.');
      console.log('  `npm run compact` builds it.');
      process.exit(1);
    }
    const { expectedVk } = await import(pathToFileURL(compiled).href);
    console.log(`  The company account's circuits this wallet proves, itself or as a vault's call (${circuits.length}), copied from contracts/managed:`);
    refused += vendorAccountKeys({ repoRoot: REPO_ROOT, keysDir: KEYS_DIR, circuits, folder, expectedVk, artefacts, repin });

    /* The vault's: the circuits the wallet proves whole, and every other one's verifier key, which a deploy installs. */
    const { VAULT_CIRCUITS_THE_WALLET_PROVES: vaultProved, VAULT_CIRCUITS_THE_WALLET_DEPLOYS: vaultAll } = await import(
      pathToFileURL(path.join(WALLET_DIR, 'src', 'chain', 'account-circuits.ts')).href);
    const { VAULT_KEYS_FOLDER: vaultFolder } = await import(pathToFileURL(path.join(WALLET_DIR, 'src', 'chain', 'key-material.ts')).href);
    const compiledVault = path.join(REPO_ROOT, 'contracts', 'managed-vault', 'contract', 'index.js');
    if (!existsSync(compiledVault)) {
      console.log('  !! REFUSED the vault\'s keys: there is no compiled vault at contracts/managed-vault.');
      console.log('     `npm run compact:vault -- --full` builds it. The account\'s keys above are still pinned.');
      refused += 1;
    } else {
      const { expectedVk: vaultVk } = await import(pathToFileURL(compiledVault).href);
      const verifiersOnly = vaultAll.filter((c) => !vaultProved.includes(c));
      console.log(`  The vault's circuits this wallet proves (${vaultProved.length}) and the verifier keys of the rest (${verifiersOnly.length}), copied from contracts/managed-vault:`);
      refused += vendorAccountKeys({ repoRoot: REPO_ROOT, keysDir: KEYS_DIR, circuits: vaultProved, folder: vaultFolder, expectedVk: vaultVk, artefacts, repin, compiled: 'managed-vault' });
      refused += vendorAccountKeys({ repoRoot: REPO_ROOT, keysDir: KEYS_DIR, circuits: verifiersOnly, folder: vaultFolder, expectedVk: vaultVk, artefacts, repin, compiled: 'managed-vault', verifierOnly: true });
    }
  } else {
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
    sources: { ...existing?.sources, ...(accountOnly ? { account: 'contracts/managed', vault: 'contracts/managed-vault' } : { circuits: S3, parameters: [S3, SRS] }) },
    artefacts,
  };
  mkdirSync(KEYS_DIR, { recursive: true });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log('');
  console.log(`  Wrote ${Object.keys(artefacts).length} pins to apps/wallet/public/keys/manifest.json`);
  if (accountOnly) process.exit(refused > 0 ? 1 : 0);
  console.log(`  (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB downloaded this run). The app now`);
  console.log('  serves and verifies key material from its own origin at /keys/ — the');
  console.log('  Foundation\'s bucket is never dialled by a page again.');
  console.log('');
  console.log('  A send needs ONE parameter size, not nine. The wallet\'s own probe screen');
  console.log('  records which k a real send asks for (watch for "params k=" under THE');
  console.log('  MEASUREMENT);');
  console.log('  the production hosting decision should carry the circuits plus that k.');

  process.exit(refused > 0 ? 1 : 0);
}

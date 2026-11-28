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
 * on the bucket AND at https://srs.midnight.network (the trusted-setup
 * publication host); both are downloaded and must hash identically, and
 * k=16 is additionally checked against a pin recorded 20 Aug 2026, when both
 * hosts were fetched in one run and served byte-identical files (see
 * KNOWN_PINS below). The ledger release declares the hash of every file of
 * its own circuits in its source, and each file is refused unless it hashes
 * to the declared value (see LEDGER_DECLARED below); the Dust spend key comes
 * from the trusted-setup host, because the bucket serves other bytes for it.
 * A key that has moved to a new generation leaves the old one stale, and the
 * run refuses until `--prune` moves it out.
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
 * compiled vault's own keys the same way. And it copies the private registry's
 * write, which the wallet proves itself, from contracts/managed-registry, checked
 * against the compiled registry's own keys.
 * `npm run compact` and `npm run compact:vault -- --full` build the files;
 * `npm run vendor-keys:account` copies them.
 *
 * WHAT IS COMMITTED AND WHAT IS NOT. The artefacts (~116 MB if every
 * parameter size is held, about 248 MB more with the account's and the vault's circuits) are
 * gitignored - they re-download, or are rebuilt, and re-verify. The manifest
 * of pins IS committed: it is small, and it is the thing that makes the
 * re-download trustworthy.
 *
 * THE KEYS FOLDER MUST ALREADY EXIST. It holds the committed manifest, so a checkout has
 * it; a run without it is refused before anything is downloaded or written, naming
 * what restores it, and the closing line names the manifest path the run wrote.
 *
 * Usage:  node scripts/vendor-keys.mjs [--k 14,16] [--repin]
 *         node --import tsx scripts/vendor-keys.mjs --account [--repin]
 *   --k        vendor only these parameter sizes (default: all, 2p10-2p18 -
 *              a send needs one k, and the probe measures which; trim after).
 *   --account  copy the company account's circuits from contracts/managed,
 *              the vault's from contracts/managed-vault and the registry's from
 *              contracts/managed-registry, instead of downloading the network's;
 *              nothing is downloaded.
 *   --prune    with --account: move the key files and drop the pins of circuits the compile
 *              no longer builds into _to_delete/ (nothing is deleted). Without it such a
 *              file or pin is refused by name.
 *   --repin    accept changed source bytes and take new pins. Read the
 *              refusal first.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* This script sits in the wallet's own scripts folder: one level up is the
 * wallet, whose public folder is served at /keys/, and two more are the
 * repository, where the compiled contract is. */
export const WALLET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(WALLET_DIR, '..', '..');
export const KEYS_DIR = path.join(WALLET_DIR, 'public', 'keys');
const MANIFEST = path.join(KEYS_DIR, 'manifest.json');

/* The bucket the SDK's prover fetches its ledger keys and parameters from.
 * Dialled by THIS NODE SCRIPT only — the app itself never touches it. */
const BUCKET = 'https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com';
/* The trusted-setup publication host — midnightntwrk/midnight-trusted-setup
 * serves the SRS parameters here with published SHA-256s per size. */
const SRS = 'https://srs.midnight.network';

/* The ledger's own circuits the wallet proves with, read from the file the
 * wallet serves them by (src/chain/ledger-keys.json), three files each. */
export const LEDGER_CIRCUITS = Object.values(
  JSON.parse(readFileSync(path.join(WALLET_DIR, 'src', 'chain', 'ledger-keys.json'), 'utf8'))
);
/* The hash the ledger release preprod runs declares for every file of its own
 * circuits, in its source (ledger/static/dust/spend.*.sha256 and
 * zswap/static/*.sha256). A file that hashes to anything else is refused. */
export const LEDGER_DECLARED = Object.freeze({
  'zswap/9/spend.prover': '19d234b5c68b7212ad6b0ec9334a95594748154128f3704eb576bcc843cc5c45',
  'zswap/9/spend.verifier': '544554effd7ae9fb9063be52a9ec2a986756301071fcd97bb4598fb45a335658',
  'zswap/9/spend.bzkir': '7cb5bbcf67cb212a3336fb439a77e8f32f0aa8a56185c8e1247d6cbfc7300205',
  'zswap/9/output.prover': 'd992b04f13c3fd432f55fb8bfe6466d87bc181f1a2acf233ec228030bbdd4ed8',
  'zswap/9/output.verifier': '72e8074856f2f5c504ade25a86a2b8902c64aeb9497c4c8e6b26dea842a0ab08',
  'zswap/9/output.bzkir': '91dc8b401dd8385e8d29eaac018c70b578505f48c7952452ef319bc397fa1f1b',
  'zswap/9/sign.prover': 'fe7268dd2bdd107f862f881ac3c5bc71a6df77ce80bfed51cf71514648e660e0',
  'zswap/9/sign.verifier': 'e39a727caa0de167e6dd6122a9e3b758fecf48f9093ab77c0309648de8ce07e1',
  'zswap/9/sign.bzkir': '37ea2094516e145a738126307cf92bd293f7cb524b1ccd49fa6f3225a9ec3a50',
  'dust/10/spend.prover': '3dff9f54add761350ad02621a425d67fe3d656c8145fef8ef147870489ffdc81',
  'dust/10/spend.verifier': 'd15a1295780549f534287a39c938005e1faa3232be21861573bd0cdb148949cb',
  'dust/10/spend.bzkir': 'd211cacb22391b9db60f945787d98c16d344cbb4790246132117084c080399c1'
});
/* The ledger circuits the bucket serves other bytes for than the release
 * declares: these are fetched from the trusted-setup host, every other ledger
 * file from the bucket. */
const FROM_THE_TRUSTED_SETUP = Object.freeze(['dust/10/spend']);

/** The two hosts the ledger's keys are fetched from: the bucket and the trusted-setup host. */
export { BUCKET, SRS as TRUSTED_SETUP };

/** The host a ledger circuit file is fetched from. */
export const ledgerSourceOf = (relPath) =>
  FROM_THE_TRUSTED_SETUP.some((c) => relPath.startsWith(`${c}.`)) ? SRS : BUCKET;

/** The lines refusing a ledger circuit file whose bytes are not the ones its release declares, or null when they are (or nothing is declared for it). */
export const declaredRefusal = (relPath, hash, from) => {
  const declared = LEDGER_DECLARED[relPath];
  if (declared === undefined || declared === hash) return null;
  return [
    `  !! REFUSED ${relPath}: ${from} serves ${hash}, but the ledger release declares`,
    `     ${declared}. A ledger key that is not the release's is refused by the node. Nothing`,
    '     was written for this file.'
  ];
};

/**
 * The lines refusing a file whose download dropped before its bytes arrived. Nothing is written or pinned for it, every
 * file the run accepts stays written and pinned, and running the door again fetches it afresh.
 */
export const droppedRefusal = (relPath, url, cause) => [
  `  !! REFUSED ${relPath}: the download from ${url} dropped (${cause?.cause?.code ?? cause?.message ?? cause}).`,
  '     Nothing was written for this file; every file this run accepted is written and pinned.',
  '     Run this door again (with the same options) to fetch it afresh.'
];

/** Every folder of ledger circuit files the keys folder or the pins hold, one generation deep (zswap/9, dust/10, ...). */
export const ledgerFoldersOf = ({ keysDir, artefacts, circuits }) => {
  const tops = new Set(circuits.map((c) => c.split('/')[0]));
  const folders = new Set(circuits.map((c) => c.split('/').slice(0, 2).join('/')));
  for (const served of Object.keys(artefacts)) {
    const parts = served.split('/');
    if (parts.length > 2 && tops.has(parts[0])) folders.add(parts.slice(0, 2).join('/'));
  }
  for (const top of tops) {
    const dir = path.join(keysDir, top);
    if (existsSync(dir)) for (const gen of readdirSync(dir)) folders.add(`${top}/${gen}`);
  }
  return [...folders].sort();
};

const SUFFIXES = ['.prover', '.verifier', '.bzkir'];

/* Every parameter size that exists on the bucket, weighed 20 Aug. */
const ALL_K = [10, 11, 12, 13, 14, 15, 16, 17, 18];

/* Independently measured pins — cross-checks this run must agree with.
 * k=16: fetched 20 Aug 2026 from BOTH hosts in one run — the bucket and
 * the trusted-setup host — and each served byte-identical content, which is
 * what makes this a cross-check rather than a second copy of whatever one
 * bucket served that day. The trusted-setup catalog publishes a SHA-256 for
 * every size; SIZE was compared against it, the published digest was NOT,
 * so treat the two-host agreement as the evidence and not the catalog. */
const KNOWN_PINS = {
  bls_midnight_2p16: '09c877216d6589b370263e18af40a030a901b41a7a7c37ef58c9901db41f05c6'
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The three files each contract circuit is proved with, as the wallet serves
 * them (`<folder>/<circuit>.<kind>`, the folder its key material names) and
 * where the compile wrote them (`contracts/<compiled>`: `managed` for the
 * company account, `managed-vault` for the vault). With `verifierOnly`, the
 * verifier key alone: what a deploy installs, for a circuit the wallet never proves.
 */
export const accountFilesOf = (circuits, folder, compiled = 'managed', verifierOnly = false) =>
  circuits.flatMap((circuit) => [
    ...(verifierOnly
      ? []
      : [
          {
            served: `${folder}/${circuit}.prover`,
            built: path.join('contracts', compiled, 'keys', `${circuit}.prover`),
            circuit
          }
        ]),
    {
      served: `${folder}/${circuit}.verifier`,
      built: path.join('contracts', compiled, 'keys', `${circuit}.verifier`),
      circuit
    },
    ...(verifierOnly
      ? []
      : [
          {
            served: `${folder}/${circuit}.bzkir`,
            built: path.join('contracts', compiled, 'zkir', `${circuit}.bzkir`),
            circuit
          }
        ])
  ]);

/**
 * Copies the private registry's circuits the wallet proves from the registry's own compile, each checked
 * against the verifier keys that compile expects. With no compiled registry it refuses by name and
 * copies nothing. Returns how many circuits were refused, whether the registry's folder was walked, and
 * every path it serves.
 */
export async function vendorRegistryKeys({
  repoRoot,
  keysDir,
  circuits,
  folder,
  artefacts,
  repin = false,
  log = console.log
}) {
  const compiled = path.join(repoRoot, 'contracts', 'managed-registry', 'contract', 'index.js');
  if (!existsSync(compiled)) {
    log("  !! REFUSED the registry's keys: there is no compiled registry at contracts/managed-registry.");
    log('     `npm run compact` builds it with its keys. The keys above are still pinned.');
    return { refused: 1, walked: false, expected: [] };
  }
  const { expectedVk } = await import(pathToFileURL(compiled).href);
  log(
    `  The private registry's circuits this wallet proves (${circuits.length}), copied from contracts/managed-registry:`
  );
  const refused = vendorAccountKeys({
    repoRoot,
    keysDir,
    circuits,
    folder,
    expectedVk,
    artefacts,
    repin,
    log,
    compiled: 'managed-registry'
  });
  return { refused, walked: true, expected: accountFilesOf(circuits, folder, 'managed-registry').map((f) => f.served) };
}

/**
 * COPY AND PIN THE ACCOUNT'S CIRCUITS. Reads each file from the compile under
 * `repoRoot`, refuses a circuit whose files are missing, whose verifier key is
 * not the one the compiled contract expects (`expectedVk`), or whose bytes
 * differ from a pin already in `artefacts` (unless `repin`); writes the rest
 * under `keysDir` and pins them in `artefacts`. Returns how many it refused.
 * A refused circuit writes none of its three files, so a prover is never
 * served beside a verifier from another build.
 */
export function vendorAccountKeys({
  repoRoot,
  keysDir,
  circuits,
  folder,
  expectedVk,
  artefacts,
  repin = false,
  log = console.log,
  compiled = 'managed',
  verifierOnly = false
}) {
  let refused = 0;
  for (const circuit of circuits) {
    const files = accountFilesOf([circuit], folder, compiled, verifierOnly);
    const missing = files.filter((f) => !existsSync(path.join(repoRoot, f.built)));
    if (missing.length > 0) {
      log(
        `  !! REFUSED ${circuit}: ${missing.map((f) => f.built).join(', ')} not on disk. \`npm run compact\` builds them.`
      );
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

/* The served paths under the given folders that a pin or a file on disk still holds
 * but the compile no longer builds: `expected` is every path the run just walked. */
export function staleKeysOf({ keysDir, artefacts, folders, expected }) {
  const wanted = new Set(expected);
  const held = new Set();
  for (const folder of folders) {
    for (const served of Object.keys(artefacts)) if (served.startsWith(`${folder}/`)) held.add(served);
    const dir = path.join(keysDir, folder);
    if (existsSync(dir)) for (const name of readdirSync(dir)) held.add(`${folder}/${name}`);
  }
  return [...held].filter((served) => !wanted.has(served)).sort();
}

/* Moves each stale file into `graveyard` under a name that says where it came from, and
 * drops its pin. Nothing is deleted: the person who ran it empties the graveyard by hand. */
export function pruneStale({ keysDir, artefacts, stale, graveyard, stamp }) {
  mkdirSync(graveyard, { recursive: true });
  let moved = 0;
  for (const served of stale) {
    const from = path.join(keysDir, served);
    if (existsSync(from)) {
      renameSync(from, path.join(graveyard, `vendor-keys-pruned-${stamp}-${served.replaceAll('/', '-')}`));
      moved += 1;
    }
    delete artefacts[served];
  }
  return moved;
}

/* A stale key is refused unless the run was told to prune; returns how many refusals to add. */
export function pruneOrRefuse({
  keysDir,
  artefacts,
  folders,
  expected,
  prune,
  graveyard,
  stamp,
  log = console.log,
  command = 'npm run vendor-keys:account -- --prune'
}) {
  const stale = staleKeysOf({ keysDir, artefacts, folders, expected });
  if (stale.length === 0) return 0;
  if (!prune) {
    log(`  !! REFUSED ${stale.length} key file(s) or pin(s) of circuits the wallet no longer serves:`);
    for (const served of stale) log(`     ${served}`);
    log('     The wallet would keep serving them. `--prune` moves the files into _to_delete/ and drops');
    log(`     their pins; run \`${command}\` once you have read the names above.`);
    return 1;
  }
  const moved = pruneStale({ keysDir, artefacts, stale, graveyard, stamp });
  log(
    `  PRUNED ${stale.length} pin(s), moved ${moved} file(s) into ${path.basename(graveyard)}/ (--prune, deliberate)`
  );
  return 0;
}

/** The path as the report names it: from the repository's root, with forward slashes. */
const fromRoot = (repoRoot, target) => path.relative(repoRoot, target).split(path.sep).join('/');

/** Refuses (returns 1) when the keys folder is not there: the run never makes the folder it writes into, so it cannot report success at a place nothing serves. Subfolders under it are made as files land. */
export function keysFolderOrRefuse({ keysDir, repoRoot, log = console.log }) {
  if (existsSync(keysDir) && statSync(keysDir).isDirectory()) return 0;
  log(`  !! REFUSED: ${fromRoot(repoRoot, keysDir)} is not there, and this script does not make it.`);
  log('     The folder ships with manifest.json inside it, so a full checkout of the repository has it.');
  log(
    `     Restore it by checking out ${fromRoot(repoRoot, path.join(keysDir, 'manifest.json'))}, or run this from a full checkout, then run again.`
  );
  return 1;
}

/** The closing line of a run: where the manifest of pins was written, read from that path. */
export const wroteLine = ({ repoRoot, manifestPath, pins }) =>
  `  Wrote ${pins} pins to ${fromRoot(repoRoot, manifestPath)}`;

/** Node reports this file's URL by its real path, so the path it was started by is resolved the same way: a symlinked folder (macOS /var -> /private/var) must not make the script think it was imported. */
const isMain =
  process.argv[1] !== undefined &&
  realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  const args = process.argv.slice(2);
  const repin = args.includes('--repin');
  const prune = args.includes('--prune');
  const kArg = args.includes('--k') ? args[args.indexOf('--k') + 1] : null;
  const sizes = kArg ? kArg.split(',').map((s) => Number(s.trim())) : ALL_K;
  if (sizes.some((k) => !ALL_K.includes(k))) {
    console.log(`  --k must name sizes that exist: ${ALL_K.join(', ')}`);
    process.exit(1);
  }
  if (keysFolderOrRefuse({ keysDir: KEYS_DIR, repoRoot: REPO_ROOT }) !== 0) process.exit(1);

  async function download(url) {
    const started = Date.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes, ms: Date.now() - started };
  }

  const existing = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;
  if (existing) {
    console.log(`  A manifest already exists (made ${existing.generatedAt}). Its pins are`);
    console.log('  DEFENDED: a source file that hashes differently is refused, not repinned.');
    console.log('');
  }

  const artefacts = existing ? { ...existing.artefacts } : {};
  let refused = 0;
  let downloadedBytes = 0;

  /** The download, or null once its refusal is printed and counted. */
  async function downloadOrRefuse(relPath, url) {
    try {
      return await download(url);
    } catch (e) {
      for (const line of droppedRefusal(relPath, url, e)) console.log(line);
      refused += 1;
      return null;
    }
  }

  async function vendor(relPath, extraSources = [], from = BUCKET) {
    const got = await downloadOrRefuse(relPath, `${from}/${relPath}`);
    if (got === null) return;
    const { bytes, ms } = got;
    const hash = sha256(bytes);
    const refusal = declaredRefusal(relPath, hash, from);
    if (refusal !== null) {
      for (const line of refusal) console.log(line);
      refused += 1;
      return;
    }

    /* Cross-checks: every extra source must serve the identical file. */
    for (const source of extraSources) {
      const other = await downloadOrRefuse(relPath, source);
      if (other === null) return;
      if (sha256(other.bytes) !== hash) {
        console.log(`  !! REFUSED ${relPath}: ${from} and ${source} serve DIFFERENT bytes`);
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
    console.log(
      `  ${relPath.padEnd(24)} ${String(bytes.length).padStart(10)} bytes  ` +
        `${String(ms).padStart(6)}ms  sha256 ${hash}`
    );
  }

  const accountOnly = args.includes('--account');
  if (accountOnly) {
    /* The set is the wallet's own, read from its TypeScript, and the expected
     * verifier keys are the compiled contract's own: neither is retyped here. */
    let circuits;
    let folder;
    try {
      ({ ACCOUNT_CIRCUITS_THE_WALLET_HOLDS_KEYS_FOR: circuits } = await import(
        pathToFileURL(path.join(WALLET_DIR, 'src', 'chain', 'account-circuits.ts')).href
      ));
      ({ ACCOUNT_KEYS_FOLDER: folder } = await import(
        pathToFileURL(path.join(WALLET_DIR, 'src', 'chain', 'key-material.ts')).href
      ));
    } catch (e) {
      console.log("  --account reads the wallet's list of account circuits, which is TypeScript, so it");
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
    console.log(
      `  The company account's circuits this wallet proves, itself or as a vault's call (${circuits.length}), copied from contracts/managed:`
    );
    refused += vendorAccountKeys({
      repoRoot: REPO_ROOT,
      keysDir: KEYS_DIR,
      circuits,
      folder,
      expectedVk,
      artefacts,
      repin
    });
    const walked = [folder];
    const expected = accountFilesOf(circuits, folder).map((f) => f.served);

    /* The vault's: the circuits the wallet proves whole, and every other one's verifier key, which a deploy installs. */
    const { VAULT_CIRCUITS_THE_WALLET_PROVES: vaultProved, VAULT_CIRCUITS_THE_WALLET_DEPLOYS: vaultAll } = await import(
      pathToFileURL(path.join(WALLET_DIR, 'src', 'chain', 'account-circuits.ts')).href
    );
    const { VAULT_KEYS_FOLDER: vaultFolder } = await import(
      pathToFileURL(path.join(WALLET_DIR, 'src', 'chain', 'key-material.ts')).href
    );
    const compiledVault = path.join(REPO_ROOT, 'contracts', 'managed-vault', 'contract', 'index.js');
    if (!existsSync(compiledVault)) {
      console.log("  !! REFUSED the vault's keys: there is no compiled vault at contracts/managed-vault.");
      console.log("     `npm run compact:vault -- --full` builds it. The account's keys above are still pinned.");
      refused += 1;
    } else {
      const { expectedVk: vaultVk } = await import(pathToFileURL(compiledVault).href);
      const verifiersOnly = vaultAll.filter((c) => !vaultProved.includes(c));
      console.log(
        `  The vault's circuits this wallet proves (${vaultProved.length}) and the verifier keys of the rest (${verifiersOnly.length}), copied from contracts/managed-vault:`
      );
      walked.push(vaultFolder);
      expected.push(
        ...accountFilesOf(vaultProved, vaultFolder, 'managed-vault').map((f) => f.served),
        ...accountFilesOf(verifiersOnly, vaultFolder, 'managed-vault', true).map((f) => f.served)
      );
      refused += vendorAccountKeys({
        repoRoot: REPO_ROOT,
        keysDir: KEYS_DIR,
        circuits: vaultProved,
        folder: vaultFolder,
        expectedVk: vaultVk,
        artefacts,
        repin,
        compiled: 'managed-vault'
      });
      refused += vendorAccountKeys({
        repoRoot: REPO_ROOT,
        keysDir: KEYS_DIR,
        circuits: verifiersOnly,
        folder: vaultFolder,
        expectedVk: vaultVk,
        artefacts,
        repin,
        compiled: 'managed-vault',
        verifierOnly: true
      });
    }
    const { REGISTRY_CIRCUITS_THE_WALLET_PROVES: registryProved } = await import(
      pathToFileURL(path.join(WALLET_DIR, 'src', 'chain', 'account-circuits.ts')).href
    );
    const { REGISTRY_KEYS_FOLDER: registryFolder } = await import(
      pathToFileURL(path.join(WALLET_DIR, 'src', 'chain', 'key-material.ts')).href
    );
    const registry = await vendorRegistryKeys({
      repoRoot: REPO_ROOT,
      keysDir: KEYS_DIR,
      circuits: registryProved,
      folder: registryFolder,
      artefacts,
      repin
    });
    refused += registry.refused;
    if (registry.walked) walked.push(registryFolder);
    expected.push(...registry.expected);
    refused += pruneOrRefuse({
      keysDir: KEYS_DIR,
      artefacts,
      folders: walked,
      expected,
      prune,
      graveyard: path.join(REPO_ROOT, '_to_delete'),
      stamp: new Date().toISOString().slice(0, 10)
    });
  } else {
    console.log('  Circuit key material (prover, verifier, IR per circuit):');
    for (const circuit of LEDGER_CIRCUITS) {
      for (const suffix of SUFFIXES) {
        const relPath = `${circuit}${suffix}`;
        await vendor(relPath, [], ledgerSourceOf(relPath));
      }
    }
    const expected = LEDGER_CIRCUITS.flatMap((c) => SUFFIXES.map((suffix) => `${c}${suffix}`));
    const folders = ledgerFoldersOf({ keysDir: KEYS_DIR, artefacts, circuits: LEDGER_CIRCUITS });
    refused += pruneOrRefuse({
      keysDir: KEYS_DIR,
      artefacts,
      folders,
      expected,
      prune,
      graveyard: path.join(REPO_ROOT, '_to_delete'),
      stamp: new Date().toISOString().slice(0, 10),
      command: 'npm run vendor-keys -- --prune'
    });

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
    sources: {
      ...existing?.sources,
      ...(accountOnly
        ? { account: 'contracts/managed', vault: 'contracts/managed-vault', registry: 'contracts/managed-registry' }
        : { circuits: [BUCKET, SRS], parameters: [BUCKET, SRS] })
    },
    artefacts
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log('');
  console.log(wroteLine({ repoRoot: REPO_ROOT, manifestPath: MANIFEST, pins: Object.keys(artefacts).length }));
  if (accountOnly) process.exit(refused > 0 ? 1 : 0);
  console.log(`  (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB downloaded this run). The app now`);
  console.log('  serves and verifies key material from its own origin at /keys/ — the');
  console.log("  Foundation's bucket is never dialled by a page again.");
  console.log('');
  console.log("  A send needs ONE parameter size, not nine. The wallet's own probe screen");
  console.log('  records which k a real send asks for (watch for "params k=" under THE');
  console.log('  MEASUREMENT);');
  console.log('  the production hosting decision should carry the circuits plus that k.');

  process.exit(refused > 0 ? 1 : 0);
}

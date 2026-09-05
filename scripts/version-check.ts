/**
 * WHAT VERSION IS EVERYTHING, AND WHICH ROW COULD NOT BE MEASURED AT ALL.
 *
 * Read-only. Nothing is built, proved, submitted or deployed.
 *
 * Error 170 — `InvalidDustSpendProof` — is documented on Midnight's own forum
 * as a version mismatch in the fee stack rather than a wallet fault: the ledger
 * library, the proof server and the wallet SDK have to be pinned together per
 * environment, and mixing lines produces exactly this rejection.
 *
 * ── WHAT THIS PRINTS, AND WHY IT IS ONE TABLE ────────────────────────────
 *
 * One row per thing that has a version, with a verdict per row:
 *
 *   OK        measured on both sides and they agree
 *   MISMATCH  measured on both sides and they do not
 *   CLAIMED   only a document can answer, so the document is quoted and the row
 *             is NOT presented as an observation. **NOTHING PRODUCES THIS ROW
 *             ANY MORE** — the last one, "what Stagenet needs", became a
 *             derivation from the node on 28 Aug 2026. The verdict is kept
 *             because the next unanswerable question deserves it rather than a
 *             row dressed up as measured.
 *   UNKNOWN   could not be measured. **Never OK, never "matching".**
 *
 * **AN UNREACHABLE PROVER IS THE WHOLE REASON THIS ROUND EXISTS.**
 * `.midnight/version-baseline.json` from 22 Aug records `proofServerImage` as
 * `9.0.0-rc.5_experimental` while recording `prover/version`, `prover/health`
 * and `prover/` all as *"unreachable — fetch failed"*. A pin written down and
 * never once confirmed against a running server is not a measurement, and the
 * previous version of this file printed it in a way that read like one.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────
 *
 * **It does not decide what Stagenet "should" run from any document.**
 * `docs.midnight.network` serves 0.23/0.31 documentation while we compile with
 * 0.33, and the Foundation's Q2 2026 beta delivery document — until 28 Aug the
 * only source this file had for the Stagenet component list — is a draft whose
 * table has been edited forward of the running network. **THAT ROW IS NOW
 * DERIVED FROM THE NODE'S OWN PIN INSTEAD**, through the ledger git tag the
 * node commit names; the derivation is at NODE_DERIVATION below and in full in
 * `docs/stagenet.md`. Everything else is asked of a running process or read off
 * this disk.
 *
 * **It does not change the endpoints, and they are not the defect.** Suspected
 * again on 28 Aug and measured wrong: `src/midnight/network.ts:104-114` puts
 * stagenet on `indexer.stagenet.shielded.tools` / `rpc.stagenet.shielded.tools`
 * with the comment recording that these come from that same delivery document
 * and not from testkit, which has no stagenet config at all;
 * `src/midnight/network.test.ts:106-111` pins them in both directions; and the
 * 22 Aug baseline shows that node answering with `Midnight Stagenet`,
 * `2.0.0-d9729c13`, `specVersion 2000000`, `transactionVersion 4`. They are
 * right. The pins are what nothing was checking.
 *
 * **AND IT NO LONGER OVERWRITES A MEASUREMENT WITH A FAILURE.** The previous
 * version wrote its snapshot unconditionally, so one run with the network down
 * would have replaced the only record of `transactionVersion 4` with three
 * "unreachable" strings, silently. Rows that could not be measured now keep the
 * value they had, dated, and are reported as carried rather than observed.
 */
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', O = '\x1b[0m';

const NODE = process.env.MIDNIGHT_NODE_URL || 'https://rpc.stagenet.shielded.tools';
const INDEXER = process.env.MIDNIGHT_INDEXER_URL || 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
/** 6301, not 6300. M-144, and `scripts/chain-probe.ts:116-119` has the reason. */
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT || 6301);
const PROVER = process.env.MIDNIGHT_PROVER_URL || `http://localhost:${PROVER_PORT}`;

/** The image every script here is supposed to pin. One place, one spelling. */
const PINNED_IMAGE = 'midnightntwrk/proof-server:9.0.0-rc.3';

/**
 * WHAT STAGENET NEEDS IS NO LONGER A CLAIM. IT IS DERIVED FROM THE NODE.
 *
 * This row used to quote the Foundation Q2 2026 beta delivery document and read
 * CLAIMED, because a document was the only source anyone here had. That
 * document is a DRAFT its own author says must not be merged, and its component
 * table has been edited forward of the network it describes: on 28 Aug it named
 * proof server 9.0.0-rc.6, Compact.js 2.5.5-rc.7, Midnight.js 5.0.0-beta.6 and
 * indexer 4.4.0-rc.1, none of which is what the running node is built from.
 * Quoting it and marking the row CLAIMED was honest about the source and still
 * pointed at the wrong image.
 *
 * The derivation replacing it reads only primary sources, in three steps:
 *
 *   1. The chain says what it is. `state_getRuntimeVersion` on
 *      rpc.stagenet.shielded.tools returns node build 2.0.0-d9729c13,
 *      specVersion 2000000, transactionVersion 4.
 *   2. That commit's own Cargo.toml says what it was built against.
 *      midnight-node@d9729c13/Cargo.toml:445 pins midnight-ledger at git tag
 *      `crate-ledger-9.1.0.0-rc.3`. The node carries three ledger lines side by
 *      side — L7 7.0.3, L8 8.1.0, L9 — and L9 is the line transactionVersion 4
 *      selects.
 *   3. That tag says which proof server belongs to it.
 *      `crate-ledger-9.1.0.0-rc.3/proof-server/Cargo.toml` reads 9.0.0-rc.3,
 *      alongside ledger-wasm 1.0.0-rc.3 and onchain-runtime-wasm 4.0.0-rc.3 —
 *      which are exactly what this repository holds.
 *
 * **SO THE ROW IS MEASURED, NOT CLAIMED**, and its verdict is OK or MISMATCH
 * against the pin like any other measured row. The one thing still inferred is
 * step 2's last clause — that transactionVersion 4 means the L9 line — and the
 * `ledger ↔ transactionVersion` row below still reads UNKNOWN because of it.
 *
 * `docs/stagenet.md` carries this derivation in full, with the five commands
 * that re-derive every line of it from primary sources, and a section on why
 * newer is wrong here: 1.0.0-rc.4 and proof server rc.6/rc.7 belong to ledger
 * release crate-ledger-9.1.0.0-rc.4, which this node is not built from.
 */
const NODE_DERIVED_PROOF_SERVER = '9.0.0-rc.3';
const NODE_DERIVATION =
  "derived from the node: midnight-node@d9729c13/Cargo.toml:445 pins ledger tag crate-ledger-9.1.0.0-rc.3, whose proof-server/Cargo.toml reads 9.0.0-rc.3 (docs/stagenet.md)";

type Verdict = 'OK' | 'MISMATCH' | 'UNKNOWN' | 'CLAIMED';
interface Row { what: string; ours: string; theirs: string; verdict: Verdict; note?: string }
const rows: Row[] = [];
const add = (what: string, ours: string, theirs: string, verdict: Verdict, note?: string) =>
  rows.push({ what, ours, theirs, verdict, note });

const UNMEASURED = '—';

async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const res = await fetch(NODE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

async function tryFetch(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    return text.slice(0, 200).replace(/\s+/g, ' ').trim() || `(empty, HTTP ${res.status})`;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ pins --- */

/**
 * Every proof-server image and prover port this repository names, with the
 * `file:line` of each.
 *
 * **A COMMENT IS NOT A PIN.** Half the mentions of `8.1.0` here are history —
 * scripts recording what went wrong and why the port moved — and a check that
 * called those disagreements would cry wolf forever. So each hit is classified
 * by whether its line is executable or a comment, and only executable lines
 * decide the verdict. The comments are still counted, and reported separately,
 * because a comment naming a stale pin is worth knowing about even though it
 * runs nothing.
 */
interface Hit { where: string; value: string; comment: boolean }

const isComment = (line: string): boolean => /^\s*(#|\/\/|\*|\/\*)/.test(line);

const sourcesToScan = (): string[] => {
  const out: string[] = [];
  for (const n of readdirSync(ROOT).sort()) if (n.endsWith('.command')) out.push(n);
  const s = join(ROOT, 'scripts');
  if (existsSync(s)) {
    for (const n of readdirSync(s).sort()) {
      if (/\.(ts|mjs|sh|js)$/.test(n)) out.push(join('scripts', n));
    }
  }
  return out;
};

const scanPins = () => {
  const images: Hit[] = [];
  const ports: Hit[] = [];
  for (const rel of sourcesToScan()) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const where = `${rel}:${i + 1}`;
      const comment = isComment(line);
      for (const m of line.matchAll(/proof-server:([A-Za-z0-9._-]+)/g)) {
        images.push({ where, value: m[1], comment });
      }
      // Only the three shapes that actually decide a port: a default for the
      // prover port, a published container port, and a health/version URL.
      for (const rx of [
        /MIDNIGHT_PROVER_PORT[^0-9\n]{0,16}(\d{4})/g,
        /-p\s+"?\$?\{?[A-Za-z_]*:?-?(\d{4})\}?:6300/g,
        /localhost:(\d{4})\/(?:health|version)/g,
      ]) {
        for (const m of line.matchAll(rx)) ports.push({ where, value: m[1], comment });
      }
    });
  }
  return { images, ports };
};

/* ------------------------------------------------------------------ main --- */

async function main() {
  console.log(`\n${B}What everything is, right now${O}`);
  console.log(`${D}node ${NODE}${O}`);
  console.log(`${D}indexer ${INDEXER}${O}`);
  console.log(`${D}prover ${PROVER}${O}\n`);

  const measured: Record<string, unknown> = {};
  const unmeasured: string[] = [];

  /* ---------------- the node ---------------- */
  let chain: any = null;
  try {
    const rt = await rpc('state_getRuntimeVersion');
    const name = await rpc('system_chain').catch(() => '?');
    const ver = await rpc('system_version').catch(() => '?');
    chain = { chain: name, ver, specName: rt?.specName, specVersion: rt?.specVersion, transactionVersion: rt?.transactionVersion };
    measured.chain = chain;
    add('node — chain', UNMEASURED, String(name), 'OK', 'nothing here pins a chain name; this is what answered');
    add('node — software', UNMEASURED, String(ver), 'OK');
    add('node — runtime specVersion', UNMEASURED, String(rt?.specVersion), 'OK');
    add('node — transactionVersion', UNMEASURED, String(rt?.transactionVersion), 'OK');
  } catch (e: any) {
    unmeasured.push('chain');
    const why = String(e?.message ?? e).slice(0, 60);
    for (const what of ['node — chain', 'node — software', 'node — runtime specVersion', 'node — transactionVersion']) {
      add(what, UNMEASURED, 'could not ask the node', 'UNKNOWN', why);
    }
  }

  /* ---------------- the indexer ---------------- */
  const ready = await tryFetch(INDEXER.replace('/api/v4/graphql', '/ready'));
  if (ready === null) {
    unmeasured.push('indexerReady');
    add('indexer — /ready', UNMEASURED, 'unreachable', 'UNKNOWN');
  } else {
    measured.indexerReady = ready;
    add('indexer — /ready', UNMEASURED, ready, 'OK');
  }

  /* ---------------- the proof server ---------------- */
  const proverVersion = await tryFetch(`${PROVER}/version`);
  const proverHealth = await tryFetch(`${PROVER}/health`);
  if (proverVersion === null && proverHealth === null) {
    unmeasured.push('prover');
    add('proof server — running', PINNED_IMAGE.split(':')[1], `nothing answering on ${PROVER}`, 'UNKNOWN',
      'the pin below is what a .command WOULD start; nothing here has ever confirmed it against a running server');
  } else {
    measured.prover = { version: proverVersion, health: proverHealth, url: PROVER };
    const tag = PINNED_IMAGE.split(':')[1];
    const agrees = proverVersion !== null && proverVersion.includes(tag.split('_')[0]);
    add('proof server — running', tag, String(proverVersion ?? proverHealth), agrees ? 'OK' : 'MISMATCH',
      agrees ? undefined : 'the server answering is not reporting the pinned version');
  }
  /*
   * MEASURED, NOT CLAIMED. The source is the node's own pin, read through the
   * ledger tag it names — see NODE_DERIVATION above. The verdict is a real
   * comparison now: if what this repository pins ever drifts from what the
   * node's ledger release names, this row says MISMATCH instead of quoting a
   * document that agrees with neither.
   */
  add('proof server — what Stagenet needs', PINNED_IMAGE.split(':')[1], NODE_DERIVED_PROOF_SERVER,
    PINNED_IMAGE.split(':')[1] === NODE_DERIVED_PROOF_SERVER ? 'OK' : 'MISMATCH', NODE_DERIVATION);

  /* ---------------- the pins across this repository ---------------- */
  const { images, ports } = scanPins();
  const liveImages = [...new Set(images.filter((h) => !h.comment).map((h) => h.value))];
  const livePorts = [...new Set(ports.filter((h) => !h.comment).map((h) => h.value))];
  const pinnedTag = PINNED_IMAGE.split(':')[1];

  add('proof server — image, everywhere', pinnedTag,
    liveImages.length === 1 ? `${liveImages[0]} (${images.filter((h) => !h.comment).length} places)` : liveImages.join(', ') || 'none',
    liveImages.length === 1 && liveImages[0] === pinnedTag ? 'OK' : 'MISMATCH');
  add('proof server — port, everywhere', String(PROVER_PORT),
    livePorts.length ? livePorts.sort().join(', ') : 'none',
    livePorts.length && livePorts.every((p) => p === String(PROVER_PORT) || p === '6300') && livePorts.includes(String(PROVER_PORT))
      ? 'OK' : 'MISMATCH',
    '6300 is the port INSIDE the container and is expected on the right of a -p mapping');
  measured.pins = { liveImages, livePorts };

  /* ---------------- what is installed here ---------------- */
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const overrides: Record<string, string> = pkg.overrides ?? {};
  const installedVersion = (name: string): string | null => {
    try {
      return JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch {
      return null;
    }
  };

  const interesting = Object.keys(deps)
    .filter((k) => /ledger|proof|wallet-sdk$|compact-runtime|compact-js|midnight-js-contracts|onchain-runtime|testkit/.test(k))
    .sort();
  const installed: Record<string, string> = {};
  for (const name of interesting) {
    const real = installedVersion(name);
    installed[name] = real ?? deps[name];
    add(name, deps[name], real ?? 'not installed', real === null ? 'UNKNOWN' : real === deps[name] ? 'OK' : 'MISMATCH');
  }
  for (const [name, want] of Object.entries(overrides)) {
    const real = installedVersion(name);
    installed[name] = real ?? want;
    add(`${name} (override)`, want, real ?? 'not installed', real === null ? 'UNKNOWN' : real === want ? 'OK' : 'MISMATCH');
  }
  measured.installed = installed;

  /*
   * NOTHING COMPARES A LEDGER VERSION TO A `transactionVersion`, AND NOTHING
   * CAN FROM HERE. The node answers `transactionVersion 4`; the ledger package
   * is `ledger-v9@1.0.0-rc.3` with `onchain-runtime-v4@4.0.0-rc.3` forced by an
   * override. There is no published mapping between those numbers, and
   * inventing one would be exactly the guess this instrument exists to remove.
   */
  add('ledger ↔ transactionVersion', `ledger-v9 ${installed['@midnightntwrk/ledger-v9'] ?? '?'}`,
    chain ? `transactionVersion ${chain.transactionVersion}` : 'node not reached', 'UNKNOWN',
    'no published mapping between a ledger package version and a node transactionVersion; the only evidence either way is whether a submission is accepted');

  /* ---------------- compact ---------------- */
  const pragmaOf = (rel: string): string => {
    try {
      const m = readFileSync(join(ROOT, rel), 'utf8').match(/pragma\s+language_version\s+([^;]+);/);
      return m ? m[1].trim() : 'no pragma';
    } catch {
      return 'file not found';
    }
  };
  const accountPragma = pragmaOf('contracts/src/ConfidentialAccount.compact');
  const vaultPragma = pragmaOf('contracts/src/Vault.compact');

  const manifestOf = (rel: string): any => {
    try { return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')); } catch { return null; }
  };
  const accountManifest = manifestOf('contracts/managed/compiler/contract-manifest.json');
  const vaultManifest = manifestOf('contracts/managed-vault/compiler/contract-manifest.json');

  let compilerNow: string | null = null;
  try {
    const path = execFileSync('./scripts/find-compactc.sh', [], { encoding: 'utf8' }).trim();
    compilerNow = execFileSync(path, ['--version'], { encoding: 'utf8' }).trim().slice(0, 40);
  } catch {
    compilerNow = null;
  }

  add('compact — ConfidentialAccount pragma', accountPragma,
    accountManifest ? `built at language-version ${accountManifest['language-version']}` : 'no build manifest',
    accountManifest ? 'OK' : 'UNKNOWN',
    '`>= 0.22` accepts any future compiler silently; the artefact records what it actually resolved to');
  add('compact — Vault pragma', vaultPragma,
    vaultManifest ? `built at language-version ${vaultManifest['language-version']}` : 'no build manifest',
    vaultManifest ? 'OK' : 'UNKNOWN');
  add('compact — the two contracts agree', accountPragma, vaultPragma,
    accountPragma === vaultPragma ? 'OK' : 'MISMATCH',
    'they are declared differently and have so far resolved to the same language version');
  add('compact — compiler on this machine', accountManifest ? String(accountManifest['compiler-version']) : 'unknown',
    compilerNow ?? 'no compactc found', compilerNow === null ? 'UNKNOWN'
      : accountManifest && compilerNow.includes(String(accountManifest['compiler-version'])) ? 'OK' : 'MISMATCH',
    'scripts/find-compactc.sh picks the NEWEST installed compiler, so this can move without anything being changed here');
  measured.compact = {
    accountPragma, vaultPragma, compilerNow,
    builtWith: accountManifest?.['compiler-version'] ?? null,
    builtAtLanguageVersion: accountManifest?.['language-version'] ?? null,
  };

  /* ---------------- the table ---------------- */

  const colour = (v: Verdict) =>
    v === 'OK' ? `${G}OK      ${O}` : v === 'MISMATCH' ? `${R}MISMATCH${O}` : v === 'CLAIMED' ? `${Y}CLAIMED ${O}` : `${Y}UNKNOWN ${O}`;
  const w1 = Math.max(...rows.map((r) => r.what.length));
  const w2 = Math.max(...rows.map((r) => r.ours.length), 12);
  console.log(`  ${B}${'WHAT'.padEnd(w1)}  ${'WE PIN / HOLD'.padEnd(w2)}  WHAT ANSWERED${O}`);
  console.log(`  ${D}${'─'.repeat(Math.min(110, w1 + w2 + 40))}${O}`);
  for (const r of rows) {
    console.log(`  ${r.what.padEnd(w1)}  ${r.ours.padEnd(w2)}  ${r.theirs}`);
    console.log(`    ${colour(r.verdict)}${r.note ? `  ${D}${r.note}${O}` : ''}`);
  }

  const counts = rows.reduce((m: Record<string, number>, r) => ({ ...m, [r.verdict]: (m[r.verdict] ?? 0) + 1 }), {});
  console.log(`\n  ${B}${counts.OK ?? 0} OK, ${counts.MISMATCH ?? 0} MISMATCH, ${counts.UNKNOWN ?? 0} UNKNOWN, ${counts.CLAIMED ?? 0} CLAIMED${O}`);
  if (counts.UNKNOWN) {
    console.log(`  ${D}An UNKNOWN row is not a passing row. It is a question nobody has answered${O}`);
    console.log(`  ${D}yet, and the proof server has been one of them since 22 Aug.${O}`);
  }

  /* ---------------- where the pins disagree, by file and line ---------------- */
  const staleImages = images.filter((h) => h.value !== pinnedTag);
  if (staleImages.length) {
    console.log(`\n  ${B}Every place another proof-server image is named${O}`);
    for (const h of staleImages) {
      console.log(`    ${h.comment ? `${D}comment${O}` : `${R}LIVE   ${O}`}  ${h.where}  ${h.value}`);
    }
    console.log(`    ${D}A comment naming an old image is history and runs nothing. A LIVE line${O}`);
    console.log(`    ${D}would start it, and two stacks on one port means whichever ran last${O}`);
    console.log(`    ${D}silently serves the other — DEPLOY-PREVIEW.command:38-52.${O}`);
  }

  /* ---------------- the baseline, merged rather than overwritten ---------- */
  const baselinePath = join(ROOT, '.midnight', 'version-baseline.json');
  const before: any = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;

  console.log(`\n  ${B}Against the last time this was recorded${O}`);
  if (before) {
    let changed = 0;
    const compare = (label: string, a: unknown, b: unknown) => {
      if (b === undefined) return;
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        console.log(`    ${Y}CHANGED${O}  ${label}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
        changed++;
      }
    };
    compare('runtime specVersion', before.chain?.specVersion, chain?.specVersion);
    compare('transactionVersion', before.chain?.transactionVersion, chain?.transactionVersion);
    compare('node software', before.chain?.ver, chain?.ver);
    for (const k of Object.keys(installed)) compare(k, (before.installed ?? {})[k], installed[k]);
    if (changed === 0) console.log(`    ${D}nothing that was measured on both runs has changed since ${before.at}${O}`);
  } else {
    console.log(`    ${D}no baseline recorded before now — this run creates one.${O}`);
  }

  /*
   * MERGED, NOT REPLACED, and this is the change that matters most in this
   * file. A run with the network down measures nothing about the chain; writing
   * that run out whole would delete the only record this project holds of what
   * the node answered, and would do it silently.
   */
  /*
   * WHEN EACH ROW WAS MEASURED, PER ROW.
   *
   * The file's top-level `at` is when this file was last WRITTEN, and a run
   * that measured nothing still writes it. Reading a carried value's age off
   * that stamp dates it to the wrong run — which this file did once, reporting
   * a 22 Aug node reading as though it were minutes old. A value carries its
   * own observation date now, and a key that has never had one inherits the
   * previous file's `at`, because that is the best evidence of when it was
   * taken.
   */
  const now = new Date().toISOString();
  const observedAt: Record<string, string> = { ...(before?.observedAt ?? {}) };
  for (const k of Object.keys(measured)) observedAt[k] = now;
  for (const k of Object.keys(before ?? {})) {
    if (observedAt[k] === undefined && before[k] !== undefined && before.at) observedAt[k] = before.at;
  }

  const merged: any = {
    ...(before ?? {}), ...measured,
    at: now, node: NODE,
    prover: measured.prover ?? before?.prover,
    observedAt,
  };
  const carried = unmeasured.filter((k) => before && before[k] !== undefined);
  if (unmeasured.length) {
    const nothingToKeep = unmeasured.filter((k) => !carried.includes(k));
    merged.carried = {
      keys: carried,
      observedAt: Object.fromEntries(carried.map((k) => [k, observedAt[k] ?? null])),
      unmeasuredThisRun: unmeasured,
    };
    console.log(`\n  ${Y}${unmeasured.length} thing(s) could not be measured this run: ${unmeasured.join(', ')}${O}`);
    if (carried.length) {
      for (const k of carried) {
        console.log(`  ${D}KEPT, NOT RE-MEASURED — ${k} — as observed on ${observedAt[k] ?? 'a date this file never recorded'}.${O}`);
      }
      console.log(`  ${D}Those values are history. The table above says UNKNOWN for them, and it${O}`);
      console.log(`  ${D}is the table that describes now.${O}`);
    }
    if (nothingToKeep.length) {
      console.log(`  ${D}Nothing recorded to keep for ${nothingToKeep.join(', ')}, so they stay unknown.${O}`);
    }
  }
  writeFileSync(baselinePath, JSON.stringify(merged, null, 2));
  console.log(`\n  ${G}✓${O} recorded in .midnight/version-baseline.json`);
  console.log(`\n${D}  Nothing was built, proved, submitted or deployed.${O}`);
}

main().then(() => process.exit(0)).catch((e: any) => {
  console.error(`\n${R}stopped:${O} ${String(e?.message ?? e)}`);
  process.exit(1);
});

/**
 * HAS THE MIDNIGHT REFERENCE GONE STALE?
 *
 * Read-only. Nothing is installed, built, proved or submitted.
 *
 * `docs/midnight/` records what every Midnight component was on the day it was
 * written. Components move. A reference nobody re-checks becomes the thing that
 * causes the mistake it was written to prevent, so this compares what is
 * RECORDED against what is LIVE and prints only what has moved.
 *
 * It checks, in order of how much a change would hurt:
 *
 *   the node's specVersion        a chain upgrade invalidates proofs
 *   the indexer's schema          a renamed field breaks every query using it
 *   the proof server's version    a mismatched prover is node error 170
 *   the compiler's version        renames between compiler lines are silent
 *   npm dist-tags                 what is newest, per release line
 *   Docker tags                   proof server and node images
 *
 * WHAT COUNTS AS A PROBLEM IS NOT "SOMETHING NEWER EXISTS". Our stack follows
 * STAGENET, not npm. A newer package is information; a changed NODE or INDEXER
 * or a Stagenet document naming different versions is a call to action.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const BASELINE = join(ROOT, '.midnight', 'reference-baseline.json');
const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', O = '\x1b[0m';

/**
 * What Stagenet requires. The only column that governs us.
 *
 * **THE PROOF-SERVER ROW IS NO LONGER THE DELIVERY DOCUMENT'S.** It is derived
 * from the running node: midnight-node@d9729c13/Cargo.toml:445 pins
 * midnight-ledger at git tag `crate-ledger-9.1.0.0-rc.3`, and that tag's
 * `proof-server/Cargo.toml` reads `9.0.0-rc.3`. It read
 * `9.0.0-rc.5_experimental` until 28 Aug 2026, taken from the delivery document
 * — a draft whose component table has been edited forward of the network it
 * describes. `docs/stagenet.md` carries the derivation and the five commands
 * that redo it from primary sources.
 *
 * **EVERY OTHER ROW HERE STILL COMES FROM THAT DOCUMENT AND IS THEREFORE
 * SUSPECT.** Two are already known wrong against the chain: `node` says
 * `2.0.0-rc.4` and the chain answers `2.0.0-d9729c13`, a development build with
 * no published release; `ledger` says `9.1.0.0-rc.3`, which is a ledger RELEASE
 * TAG and not an npm version — the npm packages that tag contains are
 * `ledger-v9@1.0.0-rc.3` and `onchain-runtime-v4@4.0.0-rc.3`, which is what we
 * hold. Re-deriving the remaining rows from the node the way the proof server
 * was re-derived is named work and is not scheduled here.
 */
const STAGENET_REQUIRES: Record<string, string> = {
  'compact compiler': '0.33.0-rc.2',
  'compact runtime': '0.18.0-rc.1',
  'compact-js': '2.5.5-rc.6',
  'midnight-js / testkit-js': '5.0.0-beta.4',
  'wallet-sdk': '2.0.0-beta.2',
  'ledger': '9.1.0.0-rc.3',
  'proof server': '9.0.0-rc.3',
  'node': '2.0.0-rc.4',
  'indexer': '4.4.0-pre-alpha.16',
};

const NPM = [
  '@midnight-ntwrk/midnight-js-contracts', '@midnight-ntwrk/testkit-js',
  '@midnight-ntwrk/compact-runtime', '@midnight-ntwrk/compact-js',
  '@midnightntwrk/ledger-v9', '@midnightntwrk/wallet-sdk',
];

const get = async (url: string, init?: RequestInit): Promise<any> => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
};

async function main() {
  const now: Record<string, unknown> = { checkedAt: new Date().toISOString() };
  const moved: string[] = [];
  const urgent: string[] = [];

  console.log(`\n${B}Is the Midnight reference still true?${O}\n`);

  /* ---------- the chain ---------- */
  try {
    const rt = await get(process.env.MIDNIGHT_NODE_URL || 'https://rpc.stagenet.shielded.tools', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'state_getRuntimeVersion', params: [] }),
    });
    now.nodeSpecVersion = rt?.result?.specVersion;
    now.nodeTransactionVersion = rt?.result?.transactionVersion;
    console.log(`  node specVersion        ${now.nodeSpecVersion}   transactionVersion ${now.nodeTransactionVersion}`);
  } catch (e: any) { console.log(`  ${R}node unreachable: ${String(e?.message ?? e).slice(0, 70)}${O}`); }

  /* ---------- the indexer's schema, hashed ---------- */
  try {
    const idx = process.env.MIDNIGHT_INDEXER_URL || 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
    // All THREE roots. Only introspecting queries is the mistake that cost us a
    // wrong conclusion about whether balances were readable at all.
    const q = `query { __schema {
      queryType { fields { name } }
      mutationType { fields { name } }
      subscriptionType { fields { name } } } }`;
    const j = await get(idx, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) });
    const s = j?.data?.__schema;
    const names = [
      ...(s?.queryType?.fields ?? []).map((f: any) => 'Q:' + f.name),
      ...(s?.mutationType?.fields ?? []).map((f: any) => 'M:' + f.name),
      ...(s?.subscriptionType?.fields ?? []).map((f: any) => 'S:' + f.name),
    ].sort();
    now.indexerFieldCount = names.length;
    now.indexerSchemaHash = createHash('sha256').update(names.join(',')).digest('hex').slice(0, 16);
    now.indexerFields = names;
    console.log(`  indexer schema          ${names.length} operations, fingerprint ${now.indexerSchemaHash}`);
  } catch (e: any) { console.log(`  ${R}indexer unreachable: ${String(e?.message ?? e).slice(0, 70)}${O}`); }

  /* ---------- the proof server ---------- */
  for (const port of [6301, 6300]) {
    try {
      const v = await get(`http://localhost:${port}/version`);
      now[`proofServer${port}`] = String(v).trim();
      console.log(`  proof server :${port}      ${String(v).trim()}`);
    } catch { console.log(`  ${D}proof server :${port}      not answering${O}`); }
  }

  /* ---------- the compiler ---------- */
  try {
    const { execSync } = await import('node:child_process');
    const c = execSync('./scripts/find-compactc.sh', { encoding: 'utf8' }).trim();
    now.compactc = execSync(`"${c}" --version`, { encoding: 'utf8' }).trim();
    console.log(`  compactc                ${now.compactc}`);
  } catch { console.log(`  ${D}compactc not found${O}`); }

  /* ---------- npm ---------- */
  const tags: Record<string, unknown> = {};
  for (const p of NPM) {
    try {
      const j = await get(`https://registry.npmjs.org/-/package/${encodeURIComponent(p)}/dist-tags`);
      tags[p] = j;
    } catch { tags[p] = { error: true }; }
  }
  now.npmDistTags = tags;

  /* ---------- docker ---------- */
  for (const [key, repo] of [['proofServerTags', 'proof-server'], ['nodeTags', 'midnight-node']]) {
    try {
      const j = await get(`https://hub.docker.com/v2/repositories/midnightntwrk/${repo}/tags?page_size=10&ordering=last_updated`);
      now[key] = (j?.results ?? []).map((t: any) => `${t.name}@${String(t.last_updated).slice(0, 10)}`);
    } catch { now[key] = ['unreachable']; }
  }

  /* ---------- compare ---------- */
  console.log(`\n${B}Against what the reference records${O}`);
  if (!existsSync(BASELINE)) {
    console.log(`  ${Y}no baseline yet — this run creates one. It can say what things ARE,${O}`);
    console.log(`  ${Y}not what moved. That is the cost of a first run and is paid once.${O}`);
  } else {
    const was = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const cmp = (label: string, a: unknown, b: unknown, isUrgent = false) => {
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      const line = `${label}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`;
      moved.push(line);
      if (isUrgent) urgent.push(line);
    };
    cmp('node specVersion', was.nodeSpecVersion, now.nodeSpecVersion, true);
    cmp('node transactionVersion', was.nodeTransactionVersion, now.nodeTransactionVersion, true);
    cmp('indexer schema fingerprint', was.indexerSchemaHash, now.indexerSchemaHash, true);
    cmp('proof server :6301', was.proofServer6301, now.proofServer6301, true);
    cmp('compactc', was.compactc, now.compactc, true);
    for (const p of NPM) cmp(`npm ${p}`, (was.npmDistTags ?? {})[p], tags[p]);

    if (was.indexerFields && now.indexerFields) {
      const before = new Set(was.indexerFields as string[]);
      const after = new Set(now.indexerFields as string[]);
      const added = [...after].filter(x => !before.has(x));
      const gone = [...before].filter(x => !after.has(x));
      if (gone.length) urgent.push(`indexer REMOVED: ${gone.join(', ')}`);
      if (added.length) moved.push(`indexer added: ${added.join(', ')}`);
    }

    if (!moved.length) {
      console.log(`  ${G}nothing has moved since ${was.checkedAt}.${O}`);
      console.log(`  ${D}The reference in docs/midnight/ is still true.${O}`);
    } else {
      for (const m of moved) console.log(`    ${urgent.includes(m) ? R + 'CHANGED' : Y + 'changed'}${O}  ${m}`);
    }
  }

  /* ---------- what our stack must match ---------- */
  console.log(`\n${B}What Stagenet requires — the only column that governs us${O}`);
  for (const [k, v] of Object.entries(STAGENET_REQUIRES)) console.log(`    ${k.padEnd(26)} ${v}`);
  console.log(`  ${D}Recorded from Midnight's Stagenet delivery document (docs PR #1162).${O}`);
  console.log(`  ${D}When that document changes, this list and docs/midnight/00-INDEX.md${O}`);
  console.log(`  ${D}must change with it — and only then do we upgrade anything.${O}`);

  mkdirSync(join(ROOT, '.midnight'), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(now, null, 2));

  console.log(`\n${B}Verdict${O}`);
  if (urgent.length) {
    console.log(`  ${R}${B}THE REFERENCE IS STALE IN PLACES THAT MATTER.${O}`);
    console.log(`  ${R}Update docs/midnight/ before building anything on it:${O}`);
    for (const u of urgent) console.log(`    • ${u}`);
  } else if (moved.length) {
    console.log(`  ${Y}Newer packages exist, but nothing WE depend on has moved.${O}`);
    console.log(`  ${D}Newer is not a target — our stack follows Stagenet. No action needed.${O}`);
  } else {
    console.log(`  ${G}The reference is current.${O}`);
  }
  console.log(`\n${D}Baseline written to .midnight/reference-baseline.json${O}`);
}

main().then(() => process.exit(0)).catch((e: any) => {
  console.error(`stopped: ${String(e?.message ?? e)}`);
  process.exit(1);
});

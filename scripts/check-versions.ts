/**
 * Two questions, both of which have bitten this project.
 *
 * 1. **Is what is installed exactly what is declared?** M-30 was two copies of
 *    the WASM runtime in `node_modules` — one pulled by a caret range resolving
 *    forward, one pinned exactly — and every contract call failed with
 *    "expected instance of StateValue". Nothing in the error named versions.
 *
 * 2. **Has Midnight shipped something newer, and is it STABLE?** Everything
 *    load-bearing here is a beta or a release candidate: midnight-js
 *    5.0.0-beta.4, ledger-v9 1.0.0-rc.3, compact-runtime 0.18.0-rc.1. Betas get
 *    replaced without ceremony, and a stable major is the moment to plan a
 *    move — not the moment to discover one happened three months ago.
 *
 * Nobody is watching the Foundation's releases. This is the check that does it,
 * and it is deliberately read-only: it reports and never installs. A tool that
 * upgrades things on its own is how a dependency change arrives without anyone
 * choosing it, which is the whole of M-17.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BOLD = '\x1b[1m', DIM = '\x1b[2m', RED = '\x1b[31m', GREEN = '\x1b[32m', YEL = '\x1b[33m', OFF = '\x1b[0m';
const ROOT = process.cwd();

const isPrerelease = (v: string) => /-(alpha|beta|rc|next|canary|experimental)/i.test(v);
const isMidnight = (n: string) => n.startsWith('@midnight-ntwrk/') || n.startsWith('@midnightntwrk/');

interface Row {
  name: string;
  declared: string;
  installed: string | null;
  latest?: string;
  latestStable?: string;
}

async function npmVersions(name: string): Promise<{ latest?: string; stable?: string }> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return {};
    const body: any = await res.json();
    const latest = body?.['dist-tags']?.latest as string | undefined;
    // The newest version carrying no prerelease tag. `dist-tags.latest` is not
    // it: the Foundation publishes betas to `latest`, so trusting that tag
    // would report a beta as though it were a stable release.
    const stable = Object.keys(body?.versions ?? {})
      .filter((v) => !isPrerelease(v))
      .sort(compareSemver)
      .pop();
    return { latest, stable };
  } catch {
    return {};
  }
}

/**
 * Enough semver ordering to compare two versions. Not a full implementation.
 *
 * Compares the numeric core only, so `5.0.0-beta.4` and `5.0.0` both read as
 * `[5,0,0]` and compare EQUAL. That is deliberate and it is what makes the
 * stable check work: "a stable exists at the same version we are running as a
 * prerelease" is precisely the moment worth flagging.
 */
function compareSemver(a: string, b: string): number {
  const parts = (v: string) => v.split('.').map((p) => parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const rows: Row[] = [];

  for (const section of ['dependencies', 'devDependencies'] as const) {
    for (const [name, declared] of Object.entries(pkg[section] ?? {}) as [string, string][]) {
      let installed: string | null = null;
      try {
        installed = JSON.parse(
          readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'),
        ).version;
      } catch { /* reported below as missing */ }
      rows.push({ name, declared, installed });
    }
  }

  /* ---------------------------------------------------- 1. exactness */
  console.log(`\n${BOLD}Is what is installed what is declared?${OFF}`);
  const ranged = rows.filter((r) => /^[\^~><]/.test(r.declared));
  const missing = rows.filter((r) => r.installed === null);
  const drifted = rows.filter((r) => r.installed && !/^[\^~><]/.test(r.declared) && r.installed !== r.declared);

  if (ranged.length) {
    console.log(`  ${RED}✗${OFF} ${ranged.length} package(s) still use a range, so a bump can arrive unchosen:`);
    for (const r of ranged) console.log(`      ${r.declared.padEnd(14)} ${r.name}`);
  } else {
    console.log(`  ${GREEN}✓${OFF} every version is pinned exactly`);
  }
  if (missing.length) {
    console.log(`  ${RED}✗${OFF} declared but not installed: ${missing.map((r) => r.name).join(', ')}`);
    console.log(`      ${DIM}this is M-21 — the failure is a module-not-found deep inside a script${OFF}`);
  }
  if (drifted.length) {
    console.log(`  ${RED}✗${OFF} installed differs from pinned — run npm ci:`);
    for (const r of drifted) console.log(`      ${r.name}  pinned ${r.declared}, installed ${r.installed}`);
  }
  if (!missing.length && !drifted.length) {
    console.log(`  ${GREEN}✓${OFF} every installed version matches what package.json asks for`);
  }

  /* ---------------------------------------------------- 2. upstream */
  console.log(`\n${BOLD}Has Midnight shipped anything newer?${OFF}`);
  const mid = rows.filter((r) => isMidnight(r.name));
  await Promise.all(mid.map(async (r) => {
    const { latest, stable } = await npmVersions(r.name);
    r.latest = latest; r.latestStable = stable;
  }));

  const news: string[] = [];
  const stableNews: string[] = [];
  for (const r of mid.sort((a, b) => a.name.localeCompare(b.name))) {
    const current = r.installed ?? r.declared;
    const onPre = isPrerelease(current);
    /*
     * NEWER, not merely different. The first version compared with `!==` and
     * cheerfully reported `5.0.0-beta.4 → 4.1.1` as an upgrade — the registry's
     * `latest` tag points at the stable 4.x line while we are deliberately
     * ahead on 5.0 betas, so "different" is the normal state and says nothing.
     */
    if (r.latest && compareSemver(r.latest, current) > 0) {
      news.push(`      ${r.name}  ${current} → ${r.latest}`);
    }
    /*
     * The signal worth acting on: we are on a prerelease and a stable exists
     * that is at least as new. That is the moment to plan a move, and it is
     * exactly what nobody was watching for.
     */
    if (onPre && r.latestStable && compareSemver(r.latestStable, current) >= 0) {
      stableNews.push(`      ${r.name}  on ${current}, STABLE ${r.latestStable} available`);
    }
  }

  if (!mid.some((r) => r.latest)) {
    console.log(`  ${YEL}!${OFF} could not reach the npm registry — skipped`);
  } else if (stableNews.length) {
    console.log(`  ${RED}${BOLD}A stable release exists for something we run on a prerelease:${OFF}`);
    stableNews.forEach((l) => console.log(l));
    console.log(`\n  ${DIM}Not urgent, but it is a decision someone has to make on purpose.${OFF}`);
  } else if (news.length) {
    console.log(`  ${YEL}!${OFF} newer prereleases exist (expected — we track betas deliberately):`);
    news.forEach((l) => console.log(l));
  } else {
    console.log(`  ${GREEN}✓${OFF} nothing newer published`);
  }

  const bad = ranged.length + missing.length + drifted.length + stableNews.length;
  console.log();
  if (bad === 0) console.log(`  ${GREEN}${BOLD}Nothing to decide.${OFF}`);
  else console.log(`  ${BOLD}${bad} thing(s) above want a human decision.${OFF} Nothing was changed.`);
  process.exitCode = ranged.length || missing.length || drifted.length ? 1 : 0;
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => {
  console.log(`  ${RED}✗${OFF} ${String(e?.message ?? e)}`);
  process.exit(1);
});

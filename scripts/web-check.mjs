/**
 * DRIVING THE PAYROLL APP IN A REAL BROWSER AND WRITING DOWN WHAT IT SAID.
 *
 *
 * ── WHAT IT IS FOR ───────────────────────────────────────────────────────
 *
 * The app opened to a completely white page in a real browser and nothing in
 * this project could see why. Four rounds running, every defect was found by
 * starting the thing rather than by a test. This asks the same question opening
 * the app by hand asks, unattended — and leaves the answer
 * in `logs/REPORT-WEB-CHECK.txt`.
 *
 * ── STARTED THROUGH `npm run dev`, NOT AROUND IT ─────────────────────────
 *
 * That script is the one place that declares a development build, and it sets
 * six things nothing else does — the two origins, the simulated-address
 * relaxation, the localhost-origin flag, and the two that arm the page's own
 * error sink. `X1` exists because a launcher went around it and every test
 * still passed. Repeating that here would produce a report about an app nobody
 * runs.
 *
 * ── THE BROWSER IS FOUND, NOT DEMANDED ───────────────────────────────────
 *
 * `--probe-browser` exits 0 if one can launch and 1 if it cannot, and the
 * launcher uses that to decide whether a download is needed. This is the shape
 * the wallet's screen-photographing script already uses on this machine, and
 * it is used here rather than reinvented: a refusal that fires on a machine
 * which has a perfectly good browser is worse than no check at all.
 *
 * `CHROMIUM_PATH` points at a binary directly, for an environment that has one
 * but no route to Playwright's download. `scripts/browser-probe.mjs` in this
 * same folder already reads that name.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch, renderedText, renderReport } from './web-check-observe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL_BASE = process.env.WEB_CHECK_URL ?? 'http://localhost:5173';
const SERVICE = process.env.WEB_CHECK_SERVICE ?? 'http://localhost:8787';

/*
 * **THIS SCRIPT WRITES NO FILE, AND THAT IS THE CONVENTION RATHER THAN AN
 * OMISSION.** Every `.command` in this project leaves its whole output in
 * `logs/REPORT-<ITS-OWN-NAME>.txt` and owns that name alone. `WEB-CHECK.command`
 * owns `logs/REPORT-WEB-CHECK.txt`; it pipes everything through `tee`, so what
 * this prints IS that report. A second writer to the same path is how
 * `UNLOCK-CHECK` came to overwrite a file another command owned.
 */

/** How long the page is given to mount before it is called empty. */
const MOUNT_MS = Number(process.env.WEB_CHECK_MOUNT_MS ?? 25_000);
/** How long both servers are given to answer. The first build is not quick. */
const BOOT_MS = Number(process.env.WEB_CHECK_BOOT_MS ?? 90_000);

/** Says it, and refuses with the same voice everywhere. */
const say = (s = '') => console.log(s);
const refuse = (...lines) => {
  say();
  for (const line of lines) say(`  ${line}`);
  say();
  process.exit(1);
};

const loadPlaywright = async () => {
  for (const name of ['playwright', 'playwright-core']) {
    try { return await import(name); } catch { /* try the next */ }
  }
  return null;
};

const launchOptions = process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH }
  : {};

/* ------------------------------------------------------- probe, and nothing else */

if (process.argv.includes('--probe-browser')) {
  const playwright = await loadPlaywright();
  if (!playwright) process.exit(1);
  try {
    const probe = await playwright.chromium.launch(launchOptions);
    await probe.close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ refusals */

const playwright = await loadPlaywright();
if (!playwright) {
  refuse(
    'THE CHECK CANNOT RUN: the browser driver is not installed.',
    '',
    'It is a dependency of this repository. START-HERE.command in the same',
    'folder as this one installs everything and builds the contracts.',
  );
}

const free = (port) => new Promise((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(port, '127.0.0.1');
});

const taken = [];
for (const port of [5173, 8787]) if (!(await free(port))) taken.push(port);
if (taken.length) {
  refuse(
    `THE CHECK CANNOT RUN: port ${taken.join(' and ')} is already in use.`,
    '',
    'Almost always this is the app already running in another window. This',
    'check starts its own copy and needs both ports to itself, so that window',
    'has to be closed first.',
    '',
    'The ports are fixed on purpose and changing them is not the answer: the',
    'interface is built knowing both numbers.',
  );
}

/* ------------------------------------------------------------------ the servers */

say();
say(`  Starting the app through the development script, then reading ${URL_BASE}`);
say('  Nothing is submitted anywhere and no window will open.');
say();

const answered = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch { return false; }
};

/*
 * ITS OWN PROCESS GROUP, so the backgrounded service can be reached when this
 * finishes. `npm run dev` puts the service behind an `&` inside its own shell;
 * without the group, the interface dies, the service keeps 8787, and the next
 * run refuses to start for a reason that looks like nothing.
 */
const dev = spawn('npm', ['run', 'dev'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let devOutput = '';
dev.stdout.on('data', (b) => { devOutput += b.toString(); });
dev.stderr.on('data', (b) => { devOutput += b.toString(); });

let stopped = false;
const stopEverything = () => {
  if (stopped) return;
  stopped = true;
  try { process.kill(-dev.pid, 'SIGTERM'); } catch { /* already gone */ }
  // A slow shutdown leaves 8787 held and the next run refuses. Insist.
  setTimeout(() => { try { process.kill(-dev.pid, 'SIGKILL'); } catch { /* gone */ } }, 1000).unref();
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopEverything(); process.exit(1); });
process.on('exit', stopEverything);

const until = Date.now() + BOOT_MS;
let up = false;
while (Date.now() < until) {
  if (await answered(URL_BASE) && await answered(`${SERVICE}/api/health`)) { up = true; break; }
  if (dev.exitCode !== null) break;
  await new Promise((r) => setTimeout(r, 400));
}

if (!up) {
  say('  THE APP DID NOT COME UP. What the development script printed:');
  say();
  for (const line of devOutput.split('\n')) say(`    ${line}`);
  refuse(
    `Neither ${URL_BASE} nor ${SERVICE}/api/health answered within`,
    `${Math.round(BOOT_MS / 1000)} seconds. Nothing was read and no report was written.`,
  );
}

say('  Both servers are up. Opening the page.');

/* ------------------------------------------------------------------- the walk */

const startedAt = new Date().toISOString();
let browser;
let collected;
let rendered;
try {
  browser = await playwright.chromium.launch(launchOptions);
} catch (e) {
  say('  THE BROWSER WOULD NOT LAUNCH.');
  say(`    ${String(e?.message ?? e).split('\n')[0]}`);
  refuse(
    'Playwright is installed but its browser is not, or the binary named by',
    'CHROMIUM_PATH cannot be run here. The launcher that runs this check',
    'fetches the browser when this happens.',
  );
}

try {
  const page = await browser.newPage();
  collected = watch(page);
  await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60_000 });

  /*
   * WAITS FOR SOMETHING TO MOUNT, RATHER THAN FOR A NUMBER OF SECONDS. The
   * first load of a development build compiles as it serves, so a fixed pause
   * is either too short — and reports an empty page that was merely still
   * arriving — or too long for every run after it.
   */
  try {
    await page.waitForFunction(
      () => (document.getElementById('root')?.childElementCount ?? 0) > 0,
      null,
      { timeout: MOUNT_MS },
    );
  } catch {
    say(`  Nothing mounted within ${Math.round(MOUNT_MS / 1000)} seconds. Reading the page as it stands.`);
  }

  rendered = await renderedText(page);
} finally {
  try { await browser?.close(); } catch { /* it may already be gone */ }
}

const finishedAt = new Date().toISOString();

say();
say(renderReport({ url: URL_BASE, collected, rendered, startedAt, finishedAt }));
say('== WHAT THE DEVELOPMENT SCRIPT PRINTED ===============================');
say();
for (const line of devOutput.split('\n')) say(`  ${line}`);
say();

stopEverything();
/*
 * ZERO WHATEVER THE PAGE SAID. A walk that found a broken page did its job; the
 * report is the output, not the exit status. The launcher only needs to know
 * whether the check itself could run, and every way it could not is a refusal
 * above.
 */
process.exit(0);

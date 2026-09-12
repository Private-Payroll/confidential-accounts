/**
 * Drives the browser-proving probe in a real Chromium and reports what happened.
 *
 * Headless, but a real browser engine: the same module loader, the same wasm32
 * address space, the same cross-origin isolation rules. What it cannot tell us
 * is how a phone behaves, which is a separate and slower question.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const URL = process.env.PROBE_URL ?? 'http://localhost:5199/';
/*
 * WHICH CHROMIUM, AND WHY THIS IS NOT A CONSTANT.
 *
 * The first version of this line defaulted to a path that exists only inside a
 * Linux build container - `/opt/pw-browsers/...` - in a script that is only
 * ever run from a `.command` on a Mac. It had never been run there, so nobody
 * met it until 12 Sep, when the probe it drives failed on a machine that was
 * completely fine.
 *
 * THE ORDER BELOW IS DELIBERATE. An explicit answer wins; then the pinned
 * container build IF IT IS ACTUALLY ON THIS DISK; then Chrome where macOS
 * installs it; and finally nothing at all, which hands the question to
 * Playwright's own resolution rather than to a guess of ours. A refusal here
 * names every place that was looked at, because "it did not load" is a sentence
 * about the prover and this is a sentence about a missing file.
 */
const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => existsSync(p));
if (!EXECUTABLE) {
  console.log('  NO BROWSER WAS FOUND TO DRIVE, so the prover was never asked to load.');
  console.log('  This is NOT an answer about the prover. Every path looked at:');
  for (const p of CANDIDATES) console.log(`    ${p}`);
  console.log('  Set CHROMIUM_PATH to a Chrome or Chromium on this machine and run it again.');
}

const browser = await chromium.launch({
  ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
  args: ['--enable-features=SharedArrayBuffer'],
});
const page = await browser.newPage();

const console_ = [];
page.on('console', (m) => console_.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => console_.push(`pageerror: ${e.message}`));
// A 404 that only says "Failed to load resource" names nothing. Capturing the
// URL is the difference between "a favicon" and "an artefact that is missing".
page.on('requestfailed', (r) => console_.push(`requestfailed: ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) console_.push(`http ${r.status()}: ${r.url()}`); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__RESULT__ !== undefined, null, { timeout: 180_000 });
const result = await page.evaluate(() => window.__RESULT__);
const text = await page.evaluate(() => document.getElementById('out').textContent);

console.log(text);
console.log('\n--- structured ---');
console.log(JSON.stringify(result, null, 2));
if (console_.length) {
  console.log('\n--- console ---');
  for (const l of console_.slice(0, 25)) console.log('  ' + l);
}
await browser.close();
process.exit(result?.ok ? 0 : 1);

/**
 * Drives the browser-proving probe in a real Chromium and reports what happened.
 *
 * Headless, but a real browser engine: the same module loader, the same wasm32
 * address space, the same cross-origin isolation rules. What it cannot tell us
 * is how a phone behaves, which is a separate and slower question.
 */
import { chromium } from 'playwright';

const URL = process.env.PROBE_URL ?? 'http://localhost:5199/';
/*
 * The Chromium that is already here, not one Playwright would download.
 *
 * This container pins its own build and has no route to Playwright's CDN, so
 * the version the npm package expects does not exist on disk. Pointing at the
 * installed binary is the supported way through that, and it is also what a CI
 * image would do.
 */
const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: EXECUTABLE,
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

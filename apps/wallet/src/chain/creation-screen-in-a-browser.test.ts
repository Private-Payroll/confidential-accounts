import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityFromWords } from '../../../../packages/identity/src/keys/derivation.js';
import { committeeKeyFor } from '../../../../packages/identity/src/profile/committee-key.js';
import { companyLabelOf } from '../../../../packages/identity/src/profile/company-label.js';
import { vaultArtefactPlaces, vaultArtefactRoutes } from '../../../../src/server/vault-artefacts.js';

/*
 * THE WALLET'S SCREEN FOR THE SECOND PRESS OF CREATING A COMPANY, IN A BROWSER,
 * OVER A DEPLOY THE VAULT WORKER BUILT.
 *
 * The screen runs the account contract's own code in the wallet's page to make
 * the account's starting state itself, and compares it with the deploy. That
 * code refuses to run until the page has been told which network it is on, and
 * every test that drew the screen in Node, with the contract's code handed in,
 * passed while the real page refused. So this draws the real screen in the
 * wallet's page, over a deploy the web application's worker really built, with
 * only the service standing in (it serves the circuits' public files from the
 * build, as the service does, and nothing else) and no chain.
 *
 * The person is a fixed test identity, from the words every test here uses.
 */
/** Both dev servers listen on the address the test dials, on a port the system picks (the rule in src/testing/server-under-test.test.ts). */
const LOOPBACK = { host: '127.0.0.1', port: 0 } as const;
const APP = fileURLToPath(new URL('../../../web/vite.config.ts', import.meta.url));
const WALLET = process.env.WALLET_VITE_CONFIG ?? fileURLToPath(new URL('../../vite.config.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const WORDS = Array.from({ length: 23 }, () => 'abandon').concat(['art']).join(' ');
const CHROMIUM = process.env.CHROMIUM_PATH ?? chromium.executablePath();
const CAN_RUN_HERE = existsSync(CHROMIUM) && existsSync(`${REPO}/contracts/managed/keys`);

/** A folder for a server's prepared dependencies: inside the modules folder so that they can find the packages they name. */
const preparedFolder = (name: string): string => {
  mkdirSync(`${REPO}/node_modules`, { recursive: true });
  return mkdtempSync(`${REPO}/node_modules/.${name}`);
};

describe.skipIf(!CAN_RUN_HERE)('THE CREATION SCREEN OVER A REAL DEPLOY, IN A BROWSER [needs Chromium and contracts/managed/keys; `npx playwright install chromium` installs the one, `npm run compact` builds the other]', () => {
  let service: Server;
  let web: ViteDevServer;
  let wallet: ViteDevServer;
  let browser: Browser;
  let webPage: Page;
  let screen: Page;
  const caches: string[] = [];
  const earlier = { allowed: process.env.VITE_ALLOW_LOCALHOST_ORIGIN, app: process.env.VITE_APP_ORIGIN };
  const errors: string[] = [];
  let built: { account: string; tx: string; insert: unknown } | null = null;

  const watch = (page: Page, who: string): void => {
    page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${who}: ${m.text()}`); });
  };
  /** The screen has read the deploy and either shows the account it creates or says it will not sign. */
  const screenSettled = (): Promise<unknown> =>
    screen.waitForFunction("document.body.innerText.includes('The account the deploy creates') || document.body.innerText.includes('will not sign')", undefined, { timeout: 120_000 });
  const originOf = (s: ViteDevServer): string => s.resolvedUrls!.local[0]!.replace(/\/$/, '');

  beforeAll(async () => {
    const app = express();
    app.use(vaultArtefactRoutes(vaultArtefactPlaces(REPO, process.env)));
    service = await new Promise<Server>((up) => { const s = app.listen(0, '127.0.0.1', () => up(s)); });
    const servicePort = (service.address() as { port: number }).port;
    caches.push(preparedFolder('creation-screen-web-'), preparedFolder('creation-screen-wallet-'));
    web = await createServer({
      configFile: APP, cacheDir: caches[0], logLevel: 'silent',
      server: { ...LOOPBACK, proxy: { '/artefacts/vault': `http://127.0.0.1:${servicePort}` } },
    });
    await web.listen(LOOPBACK.port);
    process.env.VITE_ALLOW_LOCALHOST_ORIGIN = '1';
    process.env.VITE_APP_ORIGIN = originOf(web);
    wallet = await createServer({ configFile: WALLET, cacheDir: caches[1], logLevel: 'silent', server: { ...LOOPBACK, strictPort: false } });
    await wallet.listen(LOOPBACK.port);
    browser = await chromium.launch(process.env.CHROMIUM_PATH === undefined ? {} : { executablePath: process.env.CHROMIUM_PATH });
    webPage = await browser.newPage();
    watch(webPage, 'the application');
    await webPage.goto(`${originOf(web)}/`, { waitUntil: 'load' });

    /* The company's label, and the key this person's wallet holds it by: what the wallet would have drawn. */
    const label = companyLabelOf(randomBytes(32));
    const key = committeeKeyFor(identityFromWords(WORDS), label) as unknown as { tag: string; value: string };
    /* The deploy, built by the application's worker as the first press builds it. */
    built = await webPage.evaluate(`(async () => {
      const m = await import('/src/adapters/vault-builder.ts');
      const w = await m.theVaultBuilder();
      const seat = await w.foundingSeat({ signingSecret: '1'.repeat(64), blinding: '2'.repeat(64) });
      return w.accountDeploy({ foundingLeaf: seat.seat, label: ${JSON.stringify(label)}, foundingKey: ${JSON.stringify(key)} });
    })()`) as typeof built;
    const request = {
      schema: 'midnight-identity/disclosure-request/v1', kind: 'creation',
      requester: { origin: originOf(web), name: 'Payroll', rdns: 'test.payroll' }, purpose: 'Finish creating a company',
      nonce: 'creation-screen-test', expiresAt: Date.now() + 3_600_000,
      company: label, account: built!.account, deploy: built!.tx, insert: built!.insert,
    };
    screen = await browser.newPage();
    watch(screen, 'the wallet');
    await screen.addInitScript(`window.__creation = ${JSON.stringify({ request, words: WORDS })};`);
    await screen.goto(`${originOf(wallet)}/creation-screen.html`, { waitUntil: 'load' });
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await web?.close();
    await wallet?.close();
    await new Promise<void>((done) => { if (service === undefined) done(); else service.close(() => done()); });
    for (const c of caches) rmSync(c, { recursive: true, force: true });
    for (const [name, value] of [['VITE_ALLOW_LOCALHOST_ORIGIN', earlier.allowed], ['VITE_APP_ORIGIN', earlier.app]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  /* RED WHEN: the wallet's page refuses to make the account's starting state from the real deploy (for one thing because the contract's code was run before the page was told its network), or reads the deploy as another account's, or shows no press to sign. */
  it('reads the real deploy, makes the account\'s starting state itself and offers to sign', async () => {
    await screenSettled();
    const text = await screen.evaluate('document.body.innerText') as string;
    expect(text).not.toMatch(/will not sign|could not make the account|Network ID/i);
    expect(text).toContain(built!.account);
    expect(await screen.getByRole('button', { name: 'Sign and finish' }).isEnabled()).toBe(true);
    expect(errors).toEqual([]);
  }, 150_000);

  /* RED WHEN: pressing the press does not hand a signature back, or the worker cannot build the finishing transaction, or carry the same creation again, from that signature. */
  it('signs, and the worker builds the finishing transaction from the signature', async () => {
    await screenSettled();
    await screen.getByRole('button', { name: 'Sign and finish' }).click();
    await screen.waitForSelector('[data-signed-heading]', { timeout: 30_000 });
    const answer = await screen.evaluate('window.__creationAnswer') as { signature: { tag: string; value: string } };
    expect(answer.signature.tag).toBeTruthy();
    const fin = await webPage.evaluate(`(async () => {
      const m = await import('/src/adapters/vault-builder.ts');
      const w = await m.theVaultBuilder();
      const finished = await w.finishedCreation({ account: ${JSON.stringify(built!.account)}, signature: ${JSON.stringify(answer.signature)} });
      const again = await w.creationAgain({ deploy: ${JSON.stringify(built!.tx)}, insert: finished.tx });
      return { finished: finished.tx.length, again: again.account };
    })()`) as { finished: number; again: string };
    expect(fin.finished).toBeGreaterThan(1000);
    expect(fin.again).toBe(built!.account);
    expect(errors).toEqual([]);
  }, 150_000);
});

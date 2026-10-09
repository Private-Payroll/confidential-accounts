import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vaultArtefactFile, vaultArtefactPlaces, vaultArtefactRoutes } from './vault-artefacts.js';
import { DEPLOYED_CIRCUITS } from '../midnight/deferral.js';

/* Only the files a device proves a vault's transactions with; nothing else by any spelling. */
const places = vaultArtefactPlaces('/repo', {});

describe('THE PROVING MATERIAL A DEVICE MAY FETCH', () => {
  it('names the vault\'s own circuits, the network\'s shielded circuits and the public parameters', () => {
    expect(vaultArtefactFile(places, '/keys/deposit.prover')).toBe('/repo/contracts/managed-vault/keys/deposit.prover');
    expect(vaultArtefactFile(places, '/keys/payout.verifier')).toBe('/repo/contracts/managed-vault/keys/payout.verifier');
    expect(vaultArtefactFile(places, '/zkir/deposit.bzkir')).toBe('/repo/contracts/managed-vault/zkir/deposit.bzkir');
    expect(vaultArtefactFile(places, '/params/bls_midnight_2p13')).toBe('/repo/.midnight/params/bls_midnight_2p13');
    expect(vaultArtefactFile(places, '/builtin/zswap/9/keys/output.prover')).toBe('/repo/.midnight/params/zswap/9/output.prover');
    expect(vaultArtefactFile(places, '/builtin/zswap/9/zkir/output.bzkir')).toBe('/repo/.midnight/params/zswap/9/output.bzkir');
    expect(vaultArtefactFile(vaultArtefactPlaces('/repo', { MIDNIGHT_PARAMS_DIR: '/params' }), '/params/bls_midnight_2p9'))
      .toBe('/params/bls_midnight_2p9');
  });

  it('A VAULT CALL ALSO PROVES THE ACCOUNT\'S recordPaymentFromVault OR approveVaultChange, AND A SIGNER\'S DEVICE PROVES propose, approve, cancel, amendSigner, setThreshold, setVaultThreshold, adopt, setPolicy, setPolicyBar AND clearRun ARE SERVED, AND THE ACCOUNT\'S CIRCUITS NO DEVICE PROVES ARE NOT (THE WHOLE SERVED LIST IS PINNED IN vault-worker-routing.test.ts)', () => {
    /* RED WHEN: the account's folder is not served (a payment out, a raise, an approval, a seat or a threshold change then cannot be
     * proved on a device, nor a vault's adoption when it is created), or it serves any other circuit of the account's, or a vault name reaches it. */
    /* A withdrawal, a vault's own approvals needed, a vault's spending policy and the approvals a policy change needs are proved on a signer's device too: RED WHEN any is not served. */
    /* Charging an approved run to its vault's period is proved on the paying signer's device: RED WHEN clearRun is not served. */
    for (const circuit of ['recordPaymentFromVault', 'approveVaultChange', 'propose', 'approve', 'cancel', 'amendSigner', 'setThreshold', 'setVaultThreshold', 'adopt', 'setPolicy', 'setPolicyBar', 'clearRun']) {
      expect(vaultArtefactFile(places, `/account/keys/${circuit}.prover`)).toBe(`/repo/contracts/managed/keys/${circuit}.prover`);
      expect(vaultArtefactFile(places, `/account/keys/${circuit}.verifier`)).toBe(`/repo/contracts/managed/keys/${circuit}.verifier`);
      expect(vaultArtefactFile(places, `/account/zkir/${circuit}.bzkir`)).toBe(`/repo/contracts/managed/zkir/${circuit}.bzkir`);
    }
    for (const path of [
      '/account/keys/closeExpiredRun.prover', '/account/keys/holdRun.prover',
      '/account/keys/retireVault.prover', '/account/keys/payout.prover', '/account/keys/recordPayment.prover',
      '/account/zkir/recordPayment.prover', '/account/keys/recordPayment.bzkir', '/account/keys/../keys/recordPayment.prover',
      '/keys/recordPayment.prover', '/keys/propose.prover', '/keys/approve.prover',
      '/account/params/bls_midnight_2p13', '/account/keys/recordpayment.prover', '/account/keys/Propose.prover',
    ]) {
      expect(vaultArtefactFile(places, path), path).toBeNull();
    }
  });

  it('EVERY ONE OF THE ACCOUNT\'S VERIFYING KEYS IS SERVED, FOR THE FOUNDING SIGNER\'S DEVICE TO DEPLOY THE ACCOUNT WITH, AND NO MORE PROVING MATERIAL', () => {
    /* RED WHEN a verifying key the account's deploy or its second step carries cannot be fetched by the device. */
    for (const circuit of DEPLOYED_CIRCUITS) {
      expect(vaultArtefactFile(places, `/account/keys/${circuit}.verifier`), circuit).toBe(`/repo/contracts/managed/keys/${circuit}.verifier`);
    }
    /* RED WHEN serving every verifying key also serves proving material for a circuit no device proves. */
    for (const path of ['/account/keys/holdRun.prover', '/account/zkir/holdRun.bzkir', '/account/keys/recordPayment.verifier']) {
      expect(vaultArtefactFile(places, path), path).toBeNull();
    }
  });

  it('REFUSES EVERY OTHER NAME: another circuit, another folder, a mismatched kind, or a way out', () => {
    for (const path of [
      '/keys/../../.env', '/keys/deposit.prover/../x', '/keys/notACircuit.prover', '/keys/deposit.bzkir',
      '/zkir/deposit.prover', '/params/../wallet.seed', '/params/bls_midnight_2p', '/params/seed',
      '/builtin/zswap/9/keys/../../../wallet.seed', '/builtin/dust/9/keys/spend.prover',
      '/builtin/zswap/9/keys/sign.bzkir', '/builtin/zswap/8/keys/output.prover', '/', '',
      '/keys/Deposit.prover', '/keys/deposit.prover?x',
    ]) {
      expect(vaultArtefactFile(places, path), path).toBeNull();
    }
  });
});

/*
 * THE ROUTE ITSELF, OVER REAL FILES AND REAL HTTP. The assertions above say which file a name maps to;
 * these say the file actually arrives. The public parameters live in a folder whose name starts with a
 * dot, and a file that is found but never sent is exactly what a browser saw as "404".
 */
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const bytes = (label: string): Buffer => Buffer.from(`${label}:${'x'.repeat(64)}`);

const PARAMS = bytes('parameters for k=0');
const SWAPPED = bytes('some other parameters');
const FILECOIN = bytes('the older parameters');
const PROVER = bytes('deposit proving key');
const OUTPUT = bytes('shielded output proving key');
const SECRET = bytes('seed words');

/* The only parameters this checkout knows as genuine. The real table is Midnight's; this one names test bytes. */
const KNOWN: Readonly<Record<string, string>> = { bls_midnight_2p0: sha256(PARAMS), bls_midnight_2p1: sha256(PARAMS), bls_midnight_2p17: sha256(PARAMS) };
const known = (name: string): string | undefined => KNOWN[name];

const lay = (root: string, files: Record<string, Uint8Array>): void => {
  for (const [rel, b] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), b);
  }
};

/* A raw request: the path goes on the wire exactly as written, with no client tidying a way out of the folder. */
const get = (server: Server, path: string): Promise<{ status: number; body: Buffer }> =>
  new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    req.end();
  });

const serve = async (root: string): Promise<Server> => {
  const app = express();
  app.use(vaultArtefactRoutes(vaultArtefactPlaces(root, {}), known));
  return new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
};

describe('THE ROUTE HANDS THE FILE OVER, NOT ONLY FINDS IT', () => {
  let plain: Server;
  let dotted: Server;
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'artefacts-'));
    const tree = {
      '.midnight/params/bls_midnight_2p0': PARAMS,
      '.midnight/params/bls_midnight_2p1': SWAPPED,
      '.midnight/params/bls_filecoin_2p0': FILECOIN,
      '.midnight/params/zswap/9/output.prover': OUTPUT,
      '.midnight/params/seed': SECRET,
      '.midnight/params/.env': SECRET,
      'contracts/managed-vault/keys/deposit.prover': PROVER,
      '.env': SECRET,
    };
    lay(root, tree);
    /* The same checkout, placed inside a folder whose own name starts with a dot. */
    lay(join(root, '.apps', 'checkout'), tree);
    plain = await serve(root);
    dotted = await serve(join(root, '.apps', 'checkout'));
  });
  afterAll(() => { plain?.close(); dotted?.close(); });

  it('A PUBLIC PARAMETER FILE KEPT UNDER .midnight/params ARRIVES, BYTE FOR BYTE', async () => {
    /* RED WHEN: the file is handed to the sender as a path with a dot-named folder in it and the sender's
     * default for such paths is left in place - it answers 404 although the file is there. */
    const got = await get(plain, '/artefacts/vault/params/bls_midnight_2p0');
    expect(got.status).toBe(200);
    expect(sha256(got.body)).toBe(sha256(PARAMS));
  });

  it('THE NETWORK\'S OWN SHIELDED-OUTPUT CIRCUIT, KEPT BESIDE THE PARAMETERS, ARRIVES TOO', async () => {
    /* RED WHEN: as above - it sits under the same dot-named folder. */
    const got = await get(plain, '/artefacts/vault/builtin/zswap/9/keys/output.prover');
    expect(got.status).toBe(200);
    expect(sha256(got.body)).toBe(sha256(OUTPUT));
  });

  it('A CHECKOUT THAT ITSELF SITS UNDER A DOT-NAMED FOLDER STILL HANDS OVER ITS COMPILED KEYS', async () => {
    /* RED WHEN: the dot test is made against the whole path on disk rather than only the part below the
     * folder the file is served from - then every file of a deployment placed under such a folder is refused. */
    const got = await get(dotted, '/artefacts/vault/keys/deposit.prover');
    expect(got.status).toBe(200);
    expect(sha256(got.body)).toBe(sha256(PROVER));
  });

  it('A PARAMETER FILE WHOSE BYTES ARE NOT THE PUBLISHED ONES IS NOT HANDED OVER, AND NEITHER IS A NAME NOTHING PUBLISHES', async () => {
    /* RED WHEN: the route sends a parameter file without comparing it with the published digest for its name,
     * or treats a name with no published digest as fine. */
    const swapped = await get(plain, '/artefacts/vault/params/bls_midnight_2p1');
    expect(swapped.status).toBe(404);
    expect(swapped.body.includes(SWAPPED)).toBe(false);
    const older = await get(plain, '/artefacts/vault/params/bls_filecoin_2p0');
    expect(older.status).toBe(404);
    expect(older.body.includes(FILECOIN)).toBe(false);
  });

  it('A NAME OUTSIDE THE LIST, OR A PATH THAT TRIES TO LEAVE THE FOLDER, STILL GETS NOTHING', async () => {
    /* RED WHEN: the list of names is widened, or a way out of the folder is let through - any of these
     * returns the secret's bytes. */
    for (const path of [
      '/artefacts/vault/params/seed',
      '/artefacts/vault/params/../../.env',
      '/artefacts/vault/params/..%2F..%2F.env',
      '/artefacts/vault/params/%2e%2e/%2e%2e/.env',
      '/artefacts/vault/keys/../../../../.env',
      '/artefacts/vault/builtin/zswap/9/keys/../../../seed',
      '/artefacts/vault/.env',
      '/artefacts/vault/params/.env',
    ]) {
      for (const server of [plain, dotted]) {
        const got = await get(server, path);
        expect(got.status, path).not.toBe(200);
        expect(got.body.includes(SECRET), path).toBe(false);
      }
    }
  });
});

/* The status and the caching header of one response, as a browser would receive them. */
const head = (server: Server, path: string): Promise<{ status: number; cache: string | undefined }> =>
  new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, cache: res.headers['cache-control'] }));
    });
    req.on('error', reject);
    req.end();
  });

/*
 * **A REFUSAL A BROWSER IS ALLOWED TO KEEP IS A REFUSAL IT REPLAYS.** A browser
 * that is told a response may be kept for an hour does not ask again for an
 * hour, whatever has changed here since. A refusal that carried that permission
 * went on being served from the browser's own cache after the file it refused
 * was being handed over, and the request never reached this server.
 */
describe('A REFUSAL IS NEVER KEPT BY A BROWSER, AND A FILE THAT IS SENT MAY BE', () => {
  let server: Server;
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'artefacts-kept-'));
    lay(root, {
      '.midnight/params/bls_midnight_2p0': PARAMS,
      '.midnight/params/bls_midnight_2p1': SWAPPED,
      'contracts/managed-vault/keys/deposit.prover': PROVER,
    });
    /* A name that is on the list and is there, but cannot be sent: a folder where the file should be. */
    mkdirSync(join(root, 'contracts', 'managed-vault', 'keys', 'deposit.verifier'), { recursive: true });
    server = await serve(root);
  });
  afterAll(() => { server?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

  it('A FILE THAT IS FOUND AND THEN CANNOT BE SENT IS REFUSED WITH NOTHING A BROWSER MAY KEEP', async () => {
    /* RED WHEN: the refusal a failed send turns into does not say it must not be kept. With the one-hour header
     * set on the response before the send, and the refusal saying nothing, it answers 'public, max-age=3600'. */
    const got = await head(server, '/artefacts/vault/keys/deposit.verifier');
    expect(got.status).toBe(404);
    expect(got.cache).toBe('no-store');
  });

  it('EVERY OTHER REFUSAL SAYS THE SAME: A NAME OFF THE LIST, A FILE NOT HERE, AND PARAMETERS THAT ARE NOT THE PUBLISHED ONES', async () => {
    /* RED WHEN: a refusal goes out without saying it must not be kept - a browser, or anything between, may then
     * decide for itself how long to keep it. */
    for (const path of [
      '/artefacts/vault/keys/nothing.prover',
      '/artefacts/vault/zkir/deposit.bzkir',
      '/artefacts/vault/params/bls_midnight_2p1',
      '/artefacts/vault/params/bls_filecoin_2p0',
    ]) {
      const got = await head(server, path);
      expect(got.status, path).toBe(404);
      expect(got.cache, path).toBe('no-store');
    }
  });

  it('PARAMETERS MIDNIGHT PUBLISHES THAT ARE NOT HERE, OR NOT GENUINE, ARE REFUSED BY NAME, WITH WHAT BRINGS THEM HERE, AND NOT KEPT', async () => {
    /* RED WHEN: a device asking for published parameters this server lacks, or holds a wrong copy of, is told only that nothing is here. */
    for (const name of ['bls_midnight_2p17', 'bls_midnight_2p1']) {
      const got = await get(server, `/artefacts/vault/params/${name}`);
      expect(got.status, name).toBe(404);
      const said = JSON.parse(got.body.toString('utf8')).error as string;
      expect(said, name).toContain(`the public parameters ${name} are not on this server`);
      expect(said, name).toMatch(/fetches and checks them each time it starts: let it reach its parameter source, or set MIDNIGHT_PARAM_SOURCE .* and restart it/u);
      expect((await head(server, `/artefacts/vault/params/${name}`)).cache, name).toBe('no-store');
    }
    /* RED WHEN: a name nothing publishes is answered as if it were parameters, and so named back to whoever asked. */
    const unpublished = await get(server, '/artefacts/vault/params/bls_filecoin_2p0');
    expect(JSON.parse(unpublished.body.toString('utf8'))).toEqual({ error: 'there is no such proving material here.' });
  });

  it('A FILE THAT IS SENT MAY BE KEPT FOR AN HOUR', async () => {
    /* RED WHEN: the caching header is dropped from a successful send - every approval then downloads again. */
    for (const path of ['/artefacts/vault/keys/deposit.prover', '/artefacts/vault/params/bls_midnight_2p0']) {
      const got = await head(server, path);
      expect(got.status, path).toBe(200);
      expect(got.cache, path).toBe('public, max-age=3600');
    }
  });
});

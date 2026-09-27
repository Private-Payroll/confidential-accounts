import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vaultArtefactFile, vaultArtefactPlaces, vaultArtefactRoutes } from './vault-artefacts.js';

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

  it('A PAYMENT OUT ALSO PROVES THE ACCOUNT\'S recordPayment, AND A SIGNER\'S DEVICE PROVES propose, approve, amendSigner AND setThreshold: THOSE FIVE AND NO OTHER OF THE ACCOUNT\'S', () => {
    /* RED WHEN: the account's folder is not served (a payment out, a raise, an approval, a seat or a threshold change then cannot be
     * proved on a device), or it serves any other circuit of the account's, or a vault name reaches it. */
    for (const circuit of ['recordPayment', 'propose', 'approve', 'amendSigner', 'setThreshold']) {
      expect(vaultArtefactFile(places, `/account/keys/${circuit}.prover`)).toBe(`/repo/contracts/managed/keys/${circuit}.prover`);
      expect(vaultArtefactFile(places, `/account/keys/${circuit}.verifier`)).toBe(`/repo/contracts/managed/keys/${circuit}.verifier`);
      expect(vaultArtefactFile(places, `/account/zkir/${circuit}.bzkir`)).toBe(`/repo/contracts/managed/zkir/${circuit}.bzkir`);
    }
    for (const path of [
      '/account/keys/cancel.prover', '/account/keys/closeExpiredRun.prover', '/account/keys/setVaultThreshold.prover',
      '/account/keys/adopt.prover', '/account/keys/payout.prover',
      '/account/zkir/recordPayment.prover', '/account/keys/recordPayment.bzkir', '/account/keys/../keys/recordPayment.prover',
      '/keys/recordPayment.prover', '/keys/propose.prover', '/keys/approve.prover',
      '/account/params/bls_midnight_2p13', '/account/keys/recordpayment.prover', '/account/keys/Propose.prover',
    ]) {
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
const KNOWN: Readonly<Record<string, string>> = { bls_midnight_2p0: sha256(PARAMS), bls_midnight_2p1: sha256(PARAMS) };
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

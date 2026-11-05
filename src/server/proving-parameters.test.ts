import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIDNIGHT_PARAMETER_SHA256, PARAMETER_SOURCES, describeParameters, ensureProvingParameters, parameterSources,
  parametersNeeded, publishedByMidnight, servedCircuits, sizesFromTheCircuits, startProvingParameters, type ReadSizes,
} from './proving-parameters.js';
import { vaultArtefactPlaces, vaultArtefactRoutes } from './vault-artefacts.js';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/*
 * The compiled deposit circuit this repository ships. Only the full key build writes it and the quick compile does
 * not, so the one block that reads it stands down where it is absent and says so.
 */
const DEPOSIT_CIRCUIT = fileURLToPath(new URL('../../contracts/managed-vault/zkir/deposit.bzkir', import.meta.url));
const HAS_DEPOSIT_CIRCUIT = existsSync(DEPOSIT_CIRCUIT);
if (!HAS_DEPOSIT_CIRCUIT) console.log(`  NOT CHECKED HERE: the size the served circuits need was not read, because ${DEPOSIT_CIRCUIT} is missing. \`npm run compact\` then \`npm run compact:vault -- --full\` build it.`);

describe('THE DIGESTS A PARAMETER FILE IS CHECKED AGAINST', () => {
  it('lists exactly bls_midnight_2p0 to bls_midnight_2p25, each with a whole SHA-256, and nothing else', () => {
    /* RED WHEN: a size is dropped or added, a digest is cut short, or an older-named file is given a digest. */
    expect(Object.keys(MIDNIGHT_PARAMETER_SHA256)).toEqual(Array.from({ length: 26 }, (_, k) => `bls_midnight_2p${k}`));
    for (const [name, digest] of Object.entries(MIDNIGHT_PARAMETER_SHA256)) expect(digest, name).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Set(Object.values(MIDNIGHT_PARAMETER_SHA256)).size).toBe(26);
    expect(publishedByMidnight('bls_filecoin_2p15')).toBeUndefined();
    expect(publishedByMidnight('constructor')).toBeUndefined();
    expect(publishedByMidnight('bls_midnight_2p15')).toBe(MIDNIGHT_PARAMETER_SHA256.bls_midnight_2p15);
  });

  it('fetches from the published sources unless the variable Midnight\'s own tools read names one', () => {
    /* RED WHEN: the list is empty, the override is ignored, or a trailing slash doubles up in the address. */
    expect(parameterSources({})).toEqual(PARAMETER_SOURCES);
    expect(PARAMETER_SOURCES.length).toBeGreaterThan(0);
    expect(parameterSources({ MIDNIGHT_PARAM_SOURCE: 'http://127.0.0.1:9/' })).toEqual(['http://127.0.0.1:9']);
  });
});

describe.skipIf(!HAS_DEPOSIT_CIRCUIT)('THE SIZE EACH SERVED CIRCUIT NEEDS IS READ FROM THE CIRCUIT [needs contracts/managed-vault/zkir/deposit.bzkir; `npm run compact` then `npm run compact:vault -- --full` build it]', () => {
  /*
   * The size the deposit circuit needs, read from the compiled circuit through the same reader the service uses, so
   * the fixtures below follow the circuit when it is rebuilt at another size.
   */
  let depositK = 0;
  beforeAll(async () => {
    const [size] = await sizesFromTheCircuits([DEPOSIT_CIRCUIT]);
    if (size === undefined || !('k' in size)) throw new Error(`the compiled deposit circuit could not be read: ${size === undefined ? 'no answer' : size.why}`);
    depositK = size.k;
  });

  it('reads k from each compiled circuit, off the circuit, and says why for a file that is not one', async () => {
    /* RED WHEN: k is taken from anywhere but the compiled bytes - a constant, a list, or the file's name - or
     * one unreadable file costs the answers for the others. The two values were read off the circuit library
     * with these exact circuits. */
    const zkir: any = await import('@midnight-ntwrk/zkir-v2');
    const circuit = (n: number): Uint8Array => zkir.jsonIrToBinary(JSON.stringify({
      version: { major: 2, minor: 0 }, do_communications_commitment: false, num_inputs: 1,
      instructions: Array.from({ length: n }, () => ({ op: 'constrain_bits', var: 0, bits: n === 1 ? 8 : 248 })),
    }));
    const dir = mkdtempSync(join(tmpdir(), 'sizes-'));
    writeFileSync(join(dir, 'small.bzkir'), circuit(1));
    writeFileSync(join(dir, 'larger.bzkir'), circuit(10));
    writeFileSync(join(dir, 'broken.bzkir'), 'not a circuit');
    const sizes = await sizesFromTheCircuits([join(dir, 'small.bzkir'), join(dir, 'broken.bzkir'), join(dir, 'larger.bzkir')]);
    expect(sizes[0]).toEqual({ k: 4 });
    expect(sizes[1]).toHaveProperty('why');
    expect(sizes[2]).toEqual({ k: 12 });
  });

  it('groups the served circuits by the size each needs, and names any it could not read', async () => {
    /* RED WHEN: a circuit is left out of its group, a missing or unreadable circuit is passed over in silence,
     * or a served circuit is not asked about at all. */
    const root = mkdtempSync(join(tmpdir(), 'needs-'));
    const places = vaultArtefactPlaces(root, {});
    const circuits = servedCircuits(places);
    const labels = circuits.map((c) => c.label);
    expect(labels).toContain('deposit (vault)');
    expect(labels).toContain('depositUnshielded (vault)');
    expect(labels).toContain('recordPaymentFromVault (company account)');
    expect(labels).toContain('shielded output (network)');
    const outputK = depositK + 1;
    const unknownK = depositK + 2;
    const sizes: Record<string, number> = { deposit: depositK, depositUnshielded: 9, output: outputK };
    for (const c of circuits) {
      const name = c.label.split(' ')[c.label.startsWith('shielded') ? 1 : 0]!;
      if (name === 'payout') continue; /* left missing on purpose */
      mkdirSync(dirname(c.ir), { recursive: true });
      writeFileSync(c.ir, name === 'retire' ? 'unreadable' : name);
    }
    const readSizes: ReadSizes = async (files) => files.map((f) => {
      const name = readFileSync(f, 'utf8');
      return name === 'unreadable' ? { why: 'not a circuit' } : { k: sizes[name] ?? unknownK };
    });
    const { needs, unread } = await parametersNeeded(circuits, readSizes);
    expect(needs.get(depositK)).toEqual(['deposit (vault)']);
    expect(needs.get(9)).toEqual(['depositUnshielded (vault)']);
    expect(needs.get(outputK)).toEqual(['shielded output (network)']);
    expect([...needs.keys()]).toEqual([9, depositK, outputK, unknownK]);
    expect(unread.some((u) => u.startsWith('payout (vault)'))).toBe(true);
    expect(unread.some((u) => u.startsWith('retire (vault)') && u.includes('not a circuit'))).toBe(true);
    expect([...needs.values()].flat().length + unread.length).toBe(circuits.length);
  });
});

/*
 * WHERE THE KEYS ARE BUILT, THE BLOCK ABOVE CANNOT STAND DOWN. It stands down, and passes, where the compiled
 * circuit is missing, so a job that built the keys and lost the circuit would pass having read nothing. The job
 * that builds the keys sets KEYS_MUST_BE_BUILT, and there a missing circuit is a failure naming it.
 */
const KEYS_MUST_BE_BUILT = (process.env.KEYS_MUST_BE_BUILT ?? '') !== '';

describe.skipIf(!KEYS_MUST_BE_BUILT)('where the checks built the keys, the size each served circuit needs is read [needs KEYS_MUST_BE_BUILT, which the job that runs `npm run compact` then `npm run compact:vault -- --full` sets]', () => {
  it('the compiled deposit circuit is on disk', () => {
    /* RED WHEN: the job that builds the keys leaves no compiled deposit circuit, which would stand the block above down green. */
    expect(HAS_DEPOSIT_CIRCUIT, `${DEPOSIT_CIRCUIT} is missing`).toBe(true);
  });
});

/*
 * ON START. The public source is stood in by a function: nothing here reaches the internet. The circuits are
 * stand-ins built with the circuit library and read through the service's own reader, the deposit a larger one
 * and every other served circuit a small one, so each size here is read off a circuit and none is written in.
 * The digests are those of the stand-in bytes, so a check that passes proves the comparison and not the table.
 */
const STAND_INS = await (async () => {
  const zkir: any = await import('@midnight-ntwrk/zkir-v2');
  const circuit = (n: number): Uint8Array => zkir.jsonIrToBinary(JSON.stringify({
    version: { major: 2, minor: 0 }, do_communications_commitment: false, num_inputs: 1,
    instructions: Array.from({ length: n }, () => ({ op: 'constrain_bits', var: 0, bits: n === 1 ? 8 : 248 })),
  }));
  const dir = mkdtempSync(join(tmpdir(), 'stand-ins-'));
  const files = [join(dir, 'small.bzkir'), join(dir, 'larger.bzkir')];
  writeFileSync(files[0]!, circuit(1));
  writeFileSync(files[1]!, circuit(10));
  const [small, larger] = await sizesFromTheCircuits(files);
  if (small === undefined || !('k' in small) || larger === undefined || !('k' in larger)) throw new Error('a stand-in circuit could not be read');
  return { small: { bytes: readFileSync(files[0]!), k: small.k }, larger: { bytes: readFileSync(files[1]!), k: larger.k } };
})();
const SMALL_PARAMETERS = `bls_midnight_2p${STAND_INS.small.k}`;
const DEPOSIT_PARAMETERS = `bls_midnight_2p${STAND_INS.larger.k}`;
const GENUINE_SMALL = Buffer.from(`parameters for circuits of size 2^${STAND_INS.small.k}`);
const GENUINE_DEPOSIT = Buffer.from(`parameters for circuits of size 2^${STAND_INS.larger.k}`);
const DIGESTS: Record<string, string> = { [SMALL_PARAMETERS]: sha256(GENUINE_SMALL), [DEPOSIT_PARAMETERS]: sha256(GENUINE_DEPOSIT) };
const published = (name: string): string | undefined => DIGESTS[name];
const readSizes: ReadSizes = sizesFromTheCircuits;
/** The deposit gets the larger stand-in and every other served circuit the small one. */
const standInFor = (label: string): Buffer => (label.split(' ')[0] === 'deposit' ? STAND_INS.larger.bytes : STAND_INS.small.bytes);

type Answer = { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> };
const answer = (b: Uint8Array): Answer => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(b).buffer });
const notThere: Answer = { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };

describe('ON START THE SERVER FETCHES WHAT IT LACKS, CHECKS IT, AND SAYS SO', () => {
  let root: string;
  let places: ReturnType<typeof vaultArtefactPlaces>;
  let server: Server | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'on-start-'));
    places = vaultArtefactPlaces(root, {});
    for (const c of servedCircuits(places)) {
      mkdirSync(dirname(c.ir), { recursive: true });
      writeFileSync(c.ir, standInFor(c.label));
    }
  });
  afterEach(() => { server?.close(); server = undefined; });

  const serve = async (): Promise<(path: string) => Promise<{ status: number; body: Buffer }>> => {
    const app = express();
    app.use(vaultArtefactRoutes(places, published));
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const { port } = server.address() as AddressInfo;
    return async (path) => {
      const res = await fetch(`http://127.0.0.1:${port}/artefacts/vault/params/${path}`);
      return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
    };
  };

  it('A MISSING PARAMETER FILE IS FETCHED, CHECKED, KEPT, AND THEN HANDED TO A DEVICE', async () => {
    /* RED WHEN: a needed size is not fetched, a fetched file is not written where the route looks, or the log
     * does not say where it came from. */
    const asked: string[] = [];
    const fetch = async (url: string): Promise<Answer> => {
      asked.push(url);
      return url.endsWith(SMALL_PARAMETERS) ? answer(GENUINE_SMALL) : url.endsWith(DEPOSIT_PARAMETERS) ? answer(GENUINE_DEPOSIT) : notThere;
    };
    const out = await ensureProvingParameters({ places, sources: ['https://stand-in.example'], fetch, published, readSizes });
    expect(out.fetched.map((f) => f.name).sort()).toEqual([DEPOSIT_PARAMETERS, SMALL_PARAMETERS].sort());
    expect(out.missing).toEqual([]);
    expect(asked).toContain(`https://stand-in.example/${DEPOSIT_PARAMETERS}`);
    expect(readFileSync(join(places.params, DEPOSIT_PARAMETERS))).toEqual(GENUINE_DEPOSIT);
    const get = await serve();
    const got = await get(DEPOSIT_PARAMETERS);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(GENUINE_DEPOSIT);
    const { info } = describeParameters(out);
    expect(info.some((l) => l.includes(`fetched ${DEPOSIT_PARAMETERS}`) && l.includes('https://stand-in.example'))).toBe(true);
  });

  it('A FILE THAT FAILS THE CHECK IS NOT KEPT AND NOT SERVED, AND THE NEXT SOURCE IS TRIED', async () => {
    /* RED WHEN: a download is kept without being compared, a failed comparison stops the search early, or a
     * file already here that is not genuine is overwritten rather than moved aside, or left where the route looks. */
    mkdirSync(places.params, { recursive: true });
    writeFileSync(join(places.params, DEPOSIT_PARAMETERS), 'left here by somebody');
    const forged = Buffer.from('not the parameters');
    const fetch = async (url: string): Promise<Answer> =>
      url.startsWith('https://first.example') ? answer(forged)
        : url.endsWith(DEPOSIT_PARAMETERS) ? answer(GENUINE_DEPOSIT) : notThere;
    const out = await ensureProvingParameters({ places, sources: ['https://first.example', 'https://second.example'], fetch, published, readSizes });
    expect(out.fetched.find((f) => f.name === DEPOSIT_PARAMETERS)?.from).toBe('https://second.example');
    expect(readFileSync(join(places.params, DEPOSIT_PARAMETERS))).toEqual(GENUINE_DEPOSIT);
    expect(out.setAside).toHaveLength(1);
    expect(out.setAside[0]?.from).toBe(join(places.params, DEPOSIT_PARAMETERS));
    expect(readFileSync(out.setAside[0]!.to, 'utf8')).toBe('left here by somebody');

    const onlyForged = async (): Promise<Answer> => answer(forged);
    const root2 = mkdtempSync(join(tmpdir(), 'forged-'));
    const places2 = vaultArtefactPlaces(root2, {});
    for (const c of servedCircuits(places2)) { mkdirSync(dirname(c.ir), { recursive: true }); writeFileSync(c.ir, standInFor(c.label)); }
    const out2 = await ensureProvingParameters({ places: places2, sources: ['https://first.example'], fetch: onlyForged, published, readSizes });
    expect(out2.fetched).toEqual([]);
    expect(out2.missing.map((m) => m.name).sort()).toEqual([DEPOSIT_PARAMETERS, SMALL_PARAMETERS].sort());
    expect(existsSync(join(places2.params, DEPOSIT_PARAMETERS))).toBe(false);
    expect(existsSync(places2.params) ? readdirSync(places2.params).filter((f) => f.startsWith('bls_')) : []).toEqual([]);

    /* And a forged file somebody put in place by hand is refused by the route itself. */
    writeFileSync(join(places.params, SMALL_PARAMETERS), forged);
    const get = await serve();
    const got = await get(SMALL_PARAMETERS);
    expect(got.status).toBe(404);
    expect(got.body.includes(forged)).toBe(false);
  });

  it('A SERVER THAT CANNOT REACH THE SOURCE STILL COMES UP, AND ITS LOG NAMES THE PROOFS THAT WILL FAIL', async () => {
    /* RED WHEN: an unreachable source throws out of start-up, or the log does not name the file and every
     * circuit that needs it. */
    const offline = async (): Promise<Answer> => { throw new Error('getaddrinfo ENOTFOUND'); };
    const out = await ensureProvingParameters({ places, sources: ['https://unreachable.example'], fetch: offline, published, readSizes });
    expect(out.fetched).toEqual([]);
    const depositFile = out.missing.find((m) => m.name === DEPOSIT_PARAMETERS);
    expect(depositFile?.circuits).toEqual(['deposit (vault)']);
    expect(depositFile?.why).toContain('failed');
    const { warn } = describeParameters(out);
    expect(warn.some((l) => l.includes(DEPOSIT_PARAMETERS) && l.includes('could not be fetched'))).toBe(true);
    expect(warn.some((l) => l.includes('MIDNIGHT_PARAM_SOURCE') && l.includes('restart'))).toBe(true);
    expect(warn.some((l) => l.includes('will fail') && l.includes('deposit (vault)'))).toBe(true);
    expect(warn.some((l) => l.includes('will fail') && l.includes('depositUnshielded (vault)'))).toBe(true);
  });

  it('A FILE ALREADY HERE AND GENUINE IS KEPT AND NOTHING IS FETCHED FOR IT', async () => {
    /* RED WHEN: a genuine file is fetched again on every start, or is moved aside. */
    mkdirSync(places.params, { recursive: true });
    writeFileSync(join(places.params, SMALL_PARAMETERS), GENUINE_SMALL);
    writeFileSync(join(places.params, DEPOSIT_PARAMETERS), GENUINE_DEPOSIT);
    const asked: string[] = [];
    const fetch = async (url: string): Promise<Answer> => { asked.push(url); return notThere; };
    const out = await ensureProvingParameters({ places, sources: ['https://stand-in.example'], fetch, published, readSizes });
    expect(asked).toEqual([]);
    expect([...out.present].sort()).toEqual([DEPOSIT_PARAMETERS, SMALL_PARAMETERS].sort());
    expect(out.setAside).toEqual([]);
  });

  it('THE SERVER STARTS IT WITHOUT WAITING FOR IT, AND A FAILURE INSIDE IT REACHES THE LOG, NOT THE SERVER', async () => {
    /* RED WHEN: starting it waits for the fetch (it returns a promise, or anything, rather than nothing), the lines
     * never reach the log, or a failure part way escapes instead of being written down. */
    const lines: string[] = [];
    const log = { info: (l: string) => lines.push(`info ${l}`), warn: (l: string) => lines.push(`warn ${l}`) };
    const offline = async (): Promise<Answer> => { throw new Error('getaddrinfo ENOTFOUND'); };
    const started = startProvingParameters({ places, sources: ['https://unreachable.example'], fetch: offline, published, readSizes }, log);
    expect(started).toBeUndefined();
    expect(lines).toEqual([]);
    await vi.waitFor(() => expect(lines.some((l) => l.startsWith('warn') && l.includes('deposit (vault)'))).toBe(true));

    const broken = (): string | undefined => { throw new Error('the digest list could not be read'); };
    startProvingParameters({ places, sources: ['https://unreachable.example'], fetch: offline, published: broken, readSizes }, log);
    await vi.waitFor(() => expect(lines.some((l) => l.startsWith('warn') && l.includes('stopped part way')
      && l.includes('the digest list could not be read'))).toBe(true));
  });

  it('A FILE REPLACED WHILE THE SERVER RUNS IS CHECKED AGAIN, SO A GENUINE ONE FETCHED LATE IS SERVED', async () => {
    /* RED WHEN: the route remembers its answer for a path and not for the version of the file at that path - a
     * request that arrived before the fetch finished would then keep the file refused until a restart. */
    mkdirSync(places.params, { recursive: true });
    const file = join(places.params, DEPOSIT_PARAMETERS);
    writeFileSync(file, 'half a download, or something else');
    const get = await serve();
    expect((await get(DEPOSIT_PARAMETERS)).status).toBe(404);
    writeFileSync(`${file}.new`, GENUINE_DEPOSIT);
    renameSync(`${file}.new`, file);
    const got = await get(DEPOSIT_PARAMETERS);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(GENUINE_DEPOSIT);
  });
});

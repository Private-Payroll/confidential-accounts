import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE, VAULT_CIRCUITS } from '../midnight/vault-contract.js';
import { publishedByMidnight, type PublishedDigest } from '../midnight/proving-parameter-digests.js';

/** Midnight's published digests, kept where a device's worker can read them too; named here for this server's readers. */
export { MIDNIGHT_PARAMETER_SHA256, publishedByMidnight, type PublishedDigest } from '../midnight/proving-parameter-digests.js';

/** The file name of the public parameters for circuits of size 2^k. */
export const parameterName = (k: number): string => `bls_midnight_2p${k}`;

/**
 * Where the files are fetched from, in order. The first is the source
 * Midnight's own ledger fetches from; the second is the store Midnight's wallet
 * fetches its proving files from. Both serve the same bytes, and neither is
 * trusted: whatever arrives is checked against Midnight's published digests
 * (`MIDNIGHT_PARAMETER_SHA256`) before it is kept. `MIDNIGHT_PARAM_SOURCE` - the variable Midnight's own tools read for
 * this - replaces the list with one source.
 */
export const PARAMETER_SOURCES: readonly string[] = Object.freeze([
  'https://srs.midnight.network',
  'https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com',
]);

export const parameterSources = (env: NodeJS.ProcessEnv): readonly string[] =>
  env.MIDNIGHT_PARAM_SOURCE ? [env.MIDNIGHT_PARAM_SOURCE.replace(/\/+$/u, '')] : PARAMETER_SOURCES;

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const sha256OfFile = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });

/**
 * Whether the parameter file at `file` is the genuine one for `name`. The
 * digest is worked out once per version of the file on disk - its size and
 * modification time - so a file replaced while the server runs is checked
 * again, and one that has not changed is not read again.
 */
export function genuineParameterFiles(published: PublishedDigest): (file: string, name: string) => Promise<boolean> {
  const seen = new Map<string, { size: number; mtimeMs: number; genuine: boolean }>();
  return async (file, name) => {
    const want = published(name);
    if (want === undefined) return false;
    let st;
    try { st = statSync(file); } catch { return false; }
    const was = seen.get(file);
    if (was && was.size === st.size && was.mtimeMs === st.mtimeMs) return was.genuine;
    const genuine = (await sha256OfFile(file).catch(() => '')) === want;
    seen.set(file, { size: st.size, mtimeMs: st.mtimeMs, genuine });
    return genuine;
  };
}

/** A compiled circuit this server hands to a device, and the file its size is read from. */
export interface ServedCircuit {
  readonly label: string;
  readonly ir: string;
}

/**
 * Every circuit whose proving files this server hands to a device: the vault's,
 * the company account's that a device proves, and the network's own shielded
 * circuits a private deposit or payment also proves.
 */
export function servedCircuits(places: { compiled: string; account: string; params: string }): ServedCircuit[] {
  return [
    ...VAULT_CIRCUITS.map((c) => ({ label: `${c} (vault)`, ir: join(places.compiled, 'zkir', `${c}.bzkir`) })),
    ...ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE.map((c) => ({ label: `${c} (company account)`, ir: join(places.account, 'zkir', `${c}.bzkir`) })),
    ...['output', 'spend', 'sign'].map((c) => ({ label: `shielded ${c} (network)`, ir: join(places.params, 'zswap', '9', `${c}.bzkir`) })),
  ];
}

/** Reads each compiled circuit's size, k, from the circuit itself: a number per file, or why it could not. */
export type ReadSizes = (files: readonly string[]) => Promise<ReadonlyArray<{ k: number } | { why: string }>>;

/**
 * On a thread of its own. Laying out the largest circuits to learn their size
 * takes several seconds each, and done on the server's own thread that is
 * time in which no request is answered.
 */
export const sizesFromTheCircuits: ReadSizes = (files) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./circuit-size-worker.mjs', import.meta.url), { workerData: { files: [...files] } });
    worker.once('message', (sizes) => { resolve(sizes); void worker.terminate(); });
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`the circuit reader stopped with code ${code}`)); });
  });

export interface ParameterNeeds {
  /** k, and the circuits that need parameters of that size. */
  readonly needs: ReadonlyMap<number, readonly string[]>;
  /** Circuits whose compiled file is missing or could not be read, with why. */
  readonly unread: readonly string[];
}

export async function parametersNeeded(circuits: readonly ServedCircuit[], readSizes: ReadSizes = sizesFromTheCircuits): Promise<ParameterNeeds> {
  const needs = new Map<number, string[]>();
  const unread: string[] = [];
  const here = circuits.filter((c) => existsSync(c.ir));
  for (const c of circuits) if (!existsSync(c.ir)) unread.push(`${c.label}: its compiled circuit is not here`);
  let sizes: ReadonlyArray<{ k: number } | { why: string }>;
  try {
    sizes = here.length ? await readSizes(here.map((c) => c.ir)) : [];
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    sizes = here.map(() => ({ why }));
  }
  here.forEach((c, i) => {
    const s = sizes[i];
    if (s && 'k' in s && Number.isInteger(s.k) && s.k >= 0) needs.set(s.k, [...(needs.get(s.k) ?? []), c.label]);
    else unread.push(`${c.label}: ${s && 'why' in s ? s.why : 'no size came back for it'}`);
  });
  return { needs: new Map([...needs].sort(([a], [b]) => a - b)), unread };
}

export interface ParameterOutcome {
  readonly present: readonly string[];
  readonly fetched: readonly { name: string; from: string; bytes: number }[];
  readonly setAside: readonly { from: string; to: string }[];
  readonly missing: readonly { name: string; circuits: readonly string[]; why: string }[];
  readonly unread: readonly string[];
}

export interface EnsureParameters {
  readonly places: { compiled: string; account: string; params: string };
  readonly sources: readonly string[];
  readonly fetch?: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  readonly published?: PublishedDigest;
  readonly readSizes?: ReadSizes;
}

/**
 * **WHAT A SERVER DOES WHEN IT STARTS, SO THAT NOBODY EVER PUTS THESE FILES IN
 * PLACE BY HAND.** It reads which sizes its circuits need, keeps every file
 * already here that is genuine, and fetches the rest. A download is written
 * under a temporary name, checked, and only then given its real name, so a
 * file that fails the check is never where the route looks. A file already
 * here that fails the check is moved aside, not removed, and replaced.
 * Nothing here throws: a server that cannot fetch still starts, and the
 * outcome says which proofs will fail until it can.
 */
export async function ensureProvingParameters(o: EnsureParameters): Promise<ParameterOutcome> {
  const published = o.published ?? publishedByMidnight;
  const get = o.fetch ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(120_000) }));
  const genuine = genuineParameterFiles(published);
  const { needs, unread } = await parametersNeeded(servedCircuits(o.places), o.readSizes);
  const present: string[] = [];
  const fetched: { name: string; from: string; bytes: number }[] = [];
  const setAside: { from: string; to: string }[] = [];
  const missing: { name: string; circuits: readonly string[]; why: string }[] = [];

  for (const [k, circuits] of needs) {
    const name = parameterName(k);
    const file = join(o.places.params, name);
    if (existsSync(file) && (await genuine(file, name))) { present.push(name); continue; }
    const want = published(name);
    if (want === undefined) { missing.push({ name, circuits, why: 'Midnight publishes no digest for a file of that name' }); continue; }
    const tried: string[] = [];
    let got: { from: string; bytes: Uint8Array } | null = null;
    for (const source of o.sources) {
      const url = `${source}/${name}`;
      try {
        const res = await get(url);
        if (!res.ok) { tried.push(`${source} answered ${res.status}`); continue; }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (sha256Hex(bytes) !== want) { tried.push(`${source} sent a file that is not the published one`); continue; }
        got = { from: source, bytes };
        break;
      } catch (e) {
        tried.push(`the download from ${source} failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (got === null) { missing.push({ name, circuits, why: tried.join('; ') || 'there is nowhere to fetch it from' }); continue; }
    try {
      mkdirSync(o.places.params, { recursive: true });
      if (existsSync(file)) {
        const aside = `${file}.not-genuine-${Date.now()}`;
        renameSync(file, aside);
        setAside.push({ from: file, to: aside });
      }
      const part = `${file}.part-${process.pid}`;
      writeFileSync(part, got.bytes);
      renameSync(part, file);
      fetched.push({ name, from: got.from, bytes: got.bytes.length });
    } catch (e) {
      missing.push({ name, circuits, why: `it was fetched and checked but could not be saved in ${o.places.params} (${e instanceof Error ? e.message : String(e)}); that folder must be writable and have space` });
    }
  }
  return { present, fetched, setAside, missing, unread };
}

/** The outcome in plain words, one line each, for the server's log. */
export function describeParameters(o: ParameterOutcome): { info: string[]; warn: string[] } {
  const info: string[] = [];
  const warn: string[] = [];
  if (o.present.length) info.push(`proving   public parameters here and checked: ${o.present.join(', ')}`);
  for (const f of o.fetched) info.push(`proving   fetched ${f.name} (${f.bytes} bytes) from ${f.from}, checked against Midnight's published digest`);
  for (const a of o.setAside) {
    warn.push(`proving   ${a.from} was not the published file. It was renamed to ${a.to} and replaced with a checked copy; nothing needs doing.`);
  }
  for (const m of o.missing) {
    warn.push(`proving   ${m.name} is missing or is not the published file, and a checked copy could not be fetched: ${m.why}.`);
    warn.push(`          These will fail when a device proves them: ${m.circuits.join(', ')}.`);
    warn.push('          It is fetched again when the server restarts. Let this server reach the source above,'
      + ' or set MIDNIGHT_PARAM_SOURCE to one that serves it, then restart.');
  }
  for (const u of o.unread) {
    warn.push(`proving   ${u}. Its public parameters were not checked for, so it may fail when a device proves it;`
      + ' this build is missing or has a damaged compiled circuit.');
  }
  return { info, warn };
}

/**
 * **HOW THE SERVER STARTS IT: WITHOUT WAITING FOR IT, AND WITHOUT BEING ABLE TO
 * BE STOPPED BY IT.** It returns at once; the lines arrive in the log when the
 * work is done. Whatever goes wrong is written to the log, never thrown.
 */
export function startProvingParameters(
  o: EnsureParameters,
  log: { info: (line: string) => void; warn: (line: string) => void } = { info: console.log, warn: console.warn },
): void {
  void ensureProvingParameters(o)
    .then((outcome) => {
      const { info, warn } = describeParameters(outcome);
      for (const line of info) log.info(line);
      for (const line of warn) log.warn(line);
    })
    .catch((e: unknown) => log.warn(
      `proving   the check of the public parameters stopped part way (${e instanceof Error ? e.message : String(e)}).`
      + ' Proofs whose parameters are not already here will fail on a device; restart the server to try again.',
    ));
}

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE, VAULT_CIRCUITS } from '../midnight/vault-contract.js';

/**
 * **THE PUBLIC PARAMETERS A DEVICE PROVES WITH, AND HOW THIS SERVER KNOWS THEY ARE GENUINE.**
 *
 * Every proof on Midnight is made against one set of public parameters, the
 * output of Midnight's trusted setup, cut into one file per circuit size:
 * `bls_midnight_2p<k>`. They are the same for everybody and secret to nobody.
 * A proof made against any other parameters is not one the chain accepts.
 *
 * **WHAT A FILE IS CHECKED AGAINST IS MIDNIGHT'S OWN LIST, NOT ONE MADE HERE.**
 * Midnight's ledger carries the SHA-256 of every one of these files, k 0 to 25,
 * and refuses a file on disk or a download that does not match
 * (`midnight-ledger`, `base-crypto/src/data_provider.rs`, `EXPECTED_DATA`).
 * The table below is that list, copied digit for digit. A file is kept, and
 * handed to a device, only when its digest is the one listed for its name.
 *
 * **THE OLDER `bls_filecoin_2p<k>` FILES ARE NOT ON IT.** They are a different
 * setup - their bytes differ from the Midnight file of the same size - and
 * nothing Midnight publishes says what they should be, so this server neither
 * fetches them nor hands them out.
 */
export const MIDNIGHT_PARAMETER_SHA256: Readonly<Record<string, string>> = Object.freeze({
  bls_midnight_2p0: '59b30b3114a34ccbbfb599376e178fb8d9b3366cae2174c2f1da20e75847f823',
  bls_midnight_2p1: 'bbe04fe3c70d0c138447cb086b4baddc30cb8bb2a004114bc02e6f739516280e',
  bls_midnight_2p2: '80e15568fa1a0117db893239be7fa5e34a6bcc3a8c3bfa7709534b9cb88eb6c1',
  bls_midnight_2p3: '4be827a6472193df80d8f08b4b25a85baef436fdd1965d89b6af89f4ec4e99e2',
  bls_midnight_2p4: '232f401fad10c7ddf8828d2aa4c85c6506c5da09795998cecaeb9f75fc8f6ada',
  bls_midnight_2p5: '0a1c9229f315fc1868ff25f668fb83aec4d09f4f23a706b5197c692c619d72c6',
  bls_midnight_2p6: 'cf2ad6be7d0fedf5bec2aaa35f6be4aca33053d74268fdf5aa54fcb2891ea6df',
  bls_midnight_2p7: 'e82ae890c080188355f37feaffe91372584cd810615082d9143d4dec0453fd9d',
  bls_midnight_2p8: '909b707551eaaea79828e883cde6fc46ab15986c3b1d791bed462c9e2805c933',
  bls_midnight_2p9: 'b9009f1098bcefffec3c461ab3a5e3a17f7e5599f0f08c70fcdc55a89227bcbd',
  bls_midnight_2p10: '46b2290933cbed4c378889e4ba971f1a92888331ffb09466acd4ff61a1e2cb42',
  bls_midnight_2p11: '9901589d7956ff58be0d85569b2f455b77b58c3758026ffb5bbe4807000b96d1',
  bls_midnight_2p12: 'ef08eb3fcf62df8f72c515cffa027e681808b530cb016eea104115545ef6d5c8',
  bls_midnight_2p13: 'd3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803',
  bls_midnight_2p14: 'fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244',
  bls_midnight_2p15: '724c7c3d779148bb113c7ee9c034b2f27db16e6bdf315fde90105a9bad00b1de',
  bls_midnight_2p16: '09c877216d6589b370263e18af40a030a901b41a7a7c37ef58c9901db41f05c6',
  bls_midnight_2p17: '4a9ef6c7c0619aab74eede44b13e753e3ba54508a02dd3b7106a949aabb73b74',
  bls_midnight_2p18: 'e8436dc5d8b598f169c127c745135d889744007e6d384ff126df8d1332522f86',
  bls_midnight_2p19: '8e8dc15c4362f05c912f1e770559a3945db3e58a374def416ed5d3e65ad5b10e',
  bls_midnight_2p20: '1cc62978558fdc1e445cd70cfd9a86ec3c2e2151b6d74811232d37faf9133ff1',
  bls_midnight_2p21: '9cf1644a87f0f027ae5fc6278f91d823a6334ff3e338a29e2f2ef57d071ed64d',
  bls_midnight_2p22: 'e8ad5eed936d657a0fb59d2a55ba19f81a3083bb3554ef88f464f5377e9b2c2f',
  bls_midnight_2p23: '09399d05f9f50875dfdd87dc9903d40c897eaafa9ec8cbb08bace853ecc36c0c',
  bls_midnight_2p24: 'b0e6fa7a4ab4a79a1e6560966f267556409db44bab6d5fab3711ad6c6b623207',
  bls_midnight_2p25: '3289a751c938988cd2f54154d8722d1eda2cd11593064afdde82099b24ff4a58',
});

/** The file name of the public parameters for circuits of size 2^k. */
export const parameterName = (k: number): string => `bls_midnight_2p${k}`;

/** The digest a parameter file must have, or undefined for a name nothing publishes one for. */
export type PublishedDigest = (name: string) => string | undefined;

export const publishedByMidnight: PublishedDigest = (name) =>
  Object.hasOwn(MIDNIGHT_PARAMETER_SHA256, name) ? MIDNIGHT_PARAMETER_SHA256[name] : undefined;

/**
 * Where the files are fetched from, in order. The first is the source
 * Midnight's own ledger fetches from; the second is the store Midnight's wallet
 * fetches its proving files from. Both serve the same bytes, and neither is
 * trusted: whatever arrives is checked against the table above before it is
 * kept. `MIDNIGHT_PARAM_SOURCE` - the variable Midnight's own tools read for
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

/*
 * Reads the size, k, of each compiled circuit it is handed, off the circuit
 * itself, and reports one answer per file: a number, or why it could not.
 *
 * Each circuit is read with the prover package of its own format, the same
 * choice zkirEngineFor makes when it proves: a contract's circuits are in the
 * newer format, the network's own shielded circuits in the older one, and
 * neither package reads the other's.
 *
 * It runs on its own thread because reading a large circuit's size lays the
 * circuit out, which takes seconds of uninterrupted work for each of the
 * largest, and a server doing that on its own thread answers nobody meanwhile.
 */
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const engines = {
  contract: () => import('@midnightntwrk/zkir-v3'),
  network: () => import('@midnightntwrk/zkir-v2'),
};
const sizes = [];
for (const { file, kind } of workerData.files) {
  try {
    const load = Object.hasOwn(engines, kind) ? engines[kind] : undefined;
    if (load === undefined) throw new Error(`a circuit of a format this server does not prove: ${String(kind)}`);
    const zkir = await load();
    sizes.push({ k: Number(zkir.Zkir.deserialize(new Uint8Array(readFileSync(file))).getK()) });
  } catch (e) {
    sizes.push({ why: e instanceof Error ? e.message : String(e) });
  }
}
parentPort.postMessage(sizes);

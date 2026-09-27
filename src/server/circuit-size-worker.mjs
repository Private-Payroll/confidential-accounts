/*
 * Reads the size, k, of each compiled circuit it is handed, off the circuit
 * itself, and reports one answer per file: a number, or why it could not.
 *
 * It runs on its own thread because reading a large circuit's size lays the
 * circuit out, which takes seconds of uninterrupted work for each of the
 * largest, and a server doing that on its own thread answers nobody meanwhile.
 */
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const zkir = await import('@midnight-ntwrk/zkir-v2');
const sizes = workerData.files.map((file) => {
  try {
    return { k: Number(zkir.Zkir.deserialize(new Uint8Array(readFileSync(file))).getK()) };
  } catch (e) {
    return { why: e instanceof Error ? e.message : String(e) };
  }
});
parentPort.postMessage(sizes);

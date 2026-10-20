/**
 * Puts Midnight's public proving parameters in place for the circuits compiled in this checkout, so the real prover
 * runs. Each parameter file is fetched from Midnight's published sources and kept only when it matches the digest
 * Midnight publishes; one already here is kept when it matches. Prints what it found and exits non-zero when any
 * needed file is missing or any compiled vault or account circuit could not be read.
 *
 * Run from the repository root: `npx tsx scripts/fetch-proving-parameters.ts`.
 */
import { ensureProvingParameters, parameterSources } from '../src/server/proving-parameters.js';
import { vaultArtefactPlaces } from '../src/server/vault-artefacts.js';
import { parametersFetched } from './fetch-proving-parameters-rules.js';

try {
  const places = vaultArtefactPlaces(process.cwd(), process.env);
  const verdict = parametersFetched(await ensureProvingParameters({ places, sources: parameterSources(process.env) }));
  for (const line of verdict.lines) console.log(line);
  if (!verdict.ok) process.exitCode = 1;
} catch (e) {
  console.error(`the check of the public parameters stopped part way: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}

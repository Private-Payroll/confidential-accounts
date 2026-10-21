/**
 * THE VERDICT ON A FETCH OF MIDNIGHT'S PUBLIC PROVING PARAMETERS, IN A FILE THAT TOUCHES NO NETWORK.
 *
 * The keys check proves for real only where the public parameters are on disk, and each one is trusted only when it
 * matches the digest Midnight publishes. What was found comes from the server's own `ensureProvingParameters`; this
 * says whether it is enough to prove with and what to print, so the decision is pinned without a download.
 */
import { servedCircuits, type ParameterOutcome } from '../src/server/proving-parameters.js';

/** The labels of the network's own shielded circuits, as the server's own list writes them. */
const NETWORK_LABELS: readonly string[] = servedCircuits({ compiled: '', account: '', params: '' })
  .filter((c) => c.label.endsWith('(network)'))
  .map((c) => c.label);

/** What the server's own reader says of a compiled circuit whose file is not on this machine. */
const ABSENT = 'its compiled circuit is not here';

/**
 * Whether every compiled vault and account circuit has its public parameters here and genuine, and the lines that say so.
 *
 * Refuses when a parameter file is missing, when a compiled circuit could not be read, and when nothing at all was
 * checked. The network's own shielded circuits are not fetched by this check, so when their files are absent they are
 * said to be left out and do not fail it; one that is present and could not be read still refuses. It trusts the outcome's digest check and does not repeat it.
 */
export function parametersFetched(o: ParameterOutcome): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const left = o.unread.filter((u) => NETWORK_LABELS.some((label) => u === `${label}: ${ABSENT}`));
  const unread = o.unread.filter((u) => !left.includes(u));
  if (o.present.length > 0) lines.push(`already here and checked: ${o.present.join(', ')}`);
  for (const f of o.fetched) lines.push(`fetched ${f.name} (${f.bytes} bytes) from ${f.from}, checked against Midnight's published digest`);
  for (const a of o.setAside) lines.push(`${a.from} was not the published file; it was renamed to ${a.to} and replaced`);
  if (left.length > 0) lines.push(`not fetched here: ${left.join('; ')} (this check does not fetch them)`);
  const problems: string[] = [];
  for (const m of o.missing) problems.push(`${m.name} is missing and could not be fetched: ${m.why}; needed by: ${m.circuits.join(', ')}`);
  for (const u of unread) problems.push(`${u}, so the parameters it needs were not looked for`);
  if (problems.length === 0 && o.present.length + o.fetched.length === 0) {
    problems.push('no circuit was checked, so no public parameters are in place');
  }
  if (problems.length === 0) {
    lines.push('every compiled vault and account circuit has its public parameters here, checked');
    return { ok: true, lines };
  }
  lines.push('THE PUBLIC PARAMETERS ARE NOT ALL IN PLACE:');
  for (const p of problems) lines.push(`  - ${p}.`);
  return { ok: false, lines };
}

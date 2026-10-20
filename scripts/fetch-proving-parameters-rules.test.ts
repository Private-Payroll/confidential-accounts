/**
 * **WHAT THE FETCH OF MIDNIGHT'S PUBLIC PARAMETERS REFUSES, AND THE PLACE IT HAS IN THE KEYS CHECK.**
 *
 * The decision is a pure function over what the fetch found, so it is pinned here without a network.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parametersFetched } from './fetch-proving-parameters-rules.js';
import { parametersNeeded, servedCircuits } from '../src/server/proving-parameters.js';

const ROOT = join(import.meta.dirname, '..');
const none = { present: [], fetched: [], setAside: [], missing: [], unread: [] };
const places = { compiled: '/nowhere/c', account: '/nowhere/a', params: '/nowhere/p' };
const network = servedCircuits(places).filter((c) => c.label.endsWith('(network)')).map((c) => c.label);

describe('the public parameters the keys check proves with', () => {
  /* RED WHEN: a check where every parameter is here and genuine is refused, or says nothing of what it found. */
  it('passes when every circuit has its parameters, and says which were fetched and which were already here', () => {
    const r = parametersFetched({
      ...none,
      present: ['bls_midnight_2p10'],
      fetched: [{ name: 'bls_midnight_2p9', from: 'https://srs.midnight.network', bytes: 98692 }],
    });
    expect(r.ok).toBe(true);
    expect(r.lines.join('\n')).toContain('fetched bls_midnight_2p9 (98692 bytes) from https://srs.midnight.network, checked against Midnight\'s published digest');
    expect(r.lines.join('\n')).toContain('already here and checked: bls_midnight_2p10');
  });

  /* RED WHEN: a parameter file that could not be fetched passes, so the real prover stands down green. */
  it('refuses when a parameter file is missing, naming it, why, and the circuits that need it', () => {
    const r = parametersFetched({ ...none, present: ['bls_midnight_2p10'], missing: [{ name: 'bls_midnight_2p9', circuits: ['depositUnshielded (vault)'], why: 'https://srs.midnight.network answered 404' }] });
    expect(r.ok).toBe(false);
    const said = r.lines.join('\n');
    expect(said).toContain('bls_midnight_2p9 is missing and could not be fetched: https://srs.midnight.network answered 404');
    expect(said).toContain('needed by: depositUnshielded (vault)');
  });

  /* RED WHEN: a vault or account circuit whose compiled file is unread passes, so its parameters were never looked for. */
  it('refuses when a compiled vault or account circuit could not be read', () => {
    const r = parametersFetched({ ...none, unread: ['depositUnshielded (vault): its compiled circuit is not here'] });
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toContain('depositUnshielded (vault): its compiled circuit is not here');
  });

  /* RED WHEN: the network's own shielded circuits, which this check cannot have, fail it - or are not said to be left out. */
  it('does not fail on the network\'s own shielded circuits when their files are absent, and says so', async () => {
    expect(network.length).toBeGreaterThan(0);
    /* The reader's own words for absent files, so a reworded reason is caught here. */
    const absent = (await parametersNeeded(servedCircuits(places).filter((c) => network.includes(c.label)))).unread;
    expect(absent).toHaveLength(network.length);
    const r = parametersFetched({ ...none, present: ['bls_midnight_2p9'], unread: absent });
    expect(r.ok).toBe(true);
    expect(r.lines.join('\n')).toMatch(/not fetched here: shielded output \(network\)/);
  });

  /* RED WHEN: unread network circuits hide an unread vault circuit that sits beside them. */
  it('still refuses a vault circuit that is unread beside the network\'s', () => {
    const r = parametersFetched({ ...none, present: ['bls_midnight_2p9'], unread: [...network.map((l) => `${l}: its compiled circuit is not here`), 'deposit (vault): its compiled circuit is not here'] });
    expect(r.ok).toBe(false);
  });

  /* RED WHEN: a network circuit whose file is here but could not be read passes, so a damaged local file is waved through. */
  it('refuses a network shielded circuit whose file is present but could not be read', () => {
    const r = parametersFetched({ ...none, present: ['bls_midnight_2p9'], unread: [`${network[0]}: the file is damaged`] });
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toContain(`${network[0]}: the file is damaged`);
  });

  /* RED WHEN: a check that read no circuit at all and fetched nothing passes. */
  it('refuses an outcome in which nothing was checked, fetched or missing', () => {
    expect(parametersFetched(none).ok).toBe(false);
  });
});

describe('the fetch is part of the keys check, ahead of the tests that need it', () => {
  const code = (file: string) => readFileSync(join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /* RED WHEN: the script stops checking what it fetched, or exits clean on a refusal, so CI stands the real prover down green. */
  it('the script fetches into the places the origin serves from and exits non-zero on a refusal', () => {
    const script = code('scripts/fetch-proving-parameters.ts');
    expect(script).toMatch(/vaultArtefactPlaces\(process\.cwd\(\), process\.env\)/);
    expect(script).toMatch(/ensureProvingParameters\(\{ places, sources: parameterSources\(process\.env\) \}\)/);
    expect(script).toMatch(/parametersFetched\(/);
    expect(script).toMatch(/if \(!(\w+)\.ok\) process\.exitCode = 1;/);
    expect(script).toMatch(/catch[\s\S]*process\.exitCode = 1/);
  });

  /* RED WHEN: CI's keys job does not fetch the parameters before its tests, or the step can be skipped or can fail unseen. */
  it('the keys job runs the fetch as a plain step between the vault build and the tests', () => {
    const lines = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8').split('\n');
    const keys = lines.findIndex((l) => /^ {2}keys:/.test(l));
    const end = lines.findIndex((l, i) => i > keys && /^ {2}\S/.test(l));
    const job = lines.slice(keys, end);
    const build = job.findIndex((l) => l.includes('npm run compact:vault -- --full'));
    const fetchAt = job.findIndex((l) => l.includes('npx tsx scripts/fetch-proving-parameters.ts'));
    const tests = job.findIndex((l) => /run: npx vitest run/.test(l));
    expect(build).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(build);
    expect(tests).toBeGreaterThan(fetchAt);
    const first = job.slice(0, fetchAt).map((l, i) => (/^ {6}- /.test(l) ? i : -1)).filter((i) => i >= 0).pop()!;
    const step = job.slice(first, fetchAt + 1).join('\n');
    expect(step).not.toMatch(/\bif:|continue-on-error/);
    expect(job[first]).toMatch(/^ {6}- name: \S/);
    /* RED WHEN: a hung source stops the job on its own timeout, with no step named. */
    expect(step).toMatch(/^ {8}timeout-minutes: 10$/m);
    expect(job[fetchAt]).toMatch(/^ {8}run: npx tsx scripts\/fetch-proving-parameters\.ts$/);
  });
});

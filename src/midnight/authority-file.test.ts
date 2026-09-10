/**
 * **A DEPLOYMENT MUST NEVER CHOOSE ITS OWN MAINTENANCE AUTHORITY, AND THESE
 * CASES ARE ABOUT THE WAYS IT COULD END UP DOING SO WITHOUT ANYBODY DECIDING.**
 *
 * Whoever holds that authority can change which proofs the deployed contract
 * accepts - alone, outside the company's own approval threshold - and if the
 * key is lost the contract can never be maintained again. The SDK's own deploy
 * call samples a fresh random key when it is given none, which is how every
 * account this project deployed before the refusal existed acquired exactly
 * that.
 *
 * So the interesting cases here are the ones where a value APPEARS. A refusal
 * is the correct outcome and a plausible default is the failure.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { authorityFileIn, loadMaintenanceAuthority, noAuthorityRecorded } from './authority-file.js';

/**
 * A deployment root OUTSIDE this repository.
 *
 * Nothing here writes into the tree, ever: a case that edits a tracked file
 * puts every other file asserting the tree is clean inside its window, and this
 * project has already dismissed two real defects as flakiness.
 */
const deploymentRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'authority-'));
  mkdirSync(join(root, '.midnight'), { recursive: true });
  return root;
};

const write = (root: string, body: string) => {
  writeFileSync(authorityFileIn(root), body);
};

describe('where the recorded choice lives', () => {
  it('is under the deployment\'s own state directory and not a fixed path', () => {
    /*
     * RED WHEN: the path is written as an absolute constant, which would make
     * every deployment on a machine read one deployment's governance record.
     */
    expect(authorityFileIn('/one')).toBe(`${sep}one${sep}.midnight${sep}maintenance-authority.json`);
    expect(authorityFileIn('/two')).not.toBe(authorityFileIn('/one'));
  });
});

describe('nothing recorded', () => {
  it('refuses, and never answers with a choice', () => {
    /*
     * **THE ONE CASE THAT MATTERS.** Any answer at all here is a deployment
     * choosing its own governance.
     *
     * RED WHEN: the `existsSync` guard is removed, or the throw becomes a
     * returned default of any kind.
     */
    const root = deploymentRoot();
    try {
      expect(() => loadMaintenanceAuthority(root)).toThrow(/no maintenance authority/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('says what the decision costs rather than naming a command to type', () => {
    /*
     * Whoever meets this may be reading a deploy, a log or a check, and none of
     * those is the machine the file would be written on.
     *
     * RED WHEN: the sentence is replaced by one naming a door, a script or a
     * path as the thing to run.
     */
    const said = noAuthorityRecorded('somewhere');
    expect(said).toMatch(/never\s+sampled/i);
    expect(said).toMatch(/outside the company/i);
    expect(said, 'the refusal tells a reader to run something')
      .not.toMatch(/\.command|npx |npm run|tsx /);
  });
});

describe('something recorded', () => {
  it('answers with the committee that was written down, unchanged', () => {
    // RED WHEN: the parsed value is replaced, defaulted or normalised on its
    // way out. What is deployed must be what a person recorded.
    const root = deploymentRoot();
    try {
      write(root, JSON.stringify({
        kind: 'committee',
        committee: [{ tag: 'schnorr', value: 'aa' }, { tag: 'schnorr', value: 'bb' }],
        threshold: 2,
      }));
      expect(loadMaintenanceAuthority(root)).toEqual({
        kind: 'committee',
        committee: [{ tag: 'schnorr', value: 'aa' }, { tag: 'schnorr', value: 'bb' }],
        threshold: 2,
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a committee that lists one holder twice', () => {
    /*
     * Not this file's rule and deliberately not re-stated here: it belongs to
     * the layer that deploys, and this case exists to show that the validation
     * is REACHED rather than to describe it. One holder signs once and attaches
     * that signature at every seat holding their key, so a repeated key is not
     * the M-of-N it appears to be.
     *
     * RED WHEN: `requireMaintenanceAuthority` stops being called and the parsed
     * value is returned raw.
     */
    const root = deploymentRoot();
    try {
      write(root, JSON.stringify({
        kind: 'committee',
        committee: [{ tag: 'schnorr', value: 'aa' }, { tag: 'schnorr', value: 'aa' }],
        threshold: 2,
      }));
      expect(() => loadMaintenanceAuthority(root)).toThrow(/more than once/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a single key held without saying what replaces it', () => {
    // Same reason as above: the rule is the deploy layer's, and this shows it
    // runs. A single key is accepted only as a RECORDED temporary state.
    const root = deploymentRoot();
    try {
      write(root, JSON.stringify({ kind: 'single-key', signingKey: { tag: 'schnorr', value: 'aa' } }));
      expect(() => loadMaintenanceAuthority(root)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a record it cannot read, and does not repair it', () => {
    /*
     * **A DEPLOYMENT THAT MENDED ITS OWN GOVERNANCE RECORD WOULD BE CHOOSING
     * THE AUTHORITY IT WAS REFUSING TO CHOOSE.**
     *
     * RED WHEN: the `JSON.parse` is wrapped in something that falls back to a
     * value instead of throwing.
     */
    const root = deploymentRoot();
    try {
      write(root, 'this is not json');
      expect(() => loadMaintenanceAuthority(root)).toThrow(/not readable as JSON/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('and the two refusals are different sentences, because they send a reader elsewhere', () => {
    /*
     * An absent record is a decision nobody has taken. A malformed one is a
     * decision somebody took badly. Collapsing them sends half the readers to
     * the wrong place.
     *
     * RED WHEN: both paths throw the same message.
     */
    const empty = deploymentRoot();
    const broken = deploymentRoot();
    try {
      write(broken, '{');
      let a = ''; let b = '';
      try { loadMaintenanceAuthority(empty); } catch (e: any) { a = e.message; }
      try { loadMaintenanceAuthority(broken); } catch (e: any) { b = e.message; }
      expect(a).not.toBe('');
      expect(b).not.toBe('');
      expect(a).not.toBe(b);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

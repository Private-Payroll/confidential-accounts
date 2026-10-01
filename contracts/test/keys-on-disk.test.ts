import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNT_KEYS, VAULT_KEYS, keysOnDisk, type ContractKeys } from './keys-on-disk.js';

/*
 * THE GATE EVERY KEY-GATED TEST STANDS BEHIND, ASKED OF KEYS WRITTEN HERE, in
 * a folder of this test's own outside the repository. The repository's keys
 * are only ever copied from, never touched.
 */
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const aFolder = (): string => mkdtempSync(join(tmpdir(), 'keys-on-disk-'));

/** A contract of two circuits whose keys are written here, each pinned as its own sha256. */
const twoCircuits = (): ContractKeys & { readonly dir: string } => {
  const dir = aFolder();
  const pinned: Record<string, string> = {};
  for (const c of ['first', 'second']) {
    const bytes = Buffer.from(`the verifier key of ${c}`);
    writeFileSync(join(dir, `${c}.verifier`), bytes);
    pinned[c] = sha(bytes);
  }
  return { name: 'a contract', dir, circuits: ['first', 'second'], expectedVk: pinned, module: 'its compiled module' };
};

describe('whether the keys on disk are the keys this build compiled', () => {
  it('passes when every circuit has its key and each is the one pinned', () => {
    const c = twoCircuits();
    /* RED WHEN keys that are all there and all current are refused, which stands every gated test down. */
    expect(keysOnDisk([c])).toMatchObject({ ok: true, anyOnDisk: true, problems: [] });
    rmSync(c.dir, { recursive: true });
  });

  it('REFUSES a missing key, naming the file', () => {
    const c = twoCircuits();
    rmSync(join(c.dir, 'second.verifier'));
    const answer = keysOnDisk([c]);
    /* RED WHEN a gate looks for one file only, so a partial set of keys passes it. */
    expect(answer.ok).toBe(false);
    expect(answer.problems).toEqual([`${join(c.dir, 'second.verifier')} is missing`]);
    expect(answer.why).toContain(`${join(c.dir, 'second.verifier')} is missing`);
    rmSync(c.dir, { recursive: true });
  });

  it('REFUSES a stale key, one whose sha256 is not what the compiled module pins, naming the file', () => {
    const c = twoCircuits();
    writeFileSync(join(c.dir, 'first.verifier'), Buffer.from('a key an earlier compile made'));
    const answer = keysOnDisk([c]);
    /* RED WHEN a key is taken because it exists, so keys from an earlier compile pass and fail inside a proof. */
    expect(answer.ok).toBe(false);
    expect(answer.problems).toEqual([`${join(c.dir, 'first.verifier')} is stale: its sha256 is not the key its compiled module pins for first`]);
    rmSync(c.dir, { recursive: true });
  });

  it('REFUSES a key the compiled module pins nothing for, and a module that pins nothing at all', () => {
    const c = twoCircuits();
    /* RED WHEN a key with nothing to compare it against is taken as current. */
    expect(keysOnDisk([{ ...c, expectedVk: { first: c.expectedVk.first! } }]).problems)
      .toEqual([`${join(c.dir, 'second.verifier')} has no key pinned for it in its compiled module`]);
    /* RED WHEN a module compiled without keys is taken as agreeing with any keys on disk. */
    expect(keysOnDisk([{ ...c, expectedVk: {} }]).problems[0]).toBe('its compiled module pins no verifier key for a contract, so no key on disk can be checked against it');
    rmSync(c.dir, { recursive: true });
  });

  it('tells a build with no keys at all from one with stale or partial keys', () => {
    const empty = twoCircuits();
    for (const f of readdirSync(empty.dir)) rmSync(join(empty.dir, f));
    /* RED WHEN no keys at all reads as keys on disk. */
    expect(keysOnDisk([empty])).toMatchObject({ ok: false, anyOnDisk: false });
    const partial = twoCircuits();
    rmSync(join(partial.dir, 'first.verifier'));
    expect(keysOnDisk([partial])).toMatchObject({ ok: false, anyOnDisk: true });
    rmSync(empty.dir, { recursive: true });
    rmSync(partial.dir, { recursive: true });
  });

  it('asks every circuit the account deploys and every circuit of the vault', () => {
    /* RED WHEN either contract's gate leaves a circuit out, so a build missing that circuit's key passes. */
    expect([...ACCOUNT_KEYS.circuits].sort()).toEqual(Object.keys(ACCOUNT_KEYS.expectedVk).sort());
    expect([...VAULT_KEYS.circuits].sort()).toEqual(Object.keys(VAULT_KEYS.expectedVk).sort());
  });
});

/* The repository's own keys, copied into a folder of this test's own: never the repository's files themselves. */
const BUILT = [ACCOUNT_KEYS, VAULT_KEYS].every((c) => existsSync(c.dir) && readdirSync(c.dir).some((f) => f.endsWith('.verifier')));
if (!BUILT) console.log('  NOT CHECKED HERE: no verifier keys are on disk to copy, so the gate was not asked of this build\'s own keys. `npm run compact` then `npm run compact:vault -- --full` build them.');

describe.skipIf(!BUILT)('the gate, asked of a copy of this build\'s own keys [needs verifier keys in contracts/managed*/keys; `npm run compact` then `npm run compact:vault -- --full` build them]', () => {
  const copied = (c: ContractKeys): ContractKeys => {
    const dir = aFolder();
    for (const f of readdirSync(c.dir)) if (f.endsWith('.verifier')) copyFileSync(join(c.dir, f), join(dir, f));
    return { ...c, dir };
  };

  it('passes on the copy as on the original, and refuses the copy once one of its keys is changed', () => {
    const account = copied(ACCOUNT_KEYS);
    const vault = copied(VAULT_KEYS);
    expect(keysOnDisk([account, vault])).toEqual(keysOnDisk());
    writeFileSync(join(vault.dir, 'payout.verifier'), Buffer.from('a key an earlier compile made'));
    /* RED WHEN a stale vault key passes the gate. */
    expect(keysOnDisk([account, vault]).problems).toContain(`${join(vault.dir, 'payout.verifier')} is stale: its sha256 is not the key ${VAULT_KEYS.module} pins for payout`);
    rmSync(join(account.dir, 'recordPaymentFromVault.verifier'));
    /* RED WHEN a missing account key passes the gate. */
    expect(keysOnDisk([account, vault]).problems).toContain(`${join(account.dir, 'recordPaymentFromVault.verifier')} is missing`);
    rmSync(account.dir, { recursive: true });
    rmSync(vault.dir, { recursive: true });
  });
});

/*
 * **WHERE THE CHECKS HAVE BUILT THE KEYS, THE GATE MUST OPEN.** Every key-gated
 * test stands down, and passes, when the keys on disk are missing or stale, so a
 * job that built them wrongly would pass with nothing proved. The job that
 * builds them sets KEYS_MUST_BE_BUILT, and there a gate that would stand the
 * gated tests down is a failure naming what is missing or stale.
 */
const KEYS_MUST_BE_BUILT = (process.env.KEYS_MUST_BE_BUILT ?? '') !== '';
if (!KEYS_MUST_BE_BUILT) console.log('  NOT CHECKED HERE: KEYS_MUST_BE_BUILT is not set, so a gate that stands the key-gated tests down is not a failure here. The job that builds the keys sets it.');

describe.skipIf(!KEYS_MUST_BE_BUILT)('where the checks built the keys, every key-gated test runs [needs KEYS_MUST_BE_BUILT, which the job that runs `npm run compact` then `npm run compact:vault -- --full` sets]', () => {
  it('the keys on disk are every circuit\'s, each the one this build compiled', () => {
    const keys = keysOnDisk();
    /* RED WHEN a key the job built is missing or stale, which would stand every gated page test down green. */
    expect(keys.ok, keys.why).toBe(true);
  });
});

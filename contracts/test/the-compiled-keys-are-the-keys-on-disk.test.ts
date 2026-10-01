import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNT_KEYS, VAULT_KEYS, moduleAgainstKeys, verifiersIn, type ContractKeys } from './keys-on-disk.js';

/*
 * EACH COMPILED MODULE PINS ITS VERIFIER KEYS (`expectedVk`), AND THE KEYS ON
 * DISK ARE THOSE KEYS: the sha256 of every `keys/*.verifier` is the value its
 * module pins, for the account and for the vault, and no module pins nothing
 * while keys sit beside it. It stands down, saying so, only when a contract
 * has no keys on disk at all.
 */
for (const c of [ACCOUNT_KEYS, VAULT_KEYS]) {
  const onDisk = verifiersIn(c.dir).length > 0;
  if (!onDisk) {
    console.log(`  NOT CHECKED HERE: no verifier keys are on disk for ${c.name}, so ${c.module} was not pinned against them. \`npm run compact\` then \`npm run compact:vault -- --full\` build them.`);
  }
  describe.skipIf(!onDisk)('A COMPILED MODULE AGAINST THE KEYS ON DISK, the account\'s then the vault\'s [needs verifier keys in its keys folder; `npm run compact` then `npm run compact:vault -- --full` build them]', () => {
    it(`${c.name}: pins a key for every circuit, and every key on disk is the one it pins`, () => {
      /* RED WHEN a module pins nothing, or pins keys other than the ones on disk, or a key it pins is not there. */
      expect(Object.keys(c.expectedVk).length).toBeGreaterThan(0);
      expect(moduleAgainstKeys(c)).toEqual([]);
    });
  });
}

describe('the comparison itself, asked of keys written here', () => {
  const sha = (s: string): string => createHash('sha256').update(Buffer.from(s)).digest('hex');
  const withKeys = (pinned: Record<string, string>): ContractKeys => {
    const dir = mkdtempSync(join(tmpdir(), 'compiled-keys-'));
    writeFileSync(join(dir, 'first.verifier'), Buffer.from('key one'));
    writeFileSync(join(dir, 'second.verifier'), Buffer.from('key two'));
    return { name: 'a contract', dir, circuits: ['first', 'second'], expectedVk: pinned, module: 'its module' };
  };

  it('REFUSES a module whose expectedVk is empty while keys are on disk', () => {
    const c = withKeys({});
    /* RED WHEN a module compiled without keys is taken as agreeing with the keys beside it. */
    expect(moduleAgainstKeys(c)).toEqual([`its module pins no verifier key while 2 are on disk in ${c.dir}`]);
    rmSync(c.dir, { recursive: true });
  });

  it('names a key it pins otherwise, a key it does not pin, and a key it pins that is not there', () => {
    const c = withKeys({ first: sha('key one') });
    /* RED WHEN a key on disk the module does not pin is passed over. */
    expect(moduleAgainstKeys(c)).toEqual([`${join(c.dir, 'second.verifier')} is on disk and its module pins no key for it`]);
    /* RED WHEN a key whose sha256 differs is taken. */
    expect(moduleAgainstKeys({ ...c, expectedVk: { first: sha('key one'), second: sha('another') } }))
      .toEqual([`${join(c.dir, 'second.verifier')} is not the key its module pins for second`]);
    /* RED WHEN a pinned key that is not on disk is passed over. */
    expect(moduleAgainstKeys({ ...c, expectedVk: { first: sha('key one'), second: sha('key two'), third: sha('x') } }))
      .toEqual([`its module pins a key for third and ${join(c.dir, 'third.verifier')} is not on disk`]);
    expect(moduleAgainstKeys({ ...c, expectedVk: { first: sha('key one'), second: sha('key two') } })).toEqual([]);
    rmSync(c.dir, { recursive: true });
  });

  it('stands down for a contract with no keys on disk at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compiled-keys-'));
    /* RED WHEN a build without keys is reported as disagreeing with its module. */
    expect(moduleAgainstKeys({ name: 'x', dir, circuits: ['first'], expectedVk: { first: sha('k') }, module: 'its module' })).toEqual([]);
    rmSync(dir, { recursive: true });
  });
});

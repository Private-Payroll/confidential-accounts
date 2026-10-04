import { describe, expect, it } from 'vitest';
import * as account from '../../../../contracts/managed/contract/index.js';
import { CREATION_STEPS } from '../../../../src/midnight/deferral.js';
import { builtAccountKeys } from './this-builds-account-keys.js';
import { keysOnDisk, ACCOUNT_KEYS } from '../../../../contracts/test/keys-on-disk.js';

/* The digests are taken from this build's key files, which only a full compile of the account produces. */
const ON_DISK = keysOnDisk([ACCOUNT_KEYS]).ok;

/*
 * The digests this wallet is built with are the compiler's own: the account's
 * compiled module carries the SHA-256 of every verifier key it made, and the
 * wallet's, taken from the key files at build time, must be the same, circuit
 * for circuit, in the order each step of a creation lists them.
 */
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe.skipIf(!ON_DISK)('THE COMPANY ACCOUNT\'S KEYS THIS WALLET IS BUILT WITH [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  it('ARE THE COMPILER\'S OWN DIGESTS OF THIS BUILD\'S KEYS, STEP BY STEP AND IN ORDER', () => {
    const built = builtAccountKeys();
    if (built.of !== 'built') throw new Error(built.why);
    /* RED WHEN the digests are taken from anything but this build's key files, or a step's list or order drifts. */
    expect([...built.keys.first.keys()]).toEqual([...CREATION_STEPS.first]);
    expect([...built.keys.second.keys()]).toEqual([...CREATION_STEPS.second]);
    for (const [c, d] of [...built.keys.first, ...built.keys.second]) expect(hex(d), c).toBe((account as any).expectedVk[c]);
  });
});

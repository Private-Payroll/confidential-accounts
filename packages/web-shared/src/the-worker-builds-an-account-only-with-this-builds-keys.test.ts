import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import * as account from '../../../contracts/managed/contract/index.js';
import { CREATION_STEPS } from '../../../src/midnight/deferral.js';
import { answerVaultAsk, checkedAccountKeys, type WorkerDeps } from './vault-worker-entry.js';
import { keysOnDisk, ACCOUNT_KEYS } from '../../../contracts/test/keys-on-disk.js';
import type { VaultAsk } from './vault-worker-client.js';

/*
 * The worker builds a company's account, and the insert that finishes it, only
 * with verifying keys whose digests are the ones this build's compiled account
 * carries. Whatever serves the key files, a key that is not this build's is
 * refused by name before anything is built with it.
 */
const KEYS = join(import.meta.dirname, '../../../contracts/managed/keys');
const fileOf = async (c: string): Promise<Uint8Array> => new Uint8Array(readFileSync(join(KEYS, `${c}.verifier`)));
const expected = (account as unknown as { expectedVk: Record<string, string> }).expectedVk;
/* The keys and their digests come from a full compile of the account; the general checks compile without them. */
const ON_DISK = keysOnDisk([ACCOUNT_KEYS]).ok;

describe.skipIf(!ON_DISK)('THE KEYS THE WORKER BUILDS A COMPANY\'S ACCOUNT WITH [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  it('ARE THIS BUILD\'S OWN, HANDED BACK IN THE ORDER THEY WERE ASKED FOR', async () => {
    const keys = checkedAccountKeys(fileOf, expected, sha256);
    const got = await keys.getVerifierKeys([...CREATION_STEPS.second]);
    /* RED WHEN: the keys come back in another order than asked, or as other bytes than the files served. */
    expect(got.map(([c]) => c)).toEqual([...CREATION_STEPS.second]);
    for (const [c, k] of got) expect(k, c).toEqual(await fileOf(c));
  });

  it('REFUSE A SERVED KEY THAT IS NOT THIS BUILD\'S, BY ITS CIRCUIT', async () => {
    const swapped = async (c: string) => (c === CREATION_STEPS.second[0] ? fileOf(CREATION_STEPS.second[1]) : fileOf(c));
    const keys = checkedAccountKeys(swapped, expected, sha256);
    /* RED WHEN: a key is used without its digest being compared with the build's. */
    await expect(keys.getVerifierKeys([...CREATION_STEPS.second]))
      .rejects.toThrow(`the verifying key served for the company account's ${CREATION_STEPS.second[0]} circuit is not this build's`);
    const flipped = async (c: string) => { const k = await fileOf(c); k[k.length - 1] = (k[k.length - 1] ?? 0) ^ 1; return k; };
    /* RED WHEN: the comparison reads less than the whole key. */
    await expect(checkedAccountKeys(flipped, expected, sha256).getVerifierKey(CREATION_STEPS.first[0]))
      .rejects.toThrow('is not this build\'s');
  });

  it('REFUSE A CIRCUIT THIS BUILD HAS NO KEY FOR, BEFORE ANYTHING IS FETCHED', async () => {
    const fetched: string[] = [];
    const keys = checkedAccountKeys(async (c) => { fetched.push(c); return fileOf(c); }, expected, sha256);
    /* RED WHEN: a circuit missing from the build's digests is fetched and used anyway. */
    await expect(keys.getVerifierKey('notACircuit')).rejects.toThrow('has no circuit called notACircuit in this build');
    expect(fetched).toEqual([]);
  });
});

describe.skipIf(!ON_DISK)('THE WORKER FINISHING A COMPANY [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  it('BUILDS NOTHING WHEN A KEY OF THE SECOND STEP IS NOT THIS BUILD\'S', async () => {
    const wrong = async (c: string) => { const k = await fileOf(c); k[0] = (k[0] ?? 0) ^ 1; return k; };
    const deps = async () => ({ accountKeys: checkedAccountKeys(wrong, expected, sha256) }) as unknown as WorkerDeps;
    const ask = { id: 7, network: 'undeployed', ask: 'finished-creation', account: 'ab'.repeat(32), signature: { tag: 'schnorr', value: '00' } };
    /* RED WHEN: the insert is built from keys the worker did not check. */
    await expect(answerVaultAsk(deps, ask as unknown as VaultAsk)).rejects.toThrow('is not this build\'s, so nothing was built');
  });
});

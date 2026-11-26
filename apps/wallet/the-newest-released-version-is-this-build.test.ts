import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { operationsFromContractState, releasedVersionOf } from 'midnight-identity/profile/contract-keys';
import {
  RELEASED_CONTRACTS, RELEASED_VERSIONS, type KeySlot, type SlotDigests,
} from 'midnight-identity/wallet/released-versions';
import { CONTRACT_TABLE } from '../../scripts/contract-sources.mjs';
import { accountKeyDigests } from './this-builds-account-keys.js';

/*
 * The released list is written by hand and the build's keys are compiled, so
 * these hold the list's newest entry equal to the compiled keys of every
 * contract the contract table names, circuit by circuit and slot by slot, and
 * hold the digests the wallet is built with for a company's creation equal to
 * that same entry. A key rebuilt without the list updated turns this red.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const keysOf = (contract: keyof typeof CONTRACT_TABLE) => join(ROOT, CONTRACT_TABLE[contract].compiled, 'keys');
const ON_DISK = RELEASED_CONTRACTS.every((c) => existsSync(keysOf(c)));
const SLOT_OF_HEADER: Record<string, KeySlot> = { 'midnight:verifier-key[v6]:': 'v2', 'midnight:verifier-key[v7]:': 'v3' };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const keyFiles = (contract: keyof typeof CONTRACT_TABLE) => readdirSync(keysOf(contract)).filter((f) => f.endsWith('.verifier')).sort()
  .map((f) => [f.slice(0, -'.verifier'.length), new Uint8Array(readFileSync(join(keysOf(contract), f)))] as const);

/** One contract's compiled keys as the released list writes them: each circuit's digest, under the slot its file's header names. */
const builtDigests = (contract: keyof typeof CONTRACT_TABLE): Record<string, SlotDigests> =>
  Object.fromEntries(keyFiles(contract).map(([circuit, file]) => {
    const slot = SLOT_OF_HEADER[new TextDecoder().decode(file.slice(0, 26))];
    if (slot === undefined) throw new Error(`${contract} ${circuit}'s key file names no slot the ledger has`);
    return [circuit, { [slot]: sha(file) }];
  }));

const NEWEST = RELEASED_VERSIONS[0]!;

describe.skipIf(!ON_DISK)('THE NEWEST RELEASED VERSION IS THIS BUILD [needs every contract\'s compiled keys: `npm run compact`, then `npm run compact:vault -- --full`]', () => {
  it('HOLDS EXACTLY THE COMPILED KEYS OF EVERY CONTRACT THE CONTRACT TABLE NAMES, CIRCUIT BY CIRCUIT AND SLOT BY SLOT', () => {
    /* RED WHEN: a contract is added to the table and the released list does not release it. */
    expect([...RELEASED_CONTRACTS].sort()).toEqual(Object.keys(CONTRACT_TABLE).sort());
    /* RED WHEN: a key is rebuilt, a circuit added or removed, and the newest entry is not written again. */
    for (const contract of RELEASED_CONTRACTS) expect(NEWEST.keys[contract], contract).toEqual(builtDigests(contract));
  });

  it('IS WHAT THE WALLET CHECKS A COMPANY\'S CREATION AGAINST: THE DIGESTS IT IS BUILT WITH ARE THE ENTRY\'S', () => {
    const built = accountKeyDigests(ROOT);
    expect(built.missing).toBeNull();
    /* RED WHEN: the wallet's built-in creation digests and the released list's newest account keys part. */
    expect(Object.fromEntries([...built.first, ...built.second].map(([c, d]) => [c, { v3: d }]))).toEqual(NEWEST.keys.account);
  });

  it('A CONTRACT HOLDING EXACTLY THIS BUILD\'S KEYS IS THE NEWEST VERSION, AND ONE MORE KEY IN THE OTHER SLOT MAKES IT NONE', () => {
    const state = new L.ContractState();
    const hidden = new L.ContractState();
    for (const [circuit, file] of keyFiles('registry')) {
      const op = new L.ContractOperation();
      op.verifierKey = file;
      state.setOperation(circuit, op);
      const extra = L.ContractOperation.deserialize(op.serialize());
      extra.verifierKey = Uint8Array.from([...new TextEncoder().encode('midnight:verifier-key[v6]:'), 4 << 2, 1, 2, 3, 4]);
      hidden.setOperation(circuit, extra);
    }
    expect(releasedVersionOf(operationsFromContractState(state, 'a1'), 'registry')).toMatchObject({ released: true, version: NEWEST.version });
    /* RED WHEN: a key put beside this build's, in the slot the ledger's own reading does not show, passes as released. */
    expect(releasedVersionOf(operationsFromContractState(hidden, 'a1'), 'registry').released).toBe(false);
  });
});

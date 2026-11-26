/**
 * THE PRIVATE REGISTRY IS DEPLOYED HELD BY NO ONE, AND ONLY THE REGISTRY IS.
 *
 * The door that deploys it spends a fee and is never run here, so its decisions are pinned through
 * the file it imports them from: the holders it builds, what the assembly of a contract's starting
 * state does with them, and the verdict on the authority read back from the chain. Every account
 * and vault keeps the rule that a contract born held has keys.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { heldStateFromTheStart, type HeldStateDeps } from '../src/midnight/held-from-the-start.js';
import type { AuthorityRead, OnChainAuthority } from '../src/midnight/contract-authority-read.js';
import { authorityShapeOf } from '../src/midnight/contract-authority-read.js';
import {
  NO_OWNER, REGISTRY_CIRCUITS, afterSendingRefusal, registryAuthorityRefusal, registryDeployMissing,
} from './deploy-registry-rules.js';
import { blank } from './contract-sources.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ADDRESS = 'ab'.repeat(32);
const KEY = { tag: 'schnorr', value: 'cd'.repeat(32) };

/** A deploy builder whose constructor made nothing but its state, so the assembly can be read without keys. */
const deps: HeldStateDeps = {
  ledger: L, runtimeState: runtime.ContractState, network: 'undeployed',
  contracts: {
    buildDeploy: async () => ({
      public: { contractAddress: ADDRESS, initialContractState: new runtime.ContractState() },
      private: { unprovenTx: { protocolVersion: 0n, stage: 'Unproven' } as never, transaction: {}, newCoins: [] },
    }),
  },
};
const assembled = (holders: Parameters<typeof heldStateFromTheStart>[1]['holders']) =>
  heldStateFromTheStart(deps, { compiled: null, zkConfig: null, args: [], circuits: [], holders });

const read = (committee: OnChainAuthority['committee'], threshold: number): AuthorityRead => ({
  state: 'read', address: ADDRESS,
  authority: { committee, threshold, counter: 0n, shape: authorityShapeOf(committee, threshold), hasDuplicateMembers: false },
});

describe('the holders the registry is deployed under', () => {
  it('are no keys at threshold exactly one, and cannot be changed', () => {
    /* RED WHEN: the registry's holders carry a key or a threshold other than one, or can be edited after they are made. */
    expect(NO_OWNER).toEqual({ committee: [], threshold: 1 });
    expect(Object.isFrozen(NO_OWNER) && Object.isFrozen(NO_OWNER.committee)).toBe(true);
  });

  it('are assembled into a starting state held by no keys at threshold one, at counter 0', async () => {
    const state = await assembled(NO_OWNER);
    const authority = state.maintenanceAuthority as { committee: unknown[]; threshold: number; counter: bigint };
    /* RED WHEN: the assembly drops the holders' word that no keys is meant, and refuses or builds another authority. */
    expect([authority.committee.length, authority.threshold, authority.counter]).toEqual([0, 1, 0n]);
  });

  it('are the only holders with no keys the assembly builds: a copy made anywhere else is refused', async () => {
    /* RED WHEN: the assembly accepts no keys from any holders that look like the no-owner value, rather than from that value alone. */
    await expect(assembled({ committee: [], threshold: 1, emptyCommitteeIsDeliberate: true } as never))
      .rejects.toThrow(/this maintenance authority will not be built/u);
    await expect(assembled({ ...NO_OWNER } as never)).rejects.toThrow(/this maintenance authority will not be built/u);
    await expect(assembled({ ...NO_OWNER, threshold: 2 } as never)).rejects.toThrow(/this maintenance authority will not be built/u);
  });
});

describe('every other contract born held keeps its keys', () => {
  it('refuses no keys from holders that do not say it is meant, as an account\'s and a vault\'s never do', async () => {
    /* RED WHEN: the assembly treats every empty committee as meant, so an account or a vault could be born held by no one. */
    await expect(assembled({ committee: [], threshold: 1 })).rejects.toThrow(/this maintenance authority will not be built/u);
  });

  it('names the no-owner holders in the code of no product file but where they are made, the registry\'s rules and its door', () => {
    const SKIP = new Set(['node_modules', 'dist', 'lib', 'build', 'public', 'coverage']);
    const product = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((n) => {
      const rel = join(dir, n);
      if (SKIP.has(n) || n.startsWith('.') || n.startsWith('managed') || n.startsWith('probe')) return [];
      if (statSync(join(ROOT, rel)).isDirectory()) return product(rel);
      return /\.(ts|tsx|mjs|cjs|js)$/u.test(n) && !/\.test\.|test-support|\.d\.ts$/u.test(n) ? [rel] : [];
    });
    const files = ['src', 'scripts', 'apps', 'packages', 'contracts'].flatMap(product);
    const code = (f: string) => blank(readFileSync(join(ROOT, f), 'utf8'), false);
    /* RED WHEN: an account's or a vault's deploy passes holders that say no keys is meant, with the key quoted or not. */
    expect(files.filter((f) => /['"]?emptyCommitteeIsDeliberate['"]?\s*:\s*true\b/u.test(code(f)))).toEqual([]);
    /* RED WHEN: anything but the registry's rules and its door reaches the no-owner holders. */
    expect(files.filter((f) => /\bNO_OWNER\b/u.test(code(f))).map((f) => relative('.', f)).sort())
      .toEqual(['scripts/deploy-registry-rules.ts', 'scripts/deploy-registry.ts', 'src/midnight/held-from-the-start.ts']);
  });
});

describe('the authority read back from the chain after the deploy', () => {
  it('is accepted only when it is no keys at threshold one', () => {
    expect(registryAuthorityRefusal(read([], 1))).toBeNull();
    /* RED WHEN: the verdict stops asking that the chain hold no keys. */
    expect(registryAuthorityRefusal(read([KEY], 1))).toMatch(/1 key\(s\) at threshold 1/u);
    /* RED WHEN: the verdict stops asking for threshold one, so no keys at a higher threshold passes. */
    expect(registryAuthorityRefusal(read([], 2))).toMatch(/0 key\(s\) at threshold 2/u);
    /* RED WHEN: a threshold of nothing, which lets anyone change the registry, passes. */
    expect(registryAuthorityRefusal(read([], 0))).toMatch(/at threshold 0/u);
  });

  it('is refused when it could not be read at all', () => {
    /* RED WHEN: a read-back that found nothing, or could not ask, is taken as a pass. */
    expect(registryAuthorityRefusal({ state: 'absent', address: ADDRESS, why: 'not yet indexed' })).toMatch(/could not be read back/u);
    expect(registryAuthorityRefusal({ state: 'unreachable', address: ADDRESS, why: 'no answer' })).toMatch(/could not be read back/u);
  });
});

describe('what the door needs before it spends anything', () => {
  it('names every missing piece, and nothing when all are there', () => {
    expect(registryDeployMissing({ fundedSeed: true, keys: true, proofServer: true })).toBeNull();
    const all = registryDeployMissing({ fundedSeed: false, keys: false, proofServer: false }) ?? '';
    /* RED WHEN: a missing seed, missing keys or a silent proof server is not named before the fee is spent. */
    expect([/funded wallet seed/u, /proving and verifier keys/u, /no proof server/u].map((r) => r.test(all))).toEqual([true, true, true]);
  });
});

describe('the registry the door deploys is the one compiled', () => {
  it('is deployed with every proving circuit of the compiled registry, which is its one write', () => {
    /* RED WHEN: the door's circuit list is typed by hand and no longer the compiled registry's. */
    expect(REGISTRY_CIRCUITS).toEqual(['put']);
  });
});

describe('a failure after the deploy is sent', () => {
  it('names the address it may already be at, and says not to deploy again', () => {
    const said = afterSendingRefusal(ADDRESS, 'the read-back did not answer');
    /* RED WHEN: a failure after sending loses the address, or does not warn that a second run deploys a second registry. */
    expect(said).toContain(ADDRESS);
    expect(said).toMatch(/DO NOT DEPLOY AGAIN/u);
    expect(said).toContain('the read-back did not answer');
  });

  it('is what the door says for every failure once sent, and the address is printed before the deploy is sent', () => {
    const door = blank(readFileSync(join(ROOT, 'scripts/deploy-registry.ts'), 'utf8'), false);
    const printed = door.indexOf('ONCE THIS DEPLOY LANDS: ${address}');
    const sent = door.indexOf('await sendDeploy(live, cfg, unprovenTx)');
    /* RED WHEN: the address is printed only after the read-back, so a failure after sending loses it. */
    expect(printed).toBeGreaterThan(0);
    expect(printed).toBeLessThan(sent);
    /* RED WHEN: a failure after sending is reported without the address and the warning not to deploy again. */
    expect(door.slice(sent)).toMatch(/catch \(e\) \{\s*throw new Error\(afterSendingRefusal\(address,/u);
  });
});

describe('the door deploys only keys built from this code in the default format', () => {
  it('asks the version fingerprint whether the registry\'s keys are current, not only whether they exist', () => {
    const door = blank(readFileSync(join(ROOT, 'scripts/deploy-registry.ts'), 'utf8'), false);
    /* RED WHEN: the door counts key files on disk as enough, so keys from older code or another format are deployed. */
    expect(door).toMatch(/keys: current\(ROOT, CONTRACT_TABLE\.registry\.compiled, '\.keys-version'\) === 0/u);
  });
});

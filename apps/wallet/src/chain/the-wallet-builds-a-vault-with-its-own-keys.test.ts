import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker as ThreadWorker } from 'node:worker_threads';
import * as L from '@midnightntwrk/ledger-v9';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { identityFromWords, newWords } from 'midnight-identity';
import { answerVaultAsk } from '../../../../packages/web-shared/src/vault-worker-entry.js';
import { VAULT_CIRCUITS } from '../../../../src/midnight/vault-contract.js';
import { vaultBuilderDeps } from './vault-builder.js';
import { ACCOUNT_KEYS_FOLDER, makePinnedKeyMaterialProvider, VAULT_KEYS_FOLDER } from './key-material.js';
import { ACCOUNT_CIRCUITS_THE_WALLETS_VAULT_CIRCUITS_CALL, VAULT_CIRCUITS_THE_WALLET_PROVES } from './account-circuits.js';
import { keptProvers, type ProvingWorkerLike } from './proving.js';

/*
 * **THE WALLET BUILDS A VAULT WITH THE KEYS IT HOLDS, AND SERVES ITS PROVER ONLY THE VAULT'S OWN.** The wallet's
 * vault builder makes a vault born held by the company's committee from the verifier keys pinned in the wallet,
 * checked against the vault this build compiled; its deploy installs exactly those keys; and
 * the proving key the wallet serves for setting that vault's first secret is the vault's own, at the vault's own
 * location, and the one it serves for the account's approval that call asks for is the account's own. A real first-secret proof needs a vault adopted and its first-secret run approved on a chain; that runs
 * with the whole create-vault action.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const VAULT_KEYS = join(ROOT, 'contracts', 'managed-vault', 'keys');
const ACCOUNT_KEYS = join(ROOT, 'contracts', 'managed', 'keys');
const WALLET_KEYS = join(ROOT, 'apps', 'wallet', 'public', 'keys');
const NET = 'undeployed';
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const whyNotHere = (): string | null => {
  for (const c of VAULT_CIRCUITS) {
    if (!existsSync(join(VAULT_KEYS, `${c}.verifier`))) return `contracts/managed-vault/keys/${c}.verifier is missing`;
  }
  for (const c of ACCOUNT_CIRCUITS_THE_WALLETS_VAULT_CIRCUITS_CALL) {
    if (!existsSync(join(ACCOUNT_KEYS, `${c}.prover`))) return `contracts/managed/keys/${c}.prover is missing`;
  }
  const manifest = join(WALLET_KEYS, 'manifest.json');
  if (!existsSync(manifest)) return 'the wallet holds no key manifest';
  const pins = (JSON.parse(readFileSync(manifest, 'utf8')) as { artefacts: Record<string, unknown> }).artefacts;
  const wanted = [
    ...VAULT_CIRCUITS.map((c) => `${VAULT_KEYS_FOLDER}/${c}.verifier`),
    ...VAULT_CIRCUITS_THE_WALLET_PROVES.flatMap((c) => ['prover', 'bzkir'].map((k) => `${VAULT_KEYS_FOLDER}/${c}.${k}`)),
    ...ACCOUNT_CIRCUITS_THE_WALLETS_VAULT_CIRCUITS_CALL.flatMap((c) => ['prover', 'verifier', 'bzkir'].map((k) => `${ACCOUNT_KEYS_FOLDER}/${c}.${k}`)),
  ];
  for (const file of wanted) {
    if (pins[file] === undefined || !existsSync(join(WALLET_KEYS, file))) return `the wallet has no pinned ${file}`;
  }
  return null;
};
const WHY_NOT = whyNotHere();
/** Whether the compiled keys this needs are here, in the wallet: what the title names it waits for. */
const KEYS_HERE = WHY_NOT === null;
if (WHY_NOT !== null) console.log(`  NOT CHECKED HERE: the wallet did not build a vault with its own keys, because ${WHY_NOT}`);
/** Set by the job that builds and copies the keys: there, a key missing from the wallet is a failure, never a stand-down. */
const KEYS_MUST_BE_BUILT = (process.env.KEYS_MUST_BE_BUILT ?? '') !== '';

describe.skipIf(!KEYS_MUST_BE_BUILT)('where the checks built the keys, the wallet holds every key creating a vault proves with [needs KEYS_MUST_BE_BUILT, which the job that runs `npm run compact`, `npm run compact:vault -- --full` and `npm run vendor-keys:account` sets]', () => {
  it('no vault key and no account key a vault\'s first secret calls for is missing from the wallet', () => {
    // RED WHEN: the keys the wallet copies leave out one a vault it creates proves with, and the checks below stand down green
    expect(WHY_NOT).toBeNull();
  });
});

class ProverThread implements ProvingWorkerLike {
  private readonly worker: ThreadWorker;
  constructor() {
    const entry = JSON.stringify(new URL('./proving-worker.ts', import.meta.url).href);
    this.worker = new ThreadWorker(`const { parentPort } = require('node:worker_threads');
globalThis.postMessage = (m, t) => parentPort.postMessage(m, t);
globalThis.addEventListener = (type, l) => { if (type === 'message') parentPort.on('message', (data) => l({ data })); };
import('tsx/esm/api').then(({ register }) => { register(); return import(${entry}); });`, { eval: true });
  }
  postMessage(message: unknown, transfer?: Transferable[]): void { this.worker.postMessage(message, transfer as never); }
  addEventListener(type: 'message' | 'error', listener: (e: never) => void): void {
    if (type === 'message') this.worker.on('message', (data) => listener({ data } as never));
    else this.worker.on('error', (e: Error) => listener({ message: e.message } as never));
  }
  terminate(): void { void this.worker.terminate(); }
}

const fetchFrom = (swap: Readonly<Record<string, Uint8Array>> = {}) => (async (url: string) => {
  const file = url.replace(/^\/keys\//u, '');
  if (swap[file] !== undefined) return new Response(new Uint8Array(swap[file]!));
  const at = join(WALLET_KEYS, file);
  return existsSync(at) ? new Response(new Uint8Array(readFileSync(at))) : new Response('none', { status: 404 });
}) as typeof fetch;
const store = () => {
  const kept = new Map<string, Uint8Array>();
  return { get: async (p: string) => kept.get(p)?.slice() ?? null, put: async (p: string, b: Uint8Array) => { kept.set(p, b.slice()); }, remove: async (p: string) => { kept.delete(p); } };
};

describe.skipIf(!KEYS_HERE)('THE WALLET BUILDS A VAULT WITH ITS OWN KEYS [needs the compiled vault keys in contracts/managed-vault/keys, the compiled account keys in contracts/managed/keys, and both in the wallet: `npm run compact`, `npm run compact:vault -- --full`, then `npm run vendor-keys:account`, which runs vendor-keys --account]', () => {
  const committee = committeeKeyFor(identityFromWords(newWords()), 'co_' + '7'.repeat(64) as never);
  const ACCOUNT = 'ab'.repeat(32);
  beforeEach(() => { setNetworkId(NET as never); });

  it('a vault born held by the company is built from the wallet\'s pinned keys, and its deploy installs exactly this build\'s', async () => {
    // RED WHEN: the wallet builds a vault from keys it did not pin, or keys not of this build's vault, so the chain holds another vault's circuits
    const deps = vaultBuilderDeps({ keyMaterial: { fetchFn: fetchFrom(), cache: store() }, provers: keptProvers(() => new ProverThread()) });
    const answer = await answerVaultAsk(deps, {
      id: 1, network: NET, ask: 'born-held-vault', account: ACCOUNT, holders: { committee: [{ tag: committee.tag, value: committee.value }], threshold: 1 },
    } as never) as { ok: boolean; vault?: string; tx?: string; error?: string };
    expect(answer.error ?? null).toBeNull();
    const tx = L.Transaction.deserialize('signature', 'proof', 'pre-binding', Buffer.from(answer.tx!, 'base64'));
    const deploy = [...(tx.intents?.values() ?? [])][0]!.actions.find((a: unknown) => a instanceof L.ContractDeploy) as L.ContractDeploy;
    expect(String(deploy.address).toLowerCase()).toBe(answer.vault);
    for (const c of VAULT_CIRCUITS) {
      expect(sha(deploy.initialState.operation(c)!.verifierKey), c).toBe(sha(new Uint8Array(readFileSync(join(VAULT_KEYS, `${c}.verifier`)))));
    }
    // RED WHEN: the proving key the wallet serves for the vault's first secret is not the vault's own, at the vault's own location
    const vk = new Uint8Array(readFileSync(join(VAULT_KEYS, 'setNonceSecret.verifier')));
    const keys = makePinnedKeyMaterialProvider({
      fetchFn: fetchFrom(), cache: store(), vaultCircuits: VAULT_CIRCUITS_THE_WALLET_PROVES,
      compiledVaultVerifierKeys: (await import('../../../../contracts/managed-vault/contract/index.js') as unknown as { expectedVk: Record<string, string> }).expectedVk,
    });
    const served = await keys.lookupKey(`contract:${answer.vault}/setNonceSecret?vk=${sha(vk)}`);
    expect(sha(served!.proverKey)).toBe(sha(new Uint8Array(readFileSync(join(VAULT_KEYS, 'setNonceSecret.prover')))));
  }, 300_000);

  it('the proving key the wallet serves for the account\'s approval that setting a vault\'s secret asks for is the account\'s own', async () => {
    // RED WHEN: the wallet holds no pinned key for the account call setting a vault's first secret makes, so creating a vault stops there
    const accountVk = (await import('../../../../contracts/managed/contract/index.js') as unknown as { expectedVk: Record<string, string> }).expectedVk;
    const keys = makePinnedKeyMaterialProvider({
      fetchFn: fetchFrom(), cache: store(), vaultCircuits: VAULT_CIRCUITS_THE_WALLET_PROVES, compiledVerifierKeys: accountVk,
    });
    const vk = new Uint8Array(readFileSync(join(ACCOUNT_KEYS, 'approveVaultChange.verifier')));
    const served = await keys.lookupKey(`contract:${ACCOUNT}/approveVaultChange?vk=${sha(vk)}`);
    expect(sha(served!.proverKey)).toBe(sha(new Uint8Array(readFileSync(join(ACCOUNT_KEYS, 'approveVaultChange.prover')))));
  }, 300_000);

  it('the proving key the wallet serves for a private deposit into the vault is the vault\'s own, and a swapped one is refused', async () => {
    // RED WHEN: the wallet proves a private deposit with no pinned key of its own, so the deposit is built anywhere but the wallet
    expect(VAULT_CIRCUITS_THE_WALLET_PROVES).toContain('deposit');
    const compiled = (await import('../../../../contracts/managed-vault/contract/index.js') as unknown as { expectedVk: Record<string, string> }).expectedVk;
    const vk = new Uint8Array(readFileSync(join(VAULT_KEYS, 'deposit.verifier')));
    const VAULT = 'cd'.repeat(32);
    const keys = makePinnedKeyMaterialProvider({ fetchFn: fetchFrom(), cache: store(), vaultCircuits: VAULT_CIRCUITS_THE_WALLET_PROVES, compiledVaultVerifierKeys: compiled });
    const served = await keys.lookupKey(`contract:${VAULT}/deposit?vk=${sha(vk)}`);
    expect(sha(served!.proverKey)).toBe(sha(new Uint8Array(readFileSync(join(VAULT_KEYS, 'deposit.prover')))));
    // RED WHEN: a deposit prover served that the wallet's pins do not vouch for is used to prove
    const swapped = makePinnedKeyMaterialProvider({
      fetchFn: fetchFrom({ [`${VAULT_KEYS_FOLDER}/deposit.prover`]: new Uint8Array([1, 2, 3]) }), cache: store(),
      vaultCircuits: VAULT_CIRCUITS_THE_WALLET_PROVES, compiledVaultVerifierKeys: compiled,
    });
    await expect(swapped.lookupKey(`contract:${VAULT}/deposit?vk=${sha(vk)}`)).rejects.toThrow();
  }, 300_000);

  it('a vault verifier key served that is not the pinned one is refused, and no vault is built', async () => {
    // RED WHEN: a key served to the wallet that its pins do not vouch for is built into a vault
    const deps = vaultBuilderDeps({ keyMaterial: { fetchFn: fetchFrom({ [`${VAULT_KEYS_FOLDER}/deposit.verifier`]: new Uint8Array([1, 2, 3]) }), cache: store() } });
    const said = await answerVaultAsk(deps, {
      id: 2, network: NET, ask: 'born-held-vault', account: ACCOUNT, holders: { committee: [{ tag: committee.tag, value: committee.value }], threshold: 1 },
    } as never).then(() => 'built', (e: unknown) => {
      const chain: string[] = [];
      for (let at: unknown = e; at instanceof Error || (typeof at === 'object' && at !== null); at = (at as { cause?: unknown }).cause) {
        chain.push(String((at as { message?: unknown }).message ?? at));
        if (chain.length > 8) break;
      }
      return chain.join(' / ');
    });
    expect(said).not.toBe('built');
    expect(said).toMatch(/deposit/u);
  }, 300_000);
});

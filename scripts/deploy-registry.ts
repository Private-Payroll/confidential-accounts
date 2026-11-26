/**
 * DEPLOYS THE PRIVATE REGISTRY ON THE CHOSEN NETWORK, HELD BY NO ONE, AND PRINTS ITS ADDRESS.
 *
 * The deploy is built here rather than by Midnight.js's deploy, which gives every contract it deploys
 * a one-key authority: the registry's starting state is assembled by `heldStateFromTheStart` with no
 * keys at threshold one (`NO_OWNER`), wrapped in its own deploy, proved, paid for by the wallet whose
 * seed is on this machine, and sent. The address is printed before the deploy is sent, so it is in
 * the report whatever happens next, and every failure after sending names it. Then the authority is
 * read back from the indexer, and the address is confirmed for the network's record only when the
 * chain holds no keys at threshold one. The rules it follows are in deploy-registry-rules.ts.
 *
 *   MIDNIGHT_NETWORK_ID=<network> npx tsx scripts/deploy-registry.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StaticProofServerContainer } from '@midnight-ntwrk/testkit-js';
import type { UnprovenTx } from '@midnight-ntwrk/midnight-js-types';
import { heldStateFromTheStart } from '../src/midnight/held-from-the-start.js';
import { readContractAuthority } from '../src/midnight/contract-authority-read.js';
import { contractStateAt } from '../src/midnight/contract-state-at.js';
import { publicDataProviderAt, transactionSettingsFor } from '../src/midnight/providers.js';
import { accountModuleFor } from '../src/midnight/contract-modules.js';
import { INTENT_LIFETIME_MS } from '../src/midnight/intent-lifetime.js';
import { theNetwork } from '../src/midnight/network.js';
import { networkRecord } from '../src/core/networks.js';
import { storeDir } from '../src/wiring/deployment.js';
import { contractCallsOf } from '../packages/web-shared/src/contract-call-built.js';
import { CONTRACT_TABLE } from './contract-sources.mjs';
import { bringUpWallet, type LiveWallet } from './wallet-bringup.js';
import { startEnvironment, testEnvironmentFor } from './test-environment.js';
import { current } from './contract-version.mjs';
import {
  NO_OWNER, REGISTRY_CIRCUITS, afterSendingRefusal, registryAuthorityRefusal, registryDeployMissing,
} from './deploy-registry-rules.js';

const ROOT = join(import.meta.dirname, '..');
const NETWORK = theNetwork();
const SEED_FILE = join(storeDir(ROOT, NETWORK), 'wallet.seed');
const COMPILED = join(ROOT, CONTRACT_TABLE.registry.compiled);
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT ?? 6301);
/** How long the indexer is given to show the deployed state before the read-back is called unreachable. */
const READ_BACK_TRIES = 24;
const READ_BACK_PAUSE_MS = 5_000;

const line = (s = '') => console.log(s);
const QUIET = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, silent() {}, level: 'silent', child() { return this; } };

/** True when a proof server answers on this machine's port. */
async function proofServerAnswers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) })).ok;
  } catch {
    return false; // no answer is what this asks about, and the precondition says so
  }
}

/** The unproven deploy of the registry held by no one, sealed as Midnight.js submits it, and its address. */
async function registryDeploy(): Promise<{ address: string; unprovenTx: UnprovenTx }> {
  const [L, runtime, contracts, compactJs, registry, zk, types] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-protocol/v9'),
    import('@midnight-ntwrk/compact-runtime'),
    import('@midnight-ntwrk/midnight-js-contracts'),
    import('@midnight-ntwrk/compact-js'),
    import('../contracts/managed-registry/contract/index.js'),
    import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
    import('@midnight-ntwrk/midnight-js-types'),
  ]);
  const { CompiledContract } = compactJs;
  const compiled = CompiledContract.make(CONTRACT_TABLE.registry.name, registry.Contract).pipe(CompiledContract.withVacantWitnesses);
  const calls = contractCallsOf({
    contracts, types, ledger: L, ContractState: runtime.ContractState, settingsFor: transactionSettingsFor, accountModuleFor,
  });
  const state = await heldStateFromTheStart(
    { ledger: L, runtimeState: runtime.ContractState, contracts: calls, network: NETWORK },
    { compiled, zkConfig: new zk.NodeZkConfigProvider(COMPILED), args: [], circuits: REGISTRY_CIRCUITS, holders: NO_OWNER },
  );
  const deploy = new L.ContractDeploy(state);
  const ttl = new Date(Date.now() + INTENT_LIFETIME_MS);
  const tx = L.Transaction.fromParts(networkRecord(NETWORK).id, undefined, undefined, L.Intent.new(ttl).addDeploy(deploy));
  return { address: String(deploy.address).toLowerCase(), unprovenTx: types.LedgerTransaction.seal('v9', 'Unproven', tx) };
}

/** Proves the deploy on the proof server, has the wallet pay its fee, sends it, and waits until it lands. */
async function sendDeploy(live: LiveWallet, cfg: { proofServer: string; indexer: string; indexerWS: string }, unprovenTx: UnprovenTx) {
  const [{ submitTx }, { SucceedEntirely }, { httpClientProofProvider }, zk] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-contracts'),
    import('@midnight-ntwrk/midnight-js-types'),
    import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
    import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
  ]);
  const publicDataProvider = await publicDataProviderAt({ indexerUrl: cfg.indexer, indexerWsUrl: cfg.indexerWS });
  const zkConfigProvider = new zk.NodeZkConfigProvider(COMPILED);
  const providers = {
    config: transactionSettingsFor(NETWORK), zkConfigProvider,
    proofProvider: httpClientProofProvider({ url: cfg.proofServer, zkConfigProvider }),
    walletProvider: live.wallet, midnightProvider: live.wallet, publicDataProvider,
  };
  const landed = await submitTx(providers, { unprovenTx });
  if (landed.status !== SucceedEntirely) throw new Error(`the chain did not apply the deploy (${String(landed.status)}). Nothing to record.`);
  return publicDataProvider;
}

/** The authority read back at the address, asked again while the indexer has not shown the deploy or did not answer. */
async function authorityReadBack(publicData: Awaited<ReturnType<typeof publicDataProviderAt>>, address: string) {
  let read = await readContractAuthority((a) => contractStateAt(publicData, a), address);
  for (let i = 1; (read.state === 'absent' || read.state === 'unreachable') && i < READ_BACK_TRIES; i += 1) {
    await new Promise((r) => setTimeout(r, READ_BACK_PAUSE_MS));
    read = await readContractAuthority((a) => contractStateAt(publicData, a), address);
  }
  return read;
}

async function main(): Promise<void> {
  line(`  Deploying the private registry on ${NETWORK}, held by no one`);
  const missing = registryDeployMissing({
    fundedSeed: existsSync(SEED_FILE),
    keys: current(ROOT, CONTRACT_TABLE.registry.compiled, '.keys-version') === 0
      && REGISTRY_CIRCUITS.every((c) => ['prover', 'verifier'].every((k) => existsSync(join(COMPILED, 'keys', `${c}.${k}`)))),
    proofServer: await proofServerAnswers(PROVER_PORT),
  });
  if (missing !== null) throw new Error(missing);
  const { env, how } = testEnvironmentFor(NETWORK, QUIET);
  line(`  ${how}`);
  const cfg = await startEnvironment(env, new StaticProofServerContainer(PROVER_PORT), (s) => line(`  ${s}`));
  const live = await bringUpWallet(QUIET, cfg, readFileSync(SEED_FILE, 'utf8').trim(), NETWORK, ROOT,
    { withDust: true, requireDust: true, onNote: (m) => line(`  ${m}`) });
  try {
    const { address, unprovenTx } = await registryDeploy();
    line('  the deploy is built so that no one holds it; proving and sending it');
    line(`  Not yet confirmed, its address ONCE THIS DEPLOY LANDS: ${address}`);
    try {
      const publicData = await sendDeploy(live, cfg, unprovenTx);
      const refusal = registryAuthorityRefusal(await authorityReadBack(publicData, address));
      if (refusal !== null) throw new Error(refusal);
    } catch (e) {
      throw new Error(afterSendingRefusal(address, e instanceof Error ? e.message : String(e)));
    }
    line('  read back from the chain: no keys, threshold one. No one can change its rules.');
    line();
    line(`  THE REGISTRY'S ADDRESS ON ${NETWORK}: ${address}`);
    line('  It goes into this network\'s record as its registry.');
  } finally {
    live.stop();
    await env.shutdown(false).catch(() => undefined); // the deploy's outcome is already printed; a slow shutdown changes nothing
  }
}

main().then(() => process.exit(0), (e: unknown) => {
  line();
  line(`  THE REGISTRY WAS NOT RECORDED. ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

/**
 * Where do the 365 seconds go?
 *
 *   npx tsx scripts/diagnose-state.ts     (or DIAGNOSE.command)
 *
 * `addSigner` blocks the main thread for six minutes. Phase
 * instrumentation ruled out every provider — the proof server, the indexer,
 * the key files, the private state store — so the time is going into the SDK's
 * own synchronous work: reconstructing the ledger from on-chain state and
 * running the circuit over it.
 *
 * This times those pieces one at a time. It needs no proof server, no wallet
 * and no DUST, so it costs seconds rather than a six-minute hang, and it
 * answers a question no amount of staring at the code will.
 *
 * THE HYPOTHESIS IT IS TESTING. The contract holds two HistoricMerkleTrees:
 *
 *     signers   depth 10   1024 leaves
 *     settled   depth 16   65536 leaves
 *
 * Decision 0003 picked depth 10 for `signers` on the explicit grounds that a
 * shallower tree keeps proving cheap. Nobody applied that reasoning to
 * `settled`, which is 64 times larger. If reconstruction materialises it, every
 * call pays for it — which would explain why deployment is fast (no prior
 * state) and every call after it is not.
 *
 * If the numbers say otherwise, that is just as useful. The point is to stop
 * guessing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ledger as readLedger, pureCircuits } from '../contracts/managed/contract/index.js';
import { applyNetworkId, theNetwork, ENDPOINTS } from '../src/midnight/network.js';
import {
  previewSignersFile, readOrCreatePreviewSigners, signerBytes,
} from './preview-signers.js';

const ROOT = process.cwd();
const NETWORK = theNetwork();

const CONTRACT_FILE = join(ROOT, '.midnight', `${NETWORK}-contract.json`);
const STATE_DIR = join(ROOT, '.midnight');
const ACCOUNT_ID = 'default';

/**
 * **SIGNER A IS READ FROM `.midnight/`, NOT COMPUTED.**
 *
 * This script recomputes A's leaf to find it in the tree and rebuilds A's
 * private state to read the store — both of which used to work because A's
 * identity was `seededBytes(1)`/`seededBytes(401)`, a formula published in this
 * repository. It is real entropy in a gitignored per-account file now, written
 * by the deploy, and this reads the same file.
 *
 * A REFUSAL RATHER THAN A FRESH SET: `readOrCreatePreviewSigners` would make
 * one, and a diagnostic that invents a device reports on an account nobody
 * deployed. The door that creates the file is named (rule 19).
 */
const previewSignersPath = previewSignersFile(STATE_DIR, NETWORK, ACCOUNT_ID);
if (!existsSync(previewSignersPath)) {
  throw new Error(
    `there is no demo signer material for "${ACCOUNT_ID}" on ${NETWORK}: ` +
      `${previewSignersPath.replace(ROOT + '/', '')} does not exist.\n` +
      'Run DEPLOY-PREVIEW.command, then run this again.',
  );
}
const PREVIEW_SIGNERS = readOrCreatePreviewSigners(STATE_DIR, NETWORK, ACCOUNT_ID).signers;

const good = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const note = (s: string) => console.log(`  ${s}`);
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

/** Times something synchronous and prints how long it took. */
function time<T>(label: string, fn: () => T): T {
  process.stdout.write(`  ${label.padEnd(46)}`);
  const t = process.hrtime.bigint();
  try {
    const out = fn();
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const colour = ms > 10_000 ? '\x1b[31m' : ms > 1_000 ? '\x1b[33m' : '\x1b[32m';
    console.log(`${colour}${ms.toFixed(1)} ms\x1b[0m`);
    return out;
  } catch (e: any) {
    console.log(`\x1b[31mthrew: ${String(e?.message ?? e).slice(0, 60)}\x1b[0m`);
    throw e;
  }
}

const colourMs = (ms: number) => {
  const c = ms > 10_000 ? '\x1b[31m' : ms > 1_000 ? '\x1b[33m' : '\x1b[32m';
  return `${c}${ms} ms\x1b[0m`;
};

const seededBytes = (seed: number): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i * 7) % 256;
  return out;
};

async function main() {
  console.log('────────────────────────────────────────────────────────────');
  console.log('  Where the time goes: timing the state work directly');
  console.log('────────────────────────────────────────────────────────────');
  console.log();

  if (!existsSync(CONTRACT_FILE)) throw new Error('no deployed contract; run DEPLOY-PREVIEW.command first');
  const { contractAddress } = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8'));
  note(`contract ${String(contractAddress).slice(0, 32)}…`);
  await applyNetworkId(NETWORK);

  const e = ENDPOINTS[NETWORK]!;
  const provider: any = indexerPublicDataProvider(e.indexerUrl, e.indexerWsUrl);

  console.log();
  console.log('\x1b[1m  Fetching\x1b[0m');
  const t0 = Date.now();
  const state = await provider.queryContractState(contractAddress);
  console.log(`  ${'queryContractState (network)'.padEnd(46)}${Date.now() - t0} ms`);
  if (!state) throw new Error('the indexer returned no state for this contract');

  console.log();
  console.log('\x1b[1m  Reconstructing the ledger\x1b[0m');
  const parsed: any = time('readLedger(state.data)', () => readLedger(state.data));

  console.log();
  console.log('\x1b[1m  Reading the public fields\x1b[0m');
  time('threshold / round / approvalCount', () => [parsed.threshold, parsed.round, parsed.approvalCount]);
  time('stateCommitment', () => hex(parsed.stateCommitment));

  console.log();
  console.log('\x1b[1m  The signers tree — depth 10, 1024 leaves\x1b[0m');
  const leafA = pureCircuits.signerLeaf(
    pureCircuits.signerPublicKey(signerBytes(PREVIEW_SIGNERS.A).secretKey),
    signerBytes(PREVIEW_SIGNERS.A).blinding, pureCircuits.allVaults());
  time('signers.root()', () => parsed.signers.root());
  time('signers.firstFree()', () => parsed.signers.firstFree());
  const path = time('signers.findPathForLeaf(signer A)  <-- witness', () => parsed.signers.findPathForLeaf(leafA));
  note(`    signer A ${path ? 'is in the tree' : '\x1b[31mis NOT in the tree\x1b[0m'}`);

  /* ---------------------------------------------------------------- *
   * The path itself. This is where addSigner stops.
   *
   * Witness counting proved the circuit calls localSecretKey, signerBlinding
   * and signerPath — and then blocks forever in WASM, before any fourth call.
   * The next thing the circuit does is merkleTreePathRoot<10> over this object,
   * so the object's shape is the remaining suspect.
   *
   * `witnesses.ts` hands it over as `found as unknown as SignerPath`, which is
   * an assertion, not a check. Every bad bug in this project has hidden behind
   * a cast like that.
   * ---------------------------------------------------------------- */
  console.log();
  console.log('\x1b[1m  The Merkle path — the object the circuit blocks on\x1b[0m');
  if (!path) {
    console.log('  \x1b[31mno path returned, so the witness would throw rather than hang\x1b[0m');
  } else {
    const p: any = path;
    console.log(`  typeof path                      ${typeof p}`);
    console.log(`  constructor                      ${p?.constructor?.name ?? '(none)'}`);
    console.log(`  own keys                         ${Object.keys(p).join(', ') || '(none — likely a WASM object)'}`);
    const proto = Object.getPrototypeOf(p);
    console.log(`  prototype members                ${(proto ? Object.getOwnPropertyNames(proto) : []).filter(k=>k!=='constructor').slice(0,10).join(', ') || '(none)'}`);
    console.log(`  path.leaf present                ${p.leaf !== undefined} ${p.leaf ? `(${p.leaf.constructor?.name}, ${p.leaf.length ?? '?'} bytes)` : ''}`);
    const sibs = p.path;
    console.log(`  path.path present                ${sibs !== undefined}`);
    if (sibs !== undefined) {
      console.log(`  path.path is an array            ${Array.isArray(sibs)}`);
      console.log(`  number of siblings               \x1b[1m${sibs?.length ?? '(no length)'}\x1b[0m   \x1b[2m(the tree is depth 10, so expect 10)\x1b[0m`);
      if (sibs?.length !== 10) {
        console.log(`  \x1b[31m  ^^ this does not match the declared depth. A depth-10 loop over a`);
        console.log(`     path of a different length is exactly how this hangs.\x1b[0m`);
      }
      const first = sibs?.[0];
      if (first) {
        console.log(`  sibling[0] keys                  ${Object.keys(first).join(', ')}`);
        console.log(`  sibling[0].goes_left             ${first.goes_left} (${typeof first.goes_left})`);
        console.log(`  sibling[0].sibling               ${first.sibling ? Object.keys(first.sibling).join(', ') : '(missing)'}`);
        console.log(`  sibling[0].sibling.field type    ${typeof first?.sibling?.field}`);
      }
    }
    console.log();
    console.log('  \x1b[2mWhat the contract declares it wants:\x1b[0m');
    console.log('  \x1b[2m  { leaf: Bytes<32>, path: 10x { sibling: { field }, goes_left: Boolean } }\x1b[0m');
    // Does the leaf the path carries actually equal the leaf we asked for?
    // requireSigner asserts exactly this, and a mismatch is an auth bypass.
    if (p.leaf) {
      const same = hex(p.leaf) === hex(leafA);
      console.log(`  path.leaf === the leaf we asked for   ${same ? '\x1b[32myes\x1b[0m' : '\x1b[31mNO — requireSigner would reject this\x1b[0m'}`);
    }
  }

  console.log();
  console.log('\x1b[1m  The settled tree — depth 16, 65536 leaves\x1b[0m');
  console.log('\x1b[2m  This is the one nobody sized deliberately. Decision 0003 chose depth 10\x1b[0m');
  console.log('\x1b[2m  for signers precisely to keep this cheap; settled is 64x larger.\x1b[0m');
  time('settled.root()', () => parsed.settled.root());
  time('settled.firstFree()', () => parsed.settled.firstFree());
  time('settled.findPathForLeaf(absent leaf)', () => parsed.settled.findPathForLeaf(seededBytes(999)));

  /* ---------------------------------------------------------------- *
   * checkRoot, and the encrypted private state store.
   *
   * These are the last two untimed things on the path between "signerPath
   * returned" and "the thread stopped answering".
   *
   * `checkRoot` walks the HistoricMerkleTree's history and is the line
   * immediately after merkleTreePathRoot. `root()` was fast; this is different
   * work.
   *
   * The private state store is the provider that was never wrapped with the
   * phase timer, so a stall inside it has been reporting as the ambient phase
   * for five runs. It encrypts at rest and derives a key on access,
   * and an expensive key derivation run per access is synchronous CPU work
   * that would look exactly like what we are chasing.
   * ---------------------------------------------------------------- */
  /* ---------------------------------------------------------------- *
   * Save the real state to disk.
   *
   * The same SDK call that stalls here for six minutes finishes in 125ms
   * elsewhere against a locally-built state. So the hang depends on this
   * data, not on the code — which means the data is the thing to keep.
   * With it, the failure can be reproduced and profiled off this machine
   * instead of costing a ten-minute round trip per attempt.
   * ---------------------------------------------------------------- */
  console.log();
  console.log('\x1b[1m  Saving the real state for offline reproduction\x1b[0m');
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(ROOT, '.midnight'), { recursive: true });
    const out = join(ROOT, '.midnight', `${NETWORK}-state.dump`);
    // Serialise via the SDK so it round-trips exactly as the SDK reads it.
    const serialised = (state as any).serialize
      ? (state as any).serialize(NETWORK)
      : (state as any).data?.serialize?.(NETWORK);

    /*
     * The Zswap chain state, which is the last unreproduced input.
     *
     * `midnight-js-contracts` calls `zswapChainState.postBlockUpdate(new Date())`
     * during transaction assembly — a synchronous WASM rehash of the state. With
     * an empty one the whole assembly takes 169ms; against this machine's state
     * it takes over six minutes. This is the difference.
     *
     * It is fetched separately from the contract state, so it has to be dumped
     * separately too.
     */
    try {
      const t = Date.now();
      const tuple: any = await provider.queryZSwapAndContractState(contractAddress);
      console.log(`  ${'queryZSwapAndContractState (network)'.padEnd(46)}${colourMs(Date.now() - t)}`);
      const zswap = tuple?.[0];
      if (zswap) {
        const zBytes = Buffer.from(zswap.serialize(NETWORK));
        writeFileSync(join(ROOT, '.midnight', 'preview-zswap.dump'), zBytes);
        good(`zswap chain state written (${zBytes.length} bytes)`);
        // Time the exact call the SDK makes. This may be the whole six minutes.
        console.log('  \x1b[2m  timing postBlockUpdate — the SDK calls this during assembly\x1b[0m');
        const t2 = Date.now();
        zswap.postBlockUpdate(new Date());
        const took = Date.now() - t2;
        console.log(`  ${'zswapChainState.postBlockUpdate(now)'.padEnd(46)}${colourMs(took)}`);
        if (took > 30_000) {
          console.log('  \x1b[31m  ^^ THIS IS IT. The SDK calls this on every contract call.\x1b[0m');
        }
      }
    } catch (zerr: any) {
      note(`\x1b[33mcould not capture the zswap state: ${String(zerr?.message ?? zerr).slice(0, 80)}\x1b[0m`);
    }
    if (serialised) {
      writeFileSync(out, Buffer.from(serialised));
      good(`state written to ${out.replace(ROOT + '/', '')} (${Buffer.from(serialised).length} bytes)`);
    } else {
      // Fall back to whatever shape it is, as JSON, so something is captured.
      writeFileSync(out + '.json', JSON.stringify(state, (_k, v) =>
        typeof v === 'bigint' ? v.toString() + 'n' : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v, 2));
      note(`no serialize() on the state object; wrote a JSON view instead`);
    }
  } catch (err: any) {
    note(`\x1b[33mcould not save the state: ${String(err?.message ?? err).slice(0, 80)}\x1b[0m`);
  }

  console.log();
  console.log('\x1b[1m  checkRoot — the line right after merkleTreePathRoot\x1b[0m');
  const rootNow = parsed.signers.root();
  time('signers.checkRoot(current root)', () => parsed.signers.checkRoot(rootNow));
  time('signers.history() -> array', () => Array.from(parsed.signers.history() as any));

  console.log();
  console.log('\x1b[1m  The encrypted private state store\x1b[0m');
  console.log('\x1b[2m  The one provider never instrumented, so never ruled out.\x1b[0m');
  try {
    const { levelPrivateStateProvider } = await import('@midnight-ntwrk/midnight-js-level-private-state-provider');
    const password = process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD || 'ConfidentialAccounts-Dev-2026';
    const psp: any = levelPrivateStateProvider({
      accountId: 'diagnose-probe',
      privateStateStoreName: 'diagnose-probe',
      privateStoragePasswordProvider: async () => password,
    } as any);
    psp.setContractAddress?.(contractAddress);
    const sample = {
      ...signerBytes(PREVIEW_SIGNERS.A),
      scope: pureCircuits.allVaults(),
      current: { balance: 0n, entriesDigest: seededBytes(101), salt: seededBytes(201) },
      next: { balance: 250_000n, entriesDigest: seededBytes(102), salt: seededBytes(202) },
      proposalSalt: seededBytes(301), pinnedPath: null,
    };
    const t1 = Date.now();
    await psp.set('diagnose-probe', sample);
    console.log(`  ${'first set (derives the encryption key)'.padEnd(46)}${colourMs(Date.now() - t1)}`);
    const t2 = Date.now();
    await psp.get('diagnose-probe');
    console.log(`  ${'get'.padEnd(46)}${colourMs(Date.now() - t2)}`);
    const t3 = Date.now();
    for (let i = 0; i < 5; i++) await psp.set('diagnose-probe', sample);
    console.log(`  ${'5x set'.padEnd(46)}${colourMs(Date.now() - t3)}`);
    await psp.clear?.();
  } catch (err: any) {
    console.log(`  \x1b[33mcould not probe the store: ${String(err?.message ?? err).slice(0, 70)}\x1b[0m`);
  }

  console.log();
  console.log('\x1b[1m  Doing it all again, to separate first-call cost from steady state\x1b[0m');
  time('readLedger again', () => readLedger(state.data));
  time('signers.findPathForLeaf again', () => parsed.signers.findPathForLeaf(leafA));

  console.log();
  console.log('\x1b[1m  Reading it as the witness does, repeatedly\x1b[0m');
  console.log('\x1b[2m  requireSigner() runs signerPath() once per call, but the circuit is\x1b[0m');
  console.log('\x1b[2m  executed more than once during transaction assembly.\x1b[0m');
  time('10x readLedger + findPathForLeaf', () => {
    for (let i = 0; i < 10; i++) {
      const l: any = readLedger(state.data);
      l.signers.findPathForLeaf(leafA);
    }
  });

  console.log();
  console.log('  \x1b[1mWhat to look for\x1b[0m');
  console.log('  Anything in red is where the six minutes are going. If every line');
  console.log('  is green, the cost is not in state reconstruction and the next');
  console.log('  suspect is the circuit execution itself during assembly.');
  console.log();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.log();
    console.log(`\x1b[31m\x1b[1m  Could not finish: ${e?.message ?? e}\x1b[0m`);
    if (e?.stack) console.log(`\x1b[2m${e.stack.split('\n').slice(1, 6).join('\n')}\x1b[0m`);
    process.exit(1);
  },
);

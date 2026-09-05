/**
 * Makes a new wallet seed and prints the address the faucet needs.
 *
 * No network, no proving, no submission. It writes one file and prints one
 * address — the UNSHIELDED address, which is what the faucet wants and is not
 * the same as the coin public key. Getting that wrong sends funds somewhere
 * that looks plausible and is not us.
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkFromEnv, applyNetworkId } from '../src/midnight/network.js';

const ROOT = process.cwd();
const NETWORK = networkFromEnv(process.env.MIDNIGHT_NETWORK_ID, 'stagenet');
const SEED_FILE = join(ROOT, '.midnight', 'wallet.seed');
const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', O = '\x1b[0m';

async function main() {
  await applyNetworkId(NETWORK);
  // From testkit, not from wallet-sdk-hd. `deploy-preview.ts` imports it from
  // testkit and that is the one that exists; wallet-sdk-hd exports only the HD
  // wallet and mnemonic helpers.
  const { WalletSeeds } = await import('@midnight-ntwrk/testkit-js');

  if (existsSync(SEED_FILE)) {
    console.log(`  ${D}a seed already exists; leaving it alone${O}`);
  } else {
    mkdirSync(join(ROOT, '.midnight'), { recursive: true });
    const seed = (WalletSeeds as any).generateRandom().masterSeed;
    writeFileSync(SEED_FILE, seed, { mode: 0o600 });
    console.log(`  ${G}✓${O} new wallet seed written to .midnight/wallet.seed`);
  }

  /*
   * Derived without starting a wallet, exactly as deploy-preview.ts does it.
   *
   * It is the UNSHIELDED address, NOT the coin public key — the faucet silently
   * does nothing with the latter. And the network id goes into the address, so
   * a wrong one does not throw, it yields `mn_addr_undefined1...` — an address
   * nobody can fund, which is worse than an error because it gets used.
   */
  const seed = readFileSync(SEED_FILE, 'utf8').trim();
  const { WalletSeeds: WS } = await import('@midnight-ntwrk/testkit-js');
  const { createKeystore } = await import('@midnightntwrk/wallet-sdk');
  const seeds = (WS as any).fromMasterSeed(seed);
  const ks: any = await (createKeystore as any)(
    { kind: 'schnorr', secret: seeds.unshielded }, NETWORK);
  const addr = String(ks.getBech32Address().asString());

  if (addr.includes('undefined')) {
    throw new Error(`the network id did not reach the address: ${addr}`);
  }
  console.log(`\n  ${B}${addr}${O}\n`);
  console.log(`  ${D}unshielded address on ${NETWORK} — this is what the faucet wants${O}`);
}

main().then(() => process.exit(0)).catch((e: any) => {
  console.error(`stopped: ${String(e?.message ?? e)}`);
  process.exit(1);
});

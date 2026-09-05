/**
 * WHAT DOES THE CHAIN SAY THIS WALLET HOLDS — not what the wallet says.
 *
 * Read-only. No proving, no submission, no wallet started.
 *
 * Every balance quoted so far came from the WALLET, which computes DUST as a
 * projection and reports NIGHT from its own synced view. Neither is the chain
 * speaking. This asks the indexer directly, by address, and prints what comes
 * back verbatim — including when the answer is an error, because a schema
 * mismatch is information too.
 *
 * It checks the wallet used on 15 August, whose seed was set aside rather than
 * deleted, and the new one if it exists.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { networkFromEnv, applyNetworkId } from '../src/midnight/network.js';

const ROOT = process.cwd();
const NETWORK = networkFromEnv(process.env.MIDNIGHT_NETWORK_ID, 'stagenet');
const IDX = process.env.MIDNIGHT_INDEXER_URL || 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', O = '\x1b[0m';

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  try {
    const res = await fetch(IDX, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 400), _status: res.status }; }
  } catch (e: any) {
    return { _error: String(e?.message ?? e) };
  }
}

async function addressFor(seedFile: string): Promise<string> {
  const seed = readFileSync(seedFile, 'utf8').trim();
  const { WalletSeeds } = await import('@midnight-ntwrk/testkit-js');
  const { createKeystore } = await import('@midnightntwrk/wallet-sdk');
  const seeds = (WalletSeeds as any).fromMasterSeed(seed);
  const ks: any = await (createKeystore as any)({ kind: 'schnorr', secret: seeds.unshielded }, NETWORK);
  return String(ks.getBech32Address().asString());
}

async function main() {
  await applyNetworkId(NETWORK);
  console.log(`\n${B}What the CHAIN says, not what the wallet says${O}`);
  console.log(`${D}indexer ${IDX}${O}\n`);

  /* ---------- which queries does this indexer actually have ---------- */
  console.log(`${B}The indexer's own query list${O}`);
  const schema = await gql('query { __schema { queryType { fields { name args { name } } } } }');
  const fields = schema?.data?.__schema?.queryType?.fields ?? [];
  if (fields.length) {
    for (const f of fields) {
      console.log(`    ${f.name}(${(f.args ?? []).map((a: any) => a.name).join(', ')})`);
    }
  } else {
    console.log(`    ${Y}introspection did not answer:${O} ${JSON.stringify(schema).slice(0, 300)}`);
  }
  console.log('');

  /* ---------- the wallets ---------- */
  const wallets: [string, string][] = [];
  const old = readdirSync(join(ROOT, '_to_delete'))
    .filter(f => f.startsWith('wallet.seed.') && !f.includes('in-use'))
    .sort()
    .pop();
  /*
   * Only if it is a DIFFERENT seed from the one in use. The 15 August wallet was
   * restored into place on 16 August, so listing the set-aside copy as well
   * reports one wallet twice under two names — which is exactly the sort of
   * thing that makes a report untrustworthy.
   */
  if (old) {
    const inUse = join(ROOT, '.midnight', 'wallet.seed');
    const same = existsSync(inUse)
      && readFileSync(inUse, 'utf8').trim() === readFileSync(join(ROOT, '_to_delete', old), 'utf8').trim();
    if (!same) wallets.push(['a set-aside wallet', join(ROOT, '_to_delete', old)]);
  }
  if (existsSync(join(ROOT, '.midnight', 'wallet.seed'))) {
    wallets.push(['the wallet in use', join(ROOT, '.midnight', 'wallet.seed')]);
  }

  for (const [label, file] of wallets) {
    console.log(`${B}${label}${O}   ${D}${file.replace(ROOT + '/', '')}${O}`);
    let addr: string;
    try {
      addr = await addressFor(file);
      console.log(`  address  ${B}${addr}${O}`);
    } catch (e: any) {
      console.log(`  ${R}could not derive the address: ${String(e?.message ?? e).slice(0, 120)}${O}\n`);
      continue;
    }

    // Several shapes, because the schema is not documented and guessing one and
    // reporting "no balance" would be worse than useless.
    const tries: [string, string, Record<string, unknown>][] = [
      ['unshieldedUtxos', 'query($a:UnshieldedAddress!){ unshieldedUtxos(address:$a){ value tokenType createdAtTransaction { hash } } }', { a: addr }],
      ['unshieldedUtxos(String)', 'query($a:String!){ unshieldedUtxos(address:$a){ value tokenType } }', { a: addr }],
      ['transactions', 'query($a:UnshieldedAddress!){ transactions(address:$a){ hash } }', { a: addr }],
      ['wallet', 'query($a:String!){ wallet(address:$a){ balance } }', { a: addr }],
    ];
    let answered = false;
    for (const [name, q, vars] of tries) {
      const r = await gql(q, vars);
      if (r?.data && Object.values(r.data).some(v => v !== null && v !== undefined)) {
        console.log(`  ${G}${name}${O} →`);
        console.log(`    ${JSON.stringify(r.data)}`);
        answered = true;
        break;
      }
      const why = r?.errors ? JSON.stringify(r.errors).slice(0, 150) : JSON.stringify(r).slice(0, 150);
      console.log(`  ${D}${name} → ${why}${O}`);
    }
    if (!answered) {
      console.log(`  ${Y}none of the guessed queries fit. The field list above says what does.${O}`);
    }
    console.log('');
  }

  /* ---------- the faucet ---------- */
  console.log(`${B}The faucet${O}`);
  const base = 'https://faucet.stagenet.shielded.tools';
  for (const path of ['/api/health', '/api/drips', '/health', '/']) {
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(10000) });
      const body = (await res.text()).slice(0, 160).replace(/\s+/g, ' ');
      console.log(`    ${String(res.status).padEnd(4)} ${(base + path).padEnd(52)} ${body}`);
    } catch (e: any) {
      console.log(`    ---  ${(base + path).padEnd(52)} ${String(e?.message ?? e).slice(0, 60)}`);
    }
  }
  console.log(`\n  ${D}Other networks in src/midnight/network.ts use a /api/drips endpoint;${O}`);
  console.log(`  ${D}stagenet is configured with the bare host. If /api/drips answers here,${O}`);
  console.log(`  ${D}the link given for funding may simply have been the wrong one.${O}`);

  console.log(`\n${D}Nothing was built, proved, submitted or deployed.${O}`);
}

main().then(() => process.exit(0)).catch((e: any) => {
  console.error(`stopped: ${String(e?.message ?? e)}`);
  process.exit(1);
});

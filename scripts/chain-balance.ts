/**
 * WHAT THE CHAIN SAYS THIS ADDRESS HOLDS — read from the chain, not computed here.
 *
 * Read-only. No wallet is started, nothing is proved or submitted.
 *
 * WHY THIS EXISTS. Every balance quoted in this investigation came from the
 * WALLET's own view, and the DUST figure especially is something the wallet
 * calculates rather than reads. An earlier attempt to get an independent number
 * guessed four query names, got four "Unknown field" errors, and concluded the
 * indexer has no way to answer — which was wrong. It has a way; it is a
 * SUBSCRIPTION, and only the query type had been examined.
 *
 * From `indexer-api/graphql/schema-v4.graphql`, quoted rather than guessed:
 *
 *   subscription unshieldedTransactions(address: UnshieldedAddress!, transactionId: Int)
 *     -> union UnshieldedTransactionsEvent = UnshieldedTransaction
 *                                          | UnshieldedTransactionsProgress
 *
 *   type UnshieldedTransaction { transaction, createdUtxos, spentUtxos }
 *   type UnshieldedUtxo {
 *     owner, tokenType, value, intentHash, outputIndex, ctime, initialNonce,
 *     registeredForDustGeneration, createdAtTransaction, spentAtTransaction
 *   }
 *
 * A balance is created-minus-spent per token type, with a UTXO identified by
 * (intentHash, outputIndex).
 *
 * AND THE FIELD THAT MATTERS MOST: `registeredForDustGeneration` comes back
 * from the CHAIN here. Everything so far has read that flag from the wallet,
 * which is the thing under suspicion.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { theNetwork, applyNetworkId } from '../src/midnight/network.js';
import { endpointsOf } from '../src/core/networks.js';

const ROOT = process.cwd();
const NETWORK = theNetwork();
/*
 * **THE ENDPOINTS COME FROM THE ONE RECORD AND ARE NOT WRITTEN OUT HERE.**
 * A stagenet url typed into this file was a second copy of a value that has
 * moved under this project once already, and it was a copy that could not be
 * wrong in a way anything noticed: it was the fallback, so it answered
 * whenever the real answer was missing.
 */
const THE = endpointsOf(theNetwork());
const HTTP = process.env.MIDNIGHT_INDEXER_URL || THE.indexer;
const WS = process.env.MIDNIGHT_INDEXER_WS_URL || THE.indexerWs;
const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', O = '\x1b[0m';

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(HTTP, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  return res.json();
}

async function addressFor(seedFile: string): Promise<string> {
  const seed = readFileSync(seedFile, 'utf8').trim();
  const { WalletSeeds } = await import('@midnight-ntwrk/testkit-js');
  const { createKeystore } = await import('@midnightntwrk/wallet-sdk');
  const seeds = (WalletSeeds as any).fromMasterSeed(seed);
  const ks: any = await (createKeystore as any)({ kind: 'schnorr', secret: seeds.unshielded }, NETWORK);
  return String(ks.getBech32Address().asString());
}

const SUB = `subscription($a: UnshieldedAddress!) {
  unshieldedTransactions(address: $a) {
    __typename
    ... on UnshieldedTransaction {
      transaction { hash block { height } }
      createdUtxos { tokenType value intentHash outputIndex registeredForDustGeneration ctime }
      spentUtxos   { tokenType value intentHash outputIndex }
    }
    ... on UnshieldedTransactionsProgress { highestTransactionId }
  }
}`;

/**
 * Runs the subscription until it reports progress (the tip) or the time is up.
 *
 * `graphql-transport-ws` is the protocol the indexer speaks: connection_init,
 * wait for connection_ack, then subscribe. Written out rather than pulled from
 * a client library so that a protocol mismatch shows up as a readable message
 * instead of a silent hang.
 */
function collect(address: string, seconds: number): Promise<{ created: any[]; spent: any[]; tip: number | null; note: string }> {
  return new Promise(resolve => {
    const created: any[] = [], spent: any[] = [];
    let tip: number | null = null, note = '';
    let done = false;
    const ws = new WebSocket(WS, 'graphql-transport-ws');
    const finish = (why: string) => {
      if (done) return;
      done = true; note = why;
      try { ws.close(); } catch { /* closing a closed socket is not an error worth reporting */ }
      resolve({ created, spent, tip, note });
    };
    const timer = setTimeout(() => finish(`stopped after ${seconds}s`), seconds * 1000);

    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    ws.onerror = () => finish('the websocket errored');
    ws.onclose = () => { clearTimeout(timer); finish('the indexer closed the connection'); };
    ws.onmessage = (ev: any) => {
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === 'connection_ack') {
        ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: SUB, variables: { a: address } } }));
        return;
      }
      if (m.type === 'error') { finish(`the indexer refused the subscription: ${JSON.stringify(m.payload).slice(0, 300)}`); return; }
      if (m.type === 'next') {
        const d = m.payload?.data?.unshieldedTransactions;
        if (!d) return;
        if (d.__typename === 'UnshieldedTransaction') {
          created.push(...(d.createdUtxos ?? []).map((u: any) => ({ ...u, tx: d.transaction })));
          spent.push(...(d.spentUtxos ?? []));
        } else if (d.__typename === 'UnshieldedTransactionsProgress') {
          tip = d.highestTransactionId ?? null;
          clearTimeout(timer);
          setTimeout(() => finish('reached the indexer\'s tip'), 2000);
        }
      }
      if (m.type === 'complete') finish('the subscription completed');
    };
  });
}

async function main() {
  await applyNetworkId(NETWORK);
  console.log(`\n${B}What the chain says${O}   ${D}${WS}${O}\n`);

  const wallets: [string, string][] = [];
  try {
    const old = readdirSync(join(ROOT, '_to_delete'))
      .filter(f => f.startsWith('wallet.seed.') && !f.includes('in-use')).sort().pop();
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
  } catch { /* no _to_delete is fine */ }
  if (existsSync(join(ROOT, '.midnight', 'wallet.seed'))) {
    wallets.push(['the wallet in use', join(ROOT, '.midnight', 'wallet.seed')]);
  }

  for (const [label, file] of wallets) {
    const address = await addressFor(file);
    console.log(`${B}${label}${O}`);
    console.log(`  ${address}`);

    const { created, spent, tip, note } = await collect(address, 45);
    const spentKeys = new Set(spent.map(u => `${u.intentHash}:${u.outputIndex}`));
    const live = created.filter(u => !spentKeys.has(`${u.intentHash}:${u.outputIndex}`));

    console.log(`  ${D}${note}${tip !== null ? `, indexer tip transaction ${tip}` : ''}${O}`);
    console.log(`  ${D}${created.length} output(s) created, ${spent.length} spent, ${live.length} still unspent${O}\n`);

    if (live.length === 0) {
      console.log(`  ${Y}${B}THE CHAIN SHOWS NOTHING UNSPENT AT THIS ADDRESS.${O}\n`);
    } else {
      const byToken = new Map<string, bigint>();
      for (const u of live) {
        byToken.set(u.tokenType, (byToken.get(u.tokenType) ?? 0n) + BigInt(u.value));
      }
      console.log(`  ${B}Balance, from the chain${O}`);
      for (const [t, v] of byToken) console.log(`    ${String(v).padStart(18)}   token ${t.slice(0, 24)}…`);
      console.log('');
      console.log(`  ${B}Registered for DUST generation — the CHAIN's answer${O}`);
      for (const u of live) {
        const flag = u.registeredForDustGeneration ? `${G}yes${O}` : `${R}NO${O}`;
        console.log(`    ${String(u.value).padStart(18)}   ${flag}   ctime ${u.ctime ?? '—'}   block ${u.tx?.block?.height ?? '?'}`);
      }
      console.log('');
    }
  }

  /* ---------- the chain's own dust merkle roots ---------- */
  console.log(`${B}The chain's DUST state${O}`);
  const b = await gql(`query { block { height timestamp dustCommitmentEndIndex dustGenerationEndIndex dustCommitmentMerkleTreeRoot dustGenerationMerkleTreeRoot } }`);
  console.log(`  ${JSON.stringify(b?.data?.block ?? b?.errors ?? b).slice(0, 500)}`);
  console.log(`\n  ${D}The ledger's DUST spec lists the causes of InvalidDustSpendProof, and two${O}`);
  console.log(`  ${D}of them are inclusion proofs against these trees. If the wallet's local${O}`);
  console.log(`  ${D}roots differ from these, that is the failure — and it is a sync problem,${O}`);
  console.log(`  ${D}not a registration one.${O}`);

  console.log(`\n${D}Nothing was built, proved, submitted or deployed.${O}`);
}

main().then(() => process.exit(0)).catch((e: any) => {
  console.error(`stopped: ${String(e?.message ?? e)}`);
  process.exit(1);
});

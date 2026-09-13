/**
 * IS THE INDEXER SERVING A CHAIN THAT NO LONGER EXISTS?
 *
 * Read-only. Nothing is built, proved, submitted or deployed.
 *
 * Midnight reset Stagenet. A reset chain should have left this wallet with
 * nothing and sent it to the faucet. Instead it reported the SAME balances as
 * before the reset — 5,000,000,000 NIGHT and 5.4 x 10^18 DUST — at the same
 * sync position, within seconds.
 *
 * A wallet learns its balances from the INDEXER, not from the node. So if the
 * indexer still holds pre-reset state, the wallet builds fee proofs against
 * coins and a DUST registration that the new chain has never heard of, and the
 * node refuses every one: `InvalidDustSpendProof`, error 170. That matches
 * every symptom, including why a fresh local resync changed nothing — resyncing
 * faithfully re-reads the same stale source.
 *
 * There is precedent: a Midnight forum thread describes a preprod indexer 23
 * hours behind the chain causing a neighbouring dust error (171) for all
 * submissions.
 *
 * This asks the node and the indexer the same question — how far along are you
 * — and prints both answers. If they disagree, the problem is Midnight's
 * infrastructure and no change on this machine will fix it.
 */
export {};   // makes this file a MODULE rather than a global script.

// Without it TypeScript puts every top-level `const` into one shared scope
// across every script that also lacks an import, and two files declaring the
// same colour constants collide. The error names the variable, not the cause,
// which is a minute wasted every time somebody writes a small standalone
// script here.

import { theNetwork } from '../src/midnight/network.js';
import { endpointsOf, websocketNodeOf } from '../src/core/networks.js';

/*
 * **THE ENDPOINTS COME FROM THE ONE RECORD AND ARE NOT WRITTEN OUT HERE.**
 * A stagenet url typed into this file was a second copy of a value that has
 * moved under this project once already, and it was a copy that could not be
 * wrong in a way anything noticed: it was the fallback, so it answered
 * whenever the real answer was missing.
 */
const THE = endpointsOf(theNetwork());
const NODE = process.env.MIDNIGHT_NODE_URL || THE.node;
const INDEXER = process.env.MIDNIGHT_INDEXER_URL || THE.indexer;

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', O = '\x1b[0m';

async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const res = await fetch(NODE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  });
  const j: any = await res.json();
  if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
  return j.result;
}

async function gql(query: string): Promise<any> {
  const res = await fetch(INDEXER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

async function main() {
  console.log(`\n${B}Is the indexer on the same chain as the node?${O}\n`);

  /* ---------------- the node ---------------- */
  let nodeHeight = -1, nodeHash = '?', genesis = '?';
  console.log(`  ${B}The node${O}  ${D}${NODE}${O}`);
  try {
    const header = await rpc('chain_getHeader');
    nodeHeight = parseInt(String(header?.number ?? '0x0'), 16);
    nodeHash = String(await rpc('chain_getBlockHash', []));
    genesis = String(await rpc('chain_getBlockHash', [0]));
    console.log(`    latest block      ${B}${nodeHeight}${O}`);
    console.log(`    latest hash       ${nodeHash}`);
    console.log(`    ${B}GENESIS hash      ${genesis}${O}`);
    console.log(`    ${D}the genesis hash is the chain's identity — a reset changes it${O}`);
  } catch (e: any) {
    console.log(`    ${R}could not ask the node: ${String(e?.message ?? e).slice(0, 120)}${O}`);
  }

  /* ---------------- the indexer ---------------- */
  console.log(`\n  ${B}The indexer${O}  ${D}${INDEXER}${O}`);
  const attempts = [
    'query { block { height hash parent { hash } } }',
    'query { block { height hash } }',
    'query { latestBlock { height hash } }',
    'query { chainStatus { height hash } }',
  ];
  let answered = false;
  for (const q of attempts) {
    try {
      const j = await gql(q);
      if (j?.data && Object.values(j.data).some(v => v)) {
        console.log(`    ${D}${q}${O}`);
        console.log(`    ${JSON.stringify(j.data)}`);
        const h = (j.data as any)?.block?.height ?? (j.data as any)?.latestBlock?.height
          ?? (j.data as any)?.chainStatus?.height;
        if (typeof h === 'number' && nodeHeight >= 0) {
          const behind = nodeHeight - h;
          console.log('');
          if (behind > 50) {
            console.log(`    ${R}${B}THE INDEXER IS ${behind} BLOCKS BEHIND THE NODE.${O}`);
            console.log(`    ${R}A wallet reading balances from here is reading a chain the node has left.${O}`);
          } else if (behind < -50) {
            console.log(`    ${Y}the indexer is AHEAD of the node by ${-behind} — different chains entirely${O}`);
          } else {
            console.log(`    ${G}the indexer is level with the node (${behind} blocks apart)${O}`);
            console.log(`    ${D}so staleness is not the explanation, and the balances it served${O}`);
            console.log(`    ${D}are what this chain genuinely holds${O}`);
          }
        }
        answered = true;
        break;
      }
      if (j?.errors) console.log(`    ${D}${q} → ${JSON.stringify(j.errors).slice(0, 160)}${O}`);
    } catch (e: any) {
      console.log(`    ${D}${q} → ${String(e?.message ?? e).slice(0, 80)}${O}`);
    }
  }
  if (!answered) {
    console.log(`    ${Y}none of the guessed queries fit this indexer's schema.${O}`);
    console.log(`    ${D}Asking it to describe itself instead:${O}`);
    try {
      const j = await gql('query { __schema { queryType { fields { name } } } }');
      const names = j?.data?.__schema?.queryType?.fields?.map((f: any) => f.name) ?? [];
      console.log(`    available queries: ${names.join(', ').slice(0, 400)}`);
    } catch (e: any) {
      console.log(`    ${R}introspection refused too: ${String(e?.message ?? e).slice(0, 100)}${O}`);
    }
  }

  console.log(`\n${B}What to do with this${O}`);
  console.log('  If the indexer is behind, or on a different chain, nothing on this machine');
  console.log('  can fix it and the answer is to tell Midnight. Send them the genesis hash');
  console.log('  above and the block numbers — that is the whole of the evidence.');
  console.log(`\n${D}  Nothing was built, proved, submitted or deployed.${O}`);
}

main().then(() => process.exit(0)).catch((e: any) => {
  console.error(`\n${R}stopped:${O} ${String(e?.message ?? e)}`);
  process.exit(1);
});

/**
 * IS STAGENET TAKING TRANSACTIONS FROM ANYONE, OR JUST NOT FROM US?
 *
 * Read-only. Nothing is built, proved, submitted or deployed.
 *
 * A chain that is accepting work has USER transactions in its blocks. So: look
 * at the blocks the chain produces while this runs and count the transactions
 * somebody submitted — a `RegularTransaction`, as opposed to a
 * `SystemTransaction`, which the chain makes by itself and which proves only
 * that blocks are being made.
 *
 * Names are from indexer-api/graphql/schema-v4.graphql, not guessed:
 *   query block(offset: BlockOffset): Block     BlockOffset @oneOf { hash, height }
 *   Block { height, timestamp, transactions }
 *   interface Transaction  ->  RegularTransaction | SystemTransaction | BridgeClaimTransaction
 *   RegularTransaction { fee, transactionResult { status } }
 *   subscription unshieldedTransactions(address: UnshieldedAddress!, transactionId: Int)
 *     -> UnshieldedTransaction | UnshieldedTransactionsProgress { highestTransactionId }
 *
 * ── THIS FILE HAS NOW BEEN CONFIDENTLY WRONG TWICE, IN TWO DIFFERENT WAYS ──
 *
 * **First by SAMPLING.** It walked back through blocks and, once more than
 * 3,000 back, sampled every 500. It announced *"nothing has landed for 40
 * hours"*, which was false: thirty of our own transactions from 15 August sat
 * in a ~200-block window it stepped over. A sparse sample can prove something
 * IS there and can never prove something is NOT.
 *
 * **Then by ASSUMPTION, which is worse, because it read like a measurement.**
 * The replacement subscribed to `unshieldedTransactions` for one address, read
 * `highestTransactionId`, and asserted in its own comment: *"It is chain-wide,
 * not per-address."* Nothing had verified that. On 27 Aug it reported *"NOT ONE
 * TRANSACTION IN 8 BLOCKS… nothing is landing for anyone… worth raising"* while
 * the Midnight faucet was working and tNIGHT was received.
 *
 * **THAT MARKER IS PER-ADDRESS. MEASURED, AND THE MEASUREMENT WAS ALREADY ON
 * DISK.** `scripts/chain-balance.ts:61-71,112-113` reads the same field from the
 * same subscription, and `REPORT-CHAIN-BALANCE.txt` (16 Aug 06:04) records one
 * run of it against two addresses:
 *
 *     mn_addr_stagenet1ku4g…afv   indexer tip transaction 143   2 outputs created
 *     mn_addr_stagenet1k9rne…tta  indexer tip transaction 0     0 outputs created
 *
 * One indexer, one run, two addresses, two values. A chain-wide counter cannot
 * read 0 on a chain that was at block 36,980 and had already accepted thirty of
 * our own transactions. **So a frozen counter means nothing landed FOR THAT ONE
 * ADDRESS, which is unremarkable and proves nothing about anybody else.**
 *
 * ── WHAT THIS DOES INSTEAD, AND WHAT EACH MEASURE CAN AND CANNOT SAY ──────
 *
 *   1. Blocks are being produced at all. If not, that is the whole answer.
 *   2. A POSITIVE CONTROL on a block known to contain a transaction, so that a
 *      zero below is a genuinely empty block rather than a broken query.
 *   3. THE TWO-ADDRESS COMPARISON, run every time rather than trusted from this
 *      comment, so the claim above cannot rot back into an assumption.
 *   4. THE MEASURE THAT CAN ACTUALLY ANSWER THE QUESTION: every block produced
 *      during a wait, walked CONTIGUOUSLY — no sampling — counting
 *      `RegularTransaction`s. That is chain-wide by construction, it covers
 *      shielded and unshielded work alike because a shielded transaction is
 *      still a `RegularTransaction`, and it can only be as wrong as the window
 *      is short.
 *
 * **AND THE WINDOW IS THE LIMIT THAT REMAINS.** A quiet minute on a real chain
 * looks exactly like a stopped one. So the verdict below says how many blocks
 * were inspected and refuses to generalise past them: "no user transaction in
 * N blocks" is a fact, and "nothing is landing for anyone" is not one this
 * instrument is able to establish. The tone was part of the defect.
 */
export {};   // makes this file a MODULE rather than a global script.
//
// Without it TypeScript puts every top-level `const` into one shared scope
// across every script that also lacks an import, and two files declaring the
// same colour constants collide. The error names the variable, not the cause,
// which is a minute wasted every time somebody writes a small standalone
// script here.

const IDX = process.env.MIDNIGHT_INDEXER_URL || 'https://indexer.stagenet.shielded.tools/api/v4/graphql';

/**
 * The two addresses the per-address comparison uses.
 *
 * Both are real stagenet addresses this project has used, and they are the two
 * whose recorded readings differ — one that has received value, one that never
 * has. **That pairing is deliberate:** two never-used addresses would both read
 * 0, which is equally consistent with a per-address marker and with a chain-wide
 * one that happens to be 0, and would settle nothing.
 */
const PROBE_ADDRESS = process.env.PROBE_ADDRESS
  || 'mn_addr_stagenet1ku4g25nwe6rey753yj3xf5q25h6sghruuavcm0uznx05fpdt34asfq8afv';
const PROBE_ADDRESS_2 = process.env.PROBE_ADDRESS_2
  || 'mn_addr_stagenet1k9rne7mn0cqg4j84fgc4q6ugwsf4jq4vf8mkqdlhwzvk875x3fdqk4htta';

/** How long to watch for new blocks. Seconds. */
const WATCH_SECONDS = Number(process.env.CHAIN_ALIVE_WATCH_SECONDS || 45);

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', O = '\x1b[0m';

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(IDX, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  return res.json();
}

const BLOCK = `query($h: Int!) {
  block(offset: { height: $h }) {
    height
    timestamp
    transactions {
      __typename
      hash
      ... on RegularTransaction { fee transactionResult { status } }
    }
  }
}`;

const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} hours ago`;
};

/**
 * The per-address progress marker for ONE address.
 *
 * Returns the highest transaction id the indexer reports for that address, or
 * null if it would not answer. **What it is NOT is a chain-wide counter**, and
 * the comparison below is what keeps that from being forgotten again.
 */
const counterFor = (address: string): Promise<number | null> => new Promise(resolve => {
  const ws = new WebSocket((process.env.MIDNIGHT_INDEXER_WS_URL
    || IDX.replace(/^http/, 'ws') + '/ws'), 'graphql-transport-ws');
  let done = false;
  const finish = (v: number | null) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
  const timer = setTimeout(() => finish(null), 25000);
  const q = `subscription($a: UnshieldedAddress!) {
    unshieldedTransactions(address: $a) {
      __typename ... on UnshieldedTransactionsProgress { highestTransactionId } } }`;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
  ws.onerror = () => finish(null);
  ws.onmessage = (ev: any) => {
    let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.type === 'connection_ack') {
      ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: q, variables: { a: address } } }));
      return;
    }
    if (m.type === 'error') { finish(null); return; }
    if (m.type === 'next') {
      const d = m.payload?.data?.unshieldedTransactions;
      if (d?.__typename === 'UnshieldedTransactionsProgress') { clearTimeout(timer); finish(d.highestTransactionId ?? null); }
    }
  };
});

/** Every block in [from, to], each one asked for. No sampling, by construction. */
async function walkContiguously(from: number, to: number) {
  const blocks: Array<{ height: number; regular: number; system: number; other: number }> = [];
  for (let h = from; h <= to; h++) {
    const b = (await gql(BLOCK, { h }))?.data?.block;
    if (!b) { blocks.push({ height: h, regular: -1, system: -1, other: -1 }); continue; }
    const kinds = (b.transactions ?? []).map((t: any) => String(t.__typename));
    blocks.push({
      height: h,
      regular: kinds.filter((k: string) => k === 'RegularTransaction').length,
      system: kinds.filter((k: string) => k === 'SystemTransaction').length,
      other: kinds.filter((k: string) => k !== 'RegularTransaction' && k !== 'SystemTransaction').length,
    });
  }
  return blocks;
}

async function main() {
  console.log(`\n${B}Is Stagenet taking transactions from anyone?${O}`);
  console.log(`${D}${IDX}${O}\n`);

  const tipRes = await gql(`query { block { height timestamp } }`);
  const tip = tipRes?.data?.block;
  if (!tip) {
    console.log(`  ${R}the indexer would not answer for the latest block:${O} ${JSON.stringify(tipRes).slice(0, 300)}`);
    console.log(`  ${R}NOTHING BELOW WAS MEASURED, so this run concludes nothing.${O}`);
    return;
  }
  console.log(`  tip is block ${B}${tip.height}${O} at ${when(tip.timestamp)}  (${ago(tip.timestamp)})`);
  if (Date.now() - tip.timestamp > 5 * 60_000) {
    console.log(`  ${R}${B}THE CHAIN IS NOT PRODUCING BLOCKS.${O} That is the whole answer.`);
    return;
  }
  console.log(`  ${G}blocks are being produced${O} — so the chain is alive; the question is whether it accepts work\n`);

  /*
   * A POSITIVE CONTROL, BEFORE ANY CONCLUSION IS DRAWN.
   *
   * The first version of this script reported "no user transactions anywhere"
   * and it was nearly believed. What made it suspect was that it also found
   * zero SYSTEM transactions — and those are produced by the chain itself, so
   * finding none across the whole chain is not evidence about submitters, it
   * is evidence the query is not returning transactions at all.
   *
   * Block 14679 is known to contain one: the chain told us our wallet's NIGHT
   * was created there. If this query cannot see that transaction, then every
   * "0 transactions" below means nothing, and saying otherwise would send
   * somebody to Midnight with a finding built on a broken query.
   */
  const CONTROL_HEIGHT = Number(process.env.CONTROL_BLOCK || 14679);
  const control = (await gql(BLOCK, { h: CONTROL_HEIGHT }))?.data?.block;
  const controlCount = control?.transactions?.length ?? 0;
  console.log(`  ${B}Control — block ${CONTROL_HEIGHT}, known to contain a transaction${O}`);
  if (!control) {
    console.log(`    ${R}the indexer returned nothing for that block. The sweep below cannot be trusted.${O}\n`);
    return;
  }
  console.log(`    returned ${controlCount} transaction(s): ${(control.transactions ?? []).map((t: any) => t.__typename).join(', ') || '(none)'}`);
  if (controlCount === 0) {
    console.log(`    ${R}${B}THE QUERY IS NOT RETURNING TRANSACTIONS.${O}`);
    console.log(`    ${R}A block we KNOW holds one reports none, so nothing below is evidence${O}`);
    console.log(`    ${R}about whether the chain accepts work. Do not raise this with anyone.${O}`);
    console.log(`    ${D}Fix the query first — check Block.transactions in schema-v4.graphql.${O}\n`);
    return;
  }
  console.log(`    ${G}the query works — a zero below therefore means a genuinely empty block${O}\n`);

  /*
   * THE CLAIM THIS SCRIPT USED TO MAKE, PUT TO THE TEST EVERY RUN.
   *
   * Two addresses, one indexer, at the same moment. Different values prove the
   * marker is per-address and the old conclusion collapses. Identical values are
   * CONSISTENT WITH chain-wide and prove nothing on their own — and if both are
   * 0 or unanswered they license nothing at all, because a per-address marker
   * reads 0 for two unused addresses just as readily.
   */
  console.log(`  ${B}Is the progress marker chain-wide or per-address?${O}`);
  console.log(`    ${D}subscribing twice, with two different addresses${O}`);
  const [cA, cB] = [await counterFor(PROBE_ADDRESS), await counterFor(PROBE_ADDRESS_2)];
  console.log(`    ${PROBE_ADDRESS.slice(0, 24)}…  highestTransactionId ${B}${cA === null ? 'no answer' : cA}${O}`);
  console.log(`    ${PROBE_ADDRESS_2.slice(0, 24)}…  highestTransactionId ${B}${cB === null ? 'no answer' : cB}${O}`);

  let perAddress: boolean | null = null;
  if (cA === null || cB === null) {
    console.log(`    ${Y}one of the two would not answer, so this run settles nothing about the marker.${O}`);
    console.log(`    ${D}The recorded measurement says per-address: REPORT-CHAIN-BALANCE.txt, 16 Aug, 143 against 0.${O}`);
  } else if (cA !== cB) {
    perAddress = true;
    console.log(`    ${B}DIFFERENT VALUES — THE MARKER IS PER-ADDRESS.${O} It cannot say what is`);
    console.log(`    landing for anybody else, and a frozen one is unremarkable.`);
  } else {
    perAddress = false;
    console.log(`    identical values. ${Y}Consistent with chain-wide, and NOT proof of it${O} — two`);
    console.log(`    addresses can agree by coincidence, and two unused ones always will.`);
    if (cA === 0) {
      console.log(`    ${Y}Both read 0, which is what two unused addresses read. This licenses nothing.${O}`);
    }
  }
  console.log(`    ${D}Either way it counts UNSHIELDED transactions only: a chain busy with${O}`);
  console.log(`    ${D}shielded work would leave this number completely still.${O}\n`);

  /*
   * THE MEASURE THAT CAN ANSWER THE QUESTION.
   *
   * Watch for a while, then walk EVERY block produced in that window and count
   * the transactions somebody submitted. Contiguous, so the sampling failure
   * cannot recur; chain-wide by construction, so it needs no assumption about
   * what a counter means; and it sees shielded work, because a shielded
   * transaction is still a RegularTransaction in a block.
   */
  console.log(`  ${B}Every block produced in the next ${WATCH_SECONDS} seconds${O}`);
  const startHeight = Number(tip.height);
  await new Promise(r => setTimeout(r, WATCH_SECONDS * 1000));
  const afterHeight = Number((await gql(`query { block { height } }`))?.data?.block?.height ?? startHeight);
  const produced = afterHeight - startHeight;

  if (produced <= 0) {
    console.log(`    ${Y}No blocks were produced in ${WATCH_SECONDS}s, so there is nothing to inspect.${O}`);
    console.log(`    ${Y}This run proves nothing about whether work is being accepted. Run it again.${O}\n`);
    return;
  }

  const blocks = await walkContiguously(startHeight + 1, afterHeight);
  const unreadable = blocks.filter(b => b.regular < 0).length;
  const regular = blocks.reduce((n, b) => n + Math.max(0, b.regular), 0);
  const system = blocks.reduce((n, b) => n + Math.max(0, b.system), 0);
  const other = blocks.reduce((n, b) => n + Math.max(0, b.other), 0);

  console.log(`    blocks ${startHeight + 1}–${afterHeight}  (${produced} produced, ${blocks.length} inspected, none skipped)`);
  console.log(`    ${B}${regular}${O} user transaction(s), ${system} system, ${other} other`);
  if (unreadable) console.log(`    ${Y}${unreadable} block(s) the indexer would not return — they are not counted either way${O}`);
  console.log();

  /* ---------------- the verdict, and it claims only what was measured ------ */

  if (regular > 0) {
    console.log(`  ${G}${B}TRANSACTIONS ARE LANDING RIGHT NOW.${O}`);
    console.log(`  ${G}${regular} user transaction(s) in ${blocks.length} blocks. The chain is accepting work${O}`);
    console.log(`  ${G}from somebody, so the fault is on our side.${O}`);
    console.log(`  ${D}Do not raise it with the team — the search starts again here.${O}`);
    return;
  }

  console.log(`  ${Y}${B}NO USER TRANSACTION IN ${blocks.length} BLOCK(S).${O}`);
  console.log(`  ${Y}That is the whole of what was measured${unreadable ? `, less ${unreadable} block the indexer would not return` : ''}.${O}`);
  console.log();
  console.log(`  ${D}WHAT IT DOES NOT ESTABLISH. ${blocks.length} block(s) is about ${Math.round(WATCH_SECONDS / 60 * 10) / 10} minute(s) of chain.`);
  console.log(`  A quiet minute on a working chain looks exactly like this, and stagenet is`);
  console.log(`  not busy. "Nothing is landing for anyone" is a claim about the chain over`);
  console.log(`  hours and this instrument watches for seconds.${O}`);
  console.log();
  console.log(`  ${D}WHAT WOULD ESTABLISH IT: the same contiguous walk over a window long enough`);
  console.log(`  to be surprising — set CHAIN_ALIVE_WATCH_SECONDS, or walk back from the tip —`);
  console.log(`  together with a submission of our own that the chain refuses. Until then this`);
  console.log(`  is an observation to repeat, not a finding to raise.${O}`);
  if (perAddress) {
    console.log();
    console.log(`  ${D}And the per-address marker above is not evidence here at all: it was`);
    console.log(`  measured to be per-address in this very run.${O}`);
  }
}

main().then(() => process.exit(0)).catch((e: any) => {
  console.error(`stopped: ${String(e?.message ?? e)}`);
  process.exit(1);
});

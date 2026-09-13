/**
 * WHAT THE CHAIN SAYS AN ADDRESS HOLDS, AND WHICH OF IT EARNS THE FEE TOKEN.
 *
 * ── WHY THE FLAG IS THE POINT ───────────────────────────────────────────────
 *
 * NIGHT sitting at an address that is not registered for dust generation earns
 * nothing, and fees are payable only in what it would have earned. So an
 * unregistered output is money that has arrived and can never leave. The
 * indexer answers `registeredForDustGeneration` per output, FROM THE CHAIN,
 * which is the only source for it that is not the wallet whose behaviour is in
 * question.
 *
 * ── THE SHAPE OF THE ANSWER, AND WHY IT IS A SUBSCRIPTION ───────────────────
 *
 * There is no query that returns a balance. There is a subscription that
 * replays every transaction touching an address, each carrying the outputs it
 * created and the outputs it spent, and then reports the point it has reached.
 * An address's holding is created minus spent, with an output identified by the
 * intent hash it was made in and its index within that intent.
 *
 * ── WHAT IS PURE HERE AND WHAT IS NOT ───────────────────────────────────────
 *
 * The arithmetic is pure and is tested: given what was created and what was
 * spent, which outputs survive, how many of them earn, and what that means.
 * Only the socket is not, and it is deliberately thin, so that a protocol
 * mismatch shows up as a readable message rather than as a wrong number.
 */

/** One unshielded output, as the indexer describes it. */
export type ChainUtxo = {
  tokenType: string;
  value: string | number | bigint;
  intentHash: string;
  outputIndex: number;
  registeredForDustGeneration?: boolean | null;
  ctime?: unknown;
};

export type NightHolding = {
  /** Outputs of the fee-paying token still unspent at this address. */
  unspent: ChainUtxo[];
  /** Of those, the ones the chain says earn the fee token. */
  registered: ChainUtxo[];
  total: bigint;
  /** How far the read got. A partial read is not a holding and callers must say so. */
  complete: boolean;
  note: string;
};

const idOf = (u: { intentHash: string; outputIndex: number }) => `${u.intentHash}:${u.outputIndex}`;

/**
 * Created minus spent, narrowed to one token, with the earning ones separated.
 *
 * `registeredForDustGeneration` MISSING IS NOT `false` AND IS NOT `true`. An
 * indexer that stopped sending the field would otherwise turn every output into
 * an unregistered one, which reads as an alarm, or into a registered one, which
 * reads as a licence. Neither is a reading, so an output whose flag did not
 * arrive is counted as unspent and NOT counted as registered, and the note says
 * how many were in that state.
 */
export function holdingOf(created: ChainUtxo[], spent: ChainUtxo[], tokenType: string): Omit<NightHolding, 'complete' | 'note'> & { unknownFlags: number } {
  const gone = new Set(spent.map(idOf));
  const unspent = created.filter((u) => u.tokenType === tokenType && !gone.has(idOf(u)));
  const registered = unspent.filter((u) => u.registeredForDustGeneration === true);
  const unknownFlags = unspent.filter((u) => u.registeredForDustGeneration !== true && u.registeredForDustGeneration !== false).length;
  return {
    unspent,
    registered,
    total: unspent.reduce((t, u) => t + BigInt(u.value), 0n),
    unknownFlags,
  };
}

/** One line a person can act on. */
export function describeHolding(address: string, h: NightHolding): string[] {
  const lines = [
    `${address}`,
    `  ${h.unspent.length} unspent output(s), ${h.registered.length} of them registered for dust generation, ${h.total} in total`,
  ];
  if (!h.complete) {
    lines.push('  THIS READ DID NOT REACH THE CHAIN\'S CURRENT POINT, so it is not a holding: ' + h.note);
  }
  return lines;
}

export const SUBSCRIPTION = `subscription($a: UnshieldedAddress!) {
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
 * Replays the address's transactions until the indexer says it has caught up.
 *
 * A read that ran out of time comes back with `complete: false` rather than
 * with a shorter list, because a shorter list is indistinguishable from a
 * smaller balance and one of those two is safe to act on.
 */
export async function readHolding(
  wsUrl: string,
  address: string,
  tokenType: string,
  seconds = 45,
): Promise<NightHolding> {
  const created: ChainUtxo[] = [];
  const spent: ChainUtxo[] = [];
  let complete = false;
  let note = '';

  await new Promise<void>((resolve) => {
    let done = false;
    const ws = new WebSocket(wsUrl, 'graphql-transport-ws');
    const finish = (why: string, reached: boolean) => {
      if (done) return;
      done = true; note = why; complete = reached;
      try { ws.close(); } catch { /* closing a closed socket is not a failure */ }
      resolve();
    };
    const timer = setTimeout(() => finish(`the read stopped after ${seconds}s without reaching the chain's current point`, false), seconds * 1000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    ws.onerror = () => finish('the connection to the indexer failed', false);
    ws.onclose = () => { clearTimeout(timer); finish('the indexer closed the connection', complete); };
    ws.onmessage = (ev: any) => {
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === 'connection_ack') {
        ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: SUBSCRIPTION, variables: { a: address } } }));
        return;
      }
      if (m.type === 'error') { finish(`the indexer refused the subscription: ${JSON.stringify(m.payload).slice(0, 240)}`, false); return; }
      if (m.type === 'next') {
        const d = m.payload?.data?.unshieldedTransactions;
        if (!d) return;
        if (d.__typename === 'UnshieldedTransaction') {
          created.push(...(d.createdUtxos ?? []));
          spent.push(...(d.spentUtxos ?? []));
        } else if (d.__typename === 'UnshieldedTransactionsProgress') {
          clearTimeout(timer);
          setTimeout(() => finish('reached the point the indexer has read to', true), 2000);
        }
      }
    };
  });

  const h = holdingOf(created, spent, tokenType);
  const extra = h.unknownFlags > 0
    ? `. ${h.unknownFlags} output(s) came back without the registration flag and are counted as not registered`
    : '';
  return { unspent: h.unspent, registered: h.registered, total: h.total, complete, note: note + extra };
}

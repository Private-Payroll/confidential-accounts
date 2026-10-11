import { describe, it, expect } from 'vitest';
import { indexerContractHistory } from './contract-history.js';
import { NoteIndexUnaskable, NoteIndexUnreadable, type IndexerSocket } from './note-index.js';

/*
 * A contract's whole history, read over the indexer's subscription: every step
 * in order, the kind of step and the state it left, and never a short list.
 */
const CONTRACT = 'a7'.repeat(32);
const H = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

const latestIs = (hash: string | null) => {
  const asked: any[] = [];
  const post = (async (_url: string, init: any) => {
    asked.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ data: { contractAction: hash === null ? null : { transaction: { hash } } } }) } as Response;
  }) as typeof fetch;
  return { post, asked };
};

/** A socket that speaks `graphql-transport-ws` from a script, and remembers what it was sent. */
const scriptedSocket = (script: () => unknown[]) => {
  const sent: any[] = [];
  let closed = 0;
  const open = () => {
    const s: IndexerSocket = {
      onopen: null, onmessage: null, onerror: null, onclose: null,
      send: (data: string) => {
        const m = JSON.parse(data);
        sent.push(m);
        const reply = (msgs: unknown[]) => setTimeout(() => { for (const r of msgs) s.onmessage?.({ data: JSON.stringify(r) }); }, 0);
        if (m.type === 'connection_init') reply([{ type: 'connection_ack' }]);
        if (m.type === 'subscribe') reply(script());
      },
      close: () => { closed += 1; },
    };
    setTimeout(() => s.onopen?.({}), 0);
    return s;
  };
  return { open, sent, closed: () => closed };
};
const step = (
  kind: string, hash: string, state = 'abcd', block: unknown = { height: 7, timestamp: 1_700_000_000_000 }, entryPoint?: unknown,
  status: string | null = 'SUCCESS',
) =>
  ({ id: '1', type: 'next', payload: { data: { contractActions: {
    __typename: kind, state, transaction: { hash, block, ...(status === null ? {} : { transactionResult: { status } }) },
    ...(kind === 'ContractCall' ? { entryPoint: entryPoint ?? 'approve' } : {}),
  } } } });

describe('A CONTRACT\'S HISTORY, AS THE INDEXER SERVES IT', () => {
  it('lists every step oldest first, with its kind and the state it left, through every action of the latest transaction', async () => {
    const socket = scriptedSocket(() => [
      step('ContractDeploy', H(1), '01', { height: 1, timestamp: 1000 }), step('ContractUpdate', H(2), '02', { height: 2, timestamp: 2000 }),
      step('ContractCall', H(3), '03', { height: 3, timestamp: 3000 }, 'propose'),
      step('ContractUpdate', H(4), '04', { height: 4, timestamp: 4000 }), step('ContractCall', H(4), '05', { height: 4, timestamp: 4000 }, 'cancel'),
    ]);
    const latest = latestIs(H(4));
    const list = await indexerContractHistory('u', 'w', { post: latest.post, open: socket.open, settleMs: 5 }).of(`0x${CONTRACT.toUpperCase()}`);
    /* RED WHEN: the list closes at the first action of the latest transaction - a change and a call in one
     * transaction would then read as a change alone. */
    expect(list.map((s) => [s.kind, s.transaction, Buffer.from(s.state).toString('hex')])).toEqual([
      ['deploy', H(1), '01'], ['update', H(2), '02'], ['call', H(3), '03'], ['update', H(4), '04'], ['call', H(4), '05'],
    ]);
    const subscribe = socket.sent.find((m) => m.type === 'subscribe');
    /* RED WHEN: the subscription starts anywhere but the first block, or does not ask for each step's kind and state. */
    expect(subscribe.payload.variables).toEqual({ a: CONTRACT, o: { height: 0 } });
    expect(subscribe.payload.query).toMatch(/__typename state transaction \{ hash block \{ height timestamp \} /);
    /* RED WHEN: a step's block is not the one its transaction is in - the height or the time its author set dropped or swapped. */
    expect(list.map((s) => [s.block.height, s.block.at])).toEqual([[1, 1000], [2, 2000], [3, 3000], [4, 4000], [4, 4000]]);
    /* RED WHEN: a call is listed without the circuit it called, or a deploy or an update with one - which step raised or closed a round is read off it. */
    expect(subscribe.payload.query).toMatch(/\.\.\. on ContractCall \{ entryPoint \}/);
    expect(list.map((s) => s.entryPoint)).toEqual([undefined, undefined, 'propose', undefined, 'cancel']);
    expect(socket.closed()).toBeGreaterThan(0);
  });

  it('SAYS WHETHER EACH STEP\'S TRANSACTION SUCCEEDED IN FULL, AS THE INDEXER RECORDS ITS RESULT, AND LISTS A FAILED ONE AS NOT', async () => {
    const socket = scriptedSocket(() => [
      step('ContractCall', H(1), '01', { height: 1, timestamp: 1000 }, 'propose'),
      step('ContractCall', H(2), '02', { height: 2, timestamp: 2000 }, 'cancel', 'FAILURE'),
      step('ContractCall', H(3), '03', { height: 2, timestamp: 2000 }, 'amendSigner', 'PARTIAL_SUCCESS'),
      step('ContractCall', H(4), '04', { height: 3, timestamp: 3000 }, 'approve', null),
    ]);
    const list = await indexerContractHistory('u', 'w', { post: latestIs(H(4)).post, open: socket.open, settleMs: 5 }).of(CONTRACT);
    const subscribe = socket.sent.find((m) => m.type === 'subscribe');
    /* RED WHEN: the history does not ask each step's transaction for its result - a failed call would read as one that acted. */
    expect(subscribe.payload.query).toMatch(/\.\.\. on RegularTransaction \{ transactionResult \{ status \} \}/);
    /* RED WHEN: a step of a transaction that failed, succeeded only in part, or whose result is not given, is read as one that succeeded. */
    expect(list.map((x) => x.succeeded)).toEqual([true, false, false, false]);
  });

  it('NAMES THE LATEST TRANSACTION ON ITS OWN, SO A HISTORY IS READ AGAIN ONLY WHEN IT MOVES', async () => {
    const latest = latestIs(H(9));
    /* RED WHEN: the latest transaction is not the indexer's own answer for this contract. */
    await expect(indexerContractHistory('u', 'w', { post: latest.post, open: scriptedSocket(() => []).open }).latest(`0x${CONTRACT}`)).resolves.toBe(H(9));
    expect(latest.asked[0].variables).toEqual({ a: CONTRACT });
  });

  it('REFUSES A HISTORY THAT ENDED BEFORE THE LATEST TRANSACTION, A STEP OF AN UNKNOWN KIND, AND A STATE THAT IS NOT HEX', async () => {
    const short = scriptedSocket(() => [step('ContractDeploy', H(1)), { id: '1', type: 'complete' }]);
    await expect(indexerContractHistory('u', 'w', { post: latestIs(H(3)).post, open: short.open, settleMs: 5 }).of(CONTRACT))
      .rejects.toThrow(/stopped before its latest transaction \(the subscription ended\), after 1 step/);
    const odd = scriptedSocket(() => [step('ContractSomethingElse', H(1))]);
    await expect(indexerContractHistory('u', 'w', { post: latestIs(H(1)).post, open: odd.open, settleMs: 5 }).of(CONTRACT))
      .rejects.toThrow(/a step of a kind this does not know/);
    /* RED WHEN: a call naming no circuit is taken - which call raised a round could not then be said. */
    for (const entryPoint of ['', 5]) {
      const unnamed = scriptedSocket(() => [step('ContractCall', H(1), '01', undefined, entryPoint)]);
      await expect(indexerContractHistory('u', 'w', { post: latestIs(H(1)).post, open: unnamed.open, settleMs: 5 }).of(CONTRACT))
        .rejects.toThrow(/a call whose entry point is not named/);
    }
    const bad = scriptedSocket(() => [step('ContractDeploy', H(1), 'zz')]);
    await expect(indexerContractHistory('u', 'w', { post: latestIs(H(1)).post, open: bad.open, settleMs: 5 }).of(CONTRACT))
      .rejects.toThrow(/whose state is not hex/);
    /* RED WHEN: a step is taken without the block it is in - a time read off it later would be nothing's. */
    for (const block of [null, { height: 1 }, { height: -1, timestamp: 5 }, { height: 1, timestamp: '5' }]) {
      const noBlock = scriptedSocket(() => [step('ContractDeploy', H(1), '01', block)]);
      await expect(indexerContractHistory('u', 'w', { post: latestIs(H(1)).post, open: noBlock.open, settleMs: 5 }).of(CONTRACT))
        .rejects.toThrow(/whose block has no height or time/);
    }
  });

  it('A CONTRACT THE INDEXER HOLDS NOTHING FOR, A SILENT INDEXER, AND A QUESTION IT WILL NOT TAKE, EACH SAY SO', async () => {
    await expect(indexerContractHistory('u', 'w', { post: latestIs(null).post, open: scriptedSocket(() => []).open }).of(CONTRACT))
      .rejects.toBeInstanceOf(NoteIndexUnreadable);
    await expect(indexerContractHistory('u', 'w', { post: latestIs(H(1)).post, open: scriptedSocket(() => []).open, timeoutMs: 20 }).of(CONTRACT))
      .rejects.toThrow(/no answer within/);
    const refusing = scriptedSocket(() => [{ id: '1', type: 'error', payload: [{ message: 'Unknown field "__typename" on type "ContractAction".' }] }]);
    await expect(indexerContractHistory('u', 'w', { post: latestIs(H(1)).post, open: refusing.open }).of(CONTRACT))
      .rejects.toBeInstanceOf(NoteIndexUnaskable);
  });
});

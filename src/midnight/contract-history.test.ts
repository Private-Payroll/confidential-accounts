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
const step = (kind: string, hash: string, state = 'abcd') =>
  ({ id: '1', type: 'next', payload: { data: { contractActions: { __typename: kind, state, transaction: { hash } } } } });

describe('A CONTRACT\'S HISTORY, AS THE INDEXER SERVES IT', () => {
  it('lists every step oldest first, with its kind and the state it left, through every action of the latest transaction', async () => {
    const socket = scriptedSocket(() => [
      step('ContractDeploy', H(1), '01'), step('ContractUpdate', H(2), '02'), step('ContractCall', H(3), '03'),
      step('ContractUpdate', H(4), '04'), step('ContractCall', H(4), '05'),
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
    expect(subscribe.payload.query).toMatch(/__typename state transaction \{ hash \}/);
    expect(socket.closed()).toBeGreaterThan(0);
  });

  it('REFUSES A HISTORY THAT ENDED BEFORE THE LATEST TRANSACTION, A STEP OF AN UNKNOWN KIND, AND A STATE THAT IS NOT HEX', async () => {
    const short = scriptedSocket(() => [step('ContractDeploy', H(1)), { id: '1', type: 'complete' }]);
    await expect(indexerContractHistory('u', 'w', { post: latestIs(H(3)).post, open: short.open, settleMs: 5 }).of(CONTRACT))
      .rejects.toThrow(/stopped before its latest transaction \(the subscription ended\), after 1 step/);
    const odd = scriptedSocket(() => [step('ContractSomethingElse', H(1))]);
    await expect(indexerContractHistory('u', 'w', { post: latestIs(H(1)).post, open: odd.open, settleMs: 5 }).of(CONTRACT))
      .rejects.toThrow(/a step of a kind this does not know/);
    const bad = scriptedSocket(() => [step('ContractDeploy', H(1), 'zz')]);
    await expect(indexerContractHistory('u', 'w', { post: latestIs(H(1)).post, open: bad.open, settleMs: 5 }).of(CONTRACT))
      .rejects.toThrow(/whose state is not hex/);
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

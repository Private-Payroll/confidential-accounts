import { describe, expect, it } from 'vitest';
import { indexerContractHistory } from './contract-history.js';
import { indexerNoteEvents, indexerTransactionsByIdentifier, indexerVaultTransactions } from './indexer-queries.js';
import type { Hex } from '../core/crypto.js';

/*
 * A network reached with a project token carries it in the query of every
 * endpoint address, and a refusal about the indexer reaches the person who
 * asked. So every refusal that names the indexer names it without its query.
 */
const TOKEN = 'aProjectToken42';
const HTTP = `https://indexer.example/api/v0?project_id=${TOKEN}`;
const WS = `wss://indexer.example/api/v0/ws?project_id=${TOKEN}`;
const ADDRESS = 'ab'.repeat(32);
const unreachable = (() => Promise.reject(new Error('connect ECONNREFUSED'))) as unknown as typeof fetch;
const latestIs = (async () => new Response(JSON.stringify({
  data: { contractAction: { transaction: { hash: 'cd'.repeat(32) } } },
}))) as unknown as typeof fetch;
const noSocket = () => { throw new Error('socket refused'); };

const refusalOf = async (asked: () => Promise<unknown>): Promise<string> => {
  try { await asked(); } catch (e) { return (e as Error).message; }
  throw new Error('the indexer was unreachable and nothing was refused');
};

describe('a refusal about the indexer names it without the project token its address carries', () => {
  it('EVERY READ THAT CANNOT ASK THE INDEXER SAYS WHERE, WITHOUT THE QUERY', async () => {
    const said = [
      await refusalOf(() => indexerNoteEvents(HTTP, unreachable).eventsOf({ hash: 'cd'.repeat(32) as Hex })),
      await refusalOf(() => indexerTransactionsByIdentifier(HTTP, unreachable).byIdentifier('ef'.repeat(32))),
      await refusalOf(() => indexerVaultTransactions(HTTP, WS, { post: unreachable }).of(ADDRESS as Hex)),
      await refusalOf(() => indexerContractHistory(HTTP, WS, { post: unreachable }).latest(ADDRESS)),
      await refusalOf(() => indexerVaultTransactions(HTTP, WS, { post: latestIs, open: noSocket }).of(ADDRESS as Hex)),
      await refusalOf(() => indexerContractHistory(HTTP, WS, { post: latestIs, open: noSocket }).of(ADDRESS)),
    ];
    for (const text of said) {
      /* RED WHEN a refusal names the indexer with its query, which hands the
       * network's project token to whoever reads the refusal. */
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('project_id');
      /* And it still says which indexer, so the refusal stays one a person can act on. */
      expect(text).toContain('://indexer.example/api/v0');
    }
    expect(said.filter((t) => t.includes('wss://indexer.example/api/v0/ws'))).toHaveLength(2);
  });
});

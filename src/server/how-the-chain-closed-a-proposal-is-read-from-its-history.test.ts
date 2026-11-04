/**
 * **HOW THE CHAIN CLOSED A PROPOSAL IS READ FROM THE ACCOUNT'S OWN HISTORY**, with the account's reader of where each
 * proposal stands (`roundsOnChainIn`) stood in for by what each case says the chain shows.
 */
import { describe, it, expect, vi } from 'vitest';

const chain = vi.hoisted(() => ({ shows: undefined as unknown, asked: [] as string[] }));
vi.mock('../../packages/web-shared/src/governed-call-builder.js', () => ({
  roundsOnChainIn: (_d: unknown, _steps: unknown, ids: readonly string[]) => {
    chain.asked.push(...ids);
    return new Map(chain.shows === undefined ? [] : [[ids[0]!.toLowerCase(), chain.shows]]);
  },
}));

import { closedOnChain, type ClosedOnChainDeps } from './proposal-closed-on-chain.js';

const ID = 'AB'.repeat(32);
const deps = (history: ClosedOnChainDeps['history'] = async () => []): ClosedOnChainDeps => ({
  accountPure: {}, accountLedger: () => ({}), runtimeState: {}, ledger: {}, history,
});
const read = async (shows: unknown, history?: ClosedOnChainDeps['history']) => {
  chain.shows = shows;
  return closedOnChain(deps(history), 'ac'.repeat(32), ID);
};

describe('HOW THE CHAIN CLOSED A PROPOSAL', () => {
  it('is carried out when the calls that closed it carried it out, and withdrawn only when a withdrawal alone closed it', async () => {
    /* RED WHEN: a proposal closed by its carrying out is read as withdrawn, or the reverse. */
    expect(await read({ held: 'closed', approvals: 2, closedBy: ['setThreshold'] })).toBe('carried');
    expect(await read({ held: 'closed', approvals: 0, closedBy: ['cancel'] })).toBe('withdrawn');
    /* RED WHEN: a block where a withdrawal and a carrying out both touched it is taken as either. */
    expect(await read({ held: 'closed', approvals: 2, closedBy: ['cancel', 'setThreshold'] })).toBe('unknown');
    expect(await read({ held: 'closed', approvals: 2, closedBy: [] })).toBe('unknown');
  });

  it('is open or never held as the chain shows it, and unknown when the history is not read', async () => {
    expect(await read({ held: 'open', approvals: 1 })).toBe('open');
    expect(await read({ held: 'never', approvals: 0 })).toBe('never');
    /* RED WHEN: a history that could not be read closes a record. */
    expect(await read({ held: 'closed', closedBy: ['cancel'] }, async () => { throw new Error('the indexer did not answer'); })).toBe('unknown');
    expect(await read(undefined)).toBe('unknown');
  });
});

/**
 * The chain's time as this wallet reads it: the time of the newest block at the indexer it reads the company's account
 * from. A proposal's raise and a run's start are judged against it, never against this device's clock.
 */
import type { CompanyReach } from './company-reach.js';
/**
 * The time of the newest block, in milliseconds, at the indexer this wallet reads the company's account from. The
 * chain's time, never this device's clock, decides whether a proposal's raise may still land or a run has begun.
 */
export const chainTimeOf = (r: Pick<CompanyReach, 'builder' | 'account' | 'chain'>) => async (): Promise<number> => {
  if (r.builder.accountPresence === undefined) throw new Error('this wallet cannot read the chain\'s time.');
  return (await r.builder.accountPresence({ account: r.account, indexer: r.chain.indexer, transactions: [] })).blockTime;
};

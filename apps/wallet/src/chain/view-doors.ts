/*
 * WHERE THIS WALLET READS THE CHAIN AROUND A COMPANY'S VIEW. The view's own doors as the wallet builds them (who holds
 * the company, the account's call chain at one block), the wallet's indexer reads its screens and actions make before
 * any view exists, and the anchors a recovery reads, all come from here, so there is one named file where the wallet
 * reads the chain. Nothing here reaches the company's service.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import type { OwnChainReads } from '../../../../packages/web-shared/src/company-view-doors.js';
import type { CompanyChain } from '../actions/company-reach.js';
import { StepRefused } from '../actions/definition.js';

export { liveCompanyChain } from './company-chain.js';
export {
  contractsOnChain, deployFromIndexerAt, fromIndexerAt, holdersOnChain, labelInAccountState, labelOnAccount, seatsInAccountState, vaultOnChain,
  type HoldersOnChain, type LabelOnAccount, type VaultOnChain,
} from './company-label-on-chain.js';
export { accountAtOneBlockOver, accountPresenceAt } from '../../../../packages/web-shared/src/vault-on-chain-here.js';
/** The anchors the company's account holds on the chain, read through this wallet's builder and indexer. */
export { anchorsOnChainAt as companyAnchorsOnChain } from '../../../../packages/web-shared/src/records-anchored-here.js';

/** Thrown when this wallet's own indexer does not answer with the company's account at one block. */
export class AccountNotReadAtOneBlock extends Error {
  constructor() {
    super('this wallet could not read the company\'s account at one block, so nothing was built or sent.');
    this.name = 'AccountNotReadAtOneBlock';
  }
}

/**
 * What this wallet reads of the company on the chain for its view, itself and never as the service says it: the
 * account's call chain at one block through its own indexer. Nothing this wallet does reads a vault, its payouts, who
 * holds the account, a committee change or the vaults' keys through its view, so each of those is refused rather than
 * asked of the page.
 */
export const ownChainReadsOf = (chain: Pick<CompanyChain, 'callState'>, account: AccountAddress): OwnChainReads => {
  const notHere = (what: string) => async (): Promise<never> => {
    throw new Error(`this wallet reads ${what} on the chain itself, never through the page, and nothing was read.`);
  };
  return Object.freeze<OwnChainReads>({
    callState: async () => {
      const read = await chain.callState(account);
      if (read === null) throw new AccountNotReadAtOneBlock();
      return { ...read, account };
    },
    vaultChain: notHere('a vault'), payoutState: notHere('a vault\'s payouts'), authority: notHere('who holds the company\'s account'),
    committeeChange: notHere('a change of the committee'), vaultKeys: notHere('the vaults\' keys'),
  });
};

/** Who holds the company, read by this wallet off the chain; a refusal the wallet words is the step's. */
export const holdersOn = (chain: CompanyChain, account: AccountAddress, label: CompanyLabel) => async (): Promise<AccountHoldersRead> => {
  const now = await chain.holders(account, label);
  if ('key' in now) throw new StepRefused(now);
  return now;
};

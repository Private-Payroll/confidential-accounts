/*
 * The company's governed calls through a view of the company: every proposal filed and every step of one (a call sent,
 * approved, carried or charged, a retirement, a cancel, a close) is a write through the view, so the view's check runs
 * before it and the view forgets the lists and the chain it can change; the proposals and the account are read through
 * the view, and so are a proposal's standing and the account's calls on the chain.
 */
import { markedNothingSent, type GovernedCallService, type RoundOnThePage } from './governed-call-on-device.js';
import type { CompanyView } from './company-view.js';
import type { ProposalAct, RecordWrite } from './records-source.js';
import type { SealedAccount, SealedProposal } from '../../../src/core/types.js';

/** The view the calls follow: the step's current one. */
export interface GovernedView {
  current(): Pick<CompanyView<unknown>, 'company' | 'account' | 'list' | 'write' | 'standing' | 'callState'>;
}

/** The governed calls of the company `held` views, writing through it. */
export const governedCallServiceThrough = (held: GovernedView): GovernedCallService => {
  /* The service's answer to a proposal's route, as that route answers it: the proposal as the page shows it. */
  const written = (w: RecordWrite): Promise<RoundOnThePage> =>
    markedNothingSent(async () => (await held.current().write([w]))[0] as RoundOnThePage);
  const step = (act: ProposalAct) => (id: string, body: unknown) => written({ to: 'proposal', id, act, body });
  const ours = (accountId: string): void => {
    if (accountId !== held.current().company)
      throw new Error(
        `this company's proposals were asked about another company (${accountId}); nothing was read or sent.`
      );
  };
  return {
    callState: async (accountId) => {
      ours(accountId);
      return (await held.current().callState()) as Awaited<ReturnType<GovernedCallService['callState']>>;
    },
    standing: async (id) => (await held.current().standing(id)) as RoundOnThePage,
    send: step('send'),
    approve: step('approve'),
    retire: step('retirement'),
    cancel: step('cancel'),
    carry: step('carry'),
    charge: step('charge'),
    closed: step('closed'),
    file: async (accountId, body) => {
      ours(accountId);
      return written({ to: 'proposal-filed', body });
    },
    sealedProposals: async (accountId) => {
      ours(accountId);
      const listed = await held.current().list('proposals');
      if (!Array.isArray(listed)) throw new Error("the service did not answer with the company's proposals");
      return listed as SealedProposal[];
    },
    sealedAccount: async (accountId) => {
      ours(accountId);
      return (await held.current().account()) as SealedAccount;
    }
  };
};

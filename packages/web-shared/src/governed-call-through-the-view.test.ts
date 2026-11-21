/*
 * The company's governed calls through a view: a proposal filed or stepped is a write through the view, checked first
 * and making the view read the proposals again; the proposals, the account, a proposal's standing and the account's
 * calls on the chain are read through the view, once; and a call about another company is refused before anything is
 * read or sent.
 */
import { describe, expect, it } from 'vitest';
import { companyViewFor } from './company-view.js';
import { serviceSource, type ServiceCall } from './records-source.js';
import { treeKeptInMemory } from './tree-kept-here.js';
import { governedCallServiceThrough } from './governed-call-through-the-view.js';

const HOLDERS = { seats: ['aa'], approvals: 1, adoptedVaults: [], threshold: 1, committee: [], vaultThresholds: [], policyBar: null };

const aCompany = () => {
  const asked: string[] = [];
  const state = { proposals: [{ id: 'prp_1', accountId: 'acc_1' }] as unknown[], directory: 0 };
  const call: ServiceCall = async (path, init) => {
    const method = init?.method ?? 'GET';
    asked.push(`${method} ${path}`);
    if (path.endsWith('/directory')) return { filings: state.directory === 0 ? [] : [{ version: state.directory }] };
    if (path.endsWith('/manifest/newest')) return { versions: (JSON.parse(String(init?.body)) as { records: unknown[] }).records.map(() => 0) };
    if (path === '/api/accounts/acc_1/proposals' && method === 'GET') return state.proposals;
    if (path === '/api/accounts/acc_1/proposals') { state.proposals = [...state.proposals, { id: 'prp_2', accountId: 'acc_1' }]; return { id: 'prp_2' }; }
    if (path === '/api/accounts/acc_1') return { id: 'acc_1' };
    if (path === '/api/accounts/acc_1/call-state') return { account: 'ab', blockHash: 'cd' };
    return { approvalCount: 1 };
  };
  const view = companyViewFor(serviceSource(call, 'acc_1'), {
    holders: async () => HOLDERS, onChain: async () => { throw new Error('no anchors here'); },
    builder: { anchorHeads: async () => { throw new Error('no heads here'); } }, kept: () => treeKeptInMemory(),
  }, async () => { throw new Error('no held read here'); });
  const service = governedCallServiceThrough({ current: () => view });
  return { asked, state, view, service };
};

describe('A PROPOSAL IS FILED AND STEPPED THROUGH THE COMPANY\'S VIEW', () => {
  it('files and steps a proposal as writes through the view, and reads the proposals again after one', async () => {
    const c = aCompany();
    expect((await c.service.sealedProposals!('acc_1')).map((p) => p.id)).toEqual(['prp_1']);
    await c.service.file!('acc_1', { proposal: {} } as never);
    await c.service.approve('prp_2', { tx: 'AA', filer: 'ff' });
    /* RED WHEN: a filing or a step of a proposal goes around the view, unchecked, or to another route than the proposal's own. */
    expect(c.asked.filter((a) => a.startsWith('POST /api/accounts/acc_1/proposals') || a.startsWith('POST /api/proposals/'))).toEqual([
      'POST /api/accounts/acc_1/proposals', 'POST /api/proposals/prp_2/approve',
    ]);
    expect(c.asked.filter((a) => a.endsWith('/directory')).length).toBeGreaterThanOrEqual(3);
    /* RED WHEN: the view keeps the proposals it read before its own filing, so the step reads a list without the proposal it filed. */
    expect((await c.service.sealedProposals!('acc_1')).map((p) => p.id)).toEqual(['prp_1', 'prp_2']);
  });

  it('reads a proposal\'s standing and the account\'s calls on the chain through the view, once each', async () => {
    const c = aCompany();
    await c.service.standing('prp_1');
    await c.service.standing('prp_1');
    await c.service.callState('acc_1');
    await c.service.callState('acc_1');
    /* RED WHEN: a proposal's standing or the account's calls are read around the view, or once for every time asked. */
    expect(c.asked.filter((a) => a === 'POST /api/proposals/prp_1/standing')).toHaveLength(1);
    expect(c.asked.filter((a) => a === 'GET /api/accounts/acc_1/call-state')).toHaveLength(1);
    await expect(c.service.callState('acc_2')).rejects.toThrow(/another company/u);
  });

  it('stops a filing when the company changed since the view read it, and sends nothing', async () => {
    const c = aCompany();
    await c.service.sealedProposals!('acc_1');
    c.state.directory = 1;
    /* RED WHEN: a proposal is filed while another signer's change to the directory goes unseen. */
    await expect(c.service.file!('acc_1', { proposal: {} } as never)).rejects.toThrow(/Another signer changed the company/u);
    expect(c.asked.filter((a) => a === 'POST /api/accounts/acc_1/proposals')).toEqual([]);
  });

  it('refuses a call about another company before anything is read or sent', async () => {
    const c = aCompany();
    /* RED WHEN: a view of one company files or reads another company's proposals. */
    await expect(c.service.file!('acc_2', { proposal: {} } as never)).rejects.toThrow(/another company/u);
    await expect(c.service.sealedProposals!('acc_2')).rejects.toThrow(/another company/u);
    expect(c.asked).toEqual([]);
  });
});

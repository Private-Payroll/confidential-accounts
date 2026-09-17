import { describe, it, expect } from 'vitest';
import {
  approveOnDevice, governedCallServiceFor, nothingWasSentBy, raiseRunOnDevice, SentAndNotYetSeen, sendRaiseFromDevice,
  type GovernedCallDoors, type GovernedCallService, type RaiseOrderOnTheWire, type RoundOnThePage,
} from './governed-call-on-device.js';

/* The page's side, over a service and a worker that write down what they were asked, in order. */
const material = { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) };
const ORDER: RaiseOrderOnTheWire = {
  proposalId: 'prp_1', chainId: 'cc'.repeat(32),
  order: {
    circuit: 'propose',
    run: { root: '88'.repeat(32), payees: '3', opensAt: '1', closesAt: '2', vault: '99'.repeat(32) },
    half: { assetId: '44'.repeat(32), assetBlinding: '55'.repeat(32), proposalSalt: '66'.repeat(32), changeAmount: '1', changeBatchDigest: '77'.repeat(32) },
    proposal: 'cc'.repeat(32),
  },
};
const round = (over: Partial<RoundOnThePage> = {}): RoundOnThePage => ({ id: 'prp_1', chainId: 'cc'.repeat(32), status: 'open', ...over });

const aDevice = (over: Partial<GovernedCallService> & { standings?: RoundOnThePage[]; buildFails?: Error } = {}) => {
  const log: string[] = [];
  const standings = [...(over.standings ?? [])];
  const service: GovernedCallService = {
    raiseRun: async (runId, body) => { log.push(`raise ${runId} ${JSON.stringify(body)}`); return { proposal: round(), order: ORDER }; },
    raiseOrder: async (runId) => { log.push(`order ${runId}`); return ORDER; },
    sendRaise: async (runId, body) => { log.push(`send-raise ${runId} ${body.tx}`); return round({ txRef: 't1' }); },
    callState: async (id) => { log.push(`state ${id}`); return { account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }; },
    approve: async (id, body) => { log.push(`approve ${id} ${body.signature} ${body.tx}`); return round(); },
    standing: async (id) => { log.push(`standing ${id}`); return standings.shift() ?? round(); },
    ...over,
  };
  const doors: GovernedCallDoors = {
    service,
    builder: {
      governedCall: async (input) => {
        log.push(`build ${input.order.circuit} for ${input.account} on ${input.chain.accountState}`);
        if (JSON.stringify(input.material) !== JSON.stringify(material)) throw new Error('not this signer\'s material');
        if (over.buildFails) throw over.buildFails;
        return { tx: `TX-${input.order.circuit}` };
      },
    },
    material, accountId: 'acc_1',
    progress: (s) => log.push(`stage ${s}`),
    sleep: async () => {}, waitMs: 3, everyMs: 1,
  };
  return { log, doors };
};

describe('RAISING A LEG FROM THIS DEVICE', () => {
  it('writes the proposal down first, reads the chain, builds with this signer\'s material, sends, and waits until the chain holds it', async () => {
    const d = aDevice({ standings: [round({ txRef: 't1' }), round({ txRef: 't1', raisedAt: 'now' })] });
    const done = await raiseRunOnDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP', vault: '99'.repeat(32), opensAt: '1', closesAt: '2' });
    expect(done.raisedAt).toBe('now');
    /* RED WHEN: the order changes - above all, a build or a send before the proposal is written down. */
    expect(d.log).toEqual([
      'stage writing-down',
      `raise run_1 {"viewingKey":"vk","vault":"${'99'.repeat(32)}","opensAt":"1","closesAt":"2","asset":"GBP","onDevice":true}`,
      'stage reading-the-chain', 'state acc_1',
      'stage building', `build propose for ${'ac'.repeat(32)} on AS`,
      'stage sending', 'send-raise run_1 TX-propose',
      'stage waiting-for-the-chain', 'standing prp_1', 'standing prp_1',
    ]);
  });

  it('A PROPOSAL THE CHAIN ALREADY HOLDS IS NOT BUILT OR SENT AGAIN', async () => {
    const d = aDevice({ raiseRun: async () => ({ proposal: round({ raisedAt: 'then' }), order: null }) });
    const done = await raiseRunOnDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', vault: 'v', opensAt: '1', closesAt: '2' });
    expect(done.raisedAt).toBe('then');
    /* RED WHEN: a null order is built from anyway. */
    expect(d.log.filter((l) => l.startsWith('build') || l.startsWith('send'))).toEqual([]);
  });

  it('A BUILD THAT FAILS SENDS NOTHING, and the proposal written down can be sent again as itself', async () => {
    const d = aDevice({ buildFails: new Error('you are not a signer') });
    await expect(raiseRunOnDevice(d.doors, { runId: 'run_1', viewingKey: 'vk', vault: '99'.repeat(32), opensAt: '1', closesAt: '2' }))
      .rejects.toThrow('you are not a signer');
    expect(d.log.filter((l) => l.startsWith('send'))).toEqual([]);
    const again = aDevice({ standings: [round({ raisedAt: 'now' })] });
    await sendRaiseFromDevice(again.doors, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP' });
    /* RED WHEN: sending again asks for anything but the proposal already written down. */
    expect(again.log.filter((l) => !l.startsWith('stage'))).toEqual([
      'order run_1', 'state acc_1', `build propose for ${'ac'.repeat(32)} on AS`, 'send-raise run_1 TX-propose', 'standing prp_1',
    ]);
  });

  it('WHAT THE SERVICE HANDS OVER IS BUILT ONLY IF IT IS A RAISE OF THE PROPOSAL IT NAMES, WITH THE VAULT AND WINDOW CHOSEN HERE', async () => {
    const chosen = { runId: 'run_1', viewingKey: 'vk', vault: '99'.repeat(32), opensAt: '1', closesAt: '2' };
    for (const [why, order] of [
      ['an approval handed over as a raise', { ...ORDER, order: { circuit: 'approve', proposal: 'dd'.repeat(32) } }],
      ['a raise of another proposal', { ...ORDER, order: { ...ORDER.order, proposal: 'dd'.repeat(32) } }],
      ['another vault', { ...ORDER, order: { ...ORDER.order, run: { ...ORDER.order.run, vault: '98'.repeat(32) } } }],
      ['another window', { ...ORDER, order: { ...ORDER.order, run: { ...ORDER.order.run, closesAt: '3' } } }],
    ] as const) {
      const d = aDevice({ raiseRun: async () => ({ proposal: round(), order: order as unknown as RaiseOrderOnTheWire }) });
      /* RED WHEN: the device builds what it is handed without asking whether it is what the person chose. */
      await expect(raiseRunOnDevice(d.doors, chosen), why).rejects.toThrow(/Nothing was built or sent/u);
      expect(d.log.filter((l) => l.startsWith('build') || l.startsWith('send')), why).toEqual([]);
    }
    /* RED WHEN: sending a written-down proposal again builds an approval of it, named exactly as the proposal. */
    const resend = aDevice({ raiseOrder: async () => ({ ...ORDER, order: { circuit: 'approve', proposal: ORDER.chainId } as never }) });
    await expect(sendRaiseFromDevice(resend.doors, { runId: 'run_1', viewingKey: 'vk' })).rejects.toThrow(/not the proposal it wrote down/u);
    expect(resend.log.filter((l) => l.startsWith('build') || l.startsWith('send'))).toEqual([]);
    /* The vault is compared however it is spelled. */
    const ok = aDevice({ standings: [round({ raisedAt: 'now' })] });
    await raiseRunOnDevice(ok.doors, { ...chosen, vault: '99'.repeat(32).toUpperCase() });
  });

  it('A SEND THE CHAIN DOES NOT SHOW IN TIME IS SAID AS SENT AND NOT SEEN, NOT AS A FAILURE TO SEND', async () => {
    const d = aDevice();
    const late = await sendRaiseFromDevice(d.doors, { runId: 'run_1', viewingKey: 'vk' }).catch((e) => e);
    /* RED WHEN: a proposal that was sent is reported as not sent - a person then sends it again. */
    expect(late).toBeInstanceOf(SentAndNotYetSeen);
    expect(late.message).toMatch(/was sent and the chain has not shown it yet\. Do not send it again/u);
    expect(nothingWasSentBy(late)).toBe(false);
  });
});

describe('APPROVING FROM THIS DEVICE', () => {
  it('reads the standing first, builds the approval for the proposal\'s chain identity, sends it with the signature, and waits for one more', async () => {
    const counted = (n: number) => round({ raisedAt: 'x', approvalRound: { state: 'short', approvals: n } });
    const d = aDevice({ standings: [counted(1), counted(1), counted(2)] });
    const done = await approveOnDevice(d.doors, { round: round(), signerId: 'sgn_1', signature: 'SIG', viewingKey: 'vk' });
    expect(done.approvalRound?.approvals).toBe(2);
    expect(d.log.filter((l) => !l.startsWith('stage'))).toEqual([
      'standing prp_1', 'state acc_1', `build approve for ${'ac'.repeat(32)} on AS`, 'approve prp_1 SIG TX-approve',
      /* RED WHEN: the wait stops at a count the chain already had before this approval. */
      'standing prp_1', 'standing prp_1',
    ]);
  });

  it('AN APPROVAL IS BUILT ONLY FOR THE PROPOSAL THE PERSON WAS SHOWN', async () => {
    const d = aDevice({ standings: [round({ chainId: 'dd'.repeat(32) })] });
    /* RED WHEN: the device proves an approval of whatever id the service names now. */
    await expect(approveOnDevice(d.doors, { round: round(), signerId: 's', signature: 'S', viewingKey: 'vk' }))
      .rejects.toThrow(/another proposal than the one shown here/u);
    expect(d.log.filter((l) => l.startsWith('build') || l.startsWith('approve'))).toEqual([]);
  });

  it('a proposal the chain now calls approved ends the wait, and one that never counts it is sent and not seen', async () => {
    const d = aDevice({ standings: [round(), round({ status: 'approved' })] });
    expect((await approveOnDevice(d.doors, { round: round(), signerId: 's', signature: 'S', viewingKey: 'vk' })).status).toBe('approved');
    const never = aDevice({ standings: [round()] });
    await expect(approveOnDevice(never.doors, { round: round(), signerId: 's', signature: 'S', viewingKey: 'vk' }))
      .rejects.toBeInstanceOf(SentAndNotYetSeen);
  });

  it('A SERVICE REFUSAL KEEPS ITS OWN MARK OF WHETHER ANYTHING WAS SENT', async () => {
    const calls: string[] = [];
    const api = async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path} ${init?.body ?? ''}`);
      if (path.endsWith('/approve')) throw new Error('signature does not match. Nothing was sent.');
      if (path.endsWith('/raise-send')) throw new Error('the node dropped the connection');
      return {};
    };
    const service = governedCallServiceFor(api);
    /* RED WHEN: the mark is dropped - a refusal then reads as maybe sent, and a failure at the send as nothing sent. */
    expect(nothingWasSentBy(await service.approve('p 1', { signerId: 's', signature: 'S', viewingKey: 'vk', tx: 'T' }).catch((e) => e))).toBe(true);
    expect(nothingWasSentBy(await service.sendRaise('r1', { viewingKey: 'vk', tx: 'T' }).catch((e) => e))).toBe(false);
    await service.callState('acc 1');
    await service.standing('p 1', { viewingKey: 'vk' });
    /* RED WHEN: a key travels in an address rather than a body, or an id is not escaped. */
    expect(calls).toEqual([
      'POST /api/proposals/p%201/approve {"signerId":"s","signature":"S","viewingKey":"vk","tx":"T"}',
      'POST /api/runs/r1/raise-send {"viewingKey":"vk","tx":"T"}',
      'GET /api/accounts/acc%201/call-state ',
      'POST /api/proposals/p%201/standing {"viewingKey":"vk"}',
    ]);
  });
});

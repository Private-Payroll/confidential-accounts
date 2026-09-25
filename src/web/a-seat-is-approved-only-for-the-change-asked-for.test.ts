/**
 * **A DEVICE RAISES, APPROVES AND CARRIES OUT A SEAT ONLY FOR THE CHANGE THE
 * PERSON ASKED FOR.** The page's own module, `seatSignerOnDevice`, over a
 * service that answers what a test tells it to and a builder that writes down
 * every call it is asked for. The builder's own check that an approval's
 * proposal is the one its change and salt make is in `governed-call-builder.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { seatSignerOnDevice, type GovernanceRoundOnTheWire, type GovernedCallDoors } from './governed-call-on-device.js';
import type { GovernedCallOrder } from './governed-call-builder.js';

const LEAF = 'ab'.repeat(32);
const OTHER = 'ef'.repeat(32);
const SALT = 'cd'.repeat(32);
const ID = 'aa'.repeat(32);
const half = { assetId: '44'.repeat(32), assetBlinding: '55'.repeat(32), proposalSalt: SALT, changeAmount: '0', changeBatchDigest: '77'.repeat(32) };
const roundFor = (leaf: string, over: Partial<GovernanceRoundOnTheWire> = {}): GovernanceRoundOnTheWire => ({
  proposal: { id: 'prp_seat', chainId: ID, status: 'open', approvals: [] },
  asked: { governance: { kind: 'add-signer', leaf }, proposalSalt: SALT },
  order: { proposalId: 'prp_seat', chainId: ID, order: { circuit: 'propose', governance: { kind: 'add-signer', leaf }, half, proposal: ID } },
  ...over,
});

const aDevice = (answers: {
  round: GovernanceRoundOnTheWire; standing?: string; carry?: GovernedCallOrder;
}) => {
  const built: GovernedCallOrder[] = [];
  const sent: string[] = [];
  const doors: GovernedCallDoors = {
    service: {
      seatRound: async () => answers.round,
      sendGovernance: async () => { sent.push('raise'); return { id: 'prp_seat', chainId: ID, status: 'open', raisedAt: 'now' }; },
      /* Open until this device's approval is sent; then as the test says the chain counts it. */
      standing: async () => (sent.includes('approve')
        ? { id: 'prp_seat', chainId: ID, status: answers.standing ?? 'approved', raisedAt: 'now', approvalRound: { state: 'counted', approvals: 1 } }
        : { id: 'prp_seat', chainId: ID, status: 'open', raisedAt: 'now', approvalRound: { state: 'counted', approvals: 0 } }),
      approve: async () => { sent.push('approve'); return { id: 'prp_seat', chainId: ID, status: answers.standing ?? 'approved', raisedAt: 'now' }; },
      seatOrder: async () => ({ order: answers.carry ?? { circuit: 'amendSigner', leaf: LEAF, proposal: ID, proposalSalt: SALT } }),
      seat: async () => { sent.push('seat'); return {}; },
      callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
    } as unknown as GovernedCallDoors['service'],
    builder: { governedCall: async ({ order }) => { built.push(order); return { tx: 'TX' }; } },
    material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    accountId: 'acc_1',
    sleep: async () => {}, waitMs: 10, everyMs: 1,
  };
  const seat = () => seatSignerOnDevice(doors, {
    viewingKey: 'vk', signerId: 'sgn_ada', sign: () => 'sig', seat: { signerId: 'sgn_bo', leaf: LEAF },
  });
  return { seat, built, sent };
};

describe('A SEAT, FROM THIS DEVICE', () => {
  it('raises the proposal for the leaf asked for, approves it bound to that change and its salt, and carries it out', async () => {
    const d = aDevice({ round: roundFor(LEAF) });
    expect(await d.seat()).toEqual({ state: 'done' });
    expect(d.built.map((o) => o.circuit)).toEqual(['propose', 'approve', 'amendSigner']);
    /* RED WHEN: the approval is built without the change it approves, so the builder cannot refuse another proposal. */
    expect(d.built[1]).toEqual({ circuit: 'approve', proposal: ID, of: { governance: { kind: 'add-signer', leaf: LEAF }, proposalSalt: SALT } });
    expect(d.sent).toEqual(['raise', 'approve', 'seat']);
  });

  it('A PROPOSAL THE SERVICE SAYS SEATS SOMEBODY ELSE IS NEITHER RAISED NOR APPROVED', async () => {
    const d = aDevice({ round: roundFor(LEAF, { asked: { governance: { kind: 'add-signer', leaf: OTHER }, proposalSalt: SALT } }) });
    /* RED WHEN: the page approves whatever proposal the service names for the person asked about. */
    await expect(d.seat()).rejects.toThrow(/different change from the one asked for here/u);
    expect(d.built).toEqual([]);
    expect(d.sent).toEqual([]);
  });

  it('A RAISE HANDED OVER FOR ANOTHER LEAF IS NOT BUILT', async () => {
    const d = aDevice({ round: roundFor(LEAF, { order: roundFor(OTHER).order }) });
    /* RED WHEN: the page builds the raise it is handed without comparing it with the change asked for. */
    await expect(d.seat()).rejects.toThrow(/different proposal from the one asked for here/u);
    expect(d.built).toEqual([]);
  });

  it('A SEAT HANDED OVER FOR ANOTHER LEAF IS NOT BUILT, AFTER THE APPROVAL IT DID MAKE', async () => {
    const d = aDevice({ round: roundFor(LEAF), carry: { circuit: 'amendSigner', leaf: OTHER, proposal: ID, proposalSalt: SALT } });
    /* RED WHEN: the page carries out whatever seat it is handed on an approved proposal. */
    await expect(d.seat()).rejects.toThrow(/not the proposal asked for here/u);
    expect(d.built.map((o) => o.circuit)).toEqual(['propose', 'approve']);
    expect(d.sent).not.toContain('seat');
  });

  it('A PROPOSAL STILL SHORT OF APPROVALS IS LEFT FOR THE OTHERS, AND ONE ALREADY CARRIED OUT IS DONE', async () => {
    const short = aDevice({ round: roundFor(LEAF, { order: null }), standing: 'open' });
    expect((await short.seat()).state).toBe('waiting-for-approvals');
    expect(short.built.map((o) => o.circuit)).toEqual(['approve']);
    const done = aDevice({ round: { proposal: { id: 'prp_seat', chainId: ID, status: 'executed' }, asked: null, order: null } });
    expect(await done.seat()).toEqual({ state: 'done' });
    expect(done.built).toEqual([]);
  });
});

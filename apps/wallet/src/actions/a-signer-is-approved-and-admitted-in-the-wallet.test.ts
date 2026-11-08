import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import { SeatKeyNotFromTheInvitee } from '../../../../src/core/seat-invite-proof.js';
import { StepRefused, type StepContext } from './definition.js';
import { InvitationOutrun } from '../../../../packages/web-shared/src/governed-call-on-device.js';

/*
 * **A SIGNER INVITED BY ADDRESS IS APPROVED, AND THEN ADMITTED, FROM ANOTHER SEAT'S WALLET, ONE WINDOW EACH.** What the
 * two actions ask of the shared code (`approveSeatInvitationOnDevice` and `admitSignerHere`, stood in for here and
 * followed end to end against the service and the chain in
 * a-signer-invited-by-address-is-approved-and-admitted-from-another-seat.test.ts) is pinned: exactly what the window
 * showed, the wallet's own company keys and commitments, nothing read out, no route that raises a proposal, and the
 * words of every stop.
 */

const t = vi.hoisted(() => ({
  calls: [] as string[],
  approve: null as null | ((...a: any[]) => Promise<unknown>),
  admit: null as null | ((...a: any[]) => Promise<unknown>),
  rosterSigners: [] as unknown[],
  waitingSigners: [] as unknown[],
  called: [] as string[],
  approved: 0,
  filed: null as unknown,
  body: undefined as unknown,
  onChain: null as unknown,
}));
vi.mock('../../../../packages/web-shared/src/governed-call-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/governed-call-on-device.js')>()),
  approveSeatInvitationOnDevice: async (...a: any[]) => { t.calls.push('approve'); const done = await t.approve!(...a); t.approved += 1; return done; },
}));
vi.mock('../../../../packages/web-shared/src/roster-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/roster-here.js')>()),
  admitSignerHere: (...a: any[]) => { t.calls.push('admit'); return t.admit!(...a); },
  rosterHere: async () => { t.calls.push('roster'); return { account: { signers: t.rosterSigners }, opened: { signers: [...t.rosterSigners, ...t.waitingSigners] } }; },
}));
/* The checked reading of a listed add-signer record: by default it names this proposal's identity. */
vi.mock('../../../../src/core/proposal-filing.js', async (real) => ({
  ...(await real<typeof import('../../../../src/core/proposal-filing.js')>()),
  addSignerByAddressIn: () => (t.body === undefined ? { chainId: CHAIN_ID } : t.body),
}));
vi.mock('./upkeep.js', async (real) => {
  const actual = await real<typeof import('./upkeep.js')>();
  return {
    ...actual,
    upkeepSteps: (company: { reach: (c: unknown) => Promise<unknown>; renew: () => void }) => ({
      first: { title: { key: 'act.upkeep.step.first' }, run: async (c: unknown) => { t.calls.push('upkeep-first'); await company.reach(c); company.renew(); } },
      last: { title: { key: 'act.upkeep.step.last' }, run: async (c: unknown) => { t.calls.push('upkeep-last'); await company.reach(c); } },
    }),
  };
});

const { approveProposalAction } = await import('./approve-proposal.js');
/* No removal is carried out in these tests: the hook that changes the vault secrets after one is never reached. */
const AFTER_A_REMOVAL = { afterCarried: async (): Promise<never> => { throw new Error('no removal is carried out here'); } };
const { addSignerKind } = await import('./proposal-kinds.js');
const { admitSignerAction, ADMIT_STATE } = await import('./admit-signer.js');
const { ApprovalNotOwed, InvitationNotBound, NothingToApprove } = await import('../../../../packages/web-shared/src/governed-call-on-device.js');
const { runAction } = await import('./run.js');
const { FiledNotEntered } = await import('../../../../packages/web-shared/src/record-entered-here.js');
const { WaitingIdTaken } = await import('../../../../packages/web-shared/src/roster-here.js');
const { SeatNotReadOnTheChain } = await import('../../../../packages/web-shared/src/seat-not-read-on-the-chain.js');
const { governanceDoorsFor } = await import('./company-reach.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const ALL = MidnightCommitments.allVaults().toLowerCase();
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const SOURCES = { 'approve-proposal': readFileSync(new URL('./approve-proposal.ts', import.meta.url), 'utf8'), 'admit-signer': readFileSync(new URL('./admit-signer.ts', import.meta.url), 'utf8') };
const BASE = { record: 'acc_1', company: LABEL, account: ACCOUNT };
const APPROVE = { ...BASE, proposal: 'prp_abcdefghijkl', kind: 'add-signer', personName: 'Eve', role: 'approver', address: 'aa'.repeat(32), scope: ALL, coinKey: 'cc'.repeat(32) };
const ADMIT = { ...BASE, signer: 'sig_eve', personName: 'Eve' };
const intent = (name: string, fields: Record<string, string | undefined>): ActIntent => ({
  name, fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, string>,
}) as ActIntent;

/* The proposal's identity on the chain, and where the chain shows it at each read: one approval of the two it needs, then two. */
const CHAIN_ID = 'dd'.repeat(32);
/* Another add-signer proposal's identity, already at its bar. */
const OTHER = 'de'.repeat(32);
const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const reachOf = (signers: unknown[] = [], notBelieved: string[] = []) => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: ALL },
  leaf: 'aa'.repeat(32), companyKey: '11'.repeat(32), stepTo: () => {},
  api: async (path: string, init?: RequestInit) => {
    t.called.push(`${init?.method ?? 'GET'} ${path}`);
    return path === '/api/accounts/acc_1/proposals' ? [t.filed ?? { id: APPROVE.proposal, chainId: CHAIN_ID, accountId: 'acc_1' }] : [];
  },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({ seats: ['aa'.repeat(32)], committee: [], threshold: 1, approvals: 1, seatBar: 1, policyBar: null, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }),
  judges: {
    directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null, records: { history: new Map() } }),
    filingJudgeFor: () => async () => null, leavesFor: () => async () => [],
    rosterReadsFor: () => ({ filings: async () => [], holders: async () => ({ seats: [] }), anchored: async () => ({}), leaves: async () => [], invitedSeats: async () => ({}) }),
  },
  sealed: {}, companyKeys: KEYS,
  roster: async () => ({ id: 'acc_1', name: 'Acme', signers, notBelieved }),
  builder: { roundsOnChain: async ({ chainIds }: { chainIds: string[] }) => Object.fromEntries(chainIds.map((id) => [id, id === OTHER
    ? { held: 'open', approvals: 2, needed: 2, raisedAt: 1 } : t.onChain ?? { held: 'open', approvals: 1 + t.approved, needed: 2, raisedAt: 1 }])), companyWide: async () => 'cc'.repeat(32), runsOutrun: async () => ({}) },
  chain: { indexer: {}, callState: async () => ({ blockHash: 'b'.repeat(64), accountState: 'AS', parameters: 'PP' }) },
});
const ctxOf = (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret, account: 0 }, at: { step: 3, steps: 4 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('an approval and an admission are sent through their calls, never a bare relay'); },
    call: async (method: string, path: string) => { t.called.push(`${method} ${path}`); return { status: 404, body: {} }; }, tell: (x: Record<string, unknown>) => { told.push(x); },
    keyring: { open: () => ({ read: () => ({ accounts: {} }) }), keep: async () => {} },
  } as unknown as StepContext;
  return { ctx, told };
};
const reach = (signers: unknown[] = [], notBelieved: string[] = []) => ({
  chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, now: () => 0, secrets: () => ({}) as never,
  commitments: async () => MidnightCommitments as never, reachFor: async () => reachOf(signers, notBelieved) as never, ...AFTER_A_REMOVAL,
});
const run = async (a: ReturnType<typeof approveProposalAction>, i: ActIntent, ctx: StepContext): Promise<void> => {
  for (const step of a.steps(i)) await step.run(ctx);
};
const refusedWith = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return (e as StepRefused).words.key;
};
const refusalOf = async (p: Promise<unknown>): Promise<{ key: string; code: string | undefined }> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return { key: (e as StepRefused).words.key, code: (e as StepRefused).code };
};
/* Runs the act whole, as the wallet runs it for the page, and gives back the lines it writes to the page's report and its end. */
const ranWhole = async (def: ReturnType<typeof approveProposalAction>, i: ActIntent) => {
  const lines: string[] = [];
  const ended: unknown[] = [];
  await runAction({
    definition: def,
    request: {
      schema: 'midnight-identity/disclosure-request/v1', kind: 'act', requester: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
      purpose: 'A test.', nonce: 'n1', expiresAt: Date.now() + 20 * 60_000, hearsProgress: true, intent: i,
    } as never,
    channel: { step: () => true, relay: async () => 'relayed', answer: (a: unknown) => { ended.push(a); return true; } } as never,
    held: { identity, secret, account: 0 } as never, stop: new AbortController().signal, log: (line) => { lines.push(line); },
  });
  return { lines, ended };
};

beforeEach(() => {
  t.calls.length = 0;
  t.called.length = 0;
  t.approve = async () => ({ state: 'waiting-for-the-invitee', round: { id: 'prp_abcdefghijkl', approvalCount: 2 } });
  t.admit = async () => {};
  t.approved = 0;
  t.filed = null;
  t.body = undefined;
  t.onChain = null;
  t.rosterSigners = [];
  t.waitingSigners = [];
});

describe('A SIGNER INVITED BY ADDRESS IS APPROVED IN THE WALLET, EXACTLY AS THE WINDOW SHOWED', () => {
  it('the approval is asked of the shared code with what the window showed and the wallet\'s own keys, between the upkeep\'s two steps', async () => {
    let asked: any[] = [];
    t.approve = async (...a: any[]) => { asked = a; return { state: 'waiting-for-the-invitee', round: { id: 'p', approvalCount: 2 } }; };
    const { ctx, told } = ctxOf(intent('approve-proposal', APPROVE));
    await run(approveProposalAction(reach()), intent('approve-proposal', APPROVE), ctx);
    expect(t.calls).toEqual(['upkeep-first', 'approve', 'upkeep-last']);
    /* RED WHEN: the proposal approved is held to anything but what the window showed. */
    expect(asked[1].shown).toEqual({ proposal: APPROVE.proposal, name: 'Eve', role: 'approver', address: APPROVE.address, scope: ALL, coinPublicKey: APPROVE.coinKey });
    expect(Object.values(asked[1])).toContain(KEYS);
    /* RED WHEN: the coin key is held to an address by anything but the account's own commitments. */
    expect(asked[2]('cc'.repeat(32), '0d'.repeat(32))).toBe(MidnightCommitments.inviteAddressOf('cc'.repeat(32) as never, '0d'.repeat(32) as never));
    /* RED WHEN: the page is told a count or a bar the service or the shared code answered, not the chain's after the approval. */
    expect(told).toContainEqual({ state: 'waiting-for-the-invitee', approvals: 2, needed: 2 });
  });

  it('the proposal\'s identity is the one its signed filing and invitation name, never the one the service lists beside it', async () => {
    t.filed = { id: APPROVE.proposal, chainId: OTHER, accountId: 'acc_1' };
    const { ctx } = ctxOf(intent('approve-proposal', APPROVE));
    await run(approveProposalAction(reach()), intent('approve-proposal', APPROVE), ctx);
    /* RED WHEN: the service lists another proposal's identity, one at its bar, under this proposal's name, and the approval is skipped as if this one were. */
    expect(t.calls).toContain('approve');
    t.calls.length = 0;
    t.body = null;
    /* RED WHEN: a listed record whose signed filing or invitation does not check out is approved, or decides anything. */
    expect(await refusedWith(run(approveProposalAction(reach()), intent('approve-proposal', APPROVE), ctxOf(intent('approve-proposal', APPROVE)).ctx)))
      .toBe('act.approve-proposal.why.not-approved');
    expect(t.calls).not.toContain('approve');
  });

  it('a proposal the chain shows at its bar is not approved again, and the page is told its approvals and its bar from the chain', async () => {
    t.onChain = { held: 'open', approvals: 2, needed: 2, raisedAt: 1 };
    const { ctx, told } = ctxOf(intent('approve-proposal', APPROVE));
    await run(approveProposalAction(reach()), intent('approve-proposal', APPROVE), ctx);
    /* RED WHEN: a proposal another seat raised that already has the approvals the account needs is approved again, or the page is not told it waits for the invitee. */
    expect(t.calls).not.toContain('approve');
    expect(told).toContainEqual({ state: 'waiting-for-the-invitee', approvals: 2, needed: 2 });
  });

  it('a proposal filed and never raised on the chain, or one a removal has outrun, is not approved', async () => {
    for (const [onChain, says] of [[{ held: 'never', approvals: 0 }, 'act.approve-proposal.why.not-approved'],
      [{ held: 'open', approvals: 1, needed: 2, raisedAt: 1, outrun: true }, 'act.approve-proposal.why.outrun']] as const) {
      t.onChain = onChain;
      const { ctx } = ctxOf(intent('approve-proposal', APPROVE));
      /* RED WHEN: a proposal the chain never held is read as open and approved, or one the account will never carry out is approved. */
      expect(await refusedWith(run(approveProposalAction(reach()), intent('approve-proposal', APPROVE), ctx))).toBe(says);
    }
    expect(t.calls).not.toContain('approve');
  });

  it('an invitation a removal outran while it was being approved is never told as waiting for the invitee, and one the shared code finds outrun is refused as outrun', async () => {
    Object.defineProperty(t, 'onChain', {
      configurable: true, enumerable: true,
      get: () => (t.approved === 0 ? { held: 'open', approvals: 1, needed: 2, raisedAt: 1 } : { held: 'open', approvals: 2, needed: 2, raisedAt: 1, outrun: true }),
      set: () => {},
    });
    try {
      const { ctx, told } = ctxOf(intent('approve-proposal', APPROVE));
      await run(approveProposalAction(reach()), intent('approve-proposal', APPROVE), ctx);
      /* RED WHEN: an invitation that reached its bar after a signer was removed is told as waiting for the invitee, who can never take its seat. */
      expect(told).toContainEqual({ state: 'outrun', approvals: 2, needed: 2 });
      expect(told.some((x) => (x as { state?: string }).state === 'waiting-for-the-invitee')).toBe(false);
    } finally {
      delete (t as { onChain?: unknown }).onChain;
      t.onChain = null;
    }
    t.approved = 0;
    t.approve = async () => { throw new InvitationOutrun(); };
    const { ctx } = ctxOf(intent('approve-proposal', APPROVE));
    /* RED WHEN: the shared code's refusal of an outrun invitation is told as the wallet not approving, not as outrun with what to do next. */
    expect(await refusedWith(run(approveProposalAction(reach()), intent('approve-proposal', APPROVE), ctx))).toBe('act.approve-proposal.why.outrun');
  });

  it('RED WHEN: a proposal is approved that the wallet found changed, or found not raised, and the person is told it was', async () => {
    for (const e of [new InvitationNotBound('The proposal invites another person. Nothing was sent.'), new NothingToApprove()]) {
      t.approve = async () => { throw e; };
      const { ctx } = ctxOf(intent('approve-proposal', APPROVE));
      expect(await refusedWith(run(approveProposalAction(reach()), intent('approve-proposal', APPROVE), ctx))).toBe('act.approve-proposal.why.not-approved');
    }
  });

  /* RED WHEN: an approval the network already counts, or one of a proposal the network already carried out, is told as the wallet not approving, with no word of what to press next, or any other refusal is told in those words. */
  it('an approval already counted, and one of a proposal already carried out, are refused in words of their own that say to press Finish adding', async () => {
    const asked = async (e: unknown) => {
      t.approve = async () => { throw e; };
      const { ctx } = ctxOf(intent('approve-proposal', APPROVE));
      return refusedWith(run(approveProposalAction(reach()), intent('approve-proposal', APPROVE), ctx));
    };
    expect(await asked(new ApprovalNotOwed('counted'))).toBe('act.approve-proposal.why.already-counted');
    expect(await asked(new ApprovalNotOwed('carried-out'))).toBe('act.approve-proposal.why.carried-out');
    expect(await asked(new NothingToApprove())).toBe('act.approve-proposal.why.not-approved');
    expect(await asked(new Error('the role this seat holds may not approve'))).toBe('act.approve-proposal.why.not-approved');
    for (const k of ['already-counted', 'carried-out']) {
      expect(WORDS[`act.approve-proposal.why.${k}`]).toMatch(/nothing was sent/iu);
      expect(WORDS[`act.approve-proposal.why.${k}`]).toMatch(/press Finish adding/iu);
    }
  });

  /* RED WHEN: a refusal of an approval or an admission does not carry the kind of error that caused it, or carries anything but its class. */
  it('every refusal of an approval or an admission carries the kind of error that caused it, by its class alone', async () => {
    const approving = async (e: unknown) => {
      t.approve = async () => { throw e; };
      const { ctx } = ctxOf(intent('approve-proposal', APPROVE));
      return refusalOf(run(approveProposalAction(reach()), intent('approve-proposal', APPROVE), ctx));
    };
    expect(await approving(new NothingToApprove())).toEqual({ key: 'act.approve-proposal.why.not-approved', code: 'nothing-to-approve' });
    expect(await approving(new InvitationNotBound(`The coin key ${'cc'.repeat(32)} is not the one shown.`)))
      .toEqual({ key: 'act.approve-proposal.why.not-approved', code: 'invitation-not-bound' });
    expect(await approving(new ApprovalNotOwed('carried-out'))).toEqual({ key: 'act.approve-proposal.why.carried-out', code: 'approval-not-owed' });
    expect(await approving(Object.assign(new Error('you have already approved this proposal'), { name: 'CallNotBuilt' })))
      .toEqual({ key: 'act.approve-proposal.why.not-approved', code: 'call-not-built' });
    expect(await approving(new Error(`a key ${'dd'.repeat(32)}`))).toEqual({ key: 'act.approve-proposal.why.not-approved', code: 'error' });
    t.admit = async () => { throw new SeatNotReadOnTheChain(); };
    const { ctx } = ctxOf(intent('admit-signer', ADMIT));
    expect(await refusalOf(run(admitSignerAction(reach()), intent('admit-signer', ADMIT), ctx)))
      .toEqual({ key: 'act.admit-signer.why.chain-unread', code: 'seat-not-read-on-the-chain' });
  });

  /* RED WHEN: the line the wallet writes when an approval stops names only the generic refusal, and not the error that caused it; or it carries what the error said. */
  it('the wallet\'s line for an approval refused names the refusal and the kind of error that caused it, and nothing the error said', async () => {
    const SAID = `the proposal names ${'ee'.repeat(32)}`;
    t.approve = async () => { throw new NothingToApprove(); };
    const gone = await ranWhole(approveProposalAction(reach()), intent('approve-proposal', APPROVE));
    expect(gone.lines).toContain('action approve-proposal in the wallet: stopped at step 3 of 4: check-failed (relayed 0, unconfirmed 0) '
      + '(refused: act.approve-proposal.why.not-approved nothing-to-approve)');
    expect(gone.ended[0]).toMatchObject({ ended: 'stopped', refused: 'act.approve-proposal.why.not-approved', code: 'nothing-to-approve' });
    t.approve = async () => { throw new ApprovalNotOwed('carried-out'); };
    const done = await ranWhole(approveProposalAction(reach()), intent('approve-proposal', APPROVE));
    expect(done.lines).toContain('action approve-proposal in the wallet: stopped at step 3 of 4: check-failed (relayed 0, unconfirmed 0) '
      + '(refused: act.approve-proposal.why.carried-out approval-not-owed)');
    t.approve = async () => { throw new InvitationNotBound(SAID); };
    const bound = await ranWhole(approveProposalAction(reach()), intent('approve-proposal', APPROVE));
    expect(bound.lines.join('\n')).toContain('(refused: act.approve-proposal.why.not-approved invitation-not-bound)');
    expect(bound.lines.join('\n')).not.toContain('ee'.repeat(32));
  });

  it('RED WHEN: an approval is asked with any of what the window shows missing', async () => {
    for (const k of ['proposal', 'personName', 'role', 'address', 'scope', 'coinKey']) {
      expect((await approveProposalAction(reach()).check(intent('approve-proposal', { ...APPROVE, [k]: undefined }), {} as never))?.key)
        .toBe('act.approve-proposal.why.not-a-proposal');
    }
  });

  it('RED WHEN: an approval is asked for a role that is none of the four a seat may hold', async () => {
    for (const role of ['owner', 'Admin', 'admin ']) {
      expect((await approveProposalAction(reach()).check(intent('approve-proposal', { ...APPROVE, role }), {} as never))?.key)
        .toBe('act.approve-proposal.why.not-a-proposal');
    }
    expect(await approveProposalAction(reach()).check(intent('approve-proposal', APPROVE), {} as never)).toBeNull();
  });

  it('RED WHEN: the window does not show the role the seat is invited with, in words of its own for each role', async () => {
    for (const role of ['admin', 'approver', 'initiator', 'viewer']) {
      const lines = await approveProposalAction(reach()).shown(intent('approve-proposal', { ...APPROVE, role }));
      expect(lines.filter((l) => l.key.startsWith('act.approve-proposal.shown.role.')).map((l) => l.key)).toEqual([`act.approve-proposal.shown.role.${role}`]);
    }
  });

  it('a seat that sets a new threshold is shown with it, approved only at it, and asked with every vault\'s rights to count the seat by', async () => {
    const withThreshold = intent('approve-proposal', { ...APPROVE, threshold: '3' });
    const lines = await approveProposalAction(reach()).shown(withThreshold);
    /* RED WHEN: the window does not show the threshold the seat sets once taken, which the approvers approve with it. */
    expect(lines.find((l) => l.key === 'act.approve-proposal.shown.new-threshold')).toMatchObject({ values: { threshold: '3' }, from: 'page' });
    expect((await approveProposalAction(reach()).shown(intent('approve-proposal', APPROVE))).map((l) => l.key)).not.toContain('act.approve-proposal.shown.new-threshold');
    let asked: any[] = [];
    t.approve = async (...a: any[]) => { asked = a; return { state: 'waiting-for-the-invitee', round: { id: 'p', approvalCount: 2 } }; };
    const { ctx } = ctxOf(withThreshold);
    await run(approveProposalAction(reach()), withThreshold, ctx);
    /* RED WHEN: the shared code is not held to the threshold the window showed, or cannot count the new seat by the rights of every vault. */
    expect(asked[1].shown).toMatchObject({ threshold: '3' });
    expect(asked[3]).toEqual({ allVaults: ALL });
    /* RED WHEN: a threshold that is not a whole number of at least one is shown and asked. */
    for (const bad of ['-1', '1.5', 'x', '01']) {
      expect((await approveProposalAction(reach()).check(intent('approve-proposal', { ...APPROVE, threshold: bad }), {} as never))?.key, bad)
        .toBe('act.approve-proposal.why.not-a-threshold');
    }
  });

  it('the window shows every vault for a seat with the rights of every vault, and the rights themselves otherwise', async () => {
    const keys = async (i: ActIntent) => (await approveProposalAction(reach()).shown(i)).map((l) => l.key);
    expect(await keys(intent('approve-proposal', APPROVE))).toContain('act.approve-proposal.shown.every-vault');
    expect(await keys(intent('approve-proposal', { ...APPROVE, scope: '09'.repeat(32) }))).toContain('act.approve-proposal.shown.scope');
  });
});

describe('A SIGNER SEATED BY ADDRESS IS ADMITTED IN THE WALLET, WITH NOTHING READ OUT', () => {
  it('the admission is asked with nothing read out, the name the window showed and the account\'s commitments', async () => {
    let asked: any[] = [];
    t.admit = async (...a: any[]) => { asked = a; };
    const { ctx, told } = ctxOf(intent('admit-signer', ADMIT));
    await run(admitSignerAction(reach()), intent('admit-signer', ADMIT), ctx);
    expect(t.calls).toEqual(['upkeep-first', 'roster', 'admit', 'upkeep-last']);
    /* RED WHEN: an admission by address asks for a read-out, or admits someone other than the person the window named. */
    expect(asked[1]).toEqual({ signerId: 'sig_eve', readOut: '', name: 'Eve' });
    /* RED WHEN: the seat's coin key is recorded without the account's commitments to hold it to its address. */
    expect(asked[0].commitments).toBe(MidnightCommitments);
    expect(Object.values(asked[0])).toContain(KEYS);
    expect(told).toContainEqual({ state: ADMIT_STATE.admitted });
  });

  it('Finish adding runs while the seat it admits is one the roster names no signer for, and no vault\'s approvers are counted from that roster', async () => {
    const waiting = 'ee'.repeat(32);
    t.admit = async () => {};
    const { ctx, told } = ctxOf(intent('admit-signer', ADMIT));
    await run(admitSignerAction(reach([], [waiting])), intent('admit-signer', ADMIT), ctx);
    expect(t.calls).toEqual(['upkeep-first', 'roster', 'admit', 'upkeep-last']);
    expect(told).toContainEqual({ state: ADMIT_STATE.admitted });
    /* RED WHEN: who approves each vault is counted from a roster that names no signer for a seat the chain holds. */
    await expect(governanceDoorsFor(reachOf([], [waiting]) as never, async () => {}).approvers())
      .rejects.toThrow(/names no signer for 1 seat the company's account holds on the network, so it cannot count who approves each vault/u);
    const whole = await governanceDoorsFor(reachOf([{ id: 's1', status: 'active', leafCommitment: 'aa'.repeat(32) }]) as never, async () => {}).approvers();
    expect([...whole.seats.keys()]).toEqual(['aa'.repeat(32)]);
  });

  it('a signer the roster already holds, read through the roster that enters this seat\'s own lost filing again, is not admitted a second time', async () => {
    t.rosterSigners = [{ id: 'sig_eve', status: 'active' }];
    const { ctx, told } = ctxOf(intent('admit-signer', ADMIT));
    await run(admitSignerAction(reach()), intent('admit-signer', ADMIT), ctx);
    /* RED WHEN: taken up again after the admission was filed, the roster is filed again, or read where a lost entry is not entered again. */
    expect(t.calls).toEqual(['upkeep-first', 'roster', 'upkeep-last']);
    expect(told).toContainEqual({ state: ADMIT_STATE.alreadyAdmitted });
  });

  it('a seated entry under the id the service gave the person waiting is admitted already only when it holds their own seat', async () => {
    t.rosterSigners = [{ id: 'sig_eve', status: 'active', leafCommitment: 'aa'.repeat(32) }];
    t.waitingSigners = [{ id: 'sig_eve', status: 'pending', leafCommitment: 'AA'.repeat(32) }];
    const same = ctxOf(intent('admit-signer', ADMIT));
    await run(admitSignerAction(reach()), intent('admit-signer', ADMIT), same.ctx);
    /* RED WHEN: an admission taken up again, with the request still waiting beside the entry it filed, is filed again. */
    expect(t.calls).toEqual(['upkeep-first', 'roster', 'upkeep-last']);
    expect(same.told).toContainEqual({ state: ADMIT_STATE.alreadyAdmitted });
    t.calls.length = 0;
    t.waitingSigners = [{ id: 'sig_eve', status: 'pending', leafCommitment: 'bb'.repeat(32) }];
    t.admit = async () => { throw new WaitingIdTaken(); };
    const other = ctxOf(intent('admit-signer', ADMIT));
    /* RED WHEN: a seated signer's entry under the id the service gave the person waiting is told as their admission, and the person is told they were added. */
    expect(await refusedWith(run(admitSignerAction(reach()), intent('admit-signer', ADMIT), other.ctx))).toBe('act.admit-signer.why.id-taken');
    expect(t.calls).toEqual(['upkeep-first', 'roster', 'admit']);
    expect(other.told).not.toContainEqual({ state: ADMIT_STATE.alreadyAdmitted });
  });

  it('RED WHEN: a chain the wallet could not read for the seat taken is told as a seat that is not the invited person\'s', async () => {
    t.admit = async () => { throw new SeatNotReadOnTheChain(); };
    const { ctx } = ctxOf(intent('admit-signer', ADMIT));
    expect(await refusedWith(run(admitSignerAction(reach()), intent('admit-signer', ADMIT), ctx))).toBe('act.admit-signer.why.chain-unread');
    /* RED WHEN: the words for a chain not read tell the person to give up on the seat, rather than to press again. */
    expect(WORDS['act.admit-signer.why.chain-unread']).toMatch(/Press Finish adding again/u);
    expect(WORDS['act.admit-signer.why.chain-unread']).not.toMatch(/Do not give this person access|invite them again/u);
  });

  it('RED WHEN: an admission filed and not named in the records is told as one where nobody was admitted', async () => {
    t.admit = async () => { throw new FiledNotEntered('the connection dropped'); };
    const { ctx } = ctxOf(intent('admit-signer', ADMIT));
    expect(await refusedWith(run(admitSignerAction(reach()), intent('admit-signer', ADMIT), ctx))).toBe('act.admit-signer.why.filed-not-entered');
  });

  it('RED WHEN: a request that is not the invited person\'s is admitted, and the person is told it was', async () => {
    t.admit = async () => { throw new SeatKeyNotFromTheInvitee('This seat request is not for the person invited.'); };
    const { ctx } = ctxOf(intent('admit-signer', ADMIT));
    expect(await refusedWith(run(admitSignerAction(reach()), intent('admit-signer', ADMIT), ctx))).toBe('act.admit-signer.why.not-the-invited');
  });
});

describe('EACH ACTION CALLS ONLY THE ROUTES ITS INTENT LISTS, AND HAS ITS WORDS', () => {
  it('every route the approve and admit actions called themselves is one their intent lists', async () => {
    let doors: any = null;
    t.approve = async (...a: any[]) => { doors = a[0]; return { state: 'waiting-for-the-invitee', round: { id: 'p', approvalCount: 2 } }; };
    await run(approveProposalAction(reach()), intent('approve-proposal', APPROVE), ctxOf(intent('approve-proposal', APPROVE)).ctx);
    /* RED WHEN: an approval of a kind other than a removal files, raises or sends a proposal. */
    expect(t.called.filter((c) => /^POST \/api\/accounts\/[^\/]+\/proposals$|^POST \/api\/proposals\/[^\/]+\/send$/u.test(c))).toEqual([]);
    /* The doors the approval is handed are the action's own: the routes they reach are read by calling the ones an approval goes through. */
    await doors.service.approve(APPROVE.proposal, {});
    await doors.service.standing(APPROVE.proposal);
    await doors.service.sealedProposals('acc_1');
    const approved = t.called.slice();
    t.called.length = 0;
    await run(admitSignerAction(reach()), intent('admit-signer', ADMIT), ctxOf(intent('admit-signer', ADMIT)).ctx);
    const admitted = t.called.slice();
    /* RED WHEN: the approving wallet reaches the service by a route its intent does not list, which the wallet refuses only when it runs. */
    expect(approved).toContain(`POST /api/proposals/${APPROVE.proposal}/approve`);
    for (const [shape, called] of [[intentShapeOf('approve-proposal')!, approved], [intentShapeOf('admit-signer')!, admitted]] as const) {
      for (const c of called) expect(routeOf(shape, c.split(' ')[0]!, c.split(' ')[1]!), c).not.toBeNull();
    }
  });

  it('the routes each intent lists are the ones the shared code uses, an approval lists the raise only for the vault secrets after a removal, and every stop and line has its words', async () => {
    const approve = intentShapeOf('approve-proposal')!;
    for (const [m, p] of [['POST', '/api/proposals/prp_abcdefghijkl/approve'], ['POST', '/api/proposals/prp_abcdefghijkl/standing'],
      ['GET', '/api/accounts/acc_1/proposals'], ['POST', '/api/accounts/acc_1/manifest/entries']] as const) {
      expect(routeOf(approve, m, p), `${m} ${p}`).not.toBeNull();
    }
    /* The raise routes are listed only for a removal's hook, which raises each vault's secret run once this press carried the removal out. */
    expect(routeOf(approve, 'POST', '/api/accounts/acc_1/proposals')).not.toBeNull();
    expect(routeOf(approve, 'POST', '/api/proposals/prp_abcdefghijkl/send')).not.toBeNull();
    expect(routeOf(intentShapeOf('admit-signer')!, 'POST', '/api/accounts/acc_1/signers/sig_eve/admit')).not.toBeNull();
    const keys = new Set<string>();
    for (const [name, a, i] of [
      ['approve-proposal', approveProposalAction(reach()), [intent('approve-proposal', APPROVE), intent('approve-proposal', { ...APPROVE, scope: '09'.repeat(32) }),
        ...(['admin', 'initiator', 'viewer'] as const).map((role) => intent('approve-proposal', { ...APPROVE, role }))]],
      ['admit-signer', admitSignerAction(reach()), [intent('admit-signer', ADMIT)]],
    ] as const) {
      keys.add(`act.${name}.headline`);
      for (const c of a.checks) if (c.key.startsWith(`act.${name}`)) keys.add(c.key);
      for (const x of i) for (const line of await a.shown(x)) if (line.key.startsWith(`act.${name}`)) keys.add(line.key);
      for (const m of SOURCES[name].matchAll(/why\('([a-z-]+)'/gu)) keys.add(`act.${name}.why.${m[1]}`);
      for (const m of SOURCES[name].matchAll(/key: 'act\.[a-z-]+\.([a-z.-]+)'/gu)) keys.add(`act.${name}.${m[1]}`);
      for (const k of ['not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened']) keys.add(`act.${name}.why.${k}`);
      if (name === 'approve-proposal') {
        const kind = addSignerKind(reach() as never);
        for (const stop of ['not-approved', 'may-be-sent', 'withdrawn', 'closed', 'counted', 'not-raised', 'outrun'] as const) keys.add(kind.why(stop).key);
      }
    }
    /* RED WHEN: a stop or a line of either window has no words, and the person is shown a key. */
    expect([...keys].filter((k) => WORDS[k] === undefined)).toEqual([]);
  });
});

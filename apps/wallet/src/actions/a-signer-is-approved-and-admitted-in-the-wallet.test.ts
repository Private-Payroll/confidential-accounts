import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import { SeatKeyNotFromTheInvitee } from '../../../../src/core/seat-invite-proof.js';
import { StepRefused, type StepContext } from './definition.js';

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
}));
vi.mock('../../../../packages/web-shared/src/governed-call-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/governed-call-on-device.js')>()),
  approveSeatInvitationOnDevice: (...a: any[]) => { t.calls.push('approve'); return t.approve!(...a); },
}));
vi.mock('../../../../packages/web-shared/src/roster-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/roster-here.js')>()),
  admitSignerHere: (...a: any[]) => { t.calls.push('admit'); return t.admit!(...a); },
  rosterHere: async () => { t.calls.push('roster'); return { account: { signers: t.rosterSigners }, opened: { signers: [...t.rosterSigners, ...t.waitingSigners] } }; },
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

const { approveSignerAction } = await import('./approve-signer.js');
const { admitSignerAction, ADMIT_STATE } = await import('./admit-signer.js');
const { ApprovalNotOwed, InvitationNotBound, NothingToApprove } = await import('../../../../packages/web-shared/src/governed-call-on-device.js');
const { runAction } = await import('./run.js');
const { FiledNotEntered } = await import('../../../../packages/web-shared/src/record-entered-here.js');
const { SeatNotReadOnTheChain, WaitingIdTaken } = await import('../../../../packages/web-shared/src/roster-here.js');
const { governanceDoorsFor } = await import('./company-reach.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const ALL = MidnightCommitments.allVaults().toLowerCase();
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const SOURCES = { 'approve-signer': readFileSync(new URL('./approve-signer.ts', import.meta.url), 'utf8'), 'admit-signer': readFileSync(new URL('./admit-signer.ts', import.meta.url), 'utf8') };
const BASE = { record: 'acc_1', company: LABEL, account: ACCOUNT };
const APPROVE = { ...BASE, proposal: 'prp_abcdefghijkl', personName: 'Eve', role: 'approver', address: 'aa'.repeat(32), scope: ALL, coinKey: 'cc'.repeat(32) };
const ADMIT = { ...BASE, signer: 'sig_eve', personName: 'Eve' };
const intent = (name: string, fields: Record<string, string | undefined>): ActIntent => ({
  name, fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, string>,
}) as ActIntent;

const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const reachOf = (signers: unknown[] = [], notBelieved: string[] = []) => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: ALL },
  leaf: 'aa'.repeat(32), companyKey: '11'.repeat(32), stepTo: () => {},
  api: async (path: string, init?: RequestInit) => { t.called.push(`${init?.method ?? 'GET'} ${path}`); return []; },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({ seats: ['aa'.repeat(32)], committee: [], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }),
  judges: {
    directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null, records: { history: new Map() } }),
    filingJudgeFor: () => async () => null, leavesFor: () => async () => [],
    rosterReadsFor: () => ({ filings: async () => [], holders: async () => ({ seats: [] }), anchored: async () => ({}), leaves: async () => [], invitedSeats: async () => ({}) }),
  },
  sealed: {}, companyKeys: KEYS,
  roster: async () => ({ id: 'acc_1', name: 'Acme', signers, notBelieved }),
  builder: { roundsOnChain: async () => ({}), companyWide: async () => 'cc'.repeat(32) },
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
  chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {},
  commitments: async () => MidnightCommitments as never, reachFor: async () => reachOf(signers, notBelieved) as never,
});
const run = async (a: ReturnType<typeof approveSignerAction>, i: ActIntent, ctx: StepContext): Promise<void> => {
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
const ranWhole = async (def: ReturnType<typeof approveSignerAction>, i: ActIntent) => {
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
  t.rosterSigners = [];
  t.waitingSigners = [];
});

describe('A SIGNER INVITED BY ADDRESS IS APPROVED IN THE WALLET, EXACTLY AS THE WINDOW SHOWED', () => {
  it('the approval is asked of the shared code with what the window showed and the wallet\'s own keys, between the upkeep\'s two steps', async () => {
    let asked: any[] = [];
    t.approve = async (...a: any[]) => { asked = a; return { state: 'waiting-for-the-invitee', round: { id: 'p', approvalCount: 2 } }; };
    const { ctx, told } = ctxOf(intent('approve-signer', APPROVE));
    await run(approveSignerAction(reach()), intent('approve-signer', APPROVE), ctx);
    expect(t.calls).toEqual(['upkeep-first', 'approve', 'upkeep-last']);
    /* RED WHEN: the proposal approved is held to anything but what the window showed. */
    expect(asked[1].shown).toEqual({ proposal: APPROVE.proposal, name: 'Eve', role: 'approver', address: APPROVE.address, scope: ALL, coinPublicKey: APPROVE.coinKey });
    expect(Object.values(asked[1])).toContain(KEYS);
    /* RED WHEN: the coin key is held to an address by anything but the account's own commitments. */
    expect(asked[2]('cc'.repeat(32), '0d'.repeat(32))).toBe(MidnightCommitments.inviteAddressOf('cc'.repeat(32) as never, '0d'.repeat(32) as never));
    expect(told).toContainEqual({ state: 'waiting-for-the-invitee', approvals: 2 });
  });

  it('RED WHEN: a proposal is approved that the wallet found changed, or found not raised, and the person is told it was', async () => {
    for (const e of [new InvitationNotBound('The proposal invites another person. Nothing was sent.'), new NothingToApprove()]) {
      t.approve = async () => { throw e; };
      const { ctx } = ctxOf(intent('approve-signer', APPROVE));
      expect(await refusedWith(run(approveSignerAction(reach()), intent('approve-signer', APPROVE), ctx))).toBe('act.approve-signer.why.not-approved');
    }
  });

  /* RED WHEN: an approval the network already counts, or one of a proposal the network already carried out, is told as the wallet not approving, with no word of what to press next, or any other refusal is told in those words. */
  it('an approval already counted, and one of a proposal already carried out, are refused in words of their own that say to press Finish adding', async () => {
    const asked = async (e: unknown) => {
      t.approve = async () => { throw e; };
      const { ctx } = ctxOf(intent('approve-signer', APPROVE));
      return refusedWith(run(approveSignerAction(reach()), intent('approve-signer', APPROVE), ctx));
    };
    expect(await asked(new ApprovalNotOwed('counted'))).toBe('act.approve-signer.why.already-counted');
    expect(await asked(new ApprovalNotOwed('carried-out'))).toBe('act.approve-signer.why.carried-out');
    expect(await asked(new NothingToApprove())).toBe('act.approve-signer.why.not-approved');
    expect(await asked(new Error('the role this seat holds may not approve'))).toBe('act.approve-signer.why.not-approved');
    for (const k of ['already-counted', 'carried-out']) {
      expect(WORDS[`act.approve-signer.why.${k}`]).toMatch(/nothing was sent/iu);
      expect(WORDS[`act.approve-signer.why.${k}`]).toMatch(/press Finish adding/iu);
    }
  });

  /* RED WHEN: a refusal of an approval or an admission does not carry the kind of error that caused it, or carries anything but its class. */
  it('every refusal of an approval or an admission carries the kind of error that caused it, by its class alone', async () => {
    const approving = async (e: unknown) => {
      t.approve = async () => { throw e; };
      const { ctx } = ctxOf(intent('approve-signer', APPROVE));
      return refusalOf(run(approveSignerAction(reach()), intent('approve-signer', APPROVE), ctx));
    };
    expect(await approving(new NothingToApprove())).toEqual({ key: 'act.approve-signer.why.not-approved', code: 'nothing-to-approve' });
    expect(await approving(new InvitationNotBound(`The coin key ${'cc'.repeat(32)} is not the one shown.`)))
      .toEqual({ key: 'act.approve-signer.why.not-approved', code: 'invitation-not-bound' });
    expect(await approving(new ApprovalNotOwed('carried-out'))).toEqual({ key: 'act.approve-signer.why.carried-out', code: 'approval-not-owed' });
    expect(await approving(Object.assign(new Error('you have already approved this proposal'), { name: 'CallNotBuilt' })))
      .toEqual({ key: 'act.approve-signer.why.not-approved', code: 'call-not-built' });
    expect(await approving(new Error(`a key ${'dd'.repeat(32)}`))).toEqual({ key: 'act.approve-signer.why.not-approved', code: 'error' });
    t.admit = async () => { throw new SeatNotReadOnTheChain(); };
    const { ctx } = ctxOf(intent('admit-signer', ADMIT));
    expect(await refusalOf(run(admitSignerAction(reach()), intent('admit-signer', ADMIT), ctx)))
      .toEqual({ key: 'act.admit-signer.why.chain-unread', code: 'seat-not-read-on-the-chain' });
  });

  /* RED WHEN: the line the wallet writes when an approval stops names only the generic refusal, and not the error that caused it; or it carries what the error said. */
  it('the wallet\'s line for an approval refused names the refusal and the kind of error that caused it, and nothing the error said', async () => {
    const SAID = `the proposal names ${'ee'.repeat(32)}`;
    t.approve = async () => { throw new NothingToApprove(); };
    const gone = await ranWhole(approveSignerAction(reach()), intent('approve-signer', APPROVE));
    expect(gone.lines).toContain('action approve-signer in the wallet: stopped at step 3 of 4: check-failed (relayed 0, unconfirmed 0) '
      + '(refused: act.approve-signer.why.not-approved nothing-to-approve)');
    expect(gone.ended[0]).toMatchObject({ ended: 'stopped', refused: 'act.approve-signer.why.not-approved', code: 'nothing-to-approve' });
    t.approve = async () => { throw new ApprovalNotOwed('carried-out'); };
    const done = await ranWhole(approveSignerAction(reach()), intent('approve-signer', APPROVE));
    expect(done.lines).toContain('action approve-signer in the wallet: stopped at step 3 of 4: check-failed (relayed 0, unconfirmed 0) '
      + '(refused: act.approve-signer.why.carried-out approval-not-owed)');
    t.approve = async () => { throw new InvitationNotBound(SAID); };
    const bound = await ranWhole(approveSignerAction(reach()), intent('approve-signer', APPROVE));
    expect(bound.lines.join('\n')).toContain('(refused: act.approve-signer.why.not-approved invitation-not-bound)');
    expect(bound.lines.join('\n')).not.toContain('ee'.repeat(32));
  });

  it('RED WHEN: an approval is asked with any of what the window shows missing', async () => {
    for (const k of ['proposal', 'personName', 'role', 'address', 'scope', 'coinKey']) {
      expect((await approveSignerAction(reach()).check(intent('approve-signer', { ...APPROVE, [k]: undefined }), {} as never))?.key)
        .toBe('act.approve-signer.why.not-a-proposal');
    }
  });

  it('RED WHEN: an approval is asked for a role that is none of the four a seat may hold', async () => {
    for (const role of ['owner', 'Admin', 'admin ']) {
      expect((await approveSignerAction(reach()).check(intent('approve-signer', { ...APPROVE, role }), {} as never))?.key)
        .toBe('act.approve-signer.why.not-a-proposal');
    }
    expect(await approveSignerAction(reach()).check(intent('approve-signer', APPROVE), {} as never)).toBeNull();
  });

  it('RED WHEN: the window does not show the role the seat is invited with, in words of its own for each role', async () => {
    for (const role of ['admin', 'approver', 'initiator', 'viewer']) {
      const lines = await approveSignerAction(reach()).shown(intent('approve-signer', { ...APPROVE, role }));
      expect(lines.filter((l) => l.key.startsWith('act.approve-signer.shown.role.')).map((l) => l.key)).toEqual([`act.approve-signer.shown.role.${role}`]);
    }
  });

  it('the window shows every vault for a seat with the rights of every vault, and the rights themselves otherwise', async () => {
    const keys = async (i: ActIntent) => (await approveSignerAction(reach()).shown(i)).map((l) => l.key);
    expect(await keys(intent('approve-signer', APPROVE))).toContain('act.approve-signer.shown.every-vault');
    expect(await keys(intent('approve-signer', { ...APPROVE, scope: '09'.repeat(32) }))).toContain('act.approve-signer.shown.scope');
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
    await run(approveSignerAction(reach()), intent('approve-signer', APPROVE), ctxOf(intent('approve-signer', APPROVE)).ctx);
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
    for (const [shape, called] of [[intentShapeOf('approve-signer')!, approved], [intentShapeOf('admit-signer')!, admitted]] as const) {
      for (const c of called) expect(routeOf(shape, c.split(' ')[0]!, c.split(' ')[1]!), c).not.toBeNull();
    }
  });

  it('the routes each intent lists are the ones the shared code uses, an approval lists none that raises a proposal, and every stop and line has its words', async () => {
    const approve = intentShapeOf('approve-signer')!;
    for (const [m, p] of [['POST', '/api/proposals/prp_abcdefghijkl/approve'], ['POST', '/api/proposals/prp_abcdefghijkl/standing'],
      ['GET', '/api/accounts/acc_1/proposals'], ['POST', '/api/accounts/acc_1/manifest/entries']] as const) {
      expect(routeOf(approve, m, p), `${m} ${p}`).not.toBeNull();
    }
    /* RED WHEN: the approving wallet may file or send a raise, so a page could make it raise a proposal it did not mean to. */
    expect(routeOf(approve, 'POST', '/api/accounts/acc_1/proposals')).toBeNull();
    expect(routeOf(approve, 'POST', '/api/proposals/prp_abcdefghijkl/send')).toBeNull();
    expect(routeOf(intentShapeOf('admit-signer')!, 'POST', '/api/accounts/acc_1/signers/sig_eve/admit')).not.toBeNull();
    const keys = new Set<string>();
    for (const [name, a, i] of [
      ['approve-signer', approveSignerAction(reach()), [intent('approve-signer', APPROVE), intent('approve-signer', { ...APPROVE, scope: '09'.repeat(32) }),
        ...(['admin', 'initiator', 'viewer'] as const).map((role) => intent('approve-signer', { ...APPROVE, role }))]],
      ['admit-signer', admitSignerAction(reach()), [intent('admit-signer', ADMIT)]],
    ] as const) {
      keys.add(`act.${name}.headline`);
      for (const c of a.checks) if (c.key.startsWith(`act.${name}`)) keys.add(c.key);
      for (const x of i) for (const line of await a.shown(x)) if (line.key.startsWith(`act.${name}`)) keys.add(line.key);
      for (const m of SOURCES[name].matchAll(/why\('([a-z-]+)'/gu)) keys.add(`act.${name}.why.${m[1]}`);
      for (const m of SOURCES[name].matchAll(/key: 'act\.[a-z-]+\.([a-z.-]+)'/gu)) keys.add(`act.${name}.${m[1]}`);
      for (const k of ['not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened']) keys.add(`act.${name}.why.${k}`);
    }
    /* RED WHEN: a stop or a line of either window has no words, and the person is shown a key. */
    expect([...keys].filter((k) => WORDS[k] === undefined)).toEqual([]);
  });
});

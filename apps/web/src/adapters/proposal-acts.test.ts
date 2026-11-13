// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ProposalRow } from './company-records.js';

type Row = ProposalRow;
import { thresholdProblem } from 'vaults-web-shared/proposal-in-the-wallet.js';
import { ACT_REFUSAL } from './refusals.js';
import type { ProposalActed } from './proposal-acts.js';

/*
 * THE PROPOSALS ADAPTER'S WALLET ACTS: what is asked of the wallet for an approval, for a withdrawal, for a change of the
 * approvals the company needs, to raise a one-off payment, which rows are offered each, and what the wallet's stops come to.
 */
const kr = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null, acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown,
  named: { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) } as unknown, calls: 0, throws: null as Error | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => kr.named,
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => {
    kr.calls += 1;
    kr.acts.push(intent);
    if (kr.throws !== null) throw kr.throws;
    return kr.ended;
  },
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./proposal-acts.js');
}
const row = (over: Partial<Row> = {}): Row => ({
  id: 'prop_0001', kind: 'pay-key', status: 'open', raisedBy: 'Sam', approvals: 1, needed: 2, raisedAt: '2026-10-21T00:00:00.000Z', pays: null, ...over,
});
const stopped = (refused?: string) => ({ of: 'stopped', step: 3, steps: 4, relayed: 0, unconfirmed: 0, why: refused === undefined ? 'relay-refused' : 'check-failed', ...(refused === undefined ? {} : { refused }) });

describe('withdrawing a run and paying a leg', () => {
  /*
   * RED WHEN: a run is withdrawable only by the seat that raised it, though the account lets any seated signer withdraw a run before its
   * payment window opens; or a run no longer waiting is offered Withdraw; or a change to the company, or a one-off payment, is offered to
   * a signer who did not raise it.
   */
  it('offers Withdraw on a waiting run to any seated signer, and on a change to the company only to its raiser', async () => {
    const m = await load();
    for (const status of ['open', 'approved'] as const) {
      expect(m.canWithdraw(row({ kind: 'payroll', status, raisedByYou: false })), status).toBe(true);
      expect(m.canWithdraw(row({ kind: 'payroll', status })), status).toBe(true);
      expect(m.canWithdraw(row({ kind: 'payroll', status, raisedByYou: true })), status).toBe(true);
    }
    for (const status of ['executed', 'cancelled', 'rejected', 'blocked', 'unreadable'] as const) expect(m.canWithdraw(row({ kind: 'payroll', status, raisedByYou: true })), status).toBe(false);
    for (const kind of ['add-signer', 'remove-signer', 'set-threshold', 'transfer'] as const) expect(m.canWithdraw(row({ kind, raisedByYou: false })), kind).toBe(false);
  });

  const leg = (over: Record<string, unknown> = {}) => ({ proposal: 'p1', form: 'shielded' as const, paidOnChain: 0 as 0 | 1 | 2 | undefined, ...over });
  const read = (...rows: Row[]) => ({ of: 'read' as const, value: rows });
  /*
   * RED WHEN: Pay is offered before the chain shows the run approved, while the proposals are not read, on a leg the chain shows paid in
   * full or has not been read for, on a leg with no proposal or no form; or is not offered once approved, on a leg partly paid, or on a
   * retry approved like a run.
   */
  it('offers Pay only for a leg whose proposal the chain shows approved and that the chain does not show paid', async () => {
    const m = await load();
    const open = row({ id: 'p1', kind: 'payroll', status: 'open' });
    const approved = row({ id: 'p1', kind: 'payroll', status: 'approved' });
    expect(m.canPay(leg(), read(open))).toBe(false);
    expect(m.canPay(leg(), read(approved))).toBe(true);
    expect(m.canPay(leg(), read(row({ id: 'other', kind: 'payroll', status: 'approved' })))).toBe(false);
    expect(m.canPay(leg(), { of: 'unreadable' })).toBe(false);
    expect(m.canPay(leg({ paidOnChain: 2 }), read(approved))).toBe(false);
    expect(m.canPay(leg({ paidOnChain: 1 }), read(approved))).toBe(true);
    expect(m.canPay(leg({ paidOnChain: undefined }), read(approved))).toBe(false);
    expect(m.canPay(leg({ proposal: null }), read(approved))).toBe(false);
    expect(m.canPay(leg({ form: null }), read(approved))).toBe(false);
    /* A retry is a leg with its own proposal: payable once its own proposal is approved, whatever the leg's own is. */
    const retry = leg({ proposal: 'p3' });
    expect(m.canPay(retry, read(approved, row({ id: 'p3', kind: 'payroll', status: 'open' })))).toBe(false);
    expect(m.canPay(retry, read(open, row({ id: 'p3', kind: 'payroll', status: 'approved' })))).toBe(true);
    expect(m.canPay({ ...retry, paidOnChain: 2 }, read(row({ id: 'p3', kind: 'payroll', status: 'approved' })))).toBe(false);
  });
});

describe('approving a proposal from the list', () => {
  /* RED WHEN: the wallet is asked to approve a proposal other than the one pressed, or under a kind other than the proposal's. */
  it('asks the wallet to approve exactly the proposal pressed, by its id and kind', async () => {
    const m = await load();
    kr.acts.length = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'approved', approvals: 2, needed: 2 } };
    expect(await m.approveProposal('u1', 'acc_Company00001', row())).toEqual({ of: m.PROPOSAL_ACTED.done, state: 'approved', approvals: 2, needed: 2 } satisfies ProposalActed);
    expect(kr.acts).toEqual([{ name: m.PROPOSAL_ACT.approve, record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32), proposal: 'prop_0001', kind: 'pay-key' }]);
  });

  /* RED WHEN: a count or an amount the row carries reaches the wallet as anything but a whole number in decimal, or a field the row carries stands in for the proposal or its kind. */
  it('hands the wallet a count and an amount as whole numbers in decimal, and no field over the proposal or its kind', async () => {
    const m = await load();
    kr.acts.length = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'approved', approvals: 1, needed: 2 } };
    await m.approveProposal('u1', 'acc_Company00001', row({ kind: 'payroll', asks: { run: 'r9', payees: 2, total: 12_000_000_000_000_000_000n, proposal: 'other', name: 'x' } }));
    expect(kr.acts).toEqual([{
      name: m.PROPOSAL_ACT.approve, record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32), proposal: 'prop_0001', kind: 'payroll',
      run: 'r9', payees: '2', total: '12000000000000000000',
    }]);
  });

  /* RED WHEN: an approval leaves out a field the row carries for the wallet, sends one the row does not carry, or names the proposal's kind other than the wallet's own name for it. */
  it('asks the wallet to approve every kind under its own name, with the fields the row carries', async () => {
    const m = await load();
    const asks = { vault: 'v1', token: 'ab', amount: '5', payee: 'cd', reason: 'rent' };
    for (const [kind, wallet] of [
      ['transfer', 'one-off'], ['payroll', 'payroll'], ['add-signer', 'add-signer'], ['remove-signer', 'removal'], ['set-threshold', 'threshold'],
      ['set-vault-threshold', 'vault-threshold'], ['adopt-vault', 'adopt-vault'], ['vault-secret', 'vault-secret'], ['pay-key', 'pay-key'],
      ['set-spending-policy', 'spending-policy'], ['set-policy-bar', 'policy-bar'],
    ] as const) {
      kr.acts.length = 0; kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'approved', approvals: 1, needed: 2 } };
      await m.approveProposal('u1', 'acc_Company00001', row({ kind, asks }));
      expect(kr.acts, kind).toEqual([{ name: m.PROPOSAL_ACT.approve, record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32), proposal: 'prop_0001', kind: wallet, ...asks }]);
    }
  });

  /* RED WHEN: Approve is offered on a proposal that is not waiting, on one of a kind the wallet does not know, or on a kind whose details the wallet shows and the row does not carry; or an approval of such a row reaches the wallet. */
  it('offers Approve only on a waiting proposal the wallet can be told enough about, and asks the wallet for nothing otherwise', async () => {
    const m = await load();
    kr.calls = 0;
    const asks = { vault: 'v1' };
    expect([
      row(), row({ status: 'approved' }), row({ status: 'executed' }), row({ status: 'cancelled' }), row({ kind: 'unreadable', status: 'unreadable' }),
      row({ kind: 'payroll' }), row({ kind: 'payroll', asks }), row({ kind: 'set-spending-policy', asks }), row({ kind: 'set-policy-bar', asks: { bar: 2 } }), row({ kind: 'set-policy-bar' }),
    ].map(m.canApprove)).toEqual([true, false, false, false, false, false, true, true, true, false]);
    expect(await m.approveProposal('u1', 'acc_Company00001', row({ kind: 'payroll' }))).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(kr.calls).toBe(0);
  });

  /*
   * RED WHEN: a stop the wallet says may have sent part of it is told as a refusal that sent nothing, or a refusal that
   * sent nothing (a proposal not as shown, of any kind, under the kind's own name; a code this page does not know; a stop
   * with no refusal) is told as one that may have gone part of the way; or the wallet's own reason is lost.
   */
  it('gives back the wallet\'s reason under whichever name it refused, and says part may have gone only where the wallet says so', async () => {
    const m = await load();
    for (const [refused, why, partial] of [
      ['act.approve-proposal.why.not-approved', 'not-approved', false], ['act.approve-proposal.why.may-be-sent', 'may-be-sent', true],
      ['act.approve-proposal.why.already-counted', 'already-counted', false], ['act.approve-proposal.why.no-seat', 'seat', false],
      [undefined, 'stopped', false], ['act.approve-proposal.why.nobody-knows', 'other', false], ['act.withdraw-proposal.why.no-seat', 'seat', false],
      ['act.one-off-payment.why.not-as-shown', 'not-as-shown', false], ['act.raise-run.why.not-as-shown', 'not-as-shown', false],
      ['act.remove-signer.why.not-as-shown', 'not-as-shown', false], ['act.approve-pay-key.why.not-as-held', 'not-as-shown', false],
      ['act.change-threshold.why.not-raised', 'not-raised', false], ['act.approve-policy.why.outrun', 'outrun', false],
      ['act.one-off-payment.why.closed', 'closed', false], ['act.approve-proposal.why.run-closed', 'closed', false],
      ['act.one-off-payment.why.approval-may-be-sent', 'may-be-sent', true], ['act.remove-signer.why.not-carried', 'may-be-sent', true],
      ['act.one-off-payment.why.charge-may-be-sent', 'may-be-sent', true], ['act.one-off-payment.why.nobody-knows', 'other', false],
    ] as const) {
      kr.ended = stopped(refused);
      expect(await m.approveProposal('u1', 'acc_Company00001', row()), why).toEqual({ of: m.PROPOSAL_ACTED.stopped, act: m.PROPOSAL_ACT.approve, why, partial, handedOver: false } satisfies ProposalActed);
    }
  });
});

describe('withdrawing a proposal from the list', () => {
  /* RED WHEN: the wallet is asked to withdraw a proposal other than the one pressed, or under a kind other than the wallet's name for it. */
  it('asks the wallet to withdraw exactly the proposal pressed, under the wallet\'s name for its kind', async () => {
    const m = await load();
    for (const [kind, wallet] of [['add-signer', 'add-signer'], ['remove-signer', 'removal'], ['set-threshold', 'threshold'], ['set-vault-threshold', 'vault-threshold'], ['payroll', 'payroll'], ['transfer', 'one-off'], ['set-spending-policy', 'spending-policy'], ['set-policy-bar', 'policy-bar']] as const) {
      kr.acts.length = 0; kr.ended = { of: 'done', steps: 3, relayed: 1, outcome: { state: 'withdrawn', proposal: 'prop_0001' } };
      expect(await m.withdrawProposal('u1', 'acc_Company00001', row({ kind })), kind).toMatchObject({ of: m.PROPOSAL_ACTED.done, state: 'withdrawn' });
      expect(kr.acts, kind).toEqual([{ name: m.PROPOSAL_ACT.withdraw, record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32), proposal: 'prop_0001', kind: wallet }]);
    }
  });

  /*
   * RED WHEN: Withdraw is offered on a kind the wallet never withdraws, on a proposal no longer waiting, for a change to the company or a
   * one-off payment to anyone but the seat whose key signed its believed filing (a signer of the same name included), or to a raiser this
   * device does not believe.
   */
  it('offers Withdraw on a change to the company only to the seat that filed it, never by name, and never on a kind the wallet refuses', async () => {
    const m = await load();
    for (const kind of ['add-signer', 'set-threshold', 'set-vault-threshold', 'remove-signer', 'transfer', 'set-spending-policy', 'set-policy-bar'] as const) {
      expect(m.canWithdraw(row({ kind, raisedByYou: true })), kind).toBe(true);
      expect(m.canWithdraw(row({ kind, raisedByYou: false })), kind).toBe(false);
      expect(m.canWithdraw(row({ kind })), kind).toBe(false);
    }
    expect(m.canWithdraw(row({ kind: 'remove-signer', raisedByYou: true, raiserNotBelieved: 'seat-retired' }))).toBe(false);
    expect(m.canWithdraw(row({ kind: 'add-signer', raisedByYou: true, status: 'executed' }))).toBe(false);
    for (const kind of ['pay-key', 'adopt-vault', 'vault-secret', 'unreadable'] as const) expect(m.canWithdraw(row({ kind, raisedByYou: true })), kind).toBe(false);
  });

  /*
   * RED WHEN: the wallet's reasons for a withdrawal it refused are told as an approval's, a held one-off is told as a
   * reason this page does not know, or a withdrawal the wallet refused with nothing signed or sent is told as one that
   * may have gone part of the way.
   */
  it('gives back the wallet\'s reason for a withdrawal, and says part may have gone only where the wallet says so', async () => {
    const m = await load();
    for (const [refused, why, partial] of [
      ['act.withdraw-proposal.why.one-off-held', 'one-off-held', false], ['act.withdraw-proposal.why.not-withdrawn', 'not-withdrawn', false],
      ['act.withdraw-proposal.why.may-be-sent', 'may-be-sent', true], ['act.withdraw-proposal.why.never-pay-key', 'not-withdrawn', false],
      ['act.withdraw-proposal.why.closed', 'closed', false], ['act.withdraw-proposal.why.started', 'not-withdrawn', false],
      ['act.withdraw-proposal.why.filed-by-another', 'not-withdrawn', false], ['act.withdraw-proposal.why.may-still-land', 'not-withdrawn', false],
      ['act.withdraw-proposal.why.not-as-shown', 'not-as-shown', false], ['act.approve-proposal.why.not-approved', 'other', false],
    ] as const) {
      kr.ended = stopped(refused);
      expect(await m.withdrawProposal('u1', 'acc_Company00001', row({ kind: 'payroll' })), why).toEqual({ of: m.PROPOSAL_ACTED.stopped, act: m.PROPOSAL_ACT.withdraw, why, partial, handedOver: false } satisfies ProposalActed);
    }
  });
});

describe('before either act reaches the wallet', () => {
  /* RED WHEN: a person who is not signed in, a company that cannot be read, or a wallet that cannot be reached is told as anything but its own refusal, or reaches the wallet. */
  it('asks the wallet for nothing when nobody is signed in or the company cannot be read', async () => {
    const m = await load();
    kr.calls = 0; kr.throws = null; kr.user = null;
    expect(await m.approveProposal('u1', 'acc_Company00001', row())).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    expect(await m.withdrawProposal('u1', 'acc_Company00001', row({ kind: 'payroll' }))).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    kr.user = { id: 'u1' }; kr.named = {};
    expect(await m.withdrawProposal('u1', 'acc_Company00001', row({ kind: 'payroll' }))).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(kr.calls).toBe(0);
    kr.named = { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) };
    kr.throws = new TypeError('fetch failed');
    expect(await m.approveProposal('u1', 'acc_Company00001', row())).toEqual({ of: 'refused', why: ACT_REFUSAL.unreachable });
    kr.throws = null;
  });

  /* RED WHEN: a stop after the wallet handed transactions over is told as one that sent nothing. */
  it('says a stop handed transactions over when any were sent or left unconfirmed', async () => {
    const m = await load();
    for (const [relayed, unconfirmed, handedOver] of [[0, 0, false], [1, 0, true], [0, 1, true]] as const) {
      kr.ended = { ...stopped('act.approve-proposal.why.not-approved'), relayed, unconfirmed };
      expect(await m.approveProposal('u1', 'acc_Company00001', row()), `${relayed}/${unconfirmed}`)
        .toEqual({ of: m.PROPOSAL_ACTED.stopped, act: m.PROPOSAL_ACT.approve, why: 'not-approved', partial: false, handedOver } satisfies ProposalActed);
    }
  });
});

describe('changing the approvals the company needs', () => {
  const known = { now: 2, seated: 4 };
  const wallet = { name: 'change-threshold', record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32) };

  /* RED WHEN: the wallet is asked for a number other than the one chosen, under another name, for a vault, or with a field the change does not take. */
  it('asks the wallet to change the company\'s approvals to exactly the number chosen, as a whole number in decimal', async () => {
    const m = await load();
    kr.acts.length = 0; kr.ended = { of: 'done', steps: 5, relayed: 2, outcome: { state: 'carried-out', approvals: 2, needed: 2 } };
    expect(await m.changeThreshold('u1', 'acc_Company00001', 3, known)).toEqual({ of: m.PROPOSAL_ACTED.done, state: 'carried-out', approvals: 2, needed: 2 } satisfies ProposalActed);
    expect(kr.acts).toEqual([{ ...wallet, threshold: '3' }]);
  });

  /* RED WHEN: a change of one vault's approvals leaves the wallet unnamed which vault, or names it on a change of the company's, or is asked of the wallet under another name or with another number than the one chosen; or a number the page knows is refused (the vault's own in force, above the signers seated) reaches the wallet window. */
  it('asks the wallet to change one vault\'s approvals with the vault named, and refuses before the window the number that vault has now', async () => {
    const m = await load();
    const vault = 'ab'.repeat(32);
    kr.acts.length = 0; kr.calls = 0; kr.ended = { of: 'done', steps: 5, relayed: 2, outcome: { state: 'carried-out', approvals: 2, needed: 2 } };
    expect(await m.changeThreshold('u1', 'acc_Company00001', 3, { now: 2, seated: 4 }, undefined, vault)).toEqual({ of: m.PROPOSAL_ACTED.done, state: 'carried-out', approvals: 2, needed: 2 } satisfies ProposalActed);
    expect(kr.acts).toEqual([{ ...wallet, threshold: '3', vault }]);
    kr.acts.length = 0; kr.calls = 0;
    const P = m.THRESHOLD_PROBLEM;
    expect(await m.changeThreshold('u1', 'acc_Company00001', 3, { now: 3, seated: 4 }, undefined, vault)).toEqual({ of: m.THRESHOLD_ACTED.problem, problem: P.same });
    expect(await m.changeThreshold('u1', 'acc_Company00001', 5, { now: 3, seated: 4 }, undefined, vault)).toEqual({ of: m.THRESHOLD_ACTED.problem, problem: P.tooHigh, most: 4 });
    expect(await m.changeThreshold('u1', 'acc_Company00001', 0, { now: 3, seated: 4 }, undefined, vault)).toEqual({ of: m.THRESHOLD_ACTED.problem, problem: P.notWhole });
    expect(kr.calls).toBe(0);
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: the page asks the wallet for a number it can see the wallet would refuse (below one, not whole, above the signers seated, the number the company already asks for, or with the count of signers unread), or the wallet is opened for it. */
  it('refuses before the wallet window a number below one, above the signers seated, the one in force, or any when the counts are unread', async () => {
    const m = await load();
    kr.calls = 0;
    const P = m.THRESHOLD_PROBLEM;
    expect(await m.changeThreshold('u1', 'acc_Company00001', 0, known)).toEqual({ of: m.THRESHOLD_ACTED.problem, problem: P.notWhole });
    expect(await m.changeThreshold('u1', 'acc_Company00001', -1, known)).toEqual({ of: m.THRESHOLD_ACTED.problem, problem: P.notWhole });
    expect(await m.changeThreshold('u1', 'acc_Company00001', 2.5, known)).toEqual({ of: m.THRESHOLD_ACTED.problem, problem: P.notWhole });
    expect(await m.changeThreshold('u1', 'acc_Company00001', Number.NaN, known)).toEqual({ of: m.THRESHOLD_ACTED.problem, problem: P.notWhole });
    expect(await m.changeThreshold('u1', 'acc_Company00001', 5, known)).toEqual({ of: m.THRESHOLD_ACTED.problem, problem: P.tooHigh, most: 4 });
    expect(await m.changeThreshold('u1', 'acc_Company00001', 2, known)).toEqual({ of: m.THRESHOLD_ACTED.problem, problem: P.same });
    expect(await m.changeThreshold('u1', 'acc_Company00001', 3, { now: 2, seated: null })).toEqual({ of: m.THRESHOLD_ACTED.problem, problem: P.unread });
    expect(await m.changeThreshold('u1', 'acc_Company00001', 3, { now: null, seated: 4 })).toEqual({ of: m.THRESHOLD_ACTED.problem, problem: P.unread });
    expect(kr.calls).toBe(0);
    expect(thresholdProblem(4, known)).toBeNull();
    expect(thresholdProblem(1, known)).toBeNull();
  });

  /* RED WHEN: the wallet's own refusal of a number (after it checked every vault) is told as any other stop, so the person is not told what to change; or a stop's other reasons lose the wallet's own code. */
  it('tells the wallet\'s refusal of the number apart from its other stops, and keeps the others\' reasons', async () => {
    const m = await load();
    kr.ended = stopped('act.change-threshold.why.refused');
    expect(await m.changeThreshold('u1', 'acc_Company00001', 3, known)).toEqual({ of: m.THRESHOLD_ACTED.walletRefused });
    for (const [refused, why, partial] of [
      ['act.change-threshold.why.no-seat', 'seat', false], ['act.change-threshold.why.not-approved', 'not-approved', false],
      ['act.change-threshold.why.not-raised', 'not-raised', false], ['act.change-threshold.why.not-carried', 'may-be-sent', true],
      ['act.change-threshold.why.may-be-sent', 'may-be-sent', true], ['act.change-threshold.why.outrun', 'outrun', false],
      [undefined, 'stopped', false], ['act.change-threshold.why.nobody-knows', 'other', false],
    ] as readonly (readonly [string | undefined, string, boolean])[]) {
      kr.ended = stopped(refused);
      expect(await m.changeThreshold('u1', 'acc_Company00001', 3, known), String(refused)).toEqual({ of: m.PROPOSAL_ACTED.stopped, act: m.PROPOSAL_ACT.approve, why, partial, handedOver: false });
    }
  });

  /* RED WHEN: nothing is asked of the wallet while the person is not signed in, the company is not finished, or the wallet cannot be reached, or the reason is lost. */
  it('asks the wallet nothing when the person is not signed in or the company is not finished, and tells an unreachable wallet', async () => {
    const m = await load();
    kr.calls = 0; kr.user = null;
    expect(await m.changeThreshold('u1', 'acc_Company00001', 3, known)).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    kr.user = { id: 'u1' }; kr.named = {};
    expect(await m.changeThreshold('u1', 'acc_Company00001', 3, known)).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(kr.calls).toBe(0);
    kr.named = { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) };
    kr.throws = new TypeError('fetch failed');
    expect(await m.changeThreshold('u1', 'acc_Company00001', 3, known)).toEqual({ of: 'refused', why: ACT_REFUSAL.unreachable });
    kr.throws = null;
  });
});

describe('paying an approved run\'s leg', () => {
  const VAULT = 'ab'.repeat(32);
  const TOKEN = 'cd'.repeat(32);
  const ask = { proposal: 'prop_0001', run: 'run_1', period: '2026-10', list: 'employees', vault: VAULT, token: TOKEN, form: 'shielded', payees: 2, total: 7_000_000n } as const;
  const wallet = { name: 'pay-run', record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32) };
  const wire = { proposal: 'prop_0001', run: 'run_1', period: '2026-10', list: 'employees', vault: VAULT, token: TOKEN, form: 'private', payees: '2', total: '7000000' };

  /* RED WHEN: the wallet is asked to pay anything but the proposal, run, month, list, vault, token, form, people and total the page shows (the form under the wallet's own word, private or public), with a number that is not a whole number in decimal, or more than once. */
  it('asks the wallet once to pay exactly the leg shown, the form as private or public, the counts as whole numbers in decimal', async () => {
    const m = await load();
    kr.acts.length = 0; kr.calls = 0; kr.ended = { of: 'done', steps: 5, relayed: 2, outcome: { state: 'paid', paid: 2, owed: 0, unseen: 0, charge: 'none', approvals: 2, needed: 2 } };
    expect(await m.payRun('u1', 'acc_Company00001', ask)).toEqual({ of: 'done', state: 'paid', paid: 2, owed: 0, unseen: 0 });
    expect(kr.acts).toEqual([{ ...wallet, ...wire }]);
    expect(kr.calls).toBe(1);
    kr.acts.length = 0;
    await m.payRun('u1', 'acc_Company00001', { ...ask, form: 'unshielded', list: 'vendors' });
    expect(kr.acts).toEqual([{ ...wallet, ...wire, form: 'public', list: 'vendors' }]);
  });

  /* RED WHEN: a leg the page can see the wallet would refuse (no people, a total that is not a whole number above nothing, a month that is not one, a form the wallet does not know) reaches the wallet window. */
  it('refuses before the wallet window a leg with no people, no total, no month or no form', async () => {
    const m = await load();
    kr.acts.length = 0; kr.calls = 0;
    for (const bad of [{ payees: 0 }, { payees: 1.5 }, { total: 0n }, { total: -5n }, { period: 'October' }, { form: null }, { proposal: '' }] as const) {
      expect(await m.payRun('u1', 'acc_Company00001', { ...ask, ...bad } as never), Object.entries(bad).join()).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    }
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: the wallet's own answers lose the states and counts it gives (paid, partly paid, already paid, awaiting approvals), or give a count the wallet did not. */
  it('keeps the state and the counts the wallet answers with, and none it did not give', async () => {
    const m = await load();
    for (const [outcome, told] of [
      [{ state: 'partly-paid', paid: 1, owed: 1, unseen: 0, charge: 'charged' }, { state: 'partly-paid', paid: 1, owed: 1, unseen: 0 }],
      [{ state: 'already-paid', paid: 0, owed: 0, charge: 'none' }, { state: 'already-paid', paid: 0, owed: 0, unseen: null }],
      [{ state: 'awaiting-approvals', approvals: 1, needed: 2 }, { state: 'awaiting-approvals', paid: null, owed: null, unseen: null }],
    ] as const) {
      kr.ended = { of: 'done', steps: 5, relayed: 0, outcome };
      expect(await m.payRun('u1', 'acc_Company00001', ask), outcome.state).toEqual({ of: 'done', ...told });
    }
  });

  /* RED WHEN: a stop of the wallet's loses its own reason (window not open, window closed, stopped part way, payment not as built, not paid), tells one that sent nothing as one that may have gone through, or one that paid some people as one that paid none; or a code of the wallet's own not in the list is not told as other. */
  it('tells each stop of the wallet by its reason, whether part of it may have gone through, and the people paid', async () => {
    const m = await load();
    const W = m.PAY_RUN_WHY;
    for (const [code, why, partial] of [
      ['not-open-yet', W.notOpenYet, false], ['window-closed', W.windowClosed, false], ['stopped', W.stopped, true], ['stopped-unseen', W.stoppedUnseen, true],
      ['payment-not-as-built', W.notAsBuilt, true], ['not-paid', W.notPaid, false], ['not-payable', W.notPayable, false],
      ['not-as-shown', m.WHY.notAsShown, false], ['not-raised', m.WHY.notRaised, false], ['closed', m.WHY.closed, false], ['withdrawn', m.WHY.withdrawn, false],
      ['no-seat', m.WHY.seat, false], ['not-a-run', m.WHY.notAProposal, false], ['may-be-sent', m.WHY.mayBeSent, true], ['payment-not-seen', m.WHY.mayBeSent, true],
      ['payment-on-its-way', m.WHY.mayBeSent, true], ['payment-not-recorded', m.WHY.mayBeSent, true], ['charge-not-seen', m.WHY.mayBeSent, true],
      ['nobody-knows', m.WHY.other, false],
    ] as const) {
      kr.ended = { ...stopped(`act.pay-run.why.${code}`), outcome: { state: 'partly-paid', paid: 1, owed: 1, unseen: 0, charge: 'none' } };
      expect(await m.payRun('u1', 'acc_Company00001', ask), code).toEqual({ of: 'stopped', why, partial, handedOver: false, paid: 1, owed: 1, unseen: 0 });
    }
    kr.ended = { ...stopped('act.pay-run.why.not-paid'), relayed: 1 };
    expect(await m.payRun('u1', 'acc_Company00001', ask)).toEqual({ of: 'stopped', why: W.notPaid, partial: false, handedOver: true, paid: null, owed: null, unseen: null });
    kr.ended = stopped();
    expect(await m.payRun('u1', 'acc_Company00001', ask)).toMatchObject({ of: 'stopped', why: m.WHY.stopped });
  });
});

describe('raising a retry of a run\'s people', () => {
  const VAULT = 'ab'.repeat(32);
  const TOKEN = 'cd'.repeat(32);
  const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
  const opens = Math.floor(NOW / 1000) + 7200;
  const closes = opens + 5 * 24 * 3600 + 17;
  const retry = { run: 'run_1', period: '2026-11', list: 'employees', vault: VAULT, token: TOKEN, form: 'shielded', indices: [3, 1], total: 7_000_000n, opensAt: BigInt(opens), closesAt: BigInt(closes) } as const;

  /*
   * RED WHEN: the wallet is asked for a retry without the run, the places of the people, their count and their total, in the order the wallet reads
   * them, or with a field beyond those the wallet's raise reads (a proposal, a name), or with the window changed, or more than once.
   */
  it('asks the wallet once for a retry of exactly the places named, with the run, their count, their total and the window as given', async () => {
    const m = await load();
    kr.acts.length = 0; kr.calls = 0;
    kr.ended = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'raised', run: 'run_1', proposal: 'prop_3', approvals: 1, needed: 2 } };
    expect(await m.retryRun('u1', 'acc_Company00001', retry, undefined, NOW)).toEqual({ of: 'done', state: 'raised', approvals: 1, needed: 2 });
    expect(kr.acts).toEqual([{
      name: 'raise-run', record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32), run: 'run_1', period: '2026-11', list: 'employees', vault: VAULT, token: TOKEN,
      form: 'private', payees: '2', total: '7000000', indices: '1,3', opensAt: String(opens), closesAt: String(closes),
    }]);
    expect(kr.calls).toBe(1);
  });

  /* RED WHEN: a retry of nobody, of a place twice or below zero, with no run, no total or a window not in the future and in order, reaches the wallet window. */
  it('refuses before the wallet window a retry that names nobody, a place twice, no total or a window not in the future', async () => {
    const m = await load();
    kr.acts.length = 0; kr.calls = 0;
    for (const bad of [{ indices: [] }, { indices: [1, 1] }, { indices: [-1] }, { run: '' }, { total: 0n }, { period: 'x' }, { opensAt: BigInt(Math.floor(NOW / 1000)) }, { closesAt: BigInt(opens) }]) {
      expect(await m.retryRun('u1', 'acc_Company00001', { ...retry, ...bad }, undefined, NOW), Object.keys(bad).join()).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    }
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: a stop of the wallet is not told by its reason, or whether anything was handed over. */
  it('tells a stop of the wallet by its reason, and whether anything was handed over', async () => {
    const m = await load();
    kr.ended = { of: 'stopped', step: 1, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.raise-run.why.not-as-shown' };
    expect(await m.retryRun('u1', 'acc_Company00001', retry, undefined, NOW)).toEqual({ of: 'stopped', why: 'not-as-shown', handedOver: false });
    kr.ended = { ...(kr.ended as object), relayed: 1, refused: 'act.raise-run.why.raise-may-be-sent' };
    expect(await m.retryRun('u1', 'acc_Company00001', retry, undefined, NOW)).toEqual({ of: 'stopped', why: 'may-be-sent', handedOver: true });
  });
});

describe('raising a run the wallet draws', () => {
  const VAULT = 'ab'.repeat(32);
  const TOKEN = 'cd'.repeat(32);
  const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
  const opens = Math.floor(NOW / 1000) + 7200;
  const closes = opens + 5 * 24 * 3600 + 17;
  const run = { period: '2026-11', list: 'employees', vault: VAULT, token: TOKEN, form: 'shielded', opensAt: BigInt(opens), closesAt: BigInt(closes) } as const;
  const wire = {
    name: 'raise-run', record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32), period: '2026-11', list: 'employees', vault: VAULT, token: TOKEN,
    form: 'private', opensAt: String(opens), closesAt: String(closes),
  };
  const refusing = (code: string) => ({ of: 'stopped', step: 1, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: `act.raise-run.why.${code}` });

  /* RED WHEN: the wallet is asked for a run with any people, a total, a run's name or a count (the page names none of them for a run the wallet draws), with a window that is not in the future, or more than once. */
  it('asks the wallet once to draw a run, naming no run, no people and no total, over the window it was given, unchanged', async () => {
    const m = await load();
    kr.acts.length = 0; kr.calls = 0;
    kr.ended = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'raised', run: 'run_9', proposal: 'prop_9', approvals: 1, needed: 2 } };
    expect(await m.raiseRun('u1', 'acc_Company00001', run, undefined, NOW)).toEqual({ of: 'done', state: 'raised', approvals: 1, needed: 2 });
    expect(kr.acts).toEqual([wire]);
    for (const named of ['run', 'payees', 'total', 'indices', 'proposal']) expect(kr.acts[0], named).not.toHaveProperty(named);
    expect(kr.calls).toBe(1);
    kr.acts.length = 0;
    await m.raiseRun('u1', 'acc_Company00001', { ...run, form: 'unshielded', list: 'vendors' }, undefined, NOW);
    expect(kr.acts).toEqual([{ ...wire, form: 'public', list: 'vendors' }]);
  });

  /* RED WHEN: a month that is not one, or no vault or currency, reaches the wallet window; or the wallet's answer gains a number it did not give. */
  it('refuses before the wallet window what cannot name a run, and tells only the numbers the wallet gave', async () => {
    const m = await load();
    kr.acts.length = 0; kr.calls = 0;
    for (const bad of [{ period: 'November' }, { period: '2026-13' }, { vault: '' }, { token: '' }, { opensAt: BigInt(Math.floor(NOW / 1000)) }, { opensAt: BigInt(opens - 9000) }, { closesAt: BigInt(opens) }, { closesAt: BigInt(opens - 1) }]) {
      expect(await m.raiseRun('u1', 'acc_Company00001', { ...run, ...bad }, undefined, NOW), Object.keys(bad).join()).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    }
    expect(kr.calls).toBe(0);
    kr.ended = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'raised' } };
    expect(await m.raiseRun('u1', 'acc_Company00001', run, undefined, NOW)).toEqual({ of: 'done', state: 'raised', approvals: null, needed: null });
  });

  /* RED WHEN: a window left empty gets a default, an opening at or before now or a closing at or before the opening is let through, or the times typed are changed on their way to the wallet's seconds. */
  it('reads the window as typed, with no default, and says what is missing, past or out of order', async () => {
    const m = await load();
    const local = (ms: number): string => { const d = new Date(ms); const two = (n: number): string => String(n).padStart(2, '0'); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`; };
    const later = NOW + 3 * 3600_000;
    expect(m.paymentWindow(local(later), local(later + 86_400_000), NOW)).toEqual({
      of: m.WINDOW_OF.given, opensAt: BigInt(new Date(local(later)).getTime() / 1000), closesAt: BigInt(new Date(local(later + 86_400_000)).getTime() / 1000),
    });
    for (const [a, b] of [['', ''], [local(later), ''], ['', local(later)], ['not a time', local(later)]]) expect(m.paymentWindow(a!, b!, NOW), `${a}|${b}`).toEqual({ of: m.WINDOW_OF.problem, problem: m.WINDOW_PROBLEM.missing });
    expect(m.paymentWindow(local(NOW - 3600_000), local(later), NOW)).toEqual({ of: m.WINDOW_OF.problem, problem: m.WINDOW_PROBLEM.past });
    expect(m.paymentWindow(local(later), local(later), NOW)).toEqual({ of: m.WINDOW_OF.problem, problem: m.WINDOW_PROBLEM.order });
    expect(m.paymentWindow(local(later), local(later - 3600_000), NOW)).toEqual({ of: m.WINDOW_OF.problem, problem: m.WINDOW_PROBLEM.order });
  });

  /* RED WHEN: a stop of the wallet loses its own reason, a stop that handed something over is told as one that sent nothing, or a code of the wallet's own not in the list is not told as other. */
  it('tells each stop of the wallet by its reason, and whether anything was handed over', async () => {
    const m = await load();
    const W = m.RAISE_RUN_WHY;
    for (const [code, why] of [
      ['no-seat', W.seat], ['not-a-run', W.notARun], ['no-window', W.paymentTime], ['window-open', W.paymentTime], ['not-as-shown', W.notAsShown],
      ['not-raised', W.notRaised], ['raise-may-be-sent', W.mayBeSent], ['nobody-knows', W.other],
    ] as const) {
      kr.ended = refusing(code);
      expect(await m.raiseRun('u1', 'acc_Company00001', run, undefined, NOW), code).toEqual({ of: 'stopped', why, handedOver: false });
    }
    kr.ended = { ...refusing('raise-may-be-sent'), relayed: 1 };
    expect(await m.raiseRun('u1', 'acc_Company00001', run, undefined, NOW)).toEqual({ of: 'stopped', why: W.mayBeSent, handedOver: true });
    kr.ended = { of: 'stopped', step: 2, steps: 4, relayed: 0, unconfirmed: 0, why: 'declined' };
    expect(await m.raiseRun('u1', 'acc_Company00001', run, undefined, NOW)).toEqual({ of: 'stopped', why: W.stopped, handedOver: false });
  });
});

describe('raising a one-off payment', () => {
  const VAULT = 'ab'.repeat(32);
  const NIGHT = '00'.repeat(32);
  const PRIVATE = 'mn_shield-addr_stagenet1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg37tfmf9tk2uup37w6hww86h3lrlsvrg5rv3zjvph8ez5c566v95x7anasj9e9xdq57htt0qwwj5qx';
  const PUBLIC = 'mn_addr_stagenet1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5z5tpwxqergd3c8g7rusqqmwelz';
  const draft = { vault: VAULT, token: NIGHT, amount: '12.5', payee: PUBLIC, payeeName: '', reason: 'Chairs', vendor: null } as const;
  const wire = { name: 'one-off-payment', record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32), vault: VAULT, token: NIGHT, amount: '12500000', payee: PUBLIC, reason: 'Chairs' };
  const refusing = (code: string) => ({ of: 'stopped', step: 1, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: `act.one-off-payment.why.${code}` });

  /* RED WHEN: the wallet is asked for a payment with a field the person did not give (a name, a vendor, a proposal), an amount that is not whole units of the currency, an address with its spaces, or more than once. */
  it('asks the wallet once with the vault, currency, amount in whole units, address and reason, and a name or vendor only when given', async () => {
    const m = await load();
    kr.acts = [];
    kr.ended = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'raised', approvals: 1, needed: 2 } };
    expect(await m.raiseOneOff('u1', 'acc_Company00001', { ...draft, payee: ` ${PUBLIC} `, reason: ' Chairs ' })).toEqual({ of: 'done', state: 'raised', approvals: 1, needed: 2 });
    expect(kr.acts).toEqual([wire]);
    kr.acts = [];
    await m.raiseOneOff('u1', 'acc_Company00001', { ...draft, payee: PRIVATE, payeeName: ' Chair Co ', vendor: 'ven_aa' });
    expect(kr.acts).toEqual([{ ...wire, payee: PRIVATE, payeeName: 'Chair Co', vendor: 'ven_aa' }]);
  });

  /* RED WHEN: an amount, address or reason the page can tell is unusable reaches the wallet, or the problem named is not the first thing wrong in the order the form is read. */
  it('names what is wrong before the wallet is asked, and asks it nothing', async () => {
    const m = await load();
    const P = m.ONE_OFF_PROBLEM;
    const F = m.ONE_OFF_FIELD;
    const cases: [Partial<Record<keyof typeof draft, string>>, number, number][] = [
      [{ vault: '' }, F.vault, P.noVault], [{ token: '' }, F.amount, P.noAsset], [{ token: 'ef'.repeat(32) }, F.amount, P.noAsset], [{ amount: '' }, F.amount, P.noAmount], [{ amount: '  ' }, F.amount, P.noAmount],
      [{ amount: 'abc' }, F.amount, P.badAmount], [{ amount: '-1' }, F.amount, P.badAmount], [{ amount: '1e3' }, F.amount, P.badAmount], [{ amount: '1,000' }, F.amount, P.badAmount],
      [{ amount: '0' }, F.amount, P.zeroAmount], [{ amount: '0.0' }, F.amount, P.zeroAmount], [{ amount: '1.0000001' }, F.amount, P.tooManyDecimals],
      [{ amount: '340282366920938463463374607431768.211456' }, F.amount, P.badAmount], [{ payee: '' }, F.payee, P.noAddress], [{ payee: 'hello' }, F.payee, P.badAddress],
      [{ payee: PUBLIC.replace('mn_addr_stagenet', 'mn_addr_preview') }, F.payee, P.badAddress], [{ reason: ' ' }, F.reason, P.noReason],
      [{ reason: 'x'.repeat(501) }, F.reason, P.reasonTooLong], [{ payeeName: 'n'.repeat(129) }, F.name, P.nameTooLong],
    ];
    for (const [over, field, problem] of cases) {
      expect(m.oneOffProblem({ ...draft, ...over }), JSON.stringify(over)).toEqual({ field, problem });
      kr.acts = [];
      expect(await m.raiseOneOff('u1', 'acc_Company00001', { ...draft, ...over }), JSON.stringify(over)).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
      expect(kr.acts).toEqual([]);
    }
    expect(m.oneOffProblem({ ...draft, amount: '0.000001', payee: PRIVATE, payeeName: 'n'.repeat(128), reason: 'x'.repeat(500) })).toBeNull();
    expect(await m.raiseOneOff('u1', 'acc_Company00001', { ...draft, vault: '' })).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
  });

  /* RED WHEN: an address is read as the wrong kind, so the screen says a public payment is private or the other way round. */
  it('reads an address as private or public by its own kind, and as neither when it is not one of this network', async () => {
    const m = await load();
    expect([m.oneOffForm(PRIVATE), m.oneOffForm(PUBLIC), m.oneOffForm(` ${PUBLIC} `), m.oneOffForm('nonsense'), m.oneOffForm('')]).toEqual([m.RUN_FORM.shielded, m.RUN_FORM.unshielded, m.RUN_FORM.unshielded, null, null]);
  });

  /* RED WHEN: a stop of the wallet loses its reason, or a stop that handed something over is told as one that sent nothing. */
  it('tells each stop of the wallet by its reason, and whether anything was handed over', async () => {
    const m = await load();
    const W = m.WHY;
    for (const [code, why] of [
      ['no-seat', W.seat], ['not-a-payment', W.notAProposal], ['payee', W.notAProposal], ['not-raised', W.notRaised], ['raise-may-be-sent', W.mayBeSent], ['closed', W.closed],
      ['outrun', W.outrun], ['nobody-knows', W.other],
    ] as const) {
      kr.ended = refusing(code);
      expect(await m.raiseOneOff('u1', 'acc_Company00001', draft), code).toMatchObject({ of: 'stopped', why, handedOver: false });
    }
    kr.ended = { ...refusing('raise-may-be-sent'), relayed: 1 };
    expect(await m.raiseOneOff('u1', 'acc_Company00001', draft)).toMatchObject({ of: 'stopped', why: W.mayBeSent, partial: true, handedOver: true });
  });
});

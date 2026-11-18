import { describe, it, expect } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { approvalMessage } from './account.js';
import { sign } from './crypto.js';
import { TEST_TOKEN } from '../testing/assets.js';
import { present, harness, readableStore, THREE_SIGNERS } from '../testing/an-account-harness.js';

describe('what a RUN leaves in the store', () => {
  it('a settled run must not leave salaries in the runs table either', async () => {
    /*
     * Checking a claim I made rather than assuming it.
     *
     * Sealing the roster closed one table. `PayrollRun.employees[].amount` and
     * the run's own totals are a SECOND copy of the same numbers, written when
     * a run is created — so "we cannot read anyone's salary" is only true if
     * this table is covered too.
     */
    const h2 = harness();
    const { account, viewingKey } = await h2.accounts.create('Acme', THREE_SIGNERS, 2, undefined, drawCompanyLabel());
    h2.payroll.hireDirect(account.id, { name: 'Dana Whitfield', email: 'd@a.co', title: 'Eng', asset: TEST_TOKEN, baseAmount: 6_200_00n }, viewingKey);
    await h2.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    const runs = readableStore((h2.store as any).data.runs);
    expect(runs).not.toContain('620000');
    expect(runs).not.toContain('Dana Whitfield');

    /*
     * Nor WHICH ASSET each leg settles in. `totals` and the per-asset proposal
     * map are inside the envelope; the copy left outside is a bare list of
     * proposal ids with no asset attached, so the store cannot see that this
     * company pays anyone in ether.
     *
     * Asserted as a shape rather than a substring: an asset code is three
     * characters and a nanoid is drawn from a 64-character alphabet, so
     * `not.toContain(TEST_TOKEN)` would fire at random on correct code.
     */
    const stored = present(h2.store.listRuns(account.id)[0]);
    expect(Object.values(stored).some(v => v === TEST_TOKEN)).toBe(false);
    expect(h2.payroll.requireRun(present(stored).id, viewingKey).totals).toEqual({ [TEST_TOKEN]: 6_200_00n });
  });
});

describe('what the proposals table leaves in the store', () => {
  it('holds no summary, no proposer and no per-signer approval list', async () => {
    /*
     * The sharpest item in the whole exercise.
     *
     * The chain records approvals as NULLIFIERS so that nobody — including us —
     * can tell which signer approved what. That is decision 0003. Our own table
     * held the deanonymised version of exactly that, beside a human-written
     * summary that names people and amounts.
     */
    const h2 = harness();
    const c = await h2.accounts.create('Acme', THREE_SIGNERS, 2, undefined, drawCompanyLabel());
    const p = await h2.accounts.propose({
      accountId: c.account.id, viewingKey: c.viewingKey, kind: 'transfer',
      summary: 'Pay Wilkinson Legal 12000 for the Q3 retainer',
      payload: {
        to: 'Wilkinson Legal',
        entries: [{ id: 'e1', kind: 'transfer', asset: TEST_TOKEN, amount: 12_000_00n, counterparty: 'Wilkinson Legal', memo: '', at: '' }],
      },
      proposedBy: present(c.secrets[0]).signerId,
    });
    await h2.accounts.approve(p.id, present(c.secrets[1]).signerId, sign(approvalMessage(p), present(c.secrets[1]).signingSecret), c.viewingKey);

    const stored = readableStore((h2.store as any).data.proposals);
    expect(stored).not.toContain('Wilkinson Legal');
    // '12000' from the summary, and '1200000' — the amount in minor units —
    // which contains it, so one check covers both.
    expect(stored).not.toContain('12000');
    expect(stored).not.toContain(present(c.secrets[0]).signerId);
    // Nor the asset: there is no readable field on the record that carries one.
    expect(Object.values(h2.store.getProposal(p.id)!).some(v => v === TEST_TOKEN)).toBe(false);

    // A count is fine — the chain publishes one too. WHOSE is the leak.
    expect(h2.store.getProposal(p.id)!.approvalCount).toBe(1);
    // And a signer with the key still reads it all.
    expect(h2.accounts.requireProposal(p.id, c.viewingKey).summary).toContain('Wilkinson');
    /*
     * `amountOf` USED TO BE THE READER HERE and returned a bare number — which
     * is the shape the policy engine then evaluated against a ceiling belonging
     * to some other asset. `changeOf` returns the pair, which is what makes
     * that impossible to write.
     */
    expect(h2.accounts.changeOf(h2.accounts.requireProposal(p.id, c.viewingKey), c.viewingKey))
      .toEqual({ asset: TEST_TOKEN, amount: 12_000_00n });
  });
});

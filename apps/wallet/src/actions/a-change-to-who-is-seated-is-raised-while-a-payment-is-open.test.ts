/*
 * A change to who is seated, or to the approvals the company needs, is raised from the wallet while a payroll run or a
 * one-off payment is open: finding whether the same change is already open reads only the open proposals of the
 * change's own kind, so the run or the one-off payment, whose payments a seat's change never reads, is passed over. The
 * one-off payment's case runs alone as well as after the run's: the company asks one approval at the start of each.
 */
import { describe, expect, it } from 'vitest';
import { aCompanyOf, runIntent } from './company-harness.test-support.js';
import { setUpRunsOn } from './actions-set-up-first.test-support.js';
import { ADA, BO, CO, store } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';

describe('A CHANGE TO WHO IS SEATED IS RAISED WHILE A RUN OR A ONE-OFF PAYMENT IS OPEN', { timeout: 160_000 }, () => {
  const company = aCompanyOf({ people: 0, vendors: 2, vaults: 2, proposals: 0 });
  it('raises and carries out a change of the approvals the company needs with a payroll run open, and leaves the run open', async () => {
    await setUpRunsOn(company)['raise-run']!(0);
    const open = () => store.listProposals(CO).filter((p) => (p as { readonly status?: string }).status === 'open').map((p) => p.id);
    const before = open();
    expect(before).toHaveLength(1);
    const changed = await runIntent('change-threshold', { name: 'change-threshold', fields: { ...company.fields, threshold: '1' } } as never, company, ADA.person);
    /* RED WHEN: finding whether the change is already open opens the run, whose payments a change to who is seated never reads, and the change is refused. */
    expect(changed.told['state']).toBe('carried-out');
    expect(open()).toEqual(before);
  });

  it('raises a change of the approvals the company needs with a one-off payment open, carries it out from the second seat, and leaves the payment open', async () => {
    const open = () => store.listProposals(CO).filter((p) => (p as { readonly status?: string }).status === 'open').map((p) => p.id);
    const threshold = (to: string) => ({ name: 'change-threshold', fields: { ...company.fields, threshold: to } }) as never;
    /* Two approvals asked, so the one-off payment raised next is left open, waiting for a second seat. */
    expect((await runIntent('change-threshold', threshold('2'), company, ADA.person)).told['state']).toBe('carried-out');
    const before = open();
    await company.oneOffRaised();
    const oneOff = open().filter((id) => !before.includes(id));
    expect(oneOff).toHaveLength(1);
    const raised = await runIntent('change-threshold', threshold('1'), company, ADA.person);
    /* RED WHEN: finding whether the change is already open opens the one-off payment, whose payment a change to who is seated never reads, and the change is refused. */
    expect(raised.told['state']).toBe('waiting-for-approvals');
    const change = open().filter((id) => !before.includes(id) && !oneOff.includes(id));
    expect(change).toHaveLength(1);
    const approved = await runIntent('approve-proposal', {
      name: 'approve-proposal', fields: { ...company.fields, proposal: change[0]!, kind: 'threshold', threshold: '1' },
    } as never, company, BO.person);
    expect(approved.told['state']).toBe('carried-out');
    /* RED WHEN: the change carried out closes or changes the one-off payment it passed over. */
    expect(open()).toEqual([...before, ...oneOff]);
  });
});

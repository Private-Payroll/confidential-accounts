/**
 * **A RUN'S PROPOSALS ARE LISTED ONCE: INSIDE ITS SEAL, WHICH SAYS WHICH LEG EACH
 * IS FOR.** The list outside the seal, which the service finds a run by and
 * checks a raise against, is made only from what is inside, and a run whose
 * list outside is anything else is not opened. So what the service checked is
 * always what every device reads, and a filing cannot name one proposal to the
 * service and another to the devices that raise and approve the run.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes, toHex, type Hex } from './crypto.js';
import { openSealedRun, proposalListOf, PROPOSALS_OUTSIDE_ARE_NOT_INSIDE, sealedRunOf } from './run-legs.js';
import type { PayrollRun, RunPayout, SealedRun } from './types.js';

const KEY = toHex(randomBytes(32)) as Hex;
const LEG = 'aa'.repeat(32) + ':shielded';
const payout = (retries: string[]): RunPayout => ({
  root: '00'.repeat(32), payees: 1n, opensAt: 1n, closesAt: 2n, vault: 'c5'.repeat(32), leaves: ['01'.repeat(32)], facts: [],
  runId: '02'.repeat(32), epoch: 0,
  retries: retries.map((proposalId) => ({ originalIndices: [0], root: '03'.repeat(32), payees: 1n, opensAt: 1n, closesAt: 2n, vault: 'c5'.repeat(32), proposalId, proposedBy: 'seat_1', at: '2026-10-08T00:00:00.000Z' })),
} as unknown as RunPayout);
const run = (proposalIds: Record<string, string>, retries: string[] = []): PayrollRun => ({
  id: 'run_abcdefghijkl', accountId: 'acc_1', period: '2026-11', employees: [], payslips: [], totals: {} as never,
  status: 'proposed', proposalIds, ...(Object.keys(proposalIds).length === 0 ? {} : { payout: { [LEG]: payout(retries) } }),
} as unknown as PayrollRun);
const kept = (r: PayrollRun): SealedRun => ({ ...sealedRunOf(r, KEY, 0) }) as SealedRun;

describe('A RUN\'S PROPOSALS, OUTSIDE ITS SEAL AND IN', () => {
  it('THE LIST OUTSIDE IS EACH LEG\'S PROPOSAL AND EVERY RETRY\'S, MADE FROM INSIDE, AND THE RUN OPENS', () => {
    const r = run({ [LEG]: 'prp_leg' }, ['prp_retry_b', 'prp_retry_a']);
    const sealed = kept(r);
    /* RED WHEN: the list outside leaves out a retry's proposal, or a leg's, or is not in one order. */
    expect(sealed.proposalIds).toEqual(['prp_leg', 'prp_retry_a', 'prp_retry_b']);
    expect(proposalListOf(r)).toEqual(sealed.proposalIds);
    /* RED WHEN: a run sealed as it is kept does not open again as itself. */
    expect(openSealedRun(sealed, KEY).proposalIds).toEqual({ [LEG]: 'prp_leg' });
    /* A drawn run, raised as nothing yet, lists nothing and opens. */
    expect(openSealedRun(kept(run({})), KEY).proposalIds).toEqual({});
    /* Listed in another order is the same list. */
    expect(() => openSealedRun({ ...sealed, proposalIds: [...sealed.proposalIds!].reverse() }, KEY)).not.toThrow();
  });

  it('A RUN WHOSE LIST OUTSIDE NAMES A PROPOSAL ITS SEAL DOES NOT, OR LEAVES ONE OUT, IS NOT OPENED', () => {
    const sealed = kept(run({ [LEG]: 'prp_leg' }, ['prp_retry']));
    const lists: Array<string[] | undefined> = [
      ['prp_leg', 'prp_retry', 'prp_other'], // one the seal does not name
      ['prp_retry'], // the leg's own left out
      ['prp_leg', 'prp_other'], // a retry swapped for another
      ['prp_leg', 'prp_leg', 'prp_retry'], // one named twice
      undefined, // none at all
    ];
    for (const proposalIds of lists) {
      const { proposalIds: _drop, ...rest } = sealed;
      const changed = (proposalIds === undefined ? rest : { ...rest, proposalIds }) as SealedRun;
      /* RED WHEN: a run is opened while its list outside, which the service checks a raise against, says other than its seal. */
      expect(() => openSealedRun(changed, KEY), JSON.stringify(proposalIds)).toThrow(PROPOSALS_OUTSIDE_ARE_NOT_INSIDE);
    }
  });
});

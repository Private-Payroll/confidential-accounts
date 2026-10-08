/**
 * **A RUN IS KEPT ONLY AS A SEAT FILED IT: OF THIS COMPANY, UNDER A RUN'S NAME,
 * FOR A MONTH WRITTEN AS A MONTH, AT A KEY EPOCH, WITH ITS SEALED NUMBERS AND
 * PAYSLIPS, AND SIGNED OVER EXACTLY THAT.** Every reason `runFilingRefusal`
 * gives, each for the one thing wrong, so a reason that stopped being given
 * is seen.
 */
import { describe, expect, it } from 'vitest';
import { newSigningKeypair } from './crypto.js';
import { runFilingRefusal, signRunFiling, type RunToFile } from './run-filing.js';

const CO = 'acc_1';
const seat = newSigningKeypair();
const RUN: RunToFile = {
  id: 'run_aaaaaaaaaaa1', accountId: CO, period: '2026-09', status: 'draft', keyEpoch: 0, payslips: [],
  sealed: { iv: 'aa', tag: 'bb', body: 'cc' },
} as unknown as RunToFile;
/** The run with `change` made to it, signed over exactly that. */
const filed = (change: Record<string, unknown>) => signRunFiling(CO, { ...RUN, ...change } as RunToFile, seat.secret);

describe('A RUN A SEAT FILED', () => {
  it('IS KEPT WHOLE: SIGNED OVER EXACTLY THE RUN, FOR THIS COMPANY', () => {
    /* RED WHEN: a run filed whole is refused. */
    expect(runFilingRefusal(CO, filed({}))).toBeNull();
    expect(runFilingRefusal(CO, filed({ status: 'proposed', proposalIds: ['prp_1'] }))).toBeNull();
  });

  it('IS REFUSED, FOR EACH THING WRONG, WITH THE REASON FOR THAT THING', () => {
    const cases: Array<[string, unknown, string]> = [
      ['nothing', null, 'it is not a run'],
      ['a string', 'run', 'it is not a run'],
      ['a name that is not a run\'s', filed({ id: 'prp_aaaaaaaaaaa1' }), 'it does not carry a run\'s name'],
      ['a name one character short', filed({ id: 'run_aaaaaaaaaaa' }), 'it does not carry a run\'s name'],
      ['another company\'s run', signRunFiling('acc_2', { ...RUN, accountId: 'acc_2' } as RunToFile, seat.secret), 'it is a run of another company'],
      ['no month', filed({ period: undefined }), 'it does not say which month it pays'],
      ['a month written another way', filed({ period: '2026-9' }), 'its month is not written as a month'],
      ['no month at all', filed({ period: 'September' }), 'its month is not written as a month'],
      ['a standing it cannot have', filed({ status: 'paid' }), 'it does not say where it stands'],
      ['no key epoch', filed({ keyEpoch: undefined }), 'it does not say which key it is sealed under'],
      ['a key epoch below zero', filed({ keyEpoch: -1 }), 'it does not say which key it is sealed under'],
      ['a key epoch that is not whole', filed({ keyEpoch: 0.5 }), 'it does not say which key it is sealed under'],
      ['no sealed numbers', filed({ sealed: undefined }), 'it carries no sealed numbers'],
      ['sealed numbers missing a part', filed({ sealed: { iv: 'aa', tag: 'bb' } }), 'it carries no sealed numbers'],
      ['no payslips', filed({ payslips: undefined }), 'it carries no payslips'],
      ['proposals that are not a list', filed({ proposalIds: 'prp_1' }), 'its proposals are not a list of names'],
      ['a proposal that is not a name', filed({ proposalIds: [7] }), 'its proposals are not a list of names'],
      ['unsigned', { ...RUN }, 'it is not signed'],
      ['changed after it was signed', { ...filed({}), period: '2026-10' }, 'its signature does not cover exactly this run for this company'],
      ['signed for another company', { ...signRunFiling('acc_2', RUN, seat.secret) }, 'its signature does not cover exactly this run for this company'],
    ];
    for (const [why, run, says] of cases) {
      /* RED WHEN: a run with that wrong is kept, or refused for another reason than that one. */
      expect(runFilingRefusal(CO, run), why).toBe(says);
    }
  });
});

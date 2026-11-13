/**
 * **A READER'S READ OF A COMPANY'S RECORDS KEEPS NO ANCHOR CHECKPOINT.** A reader's act is given its record id, label
 * and account by the page, and nothing ties the three together before the read. So the heads it checks are held for
 * that one read only: they never reach the store where this device keeps the checked heads a signer's acts start from,
 * and a read pointed at another account carrying the company's label cannot leave behind a checkpoint that stops them.
 */
import { describe, expect, it } from 'vitest';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { companyJudges } from './company-judges.js';
import { treeKeptInMemory } from './tree-kept-here.js';

const LABEL = `co_${'c3'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'ab'.repeat(32) as AccountAddress;

/** The judges of a device whose kept stores count how often they are taken up; its builder refuses, so no read gets further. */
const judgesCounting = () => {
  const taken = { count: 0 };
  const refuse = async (): Promise<never> => { throw new Error('this device reaches no builder here'); };
  const judges = companyJudges({
    api: refuse, holders: refuse, indexer: async () => null, builder: refuse, keysFor: () => null,
    servedKeyFor: () => { throw new Error('no served key'); }, released: () => null, askReleased: async () => null,
    treeKept: () => { taken.count += 1; return treeKeptInMemory(); },
    openAccount: async () => null, seatsAdmittedFor: async () => new Set(), noAccount: () => { throw new Error('no account'); },
  });
  return { judges, taken };
};

describe('THE ANCHOR CHECKPOINT A READER\'S READ KEEPS', () => {
  it('IS NONE OF THIS DEVICE\'S: A READER\'S READ NEVER TAKES UP THE STORE A SIGNER\'S ACTS START FROM', async () => {
    const reader = judgesCounting();
    await expect(reader.judges.anchoredForAReader('acc_acme', LABEL, ACCOUNT)({} as never, {} as never)).rejects.toThrow(/reaches no builder/u);
    /* RED WHEN: a reader's read, given an account nothing ties to the company, writes into the checkpoint kept for it. */
    expect(reader.taken.count).toBe(0);
    const signer = judgesCounting();
    await expect(signer.judges.anchoredHere('acc_acme', LABEL, ACCOUNT)({} as never, {} as never)).rejects.toThrow(/reaches no builder/u);
    expect(signer.taken.count).toBe(1);
  });
});

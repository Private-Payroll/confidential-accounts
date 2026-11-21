/**
 * **A READER'S READ OF A COMPANY'S RECORDS KEEPS NO ANCHOR CHECKPOINT.** A reader's act is given its record id, label
 * and account by the page, and nothing ties the three together before the read. So the heads it checks are held for
 * that one read only: they never reach the store where this device keeps the checked heads a signer's acts start from,
 * and a read pointed at another account carrying the company's label cannot leave behind a checkpoint that stops them.
 */
import { describe, expect, it } from 'vitest';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { companyJudges } from './company-judges.js';
import { companyViewFor } from './company-view.js';
import type { JudgeView } from './company-view-judges.js';
import { serviceSource, type ServiceCall } from './records-source.js';
import { treeKeptInMemory } from './tree-kept-here.js';

const LABEL = `co_${'c3'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'ab'.repeat(32) as AccountAddress;

/** The judges of a device whose kept stores count how often they are taken up; its builder refuses, so no read gets further. */
const judgesCounting = () => {
  const taken = { count: 0 };
  const refuse = async (): Promise<never> => { throw new Error('this device reaches no builder here'); };
  let view: JudgeView | null = null;
  const judges = companyJudges({
    view: () => view!, indexer: async () => null, builder: refuse, keysFor: () => null,
    servedKeyFor: () => { throw new Error('no served key'); }, released: () => null, askReleased: async () => null,
    treeKept: () => { taken.count += 1; return treeKeptInMemory(); },
    openAccount: async () => null, seatsAdmittedFor: async () => new Set(), noAccount: () => { throw new Error('no account'); },
  });
  /* The service answers with nothing held, so the read gets as far as the builder. */
  const nothingHeld: ServiceCall = async (path, init) => {
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
    if (path.includes('/manifest/newest')) return { versions: (body.records ?? []).map(() => 0) };
    if (path.includes('/tree/headers')) return { headers: [], entries: [], leaves: [] };
    if (path.includes('/tree/pending')) return { entries: [] };
    if (path.includes('/directory')) return { filings: [] };
    return {};
  };
  view = companyViewFor(serviceSource(nothingHeld, 'acc_acme'), { holders: refuse, onChain: refuse, builder: { anchorHeads: refuse } },
    judges.heldReaderFor('acc_acme', ACCOUNT));
  return { judges, taken };
};

describe('THE ANCHOR CHECKPOINT A READER\'S READ KEEPS', () => {
  it('IS NONE OF THIS DEVICE\'S: A READER\'S READ NEVER TAKES UP THE STORE A SIGNER\'S ACTS START FROM', async () => {
    const reader = judgesCounting();
    await expect(reader.judges.anchoredForAReader('acc_acme', LABEL, ACCOUNT)({} as never, {} as never)).rejects.toThrow(/reaches no builder/u);
    /* RED WHEN: a reader's read, given an account nothing ties to the company, writes into the checkpoint kept for it. */
    expect(reader.taken.count).toBe(0);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * A COMPANY'S CREATION STATE, READ IN ONE PLACE, with the shared keyring stood
 * in for at its functions: what the service says, what this tab keeps, and what
 * the person's wallet reads from the network are each set by the test.
 */
const kr = vi.hoisted(() => ({
  who: { id: 'u1' } as { id: string } | null,
  standing: 'finished' as string,
  standingFails: false,
  sealed: { companyLabel: 'label-c1', contractAddress: 'ab'.repeat(32) } as Record<string, unknown>,
  committed: 'cd'.repeat(32) as string | null,
  payments: true,
  holdersFail: false,
  being: null as string | null,
  second: false,
  asked: [] as string[],
  holders: [] as unknown[],
  standings: [] as string[],
  open: true,
  keptCommitted: true as boolean | null,
  keptAsked: [] as unknown[],
  labelAsked: [] as (string | null)[],
  label: null as string | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.who,
  api: async (path: string) => { kr.asked.push(path); return kr.sealed; },
  companyCreationStanding: async (id: string) => {
    kr.standings.push(id);
    if (kr.standingFails) throw new Error('the service did not answer');
    return { account: null, state: kr.standing };
  },
  walletShowsPayKeyCommitted: async (origin: string, company: string, account: string) => {
    kr.holders.push({ origin, ask: { company, account } });
    if (kr.holdersFail) throw new Error('the wallet did not answer');
    return kr.payments && kr.committed !== null;
  },
  canOpenCompanies: () => kr.open,
  companyBeingCreatedLabel: (id: string | null) => { kr.labelAsked.push(id); return kr.label; },
  keptCreationShowsItsKeyCommitted: async (id: string, origin: string) => {
    kr.keptAsked.push({ id, origin });
    if (kr.holdersFail) throw new Error('the wallet did not answer');
    return kr.keptCommitted;
  },
  companyBeingCreated: () => kr.being,
  companyAwaitingItsSecondPress: () => (kr.being !== null && kr.second ? { accountId: kr.being, account: 'ab'.repeat(32) } : null),
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./creation-standing.js');
}

beforeEach(() => {
  Object.assign(kr, {
    who: { id: 'u1' }, standing: 'finished', standingFails: false, sealed: { companyLabel: 'label-c1', contractAddress: 'ab'.repeat(32) },
    committed: 'cd'.repeat(32), payments: true, holdersFail: false, being: null, second: false, asked: [], holders: [], standings: [],
    open: true, keptCommitted: true, keptAsked: [], label: null, labelAsked: [],
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('a company is confirmed finished only by the wallet', () => {
  /*
   * RED WHEN: a company the service calls finished is taken as finished without
   * the wallet's own read of the account showing the pay-record key committed,
   * or the wallet is asked about another company, another account, or without
   * asking for the pay-record key's entry.
   */
  it('confirms a finished company when the wallet shows its pay-record key committed, asking about that company\'s own account', async () => {
    const { creationOf } = await load();
    const c = await creationOf('c-1');
    expect(c).toEqual({ company: 'c-1', standing: 'finished', awaitingSecondPress: false, kept: false, confirmedFinished: true, mark: null });
    expect(kr.asked).toEqual(['/api/accounts/c-1']);
    expect(kr.holders).toEqual([{
      origin: 'http://wallet.localhost:5180',
      ask: { company: 'label-c1', account: 'ab'.repeat(32) },
    }]);
  });

  /* RED WHEN: a company whose pay-record key the wallet does not show committed is taken as finished because the service says so. */
  it('does not confirm a company the service calls finished while the wallet shows no pay-record key committed', async () => {
    const { creationOf } = await load();
    kr.committed = null;
    expect((await creationOf('c-1')).confirmedFinished).toBe(false);
  });

  /* RED WHEN: an answer from the wallet that carries no payment facts is taken as the key being committed. */
  it('does not confirm a company when the wallet\'s answer holds no payment facts', async () => {
    const { creationOf } = await load();
    kr.payments = false;
    expect((await creationOf('c-1')).confirmedFinished).toBe(false);
  });

  /* RED WHEN: the wallet is asked, or the company is called finished, when the service does not say finished. */
  it('does not ask the wallet about a company the service does not call finished', async () => {
    const { creationOf } = await load();
    kr.standing = 'pay-key-owed';
    const c = await creationOf('c-1');
    expect(c.confirmedFinished).toBe(false);
    expect(c.standing).toBe('pay-key-owed');
    expect(kr.holders).toEqual([]);
  });

  /*
   * RED WHEN: a wallet that could not be asked is taken as the key being
   * committed, or leaves the company marked, or is remembered so the company
   * is never asked about again.
   */
  it('leaves a company unconfirmed and unmarked when the wallet cannot be asked, and asks again next time', async () => {
    const { creationOf } = await load();
    kr.holdersFail = true;
    expect(await creationOf('c-1')).toEqual({ company: 'c-1', standing: 'finished', awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null });
    kr.holdersFail = false;
    expect((await creationOf('c-1')).confirmedFinished).toBe(true);
    expect(kr.holders).toHaveLength(2);
  });

  /* RED WHEN: a company the service cannot name an account for is asked about at the wallet with an account made up. */
  it('leaves a company unconfirmed when the service holds no account address for it', async () => {
    const { creationOf } = await load();
    kr.sealed = { companyLabel: 'label-c1', contractAddress: null };
    expect((await creationOf('c-1')).confirmedFinished).toBe(false);
    expect(kr.holders).toEqual([]);
  });
});

describe('a company this tab keeps is confirmed by what this tab kept, never by the service\'s pair', () => {
  /*
   * RED WHEN: a company this tab keeps is confirmed finished on the label and account the service names, so a service that names another,
   * finished account closes the step; or the service's pair is even read for it.
   */
  it('asks the keyring about the kept creation and reads no pair from the service', async () => {
    const { creationOf } = await load();
    kr.being = 'c-1';
    kr.keptCommitted = false;
    expect(await creationOf('c-1')).toMatchObject({ kept: true, standing: 'finished', confirmedFinished: false });
    expect(kr.keptAsked).toEqual([{ id: 'c-1', origin: 'http://wallet.localhost:5180' }]);
    expect(kr.asked).toEqual([]);
    expect(kr.holders).toEqual([]);
  });

  /* RED WHEN: a kept creation the wallet shows committed is not confirmed. */
  it('confirms a kept creation when the kept account shows the key committed', async () => {
    const { creationOf } = await load();
    kr.being = 'c-1';
    expect((await creationOf('c-1')).confirmedFinished).toBe(true);
  });

  /* RED WHEN: a kept creation that could not be read is confirmed, or that reading is remembered. */
  it('confirms nothing and asks again when the kept creation could not be read', async () => {
    const { creationOf } = await load();
    kr.being = 'c-1';
    kr.holdersFail = true;
    expect((await creationOf('c-1')).confirmedFinished).toBe(false);
    kr.holdersFail = false;
    expect((await creationOf('c-1')).confirmedFinished).toBe(true);
  });

  /* RED WHEN: a company not kept here is asked about at the keyring, which keeps nothing for it. */
  it('asks the keyring about no company that is not the one kept here', async () => {
    const { creationOf } = await load();
    kr.being = 'c-other';
    await creationOf('c-1');
    expect(kr.keptAsked).toEqual([]);
    expect(kr.holders).toHaveLength(1);
  });
});

describe('the label the wallet drew', () => {
  /* RED WHEN: the label shown after the first press is read from anywhere but the keyring's kept creation, or for another company than the one asked about. */
  it('is the keyring\'s own, asked for the company shown', async () => {
    const { keptCreationLabel } = await load();
    kr.label = 'co_drawn';
    expect(keptCreationLabel('c-1')).toBe('co_drawn');
    expect(keptCreationLabel(null)).toBe('co_drawn');
    expect(kr.labelAsked).toEqual(['c-1', null]);
    kr.label = null;
    expect(keptCreationLabel('c-1')).toBeNull();
  });
});

describe('with the saved keys shut nothing is confirmed', () => {
  /*
   * RED WHEN: a finished company is confirmed on the service's pair while the saved keys are shut, so a creation kept in them cannot be seen
   * and step 2 closes over it; or the wallet is asked; or that reading is remembered once the keys are open.
   */
  it('confirms nothing while the keys are shut, asks nobody, and reads again once they are open', async () => {
    const { creationOf } = await load();
    kr.open = false;
    expect(await creationOf('c-1')).toMatchObject({ standing: 'finished', confirmedFinished: false });
    expect(kr.holders).toEqual([]);
    expect(kr.keptAsked).toEqual([]);
    kr.open = true;
    expect((await creationOf('c-1')).confirmedFinished).toBe(true);
  });
});

describe('what each standing means', () => {
  /*
   * RED WHEN: a standing the service can name has no entry (the table is total over the keyring's own list), or the stage a
   * finished-but-unconfirmed company waits on says the key is still being sealed, or the saved keys are not needed where
   * the next step is built from what this browser keeps.
   */
  it('has an entry for every standing, names what a finished company waits on, and needs the keys where a kept creation is read', async () => {
    const { CREATION_STANDINGS, STAGE } = await load();
    const { COMPANY_CREATION_STATES } = await import('../../../../src/core/company-founding.js');
    expect(Object.keys(CREATION_STANDINGS).sort()).toEqual([...COMPANY_CREATION_STATES].sort());
    expect(CREATION_STANDINGS.finished.stage).toBe(STAGE.shown);
    expect(CREATION_STANDINGS['pay-key-owed'].stage).toBe(STAGE.key);
    expect(Object.entries(CREATION_STANDINGS).filter(([, v]) => v.needsTheKeys).map(([k]) => k).sort())
      .toEqual(['deploy-expired', 'finish-expired', 'finished', 'not-created', 'pay-key-owed']);
  });
});

describe('which companies are marked not finished', () => {
  const OWED = ['deploy-sent', 'deploy-expired', 'finish-owed', 'finish-expired', 'finish-sent', 'pay-key-owed'];

  /* RED WHEN: a company in a state that still owes the chain a step carries no mark, or a finished or unknown one does. */
  it('marks the six owed states, and neither a finished company nor one whose state is not known', async () => {
    const { creationOf, creationChanged, CREATION_MARK } = await load();
    for (const standing of [...OWED, 'finished', 'unknown']) {
      kr.standing = standing;
      expect((await creationOf('c-1')).mark, standing).toBe(OWED.includes(standing) ? CREATION_MARK.notFinished : null);
      creationChanged('c-1');
    }
  });

  /* RED WHEN: a company made before creation moved to the browser, which the service reads as not created, is marked; or one this tab keeps is not. */
  it('marks a company the service reads as not created only when this tab keeps its creation', async () => {
    const { creationOf, creationChanged, CREATION_MARK } = await load();
    kr.standing = 'not-created';
    expect((await creationOf('c-1')).mark).toBeNull();
    kr.being = 'c-other';
    expect((await creationOf('c-1')).mark).toBeNull();
    kr.being = 'c-1';
    creationChanged('c-1');
    expect((await creationOf('c-1')).mark).toBe(CREATION_MARK.notFinished);
  });

  /* RED WHEN: a company the service could not be read for is marked as not finished. */
  it('gives no mark when the service cannot be read, even for a company this tab keeps', async () => {
    const { creationOf } = await load();
    kr.standingFails = true;
    kr.being = 'c-1';
    kr.second = true;
    expect(await creationOf('c-1')).toEqual({ company: 'c-1', standing: null, awaitingSecondPress: true, kept: true, confirmedFinished: false, mark: null });
  });
});

describe('what this tab keeps of a creation', () => {
  /* RED WHEN: a company other than the one this tab keeps is said to be kept or to wait for its second press, or the one it keeps is not. */
  it('says a company is kept, and whether it waits for its second press, only for the one this tab keeps', async () => {
    const { creationOf } = await load();
    kr.standing = 'not-created';
    kr.being = 'c-1';
    kr.second = true;
    expect(await creationOf('c-1')).toMatchObject({ kept: true, awaitingSecondPress: true });
    expect(await creationOf('c-2')).toMatchObject({ kept: false, awaitingSecondPress: false });
    kr.second = false;
    expect(await creationOf('c-1')).toMatchObject({ kept: true, awaitingSecondPress: false });
  });

  /* RED WHEN: no company shown reads nothing of the creation this tab keeps, or reads the service when this tab keeps nothing. */
  it('answers for the creation this tab keeps when no company is shown, and reads nothing when it keeps none', async () => {
    const { creationOf } = await load();
    expect(await creationOf(null)).toEqual({ company: null, standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null });
    expect(kr.standings).toEqual([]);
    kr.being = 'c-new';
    kr.standing = 'not-created';
    expect(await creationOf(null)).toMatchObject({ company: 'c-new', kept: true, mark: 'not-finished' });
    expect(kr.standings).toEqual(['c-new']);
  });
});

describe('one read for each company', () => {
  /* RED WHEN: every ask reads the service and the wallet again, so each screen that lists the company reads them again. */
  it('reads the service and the wallet once for a company, however many screens ask', async () => {
    const { creationOf } = await load();
    await Promise.all([creationOf('c-1'), creationOf('c-1'), creationOf('c-1')]);
    await creationOf('c-1');
    expect(kr.standings).toEqual(['c-1']);
    expect(kr.holders).toHaveLength(1);
  });

  /* RED WHEN: a company whose creation moved on is still read from what was kept, so it keeps its old mark. */
  it('reads a company again after a creation step changed it', async () => {
    const { creationOf, creationChanged } = await load();
    kr.standing = 'finish-owed';
    expect((await creationOf('c-1')).mark).toBe('not-finished');
    kr.standing = 'finished';
    creationChanged('c-1');
    expect(await creationOf('c-1')).toMatchObject({ standing: 'finished', mark: null, confirmedFinished: true });
  });

  /* RED WHEN: a step that changed the creation this tab keeps, named by no company, leaves that creation's old reading in place. */
  it('reads the creation this tab keeps again after a step changed it, when no company is named', async () => {
    const { creationOf, creationChanged } = await load();
    kr.being = 'c-new';
    kr.standing = 'not-created';
    await creationOf(null);
    kr.standing = 'deploy-sent';
    creationChanged(null);
    expect((await creationOf(null)).standing).toBe('deploy-sent');
  });

  /* RED WHEN: what was read for one person is served to the next person to sign in on this tab, or to nobody. */
  it('reads again once another person is signed in, or nobody is', async () => {
    const { creationOf } = await load();
    await creationOf('c-1');
    kr.who = { id: 'u2' };
    await creationOf('c-1');
    expect(kr.standings).toEqual(['c-1', 'c-1']);
    kr.who = null;
    expect((await creationOf('c-1')).standing).toBeNull();
    expect(kr.standings).toEqual(['c-1', 'c-1']);
  });

  /* RED WHEN: a person who signs out and signs in again is served what was read before they signed out. */
  it('reads again after the same person signs out and in again', async () => {
    const { creationOf } = await load();
    await creationOf('c-1');
    kr.who = null;
    await creationOf('c-1');
    kr.who = { id: 'u1' };
    await creationOf('c-1');
    expect(kr.standings).toEqual(['c-1', 'c-1']);
  });

  /* RED WHEN: a service that could not be read once is never read again for that company. */
  it('does not keep a failed reading', async () => {
    const { creationOf } = await load();
    kr.standingFails = true;
    await creationOf('c-1');
    kr.standingFails = false;
    expect((await creationOf('c-1')).standing).toBe('finished');
  });
});

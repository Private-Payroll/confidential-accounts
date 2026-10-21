// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * CARRYING A COMPANY TO FINISHED THROUGH THE ADAPTER, with the shared keyring
 * and the creation read stood in for at their functions: what the creation read
 * says is set by each test, and what the adapter sends, signs and forgets is
 * read from the calls it makes.
 */
type Read = {
  company: string | null; standing: string | null; awaitingSecondPress: boolean; kept: boolean; confirmedFinished: boolean; mark: string | null;
};
const kr = vi.hoisted(() => ({
  who: null as { id: string } | null, open: true, calls: [] as string[], builders: [] as unknown[], worker: {} as Record<string, unknown> | null,
  /** What carrying a creation on past its first press comes to: whether it did, and what then waits for the second press. */
  firstPress: false as boolean | Error, afterFirstPress: null as { accountId: string } | null,
  awaiting: null as { accountId: string } | null, afterOpen: null as { accountId: string } | null, noDeploy: null as string | null, being: null as string | null,
  fails: null as Error | null, sealFails: null as Error | null, forgetFails: null as Error | null,
  /** The kept step is short of life, and a step carried or signed is built again. */
  short: false, builds: false,
  /** While set, a step sent (the carry's finish, the press's sign) is held in flight on it. */
  gate: null as Promise<void> | null,
  /** What the creation read says, one entry per read; the last one stays. */
  reads: [] as Read[], read: 0, changed: [] as (string | null)[],
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.who,
  forgetLocally: () => { kr.who = null; },
  resumeSession: async () => { kr.who = { id: 'u1' }; return kr.who; },
  canOpenCompanies: () => kr.open,
  openKeysWithWallet: async () => { kr.calls.push('open-keys'); kr.open = true; kr.awaiting = kr.afterOpen; },
  companyAwaitingItsSecondPress: () => kr.awaiting,
  companyKeptWithNoDeploy: () => kr.noDeploy,
  carryTheFirstPressOn: async (id: string) => {
    kr.calls.push(`first-press ${id}`);
    if (kr.firstPress instanceof Error) throw kr.firstPress;
    if (kr.firstPress) kr.awaiting = kr.afterFirstPress;
    return kr.firstPress;
  },
  keptCreationRunsOutSoon: () => kr.short,
  signCompanyCreationFromTheWallet: async (id: string, _o: string, builder: unknown) => {
    kr.calls.push(`sign ${id}`); kr.builders.push(builder); kr.awaiting = null;
    if (kr.gate !== null) await kr.gate;
    return { state: 'deploy-sent', ...(kr.builds ? { builtAgain: true } : {}) };
  },
  finishCompanyOnTheChain: async (id: string, builder?: unknown) => {
    kr.calls.push(builder === undefined ? `finish ${id}` : `finish-again ${id}`); kr.builders.push(builder);
    if (kr.gate !== null) await kr.gate;
    if (kr.fails !== null) throw kr.fails;
    return { state: 'finish-sent', ...(builder !== undefined && kr.builds ? { builtAgain: true } : {}) };
  },
  sealThePayRecordKey: async (id: string, builder: unknown) => {
    kr.calls.push(`seal ${id}`); kr.builders.push(builder);
    if (kr.sealFails !== null) throw kr.sealFails;
    return { state: 'finished' };
  },
  forgetAFinishedCreation: async (id: string, origin: string) => {
    kr.calls.push(`forget-finished ${id} ${origin}`);
    if (kr.forgetFails !== null) throw kr.forgetFails;
    kr.being = null;
    return true;
  },
}));
vi.mock('./creation-standing.js', async (real) => ({
  ...(await real<typeof import('./creation-standing.js')>()),
  creationOf: async (company: string | null) => {
    kr.calls.push('read');
    const r = kr.reads[Math.min(kr.read, kr.reads.length - 1)]!;
    kr.read += 1;
    return { ...r, company: r.company === undefined ? company : r.company };
  },
  creationChanged: (id: string | null) => { kr.calls.push('changed'); kr.changed.push(id); },
}));
vi.mock('./vault-builder.js', () => ({ theCreationBuilder: async () => kr.worker }));

const aWorker = () => Object.fromEntries(['foundingSeat', 'accountDeploy', 'finishedCreation', 'creationAgain', 'payKeyStanding', 'governedCall']
  .map((n) => [n, async () => n])) as Record<string, unknown>;
const standing = (s: string | null, over: Partial<Read> = {}): Read =>
  ({ company: 'c1', standing: s, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null, ...over });
/** The calls that act on the company, without the reads and the dropped caches between them. */
const acts = () => kr.calls.filter((c) => c !== 'read' && c !== 'changed');

async function load(origin = 'http://wallet.localhost:5180') {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', origin);
  const m = await import('./finish-company.js');
  const keyring = await import('vaults-web-shared/keyring.js');
  return { m, keyring };
}

beforeEach(() => {
  Object.assign(kr, { who: { id: 'u1' }, open: true, calls: [], builders: [], worker: aWorker(), awaiting: null, afterOpen: null, noDeploy: null, being: null, firstPress: false, afterFirstPress: null,
    fails: null, sealFails: null, forgetFails: null, short: false, builds: false, gate: null, reads: [standing('finish-owed')], read: 0, changed: [] });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('carrying a company to finished', () => {
  /* RED WHEN: a company the service calls finished is said finished before the wallet's own read confirms it, or the wallet's read is not what ends the step. */
  it('is finished only when the wallet\'s own read confirms it, and a finished standing alone only waits', async () => {
    const { m } = await load();
    kr.reads = [standing('finished')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'waiting', companyId: 'c1', stage: 'shown' });
    kr.reads = [standing('finished', { confirmedFinished: true })];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'done', companyId: 'c1' });
    expect(acts()).toEqual([]);
  });

  /* RED WHEN: the creation is read from a cache that was kept from before the last step, so a polled company never reads as moved on. */
  it('drops the cached read before every read, and again after a step it takes', async () => {
    const { m } = await load();
    kr.reads = [standing('finish-owed')];
    await m.carryOn('u1', 'c1');
    expect(kr.calls).toEqual(['changed', 'read', `finish c1`, 'changed']);
    kr.calls = [];
    await m.carryOn('u1', 'c1');
    expect(kr.calls).toEqual(['changed', 'read']);
    expect(kr.changed.every((id) => id === 'c1')).toBe(true);
  });

  /* RED WHEN: the finishing step is sent on every poll while the company reads finish-owed, or is sent again before the standing reads finish-expired. */
  it('sends the finishing step once, waits while the service cannot tell sent from owed, and sends again only after it ran out', async () => {
    const { m } = await load();
    kr.reads = [standing('finish-owed')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'waiting', companyId: 'c1', stage: 'finish' });
    expect(acts()).toEqual(['finish c1']);
    const polled = [await m.carryOn('u1', 'c1'), await m.carryOn('u1', 'c1'), await m.carryOn('u1', 'c1')];
    expect(polled).toEqual(Array(3).fill({ of: 'waiting', companyId: 'c1', stage: 'finish' }));
    expect(acts()).toEqual(['finish c1']);
    /* RED WHEN: a finishing step that can no longer land is not carried again with the page's worker, or is carried again without it. */
    kr.reads = [standing('finish-expired')];
    await m.carryOn('u1', 'c1');
    expect(acts()).toEqual(['finish c1', 'finish-again c1']);
    expect(kr.builders.at(-1)).toMatchObject({ foundingSeat: kr.worker!.foundingSeat, creationAgain: kr.worker!.creationAgain });
    /* RED WHEN: after the finishing step is carried again, an owed read sends it a third time before it runs out again. */
    kr.reads = [standing('finish-owed')];
    await m.carryOn('u1', 'c1');
    expect(acts()).toEqual(['finish c1', 'finish-again c1']);
  });

  /* RED WHEN: a finishing step carried again after it ran out is sent a second time when the service reads it owed straight after. */
  it('does not send the finishing step again when it reads owed right after being carried again', async () => {
    const { m } = await load();
    kr.reads = [standing('finish-expired')];
    await m.carryOn('u1', 'c1');
    kr.reads = [standing('finish-owed')];
    await m.carryOn('u1', 'c1');
    expect(acts()).toEqual(['finish-again c1']);
  });

  /* RED WHEN: a finishing step that failed to reach the service cannot be sent again by the person's next try. */
  it('a finishing step that failed is sent again when the person tries again, and says why by the refusal\'s kind', async () => {
    const { m } = await load();
    kr.fails = new TypeError('offline');
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'refused', why: 'unreachable', companyId: 'c1' });
    kr.fails = null;
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'waiting', companyId: 'c1', stage: 'finish' });
    expect(acts()).toEqual(['finish c1', 'finish c1']);
  });

  /* RED WHEN: a deploy that ran out waits for a press instead of being carried again, or is carried again without the page's worker. */
  it('carries a deploy that ran out again with no wallet press', async () => {
    const { m } = await load();
    kr.reads = [standing('deploy-expired')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'waiting', companyId: 'c1', stage: 'deploy' });
    expect(acts()).toEqual(['finish-again c1']);
    expect(kr.builders[0]).toMatchObject({ accountDeploy: kr.worker!.accountDeploy });
    /* RED WHEN: carrying the deploy again counts as the finishing step sent, so the finishing step is never sent once the account lands. */
    kr.reads = [standing('finish-owed')];
    await m.carryOn('u1', 'c1');
    expect(acts()).toEqual(['finish-again c1', 'finish c1']);
  });

  /* RED WHEN: a finishing step this browser kept with too little life left is sent as the service recorded it, and the node answers "Custom error: 228". */
  it('builds a finishing step that is short of life again, though the service still reads it owed, and says so', async () => {
    const { m } = await load();
    kr.short = true;
    kr.builds = true;
    kr.reads = [standing('finish-owed')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'waiting', companyId: 'c1', stage: 'finish', builtAgain: true });
    expect(acts()).toEqual(['finish-again c1']);
    expect(kr.builders[0]).toMatchObject({ creationAgain: kr.worker!.creationAgain });
    /* RED WHEN: a step with life left is built again at every look, or the builder is asked for when none is needed. */
    kr.short = false;
    kr.builds = false;
    kr.reads = [standing('finish-expired')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'waiting', companyId: 'c1', stage: 'finish' });
  });

  /* RED WHEN: a deploy sent and not landed, short of life, is waited for until it runs out for good, and the person waits with it. */
  it('builds a deploy that was sent and has not landed again once it is short of life, and does not count that as the finishing step sent', async () => {
    const { m } = await load();
    kr.short = true;
    kr.reads = [standing('deploy-sent')];
    await m.carryOn('u1', 'c1');
    expect(acts()).toEqual(['finish-again c1']);
    kr.short = false;
    kr.reads = [standing('deploy-sent')];
    await m.carryOn('u1', 'c1');
    expect(acts()).toEqual(['finish-again c1']);
    kr.reads = [standing('finish-owed')];
    await m.carryOn('u1', 'c1');
    expect(acts()).toEqual(['finish-again c1', 'finish c1']);
  });

  /* RED WHEN: a pay-record key owed is not sealed with the page's worker, or the step is called done on the sealing alone without the wallet's read. */
  it('seals the pay-record key when it is owed, and ends only when the wallet confirms', async () => {
    const { m } = await load();
    kr.reads = [standing('pay-key-owed'), standing('finished')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'waiting', companyId: 'c1', stage: 'key' });
    expect(acts()).toEqual(['seal c1']);
    expect(kr.builders[0]).toMatchObject({ payKeyStanding: kr.worker!.payKeyStanding });
    kr.calls = [];
    kr.being = 'c1';
    kr.reads = [standing('pay-key-owed', { kept: true }), standing('finished', { kept: true, confirmedFinished: true })];
    kr.read = 0;
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'done', companyId: 'c1' });
    /* RED WHEN: sealing the key ends the step without the creation this browser kept being dropped on the wallet's read, so every later company is refused. */
    expect(acts()).toEqual(['seal c1', 'forget-finished c1 http://wallet.localhost:5180']);
  });

  /* RED WHEN: a state in which the chain is working takes a step, or is shown as the wrong stage. */
  it('takes no step while the chain works, and names the stage it waits on', async () => {
    const { m } = await load();
    const stages: [string | null, string][] = [
      ['deploy-sent', 'deploy'], ['finish-sent', 'finish'], ['finished', 'shown'], ['unknown', 'read'], [null, 'read'],
    ];
    for (const [state, stage] of stages) {
      kr.reads = [standing(state)];
      expect(await m.carryOn('u1', 'c1'), String(state)).toEqual({ of: 'waiting', companyId: 'c1', stage });
    }
    expect(acts()).toEqual([]);
  });

  /* RED WHEN: a creation still kept after the company is confirmed finished is not forgotten, so the person is stranded; or one is forgotten that was never confirmed. */
  it('forgets the kept creation once the wallet confirms the company finished, and not before', async () => {
    const { m } = await load();
    kr.being = 'c1';
    kr.reads = [standing('finished', { kept: true })];
    await m.carryOn('u1', 'c1');
    expect(acts()).toEqual([]);
    kr.reads = [standing('finished', { kept: true, confirmedFinished: true })];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'done', companyId: 'c1' });
    expect(acts()).toEqual(['forget-finished c1 http://wallet.localhost:5180']);
    kr.calls = [];
    kr.reads = [standing('finished', { confirmedFinished: true })];
    await m.carryOn('u1', 'c1');
    expect(acts()).toEqual([]);
  });

  /* RED WHEN: a creation waiting for its second press is carried on without the wallet, or the wallet is the only way a company that nothing here keeps is said finishable. */
  it('says what a company not yet sent needs: the wallet, a new start, a new company, or only time', async () => {
    const { m } = await load();
    kr.reads = [standing('not-created', { kept: true, awaitingSecondPress: true })];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'press', companyId: 'c1' });
    kr.reads = [standing('not-created', { kept: true })];
    kr.noDeploy = 'c1';
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'no-deploy', companyId: 'c1' });
    kr.noDeploy = null;
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'waiting', companyId: 'c1', stage: 'deploy' });
    kr.reads = [standing('not-created')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'cannot', companyId: 'c1' });
    kr.reads = [standing(null, { company: null })];
    expect(await m.carryOn('u1', null)).toEqual({ of: 'none' });
    /* the only thing tried was carrying the kept creation on, which had nothing to carry */
    expect(acts()).toEqual(['first-press c1']);
  });

  /* RED WHEN: a creation whose first post or deploy never got made is only offered to be started again, so a person who reloaded cannot carry it on. */
  it('carries a creation with no deploy on from its first press, and offers starting again only when that cannot be done', async () => {
    const { m } = await load();
    kr.reads = [standing('not-created', { kept: true })];
    kr.noDeploy = 'c1';
    kr.firstPress = true;
    kr.afterFirstPress = { accountId: 'c1' };
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'press', companyId: 'c1' });
    expect(acts()).toEqual(['first-press c1']);
    kr.calls = []; kr.awaiting = null; kr.firstPress = new Error('the service did not answer');
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'no-deploy', companyId: 'c1' });
    expect(acts()).toEqual(['first-press c1']);
  });

  /* RED WHEN: a carry for one company is answered with another company's, the other's wait holds this one off, or both are not kept in flight at once. */
  it('keeps one carry for each company: nobody gets another company\'s answer, and the same company shares one', async () => {
    const { m } = await load();
    const { lane } = await import('./sends.js');
    kr.reads = [standing('finish-owed', { company: undefined }), standing('deploy-sent', { company: undefined })];
    let release!: () => void;
    kr.gate = new Promise<void>((r) => { release = r; });
    const a = m.carryOn('u1', 'c1');
    await vi.waitFor(() => expect(acts()).toEqual(['finish c1']));
    expect(m.carryOn('u1', 'c1')).toBe(a);
    /* RED WHEN: a second company is handed the first one's carry. */
    expect(await m.carryOn('u1', 'c2')).toEqual({ of: 'waiting', companyId: 'c2', stage: 'deploy' });
    expect(lane.carrying).not.toBeNull();
    release();
    expect(await a).toEqual({ of: 'waiting', companyId: 'c1', stage: 'finish' });
    await Promise.resolve();
    expect(lane.carrying).toBeNull();
  });

  /* RED WHEN: with the saved keys shut, a company this tab may keep is said unfinishable, or a step that needs the keys is tried without them. */
  it('asks for the wallet when the saved keys are shut and the step needs them', async () => {
    const { m } = await load();
    kr.open = false;
    for (const state of ['not-created', 'deploy-expired', 'finish-expired', 'pay-key-owed']) {
      kr.reads = [standing(state)];
      expect(await m.carryOn('u1', 'c1'), state).toEqual({ of: 'locked', companyId: 'c1' });
    }
    /* RED WHEN: a step that needs no keys waits for the wallet. */
    kr.reads = [standing('finish-owed')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'waiting', companyId: 'c1', stage: 'finish' });
    expect(acts()).toEqual(['finish c1']);
  });

  /*
   * RED WHEN: a company confirmed finished while the saved keys are shut is called done, so step 2 closes over a creation this tab may keep and
   * every later company is refused; or the keys are not asked for; or a creation is forgotten before the keys are open.
   */
  it('asks for the wallet instead of calling a finished company done while the saved keys are shut, then forgets once they are open', async () => {
    const { m } = await load();
    kr.open = false;
    kr.reads = [standing('finished', { confirmedFinished: true })];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'locked', companyId: 'c1' });
    kr.reads = [standing('finished')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'locked', companyId: 'c1' });
    expect(acts()).toEqual([]);
    kr.being = 'c1';
    kr.open = true;
    kr.reads = [standing('finished', { kept: true, confirmedFinished: true })];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'done', companyId: 'c1' });
    expect(acts()).toEqual(['forget-finished c1 http://wallet.localhost:5180']);
  });

  /* RED WHEN: a kept creation the keyring will not forget (the wallet does not show the key committed on the kept account) still closes the step. */
  it('is not done when the keyring refuses to forget the kept creation, and says why by the refusal\'s kind', async () => {
    const { m } = await load();
    kr.being = 'c1';
    kr.forgetFails = new Error('your wallet does not show this company\'s pay-record key committed');
    kr.reads = [standing('finished', { kept: true, confirmedFinished: true })];
    const r = await m.carryOn('u1', 'c1');
    expect(r).toMatchObject({ of: 'refused', companyId: 'c1' });
    expect(kr.being).toBe('c1');
  });

  /* RED WHEN: a refusal from a step is handed on in the keyring's words, or a failed sealing is called waiting. */
  it('says why a step did not happen by the refusal\'s kind, and stops there', async () => {
    const { m, keyring } = await load();
    kr.reads = [standing('pay-key-owed')];
    kr.sealFails = new keyring.SavedKeysDidNotOpen('the words of the keyring');
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'refused', why: 'keys-did-not-open', companyId: 'c1' });
    kr.sealFails = new Error('the chain does not show your approval yet');
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'refused', why: 'did-not-finish', companyId: 'c1' });
  });

  /* RED WHEN: two reads of the same company at once send a step twice. */
  it('shares one run between callers that ask while it runs', async () => {
    const { m } = await load();
    const [a, b] = await Promise.all([m.carryOn('u1', 'c1'), m.carryOn('u1', 'c1')]);
    expect(a).toBe(b);
    expect(acts()).toEqual(['finish c1']);
  });

  /* RED WHEN: a page whose worker cannot build an account takes a step that needs one, or signs. */
  it('takes no step that needs the page\'s worker when it cannot build an account', async () => {
    const { m } = await load();
    kr.worker = null;
    for (const state of ['pay-key-owed', 'finish-expired', 'deploy-expired']) {
      kr.reads = [standing(state)];
      expect(await m.carryOn('u1', 'c1'), state).toEqual({ of: 'refused', why: 'did-not-finish', companyId: 'c1' });
    }
    kr.awaiting = { accountId: 'c1' };
    expect(await m.openYourWallet('u1', 'c1')).toEqual({ of: 'refused', why: 'did-not-finish' });
    expect(acts()).toEqual([]);
  });

  /* RED WHEN: a page that does not know where the account is, or a person not signed in, carries anything on. */
  it('carries nothing on for a page not set up or a person who is not signed in', async () => {
    let { m } = await load('');
    expect(await m.carryOn('u1', 'c1')).toMatchObject({ of: 'refused', why: 'not-set-up' });
    expect(await m.openYourWallet('u1', 'c1')).toMatchObject({ of: 'refused', why: 'not-set-up' });
    ({ m } = await load());
    kr.who = { id: 'u9' };
    expect(await m.carryOn('u2', 'c1')).toMatchObject({ of: 'refused', why: 'not-signed-in' });
    expect(await m.openYourWallet('u2', 'c1')).toMatchObject({ of: 'refused', why: 'not-signed-in' });
    expect(acts()).toEqual([]);
  });
});

describe('the wallet press that signs the company', () => {
  /* RED WHEN: the press signs without a creation waiting for it, does not sign one that waits, or leaves the read as it was. */
  it('signs the creation that waits with the page\'s worker, and drops the cached read', async () => {
    const { m } = await load();
    kr.awaiting = { accountId: 'c1' };
    kr.being = 'c1';
    /* RED WHEN: with no company named, the press signs some creation this browser keeps, though several can be kept and each is signed on its own. */
    expect(await m.openYourWallet('u1', null)).toEqual({ of: 'done' });
    expect(acts()).toEqual([]);
    expect(await m.openYourWallet('u1', 'c1')).toEqual({ of: 'done' });
    expect(acts()).toEqual(['sign c1']);
    expect(kr.builders[0]).toMatchObject({ foundingSeat: kr.worker!.foundingSeat });
    expect(kr.changed).toContain('c1');
    kr.calls = [];
    expect(await m.openYourWallet('u1', 'c1')).toEqual({ of: 'done' });
    expect(acts()).toEqual([]);
  });

  /* RED WHEN: the screen is not told that the press built a ran-out step again, so it cannot say so. */
  it('hands on that the press built a ran-out step again', async () => {
    const { m } = await load();
    kr.awaiting = { accountId: 'c1' };
    kr.builds = true;
    expect(await m.openYourWallet('u1', 'c1')).toEqual({ of: 'done', builtAgain: true });
  });

  /* RED WHEN: the press signs and sends while the carry is still sending the step it owes, so the service is asked for the same deploy twice. */
  it('waits for a carry that is sending before it signs and sends', async () => {
    const { m } = await load();
    kr.awaiting = { accountId: 'c1' };
    kr.being = 'c1';
    let release!: () => void;
    kr.gate = new Promise<void>((r) => { release = r; });
    const carrying = m.carryOn('u1', 'c1');
    await vi.waitFor(() => expect(acts()).toEqual(['finish c1']));
    const pressing = m.openYourWallet('u1', 'c1');
    await new Promise((r) => setTimeout(r, 50));
    expect(acts()).toEqual(['finish c1']);
    release();
    await carrying;
    expect(await pressing).toEqual({ of: 'done' });
    expect(acts()).toEqual(['finish c1', 'sign c1']);
  });

  /* RED WHEN: a carry sends a step while the press is signing and sending, so the service is asked for the same deploy twice. */
  it('takes no step in a carry that starts while the press is running, and is one press when pressed twice', async () => {
    const { m } = await load();
    kr.awaiting = { accountId: 'c1' };
    kr.being = 'c1';
    let release!: () => void;
    kr.gate = new Promise<void>((r) => { release = r; });
    const first = m.openYourWallet('u1', 'c1');
    const second = m.openYourWallet('u1', 'c1');
    await vi.waitFor(() => expect(acts()).toEqual(['sign c1']));
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'waiting', companyId: 'c1', stage: 'finish' });
    expect(acts()).toEqual(['sign c1']);
    release();
    expect(await Promise.all([first, second])).toEqual([{ of: 'done' }, { of: 'done' }]);
    expect(acts()).toEqual(['sign c1']);
    /* The press over, the carry sends the step owed as before. */
    kr.gate = null;
    await m.carryOn('u1', 'c1');
    expect(acts()).toEqual(['sign c1', 'finish c1']);
  });

  /* RED WHEN: starting a creation again runs while a carry is still sending, so the rebuild puts back the creation just set aside. */
  it('starts again only after a carry that is sending has ended, and lets nothing be sent meanwhile', async () => {
    const { m } = await load();
    kr.being = 'c1';
    let release!: () => void;
    kr.gate = new Promise<void>((r) => { release = r; });
    const carrying = m.carryOn('u1', 'c1');
    await vi.waitFor(() => expect(acts()).toEqual(['finish c1']));
    const { whileNothingIsSent } = await import('./sends.js');
    const ran: string[] = [];
    let endWork!: () => void;
    const working = whileNothingIsSent(async () => { ran.push('start-again'); await new Promise<void>((r) => { endWork = r; }); return 'again'; });
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toEqual([]);
    release();
    await carrying;
    await vi.waitFor(() => expect(ran).toEqual(['start-again']));
    /* RED WHEN: a carry or a press that begins while a creation is being started again takes a step. */
    kr.gate = null;
    kr.reads = [standing('pay-key-owed')];
    expect(await m.carryOn('u1', 'c1')).toMatchObject({ of: 'waiting', companyId: 'c1' });
    const pressing = m.openYourWallet('u1', 'c1');
    kr.awaiting = { accountId: 'c1' };
    await new Promise((r) => setTimeout(r, 50));
    expect(acts()).toEqual(['finish c1']);
    endWork();
    expect(await working).toBe('again');
    await pressing;
  });

  /* RED WHEN: saved keys that are shut are not opened before the creation kept in them is looked for, so a reloaded tab cannot finish its company. */
  it('opens the saved keys first when they are shut, and signs what they hold', async () => {
    const { m } = await load();
    kr.open = false;
    kr.afterOpen = { accountId: 'c1' };
    expect(await m.openYourWallet('u1', 'c1')).toEqual({ of: 'done' });
    expect(acts()).toEqual(['open-keys', 'sign c1']);
    /* RED WHEN: keys already open are opened again, which asks the wallet for nothing. */
    kr.calls = [];
    expect(await m.openYourWallet('u1', 'c1')).toEqual({ of: 'done' });
    expect(acts()).toEqual([]);
  });

  /* RED WHEN: a refusal of the wallet is handed on in its words. */
  it('says why the wallet did not sign by the refusal\'s kind', async () => {
    const { m, keyring } = await load();
    kr.awaiting = { accountId: 'c1' };
    const wallet = await import('vaults-web-shared/wallet-sign-in.js');
    vi.spyOn(keyring, 'signCompanyCreationFromTheWallet').mockRejectedValueOnce(new wallet.WalletClosed({ of: 'declined' }, 'x'));
    expect(await m.openYourWallet('u1', 'c1')).toEqual({ of: 'refused', why: 'declined' });
  });
});

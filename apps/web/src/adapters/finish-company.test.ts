// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * FINISHING A COMPANY THROUGH THE ADAPTER, with the shared keyring and the creation read stood in for at their
 * functions: what the creation read says is set by each test, and what the adapter asks of the wallet is read from the
 * calls it makes. The wallet runs the whole of finishing a company as one action (`finishCompanyInTheWallet`); a look
 * at the company only says what the screen shows.
 */
type Read = {
  company: string | null; standing: string | null; awaitingSecondPress: boolean; kept: boolean; confirmedFinished: boolean; mark: string | null;
};
const kr = vi.hoisted(() => ({
  who: null as { id: string } | null, open: true, calls: [] as string[],
  awaiting: null as { accountId: string } | null,
  /** What the action in the wallet comes to. */
  ended: { of: 'done' } as Record<string, unknown> | Error,
  steps: [] as Array<{ step: number; steps: number }>,
  gate: null as Promise<void> | null, forgetFails: null as Error | null,
  /** Whether a creation set aside is there to take up. */
  aside: false,
  reads: [] as Read[], read: 0,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.who,
  forgetLocally: () => { kr.who = null; },
  resumeSession: async () => { kr.who = { id: 'u1' }; return kr.who; },
  canOpenCompanies: () => kr.open,
  openKeysWithWallet: async () => { kr.calls.push('open-keys'); kr.open = true; },
  companyAwaitingItsSecondPress: () => kr.awaiting,
  finishCompanyInTheWallet: async (id: string, _origin: string, opts: { onStep?: (at: { step: number; steps: number }) => void }) => {
    kr.calls.push(`act ${id}`);
    for (const at of kr.steps) opts.onStep?.(at);
    if (kr.gate !== null) await kr.gate;
    if (kr.ended instanceof Error) throw kr.ended;
    return kr.ended;
  },
  takeUpACreationSetAside: async (id: string) => {
    kr.calls.push(`take-up ${id}`);
    const was = kr.aside;
    kr.aside = false;
    return was;
  },
  forgetAFinishedCreation: async (id: string) => {
    kr.calls.push(`forget-finished ${id}`);
    if (kr.forgetFails !== null) throw kr.forgetFails;
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
  creationChanged: () => { kr.calls.push('changed'); },
}));

const standing = (s: string | null, over: Partial<Read> = {}): Read =>
  ({ company: 'c1', standing: s, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null, ...over });
const kept = (s: string | null): Read => standing(s, { kept: true, awaitingSecondPress: true });
/** The calls that act on the company, without the reads and the dropped caches between them. */
const acts = () => kr.calls.filter((c) => c !== 'read' && c !== 'changed');

async function load(origin = 'http://wallet.localhost:5180') {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', origin);
  return import('./finish-company.js');
}

beforeEach(() => {
  Object.assign(kr, {
    who: { id: 'u1' }, open: true, calls: [], awaiting: { accountId: 'c1' }, ended: { of: 'done' }, steps: [], gate: null,
    forgetFails: null, reads: [kept('not-created')], read: 0, aside: false,
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('finishing a company', () => {
  /* RED WHEN: a look at the company builds, proves or sends anything, at any standing: the pay-record key's proofs or the account's second step run with no press. */
  it('looks without acting, at every standing a company can be in', async () => {
    const m = await load();
    for (const s of ['not-created', 'deploy-sent', 'deploy-expired', 'finish-owed', 'finish-expired', 'finish-sent', 'pay-key-owed', 'finished', 'unknown']) {
      for (const read of [kept(s), standing(s)]) {
        kr.reads = [read];
        kr.read = 0;
        await m.carryOn('u1', 'c1');
      }
    }
    /* Taking up a creation set aside is a write to the saved keys, not a step of the company: it is the only thing a look may do. */
    expect(acts().filter((c) => !c.startsWith('take-up '))).toEqual([]);
  });

  /* RED WHEN: a company the service calls finished is said finished before the wallet's own read confirms it. */
  it('is finished only when the wallet\'s own read confirms it, and drops what was kept then', async () => {
    const m = await load();
    kr.reads = [standing('finished')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'waiting', companyId: 'c1', stage: 'shown' });
    kr.reads = [standing('finished', { confirmedFinished: true, kept: true })];
    kr.read = 0;
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'done', companyId: 'c1' });
    expect(acts().filter((c) => !c.startsWith('take-up '))).toEqual(['forget-finished c1']);
  });

  /* RED WHEN: a kept company nothing was sent for is not one press away, or a company sent before a reload shows as waiting for nothing instead of interrupted at its step. */
  it('says a kept company is one press away, or interrupted at the step its standing shows', async () => {
    const m = await load();
    const look = async (s: string) => { kr.reads = [kept(s)]; kr.read = 0; return m.carryOn('u1', 'c1'); };
    expect(await look('not-created')).toEqual({ of: 'press', companyId: 'c1' });
    for (const [s, step] of [['deploy-sent', 2], ['deploy-expired', 2], ['finish-owed', 2], ['finish-sent', 2], ['pay-key-owed', 3]] as const) {
      expect(await look(s), s).toEqual({ of: 'interrupted', companyId: 'c1', step, steps: m.FINISH_STEPS });
    }
  });

  /* RED WHEN: a creation set aside whose account later landed is never taken up again, so it can never be finished; or one is taken up while its account has not landed. */
  it('takes up again a creation set aside once its account has landed, and then offers to carry it on', async () => {
    const m = await load();
    kr.aside = true;
    kr.reads = [standing('deploy-expired')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'cannot', companyId: 'c1' });
    expect(acts()).toEqual([]);
    kr.reads = [standing('finish-owed'), kept('finish-owed')];
    kr.read = 0;
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'interrupted', companyId: 'c1', step: 2, steps: m.FINISH_STEPS });
    expect(acts()).toEqual(['take-up c1']);
  });

  /* RED WHEN: a company these saved keys do not keep is offered a press that cannot finish it, or shut saved keys are not said. */
  it('says a company not kept here cannot be finished from here, and shut saved keys are opened first', async () => {
    const m = await load();
    kr.reads = [standing('deploy-sent')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'cannot', companyId: 'c1' });
    kr.open = false;
    kr.reads = [kept('pay-key-owed')];
    kr.read = 0;
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'locked', companyId: 'c1' });
  });

  /*
   * RED WHEN: a reload after the account was sent, which leaves the tab holding no saved keys, says the company cannot be
   * finished from here and offers a new company, though the wallet's own action carries it on; or the carry on is more
   * than the one action.
   */
  it('after a reload with the account sent, offers to carry it on at its step with the one action', async () => {
    const m = await load();
    kr.open = false;
    kr.awaiting = null;
    for (const s of ['deploy-sent', 'finish-owed', 'finish-sent']) {
      kr.reads = [standing(s)];
      kr.read = 0;
      expect(await m.carryOn('u1', 'c1'), s).toEqual({ of: 'interrupted', companyId: 'c1', step: 2, steps: m.FINISH_STEPS });
    }
    kr.reads = [standing('unknown')];
    kr.read = 0;
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'cannot', companyId: 'c1' });
    expect(await m.openYourWallet('u1', 'c1')).toEqual({ of: 'done' });
    expect(acts().filter((c) => !c.startsWith('take-up '))).toEqual(['act c1']);
  });

  /* RED WHEN: the press does more than one action in the wallet, opens anything first while the keys are open, or loses the steps the wallet reports. */
  it('runs the whole of it as one action in the wallet, and hands on the step the wallet is on', async () => {
    const m = await load();
    kr.steps = [{ step: 1, steps: 5 }, { step: 4, steps: 5 }];
    const seen: string[] = [];
    expect(await m.openYourWallet('u1', 'c1', (step, steps) => { seen.push(`${step}/${steps}`); })).toEqual({ of: 'done' });
    expect(acts()).toEqual(['act c1']);
    expect(seen).toEqual(['1/5', '4/5']);
  });

  /* RED WHEN: an action that stopped is reported as done, or the next look forgets where it stopped. */
  it('says where the action stopped, and the next look shows it interrupted there', async () => {
    const m = await load();
    kr.ended = { of: 'stopped', step: 4, steps: 5, relayed: 3, unconfirmed: 0, why: 'stopped' };
    expect(await m.openYourWallet('u1', 'c1')).toEqual({ of: 'interrupted', step: 4, steps: 5 });
    kr.reads = [kept('pay-key-owed')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'interrupted', companyId: 'c1', step: 4, steps: 5 });
  });

  /* RED WHEN: with the saved keys shut, the press asks the wallet for more than opening them, or does not open them. */
  /* RED WHEN: a press in a tab the wallet has not read the saved keys for opens a window to read them and finishes nothing, so finishing costs two windows. */
  it('finishes the company with the one press when the saved keys are shut, asking the wallet nothing first', async () => {
    const m = await load();
    kr.open = false;
    expect(await m.openYourWallet('u1', 'c1')).toEqual({ of: 'done' });
    expect(acts()).toEqual(['act c1']);
  });

  /* RED WHEN: two presses at once run two actions, or a look taken while the action runs says anything but that it runs. */
  it('makes two presses at once one action, and a look while it runs says it waits', async () => {
    const m = await load();
    let release!: () => void;
    kr.gate = new Promise<void>((r) => { release = r; });
    const one = m.openYourWallet('u1', 'c1');
    const two = m.openYourWallet('u1', 'c1');
    await new Promise((r) => { setTimeout(r, 0); });
    kr.reads = [kept('deploy-sent')];
    expect(await m.carryOn('u1', 'c1')).toEqual({ of: 'waiting', companyId: 'c1', stage: 'deploy' });
    release();
    expect(await one).toEqual({ of: 'done' });
    expect(await two).toEqual({ of: 'done' });
    expect(acts()).toEqual(['act c1']);
  });

  /* RED WHEN: a refusal is lost, or the press runs with no wallet set up or nobody signed in. */
  it('refuses by the refusal\'s kind, and runs nothing when the wallet is not set up or nobody is signed in', async () => {
    let m = await load();
    kr.ended = new Error('the page had already closed this request');
    const refused = await m.openYourWallet('u1', 'c1');
    expect(refused.of).toBe('refused');
    m = await load('');
    expect(await m.openYourWallet('u1', 'c1')).toEqual({ of: 'refused', why: 'not-set-up' });
    expect(acts()).toEqual(['act c1']);
  });
});

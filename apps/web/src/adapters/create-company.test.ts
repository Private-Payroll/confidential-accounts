// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * CREATING A COMPANY THROUGH THE ADAPTER, ON THIS DEVICE, WITH THE SHARED
 * KEYRING STOOD IN FOR AT ITS FUNCTIONS AND ITS OWN REFUSALS KEPT, so what the
 * adapter hands the keyring and what it hands a screen back are both read.
 */
const kr = vi.hoisted(() => ({
  who: null as { id: string } | null, resumed: 0, forgot: 0, calls: [] as string[], specs: [] as unknown[], builders: [] as unknown[],
  started: async (): Promise<{ accountId: string; account: string }> => ({ accountId: 'acc_new', account: 'ab'.repeat(32) }),
  being: null as string | null, second: false, standing: 'deploy-sent' as string,
  signed: 'deploy-sent' as string, finished: 'pay-key-owed' as string, sealed: 'finished' as string,
  worker: {} as Record<string, unknown>,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.who,
  forgetLocally: () => { kr.forgot += 1; kr.who = null; },
  resumeSession: async () => { kr.resumed += 1; kr.who = { id: 'u1' }; return kr.who; },
  startCompanyHeldFromTheStart: async (spec: unknown, _origin: string, builder: unknown) => {
    kr.calls.push('start'); kr.specs.push(spec); kr.builders.push(builder); const r = await kr.started(); kr.being = r.accountId; kr.second = true; return r;
  },
  signCompanyCreationFromTheWallet: async () => { kr.calls.push('sign'); kr.second = false; return { accountId: kr.being, account: null, state: kr.signed }; },
  companyCreationStanding: async () => { kr.calls.push('standing'); return { account: null, state: kr.standing }; },
  finishCompanyOnTheChain: async () => { kr.calls.push('finish'); return { account: null, state: kr.finished }; },
  sealThePayRecordKey: async () => { kr.calls.push('seal'); if (kr.sealed === 'finished') kr.being = null; return { state: kr.sealed }; },
  companyBeingCreated: () => kr.being,
  companyAwaitingItsSecondPress: () => (kr.second && kr.being !== null ? { accountId: kr.being, account: 'ab'.repeat(32) } : null),
  createCompanyWithWallet: async () => { kr.calls.push('the service\'s path'); return { accountId: 'acc_service' }; },
}));
vi.mock('./vault-builder.js', () => ({ theVaultBuilder: async () => kr.worker }));

const aWorker = () => Object.fromEntries(['foundingSeat', 'accountDeploy', 'finishedCreation', 'creationAgain', 'payKeyStanding', 'governedCall']
  .map((n) => [n, async () => n]));

async function load(origin = 'http://wallet.localhost:5180') {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', origin);
  const m = await import('./create-company.js');
  const keyring = await import('vaults-web-shared/keyring.js');
  const wallet = await import('vaults-web-shared/wallet-sign-in.js');
  return { m, keyring, wallet };
}

beforeEach(() => {
  Object.assign(kr, { who: null, resumed: 0, forgot: 0, calls: [], specs: [], builders: [], being: null, second: false, standing: 'deploy-sent',
    signed: 'deploy-sent', finished: 'pay-key-owed', sealed: 'finished', worker: aWorker() });
  kr.started = async () => ({ accountId: 'acc_new', account: 'ab'.repeat(32) });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('creating a company on this device', () => {
  /* RED WHEN: the button creates the company on the service's path, not this device's, or not with the person as its one signer at one approval, under the name typed. */
  it('the first press makes it here, held by the person\'s own key, built with the page\'s vault worker, and sends nothing to the chain', async () => {
    const { m } = await load();
    kr.who = { id: 'u1' };
    expect(await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' })).toEqual({ of: 'waiting', companyId: 'acc_new', state: 'not-created' });
    expect(kr.calls).toEqual(['start']);
    expect(kr.specs).toEqual([{ name: 'Acme', signers: [{ name: 'Priya', role: 'admin' }], threshold: 1 }]);
    /* RED WHEN: the builder handed to the keyring is not the page's worker's own functions. */
    const builder = kr.builders[0] as Record<string, unknown>;
    for (const n of ['foundingSeat', 'accountDeploy', 'finishedCreation', 'creationAgain', 'payKeyStanding', 'governedCall']) expect(builder[n], n).toBe(kr.worker[n]);
    expect(m.waitingToBeFinished()).toBe('acc_new');
  });

  /* RED WHEN: Finish does not carry a company on as far as the chain allows: signed, sent, finished on the chain and its pay-record key sealed, in that order. */
  it('Finish signs it and sends it, then carries it on from where the chain stands until it is finished', async () => {
    const { m } = await load();
    kr.who = { id: 'u1' };
    await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' });
    kr.calls = [];
    expect(await m.finishCreating('u1')).toEqual({ of: 'waiting', companyId: 'acc_new', state: 'deploy-sent' });
    /* RED WHEN: the second press reads the service before signing, or signs and then reads nothing. */
    expect(kr.calls).toEqual(['sign']);
    kr.calls = [];
    kr.standing = 'finish-owed';
    expect(await m.finishCreating('u1')).toEqual({ of: 'done', companyId: 'acc_new' });
    /* RED WHEN: the wallet is asked to sign again once the service recorded the company, or a step is skipped or taken out of order. */
    expect(kr.calls).toEqual(['standing', 'finish', 'seal']);
    expect(m.waitingToBeFinished()).toBeNull();
  });

  /* RED WHEN: a press the chain is not ready for takes any step, or is said as done. */
  it('a press the chain is not ready for takes no step and says it waits', async () => {
    const { m } = await load();
    kr.who = { id: 'u1' };
    kr.being = 'acc_new';
    for (const state of ['deploy-sent', 'finish-sent', 'unknown']) {
      kr.calls = [];
      kr.standing = state;
      expect(await m.finishCreating('u1')).toEqual({ of: 'waiting', companyId: 'acc_new', state });
      expect(kr.calls).toEqual(['standing']);
    }
    /* A deploy that can no longer land is carried again; a pay-record key owed is sealed. */
    kr.calls = [];
    kr.standing = 'deploy-expired';
    kr.finished = 'deploy-sent';
    expect(await m.finishCreating('u1')).toEqual({ of: 'waiting', companyId: 'acc_new', state: 'deploy-sent' });
    expect(kr.calls).toEqual(['standing', 'finish']);
    kr.calls = [];
    kr.standing = 'pay-key-owed';
    expect(await m.finishCreating('u1')).toEqual({ of: 'done', companyId: 'acc_new' });
    expect(kr.calls).toEqual(['standing', 'seal']);
  });

  /* RED WHEN: a keyring holding somebody else is used, or is not brought to the person signed in before anything is created or finished. */
  it('brings the keyring to the person signed in first, and creates or finishes nothing for anybody else', async () => {
    const { m } = await load();
    kr.who = { id: 'u9' };
    expect((await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' })).of).toBe('waiting');
    expect([kr.forgot, kr.resumed]).toEqual([1, 1]);
    kr.who = { id: 'u9' };
    expect(await m.createCompany('u2', { name: 'Acme', firstSigner: 'Priya' })).toMatchObject({ of: 'refused', why: 'not-signed-in' });
    kr.who = { id: 'u9' };
    expect(await m.finishCreating('u2')).toMatchObject({ of: 'refused', why: 'not-signed-in', waiting: 'acc_new' });
    expect(kr.calls).toEqual(['start']);
  });

  /* RED WHEN: a refusal is handed on in the keyring's words, or two different refusals are said as one. */
  it('hands back a reason by the refusal\'s kind, never its words, and says which company waits', async () => {
    const { m, keyring, wallet } = await load();
    kr.who = { id: 'u1' };
    const cases: [unknown, string][] = [
      [new keyring.FirstKeysNeedTheSignIn('x'), 'sign-in-again'],
      [new keyring.SavedKeysDidNotOpen('x'), 'keys-did-not-open'],
      [new keyring.SavedKeysWentBack('x'), 'keys-went-back'],
      [new keyring.AnotherPersonError('x'), 'another-person'],
      [new keyring.AuthError('x'), 'not-signed-in'],
      [new wallet.WalletClosed({ of: 'declined' }, 'x'), 'declined'],
      [new TypeError('x'), 'unreachable'],
      [new Error('the service said something'), 'did-not-finish'],
    ];
    for (const [e, why] of cases) {
      kr.started = async () => { throw e; };
      expect(await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' }), why).toEqual({ of: 'refused', why, waiting: null });
    }
    kr.being = 'acc_half';
    kr.standing = 'not-created';
    kr.signed = 'deploy-sent';
    kr.started = async () => { throw new Error('x'); };
    expect(await m.finishCreating('u1')).toEqual({ of: 'waiting', companyId: 'acc_half', state: 'deploy-sent' });
  });

  /* RED WHEN: Finish asks the wallet anything with no company started here. */
  it('Finish with no company started here asks nothing', async () => {
    const { m } = await load();
    kr.who = { id: 'u1' };
    expect(await m.finishCreating('u1')).toEqual({ of: 'refused', why: 'nothing-to-sign', waiting: null });
    expect(kr.calls).toEqual([]);
  });

  /* RED WHEN: a page whose worker cannot build an account, or that does not know where the account is, starts anything. */
  it('refuses, starting nothing, when the page does not know where the account is or its worker cannot build one', async () => {
    let { m } = await load('');
    expect(await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' })).toMatchObject({ of: 'refused', why: 'not-set-up' });
    expect(await m.finishCreating('u1')).toMatchObject({ of: 'refused', why: 'not-set-up' });
    expect(kr.resumed).toBe(0);
    ({ m } = await load());
    kr.who = { id: 'u1' };
    for (const missing of ['foundingSeat', 'accountDeploy', 'finishedCreation', 'creationAgain', 'payKeyStanding']) {
      const { [missing]: _gone, ...rest } = aWorker();
      kr.worker = rest;
      expect(await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' }), missing).toMatchObject({ of: 'refused', why: 'did-not-finish' });
    }
    expect(kr.calls).toEqual([]);
  });
});

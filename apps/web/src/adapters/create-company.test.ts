// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * CREATING A COMPANY THROUGH THE ADAPTER, WITH THE SHARED KEYRING STOOD IN FOR
 * AT ITS FUNCTIONS AND ITS OWN REFUSALS KEPT, so what the adapter hands the
 * keyring and what it hands a screen back are both read.
 */
const kr = vi.hoisted(() => ({
  who: null as { id: string } | null, resumed: 0, forgot: 0, specs: [] as unknown[],
  create: async (): Promise<{ accountId: string }> => ({ accountId: 'acc_new' }),
  waiting: null as string | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.who,
  forgetLocally: () => { kr.forgot += 1; kr.who = null; },
  resumeSession: async () => { kr.resumed += 1; kr.who = { id: 'u1' }; return kr.who; },
  createCompanyWithWallet: async (spec: unknown) => { kr.specs.push(spec); return kr.create(); },
  finishCompanyCreation: async () => ({ accountId: 'acc_half' }),
  companyAwaitingSetup: () => kr.waiting,
}));

async function load(origin = 'http://wallet.localhost:5180') {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', origin);
  const m = await import('./create-company.js');
  const keyring = await import('vaults-web-shared/keyring.js');
  const wallet = await import('vaults-web-shared/wallet-sign-in.js');
  return { m, keyring, wallet };
}

beforeEach(() => { kr.who = null; kr.resumed = 0; kr.forgot = 0; kr.specs = []; kr.waiting = null; kr.create = async () => ({ accountId: 'acc_new' }); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('creating a company', () => {
  /* RED WHEN: the company is not created with the person as its one signer and one approval, its name is not the one typed, or the id is not handed back. */
  it('creates it over the keyring\'s own journey, with the person creating it as its one signer', async () => {
    const { m } = await load();
    kr.who = { id: 'u1' };
    expect(await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' })).toEqual({ of: 'done', companyId: 'acc_new' });
    expect(kr.specs).toEqual([{ name: 'Acme', signers: [{ name: 'Priya', role: 'admin' }], threshold: 1 }]);
    expect(kr.resumed).toBe(0);
  });

  /* RED WHEN: a keyring holding somebody else is used, or is not brought to the person signed in before anything is created. */
  it('brings the keyring to the person signed in first, and creates nothing for anybody else', async () => {
    const { m } = await load();
    kr.who = { id: 'u9' };
    expect((await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' })).of).toBe('done');
    expect([kr.forgot, kr.resumed]).toEqual([1, 1]);
    kr.who = { id: 'u9' };
    const other = await m.createCompany('u2', { name: 'Acme', firstSigner: 'Priya' });
    expect(other).toMatchObject({ of: 'refused', why: 'not-signed-in' });
    expect(kr.specs).toHaveLength(1);
  });

  /* RED WHEN: a refusal is handed on in the keyring's words, or two different refusals are said as one. */
  it('hands back a reason by the refusal\'s kind, never its words', async () => {
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
      kr.create = async () => { throw e; };
      const r = await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' });
      expect(r, why).toEqual({ of: 'refused', why, waiting: null });
    }
  });

  /* RED WHEN: a company created whose keys were not saved is not said to be waiting, so a screen offers no Finish. */
  it('says which company is waiting to be finished, and finishes it', async () => {
    const { m } = await load();
    kr.who = { id: 'u1' };
    kr.create = async () => { kr.waiting = 'acc_half'; throw new Error('x'); };
    expect(await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' })).toEqual({ of: 'refused', why: 'did-not-finish', waiting: 'acc_half' });
    expect(await m.finishCreating()).toEqual({ of: 'done', companyId: 'acc_half' });
  });

  /* RED WHEN: a page built without the account's address asks the keyring anything. */
  it('refuses, asking nothing, when the page does not know where the account is', async () => {
    const { m } = await load('');
    expect(await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' })).toMatchObject({ of: 'refused', why: 'not-set-up' });
    expect(kr.specs).toEqual([]);
    expect(kr.resumed).toBe(0);
  });
});

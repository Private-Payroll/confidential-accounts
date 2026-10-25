// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * THE FIRST PRESS OF CREATING A COMPANY THROUGH THE ADAPTER, FOUNDED IN THE WALLET,
 * WITH THE SHARED KEYRING STOOD IN FOR AT ITS FUNCTIONS AND ITS OWN REFUSALS
 * KEPT, so what the adapter hands the keyring and what it hands a screen back
 * are both read.
 */
const kr = vi.hoisted(() => ({
  who: null as { id: string } | null, resumed: 0, forgot: 0, calls: [] as string[], specs: [] as unknown[], builders: [] as unknown[],
  started: async (): Promise<{ accountId: string; account: string; label: string }> => ({ accountId: 'acc_new', account: 'ab'.repeat(32), label: 'co_drawn' }),
  builder: null as Record<string, unknown> | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.who,
  forgetLocally: () => { kr.forgot += 1; kr.who = null; },
  resumeSession: async () => { kr.resumed += 1; kr.who = { id: 'u1' }; return kr.who; },
  startCompanyHeldFromTheStart: async (spec: unknown, _origin: string, ...rest: unknown[]) => {
    kr.calls.push('start'); kr.specs.push(spec); kr.builders.push(...rest); return kr.started();
  },
}));
vi.mock('./vault-builder.js', () => ({ theCreationBuilder: async () => kr.builder }));

async function load(origin = 'http://wallet.localhost:5180') {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', origin);
  const m = await import('./create-company.js');
  const keyring = await import('vaults-web-shared/keyring.js');
  const wallet = await import('vaults-web-shared/wallet-sign-in.js');
  return { m, keyring, wallet };
}

beforeEach(() => {
  Object.assign(kr, { who: null, resumed: 0, forgot: 0, calls: [], specs: [], builders: [], builder: { theBuilder: true } });
  kr.started = async () => ({ accountId: 'acc_new', account: 'ab'.repeat(32), label: 'co_drawn' });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('creating a company on this device', () => {
  /* RED WHEN: the button creates the company on the service's path, not the wallet's, or not with the person as its one signer at one approval, under the name typed. */
  it('the first press has the wallet found it, with the person as its one signer, handing the keyring no builder, and sends nothing to the chain', async () => {
    const { m } = await load();
    kr.who = { id: 'u1' };
    /* RED WHEN: the label the wallet drew is not handed to the screen, so the person is never shown what their wallet named the company. */
    expect(await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' })).toEqual({ of: 'done', companyId: 'acc_new', label: 'co_drawn' });
    /* RED WHEN: the first press goes on to sign, send or finish the company, which is the second step's alone. */
    expect(kr.calls).toEqual(['start']);
    expect(kr.specs).toEqual([{ name: 'Acme', signers: [{ name: 'Priya', role: 'admin' }], threshold: 1 }]);
    /* RED WHEN: the page hands the keyring anything that builds or proves: the company's account is built in the wallet. */
    expect(kr.builders).toEqual([]);
  });

  /* RED WHEN: a company is refused, or the adapter reads the keyring for another creation first, because another company is not finished. */
  it('creates one company after another, each handed back by its own id, whatever is kept', async () => {
    const { m } = await load();
    kr.who = { id: 'u1' };
    let n = 0;
    kr.started = async () => { n += 1; return { accountId: `acc_${n}`, account: 'ab'.repeat(32), label: `co_${n}` }; };
    expect(await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' })).toEqual({ of: 'done', companyId: 'acc_1', label: 'co_1' });
    expect(await m.createCompany('u1', { name: 'Other', firstSigner: 'Priya' })).toEqual({ of: 'done', companyId: 'acc_2', label: 'co_2' });
    expect(kr.calls).toEqual(['start', 'start']);
  });

  /* RED WHEN: a keyring holding somebody else is used, or is not brought to the person signed in before anything is created. */
  it('brings the keyring to the person signed in first, and creates nothing for anybody else', async () => {
    const { m } = await load();
    kr.who = { id: 'u9' };
    expect((await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' })).of).toBe('done');
    expect([kr.forgot, kr.resumed]).toEqual([1, 1]);
    kr.who = { id: 'u9' };
    expect(await m.createCompany('u2', { name: 'Acme', firstSigner: 'Priya' })).toEqual({ of: 'refused', why: 'not-signed-in' });
    expect(kr.calls).toEqual(['start']);
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
      kr.started = async () => { throw e; };
      expect(await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' }), why).toEqual({ of: 'refused', why });
    }
  });

  /* RED WHEN: a page that does not know where the wallet is starts anything, or the page's worker is asked for anything. */
  it('refuses, starting nothing, when the page does not know where the wallet is, and never needs the page\'s worker', async () => {
    let { m } = await load('');
    expect(await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' })).toEqual({ of: 'refused', why: 'not-set-up' });
    expect(kr.resumed).toBe(0);
    expect(kr.calls).toEqual([]);
    ({ m } = await load());
    kr.who = { id: 'u1' };
    kr.builder = null;
    expect((await m.createCompany('u1', { name: 'Acme', firstSigner: 'Priya' })).of).toBe('done');
  });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ACT_REFUSAL } from './refusals.js';

/*
 * THE READER'S CODE: the wallet is asked for a code of the reader kind for the company the link names and the person signed in,
 * the dialog it opened is always given up, and what the page is handed is the code's text.
 */
const st = vi.hoisted(() => ({ user: true, asked: [] as unknown[], gave: 0, throws: null as unknown }));
vi.mock('./keyring-person.js', () => ({ keyringFor: async () => st.user }));
vi.mock('vaults-web-shared/wallet-frame.js', async (real) => ({ ...(await real<typeof import('vaults-web-shared/wallet-frame.js')>()), walletInThisPage: () => ({}) }));
vi.mock('vaults-web-shared/wallet-sign-in.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-sign-in.js')>()),
  US_TO_A_WALLET: { rdns: 'test.app' },
  openWalletDialog: () => ({ giveUp: () => { st.gave += 1; } }),
}));
vi.mock('vaults-web-shared/wallet-join-code.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-join-code.js')>()),
  askWalletForAJoinCode: async (_v: unknown, _o: unknown, ask: unknown) => { st.asked.push(ask); if (st.throws !== null) throw st.throws; return { code: 'made' }; },
}));
vi.mock('midnight-identity/profile/join-code', async (real) => ({ ...(await real<typeof import('midnight-identity/profile/join-code')>()), writeJoinCode: (c: { code: string }) => `text:${c.code}` }));

async function load(origin = 'http://wallet.localhost:5180') {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', origin);
  return import('./reader-join-code.js');
}
const COMPANY = { label: `co_${'c1'.repeat(32)}`, account: 'c0'.repeat(32) } as never;

describe('the reader\'s code', () => {
  /* RED WHEN: the wallet is asked for another kind of code, another company, or another person than the one signed in. */
  it('asks for a reader code of the company the link names, and returns its text', async () => {
    const m = await load();
    st.asked = []; st.gave = 0;
    expect(await m.readerCodeFromTheWallet('u1', COMPANY, 'Vaults')).toEqual({ of: 'done', text: 'text:made' });
    expect(st.asked).toEqual([{ company: (COMPANY as { label: string }).label, account: 'c0'.repeat(32), person: 'u1', parts: { kind: 'reader' }, name: 'Vaults', rdns: 'test.app' }]);
    expect(st.gave).toBe(1);
  });

  /* RED WHEN: a wallet that stopped leaves its dialog open, or its stop is lost. */
  it('gives the dialog up and says why when the wallet stops', async () => {
    const m = await load();
    st.gave = 0; st.throws = new Error('closed');
    expect((await m.readerCodeFromTheWallet('u1', COMPANY, 'Vaults')).of).toBe('refused');
    expect(st.gave).toBe(1);
    st.throws = null;
  });

  /* RED WHEN: a person not signed in, or an app with no wallet set, reaches the wallet. */
  it('does not reach the wallet when nobody is signed in or no wallet is set', async () => {
    const m = await load();
    st.asked = []; st.user = false;
    expect(await m.readerCodeFromTheWallet('u1', COMPANY, 'Vaults')).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    st.user = true;
    const none = await load('');
    expect(await none.readerCodeFromTheWallet('u1', COMPANY, 'Vaults')).toEqual({ of: 'refused', why: ACT_REFUSAL.notSetUp });
    expect(st.asked).toEqual([]);
  });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ACT_REFUSAL } from './refusals.js';

/*
 * A READER OPENS A COMPANY: the wallet is asked first and the records are read only with what it gave; a refusal is told by its
 * code, drops the keys held, and is kept once for the sign-up page.
 */
const st = vi.hoisted(() => ({
  user: true, asked: { of: 'held' } as unknown, held: null as unknown, order: [] as string[], read: { of: 'open', id: 'c-9', label: 'l', runs: null, proposals: null } as unknown, throws: null as unknown,
}));
vi.mock('./keyring-person.js', () => ({ keyringFor: async () => st.user }));
vi.mock('vaults-web-shared/reader-keys-released.js', () => ({
  readerKeysFromTheWallet: async () => { st.order.push('wallet'); if (st.throws !== null) throw st.throws; return st.asked; },
  readerKeysReleasedFor: () => st.held,
}));
vi.mock('./reader-records.js', async (real) => ({
  ...(await real<typeof import('./reader-records.js')>()),
  readReaderCompany: async (held: unknown) => { st.order.push(`read:${String(held)}`); return st.read; },
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./reader-open.js');
}
const LABEL = `co_${'c1'.repeat(32)}`;
const ACCOUNT = 'c0'.repeat(32);
const LINK = { id: 'c-9', label: LABEL, account: ACCOUNT } as never;

describe('the code a refusal is told by', () => {
  /* RED WHEN: a refusal the wallet worded is told as another reason, or a word it did not mean is told as a known one. */
  it('is the end of the wallet\'s refusal words, or other when it names none the page knows', async () => {
    const m = await load();
    expect(m.readerWhyOf('act.reader-keys.why.no-grant')).toBe('no-grant');
    expect(m.readerWhyOf('act.reader-keys.why.not-a-reader-here')).toBe('not-a-reader-here');
    expect(m.readerWhyOf('act.reader-keys.why.taken-away')).toBe('taken-away');
    expect(m.readerWhyOf('act.reach.why.service-unreached')).toBe('unreached');
    expect(m.readerWhyOf('act.reader-keys.why.something-new')).toBe('other');
    expect(m.readerWhyOf(null)).toBe('other');
  });
});

describe('the reader\'s link', () => {
  /* RED WHEN: a link with a label or an account that is not in the closed shapes, or with no id, is taken for a company. */
  it('is read from the address, and null when any of its three parts is not in shape', async () => {
    const m = await load();
    expect(m.readerLinkOf({ id: 'c-9', label: LABEL, account: ACCOUNT })).toEqual({ id: 'c-9', label: LABEL, account: ACCOUNT });
    expect(m.readerLinkOf({ id: 'c-9', label: 'x', account: ACCOUNT })).toBeNull();
    expect(m.readerLinkOf({ id: 'c-9', label: LABEL, account: 'x' })).toBeNull();
    expect(m.readerLinkOf({ id: '', label: LABEL, account: ACCOUNT })).toBeNull();
  });
});

describe('opening as a reader', () => {
  /* RED WHEN: the records are read before the wallet answered, or with anything but the keys it gave. */
  it('asks the wallet first, then reads with the keys held', async () => {
    const m = await load();
    st.held = 'KEYS'; st.order = []; st.asked = { of: 'held' };
    expect(await m.openAsReader('u1', LINK)).toMatchObject({ of: 'open' });
    expect(st.order).toEqual(['wallet', 'read:KEYS']);
  });

  /* RED WHEN: a refusal still reads the records, or its code is lost. */
  it('reads nothing and returns the code when the wallet refused', async () => {
    const m = await load();
    st.order = []; st.asked = { of: 'none', refused: 'act.reader-keys.why.no-grant', code: 'x' };
    expect(await m.openAsReader('u1', LINK)).toEqual({ of: 'closed', why: 'no-grant' });
    expect(st.order).toEqual(['wallet']);
  });

  /* RED WHEN: a person who is not signed in, or a wallet that cannot be reached, is taken for an access taken away. */
  it('is a refusal of the act, not a closed company, when the person is not signed in or the wallet throws', async () => {
    const m = await load();
    st.user = false; st.order = [];
    expect(await m.openAsReader('u1', LINK)).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    expect(st.order).toEqual([]);
    st.user = true; st.throws = new Error('window closed');
    expect((await m.openAsReader('u1', LINK)).of).toBe('refused');
    st.throws = null;
  });

  /* RED WHEN: a read with no keys held for the visit reaches the service anyway. */
  it('reads nothing when this visit holds no keys', async () => {
    const m = await load();
    st.held = null; st.order = [];
    expect(await m.readOpened(LINK)).toEqual({ of: 'closed', why: 'no-keys' });
    expect(st.order).toEqual([]);
  });

  /* RED WHEN: a company the link does not name, or one that cannot be reached, is told as an access taken away. */
  it('tells a mismatch and an unreached account by their own codes', async () => {
    const m = await load();
    st.held = 'KEYS';
    st.read = { of: 'refused', why: 'not-the-companys' };
    expect(await m.readOpened(LINK)).toEqual({ of: 'closed', why: 'not-the-companys' });
    st.read = { of: 'refused', why: 'unreached' };
    expect(await m.readOpened(LINK)).toEqual({ of: 'closed', why: 'unreached' });
  });
});

describe('the reason kept for the sign-up page', () => {
  /* RED WHEN: a reason is told twice, or is kept for another company, or survives the company opening. */
  it('is told once, to its own company, and forgotten when the company opens', async () => {
    const m = await load();
    m.rememberWhyNotOpen('c-9', { of: 'closed', why: 'no-grant' });
    expect(m.takeWhyNotOpen('c-2')).toBeNull();
    expect(m.takeWhyNotOpen('c-9')).toEqual({ of: 'closed', why: 'no-grant' });
    expect(m.takeWhyNotOpen('c-9')).toBeNull();
    m.rememberWhyNotOpen('c-9', { of: 'closed', why: 'no-grant' });
    m.rememberWhyNotOpen('c-9', { of: 'open', company: {} as never });
    expect(m.takeWhyNotOpen('c-9')).toBeNull();
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatTokenAmount, visibilityOf } from 'vaults-ui/format/token-amount';
import type { AddressesAndBalancesShown } from 'midnight-identity/profile/addresses-and-balances';
import { NIGHT, StaticAssetRegistry, type Asset } from '../../../../src/core/assets.js';
import { WalletDidNotShowAddressesAndBalances } from 'vaults-web-shared/wallet-records-key.js';
import { US_TO_A_WALLET, WalletClosed } from 'vaults-web-shared/wallet-sign-in.js';
import { ACCOUNT_BALANCES, SIDE, accountBalancesFrom, askForAccountBalances, type AccountBalances, type SideHeld, type TokenHeld } from './account-balances.js';

/*
 * THE ACCOUNT'S BALANCES, AS THE PERSON'S WALLET SAYS THEM ON THEIR PRESS. The
 * wallet's window and its answer are stood in for; what is asked, how often,
 * and what a screen is handed are the adapter's own.
 */
const PRIVATE_ADDRESS = `mn_shield-addr_test1${'q'.repeat(60)}`;
/** A token with a private form only. */
const PRIVATE_TOKEN = 'ab'.repeat(32);
/** A token with both forms. */
const BOTH = 'ef'.repeat(32);
/** A token the registry does not name. */
const UNNAMED = 'cd'.repeat(32);
/** More than a JS number holds exactly: every digit must survive. */
const HUGE = '123456789012345678901234567890123';

const ROWS: Asset[] = [
  { code: NIGHT, symbol: 'NIGHT', name: 'Night', decimals: 6, ledger: { shielded: null, unshielded: NIGHT }, enabled: true, sortOrder: 50 },
  { code: PRIVATE_TOKEN, symbol: 'PRV', name: 'Private token', decimals: 6, ledger: { shielded: PRIVATE_TOKEN, unshielded: null }, enabled: true, sortOrder: 60 },
  { code: BOTH, symbol: 'BTH', name: 'Both forms', decimals: 2, ledger: { shielded: BOTH, unshielded: BOTH }, enabled: true, sortOrder: 70 },
];
const registry = new StaticAssetRegistry(ROWS);

const SHOWN: AddressesAndBalancesShown = {
  addresses: { private: PRIVATE_ADDRESS },
  balances: [
    /* The wallet's private row under the identifier of sixty-four zeros: a shielded token, not NIGHT. */
    { token: NIGHT, amount: '700', visibility: 'private' },
    { token: PRIVATE_TOKEN, amount: HUGE, visibility: 'private' },
    { token: UNNAMED, amount: '5', visibility: 'private' },
    { token: NIGHT, amount: '12000000', visibility: 'public' },
    { token: PRIVATE_TOKEN, amount: '9', visibility: 'public' },
    { token: BOTH, amount: '3', visibility: 'public' },
  ],
  read: { private: 900, public: 950 },
};

const st = vi.hoisted(() => ({
  origin: 'https://wallet.example',
  asked: [] as unknown[],
  gaveUp: 0,
  answer: null as null | (() => Promise<{ shown: unknown; at: number }>),
}));
vi.mock('./session.js', () => ({ get ACCOUNT_ORIGIN() { return st.origin; } }));
vi.mock('vaults-web-shared/wallet-frame.js', () => ({ walletInThisPage: () => ({}) }));
vi.mock('vaults-web-shared/wallet-sign-in.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-sign-in.js')>()),
  openWalletDialog: () => ({ giveUp: () => { st.gaveUp += 1; } }),
}));
vi.mock('vaults-web-shared/wallet-records-key.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-records-key.js')>()),
  askWalletForAddressesAndBalances: async (_view: unknown, walletOrigin: string, ask: unknown) => {
    st.asked.push({ walletOrigin, ask });
    return st.answer!();
  },
}));

beforeEach(() => {
  st.origin = 'https://wallet.example';
  st.asked = [];
  st.gaveUp = 0;
  st.answer = async () => ({ shown: SHOWN, at: 1_000 });
});

const read = (a: AccountBalances) => {
  if (a.of !== ACCOUNT_BALANCES.read) throw new Error(`refused: ${a.why}`);
  return a;
};
const sideRead = (s: SideHeld) => {
  if (s.of !== SIDE.read) throw new Error('not known');
  return s;
};

describe('THE ACCOUNT\'S BALANCES, ASKED OF THE PERSON\'S WALLET', () => {
  it('ASKS THE WALLET ONCE PER CALL, AND KEEPS NOTHING BETWEEN CALLS', async () => {
    const first = read(await askForAccountBalances(registry));
    /* RED WHEN: one call asks the wallet more than once, or not at all, or leaves its window open. */
    expect(st.asked).toHaveLength(1);
    expect(st.gaveUp).toBe(1);
    expect((st.asked[0] as { walletOrigin: string }).walletOrigin).toBe('https://wallet.example');
    /* RED WHEN: the wallet's window for the account's balances names this page otherwise than its window to pay does. */
    expect((st.asked[0] as { ask: unknown }).ask).toMatchObject({ name: US_TO_A_WALLET.name, rdns: US_TO_A_WALLET.rdns });
    st.answer = async () => ({ shown: { ...SHOWN, balances: [], read: { private: 1_100, public: 1_100 } }, at: 2_000 });
    const second = read(await askForAccountBalances(registry));
    /* RED WHEN: a second call answers from what the first was told instead of asking again. */
    expect(st.asked).toHaveLength(2);
    expect(sideRead(first.private).tokens).toHaveLength(1);
    expect(sideRead(second.private).tokens).toEqual([]);
    expect(second.at).toBe(2_000);
  });

  it('HANDS A SCREEN THE PRIVATE ADDRESS, EACH SIDE\'S MOMENT, AND NO PUBLIC ADDRESS', async () => {
    const got = read(await askForAccountBalances(registry));
    /* RED WHEN: the private address is not the wallet's, a side's moment is lost, or anything shaped like an address beyond the private one reaches a screen. */
    expect(got.privateAddress).toBe(PRIVATE_ADDRESS);
    expect(sideRead(got.private).at).toBe(900);
    expect(sideRead(got.public).at).toBe(950);
    expect(Object.keys(got).sort()).toEqual(['at', 'of', 'private', 'privateAddress', 'public']);
  });

  it('THE PRIVATE ROW UNDER SIXTY-FOUR ZEROS IS NOT CALLED NIGHT: A TOKEN IS NAMED ONLY BY THE REGISTRY\'S ENTRY FOR ITS SIDE', () => {
    const got = read(accountBalancesFrom(SHOWN, 1_000, registry));
    const priv = sideRead(got.private);
    const pub = sideRead(got.public);
    /* RED WHEN: the wallet's private zero-identifier row is offered as NIGHT, which has no private form. */
    expect(priv.tokens.map((t) => t.name)).toEqual(['Private token']);
    expect(priv.tokens.some((t) => t.code === NIGHT)).toBe(false);
    /* RED WHEN: a token held on a side the registry gives it no form on is offered there. */
    expect(pub.tokens.map((t) => t.name)).toEqual(['Night', 'Both forms']);
    /* RED WHEN: a token held above zero that this app cannot put in is dropped without being counted, or one held at zero is counted. */
    expect(priv.cannotPutIn).toBe(2);
    expect(pub.cannotPutIn).toBe(1);
    expect(read(accountBalancesFrom({ ...SHOWN, balances: [{ token: NIGHT, amount: '0', visibility: 'private' }] }, 1, registry)).private)
      .toEqual({ of: SIDE.read, at: 900, tokens: [], cannotPutIn: 0 });
    /* RED WHEN: a row loses its side or its token, so one token held on both sides cannot be told apart. */
    expect([...priv.tokens, ...pub.tokens].map((t) => [t.visibility, t.code])).toEqual([['private', PRIVATE_TOKEN], ['public', NIGHT], ['public', BOTH]]);
  });

  it('A TOKEN TURNED OFF IN THE REGISTRY IS NOT OFFERED: IT IS COUNTED WITH THE TOKENS THIS APP CANNOT PUT IN', () => {
    const off = new StaticAssetRegistry([...ROWS.filter((r) => r.code !== BOTH), { ...ROWS.find((r) => r.code === BOTH)!, enabled: false }]);
    const pub = sideRead(read(accountBalancesFrom(SHOWN, 1_000, off)).public);
    /* RED WHEN: a token the registry has turned off is offered to put into a vault. */
    expect(pub.tokens.map((t) => t.code)).toEqual([NIGHT]);
    /* RED WHEN: the turned-off token the wallet holds is dropped without being counted. */
    expect(pub.cannotPutIn).toBe(2);
  });

  it('EACH AMOUNT IS PRIVATE OR PUBLIC FROM ITS SIDE ALONE, AND KEEPS EVERY DIGIT', () => {
    const got = read(accountBalancesFrom(SHOWN, 1_000, registry));
    const [prv] = sideRead(got.private).tokens;
    const [night, both]: readonly (TokenHeld | undefined)[] = sideRead(got.public).tokens;
    /* RED WHEN: an amount is made public for a private side, or private for a public one, as for a token that has both forms. */
    expect(visibilityOf(prv!.amount)).toBe('private');
    expect(visibilityOf(night!.amount)).toBe('public');
    expect(visibilityOf(both!.amount)).toBe('public');
    /* RED WHEN: an amount passes through a JS number, so digits past its precision are lost. */
    expect(prv!.held).toBe(BigInt(HUGE));
    expect(formatTokenAmount(prv!.amount, 'en').replace(/\D/gu, '')).toBe(HUGE);
    expect(night!.held).toBe(12_000_000n);
  });

  it('A SIDE THE WALLET COULD NOT READ IS NOT KNOWN, NEVER ZERO, WITH NO ROWS', async () => {
    st.answer = async () => ({ shown: { ...SHOWN, balances: SHOWN.balances.filter((b) => b.visibility === 'public'), read: { private: null, public: 950 } }, at: 1_000 });
    const got = read(await askForAccountBalances(registry));
    /* RED WHEN: an unread side is handed to a screen as read, as zero, or with rows. */
    expect(got.private).toEqual({ of: SIDE.notKnown });
    expect(sideRead(got.public).tokens).toHaveLength(2);
  });

  it('REFUSES WITH A CODE: NO WALLET SET UP, A DECLINE, AND AN ANSWER THIS PAGE DOES NOT BELIEVE', async () => {
    st.answer = async () => { throw new WalletDidNotShowAddressesAndBalances('not-an-answer', 'this answer cannot be read: it carries an address beside the private one.'); };
    /* RED WHEN: an answer the page does not believe, such as one carrying the public address, reaches a screen as balances. */
    expect(await askForAccountBalances(registry)).toEqual({ of: ACCOUNT_BALANCES.refused, why: 'unreadable' });
    expect(st.gaveUp).toBe(1);
    st.answer = async () => { throw new WalletClosed({ of: 'declined' }, 'declined'); };
    /* RED WHEN: the person's decline is not said as a decline. */
    expect(await askForAccountBalances(registry)).toEqual({ of: ACCOUNT_BALANCES.refused, why: 'declined' });
    st.origin = '';
    const before = st.asked.length;
    /* RED WHEN: a page with no wallet set up opens a window anyway. */
    expect(await askForAccountBalances(registry)).toEqual({ of: ACCOUNT_BALANCES.refused, why: 'not-set-up' });
    expect(st.asked.length).toBe(before);
  });
});

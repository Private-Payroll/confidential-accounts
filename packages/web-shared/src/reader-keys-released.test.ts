/**
 * **A READER'S PAGE HOLDS THE READ KEYS ITS WALLET GAVE, PER COMPANY, ONLY FOR THE PERSON THEY WERE GIVEN TO.** The keys
 * are taken only whole and only for the company asked about, and are let go when somebody else, or nobody, is signed in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const wallet = vi.hoisted(() => ({ person: 'rhea' as string | null, ended: null as unknown }));
vi.mock('./keyring.js', () => ({
  actOnACompanyInTheWallet: async () => wallet.ended,
  currentUser: () => (wallet.person === null ? null : { id: wallet.person, email: null, name: wallet.person }),
  isSignedIn: () => wallet.person !== null,
}));

const { companiesReadThisVisit, heldFromRelease, readerKeysFromTheWallet, readerKeysReleasedFor } = await import('./reader-keys-released.js');
const { keysByPurpose } = await import('./keys-by-purpose.js');
type ReaderKeysAsked = import('./reader-keys-released.js').ReaderKeysAsked;

const KEY = 'ab'.repeat(32);
const ACME = { accountId: 'acc_acme', label: `co_${'c3'.repeat(32)}`, account: 'cd'.repeat(32) };
const RELEASE = { accountId: 'acc_acme', byEpoch: { 0: { roster: KEY, policy: KEY } } };

beforeEach(() => { wallet.person = 'rhea'; wallet.ended = { of: 'done', steps: 1, relayed: 0, readKeys: RELEASE }; });

describe('THE READ KEYS A READER\'S PAGE HOLDS', () => {
  it('ARE TAKEN WHOLE AND ONLY FOR THE COMPANY ASKED ABOUT', () => {
    const held = heldFromRelease(RELEASE, 'acc_acme')!;
    expect(keysByPurpose(held).at(0).keyFor('roster', 'acc_acme')).toBe(KEY);
    expect(keysByPurpose(held).at(0).keyFor('people', 'acc_acme')).toBeNull();
    /* RED WHEN: keys the wallet gave for one company are held as another's. */
    expect(heldFromRelease(RELEASE, 'acc_other')).toBeNull();
    /* RED WHEN: a release naming a kind of record this page does not know is taken in part. */
    expect(heldFromRelease({ ...RELEASE, byEpoch: { 0: { roster: KEY, secrets: KEY } } }, 'acc_acme')).toBeNull();
  });

  it('ARE HELD FOR THE VISIT OF THE PERSON THEY WERE GIVEN TO, AND NONE ARE KEPT WHEN THE WALLET GAVE NONE', async () => {
    expect((await readerKeysFromTheWallet(ACME, 'https://wallet.example')).of).toBe('held');
    expect(readerKeysReleasedFor('acc_acme')).not.toBeNull();
    expect(companiesReadThisVisit()).toEqual(['acc_acme']);
    /* RED WHEN: a stopped act leaves the keys of an earlier visit as if the grant still stood. */
    wallet.ended = { of: 'stopped', step: 1, steps: 1, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.reader-keys.why.no-grant', code: 'no-grant' };
    /* RED WHEN: a refusal reaches the page without the wallet's words for it, so the page cannot say why nothing opened. */
    const refused: ReaderKeysAsked = await readerKeysFromTheWallet(ACME, 'https://wallet.example');
    expect(refused).toEqual({ of: 'none', refused: 'act.reader-keys.why.no-grant', code: 'no-grant' });
    expect(companiesReadThisVisit()).toEqual([]);
    /* RED WHEN: an act that ends done with no keys in it is taken as holding keys. */
    wallet.ended = { of: 'done', steps: 1, relayed: 0 };
    expect(await readerKeysFromTheWallet(ACME, 'https://wallet.example')).toEqual({ of: 'none', refused: null, code: null });
    wallet.ended = { of: 'done', steps: 1, relayed: 0, readKeys: RELEASE };
    await readerKeysFromTheWallet(ACME, 'https://wallet.example');
    /* RED WHEN: another person signed in on this tab reads the keys given to the one before. */
    wallet.person = 'mallory';
    expect(readerKeysReleasedFor('acc_acme')).toBeNull();
    expect(companiesReadThisVisit()).toEqual([]);
    wallet.person = 'rhea';
    expect(readerKeysReleasedFor('acc_acme')).toBeNull();
  });
});

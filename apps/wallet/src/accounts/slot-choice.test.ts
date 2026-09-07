import { describe, expect, it } from 'vitest';
import { emptyProfile, grantTo } from 'midnight-identity/profile/model';
import type { Profile } from 'midnight-identity/profile/model';
import { OFFER_ORDER, alsoUsedBy, chooseSlot, originsOfSlot } from './slot-choice.js';
import { MAIN_ACCOUNT, SUBWALLET_ACCOUNTS, WALLET_ACCOUNTS } from './subwallets.js';

/**
 * **WHICH WALLET A COMPANY IS OFFERED.**
 *
 * The actual defect was offering the LAST-USED slot, which hands every new
 * company the address the previous one already has, silently, to somebody who
 * never chose it. Everything here is about the DEFAULT; nothing here refuses
 * anything, and the test at the bottom is what says so.
 */

const NOW = 1_755_000_000_000;
const to = (profile: Profile, origin: string, subwallet: number): Profile =>
  grantTo(profile, { origin, name: origin, rdns: origin }, subwallet, [], NOW);

describe('§1 — the wallet a company is offered', () => {
  it('OFFERS ONE NOBODY HAS, AND THE MAIN WALLET LAST', () => {
    /* The main wallet is where the rest of somebody's money lives, so an
     * employer paid into it sees everything else that arrives there. It stays
     * offered in the picker; it is not what an untouched screen proposes. */
    expect(OFFER_ORDER[0]).toBe(SUBWALLET_ACCOUNTS[0]);
    expect(OFFER_ORDER[OFFER_ORDER.length - 1]).toBe(MAIN_ACCOUNT);
    expect([...OFFER_ORDER].sort((a, b) => a - b))
      .toEqual([...WALLET_ACCOUNTS].sort((a, b) => a - b));

    const empty = emptyProfile(NOW);
    expect(chooseSlot(empty, 'https://a.example'))
      .toEqual({ account: SUBWALLET_ACCOUNTS[0], because: 'unused' });
  });

  it('TWO SITES ARE NOT OFFERED ONE SLOT', () => {
    const one = to(emptyProfile(NOW), 'https://a.example', SUBWALLET_ACCOUNTS[0]!);
    expect(chooseSlot(one, 'https://b.example'))
      .toEqual({ account: SUBWALLET_ACCOUNTS[1], because: 'unused' });
  });

  it('AND A SITE THAT ALREADY HAS ONE KEEPS IT', () => {
    /* A second address next month means half a salary history sitting at an
     * address the company no longer pays. */
    const one = to(emptyProfile(NOW), 'https://a.example', SUBWALLET_ACCOUNTS[4]!);
    expect(chooseSlot(one, 'https://a.example'))
      .toEqual({ account: SUBWALLET_ACCOUNTS[4], because: 'already-theirs' });
  });

  it('AND WHEN EVERY SLOT IS SPENT IT SAYS SO RATHER THAN PRETENDING', () => {
    /* *This is fresh* and *there is nothing fresh left* are different
     * sentences, and a wallet that says the first when it means the second is
     * teaching a person that silence means it is fine. */
    let profile = emptyProfile(NOW);
    for (const [i, account] of OFFER_ORDER.entries()) {
      profile = to(profile, `https://site-${i}.example`, account);
    }
    expect(chooseSlot(profile, 'https://new.example'))
      .toEqual({ account: OFFER_ORDER[0], because: 'every-slot-used' });
  });

  it('WHO ELSE ALREADY HAS A SLOT — everybody but the site asking', () => {
    let profile = to(emptyProfile(NOW), 'https://a.example', 2);
    profile = to(profile, 'https://b.example', 2);
    expect(originsOfSlot(profile, 2)).toEqual(['https://a.example', 'https://b.example']);
    expect(alsoUsedBy(profile, 2, 'https://b.example')).toEqual(['https://a.example']);
    expect(alsoUsedBy(profile, 3, 'https://b.example')).toEqual([]);
  });

  it('AND NOTHING HERE REFUSES ANYTHING — it is a default and it is pure', () => {
    /*
     * The design decision of 22 Aug: *reusing an address
     * costs linkability, and linkability is the person's to spend.* This
     * function answers a question; it has no way to say no. And it reads no
     * storage and no clock, so two devices holding one profile open on the same
     * wallet and a recovered wallet opens on the one this company already has.
     */
    const profile = to(emptyProfile(NOW), 'https://a.example', 2);
    expect(chooseSlot(profile, 'https://b.example').account).toBeTypeOf('number');
    expect(chooseSlot(profile, 'https://b.example'))
      .toEqual(chooseSlot(profile, 'https://b.example'));
  });
});

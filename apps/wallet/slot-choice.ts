import type { Profile } from 'midnight-identity/profile/model';
import { MAIN_ACCOUNT, SUBWALLET_ACCOUNTS } from './subwallets.js';

/**
 * WHICH WALLET A COMPANY IS OFFERED, AND WHY IT IS NOT THE LAST ONE USED.
 *
 * **THIS IS A DEFAULT AND NEVER A REFUSAL, AND THAT IS THE SCOPE'S OWN
 * DECISION.** 22 Aug: *reusing an address costs linkability, and
 * linkability is the person's to spend.* A contractor may genuinely want every
 * payment arriving in one place for their accountant, and there are eleven
 * slots and twelve-client people. So nothing here refuses anything: the picker
 * still offers every wallet, and what this decides is which one is already
 * selected when the screen opens.
 *
 * **WHY THAT IS WORTH A FILE.** The actual defect was offering the
 * LAST-USED slot, which is the worst possible default: it hands every new
 * company the address the previous one already has, silently, to somebody who
 * never chose it. **Defaults decide the outcome for almost everybody.**
 *
 * ── THE THREE ANSWERS, IN ORDER ──────────────────────────────────────────
 *
 * 1. **A COMPANY THAT ALREADY HAS ONE KEEPS IT.** This is not a convenience.
 *    A receiving address is where money arrives; giving a company a second one
 *    next month means half a person's salary history sits at an address the
 *    company no longer pays. The same site gets the same slot for ever, and
 *    that is read off the grants rather than remembered separately.
 * 2. **OTHERWISE A SLOT NO SITE HAS USED**, which is the rule.
 * 3. **AND IF THERE IS NO UNUSED ONE LEFT, SAY SO RATHER THAN PRETEND.** With
 *    every slot spent, any answer shares an address with somebody. The screen
 *    is told which case it is in, because *this is fresh* and *there is nothing
 *    fresh left* are different sentences and a wallet that says the first when
 *    it means the second is teaching a person that silence means it is fine.
 *
 * ── THE ORDER, AND WHY THE MAIN WALLET IS LAST ───────────────────────────
 *
 * The picker's own order is `MAIN_ACCOUNT` first, because that is the wallet a
 * person thinks of as theirs. **That is exactly why it is the last thing to
 * hand an employer.** It is where the rest of somebody's money lives, so an
 * employer paid into it can see every other thing that arrives there. It stays
 * offered — nothing here refuses it — but it is not what an unchosen screen
 * proposes.
 *
 * ── WHAT THIS BUYS AND WHAT IT DOES NOT, SAID PLAINLY ────────────────────
 *
 * §2 again: different subwallets mean different addresses, so two employers do
 * not see one payee address, **and they do not make a person two people.** The
 * slots come from one secret and one recovery set; anyone who links two of them
 * knows it, and **we can always tell, because it is one wallet signing in.**
 * Nothing in this file may be described as anonymity.
 */

/**
 * THE ORDER A FRESH SLOT IS LOOKED FOR IN. Subwallets first, main wallet last —
 * see the header. It is deliberately NOT `WALLET_ACCOUNTS`, which is the order
 * the picker RENDERS in, and the two are different questions.
 */
export const OFFER_ORDER: readonly number[] =
  Object.freeze([...SUBWALLET_ACCOUNTS, MAIN_ACCOUNT]);

/** Why the screen is proposing the wallet it is proposing. */
export type Because =
  /** This site has been given this slot before. It keeps it. */
  | 'already-theirs'
  /** No site has been given this one. */
  | 'unused'
  /** Every slot has gone to somebody. Whatever is offered is shared. */
  | 'every-slot-used';

export interface SlotChoice {
  readonly account: number;
  readonly because: Because;
}

/**
 * EVERY ORIGIN A SLOT HAS ALREADY BEEN DISCLOSED TO, in first-given order.
 *
 * Read off `grants`, which is where a disclosure records the slot it was made
 * from. **Releases are deliberately not consulted**: a release carries no
 * subwallet at all, and `model.ts` says why — a key does not depend on one, and
 * a record naming a slot would imply a separation the mechanism does not have.
 */
export const originsOfSlot = (profile: Profile, account: number): readonly string[] => {
  const seen: string[] = [];
  for (const grant of profile.grants) {
    if (grant.subwallet !== account) continue;
    if (!seen.includes(grant.recipient.origin)) seen.push(grant.recipient.origin);
  }
  return Object.freeze(seen);
};

/**
 * WHO ELSE ALREADY HAS THIS SLOT'S ADDRESS — everybody but the site asking.
 *
 * This is what the screen says once, when somebody deliberately picks a slot
 * another employer already pays: *this address is already used by another
 * employer here; they could learn you work for both.* The second half,
 * and the reason the first half is a default rather than a refusal.
 */
export const alsoUsedBy = (
  profile: Profile, account: number, origin: string,
): readonly string[] => Object.freeze(
  originsOfSlot(profile, account).filter((o) => o !== origin));

/**
 * THE WALLET THIS SCREEN OPENS ON.
 *
 * A pure function of the profile and the observed origin. **It reads no
 * storage and no clock**, so two devices holding the same profile open on the
 * same wallet, and a wallet rebuilt from its recovery pieces opens on the one
 * its own history says this company already has.
 *
 * `order` is an argument only so a test can drive a short list; nothing in the
 * product passes one.
 */
export function chooseSlot(
  profile: Profile, origin: string, order: readonly number[] = OFFER_ORDER,
): SlotChoice {
  const theirs = profile.grants.find((g) => g.recipient.origin === origin);
  if (theirs !== undefined && order.includes(theirs.subwallet)) {
    return Object.freeze({ account: theirs.subwallet, because: 'already-theirs' as const });
  }
  const fresh = order.find((account) => originsOfSlot(profile, account).length === 0);
  if (fresh !== undefined) {
    return Object.freeze({ account: fresh, because: 'unused' as const });
  }
  /*
   * NOTHING FRESH IS LEFT, AND THE HONEST ANSWER IS THE FIRST ONE RATHER THAN A
   * CLEVER ONE. Picking the *least* shared slot would be a wallet spending
   * somebody's linkability for them by an arithmetic they cannot see; the
   * screen says the situation and the person chooses.
   */
  return Object.freeze({ account: order[0] as number, because: 'every-slot-used' as const });
}

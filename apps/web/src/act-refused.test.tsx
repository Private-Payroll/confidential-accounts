// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { ActRefused } from './act-refused.js';
import { ACT_REFUSAL, type ActRefusal } from './adapters/refusals.js';
import en from './locales/en.json';

/*
 * Why an action on a company did not happen, said in the person's language:
 * every refusal by its own phrase, none by another's.
 */
afterEach(() => { cleanup(); });

const LANGUAGES = languagesFrom({ './locales/en.json': en });

const said = (why: ActRefusal): string | null => {
  const { container } = render(<KitProvider languages={LANGUAGES} pick="en"><ActRefused why={why} /></KitProvider>);
  const text = container.querySelector(`[data-refusal="${why}"] [data-slot="alert-description"]`)?.textContent ?? null;
  cleanup();
  return text;
};

describe('a refusal on the screen', () => {
  /* RED WHEN: the headline over any refusal says that nothing happened, above a body that says a step was sent or may have gone through. */
  it('heads every refusal with words true whether or not an earlier step went through', () => {
    for (const why of Object.values(ACT_REFUSAL)) {
      const { container } = render(<KitProvider languages={LANGUAGES} pick="en"><ActRefused why={why} /></KitProvider>);
      const title = container.querySelector(`[data-refusal="${why}"] [data-slot="alert-title"]`)?.textContent;
      cleanup();
      expect(title, why).toBe('This did not finish');
    }
    expect(Object.values(en as Record<string, string>).filter((v) => /did not happen/i.test(v) && v.length < 40)).toEqual([]);
  });

  /* RED WHEN: a refusal is said with another refusal's phrase, or with none: a phrase the English file does not have shows as its key. */
  it('says each refusal in its own words', () => {
    const words = new Set(Object.values(en as Record<string, string>));
    const phrases = Object.values(ACT_REFUSAL).map((why) => said(why));
    expect(phrases.filter((p) => p === null || !words.has(p))).toEqual([]);
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  /* RED WHEN: a signer whose records name no seat for them, or a seat their own key does not make, is told only that it did not finish. */
  it('says a seat that is missing, or not the signer\'s own, as that', () => {
    const words = en as Record<string, string>;
    expect(said(ACT_REFUSAL.noSeat)).toBe(words['act.refused.noSeat']);
    expect(said(ACT_REFUSAL.notYourSeat)).toBe(words['act.refused.notYourSeat']);
  });

  /* RED WHEN: a refusal of a signer's entry or of a vault press says what happened but not what resolves it, or names another way out. */
  it('names what resolves each refusal of an entry or of a vault press', () => {
    const resolvedBy: [ActRefusal, RegExp][] = [
      [ACT_REFUSAL.entryNotFiled, /has not taken your entry yet.*Open the company again/u],
      [ACT_REFUSAL.entryWaitsForItsInvitation, /could not read it.*Ask the signer who added you to open the company or invite you again/u],
      [ACT_REFUSAL.seatUnknown, /holds no seat under your keys.*Open the company again/u],
      [ACT_REFUSAL.seatNotBelieved, /does not believe your seat.*ask a signer to check your seat/u],
      [ACT_REFUSAL.seatMayNotRaise, /may not raise proposals.*A signer whose role may raise proposals creates the vault/u],
      [ACT_REFUSAL.committeeUnread, /could not say who holds.*Open your account and try again/u],
      [ACT_REFUSAL.committeeNotInstallable, /cannot hold a vault.*Ask a super admin to correct/u],
      [ACT_REFUSAL.pageOutOfDate, /out of date.*Reload the page and try again/u],
      [ACT_REFUSAL.vaultNotTheCompanys, /puts no money into it.*create a new vault/u],
      [ACT_REFUSAL.vaultInfoRefused, /not accepted.*1 to 64 characters.*1,000.*Change it/u],
    ];
    for (const [why, resolves] of resolvedBy) expect(said(why), why).toMatch(resolves);
  });

  /* RED WHEN: a wallet that did not answer, could not be shown, closed, let the ask run out or expired is told without saying that nothing was signed or sent for this step, that an earlier step of the action may have gone through, and what resolves it. */
  it('says what was and was not done when the account did not answer, and what to do', () => {
    for (const why of [ACT_REFUSAL.silent, ACT_REFUSAL.noWindow, ACT_REFUSAL.windowGone, ACT_REFUSAL.expired, ACT_REFUSAL.ranOut, ACT_REFUSAL.unreadable]) {
      expect(said(why), why).toMatch(/nothing was (signed|sent)/iu);
      expect(said(why), why).toMatch(/Reload the page.*try again\.$/u);
    }
    for (const why of [ACT_REFUSAL.silent, ACT_REFUSAL.noWindow, ACT_REFUSAL.windowGone, ACT_REFUSAL.expired, ACT_REFUSAL.ranOut]) {
      expect(said(why), why).toMatch(/before it in the same action may already have gone through/u);
    }
    expect(said(ACT_REFUSAL.ranOut)).toMatch(/ran out of time while your account was open/u);
    expect(said(ACT_REFUSAL.expired)).toMatch(/had expired by the time it reached your account/u);
  });

  /* RED WHEN: a payment the account could not make is not said as unpaid with nothing sent, or does not name the one thing to do about its reason. */
  it('says each failed payment as unpaid, with its own next step', () => {
    const resolvedBy: [ActRefusal, RegExp][] = [
      [ACT_REFUSAL.payChainUnreadable, /paid nothing and nothing was sent.*Check your connection.*try again later/u],
      [ACT_REFUSAL.payNotEnough, /not have enough.*paid nothing and nothing was sent.*Add to your account or choose a smaller amount/u],
      [ACT_REFUSAL.payNotAsApproved, /did not match what you approved.*paid nothing and nothing was sent.*contact support before paying/u],
      [ACT_REFUSAL.payDidNotFinish, /could not finish the payment.*paid nothing and nothing was sent.*Try again/u],
    ];
    for (const [why, says] of resolvedBy) expect(said(why), why).toMatch(says);
  });

  /* RED WHEN: a person who cannot sign a committee change is told the other signers will sign the rest, when only the company's super admins sign it; or a change whose check disagrees with the chain is said as the company's records not matching, when no records are read. */
  it('names the super admins, not the signers, for a committee change', () => {
    expect(said(ACT_REFUSAL.nothingToSign)).toMatch(/other super admins sign the rest/u);
    expect(said(ACT_REFUSAL.nothingToSign)).not.toMatch(/signers/u);
    expect(said(ACT_REFUSAL.committeeDisagrees)).toMatch(/super admins to sign.*does not match what your account reads.*nothing was sent.*Reload the page/u);
  });
});

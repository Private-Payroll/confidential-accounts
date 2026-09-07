// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { newSecret } from 'midnight-identity';
import { loadSubwallets, saveLastUsedWallet, saveSubwalletName } from '../storage.js';
import { switchWallet } from './wallets.js';

/*
 * THE ONE RECORD, AND THE TWO WALLS IN FRONT OF IT.
 *
 * `shell/wallets.ts` is new this change: it is the change event `storage.ts`
 * cannot emit, and it is now the ONLY way this interface writes which wallet
 * is open.
 *
 * WHY THIS FILE EXISTS, AND IT IS NOT TIDINESS. The refusal below ALREADY
 * EXISTED before this change, inside `screens/home.tsx`'s own `switchTo`. An earlier change
 * moved it here and then mutated it — deleted the guard entirely — and **all
 * 673 tests stayed green**. The standing rule: *a claim of safety is only true
 * if a check exists AND a test goes red when the check is removed.* It did not.
 *
 * AND THE MUTATION SAID SOMETHING MORE PRECISE THAN EXPECTED, so this file
 * says it rather than claiming the tidier thing. With the guard gone, the
 * ACCOUNT 1 cases still passed: `storage.ts` refuses `account === 1` itself, so
 * The rule is genuinely double-walled and the interface is not what is holding it.
 * What died was the FIXED SET — and that is what this guard is actually for.
 *
 * ==========================================================================
 * §1 CLOSED THE OTHER HALF, AND IT CHANGED WHAT THIS FILE CAN PROVE
 * ==========================================================================
 *
 * Until this change `storage.ts` refused only non-integers, negatives and
 * account 1; **accounts 12 and up it wrote happily**, while `subwallets.ts`
 * offers ten slots and `useWallets` silently falls back to the main wallet for
 * anything outside them. So a switch to account 12 was written to disk, opened
 * the main wallet instead, and said nothing — the record and the screen naming
 * different wallets, which is a disagreement moved into the chrome.
 * The design asked for the writer to be made as strict as the reader,
 * and `saveLastUsedWallet` now refuses anything outside `{0} ∪ [2,11]`.
 *
 * **AND IT NEARLY COST THIS MODULE ITS PIN, WHICH IS WORTH RECORDING BECAUSE
 * THE MUTATION IS WHAT FOUND IT.** With both walls standing, deleting
 * `switchWallet`'s guard left every test in this file GREEN — measured, not
 * assumed — because a bare `.toThrow()` cannot tell which wall refused. A
 * redundant guard had quietly become an unpinned one, which is exactly the
 * shape this file was written about.
 *
 * The two walls do NOT say the same thing, and that is the fix: `switchWallet`
 * throws *"account 12 is not a wallet this interface offers"* and
 * `saveLastUsedWallet` throws *"a wallet is account 0 or 2–11"*. So each wall
 * is pinned by its OWN message — `'and the refusal is this module's own'`
 * below, and `'the storage writer refuses the same fixed set'` after it — and
 * removing either guard turns exactly one of them red.
 *
 * BOTH WALLS ARE CHECKED HERE. Not as a duplicate of
 * `subwallet-picker.test.tsx`'s row, but so that removing either one is red
 * rather than quietly leaving a single point of failure.
 *
 * THE NOTIFICATION HALF IS NOT TESTED HERE, ON PURPOSE. It is already pinned
 * where it matters — through the screens, in `shell.test.tsx` and
 * `subwallet-picker.test.tsx`, thirteen of which go red when the notification
 * is removed (recorded in the change's entry). A unit test of the `Set` would
 * be a second, weaker statement of a claim two files already make against the
 * real interface.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

beforeEach(() => {
  localStorage.clear();
});

describe('the interface writes only wallets it can open, and the fixed ten', () => {
  it('switchWallet throws for account 1, and names it as the authority compartment', () => {
    const secret = newSecret();
    expect(() => switchWallet(secret, 1)).toThrow(/authority compartment/);
    /* Both walls say it, so this test alone does not tell them apart — the
     * fixed-set test below is the one that is only this module's. */
    expect(loadSubwallets(secret).lastUsed).not.toBe(1);
  });

  it('and nothing is written — the refused switch leaves the record where it was', () => {
    const secret = newSecret();
    switchWallet(secret, 4);
    expect(loadSubwallets(secret).lastUsed).toBe(4);
    expect(() => switchWallet(secret, 1)).toThrow();
    /* The wallet that was open is still the wallet that is open. A refusal
     * that half-wrote would be worse than no refusal: the screen would say one
     * thing and the record another, which is a disagreement moved into the
     * chrome. */
    expect(loadSubwallets(secret).lastUsed).toBe(4);
  });

  it('the storage writer refuses it too — the second wall is still standing', () => {
    const secret = newSecret();
    /* If either of these stops throwing, the guard above has become the ONLY
     * thing between account 1 and the record, and any future caller that does
     * not go through this module would reach it. */
    expect(() => saveLastUsedWallet(secret, 1)).toThrow();
    expect(() => saveSubwalletName(secret, 1, 'authority')).toThrow();
  });

  /* THIS USED TO BE THE ONE ONLY THIS MODULE ENFORCED, and it is not
   * any more: `saveLastUsedWallet` refuses the same set now, so both walls
   * stand behind this assertion and deleting either one leaves it green. The
   * assertion itself is untouched; the two tests after it are what tell the
   * walls apart. */
  it('every account outside the fixed ten is refused — the slots storage would take', () => {
    const secret = newSecret();
    for (const notAWallet of [12, 99, -1, 1.5]) {
      expect(() => switchWallet(secret, notAWallet), String(notAWallet)).toThrow();
    }
  });

  it('so the record can never name a wallet this interface cannot open', () => {
    const secret = newSecret();
    switchWallet(secret, 11);
    expect(() => switchWallet(secret, 12)).toThrow();
    /* Without the guard this reads 12, `useWallets` falls back to the main
     * wallet, and the screen and the record disagree with nothing said. */
    expect(loadSubwallets(secret).lastUsed).toBe(11);
  });

  /*
   * THIS MODULE'S OWN WALL, PINNED BY ITS OWN WORDS. Found by mutation:
   * with `storage.ts` tightened, deleting the guard in `wallets.ts` left every
   * other test in this file green, because both walls refuse account 12 and a
   * bare `.toThrow()` cannot say which one did. The message is the difference,
   * and this is the only test that reads it.
   */
  it('and the refusal is this module’s own — so deleting its guard is still red', () => {
    const secret = newSecret();
    expect(() => switchWallet(secret, 12))
      .toThrow(/is not a wallet this interface offers/);
    expect(() => switchWallet(secret, 1))
      .toThrow(/is not a wallet this interface offers/);
  });

  /*
   * THE SECOND WALL, NAMED DIRECTLY. THE RULE: *"make the writer as strict as the
   * reader — `{0} ∪ [2,11]`, refused loudly, the way account 1 already is.
   * Nothing displayed disagrees with what is open today, so this is defence in
   * depth rather than a fix."*
   *
   * It goes through `saveLastUsedWallet` and NOT through `switchWallet`, on
   * purpose: a test that reached the disk through the interface's own door
   * would go green off either guard and could not tell which one refused.
   */
  it('the storage writer refuses the same fixed set — the second wall', () => {
    const secret = newSecret();
    saveLastUsedWallet(secret, 11);
    for (const notAWallet of [12, 99, 1.5, -1]) {
      expect(() => saveLastUsedWallet(secret, notAWallet), String(notAWallet)).toThrow();
    }
    /* A refusal that half-wrote would be worse than no refusal. */
    expect(loadSubwallets(secret).lastUsed).toBe(11);
    /* And the account-1 message is unchanged, because that is the case a
     * reader of that error is most likely to be looking at. */
    expect(() => saveLastUsedWallet(secret, 1)).toThrow(/authority compartment/);
    /* Every slot the interface offers still writes. */
    for (const account of [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      saveLastUsedWallet(secret, account);
      expect(loadSubwallets(secret).lastUsed, String(account)).toBe(account);
    }
  });

  /*
   * THE OTHER WRITER, AND THIS IS WHAT ORDERED IT: *"the two
   * writers should not disagree about what an account is."* Until recently they did.
   * `saveLastUsedWallet` refused `{0} ∪ [2,11]`; `saveSubwalletName` refused
   * only non-integers, negatives and account 1 — so a name for account 12
   * reached the disk and read back, a fact in the record that no screen can
   * ever show.
   *
   * IT GOES THROUGH `saveSubwalletName` AND NOT THROUGH `renameWallet`, on
   * purpose and for the same reason: `renameWallet` has no guard of its own, so a
   * test that went through it could not say which wall refused if one is ever
   * added. And the last assertion reads THIS writer's own sentence, because
   * `saveLastUsedWallet` also refuses 12 and a bare `.toThrow()` cannot tell
   * the two apart — the lesson of an earlier mutation, applied before it bites.
   */
  it('the NAME writer refuses the same fixed set — §1, so the two writers agree', () => {
    const secret = newSecret();
    saveSubwalletName(secret, 2, 'Client money');
    for (const notAWallet of [12, 99, 1.5, -1]) {
      expect(() => saveSubwalletName(secret, notAWallet, 'Savings'), String(notAWallet))
        .toThrow();
    }
    /* A refusal that half-wrote would be worse than no refusal. */
    expect(loadSubwallets(secret).names).toEqual({ 2: 'Client money' });
    /* The account-1 message is unchanged — that is the case a reader of that
     * error is most likely to be looking at. */
    expect(() => saveSubwalletName(secret, 1, 'authority')).toThrow(/authority compartment/);
    expect(() => saveSubwalletName(secret, 12, 'Savings')).toThrow(/subwallet names live at/);
    /* Every slot the interface offers still takes a name. */
    for (const account of [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      saveSubwalletName(secret, account, `slot ${account}`);
      expect(loadSubwallets(secret).names[String(account)], String(account))
        .toBe(`slot ${account}`);
    }
  });

  it('and every account the interface DOES offer is accepted', () => {
    const secret = newSecret();
    for (const account of [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      switchWallet(secret, account);
      expect(loadSubwallets(secret).lastUsed, String(account)).toBe(account);
    }
  });
});

import { AnotherPersonError, AuthError, CompanyStartedBySomebodyElse, FirstKeysNeedTheSignIn, SavedKeysDidNotOpen, SavedKeysWentBack } from 'vaults-web-shared/keyring.js';
import { WalletClosed } from 'vaults-web-shared/wallet-sign-in.js';

/*
 * WHY AN ACTION ON A COMPANY DID NOT HAPPEN, one of a fixed set a screen says
 * in its own words. The shared code's own words are never handed on.
 */
export const ACT_REFUSAL = {
  notSetUp: 'not-set-up', notSignedIn: 'not-signed-in', anotherPerson: 'another-person',
  signInAgain: 'sign-in-again', keysDidNotOpen: 'keys-did-not-open', keysWentBack: 'keys-went-back',
  declined: 'declined', expired: 'expired', noWindow: 'no-window', windowGone: 'window-gone', gaveUp: 'gave-up', silent: 'silent',
  noKeysHere: 'no-keys-here', rosterDisagrees: 'roster-disagrees', nothingToSign: 'nothing-to-sign', nothingSent: 'nothing-sent',
  unreachable: 'unreachable', didNotFinish: 'did-not-finish', noSeat: 'no-seat', notYourSeat: 'not-your-seat',
} as const;

export type ActRefusal = (typeof ACT_REFUSAL)[keyof typeof ACT_REFUSAL];

/** What an action's answer is. */
export const ACTED = { done: 'done', refused: 'refused' } as const;

/** The refusal a failure from the keyring, the account or the network is, told apart by its kind and never by its words. */
export function refusalOf(e: unknown): ActRefusal {
  if (e instanceof AnotherPersonError || e instanceof CompanyStartedBySomebodyElse) return ACT_REFUSAL.anotherPerson;
  if (e instanceof AuthError) return ACT_REFUSAL.notSignedIn;
  if (e instanceof FirstKeysNeedTheSignIn) return ACT_REFUSAL.signInAgain;
  if (e instanceof SavedKeysDidNotOpen) return ACT_REFUSAL.keysDidNotOpen;
  if (e instanceof SavedKeysWentBack) return ACT_REFUSAL.keysWentBack;
  if (e instanceof TypeError) return ACT_REFUSAL.unreachable;
  if (e instanceof WalletClosed) {
    switch (e.refusal.of) {
      case 'declined': return ACT_REFUSAL.declined;
      case 'expired': return ACT_REFUSAL.expired;
      case 'no-wallet-tab': return ACT_REFUSAL.noWindow;
      case 'window-gone': return ACT_REFUSAL.windowGone;
      case 'gave-up': return ACT_REFUSAL.gaveUp;
      case 'silent': return ACT_REFUSAL.silent;
      default: return ACT_REFUSAL.didNotFinish;
    }
  }
  return ACT_REFUSAL.didNotFinish;
}

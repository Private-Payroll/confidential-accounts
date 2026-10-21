import { AnotherPersonError, AuthError, CompanyStartedBySomebodyElse, FirstKeysNeedTheSignIn, SavedKeysDidNotOpen, ServiceRefused, SavedKeysWentBack } from 'vaults-web-shared/keyring.js';
import { ReadRanOutOfTime } from 'vaults-web-shared/read-bound.js';
import { WalletClosed, type WalletPaymentFailure } from 'vaults-web-shared/wallet-sign-in.js';

/*
 * WHY AN ACTION ON A COMPANY DID NOT HAPPEN, one of a fixed set a screen says
 * in its own words. The shared code's own words are never handed on.
 */
export const ACT_REFUSAL = {
  notSetUp: 'not-set-up', notSignedIn: 'not-signed-in', anotherPerson: 'another-person',
  signInAgain: 'sign-in-again', keysDidNotOpen: 'keys-did-not-open', keysWentBack: 'keys-went-back',
  declined: 'declined', expired: 'expired', ranOut: 'ran-out', unreadable: 'unreadable', noWindow: 'no-window', windowGone: 'window-gone', gaveUp: 'gave-up', silent: 'silent',
  noKeysHere: 'no-keys-here', committeeDisagrees: 'committee-disagrees', nothingToSign: 'nothing-to-sign', nothingSent: 'nothing-sent',
  unreachable: 'unreachable', didNotFinish: 'did-not-finish', noSeat: 'no-seat', notYourSeat: 'not-your-seat',
  entryNotFiled: 'entry-not-filed', entryWaitsForItsInvitation: 'entry-waits-for-its-invitation',
  seatUnknown: 'seat-unknown', seatNotBelieved: 'seat-not-believed', seatMayNotRaise: 'seat-may-not-raise',
  committeeUnread: 'committee-unread', committeeNotInstallable: 'committee-not-installable', pageOutOfDate: 'page-out-of-date',
  vaultNotTheCompanys: 'vault-not-the-companys', vaultInfoRefused: 'vault-info-refused',
  readRanOut: 'read-ran-out', payChainUnreadable: 'pay-chain-unreadable', payNotEnough: 'pay-not-enough', payNotAsApproved: 'pay-not-as-approved', payDidNotFinish: 'pay-did-not-finish',
  feeNotPaid: 'fee-not-paid', networkRefused: 'network-refused', rosterNotBelieved: 'roster-not-believed',
} as const;

export type ActRefusal = (typeof ACT_REFUSAL)[keyof typeof ACT_REFUSAL];

/** What an action's answer is. */
export const ACTED = { done: 'done', refused: 'refused' } as const;

/** Each reason the account could not make a payment it was asked for, as the refusal that says it. */
function paymentFailure(why: WalletPaymentFailure): ActRefusal {
  switch (why) {
    case 'chain-unreadable': return ACT_REFUSAL.payChainUnreadable;
    case 'not-enough': return ACT_REFUSAL.payNotEnough;
    case 'not-as-approved': return ACT_REFUSAL.payNotAsApproved;
    default: return ACT_REFUSAL.payDidNotFinish;
  }
}


/** The refusal a failure from the keyring, the service, the account or the network is, told apart by its kind and never by its words (an ask that ran out while the account was open, by the refusal's `while`). */
export function refusalOf(e: unknown): ActRefusal {
  if (e instanceof AnotherPersonError || e instanceof CompanyStartedBySomebodyElse) return ACT_REFUSAL.anotherPerson;
  if (e instanceof AuthError) return ACT_REFUSAL.notSignedIn;
  if (e instanceof FirstKeysNeedTheSignIn) return ACT_REFUSAL.signInAgain;
  if (e instanceof SavedKeysDidNotOpen) return ACT_REFUSAL.keysDidNotOpen;
  if (e instanceof SavedKeysWentBack) return ACT_REFUSAL.keysWentBack;
  if (e instanceof ReadRanOutOfTime) return ACT_REFUSAL.readRanOut;
  /* By the kind's name, which the roster's refusal sets: the code that throws it is loaded only where a company is opened. */
  if (e instanceof Error && e.name === 'RosterNotBelieved') return ACT_REFUSAL.rosterNotBelieved;
  if (e instanceof TypeError) return ACT_REFUSAL.unreachable;
  if (e instanceof ServiceRefused && e.code === 'fee-not-paid') return ACT_REFUSAL.feeNotPaid;
  if (e instanceof ServiceRefused && e.code === 'network-refused') return ACT_REFUSAL.networkRefused;
  if (e instanceof WalletClosed) {
    switch (e.refusal.of) {
      case 'declined': return ACT_REFUSAL.declined;
      case 'expired': return e.refusal.while === 'open' ? ACT_REFUSAL.ranOut : ACT_REFUSAL.expired;
      case 'unreadable': return ACT_REFUSAL.unreadable;
      case 'failed': return paymentFailure(e.refusal.why);
      case 'no-wallet-tab': return ACT_REFUSAL.noWindow;
      case 'window-gone': return ACT_REFUSAL.windowGone;
      case 'gave-up': return ACT_REFUSAL.gaveUp;
      case 'silent': return ACT_REFUSAL.silent;
      default: return ACT_REFUSAL.didNotFinish;
    }
  }
  return ACT_REFUSAL.didNotFinish;
}

import { AnotherPersonError, AuthError, CompanyStartedBySomebodyElse, FirstKeysNeedTheSignIn, SavedKeysDidNotOpen, ServiceRefused, SavedKeysWentBack } from 'vaults-web-shared/keyring.js';
import { ReadRanOutOfTime } from 'vaults-web-shared/read-bound.js';
import { WalletClosed, type WalletPaymentFailure } from 'vaults-web-shared/wallet-sign-in.js';

/* The codes themselves live in `refusal-codes.ts`, which loads nothing, so a screen the first download carries can name them without loading the keyring. */
import { ACT_REFUSAL, type ActRefusal } from './refusal-codes.js';

export { ACT_REFUSAL, ACTED, SEAT_REFUSALS, type ActRefusal } from './refusal-codes.js';

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
  /* A company whose key the person's wallet has not released on this visit: a page load never asks, the person is offered the ask. */
  if (e instanceof Error && e.name === 'CompanyKeyNotOpened') return ACT_REFUSAL.notOpenedYet;
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

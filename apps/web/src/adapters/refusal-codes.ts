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
  notOpenedYet: 'not-opened-yet',
} as const;

export type ActRefusal = (typeof ACT_REFUSAL)[keyof typeof ACT_REFUSAL];

/** What an action's answer is. */
export const ACTED = { done: 'done', refused: 'refused' } as const;

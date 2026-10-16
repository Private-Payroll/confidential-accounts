/**
 * **THE APPROVALS A CHANGE OF WHO IS SEATED NEEDS ON A COMPANY'S ACCOUNT**: the
 * higher of the account's approval threshold and the approvals a policy change
 * needs as the account stores them, the threshold standing in while none is
 * stored. It is the number the account's own `requireSeatBar` holds a seating,
 * a removal or a re-seating to, the number a change to a spending policy is
 * carried out at, and the fewest signers a removal by `amendSigner` may leave
 * seated. (`removeSignerAndSetThreshold` instead checks the size against the
 * threshold it has just written and against the stored policy-bar row, when
 * there is one.) Pure, and loads nothing, so the service and every device
 * judge by this one rule.
 */
export function seatBarOf<T extends number | bigint>(threshold: T, storedBar: T | null): T {
  return storedBar !== null && storedBar > threshold ? storedBar : threshold;
}

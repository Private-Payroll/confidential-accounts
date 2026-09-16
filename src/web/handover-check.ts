/**
 * **WHAT A SIGNER'S OWN DEVICE CHECKS BEFORE A COMPANY ACCOUNT IS HANDED TO ITS
 * COMMITTEE.** Kept apart from the screen so the same check can be read and
 * driven without one.
 */
type Key = { tag: string; value: string };

/** The part of the service's answer about a company's authority that this check reads. */
export interface HandoverView {
  readonly committee: { readonly committee: readonly Key[]; readonly threshold: number } | null;
  readonly why: string | null;
  readonly contracts: readonly { readonly seats: readonly { readonly key: Key; readonly you: boolean }[] }[];
}

const same = (a: Key, b: Key) => a.tag.toLowerCase() === b.tag.toLowerCase() && a.value.toLowerCase() === b.value.toLowerCase();

/**
 * **WHAT THIS DEVICE CAN CHECK OF THE COMMITTEE BEFORE THE ACCOUNT IS HANDED TO
 * IT, AND IT IS LESS THAN THE WHOLE COMMITTEE.** The committee comes from the
 * service. This checks it against two things the service does not supply: the
 * key this person's wallet gives for this company, and the number of active
 * signers on the company's own roster, which this device opened. It refuses a
 * committee that lacks this person's key, shows this person's key on a seat it
 * calls somebody else's, shows another key as this person's, or has a number of
 * keys other than the number of signers. **It cannot tell whether another
 * signer's key is theirs**: only that signer's own device can.
 */
export function whyNotHandOver(view: HandoverView, mine: Key, activeSigners: number): string | null {
  if (view.committee === null) return view.why ?? 'this company has no committee yet.';
  if (view.committee.committee.length !== activeSigners) {
    return `the committee this service reports has ${view.committee.committee.length} key(s) and this company has `
      + `${activeSigners} signer(s), so the account is not handed to it from here.`;
  }
  if (!view.committee.committee.some((k) => same(k, mine))) {
    return 'the committee this service reports does not carry the key your wallet gives for this company, so the '
      + 'account is not handed to it from here.';
  }
  const seats = view.contracts.flatMap((c) => c.seats);
  if (seats.some((s) => !s.you && same(s.key, mine))) {
    return 'this service shows your wallet\'s key on a seat it says is not yours, so the account is not handed over '
      + 'from here.';
  }
  const shownAsMine = seats.filter((s) => s.you);
  if (shownAsMine.some((s) => !same(s.key, mine))) {
    return 'this service shows a key as yours that is not the one your wallet gives for this company, so the account '
      + 'is not handed over from here.';
  }
  return null;
}

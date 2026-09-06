import { addressFingerprint } from 'midnight-identity/profile/fingerprint';
import type { Hex, Sealed } from '../core/crypto.js';
import { openFromInbox } from '../core/sealed-records.js';
import { openHandover } from '../core/invite-handover.js';
import type { SealedHandover } from '../core/invite-handover.js';

/**
 * **OPENING THE DROP BOX ON THE ADMIN'S OWN MACHINE.** `docs/NEXT.md` `X12` §2,
 * `docs/scope-invitations.md` §5, `docs/how-money-can-be-lost.md` `C21`.
 *
 * ── WHY THIS IS IN THE BROWSER AND NOT ON THE SERVER ──────────────────────
 *
 * §5, decided 22 Aug: the fingerprint is **computed on the ADMIN'S machine,
 * not ours** — computing it here would require the address, and the leak
 * returns through the door this section builds. The whole point of
 * `C160` is that a receiving address never becomes readable to this service;
 * a server-side comparison would hand it one for every pending hire, on a
 * schedule, in the name of privacy.
 *
 * So the route serves ciphertext (`GET /api/employees/:id/handover`), the
 * viewing key stays in this tab, and this file is where the two meet.
 *
 * ── AND IT CARRIES NO WEBASSEMBLY ────────────────────────────────────────
 *
 * `sealed-records.ts` and `invite-handover.ts` are `@noble` and nothing
 * else, and `addressFingerprint` is a hash and an alphabet. **The address is a
 * plain string here and is never rebuilt through `payeeAddress()`** — that
 * happens at `admit`, on the machine that writes the roster, exactly as it
 * always has (`A-1`, `C7`). This screen is not deciding whether an address is
 * payable; it is showing a person two codes.
 *
 * ── WHAT THE COMPARISON PROVES, AND WHAT IT DOES NOT ─────────────────────
 *
 * **It proves the person who pressed approve in the wallet is the person who
 * filled in the join screen**: the code came off the wallet's own screen and
 * the address came out of the same wallet's disclosure, so a page that relayed
 * the acceptance to a different wallet renders a different code here.
 *
 * **IT DOES NOT PROVE THE RIGHT PERSON WAS INVITED.** Somebody who accepts
 * their own invitation pastes their own matching code and every screen agrees.
 * What catches that is the admin confirming the code with the person through a
 * channel where a wrong person would be noticed — and `App.tsx` says that on
 * the screen, in the way the unlock screen says what it cannot check.
 */

export type Accepted =
  | {
    readonly of: 'opened';
    /** What THIS machine works out, from the address that actually arrived. */
    readonly ours: string;
    /**
     * What the person read off their own wallet and pasted into the join
     * screen. **`null` is a real answer**, not a failure: a member who added
     * themselves as a payee had no page, no second party and nothing to
     * confirm, and a seeded record was never on anybody's device.
     */
    readonly theirs: string | null;
    /** Equal strings. `null` when there is nothing to compare. */
    readonly agree: boolean | null;
  }
  /** The box would not open, or what came out was not a handover. The sentence
   * is the one the opener threw, because it is written for a person. */
  | { readonly of: 'unreadable'; readonly says: string };

/** The outer envelope `acceptInvite` seals around the invitee's own. */
interface Box {
  readonly byUserId?: string | null;
  readonly handover: SealedHandover;
}

export function acceptedCodes(
  inbox: ({ ephemeral: Hex } & Sealed) | null,
  accountId: string,
  viewingKey: Hex,
): Accepted | null {
  if (!inbox) return null;
  try {
    const box = openFromInbox<Box>(inbox, accountId, viewingKey);
    const handover = openHandover(box.handover, accountId, viewingKey);
    const ours = addressFingerprint(handover.address);
    return {
      of: 'opened',
      ours,
      theirs: handover.confirmation,
      agree: handover.confirmation === null ? null : handover.confirmation === ours,
    };
  } catch (e) {
    return { of: 'unreadable', says: e instanceof Error ? e.message : String(e) };
  }
}

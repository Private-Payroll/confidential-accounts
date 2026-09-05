/**
 * **THE TWO DECISIONS THE KEYRING MAKES ABOUT KEY MATERIAL, AS FUNCTIONS A
 * TEST CAN REACH.** `C329`, `S34`.
 *
 * `src/web/keyring.ts` does I/O — it holds the session, seals the bundle and
 * talks to the server — and `C275`'s rule is that a rule about money living
 * only inside its caller is a rule no test can reach. Both of these decide
 * whether a signer's blinding survives, which decision 0003 says exists on one
 * device and nowhere else, so both are here and both are tested.
 *
 * `S34`'s `money-safety-auditor` found the first of them; its `test-auditor`
 * found that the whole of the new keyring code had no test at all.
 */
import { signingPublicKeyOf, unwrapKey, type Hex, type Sealed } from '../core/crypto.js';
import { openAccount as openSealedAccount } from '../core/account.js';
import type { SealedAccount } from '../core/types.js';

/** Only what these two decisions read. */
export interface HeldKeys { signerId: string; signingSecret: Hex }
export interface SealedSeat { signingPublicKey: Hex; signingSecret: Hex; wrappingSecret: Hex }

/**
 * **WOULD WRITING THIS DESTROY KEY MATERIAL THAT IS ALREADY HERE?** Returns the
 * refusal, or null.
 *
 * `keyring.accounts` holds ONE entry per account and every writer used to
 * assign into it unconditionally. What is destroyed is the `blinding`:
 * accepting an invite while already holding a seat on the same company replaced
 * the operator's own material with the invitee's and **nothing failed** — the
 * next open reported `agrees`, because the material now there matches the leaf
 * now there. Their old seat stays on the roster, counts towards N, and can
 * never be proved again. A silent failure that looks like success.
 *
 * The same material written twice is not a clobber. A retry must cost nothing.
 */
export function clobberRefusal(
  held: HeldKeys | undefined | null,
  incoming: HeldKeys,
): string | null {
  if (!held) return null;
  if (held.signingSecret.toLowerCase() === incoming.signingSecret.toLowerCase()) return null;
  return 'THIS DEVICE ALREADY HOLDS KEY MATERIAL FOR THIS COMPANY, AND WRITING THIS WOULD '
    + 'DESTROY IT.\n'
    + `  seat held here   ${held.signerId}\n`
    + `  seat offered     ${incoming.signerId}\n`
    + 'WHAT IT MEANS. A blinding lives on one device and nowhere else (decision 0003). '
    + 'Replacing the entry would leave the seat held here on the account\x27s roster, '
    + 'counting towards the threshold, with nobody able to reproduce its leaf — and nothing '
    + 'would look wrong afterwards, because the new material matches the new seat.\n'
    + 'WHAT RESOLVES IT. Accept the second seat on a different device or in a different '
    + 'browser profile, or have the seat held here replaced by an approved round from '
    + 'another signer first.\n'
    + 'NOTHING WAS PROVED, NOTHING WAS SUBMITTED AND NOTHING WAS WRITTEN.';
}

/**
 * **WHICH SEAT, IF ANY, THIS DEVICE'S PENDING MATERIAL BELONGS TO.** Returns
 * the pair to promote, or null.
 *
 * ── WHAT IT PROVES BEFORE IT ANSWERS, AND WHY THE FIRST VERSION DID NOT ──
 *
 * The first version trial-unwrapped each wrapped viewing key with the pending
 * wrapping secret, took the `signerId` written beside whichever ciphertext
 * opened, and said a substituted roster could not forge one. **That was false
 * and `S34`'s `money-safety-auditor` caught it (rule 14).** `wrapKey` is
 * public-key sealing: anyone holding the wrapping PUBLIC key — which this
 * device POSTed to the server one step earlier — can produce a ciphertext that
 * opens under the matching secret, and the `signerId` beside it is
 * unauthenticated plaintext the server chooses.
 *
 * So the unwrapped value is USED rather than discarded: it is the viewing key,
 * it opens the roster, and the answer is given only if the seat at that
 * `signerId` carries **this device's own signing public key** — a value derived
 * from a secret that never left here. A forged entry names a seat whose public
 * key does not match, and is refused.
 *
 * **AND NO MATCH IS NOT A REASON TO DISCARD ANYTHING.** A pending entry is the
 * only copy of a published seat's blinding. This function only answers; the
 * caller only promotes on an answer.
 *
 * **IT ANSWERS NULL UNTIL ACCESS IS GRANTED, AND THAT IS CORRECT.** A seat
 * published but not yet granted has no wrapped key to open, and an account this
 * device cannot open is one there is nothing to finish for yet.
 */
export function seatToPromote(
  seats: SealedSeat[],
  sealed: SealedAccount,
): { signingPublicKey: Hex; signerId: string } | null {
  for (const seat of seats) {
    for (const w of sealed.wrappedKeys as Array<{ signerId: string } & { ephemeral: Hex } & Sealed>) {
      let viewingKey: Hex;
      try {
        viewingKey = unwrapKey(w, seat.wrappingSecret) as Hex;
      } catch {
        /* Not ours, or not openable. Nothing is discarded either way. */
        continue;
      }
      let mine;
      try {
        mine = openSealedAccount(sealed, viewingKey).signers.find(x => x.id === w.signerId);
      } catch {
        /* A ciphertext that opened but is not this account's viewing key. That
         * is a forgery or a corrupt record, and it is not a match. */
        continue;
      }
      if (!mine) continue;
      /*
       * **DERIVED FROM THE SECRET, NOT READ OFF THE PENDING ENTRY.** `C323`,
       * and it is the reason `signingPublicKeyOf` exists — a check that
       * compares two stored claims agrees with a record that was replaced in
       * its entirety, and the pending entry is stored in the same bundle as
       * everything else this device holds. The one value here that nothing else
       * can produce is the curve's answer to this device's own signing secret.
       */
      if (mine.signingPublicKey?.toLowerCase()
          !== signingPublicKeyOf(seat.signingSecret).toLowerCase()) continue;
      return { signingPublicKey: seat.signingPublicKey, signerId: w.signerId };
    }
  }
  return null;
}

import type { Hex, Sealed } from './crypto.js';
import { sealToInbox, openFromInbox } from './sealed-records.js';

/**
 * **WHAT AN INVITEE HANDS OVER, SEALED BEFORE IT LEAVES THEIR DEVICE.**
 * `docs/NEXT.md` `X11` §7, `docs/how-money-can-be-lost.md` `C160`.
 *
 * ── THE DIFFERENCE THIS FILE EXISTS TO MAKE ───────────────────────────────
 *
 * `POST /api/invites/:token/accept-employee` took the receiving address as a
 * bech32 STRING and sealed it on our side. Where it ended up was already right
 * — sealed to the company's inbox key, unreadable to us — but **the plaintext
 * existed in our process, in whatever the framework buffered, and in anything
 * that ever logged a request body.** `docs/scope-invitations.md` §5 decided the
 * opposite on 22 Aug: the acceptance seals the address to the company's inbox
 * key **on the employee's own device**.
 *
 * **We do not store it, which is a policy. Not being able to see it is a
 * property**, and this file is the property.
 *
 * ── ONE SHAPE, ONE OWNER, BECAUSE TWO SIDES WRITE AND READ IT ─────────────
 *
 * The browser seals; `admit` opens, months later, on somebody else's machine.
 * A shape agreed by convention between a page and a service is a shape that
 * drifts, and what drifts here is where a salary is paid. So `sealHandover` is
 * the only way to make one and `openHandover` is the only way to read one, and
 * both are here. **`schema` travels inside the envelope** so a value sealed by
 * something else, or by an older build, is refused by name rather than read as
 * whatever it happens to look like.
 *
 * ── AND IT CARRIES NO WEBASSEMBLY, WHICH IS WHY IT IS ITS OWN FILE ────────
 *
 * It reaches `sealed-records.ts`, which is `@noble` and nothing else.
 * The ADDRESS is a plain string here rather than a `PayeeAddress`, because
 * building one of those reaches `@midnightntwrk/wallet-sdk-address-format` and
 * therefore the ledger, and `src/web` may not contain it. **That is not a
 * loosening**: the checks happen on the invitee's device through
 * `midnight-identity/wallet/address-shape` before this is called, and `admit`
 * still rebuilds the value through the real `payeeAddress()` from this very
 * string, exactly as it always has.
 */

/** The version of this shape. Inside the envelope, never beside it. */
export const HANDOVER_SCHEMA = 'confidential-accounts/invite-handover/v1' as const;

/** A blob nobody without the account's viewing key can open. */
export type SealedHandover = { ephemeral: Hex } & Sealed;

/** What is inside one, once opened. */
export interface InviteHandover {
  readonly schema: typeof HANDOVER_SCHEMA;
  /** The public half of the payslip keypair, derived from the company key. */
  readonly wrappingPublicKey: Hex;
  /**
   * The receiving address **as the wallet wrote it** — one bech32 string, both
   * halves inside it. Never two fields: `payee-address.ts` is the argument.
   */
  readonly address: string;
  /**
   * **THE CODE THE PERSON READ OFF THEIR OWN WALLET AND TYPED INTO THE PAGE.**
   * `../../docs/how-money-can-be-lost.md` `C21`,
   * `../../docs/scope-invitations.md` §5.
   *
   * It is a fingerprint of the address the WALLET showed, carried here so the
   * admin can hold it beside the fingerprint their own machine computes from
   * the address that actually arrived. Two codes, one glance.
   *
   * **IT IS INSIDE THE ENVELOPE AND NOT BESIDE IT**, for the reason everything
   * else in here is: a fingerprint is not the address, but it is a hundred bits
   * that identify one, so it is a standing handle on where somebody is paid for
   * anybody who can read the wire. It travels sealed or it does not travel.
   *
   * **AND IT MAY BE `null`.** `addSelfAsPayee` walks this same shape with no
   * page, no second party and nobody to confirm anything with — there is no
   * code because there was never a comparison to make. A blank standing in for
   * one would repeat the email field's lesson: two absences that compare equal.
   * So the screen that shows the comparison says *no code was given* rather
   * than showing an empty box that looks like a match.
   */
  readonly confirmation: string | null;
  /**
   * The company address the payee's device worked their payslip key out from.
   * Absent from a handover sealed before it was carried, which reads as not
   * known rather than as any particular address.
   */
  readonly keyFrom?: string | null;
}

/**
 * **THE INVITEE'S BROWSER CALLS THIS, AND OUR SERVER NEVER DOES ON THAT DOOR.**
 *
 * `inboxPublicKey` comes out of the sealed offer, which only the holder of the
 * link can open — see `payroll.ts`'s note where the offer is built. It seals
 * and cannot open; opening needs the account's viewing key, which no invitee
 * ever holds and no invitee ever should.
 */
export const sealHandover = (
  parts: { wrappingPublicKey: Hex; address: string; confirmation: string | null; keyFrom?: string | null },
  inboxPublicKey: Hex,
): SealedHandover => sealToInbox<InviteHandover>({
  schema: HANDOVER_SCHEMA,
  wrappingPublicKey: parts.wrappingPublicKey,
  address: parts.address,
  /* Named on the parameter rather than defaulted, so the one door that
   * legitimately has no code — a member adding themselves — has to say so
   * rather than forget to. */
  confirmation: parts.confirmation,
  keyFrom: parts.keyFrom ?? null,
}, inboxPublicKey);

/**
 * **OPENED WHERE THE RECORD IS WRITTEN, AND CHECKED RATHER THAN CAST.**
 *
 * What comes out of an envelope is JSON: a shape that looks like a handover,
 * not a handover. Every field is checked here so that nothing downstream throws
 * a `TypeError` out of a property access — the same rule `wallet-payee.ts`'s
 * `asResponse` is written to, and for the same reason.
 */
export function openHandover(
  sealed: SealedHandover, accountId: string, viewingKey: Hex,
): InviteHandover {
  const opened = openFromInbox<Partial<InviteHandover>>(sealed, accountId, viewingKey);
  if (!opened || typeof opened !== 'object') {
    throw new Error('what was handed over is not readable as a handover at all.');
  }
  if (opened.schema !== HANDOVER_SCHEMA) {
    throw new Error(
      `this handover says it is '${String(opened.schema ?? 'nothing')}' and this build reads `
      + `'${HANDOVER_SCHEMA}'. It is refused rather than guessed at: guessing means guessing `
      + 'where somebody is paid.');
  }
  if (typeof opened.address !== 'string' || opened.address.trim() === '') {
    throw new Error(
      'this handover carries no address, so there is nothing to pay. It has to come from '
      + 'their own device or wallet; nobody can supply it on their behalf.');
  }
  if (typeof opened.wrappingPublicKey !== 'string' || opened.wrappingPublicKey === '') {
    throw new Error(
      'this handover carries no key to seal payslips to, so nothing sent to this person '
      + 'could ever be opened by them.');
  }
  /*
   * **ABSENT AND `null` ARE ONE ANSWER HERE, AND THE SCHEMA DID NOT MOVE.**
   *
   * A handover sealed before this field existed carries no code, and neither
   * does one from `addSelfAsPayee`. Both mean *there is no code to compare*,
   * which is a thing the admin's screen can say. Bumping the schema instead
   * would refuse every drop box already sealed — for a field that is evidence
   * ABOUT the address rather than part of it — and refusing a drop box is
   * refusing the only copy of where somebody is paid. **Between two designs of
   * similar cost, the one that fails recoverably wins.**
   *
   * What is refused is a code that is present and is not a string, because a
   * screen rendering an object where twenty characters belong is a comparison
   * nobody can make.
   */
  if (opened.confirmation !== undefined && opened.confirmation !== null
    && typeof opened.confirmation !== 'string') {
    throw new Error(
      'this handover carries something in place of the code the person read off their '
      + 'wallet, and it is not text. It is refused rather than rendered.');
  }
  return Object.freeze({
    schema: HANDOVER_SCHEMA,
    wrappingPublicKey: opened.wrappingPublicKey,
    address: opened.address,
    confirmation: typeof opened.confirmation === 'string' ? opened.confirmation : null,
    keyFrom: keyFromOf(opened.keyFrom),
  });
}

/**
 * **THE ADDRESS A PAYSLIP KEY CAME FROM, OR NOTHING.** A company address is 32
 * bytes of hex. Anything else in this field is refused rather than stored,
 * because a payslip that names a wrong address is one its payee is sent to
 * the wrong place to open.
 */
function keyFromOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(
      'this handover names the company address its payslip key came from, and what it '
      + 'names is not a company address. It is refused rather than stored, because every '
      + 'payslip sealed to this person would send them to that address to open it.');
  }
  return value.toLowerCase();
}

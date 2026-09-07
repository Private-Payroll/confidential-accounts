import { sha256 } from '@noble/hashes/sha2.js';

/**
 * **SOMETHING A PERSON CAN ACTUALLY COMPARE, STANDING IN FOR AN ADDRESS THEY
 * CANNOT.**
 *
 * The unlock screen asks a person to recognise a company and then shows them
 * `dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8`. **Nobody
 * recognises that**, so the one instruction on the screen a person must follow
 * is the one no person can — and it is worst at the FIRST release for a
 * company, which is the release that decides every release after it.
 *
 * This is a RENDERING of that address and nothing more. It is derived from the
 * address alone, so any client computes the same one; it can be put in an
 * invitation, an email from an employer, or read down a phone line; and it is
 * the same for that company for ever, on every device and in every wallet.
 *
 * ══ WHY THIS IS NOT TWO DIGITS, WHICH IS WHAT PAIRING SHOWS ═══════════════
 *
 * **`devices/pairing.ts` shows two digits and that is SAFE THERE ONLY BECAUSE
 * OF THE PROTOCOL AROUND THEM.** The old device commits to its contribution
 * before it learns the nonce, so it cannot choose what the screens display.
 * That file's own header records what happened the one time the commitment was
 * missing: a relay **ground its ephemeral keypair until the digits matched, in
 * 245 tries** — a measured count. How long they took was never
 * measured here, and 245 is the number that carries the argument.
 * And the sentence that matters most here: *adding digits does not help — four
 * digits is ten thousand tries, which is the same kind of nothing.*
 *
 * **THERE IS NO COMMITMENT PROTOCOL AVAILABLE IN THIS CASE AND THERE CANNOT
 * BE.** Nobody is interacting. An attacker picks their own contract address
 * freely and computes this function offline, as many times as they like, long
 * before anybody sees anything. That is vanity-address grinding and it is
 * ordinary practice. **So the only thing standing between a person and a
 * company that has been ground to look like another company is the WIDTH of
 * what is compared.**
 *
 * ══ THE WIDTH, AS ARITHMETIC RATHER THAN AS TASTE ═════════════════════════
 *
 * Twenty characters of a 32-symbol alphabet is **100 bits**. The attacker's
 * problem is not a birthday collision — any two companies colliding is no use
 * to them — it is hitting ONE GIVEN value, so the expected work is the full
 * 2^100 ≈ 1.27 × 10^30 tries, each one hash.
 *
 *   a high-end GPU, ~10^10 hashes/second     4 × 10^12 years
 *   ten thousand of them                     4 × 10^8 years
 *   the entire Bitcoin network's hash rate,
 *   ~7 × 10^20 /second — the existence proof
 *   that purpose-built hashing hardware
 *   at this scale can be built at all        ~57 years
 *
 * **Eighty bits (sixteen characters) is already past every general-purpose
 * fleet** — 2^80 is about half an hour of that same network — and the four
 * extra characters are what put it past the only hardware anybody has ever
 * actually built. Four characters on a screen is the whole price.
 *
 * **AND THE HONEST LIMIT, WHICH THE ARITHMETIC DOES NOT COVER.** All of the
 * above bounds a comparison of the WHOLE fingerprint. A person who checks only
 * the first and last group is comparing forty bits, and forty bits is an hour
 * on one GPU. **So this is never rendered truncated, never with an ellipsis,
 * and never shortened to fit** — which is also why it is twenty characters and
 * not forty. A thing short enough to be compared whole is the point of it.
 *
 * ══ WHY NOT WORDS, WHICH WOULD BE MORE SPEAKABLE ══════════════════════════
 *
 * A word list is the most speakable encoding there is and it is **exactly the
 * wrong one inside a wallet**. This wallet's recovery is words. A person told
 * that their company is *"abandon ability able…"* has been handed something
 * that looks precisely like the thing they must never type into anything, at
 * the moment they are being asked to trust a screen. The confusion is the
 * attack. So: Crockford's base32 — `I`, `L`, `O` and `U` are not in it, so
 * there is no one/ell, no zero/oh, and nothing that reads as a word.
 *
 * ══ AND IT IS NEVER A KEY INPUT ═══════════════════════════════════════════
 *
 * `unlock.ts` derives from the address's own bytes at full width and imports
 * nothing from this file. **A fingerprint that reached the derivation would be
 * a 100-bit selector for a 256-bit thing**, which is a rejected design
 * wearing a new hat — and `unlock.test.ts` pins the released bytes against an
 * independent derivation, so it dies if this ever crosses over.
 *
 * ══ WHERE A NAME WOULD SIT, WHEN THERE IS ONE ═════════════════════════════
 *
 * Scope 4's invitation carries a company name by a path that is not the asking
 * page, and a name is what a person actually recognises. **It does not replace
 * this.** A name can be wrong — learned from a stale invitation, or shared by
 * two companies — and a fingerprint cannot, because it IS the address. So a
 * name belongs ABOVE this as the thing a person recognises, with this beneath
 * it as the thing that settles it, in exactly the relation the ask screen
 * already uses for a claim and the fact that checks it.
 */

/**
 * Crockford's base32, upper case. No `I`, `L`, `O` or `U`: nothing that reads
 * as one/ell, zero/oh, or as a word.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Twenty symbols of five bits. The header is the argument for the number. */
const SYMBOLS = 20;

/** Read in fours, the way anybody reads a long number aloud. */
const GROUP = 4;

/** Its own domain, so this string can never collide with another use of the
 * same address under a different label. `v1`, and it may never change: a
 * fingerprint that moved would be a company nobody could confirm twice. */
const COMPANY_LABEL = 'midnight-identity/company-fingerprint/v1/';

/**
 * **THE SECOND SUBJECT, AND IT IS A SECOND LABEL RATHER THAN A SECOND
 * FUNCTION.**
 *
 * An invitee's wallet shows a code for the RECEIVING ADDRESS it is about to
 * disclose; the person pastes it into the page that asked, and the admin's own
 * machine computes the same code from the address that actually arrived. **Two
 * codes, one glance.**
 *
 * It is domain-separated from the company one for the reason the company one is
 * domain-separated from everything else: **the same twenty characters must
 * never mean two things.** A company address and a receiving address are
 * different values in different alphabets, but a reader comparing a code has no
 * way to tell which kind they are holding, and a label costs nothing.
 *
 * **THE WIDTH, THE ALPHABET AND THE GROUPING ARE SHARED**, so the arithmetic
 * above covers both and the design's *put it behind one function so its length
 * can change later in one place* is true by construction rather than by
 * agreement: `SYMBOLS` is read once, in `render`.
 */
const RECEIVING_ADDRESS_LABEL = 'midnight-identity/receiving-address-fingerprint/v1/';

/** The one spelling — folded, not refused, and folded here too so the
 * two spellings of one company render one fingerprint. */
const COMPANY_ADDRESS = /^[0-9a-fA-F]{64}$/u;

/**
 * **WHAT A RECEIVING ADDRESS HAS TO LOOK LIKE BEFORE IT IS RENDERED, AND WHY
 * THIS IS DELIBERATELY NOT THE REAL DECODER.**
 *
 * `wallet/address-shape.ts` is where a shielded address is CHECKED — checksum,
 * type and network, by name — and `payeeAddress()` on the far side is where it
 * is rebuilt before anybody is paid. Neither belongs here: this file must reach
 * `@noble` and nothing else, and it is called on BOTH sides of a
 * comparison, one of which is a payroll admin's browser holding a string that
 * has already been through both of those doors.
 *
 * So what this refuses is the class the header is about — **a string that is
 * not an address at all, rendered into something a person would compare and
 * believe.** Bech32m, so: printable, no whitespace, a separator in it, and long
 * enough to be an address rather than a word.
 */
const RECEIVING_ADDRESS = /^[\x21-\x7e]{40,}$/u;

export class FingerprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FingerprintError';
  }
}

/**
 * **THE ONE PLACE THE WIDTH, THE ALPHABET AND THE GROUPING LIVE.**
 *
 * Both public functions below are this with a different label, so a change to
 * how long a code is, or to how it is grouped, is one edit here and is the same
 * edit on both sides of every comparison. Two copies of this loop would be two
 * places for twenty to become sixteen.
 */
const render = (label: string, value: string): string => {
  const digest = sha256(new TextEncoder().encode(label + value));

  /* SYMBOLS × 5 bits, taken from the TOP of the digest. Thirteen bytes carry
   * 104; the low four are dropped rather than folded in, because a symbol
   * built from part of a byte would be a spelling nobody else reproduces. */
  let bits = 0n;
  for (let i = 0; i < 13; i += 1) bits = (bits << 8n) | BigInt(digest[i] as number);
  bits >>= 4n;

  const symbols: string[] = new Array<string>(SYMBOLS);
  for (let i = SYMBOLS - 1; i >= 0; i -= 1) {
    symbols[i] = ALPHABET[Number(bits & 31n)] as string;
    bits >>= 5n;
  }

  const groups: string[] = [];
  for (let i = 0; i < SYMBOLS; i += GROUP) groups.push(symbols.slice(i, i + GROUP).join(''));
  return groups.join('-');
};

/**
 * **A CODE AS SOMEBODY PASTED IT, PUT BACK INTO THE ONE SPELLING.**
 *
 * The code is copied rather than transcribed — that is the whole reason it
 * exists in this shape — but a paste picks up a trailing space, a line break, a
 * pair of quotes, and a person who copies half of it gets half of it. **A
 * comparison that failed on a space would send an admin looking for an attacker
 * who is not there**, which is worse than useless: the one control that
 * depends on a human paying attention must not spend that attention on
 * punctuation.
 *
 * So: separators and whitespace dropped, case folded, and the groups rebuilt
 * from `GROUP` and `SYMBOLS` — the same two constants `render` reads, so a code
 * that changes width is still tidied correctly with no second edit.
 *
 * **`null` FOR ANYTHING THAT IS NOT ONE**, rather than a best effort. A screen
 * can say *that is not a whole code* while somebody is still standing in front
 * of it; a half-code sealed into a handover is a mismatch discovered by an
 * admin days later, with nobody able to say whether it was a typo or a theft.
 */
export function tidyFingerprint(typed: string): string | null {
  if (typeof typed !== 'string') return null;
  const symbols = typed.toUpperCase().replace(/[^0-9A-Z]/gu, '');
  if (symbols.length !== SYMBOLS) return null;
  if ([...symbols].some((c) => !ALPHABET.includes(c))) return null;
  const groups: string[] = [];
  for (let i = 0; i < SYMBOLS; i += GROUP) groups.push(symbols.slice(i, i + GROUP));
  return groups.join('-');
}

/**
 * THE FINGERPRINT OF ONE COMPANY. A pure function of its address and nothing
 * else — no clock, no storage, no wallet, no device.
 *
 * The input is the address in either spelling; the output is the same either
 * way. **The separators are part of it**, because it is compared by eye and
 * never typed into anything.
 */
export function companyFingerprint(company: string): string {
  if (typeof company !== 'string' || !COMPANY_ADDRESS.test(company)) {
    throw new FingerprintError(
      'a company fingerprint is computed from a company\'s own address, and that is not '
      + 'one.');
  }
  return render(COMPANY_LABEL, company.toLowerCase());
}

/**
 * **THE FINGERPRINT OF A RECEIVING ADDRESS — THE CODE TWO PEOPLE COMPARE.**
 *
 * A pure function of the address and nothing else, exactly as its neighbour is:
 * no clock, no storage, no wallet, no device, so **the wallet that is about to
 * disclose an address and the admin who receives one compute the same string
 * from the same value without ever talking to each other.** That is the whole
 * mechanism — there is nothing else in it.
 *
 * **WHAT IT PROVES IS NARROW AND THE SCREENS SAY SO.** It matches when the
 * address that arrived is the address the wallet showed, so a page that relayed
 * an acceptance to a different wallet does not match. **It says nothing about
 * whether the right person was invited** — somebody accepting their own
 * invitation pastes their own matching code — and what catches that is the
 * admin confirming the code with the person through a channel where a wrong
 * person would be noticed.
 *
 * **NOT THE DEVICE-PAIRING DIGITS, AND `devices/pairing.ts`'s HEADER IS WHY.**
 * Pairing commits before it reveals, which is the only reason two digits are
 * safe there. Nothing here commits to anything, so the width is the whole
 * defence — and the width here is the width above.
 */
export function addressFingerprint(address: string): string {
  if (typeof address !== 'string' || !RECEIVING_ADDRESS.test(address)) {
    throw new FingerprintError(
      'this code is computed from the address money would be sent to, and that is not an '
      + 'address.');
  }
  return render(RECEIVING_ADDRESS_LABEL, address.toLowerCase());
}

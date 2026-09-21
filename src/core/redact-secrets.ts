/**
 * REMOVING A SECRET FROM A LINE OF TEXT BEFORE ANYTHING KEEPS IT.
 *
 * ── WHAT THIS EXISTS FOR ─────────────────────────────────────────────────
 *
 * The wallet SDK prints its own seed phrase into every log it writes, at INFO,
 * in the shape `Your wallet seed is: 39aebaeb…`. Thirty-eight files on this
 * machine contain one. **That line is printed by the SDK and not by us**, so it
 * cannot be fixed by choosing not to write it — the only place it can be
 * stopped is between the text and the file.
 *
 * The browser error sink is a second way for text to reach a file: it posts
 * what a page said, and the service appends it to `logs/REPORT-WEB-CONSOLE.txt`.
 * **An error message can carry anything** — a key, a seed, a session token, a
 * password typed into the wrong field, an address. So the text is put through
 * this function twice: once in the page, before it crosses the wire, and once
 * in the service, before it reaches the disk.
 *
 * **TWICE IS NOT TWO COPIES OF THE RULE.** It is one function applied at two
 * boundaries, which is the difference between defence in depth and the drift
 * that `src/testing/redact.ts` was written to end. Each application has its own
 * test and its own mutation, because a layer nothing watches is a layer that
 * can be removed without anything going red.
 *
 * ── WHY IT IS NOT `src/testing/redact.ts` ────────────────────────────────
 *
 * That one serialises a VALUE and blanks long hex so a substring search over
 * the result means what it appears to mean. It is a test helper for sealed
 * records and it takes `unknown`. This one takes TEXT that is about to be
 * persisted, in production code, and has to cope with a seed phrase, a bearer
 * token and a JSON body flattened into an exception message. Different input,
 * different job, and the 32-character hex threshold is the one thing they
 * share — deliberately, and for the reason written out over there.
 *
 * ── THE DIRECTION IT ERRS IN ─────────────────────────────────────────────
 *
 * **Over-redaction costs a debugging detail. Under-redaction costs a wallet.**
 * So every rule below is deliberately wider than the secret it is aimed at, and
 * a Midnight address is redacted even though an address is public — because the
 * line that prints a seed prints the address beside it, and a report that keeps
 * one half of that pair invites somebody to keep the other.
 *
 * **AND NO RULE BELOW ERRS THE OTHER WAY.** The seed phrase rule matched in
 * lower case only, so one capital letter anywhere in twenty-four words switched
 * it off and the whole phrase was kept. It was the single exception to the
 * paragraph above and it was found by running the file's own adversarial cases
 * against it rather than by reading it. What that rule now costs is written
 * beside it.
 */

/** Longer than this and a message is truncated rather than persisted whole. */
export const MAX_MESSAGE = 4000;

/**
 * The name of anything whose value is a secret, wherever it appears as
 * `name=value`, `name: value` or `"name": "value"`.
 *
 * Matched as a substring of the name, case-insensitively, so `authKey`,
 * `sessionToken`, `walletSeed` and `PASSWORD` are all covered without listing
 * every spelling anybody might use.
 *
 * **`sk` IS DELIBERATELY NOT IN THIS LIST** though it is what a secret key is
 * called everywhere else in this repository. As a substring it matches `task`,
 * `risk`, `disk` and `ask`, and a report that redacts the word `task` is a
 * report nobody trusts. Real key material is caught by the hex and token rules
 * below, which is where it was always going to be caught.
 */
const SECRET_NAMES =
  'password|passphrase|secret|seed|mnemonic|token|authkey|apikey|privatekey|signingkey';

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  /*
   * THE SDK'S OWN LINE, FIRST AND BY NAME. It arrives in this shape:
   *   INFO (18260): Your wallet seed is: 39aebaeb…
   * The generic rules below would catch the hex anyway; this one is here so the
   * report says WHICH secret was removed, and so there is a rule that names it
   * rather than a rule that happens to cover it.
   */
  [/(wallet seed is:?)\s*\S+/gi, '$1 <redacted:seed>'],

  /*
   * A SEED PHRASE. Twelve or more words in a row, each three to eight letters,
   * single-spaced, IN ANY CASE.
   *
   * This is a shape and not a word list, on purpose: BIP-39 has 2,048 words in
   * ten languages and a list that lags the SDK's is a list that misses.
   *
   * ── THE `i`, AND WHY IT IS NOT A TIGHTENING BUT A CORRECTION ───────────
   *
   * This rule was lower-case only, and **one capital letter anywhere in
   * twenty-four words turned it off entirely** — `abandon ability able` was
   * removed and `abandon ability able about above Absent…` was written to disk
   * in full, as was a phrase in capitals. The words are a working wallet in any
   * case at all; only the rule cared.
   *
   * It was narrow because the case that exists today is the SDK's, and the SDK
   * prints in lower case. **The case that does not exist yet is a person's**:
   * the sink exists to catch what a PERSON's browser said, a phrase reaches it
   * by being typed or pasted into the wrong field, and a phone keyboard
   * capitalises the first word without being asked. More text now reaches disk
   * than ever before — every refusal body — so this was closed when the sink
   * was added rather than left for later.
   *
   * **WHAT THE OVER-REDACTION COSTS, SAID OUT LOUD:** twelve consecutive short
   * title-case words in an error message now go too. That is a redacted
   * sentence in a report, and it is the trade the note at the top of this file
   * already says it wants — over-redaction costs a debugging detail,
   * under-redaction costs a wallet. Ordinary prose does not run twelve short
   * words with no punctuation in any case, which is why the shape works at all.
   */
  [/\b(?:[a-z]{3,8} ){11,}[a-z]{3,8}\b/gi, '<redacted:seed-phrase>'],

  /*
   * A BEARER TOKEN, wherever an Authorization header has been stringified into
   * a message. Caught before the generic token rule so the word `Bearer`
   * survives and the line still says what kind of thing was removed.
   */
  [/(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted:token>'],

  /*
   * A NAMED SECRET, in the three shapes text arrives in. The value runs to the
   * closing quote, or to whitespace, a comma, a semicolon or a closing bracket.
   */
  [new RegExp(`("(?:[A-Za-z0-9_.-]*(?:${SECRET_NAMES})[A-Za-z0-9_.-]*)"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'),
    '$1"<redacted>"'],
  [new RegExp(`\\b([A-Za-z0-9_.-]*(?:${SECRET_NAMES})[A-Za-z0-9_.-]*)(\\s*[:=]\\s*)[^\\s,;)\\]}"']+`, 'gi'),
    '$1$2<redacted>'],

  /*
   * A MIDNIGHT BECH32 STRING — address, coin public key, encryption key, or a
   * secret key that looks exactly like all of them. Redacted whole. See the
   * note at the top about which direction this errs in.
   */
  [/\bmn_[a-z0-9_-]*1[02-9ac-hj-np-z]{16,}/gi, '<redacted:bech32>'],

  /*
   * THIRTY-TWO HEX CHARACTERS OR MORE. The same threshold, and the same
   * reasoning, as `src/testing/redact.ts`: long enough that no plausible
   * plaintext reaches it by accident, short enough to catch every key, seed,
   * commitment, nonce and ciphertext body this system produces.
   */
  [/\b[0-9a-fA-F]{32,}\b/g, '<redacted:hex>'],

  /*
   * FORTY CHARACTERS OF UNBROKEN base64 OR base64url. Session tokens and JWTs
   * that are not hex land here.
   *
   * `/` IS DELIBERATELY NOT IN THE SET, and that is the whole reason the
   * threshold is 40 rather than 32. With `/` in it this rule ate absolute paths
   * out of stack traces — the one thing a browser error report exists to carry.
   */
  [/\b[A-Za-z0-9+_=-]{40,}\b/g, '<redacted:token>'],
];

/**
 * The text with everything shaped like a secret replaced, and nothing else
 * changed.
 *
 * Total, and never throws: it is called on the error path of a page and on the
 * write path of a service, and a redactor that can fail is a redactor that
 * hands the raw text to whatever catches for it. A non-string is stringified
 * rather than passed through.
 */
export const redactSecrets = (text: unknown): string => {
  let out = typeof text === 'string' ? text : String(text);
  for (const [pattern, replacement] of RULES) {
    try { out = out.replace(pattern, replacement); }
    catch { /* one rule failing must not release the other seven */ }
  }
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}… <truncated>` : out;
};

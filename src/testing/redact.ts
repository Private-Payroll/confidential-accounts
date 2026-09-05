/**
 * SEARCHING A SERIALISED RECORD FOR SOMETHING THAT SHOULD NOT BE IN IT. M-101, T-12.
 *
 * "The server cannot read a salary" is checked by serialising what the server
 * holds and asserting the salary does not appear in it. That check is unsound
 * as written, and the unsoundness is invisible:
 *
 * **Ciphertext is rendered as hex, and every decimal digit is also a hex
 * digit.** So a salary can appear inside a perfectly good ciphertext by pure
 * chance, and the test fails on correct code. Four digits in a couple of
 * hundred hex characters is roughly one run in a hundred and twenty — rare
 * enough to read as flakiness, frequent enough to happen twice in an afternoon,
 * which is exactly what it did on 16 August:
 *
 *     ...5155c8 9000 fa982e...
 *
 * A test that fails at random trains whoever runs it to re-run rather than to
 * look, which is how a real failure gets waved through.
 *
 * ------------------------------------------------------------------------
 * WHY THIS FILE EXISTS RATHER THAN THE FIX LIVING WHERE IT WAS FOUND
 *
 * **The rule was already known.** M-101 hit it, and `core.test.ts` grew exactly
 * this function to handle it — as a private helper, at the top of one test
 * file. `sealed-records.test.ts` then wrote the same check without it, because
 * there was no way to reach it.
 *
 * One rule, held in one place nobody else can get to, is the same defect as one
 * rule written twice. It cost this project two lost afternoons of "flaky test"
 * before somebody read the failure.
 */

/**
 * Serialises a value with every long hex run replaced by `<hex>`.
 *
 * What remains is exactly the part a human could read, so a substring search
 * over it means what it appears to mean.
 *
 * `bigint` is stringified rather than dropped: an amount held as a bigint is
 * still an amount, and a serialiser that silently omitted it would make the
 * test pass by hiding the thing it is looking for.
 *
 * 32 hex characters is the threshold. Long enough that no plausible plaintext
 * reaches it by accident, short enough to catch every commitment, nonce,
 * blinding, tag and ciphertext body this system produces.
 *
 * **IT WAS LOWERED TO 24 AND HAS BEEN PUT BACK. `C29`, found by audit 17 Aug.**
 * A 12-byte `iv` is 24 hex characters and was showing up unredacted; the change
 * made was to lower the threshold for everything, which blinded EVERY
 * "the server cannot read a salary" assertion in the repo to any 24-to-31
 * character lowercase-hex plaintext at once. Measured with it back at 32: the
 * whole suite is green, so nothing ever needed it. **A detector loosened to
 * make a run green is `C16`'s lesson wearing a test's clothes.** The short
 * fixed-width secrets are redacted by NAME instead, below, which is what they
 * needed in the first place.
 */
const SHORT_BY_NAME = new Set(['iv', 'nonce', 'salt', 'tag']);

export const redactHex = (data: unknown): string =>
  JSON.stringify(data, (k, v) =>
    typeof v === 'bigint' ? v.toString()
      : (typeof v === 'string' && (SHORT_BY_NAME.has(k) || /^[0-9a-f]{32,}$/.test(v))
        ? '<hex>' : v));

/**
 * WHAT A UNIT IS — §7.17, the Foundation's own figures.
 *
 * **1 NIGHT = 10^6 STARs.** The atomic unit of NIGHT is the Star; the chain
 * counts Stars, people think in NIGHT. Source: `spec/dust.md` in
 * `midnightntwrk/midnight-ledger` and docs.midnight.network — the figure is
 * absent from the npm packages, which is not the same as unpublished.
 * **MEASURED on stagenet, 19 Aug**: a 5000 tNIGHT faucet payment read back
 * as exactly 5,000,000,000 STARs through this app's own wiring
 * (verdict FULL) — the split is a measurement
 * now, not an assumption.
 *
 * **1 DUST = 10^15 SPECKs.** The atomic unit of DUST is the Speck — same two
 * sources. DUST pays transaction fees; it is generated over time by
 * registered NIGHT rather than bought, and fifteen decimals means a useful
 * DUST balance is a very small-looking number — which is exactly why the
 * exact Speck count must ride beside it. The stagenet-shares-the-split
 * check for DUST is a measurement, the same way the faucet payment was
 * NIGHT's.
 *
 * THE RENDERING RULE, from §7.17: divide by the atomic unit, say which
 * token, and NEVER round — a rounded balance makes a smaller number look
 * like the whole of it, and the both-ends habit (always) applies to
 * amounts as much as addresses. So the divisions below are exact bigint
 * arithmetic, the fraction keeps every non-zero digit, and every screen
 * that shows a NIGHT or DUST figure keeps the exact atomic count beside it.
 */

export const STARS_PER_NIGHT = 1_000_000n;

export const SPECKS_PER_DUST = 1_000_000_000_000_000n;

/** One exact division for both tokens: never rounds, never drops a digit. */
function exactDivide(atomic: bigint, perWhole: bigint, decimals: number): string {
  const whole = atomic / perWhole;
  const fraction = atomic % perWhole;
  if (fraction === 0n) return whole.toLocaleString();
  const digits = fraction.toString().padStart(decimals, '0').replace(/0+$/u, '');
  return `${whole.toLocaleString()}.${digits}`;
}

/**
 * Stars → a NIGHT figure, exact. "1234567" becomes "1.234567"; "2500000"
 * becomes "2.5"; trailing zeros go, digits never do.
 */
export function nightFromStars(stars: bigint): string {
  return exactDivide(stars, STARS_PER_NIGHT, 6);
}

/** The exact figure, said as itself — what rides beside every NIGHT number. */
export function exactStars(stars: bigint): string {
  return `${stars.toLocaleString()} STARs`;
}

/** Specks → a DUST figure, exact — fifteen decimals, digits never dropped. */
export function dustFromSpecks(specks: bigint): string {
  return exactDivide(specks, SPECKS_PER_DUST, 15);
}

/** The exact figure, said as itself — what rides beside every DUST number. */
export function exactSpecks(specks: bigint): string {
  return `${specks.toLocaleString()} SPECKs`;
}

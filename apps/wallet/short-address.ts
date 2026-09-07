/**
 * How a shortened address is split for display — pulled out of the home
 * screen so it can be tested (this is exactly the decision: which part of an
 * address is faded and which is strong).
 *
 * WHAT IS SHOWN comes from the library's `shortPayee`; this only decides the
 * colouring. The run before the bech32 separator `1` is shared by every
 * address on the network, so it is faded; the two ends — the only parts worth
 * comparing — are strong.
 */

export interface ShortAddressParts {
  /** The shared network prefix, separator included. Faded. */
  readonly network: string;
  /** The start of this address's own characters. Strong. */
  readonly head: string;
  /** The end, after the ellipsis — or null if the form had no ellipsis. */
  readonly tail: string | null;
}

/**
 * Splits on the ellipsis `shortPayee` uses, then on the LAST `1` of the
 * leading part — safe because the bech32 character set excludes `1`, so the
 * only `1`s in the string are in the human prefix and the separator itself.
 * A form with no ellipsis (nothing was elided) comes back whole, tail null.
 */
export function splitShortAddress(short: string): ShortAddressParts {
  const gap = short.indexOf('…');
  const lead = gap === -1 ? short : short.slice(0, gap);
  const tail = gap === -1 ? null : short.slice(gap + 1);
  const cut = lead.lastIndexOf('1') + 1;
  return { network: lead.slice(0, cut), head: lead.slice(cut), tail };
}

/**
 * EVERY PRIVATE TOKEN A WALLET HOLDS, NOT ONLY NIGHT.
 *
 * The SDK's shielded wallet reports one balance map for every token among its
 * available coins (confirmed, and not being spent), keyed by each token's raw
 * colour. NIGHT is one key in that map, and the wallet shows it in its own
 * unit and under its own name. Every other key is carried here, beside NIGHT,
 * so that a token the wallet holds is never shown as a zero or left off the
 * screen.
 *
 * THE WALLET HAS NO NAME AND NO SCALE FOR A TOKEN OTHER THAN NIGHT. It does
 * not guess one. Such a token is shown as its amount in its smallest unit,
 * with its colour. Putting a decimal point into an amount whose scale this
 * wallet does not know would be inventing a number. The wallet does not read
 * the service's asset registry.
 *
 * ABSENT IS NOT EMPTY. `OtherTokens` is present only when the whole map was
 * read. A figure that did not record the other tokens, such as a checkpoint
 * saved by an older version of this wallet, carries no `OtherTokens` at all.
 * The screens say "not recorded" for that case. They never show it as a zero.
 */

/** Every private token other than NIGHT that a wallet holds, keyed by the
 * token's raw colour. Each amount is in that token's smallest unit, and every
 * amount is above zero: a token the wallet holds none of is not in the map. */
export type OtherTokens = Readonly<Record<string, bigint>>;

/**
 * NIGHT's amount and every other held token, split out of the SDK's map.
 * NIGHT is zero when the map has no NIGHT key: the map was read whole, so a
 * missing key is none held. Another token is left out when its amount is not
 * above zero, so the screens never list a token at zero.
 */
export function splitShielded(
  balances: Readonly<Record<string, bigint>>, nightRaw: string,
): { readonly night: bigint; readonly others: OtherTokens } {
  const others: Record<string, bigint> = {};
  for (const [colour, amount] of Object.entries(balances)) {
    if (colour === nightRaw) continue;
    if (typeof amount === 'bigint' && amount > 0n) others[colour] = amount;
  }
  return { night: balances[nightRaw] ?? 0n, others };
}

/** The other tokens in a fixed order (by colour), so two screens list them
 * the same way and a re-render never reshuffles them. */
export const otherTokenLines = (others: OtherTokens): ReadonlyArray<readonly [string, bigint]> =>
  Object.entries(others)
    .filter(([, amount]) => amount > 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Whether any other token is held at all. False for an absent map: an
 * unrecorded figure is not evidence of money, and it is not evidence of none. */
export const holdsAnyOther = (others: OtherTokens | undefined): boolean =>
  others !== undefined && Object.values(others).some((amount) => amount > 0n);

/** The colour's short form: its first six and last four characters, or the
 * whole colour when it is twelve characters or fewer. A short form alone
 * cannot tell two tokens apart for certain, so every caller keeps the whole
 * colour reachable beside it. */
export const shortColour = (colour: string): string =>
  (colour.length <= 12 ? colour : `${colour.slice(0, 6)}…${colour.slice(-4)}`);

/** The amount in the token's smallest unit, grouped and never divided. */
export const smallestUnits = (amount: bigint): string => amount.toLocaleString();

/** How the map is written into a saved checkpoint: amounts as decimal text,
 * because JSON has no bigint. */
export const otherTokensToStored = (others: OtherTokens): Record<string, string> =>
  Object.fromEntries(otherTokenLines(others).map(([colour, amount]) => [colour, amount.toString()]));

/**
 * The map read back from a saved checkpoint.
 *
 * `undefined` in, `undefined` out: an older checkpoint recorded NIGHT only,
 * and it must not come back as "holds no other token". Anything present but
 * not the shape written above throws, and the caller treats a damaged
 * checkpoint as no checkpoint.
 */
export function otherTokensFromStored(stored: unknown): OtherTokens | undefined {
  if (stored === undefined) return undefined;
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error('the saved other-token map is not a map');
  }
  const others: Record<string, bigint> = {};
  for (const [colour, text] of Object.entries(stored as Record<string, unknown>)) {
    if (!/^[0-9a-f]+$/iu.test(colour)) throw new Error('a saved token colour is not hex');
    if (typeof text !== 'string' || !/^[0-9]+$/u.test(text)) {
      throw new Error('a saved token amount is not a whole number');
    }
    const amount = BigInt(text);
    if (amount > 0n) others[colour] = amount;
  }
  return others;
}

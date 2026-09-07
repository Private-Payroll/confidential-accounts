/**
 * WHICH NETWORK, AND WHY IT IS A STRING AND NEVER AN ENUM.
 *
 * The network id is not a flag. It is interpolated verbatim as a segment of
 * every Bech32m address the SDK encodes and decodes:
 *
 *     'testnet'  ->  mn_shield-addr_testnet1qurswpc8...
 *     2          ->  mn_shield-addr_21qurswpc8...
 *
 * A neighbouring repository lost a day to exactly this: `ledger.NetworkId` is a numeric
 * enum, `midnight-js-network-id` declares `type NetworkId = string`, and an
 * `as any` on the import hid the mismatch from the typechecker. Every deploy
 * threw *"Expected 2 address, got testnet one"*. The Foundation's own testkit
 * passes lowercase name strings.
 *
 * So this list is names, and there is no enum anywhere near it.
 */
export const NETWORKS = [
  'undeployed', 'devnet', 'preview', 'preprod', 'qanet', 'stagenet', 'testnet', 'mainnet',
] as const;

export type NetworkName = (typeof NETWORKS)[number];

export const isNetworkName = (value: string): value is NetworkName =>
  (NETWORKS as readonly string[]).includes(value);

export function networkName(value: string): NetworkName {
  if (!isNetworkName(value)) {
    throw new Error(
      `"${value}" is not a Midnight network. It must be one of ${NETWORKS.join(', ')} — `
      + 'and it is not a label, it is part of every address, so a wrong one produces '
      + 'addresses nothing on the real network can decode.');
  }
  return value;
}

/**
 * **THE NETWORK BOTH APPLICATIONS ARE ON.** §7.16, decided 19 Aug.
 * It is where the payroll contract lives, so one indexer and one node serve
 * both products.
 *
 * A single named constant every screen reads, NEVER derived from a hostname, a
 * build flag, or "whatever is configured" — the network name is a segment of
 * every address string, so a wallet that shows one network and signs for
 * another is discovered by somebody else's money. Changing this constant
 * changes every address this wallet displays; the switch from testnet happened
 * with the balance work, which is when endpoints arrived.
 *
 * ── IT IS HERE AND NOT IN `app/config.ts`, AND THAT IS DELIBERATE ─────────────
 *
 * A person signs in to payroll with an address this wallet wrote, and payroll
 * re-derives that address from the key that signed. **Both sides put the name
 * of the network inside the string**, so one key produces two different
 * addresses on two networks — and a payroll configured for another one refuses
 * a sign-in that is perfectly good, blaming the key. That is what happened the
 * first time the two applications were walked together.
 *
 * So the value the other side must agree with is exported from a module that
 * touches NOTHING: no browser, no `window`, and — the load-bearing half — no
 * `ledger-v9`. `app/config.ts` reads `window.location`, so a server cannot
 * import it at all, and the package root reaches `wallet/address.ts` and
 * therefore ten megabytes of WebAssembly, which is the trap. **A leaf module
 * behind its own subpath export is what lets the other side read one value
 * without buying a bundle** — `midnight-identity/network`.
 */
export const NETWORK: NetworkName = 'stagenet';

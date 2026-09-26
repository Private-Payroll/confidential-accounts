/**
 * **A STAND-IN FOR THE DEPOSITOR'S WALLET THAT PAYS FOR A PAGE'S DEPOSIT WITH
 * ITS OWN PRIVATE COIN, AND TAKES ITS CHANGE BACK.** The wallet's real
 * balancing is watched in `src/web/a-deposit-built-on-the-device.test.ts`,
 * over the wallet SDK's own coin choice; this one only has to leave nothing
 * stated in public, and the chains these watches run do not check balance.
 *
 * A deposit arrives from the page stating its token and its amount as an open
 * imbalance, and the service refuses to send one that still does. So a watch
 * that runs a deposit through the service's own routes needs a wallet that
 * balances it privately. This one holds coins the watch's chain was seeded
 * with, spends one against the chain's own commitment tree, and returns what
 * it does not need to itself. It proves nothing and signs nothing, as the
 * chains these watches run do not ask it to.
 *
 * **ITS COINS MUST BE THE FIRST THE CHAIN EVER HOLDS**, because it keeps a
 * copy of the commitment tree made only of its own coins: seed the chain with
 * `seedTransaction` before any other transaction that makes a coin.
 */
import * as L from '@midnightntwrk/ledger-v9';

export interface AWalletThatPaysPrivately {
  /** One transaction that gives this wallet one coin of `token` for each value, to seed the chain with first. */
  seedTransaction(token: string, values: readonly bigint[]): unknown;
  /** The page's deposit, paid for in the same section with one of this wallet's coins, not yet bound. */
  payFor(deposit: unknown): unknown;
}

export function aWalletThatPaysPrivately(network: string, seed = new Uint8Array(32).fill(0x61)): AWalletThatPaysPrivately {
  const keys = L.ZswapSecretKeys.fromSeed(seed);
  let local = new L.ZswapLocalState();
  const used = new Set<string>();
  return {
    seedTransaction(token, values) {
      let offer: any;
      for (const value of values) {
        const coin = L.createShieldedCoinInfo(token as never, value);
        const out = L.ZswapOffer.fromOutput(L.ZswapOutput.new(coin, 0, keys.coinPublicKey, keys.encryptionPublicKey), token as never, value);
        offer = offer === undefined ? out : offer.merge(out);
      }
      const tx: any = L.Transaction.fromParts(network, offer);
      local = local.apply(keys, tx.guaranteedOffer);
      return tx;
    },
    payFor(deposit) {
      const d = deposit as any;
      const owed = [...(d.guaranteedOffer?.deltas?.entries() ?? [])].filter(([, v]: [string, bigint]) => v < 0n);
      if (owed.length !== 1) throw new Error(`this stand-in pays for one private token, and the deposit owes ${owed.length}`);
      const [token, delta] = owed[0] as [string, bigint];
      const need = -delta;
      const coin = [...local.coins].find((c: any) => String(c.type) === token && c.value >= need && !used.has(String(c.nonce)));
      if (coin === undefined) throw new Error('this stand-in holds no coin that covers the deposit; seed it with more');
      used.add(String((coin as any).nonce));
      const [next, input] = local.spend(keys, coin, 0);
      local = next;
      let offer: any = L.ZswapOffer.fromInput(input, token as never, (coin as any).value);
      const rest = (coin as any).value - need;
      if (rest > 0n) {
        const change = L.createShieldedCoinInfo(token as never, rest);
        offer = offer.merge(L.ZswapOffer.fromOutput(
          L.ZswapOutput.new(change, 0, keys.coinPublicKey, keys.encryptionPublicKey), token as never, rest));
      }
      return d.merge(L.Transaction.fromParts(network, offer));
    },
  };
}

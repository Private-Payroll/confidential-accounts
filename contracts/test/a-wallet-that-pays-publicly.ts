/**
 * **A STAND-IN FOR THE DEPOSITOR'S WALLET THAT PAYS FOR A PAGE'S PUBLIC DEPOSIT
 * WITH ITS OWN PUBLIC TOKENS, THROUGH THE WALLET SDK'S OWN PUBLIC BALANCING.**
 *
 * The product wallet asks the SDK facade to balance a page's transaction in the
 * public kind only, and the facade hands that to the public wallet's own
 * balancing capability, which adds this wallet's coins and its change in place
 * and in the section the transaction owes them. This stand-in runs that same
 * capability, from the same package, over a wallet holding coins the watch
 * chooses, and signs with the SDK's own signing steps. It proves nothing and
 * keeps no sync: its coins are whatever it is told it holds.
 *
 * The package publishes only its root, so the capability is loaded from its
 * built files by path.
 */
import * as L from '@midnightntwrk/ledger-v9';
import { createKeystore, PublicKey } from '@midnightntwrk/wallet-sdk';
import { chooseCoin } from '@midnightntwrk/wallet-sdk-capabilities';
import { Either } from 'effect';

const V1 = new URL('../../node_modules/@midnightntwrk/wallet-sdk-unshielded-wallet/dist/v1/', import.meta.url);
const load = (file: string) => import(new URL(file, V1).href);

export interface AWalletThatPaysPublicly {
  /** This wallet's public address, as the ledger writes it. */
  readonly address: string;
  /** One transaction that gives this wallet one public coin of `token` for each value, for a chain that does not check balance. */
  seedTransaction(token: string, values: readonly bigint[]): unknown;
  /** Takes this wallet's coins from the chain's own set of public coins, as a synced wallet would read them. */
  holdWhatTheChainSays(utxos: Iterable<{ value: bigint; owner: unknown; type: unknown; intentHash: unknown; outputNo: number }>): void;
  /** The page's transaction, balanced in place by the SDK's public balancing and signed; not bound. */
  payFor(tx: unknown): Promise<unknown>;
}

export async function aWalletThatPaysPublicly(network: string, seed = new Uint8Array(32).fill(0x62)): Promise<AWalletThatPaysPublicly> {
  const [T, CW, US, CB, TO] = await Promise.all([
    load('Transacting.js'), load('CoreWallet.js'), load('UnshieldedState.js'), load('CoinsAndBalances.js'), load('TransactionOps.js'),
  ]);
  const keystore = createKeystore({ kind: 'schnorr', secret: seed } as never, network as never);
  const publicKey = (PublicKey as any).fromKeyStore(keystore);
  const address = String(publicKey.addressHex);
  let held: Array<{ value: bigint; owner: string; type: string; intentHash: string; outputNo: number }> = [];
  const capability = new T.TransactingCapabilityImplementation(
    network, () => chooseCoin, () => CB.makeDefaultCoinsAndBalancesCapability(), () => ({}), TO.TransactionOps);
  return {
    address,
    seedTransaction(token, values) {
      const outputs = values.map((value) => ({ value, owner: address, type: token }));
      const intent = L.Intent.new(new Date(Date.now() + 60 * 60_000));
      intent.guaranteedUnshieldedOffer = L.UnshieldedOffer.new([], outputs as never, []);
      return L.Transaction.fromParts(network, undefined, undefined, intent);
    },
    holdWhatTheChainSays(utxos) {
      held = [...utxos]
        .filter((u) => String(u.owner).toLowerCase() === address.toLowerCase())
        .map((u) => ({ value: u.value, owner: String(u.owner), type: String(u.type), intentHash: String(u.intentHash), outputNo: u.outputNo }));
    },
    async payFor(tx) {
      const state = US.UnshieldedState.restore(
        held.map((utxo) => new US.UtxoWithMeta({ utxo, meta: { ctime: new Date(), registeredForDustGeneration: false } })), []);
      const wallet = CW.CoreWallet.restore(state, publicKey, { appliedId: 0n, highestTransactionId: 0n }, 1, network);
      const balanced = capability.balanceUnboundTransaction(wallet, tx);
      if (Either.isLeft(balanced)) throw balanced.left;
      const [out] = balanced.right as [any];
      const signable = TO.TransactionOps.collectSignableData(out);
      if (Either.isLeft(signable)) throw signable.left;
      const signatures = (signable.right as Array<{ segment: number; data: Uint8Array }>)
        .map(({ segment, data }) => ({ segment, signature: keystore.signData(data) }));
      const signed = TO.TransactionOps.attachSignatures(out, signatures);
      if (Either.isLeft(signed)) throw signed.left;
      const spent = new Set(held.map((u) => `${u.intentHash}:${u.outputNo}`));
      for (const intent of (signed.right as any).intents.values()) {
        for (const i of intent.guaranteedUnshieldedOffer?.inputs ?? []) spent.delete(`${i.intentHash}:${i.outputNo}`);
      }
      held = held.filter((u) => spent.has(`${u.intentHash}:${u.outputNo}`));
      return signed.right;
    },
  };
}

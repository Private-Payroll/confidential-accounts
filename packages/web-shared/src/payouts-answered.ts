/**
 * **A PAYMENT OUT OF A VAULT, BUILT AND PROVED IN THE VAULT WORKER**: a private payment, a merge of the vault's
 * notes, and a public payment, each built on the chain's state at one block as the page read it.
 */
import { buildMerge, buildPayout, buildPublicPayout, type VaultBuilderDeps } from './vault-builder.js';
import { fromBase64, toBase64 } from './base64-bytes.js';
import type { VaultAnswer, VaultAsk } from './vault-worker-client.js';
import type { WorkerDeps } from './vault-worker-deps.js';

/** The asks that pay out of a vault; any other ask is answered elsewhere, so this gives undefined. */
export const payoutsAnswered = async (_d: WorkerDeps, withNetwork: VaultBuilderDeps, ask: VaultAsk): Promise<VaultAnswer | undefined> => {
  switch (ask.ask) {
    case 'payout': {
      const built = await buildPayout(withNetwork, {
        vault: ask.vault, account: ask.account, order: ask.order, payment: ask.payment,
        note: ask.note, events: ask.events, ...(ask.further === undefined ? {} : { further: ask.further }), secret: ask.secret,
        chain: {
          blockHash: ask.chain.blockHash,
          vaultState: fromBase64(ask.chain.vaultState),
          zswapState: fromBase64(ask.chain.zswapState),
          parameters: fromBase64(ask.chain.parameters),
          accountState: fromBase64(ask.chain.accountState),
        },
      });
      return { id: ask.id, ok: true, ask: 'payout', tx: toBase64(built.proven), spent: built.spent, change: built.change };
    }
    case 'merge': {
      const built = await buildMerge(withNetwork, {
        vault: ask.vault, notes: ask.notes, secret: ask.secret,
        chain: {
          blockHash: ask.chain.blockHash,
          vaultState: fromBase64(ask.chain.vaultState),
          zswapState: fromBase64(ask.chain.zswapState),
          parameters: fromBase64(ask.chain.parameters),
          accountState: fromBase64(ask.chain.accountState),
        },
      });
      return { id: ask.id, ok: true, ask: 'merge', tx: toBase64(built.proven), spent: built.spent, kept: built.kept };
    }
    case 'payout-publicly': {
      const built = await buildPublicPayout(withNetwork, {
        vault: ask.vault, account: ask.account, order: ask.order, payment: ask.payment,
        chain: {
          blockHash: ask.chain.blockHash,
          vaultState: fromBase64(ask.chain.vaultState),
          zswapState: fromBase64(ask.chain.zswapState),
          parameters: fromBase64(ask.chain.parameters),
          accountState: fromBase64(ask.chain.accountState),
        },
      });
      return { id: ask.id, ok: true, ask: 'payout-publicly', tx: toBase64(built.proven) };
    }
    default:
      return undefined;
  }
};

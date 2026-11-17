/**
 * **THE CHAIN, READ IN THE VAULT WORKER AT THE INDEXER THE PERSON'S OWN WALLET NAMES**: a vault as deployed and as
 * it stands, what a call is built on at one block, whether the account is on the chain, a transaction's events and
 * the transaction that created a note. Never read by the page or the company's service.
 */
import { newestTimeToLive, type VaultBuilderDeps } from './vault-builder.js';
import { fromBase64 } from './base64-bytes.js';
import { vaultAsDeployed } from './vault-as-deployed.js';
import type { VaultAnswer, VaultAsk } from './vault-worker-client.js';
import type { WorkerDeps } from './vault-worker-deps.js';

/** The asks read off the chain; any other ask is answered elsewhere, so this gives undefined. */
export const chainReadsAnswered = async (d: WorkerDeps, withNetwork: VaultBuilderDeps, ask: VaultAsk): Promise<VaultAnswer | undefined> => {
  switch (ask.ask) {
    case 'vault-as-deployed': {
      /* The deploy as the chain holds it, from the indexer the wallet names, read here and never served by anybody. */
      const { vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'vault-as-deployed', refusal: await vaultAsDeployed(d, ask, source) };
    }
    case 'account-call-chain': {
      /* What a call to the account alone is built on, at one block, from the indexer the wallet names: never the service's. */
      const { readAccountCallChain, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'account-call-chain', chain: await readAccountCallChain(source, ask.account) };
    }
    case 'account-presence': {
      /* Read from the indexer the wallet names; the time to live comes from the bytes kept, the time from the chain. */
      const { readAccountPresence, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      const seen = await readAccountPresence(source, ask.account);
      const ttl = newestTimeToLive(withNetwork, ask.transactions.map(fromBase64));
      return { id: ask.id, ok: true, ask: 'account-presence', presence: { held: seen.held, blockHeight: seen.blockHeight, blockTime: seen.blockTime, ttl } };
    }
    case 'vault-on-chain': {
      /*
       * The vault as the chain holds it, and with `account` that account's circuits, from the indexer the wallet names,
       * read here and never by the page or the service.
       */
      const { readVaultOnChain, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'vault-on-chain', read: await readVaultOnChain(d, source, ask.vault, ask.account) };
    }
    case 'chain-at-one-block': {
      /* What a step out of the vault is built on, at one block, from the indexer the wallet names: never the service's. */
      const { readChainAtOneBlock, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'chain-at-one-block', chain: await readChainAtOneBlock(source, ask.vault, ask.account) };
    }
    case 'events-of': {
      const { readEventsOf, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'events-of', events: await readEventsOf(source, ask.transactionHash) };
    }
    case 'created-by': {
      const { readCreatedBy, vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const source = (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer);
      return { id: ask.id, ok: true, ask: 'created-by', found: await readCreatedBy(source, ask.vault, ask.commitment) };
    }
    default:
      return undefined;
  }
};

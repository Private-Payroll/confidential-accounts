/**
 * **THE VAULT WORKER'S ANSWERS IN A CHANGE OF THE SUPER ADMINS** (`super-admin-asks.ts`): the chain read here with the
 * ledger's state reader and the account's compiled reader, at the indexer the person's own wallet names, and an update's
 * bytes and each signature checked with the ledger itself, exactly as where the ledger loads on its own
 * (`committee-reads.ts`, `super-admin-ledger.ts`).
 */
import { committeeReadsOf } from './committee-reads.js';
import { superAdminLedgerOf } from './super-admin-ledger.js';
import { fromBase64, toBase64 } from './base64-bytes.js';
import type { SuperAdminAnswer, SuperAdminAsk } from './super-admin-asks.js';
import type { WorkerDeps } from './vault-worker-entry.js';

const COUNTER = /^[0-9]+$/u;

/** One answer to one of the super admins' asks, built with `d`. */
export async function superAdminAnswered(
  d: Pick<WorkerDeps, 'runtimeState' | 'accountLedger' | 'ledger' | 'chainSourceAt'>, ask: SuperAdminAsk,
): Promise<SuperAdminAnswer> {
  const ledger = superAdminLedgerOf(d.ledger);
  switch (ask.ask) {
    case 'account-committee':
    case 'contract-authority': {
      const { vaultChainSourceAt } = await import('./vault-on-chain-here.js');
      const reads = committeeReadsOf(d, (d.chainSourceAt ?? vaultChainSourceAt)(ask.indexer));
      return ask.ask === 'account-committee'
        ? { id: ask.id, ok: true, ask: ask.ask, read: await reads.accountAt(String(ask.account).toLowerCase()) }
        : { id: ask.id, ok: true, ask: ask.ask, read: await reads.authorityAt(String(ask.address).toLowerCase()) };
    }
    case 'super-admin-update': {
      if (!COUNTER.test(String(ask.counter))) throw new Error('that is not a counter the chain holds, so no update was made.');
      return { id: ask.id, ok: true, ask: ask.ask, bytes: toBase64(await ledger.updateBytes({ vault: ask.vault, counter: BigInt(ask.counter), to: ask.to })) };
    }
    case 'super-admin-signed':
      return { id: ask.id, ok: true, ask: ask.ask, good: await ledger.signedBy(ask.key, fromBase64(ask.data), ask.signature) };
    case 'super-admin-joined':
      return { id: ask.id, ok: true, ask: ask.ask, good: await ledger.joinedBy(fromBase64(ask.data), ask.key, ask.signature) };
  }
}

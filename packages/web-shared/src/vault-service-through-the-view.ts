/*
 * The company's vault routes through a view of the company: a new vault's deploy, a hand-over, a deposit, a payout and
 * a merge are each a write through the view, so the view's check runs once just before it and the view forgets what it
 * can change; a vault's chain and its payout state are read through the view. The vault's readers are not here: each
 * caller says what its own act reads of them.
 */
import type { CompanyView } from './company-view.js';
import type { VaultSend } from './records-source.js';
import type { VaultService } from './vault-service.js';
import { marked } from './vault-service-doors.js';

/** The view the vault routes follow: the step's current one. */
interface VaultView { current(): Pick<CompanyView<unknown>, 'write' | 'vaultChain' | 'payoutState'> }

/** Every vault route but the readers', through the company `held` views. */
export const vaultServiceThrough = (held: VaultView): Omit<VaultService, 'keys'> => {
  /* The route's own answer to a send, its refusal keeping the service's mark of whether anything was sent. */
  const sent = <T>(send: VaultSend, tx: string): Promise<T> =>
    marked(async () => (await held.current().write([{ to: 'vault-send', tx, ...send }]))[0] as T);
  return {
    deploy: (tx) => sent({ act: 'deploy' }, tx),
    handover: (vault, tx) => sent({ act: 'handover', vault }, tx),
    chain: async (vault) => await held.current().vaultChain(vault) as Awaited<ReturnType<VaultService['chain']>>,
    deposit: (vault, tx) => sent({ act: 'deposit', vault }, tx),
    depositPublicly: (vault, tx) => sent({ act: 'public-deposit', vault }, tx),
    payoutState: async (vault) => await held.current().payoutState(vault) as Awaited<ReturnType<VaultService['payoutState']>>,
    payout: (vault, tx) => sent({ act: 'payout', vault }, tx),
    merge: (vault, tx) => sent({ act: 'merge', vault }, tx),
    payoutPublicly: (vault, tx) => sent({ act: 'public-payout', vault }, tx),
  };
};

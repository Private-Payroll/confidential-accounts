import type { Identity } from 'midnight-identity/keys/derivation';
import type { BalanceDoors, LedgerForBalancing } from './balance-for-page.js';
import { facadeFor, startForAPage } from './facade.js';
import { makeBrowserProvingService } from './proving.js';
import type { ProofEvent } from './proving.js';
import { coinPublicKeyOf, shieldedKeysFor } from './balance.js';
import { dustKeysFor } from './dust.js';
import { unshieldedKeystoreFor } from './unshielded.js';
import { loadWalletCheckpoint } from '../accounts/storage.js';
import { openWalletId } from '../accounts/wallets-held.js';

/**
 * The live doors: the wallet the person chose, on the real network, proving in
 * this browser. The wallet is started on the press and holds nothing until it
 * has read the chain; `payForThePage` waits for that before it adds a coin.
 *
 * **ITS PRIVATE PART STARTS FROM WHERE THIS WALLET LAST GOT TO**, when this
 * browser holds a checkpoint for it, and reads only what is new; otherwise it
 * reads from the beginning. Either way nothing is paid until it has heard the
 * network say it is up to date: a restored wallet reports itself unconnected
 * until then. **Nothing here ever writes a checkpoint**, and its DUST part is
 * never started - a page's deposit pays no fee from here.
 */
export const liveBalanceDoors = (identity: Identity, account: number): BalanceDoors & { stop: () => Promise<void> } => {
  /* Decided now, while this wallet is the one on screen; the balance engine captures it for the same reason. */
  const walletId = openWalletId();
  const proofWatchers = new Set<(event: ProofEvent) => void>();
  let running: Promise<Awaited<ReturnType<typeof facadeFor>>> | null = null;
  const facade = () => {
    running ??= (async () => {
      const checkpoint = await loadWalletCheckpoint(coinPublicKeyOf(identity, account), account, walletId);
      const proving = makeBrowserProvingService(undefined, {
        onProof: (event) => { for (const watch of proofWatchers) watch(event); },
      });
      const started = await facadeFor(identity, account, proving, {}, { restoreShieldedFrom: checkpoint?.serialized });
      await startForAPage(started, { shielded: shieldedKeysFor(identity, account) });
      return started;
    })();
    return running;
  };
  return {
    ledger: async (): Promise<LedgerForBalancing> => import('@midnightntwrk/ledger-v9'),
    facade,
    dustKeys: () => dustKeysFor(identity, account),
    signSegment: () => unshieldedKeystoreFor(identity, account).signDataAsync,
    ownPublicAddress: () => String(unshieldedKeystoreFor(identity, account).getAddress()),
    watchProofs: (watch) => { proofWatchers.add(watch); return () => { proofWatchers.delete(watch); }; },
    stop: async () => {
      if (running === null) return;
      const f = await running.catch(() => { /* a wallet that never started has nothing to stop */ return null; });
      running = null;
      await f?.stop().catch(() => { /* already stopping */ });
    },
  };
};

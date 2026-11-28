import { createContext } from 'react';
import type { WalletFacade } from '@midnightntwrk/wallet-sdk';
import type { Identity } from 'midnight-identity';
import { facadeFor, seedsFor } from './facade.js';
import { makeBrowserProvingService } from './proving.js';
import { rehearsalDoors } from './rehearsal.js';
import type { RehearsalScenario } from './rehearsal.js';
import { startSend } from './send.js';
import type { SendDoors } from './send.js';
import { unshieldedKeystoreFor } from './unshielded.js';
import { fetchNetworkTerms } from './terms.js';

/**
 * THE SEND SCREEN'S ONE SEAM: the LIVE wiring — the facade over the wallet's
 * network with the WASM prover injected at the SDK's one proving seam — is
 * the default, and the rehearsal's doors plug into the same place. The
 * engine (`send.ts`), its tests, and the screen's states are the same code
 * either way.
 *
 * THE REHEARSAL STAYS REACHABLE, deliberately. Its reasoning holds: the
 * scenario picker turns the two states nobody can rehearse in
 * production — a long wait and an unknown outcome — into things a person
 * has seen before the day they are true. So the live screen carries a quiet
 * door to the pretend chain, and back.
 *
 * WHAT THE LIVE DOORS DIAL, named because naming hosts is this wallet's
 * habit: the indexer (sync, and the by-identifier question
 * the unknown middle watches with) and the network's node (submission).
 * That is ALL: key material is vendored to this wallet's OWN origin by
 * `npm run vendor-keys` and verified against pinned SHA-256s before any
 * proof (`key-material.ts`). The send screen says so before anything is
 * pressed.
 */

export interface SendWiring {
  /** The real thing: the network this wallet is built for, the WASM
   * prover, and that network's coins. Null only in tests that exercise the
   * rehearsal side alone. */
  readonly live: {
    readonly doorsFor: (identity: Identity, account: number) => SendDoors & { readonly stop?: () => Promise<void> };
    /** The network's terms, fetched from the indexer — shown once on this
     * screen, hash recorded, blocking nothing (a decision, built). */
    readonly fetchTerms: () => Promise<{ hash: string; url: string }>;
  } | null;
  /** The pretend chain, kept one quiet click away. */
  readonly rehearsalDoorsFor: (
    identity: Identity,
    account: number,
    scenario: RehearsalScenario
  ) => SendDoors & { readonly stop?: () => Promise<void> };
  /** The engine itself — injectable so screen tests can drive states. */
  readonly start: typeof startSend;
}

/**
 * Doors to the real chain for ONE account's paying wallet. The facade
 * starts on first use — which is the person's own deliberate press, the
 * same click-to-check rule the balance card holds — and one facade serves
 * every send until the screen is left.
 */
export function liveDoors(identity: Identity, account: number): SendDoors & { readonly stop: () => Promise<void> } {
  let running: Promise<WalletFacade> | null = null;
  const facade = (): Promise<WalletFacade> => {
    running ??= (async () => {
      /* The in-browser prover, injected at the SDK's one proving seam where
       * the rehearsal puts the simulator's (`proving.ts` says why it is ours). */
      const started = await facadeFor(identity, account, makeBrowserProvingService());
      await started.start(seedsFor(identity, account));
      return started;
    })();
    return running;
  };
  return {
    facade,
    /* The unshielded signer, derived per call. The keystore's own
     * `signDataAsync` IS the SDK's `SignSegment` shape. */
    signSegment: () => unshieldedKeystoreFor(identity, account).signDataAsync,
    ownUnshieldedHex: unshieldedKeystoreFor(identity, account).getAddress(),
    stop: async () => {
      if (!running) return;
      const f = await running.catch(() => null);
      running = null;
      await f?.stop().catch(() => {
        /* already stopping is fine */
      });
    }
  };
}

export const SendContext = createContext<SendWiring>({
  live: { doorsFor: liveDoors, fetchTerms: fetchNetworkTerms },
  rehearsalDoorsFor: (identity, account, scenario) => rehearsalDoors(identity, account, scenario),
  start: startSend
});

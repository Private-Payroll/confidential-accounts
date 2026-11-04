import { WAITS_FOR_THE_ROTATION, type RemoveSignerReach } from './remove-signer.js';

/**
 * **WHAT RUNS ONCE THE CHAIN HAS CARRIED A REMOVAL OUT**, for the removal action and the one approval alike
 * (`AfterRemovalCarried`, remove-signer.ts). It holds `WAITS_FOR_THE_ROTATION`: the wallet has no rotation of the vault
 * secrets to run after a removal, so both checks refuse every removal before anything is sent. The rotation replaces this
 * one value. It lives in its own file, not the registry, so a test reads the value the wallet runs with without loading
 * every action's chain code.
 */
export const AFTER_A_REMOVAL: Pick<RemoveSignerReach, 'afterCarried'> = Object.freeze({ afterCarried: WAITS_FOR_THE_ROTATION });

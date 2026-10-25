import type { Hex } from '../../../../src/core/crypto.js';
import type { SealedPool } from '../../../../src/midnight/vault-pool.js';
import type { SecretKeptHere } from '../../../../packages/web-shared/src/vault-operation.js';
import { openHere, sealHere, type SealedHere } from '../accounts/storage.js';

/** How a kept record is sealed and opened: under this wallet's own sealing key unless a test answers. */
export interface KeptSeal {
  seal(plain: string): Promise<SealedHere>;
  open(kept: SealedHere): Promise<string | null>;
}

const WALLET_SEAL: KeptSeal = Object.freeze({ seal: (plain: string) => sealHere(plain), open: (kept: SealedHere) => openHere(kept) });

/**
 * A NEW VAULT'S SECRET, KEPT IN THIS WALLET'S OWN STORE from before the
 * company's records are asked to file it until the vault has started. What is
 * kept is the record as it is filed (the secret sealed to each of its readers,
 * the person's own records key among them), sealed again under the key that
 * seals this wallet's secret, so the store holds nothing that opens without
 * this wallet. A secret the service did not file is then filed again from here
 * rather than made anew, and a vault whose chain commitment names it can
 * always be finished. A store or a seal that will not keep it refuses the filing.
 */
export function vaultSecretsKeptFor(
  person: string, store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage, seal: KeptSeal = WALLET_SEAL,
): SecretKeptHere {
  const at = (vault: Hex): string => `vault-secret:${person}:${String(vault).toLowerCase()}`;
  const notKept = (): Error => new Error('this wallet could not keep the vault\'s secret, so it was not filed.');
  return Object.freeze({
    keep: async (vault: Hex, filed: SealedPool) => {
      let sealed: SealedHere;
      try { sealed = await seal.seal(JSON.stringify(filed)); } catch { throw notKept(); }
      store.setItem(at(vault), JSON.stringify(sealed));
      if (store.getItem(at(vault)) === null) throw notKept();
    },
    held: async (vault: Hex) => {
      let raw: string | null;
      try { raw = store.getItem(at(vault)); } catch { raw = null; }
      if (raw === null) return null;
      try {
        const kept = JSON.parse(raw) as Partial<SealedHere>;
        if (typeof kept?.iv !== 'string' || typeof kept.sealed !== 'string') return null;
        const plain = await seal.open({ iv: kept.iv, sealed: kept.sealed });
        return plain === null ? null : JSON.parse(plain) as SealedPool;
      } catch { return null; }
    },
    drop: async (vault: Hex) => {
      try { store.removeItem(at(vault)); } catch { /* a secret left kept is dropped on the next start that reaches the end */ }
    },
  });
}

import type { Hex } from '../../../../src/core/crypto.js';
import type { SealedPool } from '../../../../src/midnight/vault-pool.js';
import type { RunKept, SecretKeptHere } from '../../../../packages/web-shared/src/vault-operation.js';
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
 *
 * Beside it, each secret run's public copies tree this signer raised or approved (`keepRun`), sealed the same way and
 * kept by vault and the commitment the run sets, so the vault's sealed copies can be written from this wallet whatever
 * the company's service holds. A later run of the same secret is kept beside an earlier one, never over it, so who
 * every run sealed the secret to stays known (`runsHeld`); `runHeld` gives the newest. It holds no secret: every copy
 * in it is sealed to its own reader.
 */
export function vaultSecretsKeptFor(
  person: string, store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage, seal: KeptSeal = WALLET_SEAL,
): SecretKeptHere {
  const at = (vault: Hex): string => `vault-secret:${person}:${String(vault).toLowerCase()}`;
  const notKept = (): Error => new Error('this wallet could not keep the vault\'s secret, so it was not filed.');
  const runKeyOf = (vault: Hex, commitment: Hex): string =>
    `vault-secret-run:${person}:${String(vault).toLowerCase()}:${String(commitment).toLowerCase()}`;
  /* Every run kept under one commitment, oldest first: a store written before runs were listed holds one. */
  const sealedRunsAt = (key: string): SealedHere[] => {
    let raw: string | null;
    try { raw = store.getItem(key); } catch { raw = null; } // a store that cannot be read holds no run here
    if (raw === null) return [];
    try {
      const kept = JSON.parse(raw) as unknown;
      const list = Array.isArray(kept) ? kept : [kept];
      return list.filter((k): k is SealedHere => typeof (k as Partial<SealedHere>)?.iv === 'string' && typeof (k as Partial<SealedHere>).sealed === 'string');
    } catch {
      return []; // what does not parse is no run this wallet kept
    }
  };
  const runsAt = async (key: string): Promise<RunKept[]> => {
    const out: RunKept[] = [];
    for (const k of sealedRunsAt(key)) {
      try {
        const plain = await seal.open(k);
        if (plain !== null) out.push(JSON.parse(plain) as RunKept);
      } catch {
        continue; // a run that does not open under this wallet's key is not one it kept
      }
    }
    return out;
  };
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
    keepRun: async (vault: Hex, run: RunKept) => {
      const key = runKeyOf(vault, run.commitment);
      const notKeptRun = (): Error => new Error('this wallet could not keep the run\'s sealed copies.');
      const kept = await runsAt(key);
      if (kept.some((k) => JSON.stringify(k) === JSON.stringify(run))) return;
      let sealed: SealedHere;
      try { sealed = await seal.seal(JSON.stringify(run)); } catch { throw notKeptRun(); }
      const before = sealedRunsAt(key);
      store.setItem(key, JSON.stringify([...before, sealed]));
      if (sealedRunsAt(key).length !== before.length + 1) throw notKeptRun();
    },
    runHeld: async (vault: Hex, commitment: Hex) => (await runsAt(runKeyOf(vault, commitment))).at(-1) ?? null,
    runsHeld: async (vault: Hex, commitment: Hex) => runsAt(runKeyOf(vault, commitment)),
    drop: async (vault: Hex) => {
      try { store.removeItem(at(vault)); } catch { /* a secret left kept is dropped on the next start that reaches the end */ }
    },
  });
}

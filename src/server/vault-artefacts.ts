import express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VAULT_CIRCUITS } from '../midnight/vault-contract.js';

/**
 * **THE PUBLIC MATERIAL A DEVICE PROVES A VAULT'S TRANSACTIONS WITH**, served
 * from this deployment's own build: each vault circuit's proving key,
 * verifying key and circuit; the network's own shielded-output circuit, which a
 * deposit also proves; and the public parameters those need.
 *
 * All of it is public by construction - it is what anybody proving these
 * circuits must hold - so it is served without a sign-in. What is refused is
 * any name that is not one of these files: nothing outside the three folders
 * named here can be reached, whatever is asked for.
 *
 *   /artefacts/vault/keys/<circuit>.prover|verifier
 *   /artefacts/vault/zkir/<circuit>.bzkir
 *   /artefacts/vault/params/bls_midnight_2p<k>
 *   /artefacts/vault/builtin/zswap/9/keys/<output|spend|sign>.prover|verifier
 *   /artefacts/vault/builtin/zswap/9/zkir/<output|spend|sign>.bzkir
 */
export const VAULT_ARTEFACT_PATH = '/artefacts/vault';

const BUILTIN = new Set(['output', 'spend', 'sign']);

export interface VaultArtefactPlaces {
  /** The compiled vault: `contracts/managed-vault`. */
  readonly compiled: string;
  /** The public parameters and the network's own circuits: `.midnight/params` unless a deployment says otherwise. */
  readonly params: string;
}

export const vaultArtefactPlaces = (root: string, env: NodeJS.ProcessEnv): VaultArtefactPlaces => ({
  compiled: resolve(root, 'contracts', 'managed-vault'),
  params: resolve(env.MIDNIGHT_PARAMS_DIR ?? join(root, '.midnight', 'params')),
});

/** The file a request names, or null for anything that is not one of the files above. */
export function vaultArtefactFile(places: VaultArtefactPlaces, path: string): string | null {
  const vault = /^\/(keys|zkir)\/([A-Za-z]+)\.(prover|verifier|bzkir)$/u.exec(path);
  if (vault) {
    const [, dir, circuit, ext] = vault;
    if (!(VAULT_CIRCUITS as readonly string[]).includes(circuit!)) return null;
    if ((dir === 'zkir') !== (ext === 'bzkir')) return null;
    return join(places.compiled, dir!, `${circuit}.${ext}`);
  }
  const params = /^\/params\/(bls_(?:midnight|filecoin)_2p\d{1,2})$/u.exec(path);
  if (params) return join(places.params, params[1]!);
  const builtin = /^\/builtin\/zswap\/9\/(keys|zkir)\/([a-z]+)\.(prover|verifier|bzkir)$/u.exec(path);
  if (builtin) {
    const [, dir, name, ext] = builtin;
    if (!BUILTIN.has(name!) || (dir === 'zkir') !== (ext === 'bzkir')) return null;
    return join(places.params, 'zswap', '9', `${name}.${ext}`);
  }
  return null;
}

export function vaultArtefactRoutes(places: VaultArtefactPlaces): express.Router {
  const r = express.Router();
  r.get(`${VAULT_ARTEFACT_PATH}/*path`, (req, res) => {
    const file = vaultArtefactFile(places, req.path.slice(VAULT_ARTEFACT_PATH.length));
    if (file === null || !existsSync(file)) {
      res.status(404).json({ error: 'there is no such proving material here.' });
      return;
    }
    res.setHeader('cache-control', 'public, max-age=3600');
    res.type('application/octet-stream');
    res.sendFile(file);
  });
  return r;
}

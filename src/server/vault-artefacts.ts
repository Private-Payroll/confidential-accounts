import express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE, VAULT_CIRCUITS } from '../midnight/vault-contract.js';
import { genuineParameterFiles, publishedByMidnight, type PublishedDigest } from './proving-parameters.js';

/**
 * **THE PUBLIC MATERIAL A DEVICE PROVES A VAULT'S TRANSACTIONS WITH**, served
 * from this deployment's own build: each vault circuit's proving key,
 * verifying key and circuit; the network's own shielded-output circuit, which a
 * deposit also proves; and the public parameters those need.
 *
 * All of it is public by construction - it is what anybody proving these
 * circuits must hold - so it is served without a sign-in. What is refused is
 * any name that is not one of these files: nothing outside the folders named
 * here can be reached, whatever is asked for.
 *
 * **THE COMPANY ACCOUNT'S CIRCUITS A DEVICE PROVES ARE SERVED TOO**
 * (`ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE`). A vault's payment out asks the
 * account's `recordPaymentFromVault`, and a change that moves no money asks its
 * `approveVaultChange`, inside the same transaction, so each is proved beside
 * the vault's own. And a signer's device proves the rounds it raises, approves
 * and carries out (`propose`, `approve`, `amendSigner`, `setThreshold`,
 * `adopt`), which open with the signer check and so can only be proved where
 * the signer's secret is. Those circuits, and no other of the account's, are
 * served.
 *
 *   /artefacts/vault/keys/<circuit>.prover|verifier
 *   /artefacts/vault/zkir/<circuit>.bzkir
 *   /artefacts/vault/params/bls_midnight_2p<k>   (only when it is the file Midnight publishes)
 *   /artefacts/vault/builtin/zswap/9/keys/<output|spend|sign>.prover|verifier
 *   /artefacts/vault/builtin/zswap/9/zkir/<output|spend|sign>.bzkir
 *   /artefacts/vault/account/keys/<an account circuit a device proves>.prover|verifier
 *   /artefacts/vault/account/zkir/<an account circuit a device proves>.bzkir
 */
export const VAULT_ARTEFACT_PATH = '/artefacts/vault';

const BUILTIN = new Set(['output', 'spend', 'sign']);


export interface VaultArtefactPlaces {
  /** The compiled vault: `contracts/managed-vault`. */
  readonly compiled: string;
  /** The public parameters and the network's own circuits: `.midnight/params` unless a deployment says otherwise. */
  readonly params: string;
  /** The compiled company account: `contracts/managed`. */
  readonly account: string;
}

export const vaultArtefactPlaces = (root: string, env: NodeJS.ProcessEnv): VaultArtefactPlaces => ({
  compiled: resolve(root, 'contracts', 'managed-vault'),
  params: resolve(env.MIDNIGHT_PARAMS_DIR ?? join(root, '.midnight', 'params')),
  account: resolve(root, 'contracts', 'managed'),
});

/**
 * Where a named file lives: the folder it is served from, and its path below
 * that folder. Every part of that path is fixed here or matched by a pattern
 * of letters and digits, so none of it can start with a dot or climb out.
 */
interface ArtefactLocation {
  readonly root: string;
  readonly below: string;
  /** Set for public parameters: the file name their published digest is listed under. */
  readonly parameters?: string;
}

function vaultArtefactLocation(places: VaultArtefactPlaces, path: string): ArtefactLocation | null {
  const vault = /^\/(keys|zkir)\/([A-Za-z]+)\.(prover|verifier|bzkir)$/u.exec(path);
  if (vault) {
    const [, dir, circuit, ext] = vault;
    if (!(VAULT_CIRCUITS as readonly string[]).includes(circuit!)) return null;
    if ((dir === 'zkir') !== (ext === 'bzkir')) return null;
    return { root: places.compiled, below: join(dir!, `${circuit}.${ext}`) };
  }
  const account = /^\/account\/(keys|zkir)\/([A-Za-z]+)\.(prover|verifier|bzkir)$/u.exec(path);
  if (account) {
    const [, dir, circuit, ext] = account;
    if (!ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE.includes(circuit!)) return null;
    if ((dir === 'zkir') !== (ext === 'bzkir')) return null;
    return { root: places.account, below: join(dir!, `${circuit}.${ext}`) };
  }
  const params = /^\/params\/(bls_(?:midnight|filecoin)_2p\d{1,2})$/u.exec(path);
  if (params) return { root: places.params, below: params[1]!, parameters: params[1]! };
  const builtin = /^\/builtin\/zswap\/9\/(keys|zkir)\/([a-z]+)\.(prover|verifier|bzkir)$/u.exec(path);
  if (builtin) {
    const [, dir, name, ext] = builtin;
    if (!BUILTIN.has(name!) || (dir === 'zkir') !== (ext === 'bzkir')) return null;
    return { root: places.params, below: join('zswap', '9', `${name}.${ext}`) };
  }
  return null;
}

/** The file a request names, or null for anything that is not one of the files above. */
export function vaultArtefactFile(places: VaultArtefactPlaces, path: string): string | null {
  const at = vaultArtefactLocation(places, path);
  return at === null ? null : join(at.root, at.below);
}

const NOTHING_HERE = { error: 'there is no such proving material here.' };

/**
 * **A REFUSAL IS NEVER KEPT.** A file missing now can be here a minute later -
 * this server fetches public parameters when it starts - so every refusal
 * tells a browser, and anything between, to ask again next time.
 */
const refuse = (res: express.Response): void => {
  res.setHeader('cache-control', 'no-store');
  res.status(404).json(NOTHING_HERE);
};

/**
 * **THE FILE IS HANDED TO THE SENDER AS A PATH BELOW ITS OWN FOLDER, NOT AS A
 * WHOLE PATH ON DISK.** Express's file sender treats any path with a part that
 * starts with a dot as hidden and answers 404 for it unless told otherwise, and
 * given a whole path it looks at every part - so every file under
 * `.midnight/params` was found here and then refused, and a checkout placed
 * anywhere under a dot-named folder would have had every file refused. Given
 * the folder as its root, the sender looks only at the part below it, which the
 * patterns above fix, and it still refuses anything that would climb out.
 *
 * **AND A PUBLIC PARAMETER FILE IS CHECKED BEFORE IT IS HANDED OUT.** It is
 * compared with the digest Midnight publishes for its name, once per version of
 * the file on disk; a file that differs, or a name nothing publishes a digest
 * for, gets the same answer as a file that is not here. What this cannot catch
 * is a file rewritten in place, not replaced, between that check and the send:
 * this server's own fetch always replaces, by rename.
 */
export function vaultArtefactRoutes(places: VaultArtefactPlaces, published: PublishedDigest = publishedByMidnight): express.Router {
  const genuine = genuineParameterFiles(published);
  const r = express.Router();
  r.get(`${VAULT_ARTEFACT_PATH}/*path`, async (req, res) => {
    const at = vaultArtefactLocation(places, req.path.slice(VAULT_ARTEFACT_PATH.length));
    const file = at === null ? null : join(at.root, at.below);
    if (at === null || file === null || !existsSync(file)
      || (at.parameters !== undefined && !(await genuine(file, at.parameters)))) {
      refuse(res);
      return;
    }
    res.type('application/octet-stream');
    /*
     * **A REFUSAL IS NEVER LEFT CARRYING THE HOUR.** The header rides on the
     * send, so a file that cannot be found or read never gets it, and whatever
     * refusal a failed send turns into says it must not be kept. Set on the
     * response before the send, as it once was, it stayed on the refusal, and
     * a browser went on replaying that refusal from its own cache for the hour
     * the header allowed, without asking here again - after the file was being
     * served.
     */
    res.sendFile(at.below, { root: at.root, headers: { 'cache-control': 'public, max-age=3600' } }, (err) => {
      if (err && !res.headersSent) refuse(res);
    });
  });
  return r;
}

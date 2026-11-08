import type { Hex } from '../../../src/core/crypto.js';
import { NonceSecretUnreadable, openNonceSecrets, recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { ownCopyOpened } from '../../../src/midnight/sealed-secret-copy.js';
import type { PoolDoors } from './vault-doors.js';
import { versionsAsFiledOf } from './http-sealed-pool-store.js';
import type { FiledPoolVersion, PassedOverVersion } from '../../../src/midnight/vault-pool.js';
import type { NoteOnTheWire } from './vault-builder.js';
import type { VaultBuilderClient } from './vault-worker-client.js';

type StepOnTheWire = Parameters<VaultBuilderClient['stepKept']>[0]['step'];

/** What reading the vault's secret to spend with needs: this signer, the company's records and the vault's own checks. */
type SpendDoors = Pick<PoolDoors, 'me' | 'records'> & {
  readonly builder: Pick<VaultBuilderClient, 'secretIsTheVaults' | 'ownChainCopy'>;
};

/**
 * Every secret the company's records hold for the vault, oldest first; none when they hold none or this device cannot
 * open the newest. A records read that fails is thrown: it is never answered as nothing filed.
 */
export async function recordSecretsOf(doors: Pick<PoolDoors, 'me' | 'records'>, vault: Hex): Promise<Hex[]> {
  const filed = await doors.records('nonce-secret').get(vault);
  if (filed === null) return [];
  try {
    return openNonceSecrets(filed, vault, recordsKeypairFrom(doors.me.companyKey)).secrets.map((s) => String(s).toLowerCase() as Hex);
  } catch (e) {
    /* Not opened here: what follows tries this signer's own copy on the chain, and refuses, naming why, without one. */
    if (e instanceof NonceSecretUnreadable) return [];
    throw e;
  }
}

/**
 * The secrets of every version of the vault's secret the records have filed, newest version first and each one's
 * newest secret first, after the newest record's own: a version filed over the one the vault holds hides no secret
 * from a payment. Read only; nothing is filed again. A version that does not open here gives none.
 */
async function everyFiledSecretOf(doors: Pick<PoolDoors, 'me' | 'records'>, vault: Hex): Promise<Hex[]> {
  const all = (await recordSecretsOf(doors, vault)).reverse();
  let versions: readonly (FiledPoolVersion | PassedOverVersion)[] = [];
  try {
    versions = await versionsAsFiledOf(doors.records('nonce-secret'), vault);
  } catch {
    /* Versions that cannot be listed add no secret: the newest record's are still tried, then the chain's own copy. */
    versions = [];
  }
  const opener = recordsKeypairFrom(doors.me.companyKey);
  for (const v of [...versions].reverse()) {
    if (v.neverEntered === true) continue;
    try {
      for (const s of [...openNonceSecrets(v.sealed, vault, opener).secrets].reverse()) {
        const secret = String(s).toLowerCase() as Hex;
        if (!all.includes(secret)) all.push(secret);
      }
    } catch {
      /* A version this device cannot open names no secret here. */
      continue;
    }
  }
  return all;
}

/**
 * **THIS SIGNER'S OWN COPY OF THE VAULT'S SECRET, FROM THE CHAIN**, opened here with this signer's records key, under
 * the commitment `of` names (the one the vault holds now, or the one whose copies were last all written). Answers the
 * commitment looked under, and the secret, or null when the chain holds no copy sealed to this signer there or it does
 * not open. A secret read here is used only once the vault's own check says it is the one it names.
 */
export async function ownChainSecret(
  doors: SpendDoors, vault: Hex, state: string, of: 'commitment' | 'copies-written',
): Promise<{ readonly commitment: Hex | null; readonly secret: Hex | null }> {
  if (doors.builder.ownChainCopy === undefined) return { commitment: null, secret: null };
  const reader = recordsKeypairFrom(doors.me.companyKey).publicKey;
  const copy = await doors.builder.ownChainCopy({ vault, state, reader, of });
  const commitment = copy.commitment === null ? null : String(copy.commitment).toLowerCase() as Hex;
  /* A copy that does not open here names no secret: the caller goes on as if the chain held none for this signer. */
  return { commitment, secret: copy.parts === null ? null : ownCopyOpened(doors.me.companyKey, vault, [{ reader, parts: copy.parts }]) };
}

const NO_SECRET_HERE = 'the company\'s records hold no nonce secret for this vault, so nothing is built from one. File it '
  + 'first: creating the vault again does.';

const COPIES_STILL_OWED = 'this vault\'s new secret is set on the chain and its signers\' sealed copies of it are still being '
  + 'written, and the vault pays nothing until they are. Nothing was sent. Finishing the vault\'s secret change on any '
  + 'signer\'s device writes them; then pay again.';

const NOT_YET_FILED = 'neither the company\'s records nor a copy on the chain sealed to your key holds the secret this vault '
  + 'holds now, so nothing was built from it. Nothing was sent. A signer whose copy is on the chain can pay now; you can '
  + 'once the company\'s records hold the vault\'s new secret.';

/**
 * **THE SECRET A STEP OUT OF THE VAULT IS BUILT WITH**: the one the vault holds now, by the vault's own check over
 * `state`. The records' secrets are tried newest first, every one of them, so a secret change the records show and the
 * chain does not yet (or the other way round) stops no payment, and then every earlier version's (none is filed
 * again); then this signer's own copy on the chain, which holds the new secret before the records do. Refuses, naming what clears it, when none is the vault's.
 */
export async function theSecretToSpend(doors: SpendDoors, vault: Hex, state: string): Promise<Hex> {
  const isTheVaults = (secret: Hex) => doors.builder.secretIsTheVaults({ vault, state, secret });
  for (const secret of await everyFiledSecretOf(doors, vault)) if (await isTheVaults(secret)) return secret;
  const own = await ownChainSecret(doors, vault, state, 'commitment');
  if (own.secret !== null && await isTheVaults(own.secret)) return own.secret;
  const written = own.commitment === null ? null : (await ownChainSecret(doors, vault, state, 'copies-written')).commitment;
  throw new Error(own.commitment !== null && written !== own.commitment ? COPIES_STILL_OWED : NOT_YET_FILED);
}

/**
 * **EVERY SECRET A STEP OF THIS VAULT MAY HAVE BEEN BUILT WITH**: the same secrets a step is built with, every filed
 * version's, newest first (`theSecretToSpend` reads them too), and with `state`
 * this signer's own copy on the chain. Throws, as reading the records' secret back always has, when there is none.
 */
export async function secretsToTry(doors: SpendDoors, vault: Hex, state?: string): Promise<Hex[]> {
  const all = await everyFiledSecretOf(doors, vault);
  const own = state === undefined ? null : (await ownChainSecret(doors, vault, state, 'commitment').catch(() => {
    /* A copy that cannot be read is no secret to try: the records' secrets are still tried. */
    return { secret: null };
  })).secret;
  if (own !== null && !all.includes(own)) all.push(own);
  if (all.length === 0) throw new Error(NO_SECRET_HERE);
  return all;
}

/**
 * **THE COIN A STEP KEPT, UNDER WHICHEVER OF `secrets` MADE ONE THE CHAIN HOLDS**: the vault names every coin a step
 * makes with the secret it held then, so a step made before or after a secret change is found under its own. Null
 * when none does; a secret no step could be made with proves nothing.
 */
export async function keptOnTheChainUnder(
  doors: { readonly builder: Pick<VaultBuilderClient, 'stepKept' | 'commitments'> }, vault: Hex, secrets: readonly Hex[],
  step: StepOnTheWire, onChain: ReadonlySet<string>,
): Promise<{ readonly kept: NoteOnTheWire; readonly output: string } | null> {
  for (const secret of secrets) {
    let kept: NoteOnTheWire | null;
    try {
      kept = await doors.builder.stepKept({ vault, secret, step });
    } catch {
      /* A line no step could have made under this secret proves nothing about this payment. */
      continue;
    }
    if (kept === null) continue;
    const { held, output } = await doors.builder.commitments({ vault, coin: kept });
    if (onChain.has(String(held).toLowerCase())) return { kept, output };
  }
  return null;
}

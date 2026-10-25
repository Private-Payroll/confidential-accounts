/**
 * **A COMPANY FOUNDED AS THE WALLET FOUNDS IT, FOR A PAGE'S TEST**: the answer
 * a wallet gives a keyring ask that starts a company, made from the same parts
 * the wallet's own code uses (`apps/wallet/src/keyring/found-company.ts`, whose
 * own tests run that code): the founding seat from the wallet's words for the
 * label it drew, the founding signed with it, and the seat and the founding
 * written into the saved keys handed in, sealed again under the wallet's key for
 * the person, one write on. Saved keys that do not open with the wallet's key
 * are refused, with the code `keys-did-not-open`, as the wallet refuses them. A
 * page's tests use it to answer as a wallet would without carrying the wallet's
 * screens.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import type { Identity } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import {
  keyringHolderFor, keyringKeyFor, keyringReleaseFor, withTheFounding, withTheKeysRead, type KeyringRelease,
} from 'midnight-identity/profile/unlock';
import { keyringSealKeyFor } from '../../apps/wallet/src/keyring/seal-key.js';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { signingPublicKeyOf, toHex, type Hex } from '../core/crypto.js';
import { foundTheCompanyHere } from '../core/company-founding.js';
import { seatBlinding } from '../core/seat-opening.js';
import { storedSignerLeaf } from '../core/signer-leaf.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import {
  counterOf, metadataOf, openKeyring, sealKeyring, seatsOf, tidiedWith, servedKeysOpenedFrom, withCreation, withNewSeat,
  type Keyring, type SavedCreation, type ServedKeys,
} from '../../packages/web-shared/src/keyring-blob.js';

/** The answer to a keyring ask that starts a company, as the wallet gives it. `holds` is the wallet's own address check. */
export function foundedAsTheWalletAnswers(
  identity: Identity, ask: KeyringRequest, holds: (address: string) => boolean, now = Date.now(), draw?: () => CompanyLabel,
): KeyringRelease {
  const released = draw === undefined ? keyringReleaseFor(identity, ask, now, holds) : keyringReleaseFor(identity, ask, now, holds, draw);
  const label = released.company as CompanyLabel;
  const words = seatKeysFor(identity, label, 0);
  const [signingSecret, wrappingSecret, salt] = [words.signingSecret, words.wrappingSecret, words.salt].map((k) => toHex(k).toLowerCase() as Hex);
  const walletKey = { tag: 'schnorr' as const, value: String(committeeKeyFor(identity, label).value).toLowerCase() as Hex };
  const blinding = String(seatBlinding(walletKey, salt!)).toLowerCase() as Hex;
  const scope = MidnightCommitments.allVaults().toLowerCase() as Hex;
  const leaf = storedSignerLeaf({ signingSecret: signingSecret!, blinding, scope }, MidnightCommitments).toLowerCase() as Hex;
  const founding = ask.founding!;
  const founded = foundTheCompanyHere({
    name: founding.name, signer: founding.signer, userId: ask.person, label,
    seat: { signingPublicKey: signingPublicKeyOf(signingSecret!), wrappingPublicKey: toHex(x25519.getPublicKey(words.wrappingSecret)) as Hex, leaf },
    signingSecret: signingSecret!,
  });
  const accountId = founded.account.id;
  const key = toHex(keyringSealKeyFor(identity, ask)) as Hex;
  const handedIn = ask.keyring!;
  let held: Keyring;
  try {
    held = handedIn.sealed === null ? { accounts: {} } : openedAsTheWalletOpens(identity, ask, handedIn.sealed);
  } catch {
    /* As the wallet refuses saved keys that do not open with its key for the person: it founds nothing and shows why. */
    throw Object.assign(new Error('the saved keys the page handed this wallet did not open with this wallet\'s key for you.'), { code: 'keys-did-not-open' });
  }
  const creation = {
    accountId, person: ask.person, label, foundingKey: walletKey,
    request: { name: founding.name, signers: [founding.signer], threshold: 1, companyLabel: label, foundingKey: walletKey, founding: founded },
    made: false, deploy: null, signed: null, recorded: false,
  } as SavedCreation;
  const next = withCreation(withNewSeat(held, accountId, {
    signerId: founded.seat.signerId, signingSecret: signingSecret!, wrappingSecret: wrappingSecret!, blinding, scope,
    opening: { publicKey: MidnightCommitments.signerPublicKey(signingSecret!).toLowerCase() as Hex, scope, blinding, walletKey, salt: salt! },
  }), creation);
  const { sealed } = sealKeyring({ ...next, counter: counterOf(held) }, key);
  const read = readAsTheWalletDoes(identity, ask, next, [{
    accountId, inboxPublicKey: String(founded.account.inboxPublicKey), wrappedKeys: founded.account.wrappedKeys as never,
  }]);
  return withTheKeysRead(
    withTheFounding(released, { founded, sealed: { iv: sealed.iv, tag: sealed.tag, body: sealed.body }, ifVersion: handedIn.version }),
    { ...read, resealed: null },
  );
}

/**
 * Saved keys opened as the wallet opens them (`apps/wallet/src/keyring/held-keyring.ts`): under the key no page had,
 * or a copy sealed before it under the old key. Throws when neither opens them. (No device mark is modelled here.)
 */
export function openedAsTheWalletOpens(identity: Identity, ask: Pick<KeyringRequest, 'requester' | 'person'>, sealed: unknown): Keyring {
  try { return openKeyring(sealed as never, toHex(keyringSealKeyFor(identity, ask))); } catch {
    return openKeyring(sealed as never, toHex(keyringKeyFor(identity, ask)));
  }
}

/** The key saved keys are sealed under now, as the wallet derives it: for a test to read what was kept. */
export const savedKeysSealKey = (identity: Identity, ask: Pick<KeyringRequest, 'requester' | 'person'>): Hex =>
  toHex(keyringSealKeyFor(identity, ask)) as Hex;

/** What the wallet reads from saved keys for a page (`apps/wallet/src/keyring/read-for-the-page.ts`): nothing secret. */
export function readAsTheWalletDoes(identity: Identity, ask: KeyringRequest, k: Keyring, extra: readonly ServedKeys[] = []) {
  return {
    seats: seatsOf(k),
    viewing: servedKeysOpenedFrom(k, [...(ask.served ?? []), ...extra]),
    metadata: metadataOf(k) as unknown as Readonly<Record<string, unknown>>,
    holder: keyringHolderFor(identity, ask),
  };
}

/**
 * **A KEYRING ASK ANSWERED AS THE PERSON'S WALLET ANSWERS IT** (`apps/wallet/src/screens/approve.tsx`, `releaseKeyring`):
 * the release, and when the ask handed saved keys in, what the wallet read from them, with the creation changes it was
 * asked for made and sealed again. Saved keys that do not open are refused as the wallet refuses them.
 */
export function keyringAsTheWalletAnswers(
  identity: Identity, ask: KeyringRequest, holds: (address: string) => boolean, now = Date.now(),
): KeyringRelease {
  const released = keyringReleaseFor(identity, ask, now, holds);
  if (ask.keyring === undefined) return released;
  const key = toHex(keyringSealKeyFor(identity, ask)) as Hex;
  let held: Keyring;
  let underTheOldKey = false;
  try {
    if (ask.keyring.sealed === null) held = { accounts: {} };
    else {
      try { held = openKeyring(ask.keyring.sealed as never, key); } catch {
        held = openKeyring(ask.keyring.sealed as never, toHex(keyringKeyFor(identity, ask)));
        underTheOldKey = true;
      }
    }
  } catch {
    throw Object.assign(new Error('the saved keys the page handed this wallet did not open with this wallet\'s key for you.'), { code: 'keys-did-not-open' });
  }
  const after = tidiedWith(held, ask.tidy ?? []);
  const resealed = after === held && !underTheOldKey ? null : (() => {
    const { sealed } = sealKeyring({ ...after, counter: counterOf(held) }, key);
    return { sealed: { iv: sealed.iv, tag: sealed.tag, body: sealed.body }, ifVersion: ask.keyring!.version };
  })();
  return withTheKeysRead(released, { ...readAsTheWalletDoes(identity, ask, after), resealed });
}

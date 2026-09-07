// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { newSecret } from 'midnight-identity';
import { fingerprintOf } from 'midnight-identity/recovery/pieces';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import {
  forgetEverything, saveWalletName, walletNameOf, walletNameOnRecord,
} from './storage.js';
import { ORIGINAL_SLOT, forgetOpenWallet, openWallet } from './wallets-held.js';

/*
 * THE NAME OF THE WHOLE WALLET, UNDER THE ONE ATTACK THAT MATTERS.
 *
 * The story, told about a name rather than a piece map: a browser held
 * wallet B, holds wallet A now, and the record left behind names B. Over a
 * SUBWALLET that is a wrong label on one slot; over the WHOLE wallet it is a
 * person reading somebody else's name above their money and every account
 * inside it inheriting the mistake. So the required answer for a foreign
 * record is null, everywhere the answer can be checked.
 *
 * AND THE ONE PLACE IT CANNOT BE CHECKED IS PINNED SEPARATELY. The locked
 * screen has no secret — that is what "locked" means — so it reads
 * `walletNameOnRecord`, which does not check. That reader is only honest
 * because every path that seals a keyring settles this record in the same
 * turn (`session.tsx`, `settleWalletName`); the last block below states that
 * contract as a test of the writer, so a landing that stops calling it is a
 * red test rather than a name over the wrong wallet.
 *
 * MODELLED ON `storage.test.ts`'s block, including its last assertion:
 * if `fingerprintOf` ever collapsed to a constant, writer and reader would
 * agree and this whole file would be green and wrong.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const WALLET_NAME_KEY = 'midnight-identity:wallet-name';

beforeEach(() => {
  localStorage.clear();
  /* Which compartment is open is per WINDOW, so it is module state and
   * it outlives a test. Every test here starts with nothing open. */
  forgetOpenWallet();
});

describe('the wallet name is stored against the secret', () => {
  it('round-trips for the secret it was written for', () => {
    const secret = newSecret();
    saveWalletName(secret, 'Rent money');
    expect(walletNameOf(secret)).toBe('Rent money');
  });

  it('IS NULL FOR A DIFFERENT WALLET — the record must not dress the new one', () => {
    const b = newSecret();
    saveWalletName(b, 'Company');
    const a = newSecret();
    expect(walletNameOf(a)).toBeNull();
    /* And the record itself is untouched: this is a refusal to READ it as A's,
     * not a repair of what is on disk. */
    expect(localStorage.getItem(WALLET_NAME_KEY)).not.toBeNull();
    expect(walletNameOf(b)).toBe('Company');
  });

  it('is null for a record with a stripped or forged fingerprint', () => {
    const secret = newSecret();
    saveWalletName(secret, 'Rent money');
    const record = JSON.parse(localStorage.getItem(WALLET_NAME_KEY) as string) as
      Record<string, unknown>;

    const stripped = { ...record };
    delete stripped['fingerprint'];
    localStorage.setItem(WALLET_NAME_KEY, JSON.stringify(stripped));
    expect(walletNameOf(secret)).toBeNull();

    localStorage.setItem(WALLET_NAME_KEY, JSON.stringify({
      ...record, fingerprint: toBase64Url(fingerprintOf(newSecret())),
    }));
    expect(walletNameOf(secret)).toBeNull();
  });

  it('is null for damage rather than throwing — a label is not a gate', () => {
    const secret = newSecret();
    for (const damaged of ['not json', '[]', '{}', '{"fingerprint":"x"}', 'null']) {
      localStorage.setItem(WALLET_NAME_KEY, damaged);
      expect(walletNameOf(secret), damaged).toBeNull();
      expect(walletNameOnRecord(ORIGINAL_SLOT), damaged).toBeNull();
    }
  });

  it('reader and writer do not share a blind spot', () => {
    /* If `fingerprintOf` collapsed to a constant, writer and reader would
     * agree and every refusal above would be green and wrong. */
    expect(toBase64Url(fingerprintOf(newSecret())))
      .not.toBe(toBase64Url(fingerprintOf(newSecret())));
  });
});

describe('an unnamed wallet is a supported state, not a hole', () => {
  it('no record reads as no name', () => {
    expect(walletNameOf(newSecret())).toBeNull();
    expect(walletNameOnRecord(ORIGINAL_SLOT)).toBeNull();
  });

  it('an empty or blank name REMOVES the record', () => {
    const secret = newSecret();
    saveWalletName(secret, 'Rent money');
    saveWalletName(secret, '   ');
    expect(localStorage.getItem(WALLET_NAME_KEY)).toBeNull();
    expect(walletNameOf(secret)).toBeNull();
  });

  it('surrounding space is not part of the name', () => {
    const secret = newSecret();
    saveWalletName(secret, '  Company  ');
    expect(walletNameOf(secret)).toBe('Company');
  });

  it('forgetting everything forgets the name too', () => {
    const secret = newSecret();
    saveWalletName(secret, 'Rent money');
    forgetEverything(ORIGINAL_SLOT);
    expect(localStorage.getItem(WALLET_NAME_KEY)).toBeNull();
    expect(walletNameOf(secret)).toBeNull();
  });
});

describe('the unchecked reader, and the writer contract it rests on', () => {
  it('walletNameOnRecord reads the record WITHOUT the fingerprint check — by design', () => {
    const b = newSecret();
    saveWalletName(b, 'Company');
    /* It answers for a record it cannot attribute. That is the point of it —
     * the locked screen has no secret — and it is why it may never decide
     * anything. `walletNameOf` is the authority and refuses the same record. */
    expect(walletNameOnRecord(ORIGINAL_SLOT)).toBe('Company');
    expect(walletNameOf(newSecret())).toBeNull();
  });

  /*
   * THE OLD SINGLE TEST HERE IS SPLIT IN TWO, BECAUSE THE OLD ONE ASSERTED
   * SOMETHING THIS CHANGE MAKES FALSE.
   *
   * It read: a landing leaves NOTHING of the previous wallet — one record, and
   * the last landing owns it. That was the contract while one browser held one
   * wallet. **A landing now lands BESIDE**, so the previous wallet's name is
   * not cleared; it is a different record and it must survive untouched. The
   * clearing half of the contract is still real and still needs pinning: it
   * applies inside ONE compartment, which is where `startFresh` lands.
   */
  it('A LANDING SETTLES ITS OWN COMPARTMENT AND LEAVES THE OTHER WALLET ALONE', () => {
    /* Two compartments, one window at a time — which is what `openWallet` is
     * and all this test needs; the LANDING that allocates a compartment seals
     * a secret, so it is pinned in `storage.test.ts` where IndexedDB exists. */
    openWallet('wallet-b');
    const b = newSecret();
    saveWalletName(b, 'Company');

    openWallet('wallet-a');
    const a = newSecret();
    saveWalletName(a, 'Rent money');
    /* The compartment is NAMED — a change took the default away, and in a test
     * about two compartments a defaulted reader was the ambiguity being
     * pinned. */
    expect(walletNameOnRecord('wallet-a')).toBe('Rent money');
    expect(walletNameOf(a)).toBe('Rent money');

    /* And B's record is exactly what it was. */
    openWallet('wallet-b');
    expect(walletNameOnRecord('wallet-b')).toBe('Company');
    expect(walletNameOf(b)).toBe('Company');

    /* And neither wallet's name is readable with the other's secret, which is
     * the first half — now true for a second reason as well as the first. */
    expect(walletNameOf(a)).toBeNull();
  });
});

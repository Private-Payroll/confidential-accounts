import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromSecret, identityFromWords, newSecret } from '../keys/derivation.js';
import { AddressError, addressFor, payeeAddress } from './address.js';
import { AddressShapeError, checkShieldedAddress } from './address-shape.js';
import { NETWORKS, type NetworkName } from './network.js';

/**
 * **THE MIRROR IS HELD AGAINST THE ORIGINAL, NOT AGAINST ITS OWN COMMENT.**
 *
 * `address-shape.ts` exists so the payroll page can check a receiving address
 * before it seals one, without loading the ledger. **A second reader of
 * the platform's encoding is a second thing that can be wrong**, and the only
 * defence worth having is running both over the same inputs and requiring them
 * to agree — the same accept, the same refusal code, the same two halves.
 *
 * This suite lives in the WALLET because this is the side that may load the
 * ledger. If the platform's encoding ever moves, it goes red here rather than a
 * wrong address going out in a page over there.
 */

const ours = identityFromWords(TEST_MNEMONIC);

/** What the real decoder says, as a comparable value. */
const real = (bech32: string, network: NetworkName):
{ ok: true; coin: string; enc: string; canonical: string } | { ok: false; code: string } => {
  try {
    const a = payeeAddress(bech32, network);
    return { ok: true, coin: a.coinPublicKey, enc: a.encryptionPublicKey, canonical: a.bech32 };
  } catch (e) {
    return { ok: false, code: (e as AddressError).code };
  }
};

/** What the WebAssembly-free mirror says, in the same shape. */
const mirror = (bech32: string, network: NetworkName):
{ ok: true; coin: string; enc: string; canonical: string } | { ok: false; code: string } => {
  try {
    const a = checkShieldedAddress(bech32, network);
    return { ok: true, coin: a.coinPublicKey, enc: a.encryptionPublicKey, canonical: a.bech32 };
  } catch (e) {
    return { ok: false, code: (e as AddressShapeError).code };
  }
};

describe('the address check that carries no WebAssembly', () => {
  it('AGREES WITH THE PLATFORM ON EVERY NETWORK, INCLUDING MAINNET', () => {
    /*
     * Mainnet is the case a mirror gets wrong: the platform writes it with NO
     * network segment at all, so a reader that expects one either refuses every
     * mainnet address or accepts every other network's as mainnet.
     */
    for (const net of NETWORKS) {
      const made = addressFor(ours.money.zswap, net);
      expect(mirror(made.bech32, net)).toEqual(real(made.bech32, net));
      expect(mirror(made.bech32, net)).toMatchObject({ ok: true, canonical: made.bech32 });
    }
  });

  it('AGREES ON THE TWO HALVES, WHICH IS WHERE A WRONG SPLIT WOULD HIDE', () => {
    /*
     * A mirror that split the bytes at the wrong index produces an address that
     * decodes, compares, and pays the ENCRYPTION key as if it were the coin
     * key — a silent failure, arriving through a helper. Sixty distinct
     * wallets, both halves, both readers.
     */
    let checked = 0;
    for (let i = 0; i < 60; i += 1) {
      const made = addressFor(identityFromSecret(newSecret()).money.zswap, 'stagenet');
      const a = checkShieldedAddress(made.bech32, 'stagenet');
      expect(a.coinPublicKey).toBe(made.coinPublicKey);
      expect(a.encryptionPublicKey).toBe(made.encryptionPublicKey);
      expect(a.coinPublicKey).not.toBe(a.encryptionPublicKey);
      checked += 1;
    }
    expect(checked).toBe(60);
  });

  it('REFUSES A SINGLE MISTYPED CHARACTER, BECAUSE IT IS THE PLATFORM\'S OWN CHECKSUM', () => {
    const made = addressFor(ours.money.zswap, 'stagenet').bech32;
    let refused = 0;
    for (let i = made.length - 40; i < made.length; i += 1) {
      const c = made[i] as string;
      const typo = made.slice(0, i) + (c === 'q' ? 'p' : 'q') + made.slice(i + 1);
      expect(mirror(typo, 'stagenet')).toEqual(real(typo, 'stagenet'));
      expect(mirror(typo, 'stagenet')).toMatchObject({ ok: false });
      refused += 1;
    }
    expect(refused).toBe(40);
  });

  it('REFUSES A PREVIEW ADDRESS HANDED TO A STAGENET COMPANY, BY NAME', () => {
    /* The design §7 names this case. It is the one that is not a typo and not a
     * paste of the wrong kind of thing — it is a real address of the right
     * shape for the wrong chain, and money sent to it is gone. */
    const preview = addressFor(ours.money.zswap, 'preview').bech32;
    expect(() => checkShieldedAddress(preview, 'stagenet')).toThrow(AddressShapeError);
    try {
      checkShieldedAddress(preview, 'stagenet');
    } catch (e) {
      expect((e as AddressShapeError).code).toBe('wrong-network');
      expect((e as Error).message).toContain('stagenet');
    }
    expect(mirror(preview, 'stagenet')).toEqual(real(preview, 'stagenet'));
  });

  it('REFUSES AN UNSHIELDED ADDRESS OF THE SAME WALLET AS THE WRONG KIND', () => {
    /*
     * The substitution that matters and the one a wired-up-wrong producer
     * makes: both are addresses of one subwallet and both look right.
     */
    const unshielded = 'mn_addr_stagenet1'
      + addressFor(ours.money.zswap, 'stagenet').bech32.split('1').slice(1).join('1');
    expect(mirror(unshielded, 'stagenet')).toMatchObject({ ok: false });
    expect(mirror(unshielded, 'stagenet')).toEqual(real(unshielded, 'stagenet'));
  });

  it('AGREES ON EVERY KIND OF RUBBISH, INCLUDING THE EMPTY ONE', () => {
    const junk = [
      '', '   ', '\n', 'hello', 'mn_shield-addr_stagenet1', '0x' + '0'.repeat(64),
      TEST_MNEMONIC, 'mn_shield-addr_stagenet1qqqqqqqq',
      addressFor(ours.money.zswap, 'stagenet').bech32.toUpperCase(),
    ];
    for (const value of junk) {
      expect(mirror(value, 'stagenet')).toEqual(real(value, 'stagenet'));
    }
  });

  it('TRIMS WHAT SOMEBODY PASTED, BECAUSE PEOPLE PASTE WITH WHITESPACE', () => {
    const made = addressFor(ours.money.zswap, 'stagenet').bech32;
    expect(checkShieldedAddress(`  ${made}\n`, 'stagenet').bech32).toBe(made);
  });

  it('REFUSES A NETWORK THIS WALLET DOES NOT KNOW AS THE CALLER\'S MISTAKE', () => {
    /* Not an `AddressShapeError`: the address is not what is wrong, and a
     * refusal that named it would send somebody looking at the wrong value. */
    const made = addressFor(ours.money.zswap, 'stagenet').bech32;
    expect(() => checkShieldedAddress(made, 'TESTNET' as NetworkName)).toThrow(/not a Midnight network/u);
  });
});

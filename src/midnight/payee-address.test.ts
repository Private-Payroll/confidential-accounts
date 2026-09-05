import { describe, it, expect } from 'vitest';
import {
  ShieldedCoinPublicKey, MidnightBech32m, DustAddress,
  ShieldedAddress, ShieldedEncryptionPublicKey,
} from '@midnightntwrk/wallet-sdk-address-format';
import {
  payeeAddress, payeeAddressFromKeys, samePayee, shortPayee, payeeOf, recipientOf,
  unshieldedPayeeAddress, unshieldedPayeeAddressFromKeys,
  type PayeeAddress,
} from './payee-address.js';

const COIN = 'aa'.repeat(32);
const ENC = 'bb'.repeat(32);
const OTHER_ENC = 'cc'.repeat(32);

const alice = () => payeeAddressFromKeys({ coinPublicKey: COIN, encryptionPublicKey: ENC }, 'preview');

describe('a payee is one value', () => {
  it('carries both keys, and they are the ones that went in', () => {
    const a = alice();
    expect(a.coinPublicKey).toBe(COIN);
    expect(a.encryptionPublicKey).toBe(ENC);
    expect(a.bech32).toMatch(/^mn_shield-addr_preview1/);
  });

  it('re-parses to exactly itself, so the halves always come from the string', () => {
    const a = alice();
    const again = payeeAddress(a.bech32, 'preview');
    expect(again.coinPublicKey).toBe(a.coinPublicKey);
    expect(again.encryptionPublicKey).toBe(a.encryptionPublicKey);
    expect(samePayee(a, again)).toBe(true);
  });

  /*
   * THE INVARIANT THIS TYPE EXISTS FOR — C7, V-80.
   *
   * Not "the halves happen to agree", but "there is no way to make them
   * disagree". A different encryption key is a different ADDRESS, so it is a
   * different payee, not the same payee read wrongly.
   */
  it('cannot be given one payee\'s coin key and another\'s reading key', () => {
    const a = payeeAddressFromKeys({ coinPublicKey: COIN, encryptionPublicKey: ENC }, 'preview');
    const b = payeeAddressFromKeys({ coinPublicKey: COIN, encryptionPublicKey: OTHER_ENC }, 'preview');
    expect(samePayee(a, b)).toBe(false);
    expect(a.bech32).not.toBe(b.bech32);
    /* And each still reads back its own pair — neither has borrowed the other's. */
    expect(payeeAddress(a.bech32, 'preview').encryptionPublicKey).toBe(ENC);
    expect(payeeAddress(b.bech32, 'preview').encryptionPublicKey).toBe(OTHER_ENC);
  });

  it('is frozen, so nothing can reach in and change one half afterwards', () => {
    const a = alice();
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as unknown as { encryptionPublicKey: string }).encryptionPublicKey = OTHER_ENC;
    }).toThrow();
    expect(a.encryptionPublicKey).toBe(ENC);
  });
});

describe('what it refuses', () => {
  it('a typo, because the checksum is the platform\'s and not ours', () => {
    const a = alice();
    const last = a.bech32.slice(-1);
    const typo = a.bech32.slice(0, -1) + (last === 'q' ? 'p' : 'q');
    expect(() => payeeAddress(typo, 'preview')).toThrow(/not a Midnight address/i);
  });

  it('a coin public key on its own — the half that cannot say who may read', () => {
    /*
     * Encoded through the CODEC rather than `MidnightBech32m.encode`, which
     * reads `[Bech32mSymbol]` off the INSTANCE — a property `ShieldedAddress`
     * sets on itself and `ShieldedCoinPublicKey` does not. Measured here, not
     * assumed: the generic helper throws "Cannot read properties of undefined".
     */
    const cpkOnly = ShieldedCoinPublicKey.codec
      .encode('preview', ShieldedCoinPublicKey.fromHexString(COIN)).asString();
    expect(cpkOnly).toMatch(/^mn_shield-cpk_preview1/);
    expect(() => payeeAddress(cpkOnly, 'preview')).toThrow(/shield-addr/);
  });

  it('an address for a different network, and it names both', () => {
    const a = alice();
    expect(() => payeeAddress(a.bech32, 'stagenet'))
      .toThrow(/stagenet[\s\S]*preview|preview[\s\S]*stagenet/);
  });

  it('nothing at all', () => {
    expect(() => payeeAddress('', 'preview')).toThrow(/required/);
    expect(() => payeeAddress('   ', 'preview')).toThrow(/required/);
  });

  it('AN ADDRESS WHOSE ENCRYPTION HALF IS THE WRONG WIDTH — `T-194`, `S58`', () => {
    /*
     * **THE SDK BUILDS THIS, ENCODES IT, AND DECODES IT BACK WITHOUT A WORD.**
     * `ShieldedCoinPublicKey`'s constructor throws if the coin half is not 32
     * bytes, so that half is safe by accident. The encryption half is
     * `bytes.subarray(32)` — everything remaining, any length — handed to a
     * constructor that only assigns. Measured here rather than argued: the
     * 33-byte address below round-trips through `MidnightBech32m` and comes
     * back as 66 hex characters.
     *
     * **UNTIL `S58` THIS PRODUCED A `PayeeAddress`**, frozen and returned, and
     * that value travelled to `additionalCoinEncPublicKeyMappings`
     * (`vault-ledger.ts`) unexamined. **What refused it was the ledger**, at
     * transaction-build time: `REPORT-PAYEE-KEY.txt` records `ZswapOutput.new`
     * throwing on every wrong width — *Not all bytes read, 1 bytes remaining*
     * at 33 bytes — so no money could reach a key nobody holds by this route.
     * **But that is after the run is raised, approved and open.** This refusal
     * is at the parse, where a person can still fix the address.
     */
    const wide = new ShieldedAddress(
      ShieldedCoinPublicKey.fromHexString(COIN),
      ShieldedEncryptionPublicKey.fromHexString('bb'.repeat(33)),
    );
    const bech32 = MidnightBech32m.encode('preview', wide).asString();

    /* The platform is happy with it, which is the whole reason this check is ours. */
    expect(MidnightBech32m.parse(bech32).decode(ShieldedAddress, 'preview')
      .encryptionPublicKey.toHexString()).toHaveLength(66);

    expect(() => payeeAddress(bech32, 'preview'))
      .toThrow(/encryption public key must be 32 bytes of lowercase hex/);
  });

  it('and a 31-byte encryption half, which the ledger refuses from the other side', () => {
    /* `REPORT-PAYEE-KEY.txt`: 31 bytes throws *failed to fill whole buffer*.
     * Both directions, because a guard written against one bound is half a
     * guard — `C286`'s shape. */
    const narrow = new ShieldedAddress(
      ShieldedCoinPublicKey.fromHexString(COIN),
      ShieldedEncryptionPublicKey.fromHexString('bb'.repeat(31)),
    );
    expect(() => payeeAddress(MidnightBech32m.encode('preview', narrow).asString(), 'preview'))
      .toThrow(/encryption public key must be 32 bytes of lowercase hex/);
  });

  /*
   * **THE POSITIVE CONTROL — WITHOUT IT THE TWO ABOVE PASS ON A PARSER THAT
   * REFUSES EVERY ADDRESS.** A correct 32-byte pair still parses.
   */
  it('and a correct pair is still accepted, unchanged', () => {
    const a = alice();
    const again = payeeAddress(a.bech32, 'preview');
    expect(again.encryptionPublicKey).toBe(ENC);
  });

  it('keys that are not 32 bytes of hex', () => {
    const from = (coinPublicKey: string, encryptionPublicKey: string) =>
      payeeAddressFromKeys({ coinPublicKey, encryptionPublicKey }, 'preview');
    expect(() => from('aa', ENC)).toThrow(/coin public key/);
    expect(() => from(COIN, 'nothex'.repeat(10))).toThrow(/encryption public key/);
    expect(() => from(COIN.toUpperCase(), ENC)).toThrow(/lowercase hex/);
  });
});

describe('networks', () => {
  /*
   * MAINNET IS THE SHAPE THAT BREAKS. Its segment is OMITTED from the string
   * rather than written out, so "mainnet" is the one network name that is not
   * in the address it belongs to. If our code ever passed a network id the
   * library did not recognise as mainnet, we would produce
   * `mn_shield-addr_mainnet1...` — a well-formed address for a network that
   * does not exist, which nothing downstream would question.
   */
  it('mainnet omits the segment and still round-trips', () => {
    const a = payeeAddressFromKeys({ coinPublicKey: COIN, encryptionPublicKey: ENC }, 'mainnet');
    expect(a.bech32).toMatch(/^mn_shield-addr1/);
    expect(a.bech32).not.toContain('mainnet');
    expect(payeeAddress(a.bech32, 'mainnet').coinPublicKey).toBe(COIN);
  });

  it('a mainnet address is refused on any other network', () => {
    const a = payeeAddressFromKeys({ coinPublicKey: COIN, encryptionPublicKey: ENC }, 'mainnet');
    expect(() => payeeAddress(a.bech32, 'preview')).toThrow();
  });

  it('every network we know produces an address that reads back', () => {
    for (const n of ['undeployed', 'preview', 'preprod', 'qanet', 'stagenet', 'testnet'] as const) {
      const a = payeeAddressFromKeys({ coinPublicKey: COIN, encryptionPublicKey: ENC }, n);
      expect(a.network).toBe(n);
      expect(payeeAddress(a.bech32, n).encryptionPublicKey).toBe(ENC);
    }
  });
});

describe('showing one to a person', () => {
  it('shows both ends, because a prefix confirms nothing', () => {
    const a = alice();
    const short = shortPayee(a);
    expect(short).toContain('…');
    expect(a.bech32.startsWith(short.split('…')[0])).toBe(true);
    expect(a.bech32.endsWith(short.split('…')[1])).toBe(true);
    /* Every address on one network shares this much; the tail is what differs. */
    expect(short.split('…')[0]).toContain('shield-addr');
  });
});

describe('the pair, over many payees', () => {
  it('never crosses between two people', () => {
    const people: PayeeAddress[] = [];
    for (let i = 0; i < 64; i++) {
      const c = i.toString(16).padStart(2, '0').repeat(32);
      const e = (255 - i).toString(16).padStart(2, '0').repeat(32);
      people.push(payeeAddressFromKeys({ coinPublicKey: c, encryptionPublicKey: e }, 'preview'));
    }
    for (const p of people) {
      const reparsed = payeeAddress(p.bech32, 'preview');
      expect(reparsed.coinPublicKey).toBe(p.coinPublicKey);
      expect(reparsed.encryptionPublicKey).toBe(p.encryptionPublicKey);
    }
    expect(new Set(people.map(p => p.bech32)).size).toBe(64);
  });
});

/* ------------------------------------------------------------------------
 * THE OTHER KEY SPACE. C245, C246, S6k.
 * ------------------------------------------------------------------------ */

const USER = 'dd'.repeat(32);
const bob = () => unshieldedPayeeAddressFromKeys({ userAddress: USER }, 'preview');

describe('a payee paid in public money', () => {
  it('carries one key, and it is the one that went in', () => {
    const b = bob();
    expect(b.kind).toBe('unshielded');
    expect(b.userAddress).toBe(USER);
    expect(b.bech32).toMatch(/^mn_addr_preview1/);
  });

  it('re-parses to exactly itself', () => {
    const b = bob();
    const again = unshieldedPayeeAddress(b.bech32, 'preview');
    expect(again.userAddress).toBe(b.userAddress);
    expect(samePayee(b, again)).toBe(true);
  });

  it('is frozen, like the shielded one', () => {
    const b = bob();
    expect(Object.isFrozen(b)).toBe(true);
    expect(() => { (b as unknown as { userAddress: string }).userAddress = COIN; }).toThrow();
  });
});

/**
 * **`C246` AT THE CLIENT, AND THIS IS THE FILE WHERE IT IS UNREPRESENTABLE
 * RATHER THAN DISCOURAGED.**
 *
 * A `ZswapCoinPublicKey` and a `UserAddress` are both `{ bytes: Bytes<32> }`
 * and belong to different key spaces. Nothing downstream of raw bytes can tell
 * them apart, and an unshielded send to an address in the wrong space removes
 * the money permanently — there is no unshielded burn address to distinguish a
 * mistake from an intention.
 *
 * **So the two are told apart HERE, by the platform's own codec, before any
 * bytes exist as a value this system will act on.** Every test below builds
 * both from the SAME 32 bytes, deliberately: a fixture that made them differ
 * would let these pass because the bytes did not match, which proves nothing.
 */
describe('C246: the two key spaces cannot be read as each other', () => {
  const SAME = '7e'.repeat(32);

  it('THE ONE THAT LOSES THE MONEY: a shielded address is not a public one', () => {
    const shielded = payeeAddressFromKeys(
      { coinPublicKey: SAME, encryptionPublicKey: ENC }, 'preview');
    expect(() => unshieldedPayeeAddress(shielded.bech32, 'preview'))
      .toThrow(/different key space|Expected type addr/i);
  });

  it('and the reverse: a public address is not a shielded one', () => {
    const publicPayee = unshieldedPayeeAddressFromKeys({ userAddress: SAME }, 'preview');
    expect(() => payeeAddress(publicPayee.bech32, 'preview'))
      .toThrow(/not a payee address|shield-addr/i);
  });

  it('the same 32 bytes make two DIFFERENT payees, and neither is the other', () => {
    const shielded = payeeAddressFromKeys(
      { coinPublicKey: SAME, encryptionPublicKey: ENC }, 'preview');
    const publicPayee = unshieldedPayeeAddressFromKeys({ userAddress: SAME }, 'preview');

    /* The bytes a circuit would receive ARE identical. That is the hazard. */
    expect(recipientOf(shielded)).toBe(recipientOf(publicPayee));
    /* And nothing else about them is. */
    expect(shielded.kind).not.toBe(publicPayee.kind);
    expect(samePayee(shielded, publicPayee)).toBe(false);
    expect(shielded.bech32).not.toBe(publicPayee.bech32);
  });

  it('the kind comes out of the DECODE and cannot be set', () => {
    const b = bob();
    expect(() => { (b as unknown as { kind: string }).kind = 'shielded'; }).toThrow();
    expect(unshieldedPayeeAddress(b.bech32, 'preview').kind).toBe('unshielded');
    expect(payeeAddress(alice().bech32, 'preview').kind).toBe('shielded');
  });
});

describe('one pasted string, the right kind out', () => {
  it('reads a shielded address as shielded, with both its keys', () => {
    const p = payeeOf(alice().bech32, 'preview');
    expect(p.kind).toBe('shielded');
    if (p.kind !== 'shielded') throw new Error('unreachable');
    expect(p.coinPublicKey).toBe(COIN);
    expect(p.encryptionPublicKey).toBe(ENC);
  });

  it('reads a public address as public', () => {
    const p = payeeOf(bob().bech32, 'preview');
    expect(p.kind).toBe('unshielded');
    if (p.kind !== 'unshielded') throw new Error('unreachable');
    expect(p.userAddress).toBe(USER);
  });

  /*
   * A third Midnight address type is not a payee at all, and the refusal has to
   * say so rather than falling through to whichever parse was tried last — a
   * dust address decoded as a user address would be 32 bytes nobody can spend.
   */
  it('refuses a Midnight address that is not a payee, naming both that are', () => {
    /*
     * A REAL third type with a VALID CHECKSUM, built by the platform's own
     * encoder — not a string with the prefix swapped, which fails the checksum
     * and never reaches the dispatch this test is about. `mn_dust_...` is a
     * dust address: 32 bytes that decode cleanly and that nobody can be paid at.
     */
    const dust = MidnightBech32m.encode('preview', new DustAddress(0x1234n)).asString();
    expect(dust).toMatch(/^mn_dust_preview1/);
    expect(() => payeeOf(dust, 'preview')).toThrow(/is not a payee/i);
    /* And it names the two that are, because the reader has to know what to ask for. */
    expect(() => payeeOf(dust, 'preview')).toThrow(/shield-addr/);
  });

  it('still refuses a typo, on either kind', () => {
    for (const a of [alice().bech32, bob().bech32]) {
      const last = a.slice(-1);
      expect(() => payeeOf(a.slice(0, -1) + (last === 'q' ? 'p' : 'q'), 'preview')).toThrow();
    }
  });

  it('and an address for another network, on either kind', () => {
    expect(() => payeeOf(bob().bech32, 'stagenet')).toThrow(/preview|stagenet/);
  });
});

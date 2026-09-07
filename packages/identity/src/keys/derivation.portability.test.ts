import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC, WalletSeeds } from '@midnight-ntwrk/testkit-js';
import { DustSecretKey, ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import {
  MidnightBech32m, ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey,
} from '@midnightntwrk/wallet-sdk-address-format';
import { HDKey } from '@scure/bip32';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  DerivationError, Purposes, SECRET_BYTES, identityFromSecret, identityFromWords,
  newSecret, secretFromWords, seedFromWords, wordsFromSecret,
} from './derivation.js';
import type { AuthorityKey, MoneyKey, Purpose } from './derivation.js';

/**
 * THE ONE TEST THAT DECIDES WHETHER ANY OF THE REST IS WORTH RUNNING.
 *
 * It takes the Midnight Foundation's OWN test phrase and derives a wallet twice
 * — once through this repository, once through their `testkit-js` — and asserts
 * the bytes are identical at every stage.
 *
 * WHY IT IS FIRST AND WHY IT HAS ITS OWN COMMAND FILE. A wallet derived even
 * slightly differently is not a broken wallet. It is a perfectly working wallet
 * in a place nothing else can reach: the same twenty-four words typed into any
 * other Midnight wallet would open an empty account, and the money would sit at
 * an address whose key exists nowhere but here. Nothing throws, nothing warns,
 * and the person finds out the day they need it.
 *
 * The mechanism that makes it silent is in the SDK and cannot be removed:
 * `HDWallet.fromSeed` accepts any seed from 16 to 64 bytes, so handing it the
 * 32-byte entropy instead of the 64-byte stretched seed is not an error. It is
 * a different wallet.
 *
 * The comparison is therefore against THEIR code and not against a recorded
 * value of our own. A fixture we wrote down would only prove we are consistent
 * with ourselves, which is exactly what the deleted version of this file was.
 */

/* Their derivation, for the same phrase. Everything below compares to this. */
const theirs = WalletSeeds.fromMnemonic(TEST_MNEMONIC);
const ours = identityFromWords(TEST_MNEMONIC);

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('the same phrase produces the same wallet here as in testkit', () => {
  it('produces the same 64-byte seed', () => {
    /*
     * Testkit carries the master seed as hex, so this is the stretch itself:
     * mnemonic -> PBKDF2-SHA512, 64 bytes, NO passphrase. If this line fails
     * every line below it is meaningless.
     */
    expect(hex(seedFromWords(TEST_MNEMONIC))).toBe(theirs.masterSeed);
    expect(seedFromWords(TEST_MNEMONIC)).toHaveLength(64);
  });

  it('produces the same shielded key — the one salaries are paid to', () => {
    expect(hex(ours.money.zswap)).toBe(hex(theirs.shielded));
  });

  it('produces the same unshielded key', () => {
    expect(hex(ours.money.night)).toBe(hex(theirs.unshielded));
  });

  it('produces the same dust key', () => {
    expect(hex(ours.money.dust)).toBe(hex(theirs.dust));
  });

  it('every money key is 32 bytes', () => {
    for (const key of [ours.money.zswap, ours.money.night, ours.money.dust]) {
      expect(key).toHaveLength(32);
    }
  });

  it('produces the same payee ADDRESS, which is what a payer actually uses', () => {
    /*
     * The keys matching is the proof; this is the same proof stated in the
     * value a human would compare. Both sides go through the platform's own
     * encoder, so what is compared is the address a payer would paste.
     */
    const address = (seed: Uint8Array): string => {
      const zswap = ZswapSecretKeys.fromSeed(seed);
      return MidnightBech32m.encode('testnet', new ShieldedAddress(
        ShieldedCoinPublicKey.fromHexString(zswap.coinPublicKey),
        ShieldedEncryptionPublicKey.fromHexString(zswap.encryptionPublicKey),
      )).asString();
    };
    expect(address(ours.money.zswap)).toBe(address(theirs.shielded));
    expect(address(ours.money.zswap)).toMatch(/^mn_shield-addr_testnet1/u);
  });

  it('produces a dust key the ledger accepts', () => {
    expect(() => DustSecretKey.fromSeed(ours.money.dust)).not.toThrow();
  });
});

describe('the words and the secret are the same thing in two formats', () => {
  it('round-trips a secret through its words', () => {
    const secret = newSecret();
    expect(secret).toHaveLength(SECRET_BYTES);
    expect(hex(secretFromWords(wordsFromSecret(secret)))).toBe(hex(secret));
  });

  it('reaches the same wallet from the secret as from the words', () => {
    const secret = secretFromWords(TEST_MNEMONIC);
    const fromSecret = identityFromSecret(secret);
    expect(fromSecret.words.join(' ')).toBe(TEST_MNEMONIC);
    expect(hex(fromSecret.money.zswap)).toBe(hex(ours.money.zswap));
  });

  it('gives back twenty-four words', () => {
    expect(wordsFromSecret(newSecret())).toHaveLength(24);
  });

  it('recovers the words after a round trip, which is why the SMALL number is split', () => {
    /*
     * §7.4. Pieces are cut from the 32-byte secret, not the 64-byte
     * seed, precisely so that somebody who has recovered can still be shown
     * their phrase. This asserts the property that decision buys.
     */
    const secret = secretFromWords(TEST_MNEMONIC);
    expect(wordsFromSecret(secret).join(' ')).toBe(TEST_MNEMONIC);
  });
});

describe('the failures are loud, because the silent ones are the dangerous ones', () => {
  it('refuses a phrase with a mistyped word rather than opening another wallet', () => {
    const broken = TEST_MNEMONIC.replace(/diesel$/u, 'dieseel');
    expect(() => identityFromWords(broken)).toThrow(DerivationError);
    try {
      identityFromWords(broken);
    } catch (e) {
      expect((e as DerivationError).code).toBe('not-a-recovery-phrase');
    }
  });

  it('refuses a phrase whose words are all real but reordered', () => {
    /*
     * The checksum is what catches this. Every word is in the list, so a
     * membership check alone would let it through.
     *
     * This depends on THIS fixture's rotation not happening to checksum, which
     * it does not — verified, and deterministic because the phrase is pinned by
     * `testkit-js@5.0.0-beta.4`. If it ever starts failing after a testkit bump,
     * that is why: a rotated phrase validates by chance about once in 256, and
     * the failure would be this line rather than a defect.
     */
    const words = TEST_MNEMONIC.split(' ');
    const reordered = [words[words.length - 1], ...words.slice(0, -1)].join(' ');
    expect(() => identityFromWords(reordered)).toThrow(DerivationError);
  });

  it('refuses a secret of the wrong length — including the 64-byte seed', () => {
    const seed = seedFromWords(TEST_MNEMONIC);
    expect(() => identityFromSecret(seed)).toThrow(DerivationError);
    try {
      identityFromSecret(seed);
    } catch (e) {
      expect((e as DerivationError).code).toBe('secret-wrong-length');
    }
    expect(() => identityFromSecret(new Uint8Array(16))).toThrow(DerivationError);
  });

  it('refuses a valid TWELVE-word phrase, because its recovery is already dead', () => {
    /*
     * BIP-39 is happy with 12 words and the wallet it produces is real and
     * portable. But recovery cuts pieces from the SECRET, and twelve words
     * carry 16 bytes, which `identityFromSecret` refuses. Accepting it here
     * hands somebody a working account whose pieces will not reassemble into a
     * person — discovered on a new device, at the moment they have nothing
     * else. So it is refused at the door, while they still have the other
     * wallet open.
     */
    const twelve = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    expect(secretFromWords(twelve)).toHaveLength(16);
    expect(() => identityFromWords(twelve)).toThrow(DerivationError);
    try {
      identityFromWords(twelve);
    } catch (e) {
      expect((e as DerivationError).code).toBe('not-a-recovery-phrase');
      expect((e as Error).message).toContain('24');
    }
  });

  it('accepts a phrase however it was pasted', () => {
    const messy = `  ${TEST_MNEMONIC.toUpperCase().replace(/ /gu, '\n  ')}  `;
    expect(hex(identityFromWords(messy).money.zswap)).toBe(hex(ours.money.zswap));
  });

  it('accepts the words as an array as well as a string', () => {
    expect(hex(identityFromWords(TEST_MNEMONIC.split(' ')).money.zswap))
      .toBe(hex(ours.money.zswap));
  });
});

describe('the authority compartment', () => {
  /*
   * THE MONEY HALF IS PINNED TO SOMEBODY ELSE'S BYTES. THIS HALF HAS NOBODY TO
   * COMPARE TO — the SDK ships nothing for "prove you are a member of this
   * contract" — so it is pinned two other ways, because the first version of
   * this block was pinned by nothing at all and stayed green while the account
   * index and every purpose name were changed underneath it.
   *
   *   1. An INDEPENDENT walk of the same path, through `@scure/bip32` and
   *      `@noble/hashes` directly rather than through our own module.
   *   2. RECORDED VECTORS, so that changing a purpose STRING — which is part of
   *      the derivation, and would silently re-key every credential in
   *      existence — is a test failure rather than a migration nobody noticed.
   *
   * ── AND EVERY CHECK BELOW NOW WALKS `Purposes` ITSELF ──────────────
   *
   * A row was opened because `Purposes.Recovery` had no recorded vector:
   * renaming that string would have re-keyed the key every recovery piece is
   * locked to, in silence. The instance was fixed. **The row's closing note
   * then claimed the CLASS was covered — "the vector test is the place a fifth
   * would fail to be added" — and measurement showed it was not.** Every check
   * in this block named its purposes in a list written out by hand, so a sixth
   * purpose added next year would have been unpinned exactly as the fourth was.
   *
   * **That is the row's own lesson happening to the row.** *A rule stated in a
   * comment is a rule the next addition does not inherit* — and it had moved
   * into a note, which the next addition does not inherit either.
   *
   * So there are no hand-written purpose lists left here. `EVERY_PURPOSE` is
   * `Object.values(Purposes)`, the vectors are a TABLE KEYED BY THE PURPOSE
   * STRING, and `every purpose in the object has a recorded vector` fails BY
   * NAME on a purpose that has none. **That test was watched failing on a
   * deliberately unpinned sixth purpose before any of this was believed.**
   *
   * WHAT THIS COSTS, so nobody has to discover it: adding a purpose now means
   * adding its vector here, and there is no way to add one quietly. That is
   * the entire point and it is the cost as well as the benefit.
   */
  const AUTHORITY_PATH = "m/44'/2400'/1'/0/0";
  const SALT = new TextEncoder().encode('midnight-identity/authority/v1');
  const independentRoot = HDKey.fromMasterSeed(seedFromWords(TEST_MNEMONIC))
    .derive(AUTHORITY_PATH).privateKey!;
  const independently = (purpose: string, index: number): string =>
    hex(hkdf(sha256, independentRoot, SALT, new TextEncoder().encode(`${purpose}/${index}`), 32));

  /** THE LIST, READ OFF THE OBJECT. Never written out by hand again. */
  const EVERY_PURPOSE: readonly Purpose[] = Object.values(Purposes);

  /**
   * THE RECORDED VECTORS, KEYED BY THE PURPOSE STRING.
   *
   * The key is the STRING and not the constant on purpose: renaming
   * `Purposes.Seat` from `'seat'` to anything else must fail here, and it can
   * only fail if what is written down is the string itself. Every value below
   * is the same value it was before — this is the same assertion in a new
   * place, and they were listed old-shape against
   * new-shape, line for line.
   */
  const VECTORS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
    login: {
      0: 'be06ea61ff49837c5120a333bcceb8c06df8eef36bae181df9d58e89b7a6ab3f',
    },
    device: {
      0: '2bb98c427b3ef0e765f0317a9a944185675e48d18b23942e55fd1ed014e10fca',
    },
    seat: {
      0: '5027bf96c5abbdcc57cbe951bade35703da241780beb490f67acaa65fb7be8ed',
      1: '5a6bb078678fde19bf9ac2d09dc79a823f0cab92d68baef80ad86949c0316909',
    },
    recovery: {
      0: 'e1ff1d00734d77a22d4fa6eae2f7f2b45f44f4399afb671b5d75b35c77ad88a7',
      1: '7f86f78d6385be18557795f4901b23fbe9d4ea598343fabf3eba5d210233ee1e',
    },
    profile: {
      0: '4c755c4d51e59644ff70b7edb6a6ad7a51f937f5ebaf0d6e5a3c17f961bc007d',
      1: '614eb242e9ae0209287d6f184097645048c2e9d33c515768278f262ac870488b',
    },
    /* The sixth purpose, and the vector this block's own comment says
     * there is no way to add quietly. Computed by the INDEPENDENT walk
     * (`@scure/bip32` + `@noble/hashes`, not this repository's derivation) and
     * checked against it below, so the number written down is not our own code
     * agreeing with itself. */
    unlock: {
      0: '5781ec70bd641bfd8bb8db7fb0661258cec3153e149ae82ec74252ee29ff1b86',
      1: '8782d69f6d5cea3dfe8f7f3b2bd9846f1e555182b8e67bd8b0aa02ba7f6f0aae',
    },
    /* The seventh purpose, added under the same sentence the sixth was:
     * the six above are untouched and every value in this table is the value it
     * already had. Computed by the INDEPENDENT walk (`@scure/bip32` +
     * `@noble/hashes`, not this repository's derivation) and checked against it
     * below, so the number written down is not our own code agreeing with
     * itself. */
    inbox: {
      0: 'c53175dd655d250662a98b32534f5db591dade6810e9388d6c93f2511ea0ceef',
      1: '3a393f6b50893112e50df41e950f1aa15dca1a47f6dac565f976700edd2b1610',
    },
  };

  /**
   * **THE TEST A CLOSING NOTE CLAIMED EXISTED AND DID NOT.**
   *
   * It reads the purpose list rather than repeating it, so a purpose added to
   * `derivation.ts` with no vector fails HERE, by name, in a sentence that says
   * which one. **Watched failing on a sixth purpose before it was believed.**
   */
  it('every purpose in the object has a recorded vector', () => {
    const unpinned = EVERY_PURPOSE.filter(
      (purpose) => Object.keys(VECTORS[purpose] ?? {}).length === 0);
    expect(
      unpinned,
      `these purposes exist in \`Purposes\` and have NO recorded vector: `
      + `${unpinned.join(', ')}. A purpose string is part of the derivation — renaming `
      + 'one re-keys every credential of that kind for every person who exists — so a '
      + 'purpose with no vector is a rename nothing in this suite would notice. Add its '
      + 'bytes to VECTORS above, in the same block.',
    ).toEqual([]);
  });

  /** The other direction: a vector for a purpose that no longer exists is a
   * stale expectation nobody is checking, which is the same disease facing the
   * other way. */
  it('every recorded vector belongs to a purpose that still exists', () => {
    const orphans = Object.keys(VECTORS).filter(
      (name) => !EVERY_PURPOSE.includes(name as Purpose));
    expect(orphans, `VECTORS names purposes that are not in \`Purposes\`: ${orphans.join(', ')}`)
      .toEqual([]);
  });

  it('matches the recorded vectors, so a renamed purpose cannot slip through', () => {
    /* Every expectation that was written out by hand before is here, with
     * the same purpose, the same index and the same expected bytes. */
    let checked = 0;
    for (const [purpose, byIndex] of Object.entries(VECTORS)) {
      for (const [index, expected] of Object.entries(byIndex)) {
        expect(hex(ours.authority(purpose as Purpose, Number(index))), `${purpose}/${index}`)
          .toBe(expected);
        checked += 1;
      }
    }
    /* A loop over an empty table is a green test that checked nothing — the
     * shape both are about. */
    /* Eight became ten when `unlock` arrived with two indices. The number
     * is a census of the table, not a claim about any key — the assertions are
     * the `toBe(expected)` above, and every one of those is unchanged. */
    /* Ten became twelve when `inbox` arrived with two indices. Same
     * sentence, and the ten before it are byte-identical — a census that moved
     * because a row was added, never because a row changed. */
    expect(checked).toBe(12);
  });

  it('walks the path this repository says it walks — every purpose', () => {
    for (const purpose of EVERY_PURPOSE) {
      for (const index of [0, 1, 41]) {
        expect(hex(ours.authority(purpose, index)), `${purpose}/${index}`)
          .toBe(independently(purpose, index));
      }
    }
    expect(EVERY_PURPOSE.length).toBeGreaterThan(0);
  });

  it('no purpose is any other purpose, and none is any money key', () => {
    /*
     * An earlier version of this asked only whether the PROFILE key was distinct.
     * This asks it of every purpose against every other, and of every purpose
     * against every money key at every slot the interface offers — which is
     * also the property `subwallets.test.ts` checks from its own side, and that
     * file names its purposes by hand. Widening this one covers the class
     * without touching a frozen file; the entry says so rather than leaving the
     * hand-written list there to look like the only check.
     */
    const authority = new Map<string, string>();
    for (const purpose of EVERY_PURPOSE) {
      for (const index of [0, 1, 2, 41]) {
        const key = hex(ours.authority(purpose, index));
        const already = authority.get(key);
        expect(already, `${purpose}/${index} collides with ${already}`).toBeUndefined();
        authority.set(key, `${purpose}/${index}`);
      }
    }
    expect(authority.size).toBe(EVERY_PURPOSE.length * 4);

    for (const account of [0, 2, 3, 11]) {
      const keys = ours.moneyAt(account);
      for (const key of [keys.zswap, keys.dust, keys.night]) {
        const clash = authority.get(hex(key));
        expect(clash, `a money key at account ${account} IS the authority key ${clash}`)
          .toBeUndefined();
      }
    }
    /* And the root itself is not a money key either. */
    for (const account of [0, 2, 3, 11]) {
      const keys = ours.moneyAt(account);
      for (const key of [keys.zswap, keys.dust, keys.night]) {
        expect(hex(key)).not.toBe(hex(independentRoot));
      }
    }
  });

  it('is not a spending key at any BIP-44 path', () => {
    /*
     * The defect this replaces: authority keys used to BE the person's second
     * wallet account, so a login credential was the NIGHT spending key of an
     * account any wallet offers in a dropdown. Every role and index a wallet
     * would show is checked here, at both accounts.
     *
     * EVERY purpose, not three of them.
     */
    const root = HDKey.fromMasterSeed(seedFromWords(TEST_MNEMONIC));
    const reachable = new Set<string>();
    for (const account of [0, 1, 2]) {
      for (const role of [0, 1, 2, 3, 4]) {
        for (const index of [0, 1, 2]) {
          const k = root.derive(`m/44'/2400'/${account}'/${role}/${index}`).privateKey;
          if (k) reachable.add(hex(k));
        }
      }
    }
    expect(reachable.size).toBe(45);
    for (const purpose of EVERY_PURPOSE) {
      for (const index of [0, 1, 2]) {
        expect(reachable.has(hex(ours.authority(purpose, index))), `${purpose}/${index}`)
          .toBe(false);
      }
    }
  });

  it('is never any of the money keys', () => {
    const login = ours.authority(Purposes.Login, 0);
    for (const key of [ours.money.zswap, ours.money.night, ours.money.dust]) {
      expect(hex(login)).not.toBe(hex(key));
    }
    expect(login).toHaveLength(32);
  });

  it('gives a different key for every purpose and every index', () => {
    const indices = [0, 1, 2, 7, 1000];
    const seen = new Set<string>();
    for (const purpose of EVERY_PURPOSE) {
      for (const index of indices) {
        seen.add(hex(ours.authority(purpose, index)));
      }
    }
    /* The claim is that no two (purpose, index) pairs collide. It is expressed
     * as the product rather than as a number written down, so the number cannot
     * go stale the day a purpose is added. */
    expect(seen.size).toBe(EVERY_PURPOSE.length * indices.length);
  });

  it('is the same key every time for the same purpose and index', () => {
    expect(hex(ours.authority(Purposes.Seat, 3)))
      .toBe(hex(identityFromWords(TEST_MNEMONIC).authority(Purposes.Seat, 3)));
  });

  it('refuses an index outside the range, rather than returning something', () => {
    for (const bad of [-1, 1.5, 2 ** 31, Number.MAX_SAFE_INTEGER, NaN]) {
      expect(() => ours.authority(Purposes.Login, bad)).toThrow(DerivationError);
    }
    expect(() => ours.authority(Purposes.Login, 2 ** 31 - 1)).not.toThrow();
  });
});

describe('a money key and an authority key cannot be swapped', () => {
  /*
   * THIS TEST IS THE TYPECHECK, and it is the only kind that can hold this
   * property. Both keys are 32 bytes, so no runtime assertion distinguishes
   * them — an authority key encodes into a perfectly valid shielded address,
   * and a salary paid to it lands in a coin the payee's wallet never scans
   * (second cause). What stops it is that they are different types.
   *
   * `@ts-expect-error` FAILS THE BUILD IF THE LINE BELOW STOPS BEING AN ERROR,
   * which is what makes this a test and not a comment. Delete the brands and
   * `npm run typecheck` goes red here.
   */
  it('is a compile-time refusal, not a runtime one', () => {
    const money: MoneyKey = ours.money.zswap;
    const authority: AuthorityKey = ours.authority(Purposes.Login, 0);

    // @ts-expect-error an authority key is not a money key
    const notMoney: MoneyKey = authority;
    // @ts-expect-error a money key is not an authority key
    const notAuthority: AuthorityKey = money;
    // @ts-expect-error and neither can be conjured from bare bytes
    const notEither: MoneyKey = new Uint8Array(32);

    /* Used so the compiler does not discard them; the assertions are above. */
    expect([notMoney, notAuthority, notEither].every((k) => k.length === 32)).toBe(true);
  });
});

describe('a different phrase is a different wallet', () => {
  it('does not collide', () => {
    const a = identityFromSecret(newSecret());
    const b = identityFromSecret(newSecret());
    expect(hex(a.money.zswap)).not.toBe(hex(b.money.zswap));
    expect(a.words.join(' ')).not.toBe(b.words.join(' '));
  });
});

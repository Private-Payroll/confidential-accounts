// @vitest-environment jsdom
/* jsdom because `ownedAddressFor` carries the unshielded address too since
 * The two-sided balance pulls in `config.ts`, which reads `window.location` for the
 * passkey RP — a fact about the app's wiring, not about these tests. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { HDKey } from '@scure/bip32';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  DerivationError, Purposes, addressFor, identityFromWords, seedFromWords,
} from 'midnight-identity';
import { ownedAddressFor } from './owned-address.js';
import type { OwnedAddress } from './owned-address.js';
import {
  MAIN_ACCOUNT, OFFERED_UP_FRONT, SUBWALLET_ACCOUNTS, WALLET_ACCOUNTS,
  defaultNameOf, displayNameOf, hueOf, isWalletAccount,
} from './subwallets.js';

/**
 * THE SUBWALLET SLOTS, HELD TO THREE CONSTRAINTS
 * — and 2.2's test is the one that matters most:
 * every slot the interface can reach is DERIVED, and its keys compared
 * against every authority key, because a login credential
 * byte-identical to a spending key — is one off-by-one away from coming back
 * as a dropdown entry. The comparison is against an INDEPENDENT walk of the
 * authority path through `@scure/bip32`, the same way the portability test
 * pins the authority compartment, so this file and `derivation.ts` cannot
 * agree by both being wrong in the same way.
 */

/* jsdom is its own realm: node's Buffer fails the SDK's `instanceof
 * Uint8Array` checks there, so the browser polyfill stands in — exactly as
 * in the other jsdom suites. */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const hex = (b: Uint8Array): string => PolyfillBuffer.from(b).toString('hex');
const ours = identityFromWords(TEST_MNEMONIC);

describe('the slots — 2.2 and 2.3’s fixed set', () => {
  it('starts at account 2. Never 1. Never 0.', () => {
    expect(Math.min(...SUBWALLET_ACCOUNTS)).toBe(2);
    expect(SUBWALLET_ACCOUNTS).not.toContain(1);
    expect(SUBWALLET_ACCOUNTS).not.toContain(0);
  });

  it('is a fixed set: ten subwallets, plus the main wallet, always', () => {
    /* The COUNT is a choice; that it never shrinks is not. A person can only
     * ever have used a slot this list offered, so money can only be in these
     * ten — and a later build that offers fewer makes some of it invisible.
     * Shrinking this list must be a red test, not a diff. */
    expect(SUBWALLET_ACCOUNTS).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(WALLET_ACCOUNTS).toEqual([MAIN_ACCOUNT, ...SUBWALLET_ACCOUNTS]);
    expect(OFFERED_UP_FRONT).toBeLessThanOrEqual(SUBWALLET_ACCOUNTS.length);
  });

  it('knows what is a wallet and what is not', () => {
    expect(isWalletAccount(0)).toBe(true);
    expect(isWalletAccount(2)).toBe(true);
    expect(isWalletAccount(11)).toBe(true);
    expect(isWalletAccount(1)).toBe(false);
    expect(isWalletAccount(12)).toBe(false);
    expect(isWalletAccount(-1)).toBe(false);
  });

  it('gives every slot a stable name and its own colour', () => {
    expect(defaultNameOf(MAIN_ACCOUNT)).toBe('Main wallet');
    expect(defaultNameOf(2)).toBe('Subwallet 1');
    expect(defaultNameOf(11)).toBe('Subwallet 10');
    expect(displayNameOf(2, { '2': 'Client money' })).toBe('Client money');
    expect(displayNameOf(2, { '2': '   ' })).toBe('Subwallet 1');
    expect(displayNameOf(2, {})).toBe('Subwallet 1');
    /* Colours are a function of the slot, so they survive recovery and no
     * two offered wallets share one. */
    const hues = WALLET_ACCOUNTS.map(hueOf);
    expect(new Set(hues).size).toBe(WALLET_ACCOUNTS.length);
  });
});

describe('the derivation parameter — 2.1', () => {
  it('moneyAt(0) is `money`, byte for byte: the zero-argument behaviour is unchanged', () => {
    const at0 = ours.moneyAt(0);
    expect(hex(at0.zswap)).toBe(hex(ours.money.zswap));
    expect(hex(at0.dust)).toBe(hex(ours.money.dust));
    expect(hex(at0.night)).toBe(hex(ours.money.night));
  });

  it('derives the same subwallet keys every time, from either door', () => {
    const again = identityFromWords(TEST_MNEMONIC);
    for (const account of SUBWALLET_ACCOUNTS) {
      expect(hex(again.moneyAt(account).zswap)).toBe(hex(ours.moneyAt(account).zswap));
    }
  });

  it('every subwallet is its own wallet: no key or address repeats across slots', () => {
    const seen = new Set<string>();
    const addresses = new Set<string>();
    for (const account of WALLET_ACCOUNTS) {
      const keys = ours.moneyAt(account);
      for (const key of [keys.zswap, keys.dust, keys.night]) {
        expect(key).toHaveLength(32);
        seen.add(hex(key));
      }
      addresses.add(addressFor(keys.zswap, 'testnet').bech32);
    }
    expect(seen.size).toBe(WALLET_ACCOUNTS.length * 3);
    expect(addresses.size).toBe(WALLET_ACCOUNTS.length);
  });

  it('refuses nonsense accounts by name', () => {
    for (const bad of [-1, 1.5, 2 ** 31, Number.NaN]) {
      expect(() => ours.moneyAt(bad)).toThrow(DerivationError);
    }
  });
});

describe('account 1 — 2.2, the authority trap, asserted rather than remembered', () => {
  const AUTHORITY_ROOT_PATH = "m/44'/2400'/1'/0/0";
  const SALT = new TextEncoder().encode('midnight-identity/authority/v1');
  const independentRoot = HDKey.fromMasterSeed(seedFromWords(TEST_MNEMONIC))
    .derive(AUTHORITY_ROOT_PATH).privateKey!;

  it('moneyAt(1) is refused, loudly and by its own name', () => {
    expect(() => ours.moneyAt(1)).toThrow(DerivationError);
    try {
      ours.moneyAt(1);
    } catch (e) {
      expect((e as DerivationError).code).toBe('account-reserved');
      expect((e as Error).message).toContain('authority');
    }
  });

  it('the trap is real: a wallet at account 1 WOULD spend with the authority root', () => {
    /* Not hypothetical caution — the measured defect. The NIGHT key a wallet
     * at account 1 would spend with sits at m/44'/2400'/1'/0/0 — and
     * expanding THAT key with the authority HKDF reproduces this identity's
     * real credentials, byte for byte. So the key is not "similar to" the
     * authority root; it IS the root every login and device credential grows
     * from, which is exactly why `moneyAt(1)` refuses. If the authority path
     * ever moves, this test says so rather than letting the two rules drift
     * apart. */
    const nightAtAccount1 = HDKey.fromMasterSeed(seedFromWords(TEST_MNEMONIC))
      .derive("m/44'/2400'/1'/0/0").privateKey!;
    const expandsTo = (purpose: string, index: number): string => hex(hkdf(
      sha256, nightAtAccount1, SALT, new TextEncoder().encode(`${purpose}/${index}`), 32));
    expect(expandsTo(Purposes.Login, 0)).toBe(hex(ours.authority(Purposes.Login, 0)));
    expect(expandsTo(Purposes.Device, 7)).toBe(hex(ours.authority(Purposes.Device, 7)));
  });

  it('derives EVERY slot the interface can reach; none equals any authority key', () => {
    /* The design's 2.2, verbatim: not a comment, a test. The slots come off
     * the same list the picker is built from, so a rearranged list is
     * checked as a matter of course — a list that reached account 1 would
     * fail on the root comparison below, because the night key at account 1
     * IS the authority root (previous test). */
    const authorityKeys = new Set<string>([hex(independentRoot)]);
    /* A LATER READING ORDERED THIS LINE: the hand-written list is gone and the
     * object itself is what is walked. A sixth purpose added next year is
     * covered here by arriving, not by somebody remembering to name it —
     * the same property `derivation.portability.test.ts` pins for the
     * vectors. The assertion below is unchanged; the set it is checked
     * against is strictly larger. */
    for (const purpose of Object.values(Purposes)) {
      for (const index of [0, 1, 2, 41]) {
        authorityKeys.add(hex(hkdf(
          sha256, independentRoot, SALT,
          new TextEncoder().encode(`${purpose}/${index}`), 32)));
      }
    }
    for (const account of WALLET_ACCOUNTS) {
      const keys = ours.moneyAt(account);
      for (const key of [keys.zswap, keys.dust, keys.night]) {
        expect(authorityKeys.has(hex(key))).toBe(false);
      }
    }
  });
});

describe('an address and its owner are one value', () => {
  /* The rule §3 bought — "the name travels with the address" — was held at
   * one call site, true only while home is the only screen with an
   * address. `OwnedAddress` is the durable form: the only door from a slot
   * to a renderable address returns the owner inside the value, the brand
   * keeps anybody from forging one apart, and the owner ALWAYS carries the
   * slot when the name is a personal one — because two subwallets may share
   * a name, and the surface deciding "did I copy the right thing" is
   * exactly where the difference matters. */

  it('an unnamed slot owns as itself — the slot IS the name', () => {
    expect(ownedAddressFor(ours, 0, {}, 'testnet').owner).toBe('Main wallet');
    expect(ownedAddressFor(ours, 2, {}, 'testnet').owner).toBe('Subwallet 1');
    expect(ownedAddressFor(ours, 11, {}, 'testnet').owner).toBe('Subwallet 10');
  });

  it('a personal name never travels without its slot', () => {
    const names = { '2': 'Savings', '3': 'Savings', '0': 'Everything' };
    expect(ownedAddressFor(ours, 2, names, 'testnet').owner).toBe('Savings (subwallet 1)');
    expect(ownedAddressFor(ours, 3, names, 'testnet').owner).toBe('Savings (subwallet 2)');
    expect(ownedAddressFor(ours, 0, names, 'testnet').owner).toBe('Everything (main wallet)');
  });

  it('two wallets wearing one name still produce two distinguishable owners and two addresses', () => {
    const names = { '2': 'Savings', '3': 'Savings' };
    const a = ownedAddressFor(ours, 2, names, 'testnet');
    const b = ownedAddressFor(ours, 3, names, 'testnet');
    expect(a.owner).not.toBe(b.owner);
    expect(a.address.bech32).not.toBe(b.address.bech32);
  });

  it('a pathological name cannot impersonate a slot: the real slot rides along', () => {
    /* Somebody names subwallet 2 "Subwallet 1". The genuine Subwallet 1 owns
     * as "Subwallet 1"; the impostor owns as "Subwallet 1 (subwallet 2)" —
     * the lie is printed next to the truth. */
    expect(ownedAddressFor(ours, 3, { '3': 'Subwallet 1' }, 'testnet').owner)
      .toBe('Subwallet 1 (subwallet 2)');
  });

  it('refuses the reserved account and any slot the picker does not offer', () => {
    expect(() => ownedAddressFor(ours, 1, {}, 'testnet')).toThrow(/authority/);
    /* moneyAt would happily derive account 12; the interface must not show
     * an address its own picker cannot reach — §2.3 from the other side. */
    expect(() => ownedAddressFor(ours, 12, {}, 'testnet')).toThrow(/not a wallet/);
    expect(() => ownedAddressFor(ours, -1, {}, 'testnet')).toThrow(/not a wallet/);
  });

  it('cannot be forged apart from its constructor', () => {
    // @ts-expect-error the brand is module-private: no literal can be an OwnedAddress
    const forged: OwnedAddress = {
      address: ownedAddressFor(ours, 0, {}, 'testnet').address,
      account: 2, name: 'x', slot: 'subwallet 1', owner: 'x',
    };
    /* Used so the compiler keeps the assertion above. */
    expect(forged.account).toBe(2);
  });
});

describe('the reserved account is documented where an implementer meets it', () => {
  /* The documentation half of the row. The half that closes it needs
   * balances (read account 1, say something is there, help move it) and is
   * recorded as waiting on that in the log. This pin exists because a
   * warning that lives only in a source comment is not documentation:
   * SECURITY.md is the file an external implementer reads, and deleting the
   * section must be a red suite, not a quiet diff. */
  /* Resolved through `fileURLToPath` rather than handing fs a URL: under the
   * jsdom environment the URL instance is jsdom's, and node's fs refuses it. */
  /* `SECURITY.md` IS THE LIBRARY'S, NOT THIS APPLICATION'S. It travelled with
   * the package at the merge; this file used to sit one level below it and now
   * sits in a sibling folder. The document an external implementer reads is
   * the one the package publishes, which is the one this pins. */
  const security = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      '../../../../packages/identity/SECURITY.md'), 'utf8');

  it('SECURITY.md says account 1 is reserved and never a wallet', () => {
    expect(security).toMatch(/Account 1 of this seed is reserved and must never be offered as a wallet/);
    expect(security).toMatch(/root every authority credential expands\s+from/);
  });

  it('and says plainly what happens when the phrase is imported elsewhere', () => {
    expect(security).toMatch(/imports these twenty-four words into another wallet/);
    expect(security).toMatch(/never\s+display it, never balance it and never spend it/);
    expect(security).toMatch(/Not stolen; stranded/);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { sampleContractAddress } from '@midnightntwrk/ledger-v9';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from '../keys/derivation.js';
import {
  FingerprintError, addressFingerprint, companyFingerprint, tidyFingerprint,
} from './fingerprint.js';
import { addressFor } from '../index.js';
import { NETWORK } from '../wallet/network.js';
import { parseAsk } from './request.js';
import type { UnlockRequest } from './request.js';
import { unlockKeyFor } from './unlock.js';

/**
 * **THE THING A PERSON IS ASKED TO COMPARE.**
 *
 * The screen tells somebody *"if you do not recognise the company, do not give
 * the key"* and then shows them sixty-four characters of hex. This file pins
 * the four properties that make a fingerprint worth putting there instead:
 *
 *   it is a pure function of the address, so ANY CLIENT computes the same one;
 *   two addresses that differ by one character do not share one;
 *   it is wide enough that grinding a match is not worth doing;
 *   **and it is NEVER an input to the key.**
 */

const CO_A = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
const CO_B = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
const A = 'https://payroll-a.example';
const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);

const askFor = (company: string): UnlockRequest => parseAsk({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'unlock',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'So we can show you your payslips.',
  company,
  nonce: 'n1',
  expiresAt: NOW + 60_000,
}, A, NOW) as UnlockRequest;

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('IT IS A RENDERING OF THE ADDRESS AND OF NOTHING ELSE', () => {
  it('TWO CLIENTS COMPUTE THE SAME FINGERPRINT FROM THE SAME ADDRESS', () => {
    /*
     * **THIS IS THE PROPERTY THE WHOLE THING RESTS ON.** A person is told the
     * fingerprint out of band — in an invitation, in an email from their
     * employer, over the phone — and compares it against what a wallet shows.
     * That only works if the two were computed by different code and agree.
     *
     * So the second computation here is an INDEPENDENT walk: the label, the
     * hash and the alphabet written out directly rather than imported from the
     * module, in the same discipline `unlock.test.ts` uses for the key. If
     * `fingerprint.ts` changed its label, its alphabet or its width, this
     * disagrees.
     */
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const independent = (company: string): string => {
      const digest = sha256(new TextEncoder()
        .encode(`midnight-identity/company-fingerprint/v1/${company.toLowerCase()}`));
      let bits = 0n;
      for (let i = 0; i < 13; i += 1) bits = (bits << 8n) | BigInt(digest[i] as number);
      bits >>= 4n;
      const out: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        out.unshift(ALPHABET[Number(bits & 31n)] as string);
        bits >>= 5n;
      }
      return [0, 4, 8, 12, 16].map((i) => out.slice(i, i + 4).join('')).join('-');
    };

    let checked = 0;
    for (let i = 0; i < 50; i += 1) {
      const address = sampleContractAddress();
      expect(companyFingerprint(address), address).toBe(independent(address));
      checked += 1;
    }
    expect(checked).toBe(50);

    /* And the recorded values for the two companies the screens are tested
     * with, so a change to any part of this is a diff somebody has to explain. */
    expect(companyFingerprint(CO_A)).toBe('P5DN-KZ3N-G1RX-1QDF-WZZB');
    expect(companyFingerprint(CO_B)).toBe('6JTP-4CKK-CPH3-X443-S5QA');
  });

  it('TWO ADDRESSES DIFFERING IN ONE CHARACTER DO NOT SHARE ONE', () => {
    /* The point of showing it at all. Sixty-four positions, sixteen digits: a
     * near-miss address must not render a near-miss fingerprint, it must render
     * an unrelated one. */
    const seen = new Set<string>([companyFingerprint(CO_A)]);
    let checked = 0;
    for (let at = 0; at < 64; at += 1) {
      for (const digit of '0123456789abcdef') {
        if (CO_A[at] === digit) continue;
        const near = `${CO_A.slice(0, at)}${digit}${CO_A.slice(at + 1)}`;
        const print = companyFingerprint(near);
        expect(seen.has(print), `${near} collided`).toBe(false);
        seen.add(print);
        checked += 1;
      }
    }
    expect(checked).toBe(64 * 15);
    expect(seen.size).toBe(64 * 15 + 1);
  });

  it('IS THE SAME FOR BOTH SPELLINGS OF ONE COMPANY', () => {
    /* The fold reaches here too, so a person told the fingerprint of
     * `DBE1…` and shown a wallet that was asked with `dbe1…` sees one string. */
    const mixed = [...CO_A].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join('');
    expect(companyFingerprint(CO_A.toUpperCase())).toBe(companyFingerprint(CO_A));
    expect(companyFingerprint(mixed)).toBe(companyFingerprint(CO_A));
  });

  it('IS TWENTY SYMBOLS OF A THIRTY-TWO SYMBOL ALPHABET — ONE HUNDRED BITS', () => {
    /*
     * **THE WIDTH IS THE WHOLE SECURITY ARGUMENT AND IT IS PINNED, NOT LEFT TO
     * TASTE.** Trouble is what a number chosen for looking friendly costs: pairing
     * shows two digits, and two digits are safe there ONLY because the protocol
     * commits before it reveals. **There is no commitment available here** — an
     * attacker picks their own contract address and computes this offline as
     * many times as they like — so the only thing between a person and a ground
     * lookalike is how wide this is. `fingerprint.ts` carries the arithmetic.
     */
    const print = companyFingerprint(CO_A);
    expect(print).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/u);
    expect(print.replace(/-/gu, '')).toHaveLength(20);
    /* No `I`, `L`, `O` or `U` anywhere, over a wide sample: Crockford's
     * alphabet is chosen so nothing reads as one/ell, zero/oh, or as a word. */
    for (let i = 0; i < 200; i += 1) {
      expect(companyFingerprint(sampleContractAddress())).not.toMatch(/[ILOU]/u);
    }
  });

  it('refuses anything that is not an address, rather than rendering it', () => {
    /* A fingerprint of a string that is not an address is a thing a person
     * would compare and believe. */
    for (const bad of ['', 'payroll-a', CO_A.slice(0, 63), `${CO_A}0`, `0x${CO_A}`,
      CO_A.replace('d', 'g')]) {
      expect(() => companyFingerprint(bad), bad).toThrow(FingerprintError);
    }
  });
});

describe('AND IT IS NEVER AN INPUT TO THE KEY', () => {
  it('THE DERIVATION DOES NOT IMPORT IT, AND THE SOURCE SAYS SO', () => {
    /*
     * **A HUNDRED-BIT SELECTOR FOR A TWO-HUNDRED-AND-FIFTY-SIX-BIT THING IS
     * THE REJECTED DESIGN IN A NEW HAT.** The way this dies is somebody
     * deriving from the fingerprint because it is shorter and reads better.
     * `unlock.test.ts` would catch it — the key is pinned against an
     * independent walk — and this says the same thing about the code, so a
     * reader does not have to run the suite to see it.
     */
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'unlock.ts'), 'utf8');
    expect(source).not.toContain('fingerprint');
    expect(source).not.toContain('companyFingerprint');
  });

  it('and the released bytes are unchanged by any of this', () => {
    /* The vectors, from `unlock.test.ts`, asserted here as well: if the
     * fingerprint ever reached the derivation these move. */
    expect(hex(unlockKeyFor(identity, askFor(CO_A))))
      .toBe('7a9ac85d4b33d2cca39b5b15a8ff1e2b88a0e891ef452f78562b415db33460b7');
    expect(hex(unlockKeyFor(identity, askFor(CO_B))))
      .toBe('d1aa99d5be6d5e49e391a705e4253323051cfa92a5f67e2c407909a6465bd71e');
  });
});

/**
 * **THE CODE TWO PEOPLE COMPARE, AND THE ONE THING IT MUST NEVER DO.**
 *
 * The invitee's wallet shows this for the address it is about to disclose, the
 * person pastes it into the page that asked, and the admin's own machine
 * computes it again from the address that actually arrived. **The comparison is
 * worth nothing the moment two different addresses can render one code**, so
 * that is what the first test here is, and it is the one the mutation kills.
 */
describe('§2 — THE CODE FOR A RECEIVING ADDRESS', () => {
  /** Real shielded addresses, out of the wallet's own derivation. */
  const shielded = (account: number): string =>
    addressFor(identity.moneyAt(account).zswap, NETWORK).bech32;

  it('TWO DIFFERENT ADDRESSES NEVER RENDER THE SAME CODE', () => {
    /*
     * **THE WHOLE OF THE CHECK, AS A NEGATIVE.** An admin comparing two codes
     * is doing one thing: deciding that the address that arrived is the address
     * the wallet showed. A function that answered the same twenty characters
     * for a second address would make every one of those comparisons pass, on
     * every screen, for ever — and it would look exactly like a working one.
     *
     * Two families, because the two ways this dies are different: the wallet's
     * OWN neighbouring subwallets, which is the substitution a person could
     * plausibly make by accident, and near-miss strings differing in one
     * character, which is the substitution an attacker would try to make look
     * innocent.
     */
    const seen = new Map<string, string>();
    const distinct = (address: string): void => {
      const code = addressFingerprint(address);
      const already = seen.get(code);
      expect(already === undefined || already === address,
        `${address} renders the same code as ${String(already)}`).toBe(true);
      seen.set(code, address);
    };

    /* Every wallet this interface offers, which is where a wrong-by-one-slot
     * address comes from. */
    for (let account = 2; account <= 9; account += 1) distinct(shielded(account));

    /* And a near-miss walk over one of them: change one character, get an
     * unrelated code rather than a nearly-identical one. */
    const one = shielded(2);
    let checked = 0;
    for (let at = one.length - 20; at < one.length; at += 1) {
      for (const c of 'acdefghjklmnpqrstuvwxyz023456789') {
        if (one[at] === c) continue;
        distinct(`${one.slice(0, at)}${c}${one.slice(at + 1)}`);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(600);
    expect(seen.size).toBe(checked + 8);
  });

  it('BOTH SIDES COMPUTE IT THE SAME WAY, FROM THE ADDRESS AND FROM NOTHING ELSE', () => {
    /*
     * The property the comparison rests on, pinned the way the company one is:
     * an INDEPENDENT walk — the label, the hash, the alphabet and the width
     * written out here rather than imported — because the two sides of this
     * comparison are two repositories, and a shared constant that quietly moved
     * would move both of them together and nobody would ever see a mismatch.
     */
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const independent = (address: string): string => {
      const digest = sha256(new TextEncoder().encode(
        `midnight-identity/receiving-address-fingerprint/v1/${address.toLowerCase()}`));
      let bits = 0n;
      for (let i = 0; i < 13; i += 1) bits = (bits << 8n) | BigInt(digest[i] as number);
      bits >>= 4n;
      const out: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        out.unshift(ALPHABET[Number(bits & 31n)] as string);
        bits >>= 5n;
      }
      return [0, 4, 8, 12, 16].map((i) => out.slice(i, i + 4).join('')).join('-');
    };
    for (let account = 2; account <= 6; account += 1) {
      const address = shielded(account);
      expect(addressFingerprint(address), address).toBe(independent(address));
    }
  });

  it('IS THE SAME SHAPE AS THE COMPANY ONE, AND IS NOT THE SAME STRING', () => {
    /* One width, one alphabet, one grouping — `render` is read once, so a
     * change to how long a code is changes both and cannot change one. And the
     * labels are separate, so twenty characters never mean two things: the
     * SAME sixty-four hex characters read as a company and as an address must
     * not collide. */
    const address = shielded(2);
    expect(addressFingerprint(address))
      .toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/u);
    expect(addressFingerprint(address).replace(/-/gu, '')).toHaveLength(20);
    const bothWays = `${CO_A}${CO_A}`;
    expect(addressFingerprint(bothWays)).not.toBe(companyFingerprint(CO_A));
  });

  it('refuses anything that is not an address, rather than rendering it', () => {
    /* Same rule as its neighbour and for the same reason: a code computed from
     * a string that is not an address is a code somebody would compare and
     * believe. */
    for (const bad of ['', 'nowhere', CO_A.slice(0, 39), `mn_shield addr_${CO_A}`,
      `mn_shield-addr_${CO_A}\n`]) {
      expect(() => addressFingerprint(bad), JSON.stringify(bad)).toThrow(FingerprintError);
    }
  });
});

describe('§2 — a code as somebody pasted it', () => {
  const shielded = (account: number): string =>
    addressFor(identity.moneyAt(account).zswap, NETWORK).bech32;

  it('THE SPELLINGS OF ONE CODE ARE ONE CODE, AND A HALF-CODE IS NOT A CODE', () => {
    /*
     * **THE CONTROL DEPENDS ON A HUMAN PAYING ATTENTION, SO IT MUST NOT SPEND
     * THAT ATTENTION ON PUNCTUATION.** A mismatch is supposed to mean *the
     * address that arrived is not the one the wallet showed*. A mismatch that
     * can also mean *there was a space on the end* is a control that cries
     * wolf, and one that cries wolf is one an admin learns to click through.
     */
    const code = addressFingerprint(shielded(2));
    const bare = code.replace(/-/gu, '');
    for (const spelling of [code, ` ${code} `, `${code}\n`, code.toLowerCase(), bare,
      bare.toLowerCase(), code.replace(/-/gu, ' '), `"${code}"`]) {
      expect(tidyFingerprint(spelling), JSON.stringify(spelling)).toBe(code);
    }

    /* And what is NOT one comes back null, so a screen can say so while the
     * person is still standing in front of it. */
    for (const bad of ['', 'not a code', bare.slice(0, 19), `${bare}Z`,
      bare.replace(/[0-9A-Z]$/u, 'I'), bare.replace(/[0-9A-Z]$/u, 'U')]) {
      expect(tidyFingerprint(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

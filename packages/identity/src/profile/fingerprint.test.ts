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
import type { AccountAddress, CompanyLabel } from './company-label.js';

/**
 * **THE THING A PERSON IS ASKED TO COMPARE.**
 *
 * The screen tells somebody *"if you do not recognise the company, do not give
 * the key"*. This file pins the properties that make a fingerprint worth
 * putting there:
 *
 *   it is a pure function of the company's label AND its account's address, so
 *   ANY CLIENT computes the same one, and there is no form that takes the label
 *   alone;
 *   the same label on another account renders another fingerprint;
 *   two values that differ by one character do not share one;
 *   it is wide enough that grinding a match is not worth doing;
 *   **and it is NEVER an input to the key.**
 */

const ADDRESS_A = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
const ADDRESS_B = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e' as AccountAddress;
const CO_A = `co_${'1'.repeat(8)}${ADDRESS_A.slice(8)}` as CompanyLabel;
const CO_B = `co_${'2'.repeat(8)}${ADDRESS_B.slice(8)}` as CompanyLabel;
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
const labelOf = (address: string): CompanyLabel => `co_${address}` as CompanyLabel;

describe('IT IS A RENDERING OF THE LABEL AND THE ACCOUNT TOGETHER, AND OF NOTHING ELSE', () => {
  it('TWO CLIENTS COMPUTE THE SAME FINGERPRINT FROM THE SAME PAIR', () => {
    /*
     * **THIS IS THE PROPERTY THE WHOLE THING RESTS ON.** A person is told the
     * fingerprint out of band — in an invitation, in an email from their
     * employer, over the phone — and compares it against what a wallet shows.
     * That only works if the two were computed by different code and agree.
     *
     * So the second computation here is an INDEPENDENT walk: the domain, the
     * hash and the alphabet written out directly rather than imported from the
     * module, in the same discipline `unlock.test.ts` uses for the key.
     * RED WHEN: the domain, the order or separator of label and account, the
     * alphabet or the width changes.
     */
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const independent = (label: string, account: string): string => {
      const digest = sha256(new TextEncoder()
        .encode(`midnight-identity/company-fingerprint/v2/${label}/${account.toLowerCase()}`));
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
      const label = labelOf(sampleContractAddress());
      const account = sampleContractAddress() as AccountAddress;
      expect(companyFingerprint(label, account), label).toBe(independent(label, account));
      checked += 1;
    }
    expect(checked).toBe(50);

    /* And the recorded values for the two companies the screens are tested
     * with, so a change to any part of this is a diff somebody has to explain. */
    expect(companyFingerprint(CO_A, ADDRESS_A)).toBe('1RMG-DWB5-QF84-YXAS-X3T1');
    expect(companyFingerprint(CO_B, ADDRESS_B)).toBe('NJTE-0KNH-Q1WT-8GAE-5PPS');
  });

  it('THE SAME LABEL ON ANOTHER ACCOUNT IS ANOTHER FINGERPRINT, SO ONE COMPANY CANNOT WEAR ANOTHER\'S', () => {
    /* RED WHEN: the account is left out of what is rendered. */
    expect(companyFingerprint(CO_A, ADDRESS_B)).not.toBe(companyFingerprint(CO_A, ADDRESS_A));
    /* RED WHEN: the label is left out of what is rendered. */
    expect(companyFingerprint(CO_B, ADDRESS_A)).not.toBe(companyFingerprint(CO_A, ADDRESS_A));
  });

  it('TWO LABELS, OR TWO ACCOUNTS, DIFFERING IN ONE CHARACTER DO NOT SHARE ONE', () => {
    /* The point of showing it at all. Sixty-four positions, sixteen digits: a
     * near-miss value must not render a near-miss fingerprint, it must render
     * an unrelated one. */
    const seen = new Set<string>([companyFingerprint(CO_A, ADDRESS_A)]);
    let checked = 0;
    for (let at = 0; at < 64; at += 1) {
      for (const digit of '0123456789abcdef') {
        if (ADDRESS_A[at] === digit) continue;
        const near = `${ADDRESS_A.slice(0, at)}${digit}${ADDRESS_A.slice(at + 1)}`;
        for (const print of [companyFingerprint(CO_A, near as AccountAddress), companyFingerprint(labelOf(near), ADDRESS_A)]) {
          expect(seen.has(print), `${near} collided`).toBe(false);
          seen.add(print);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(2 * 64 * 15);
    expect(seen.size).toBe(2 * 64 * 15 + 1);
  });

  it('IS THE SAME FOR BOTH SPELLINGS OF ONE ACCOUNT, AND A LABEL HAS ONLY ONE', () => {
    expect(companyFingerprint(CO_A, ADDRESS_A.toUpperCase() as AccountAddress)).toBe(companyFingerprint(CO_A, ADDRESS_A));
    /* RED WHEN: the label is folded rather than refused. */
    expect(() => companyFingerprint(CO_A.toUpperCase() as CompanyLabel, ADDRESS_A)).toThrow(FingerprintError);
  });

  it('IS TWENTY SYMBOLS OF A THIRTY-TWO SYMBOL ALPHABET — ONE HUNDRED BITS', () => {
    /*
     * **THE WIDTH IS THE WHOLE SECURITY ARGUMENT AND IT IS PINNED, NOT LEFT TO
     * TASTE.** Pairing shows two digits, and two digits are safe there ONLY
     * because the protocol commits before it reveals. **There is no commitment
     * available here** — an attacker picks their own label and deploys their
     * own account, and computes this offline as many times as they like — so
     * the only thing between a person and a ground lookalike is how wide this
     * is. `fingerprint.ts` carries the arithmetic.
     */
    const print = companyFingerprint(CO_A, ADDRESS_A);
    expect(print).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/u);
    expect(print.replace(/-/gu, '')).toHaveLength(20);
    for (let i = 0; i < 200; i += 1) {
      expect(companyFingerprint(labelOf(sampleContractAddress()), sampleContractAddress() as AccountAddress)).not.toMatch(/[ILOU]/u);
    }
  });

  it('refuses a label where the account belongs and an address where the label belongs, rather than rendering either', () => {
    /* A fingerprint of a string that is not what it stands for is a thing a
     * person would compare and believe.
     * RED WHEN: either reader accepts the other's shape, or anything malformed. */
    for (const bad of ['', 'payroll-a', ADDRESS_A, CO_A.slice(0, 66), `${CO_A}0`, `0x${ADDRESS_A}`]) {
      expect(() => companyFingerprint(bad as CompanyLabel, ADDRESS_A), bad).toThrow(FingerprintError);
    }
    for (const bad of ['', CO_A, ADDRESS_A.slice(0, 63), `${ADDRESS_A}0`, `0x${ADDRESS_A}`, ADDRESS_A.replace('d', 'g')]) {
      expect(() => companyFingerprint(CO_A, bad as AccountAddress), bad).toThrow(FingerprintError);
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
    /* The keys for these two labels, recorded from an independent walk of
     * the derivation: if the fingerprint ever reached the derivation these move. */
    expect(hex(unlockKeyFor(identity, askFor(CO_A))))
      .toBe('347b798eae3ae0772f06e919328963fbd56fac95fb3062eb8d6c3880e6d408c9');
    expect(hex(unlockKeyFor(identity, askFor(CO_B))))
      .toBe('c681c227b3601a75ac543579ee6eb50708e6ae777009c4ff028ce9475e629a6e');
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
    const bothWays = `${CO_A}/${ADDRESS_A}`;
    expect(addressFingerprint(bothWays)).not.toBe(companyFingerprint(CO_A, ADDRESS_A));
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

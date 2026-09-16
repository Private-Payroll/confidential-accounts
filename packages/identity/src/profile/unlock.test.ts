import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { HDKey } from '@scure/bip32';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  dummyContractAddress, encodeContractAddress, sampleContractAddress,
} from '@midnightntwrk/ledger-v9';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  Purposes, identityFromSecret, identityFromWords, secretFromWords, seedFromWords,
} from '../keys/derivation.js';
import type { Purpose } from '../keys/derivation.js';
import { fromBase64Url, toBase64Url } from '../passkey/bytes.js';
import { ASK_KINDS, parseAsk, parseRequest } from './request.js';
import type { UnlockRequest } from './request.js';
import { listen } from './channel.js';
import type { ChannelState, ChannelWindow } from './channel.js';
import {
  KEYRING_RELEASE_SCHEMA, RELEASE_SCHEMA, UnlockError, keyringKeyFor, keyringReleaseFor,
  readKeyringRelease, readRelease, releaseFor, unlockKeyFor,
} from './unlock.js';
import { committeeKeyFor, committeeSigningKeyFor } from './committee-key.js';
import type { KeyringRequest } from './request.js';
import { emptyProfile, grantTo, originsFor, recordRelease, releasesOf } from './model.js';
import { WALLET_ACCOUNTS } from '../../../../apps/wallet/src/accounts/subwallets.js';

/**
 * **THE WALLET RELEASES A KEY, AND THE FIVE THINGS THAT MAKE THAT SAFE.**
 *
 * **ONE INGREDIENT CHANGED AND NOTHING ELSE.** An earlier version derived the released key
 * from the requesting ORIGIN. The origin is the one thing the wallet can trust,
 * so using it felt safe — **and a hostname is a deployment detail**, so anything
 * sealed under a key derived from ours can only ever be opened at ours.
 * The key is now derived from **the company's own account contract address**,
 * and the origin keeps deciding who may be handed something.
 *
 * The five rules this file checks, in their own order:
 *
 *   1. the address goes in AT FULL WIDTH, as its own bytes;
 *   2. the SAME COMPANY FROM TWO DIFFERENT HOSTS gets the same key;
 *   3. two companies never get the same one, and a rebuilt wallet agrees;
 *   4. it is never a money key;
 *   5. the remembered list is never an input.
 *
 * **THE TWO THAT MATTER MOST ARE THE TWO-HOSTS ONE AND THE MONEY KEY.** Both
 * are asserted against a walk of the derivation written out here — `@scure/bip32`
 * and `@noble/hashes` directly rather than through this repository's own module
 * — so this file and `unlock.ts` cannot agree by both being wrong in the same
 * way ABOUT THE PATH OR THE CONSTANTS. **IT IS NOT INDEPENDENT AT THE LEVEL OF
 * THE PRIMITIVES, AND THAT IS WORTH SAYING HERE RATHER THAN LEAVING IT TO BE
 * ASSUMED:** `@scure/bip32` is the library the SDK derives with too, so a defect
 * inside it moves both sides together and this file stays green. That is
 * `derivation.portability.test.ts`'s discipline, borrowed because the property is
 * the same one.
 */

const NOW = 1_755_000_000_000;
const A = 'https://payroll-a.example';
const B = 'https://payroll-b.example';

/**
 * **TWO COMPANIES, WRITTEN THE WAY THE CHAIN WRITES THEM.** Both came out of
 * `sampleContractAddress()`; the shape is pinned against the SDK below rather
 * than described.
 */
const CO_A = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
const CO_B = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';

const identity = identityFromWords(TEST_MNEMONIC);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** An unlock on the wire. **No `origin` key, no `wants` key, one `company`.** */
const unlock = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'unlock',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'So we can show you your payslips.',
  company: CO_A,
  nonce: 'n1',
  expiresAt: NOW + 60_000,
  ...over,
});

/** A disclosure on the wire, in the shape first shipped — no `kind` at all. */
const disclosure = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'To pay you, we need to know who you are.',
  wants: [{ attribute: 'given-name', required: true }],
  nonce: 'n1',
  expiresAt: NOW + 60_000,
  ...over,
});

/** The parsed ask, which is the only thing `unlock.ts` will take. */
const askAt = (
  origin: string, company: string = CO_A, over: Record<string, unknown> = {},
): UnlockRequest => parseAsk(unlock({ company, ...over }), origin, NOW) as UnlockRequest;

/** The key for a company, asked for from the ordinary host. */
const keyFor = (company: string): string => hex(unlockKeyFor(identity, askAt(A, company)));

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (e) {
    return (e as { code?: string }).code ?? 'no code';
  }
  throw new Error('should have refused');
};

/* ── THE INDEPENDENT WALK. Nothing below it goes through `unlock.ts`. ────── */

const AUTHORITY_PATH = "m/44'/2400'/1'/0/0";
const AUTHORITY_SALT = new TextEncoder().encode('midnight-identity/authority/v1');
const UNLOCK_SALT = new TextEncoder().encode('midnight-identity/unlock/v2');
const independentRoot = HDKey.fromMasterSeed(seedFromWords(TEST_MNEMONIC))
  .derive(AUTHORITY_PATH).privateKey!;
const independentAuthority = (purpose: string, index: number): Uint8Array =>
  hkdf(sha256, independentRoot, AUTHORITY_SALT,
    new TextEncoder().encode(`${purpose}/${index}`), 32);
const independentUnlockKey = (company: string): Uint8Array => hkdf(
  sha256, independentAuthority('unlock', 0), UNLOCK_SALT,
  new TextEncoder().encode(company), 32);

describe('§4 — AN UNLOCK IS ITS OWN KIND, AND NAMES EXACTLY ONE THING', () => {
  it('parses, carries the company it named and the origin the parser observed', () => {
    const ask = parseAsk(unlock(), A, NOW);
    expect(ask.kind).toBe('unlock');
    expect('wants' in ask).toBe(false);
    expect(ask.requester.origin).toBe(A);
    expect((ask as UnlockRequest).company).toBe(CO_A);
  });

  it('AN UNLOCK THAT ALSO CARRIES ATTRIBUTES IS REFUSED BY NAME, NOT IGNORED', () => {
    /* Two different powers. A screen approving both behind one press could not
     * be read, so the whole request goes rather than half of it being
     * honoured — and the code names THIS kind, because a refusal naming the
     * wrong one tells a requester something untrue about its own message. */
    expect(codeOf(() => parseAsk(
      unlock({ wants: [{ attribute: 'given-name', required: true }] }), A, NOW)))
      .toBe('attributes-on-an-unlock');
  });

  it('and an EMPTY list on an unlock is refused too — by presence, not by content', () => {
    expect(codeOf(() => parseAsk(unlock({ wants: [] }), A, NOW)))
      .toBe('attributes-on-an-unlock');
  });

  it('AN UNLOCK THAT NAMES ITS OWN ORIGIN IS REFUSED, in either place it could put one', () => {
    /* **THIS ONE LINE IS NOT LOOSENED.** The origin no longer selects the
     * key, but it still decides who is answered and what a person is shown, and
     * anything that could name its own address could name somebody else's. */
    expect(codeOf(() => parseAsk(unlock({ origin: B }), A, NOW)))
      .toBe('claims-its-own-origin');
    expect(codeOf(() => parseAsk(
      unlock({ requester: { name: 'Payroll A', rdns: 'example.payroll-a', origin: B } }),
      A, NOW))).toBe('claims-its-own-origin');
  });

  it('STRIPPING `kind` OFF AN UNLOCK IN FLIGHT REFUSES IT — it does not become one', () => {
    /* It now lands on the disclosure branch carrying a `company`, which
     * that branch refuses by name. Either way, **no edit of this field yields
     * something a person is asked to approve.** */
    const { kind, ...withoutKind } = unlock();
    expect(kind).toBe('unlock');
    expect(codeOf(() => parseAsk(withoutKind, A, NOW))).toBe('company-on-a-disclosure');
  });

  it('`parseRequest` still refuses it BY NAME, so nothing that renders rows sees one', () => {
    expect(codeOf(() => parseRequest(unlock(), A, NOW))).toBe('not-a-disclosure');
  });

  it('THE OTHER TWO KINDS ARE UNTOUCHED: every refusal they had, they still have', () => {
    expect(codeOf(() => parseAsk(disclosure({ wants: [] }), A, NOW))).toBe('nothing-asked-for');
    expect(codeOf(() => parseAsk(
      { ...unlock(), kind: 'sign-in', wants: [] }, A, NOW))).toBe('company-on-a-sign-in');
    expect(codeOf(() => parseAsk(
      { ...disclosure(), kind: 'sign-in', wants: [] }, A, NOW)))
      .toBe('attributes-on-a-sign-in');
    expect(parseAsk(disclosure(), A, NOW).kind).toBe('disclosure');
  });

  it('AND NEITHER OF THEM MAY NAME A COMPANY — refused by presence, own code each', () => {
    /* Neither opens anything, so neither has a company to name, and a
     * requester that named one and was answered would be entitled to believe
     * the wallet had read it. `origin` and `wants` are refused in the same
     * sentence for the same reason. */
    expect(codeOf(() => parseAsk(disclosure({ company: CO_A }), A, NOW)))
      .toBe('company-on-a-disclosure');
    expect(codeOf(() => parseAsk(
      { ...disclosure(), kind: 'sign-in', wants: undefined, company: CO_A }, A, NOW)))
      .toBe('company-on-a-sign-in');
  });

  it('THE THIRD KIND WAS ADDED, NOT SUBSTITUTED: the first two are where they were', () => {
    expect(ASK_KINDS[0]).toBe('disclosure');
    expect(ASK_KINDS[1]).toBe('sign-in');
    expect(ASK_KINDS.slice(0, 2)).toEqual(['disclosure', 'sign-in']);
    expect(ASK_KINDS).toContain('unlock');
    expect(new Set(ASK_KINDS).size).toBe(ASK_KINDS.length);
  });
});

describe('§2 — THE COMPANY IS CLAIMED, SO ITS SHAPE IS WHAT CAN BE CHECKED', () => {
  it('IS THE SHAPE THE SDK ITSELF PRODUCES — measured, not described', () => {
    /*
     * `ContractAddress` is declared as a bare `string` (`ledger-v9.d.ts:33`),
     * so the type says nothing about the shape and the only way to know it is
     * to run the thing. `sampleContractAddress()` is the chain's own
     * serialiser and `encodeContractAddress` is what Compact's
     * `ContractAddress` is built from (`:475`, `:549`).
     */
    for (let i = 0; i < 20; i += 1) {
      const sampled = sampleContractAddress();
      expect(sampled, 'the SDK produced an address this wallet would refuse')
        .toMatch(/^[0-9a-f]{64}$/u);
      expect(encodeContractAddress(sampled)).toHaveLength(32);
    }
    expect(dummyContractAddress()).toMatch(/^[0-9a-f]{64}$/u);
    /* And ours are the SDK's own output, round-tripping to thirty-two bytes. */
    for (const company of [CO_A, CO_B]) {
      expect(encodeContractAddress(company)).toHaveLength(32);
    }
  });

  it('THE UPPERCASE SPELLING DECODES IN THE SDK AND IS FOLDED HERE, NOT REFUSED', () => {
    /*
     * **THIS REPLACES THE TEST THAT ASSERTED THE OPPOSITE, AND THE ENTRY SAYS
     * SO.** The old rule refused every spelling but the canonical one, which was
     * stricter than Midnight itself: the SDK's own validator accepts
     * `[0-9A-Fa-f]` (`@midnight-ntwrk/midnight-js-utils/dist/index.mjs:576`)
     * and rejects only a `0x` prefix (`:986`, `:991`). So an address every
     * Midnight tool calls valid arrived here and was refused.
     *
     * **The danger it was guarding against is unchanged and is still closed** —
     * two spellings of one company must never be two keys. Folding closes it as
     * completely as refusing did, because case-folding hex is one-to-one on
     * addresses, and unlike refusing it accepts what the chain emits. The test
     * below is the pin.
     */
    expect(encodeContractAddress(CO_A.toUpperCase())).toHaveLength(32);
    const parsed = parseAsk(unlock({ company: CO_A.toUpperCase() }), A, NOW) as UnlockRequest;
    /* **Parsed, and CANONICAL from the door inward** — the screen, the record
     * and the derivation are each handed one spelling rather than folding for
     * themselves and one of them one day forgetting to. */
    expect(parsed.company).toBe(CO_A);
  });

  it('TWO SPELLINGS OF ONE COMPANY PRODUCE IDENTICAL BYTES', () => {
    /*
     * **THE PIN THE FOLD EXISTS FOR.** A company whose records open
     * under one spelling and not the other has lost them, which is that defect with
     * a smaller radius — so the assertion is not that both spellings are
     * accepted, it is that both give the SAME KEY.
     *
     * Mixed case is in here on purpose: the SDK's pattern is `[0-9A-Fa-f]` per
     * BYTE PAIR, so `Db` and `dB` are both addresses to it.
     */
    const mixed = [...CO_A].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join('');
    expect(mixed).not.toBe(CO_A);
    expect(mixed.toLowerCase()).toBe(CO_A);

    const canonical = keyFor(CO_A);
    for (const spelling of [CO_A.toUpperCase(), mixed]) {
      expect(keyFor(spelling), spelling).toBe(canonical);
      /* And through the parser as well as through the module's own door. */
      expect(hex(unlockKeyFor(identity, askAt(B, spelling))), `${spelling} from B`)
        .toBe(canonical);
    }
    /*
     * **AND THROUGH `unlock.ts`'s OWN DOOR, WHICH THE PARSER NEVER TOUCHED.**
     * The two tests above both go through `parseAsk`, which folds first — so
     * they would pass with no fold in `unlock.ts` at all. A caller that
     * assembled an `UnlockRequest` by hand meets only this one, and it is the
     * one the derivation is actually behind.
     */
    for (const spelling of [CO_A.toUpperCase(), mixed]) {
      const forged = { ...askAt(A), company: spelling } as UnlockRequest;
      expect(hex(unlockKeyFor(identity, forged)), `${spelling} hand-built`).toBe(canonical);
    }
    /* It is still the independent walk's number, so the fold did not move it. */
    expect(canonical).toBe(hex(independentUnlockKey(CO_A)));
    /* And two DIFFERENT companies are still two different keys after folding. */
    expect(keyFor(CO_B.toUpperCase())).not.toBe(canonical);
  });

  it('A `0x` PREFIX IS STILL REFUSED, AS THE SDK ITSELF REFUSES IT', () => {
    /*
     * `assertIsContractAddress` throws *"Unexpected '0x' prefix in contract
     * address"* (`@midnight-ntwrk/midnight-js-utils/dist/index.mjs:986`,
     * `:991`). Here it needs no clause of its own: the shape is sixty-four
     * characters exactly, so a prefixed address is sixty-six.
     */
    for (const bad of [`0x${CO_A}`, `0x${CO_A}`.toUpperCase(), `0X${CO_A}`]) {
      expect(codeOf(() => parseAsk(unlock({ company: bad }), A, NOW)), bad)
        .toBe('not-a-company-address');
    }
  });

  it('A MALFORMED IDENTIFIER IS A REQUEST THAT DOES NOT KNOW WHAT IT IS ASKING FOR', () => {
    for (const bad of [
      undefined, null, 42, '', 'payroll-a', CO_A.slice(0, 63), `${CO_A}0`, `0x${CO_A}`,
      CO_A.replace('d', 'g'), ` ${CO_A}`, `${CO_A} `,
      /* `CO_A.toUpperCase()` was in this list and is now a VALID
       * spelling, pinned two tests above. Everything else it refused, it still
       * refuses: a `g` is not hex in any case, and neither is a space. */
      CO_A.toUpperCase().replace('D', 'G'), CO_A.toUpperCase().slice(0, 63),
    ]) {
      expect(codeOf(() => parseAsk(unlock({ company: bad }), A, NOW)), String(bad))
        .toBe('not-a-company-address');
    }
    /* And an unlock that names no company at all is the same refusal. */
    const { company, ...withoutCompany } = unlock();
    expect(company).toBe(CO_A);
    expect(codeOf(() => parseAsk(withoutCompany, A, NOW))).toBe('not-a-company-address');
  });

  it('AND `unlock.ts` HAS ITS OWN DOOR, so a hand-built ask meets it too', () => {
    /* The same argument made for the origin: `request.ts` is one door and a
     * caller that assembled an `UnlockRequest` itself never went through it. */
    for (const bad of [
      '', 'payroll-a', CO_A.slice(0, 63), `0x${CO_A}`,
      /* The uppercase spelling is no longer bad; a non-hex character
       * in any case still is. */
      CO_A.toUpperCase().replace('D', 'G'),
    ]) {
      const forged = { ...askAt(A), company: bad } as UnlockRequest;
      expect(() => unlockKeyFor(identity, forged), bad).toThrow(UnlockError);
    }
  });
});

describe('RULE 1 — THE ORIGIN IS OBSERVED, AND IT GATES RATHER THAN DERIVES', () => {
  it('two asks from one origin agree on the key, whatever else the message says', () => {
    const plain = askAt(A);
    const lying = askAt(A, CO_A, {
      requester: { name: 'Payroll B', rdns: 'example.payroll-b' },
      purpose: 'We are definitely payroll B.',
      nonce: 'something-else',
      expiresAt: NOW + 120_000,
    });
    expect(hex(unlockKeyFor(identity, lying))).toBe(hex(unlockKeyFor(identity, plain)));
    expect(hex(unlockKeyFor(identity, lying))).toBe(hex(independentUnlockKey(CO_A)));
    expect(hex(unlockKeyFor(identity, lying))).not.toBe(hex(independentUnlockKey(CO_B)));
  });

  it('THROUGH THE REAL CHANNEL: the browser’s origin is what is observed', () => {
    /* `MessageEvent.origin` is the browser's value and no page can write it.
     * The body here calls itself Payroll B in every field it has; the event
     * came from A; and the key is the one for the COMPANY the ask named. */
    const states: ChannelState[] = [];
    let handler: ((event: MessageEvent) => void) | null = null;
    const opener = { postMessage: (): void => {} };
    const view: ChannelWindow = {
      opener,
      addEventListener: (_t, h) => { handler = h; },
      removeEventListener: () => {},
    };
    listen(view, () => NOW, (s) => states.push(s));
    handler!({
      source: opener as unknown as MessageEventSource,
      origin: A,
      data: unlock({ requester: { name: 'Payroll B', rdns: 'example.payroll-b' } }),
    } as unknown as MessageEvent);

    const settled = states[states.length - 1]!;
    expect(settled.of).toBe('request');
    const ask = (settled as { request: UnlockRequest }).request;
    expect(ask.kind).toBe('unlock');
    expect(ask.requester.origin).toBe(A);
    expect(hex(unlockKeyFor(identity, ask))).toBe(hex(independentUnlockKey(CO_A)));
  });

  it('the parser refuses an origin nobody could have observed', () => {
    /* An opaque origin postMessages as the literal string `null`, shared by
     * every sandboxed frame in existence. `http://` goes for the reason a
     * passkey needs a secure context: an origin nobody can authenticate is a
     * name, not an identity. **This is still true when the origin no longer
     * chooses the key** — an origin the wallet cannot make sense of is one it
     * cannot show a person and cannot post an answer to. */
    for (const origin of ['null', 'http://payroll-a.example', '']) {
      expect(codeOf(() => parseAsk(unlock(), origin, NOW))).toBe('malformed-field');
    }
  });

  it('AND `unlock.ts` STILL HAS ITS OWN DOOR, NOW THAT THE PARSER IS NOT LOOSE', () => {
    /*
     * **THE DEFECT IS CLOSED AND THIS IS THE ASSERTION THAT INVERTED.**
     *
     * This test was written by watching it fail, and it recorded a split:
     * `request.ts`'s `common` accepted any non-empty string beginning
     * `https://`, so `https://a b.example` — a name with a space in it —
     * PARSED, and only this module refused it. **The line below used to assert
     * that the parser accepted it.** The shared check now parses instead of
     * matching a prefix, so it refuses it too, and the line asserts that.
     *
     * **WHAT THE TEST IS FOR HAS NOT CHANGED.** Its subject is that this module
     * has a door of its own — a caller that assembled an ask by hand never went
     * through the parser — and the loop below, which is the part that says so,
     * is untouched. What changed is that the door is no longer the ONLY one
     * that is strict, which is the whole point.
     */
    expect(() => parseAsk(unlock(), 'https://a b.example', NOW)).toThrow();
    for (const origin of ['https://a b.example', 'null', 'http://payroll-a.example', '']) {
      const forged = { ...askAt(A), requester: { ...askAt(A).requester, origin } };
      expect(() => unlockKeyFor(identity, forged as UnlockRequest), origin)
        .toThrow(UnlockError);
    }
  });
});

describe('RULE 2 — THE SAME COMPANY FROM TWO DIFFERENT HOSTS GETS THE SAME KEY', () => {
  it('THE EXPORT, EXPRESSED AS CODE: two hosts, one company, identical bytes', () => {
    /*
     * **THIS IS THE WHOLE PURPOSE.** Anything sealed under a key
     * derived from our address can only ever be opened at our address, so the
     * copy a customer takes to another client does not open and the defect reopens
     * by the mechanism meant to serve it.
     *
     * Five hosts, one company, one key — including hosts that are not ours and
     * one that no longer resolves anywhere.
     */
    const hosts = [
      A, B, 'https://payroll-a.example:8443', 'https://books.some-accountant.example',
      'https://a-client-somebody-else-wrote.example',
    ];
    const keys = new Set(hosts.map((host) => hex(unlockKeyFor(identity, askAt(host, CO_A)))));
    expect(keys.size, 'the same company gave different keys at different hosts').toBe(1);
    expect([...keys][0]).toBe(hex(independentUnlockKey(CO_A)));
  });

  it('THE ORIGIN IS IN NO PART OF THE DERIVATION — the source says so as well', () => {
    /*
     * The property is *the key is a pure function of the seed and the company*,
     * and the way it dies is somebody putting the origin back in "for safety".
     * The test above would catch that; this says the same thing about the code,
     * so a reader does not have to run the suite to see it. **`originOf` is
     * called and its result is discarded** — that is the gate.
     */
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'unlock.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function unlockKeyFor'));
    const code = body.slice(0, body.indexOf('\n}')).replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(code).toContain('originOf(ask);');
    expect(code).toContain('companyOf(ask)');
    /* The origin's value reaches nothing: it is not assigned and not encoded. */
    expect(code).not.toContain('const origin');
    expect(code).not.toContain('encode(origin');
  });

  it('matches the independent walk, and the recorded bytes for three companies', () => {
    /*
     * **THESE VECTORS ARE REPLACED RATHER THAN ADDING TO THEM, AND THAT IS
     * DELIBERATE, DECLARED AND ARGUED.** `Purposes.Unlock`
     * has no obligation to old bytes TODAY and will never be free again,
     * because payroll's half is unbuilt and **not one byte anywhere has been
     * sealed under an older key.** The four purposes older than `Unlock` are
     * untouched and their vectors in `derivation.portability.test.ts` are
     * byte-identical.
     *
     * Every number below was produced by the INDEPENDENT walk above and is
     * checked against both it and `unlock.ts`, so it is not this repository's
     * code agreeing with itself.
     */
    const VECTORS: Readonly<Record<string, string>> = {
      'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8':
        '7a9ac85d4b33d2cca39b5b15a8ff1e2b88a0e891ef452f78562b415db33460b7',
      '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e':
        'd1aa99d5be6d5e49e391a705e4253323051cfa92a5f67e2c407909a6465bd71e',
      /* The all-zero address is a correctly-shaped one — `dummyContractAddress()`
       * returns it — so it gets a key like any other rather than a special case. */
      '0000000000000000000000000000000000000000000000000000000000000000':
        '331df3aa0e33c47e7ec698469935ae0ec00244ca65213f4c96f6b7eaf9c41b57',
    };
    let checked = 0;
    for (const [company, expected] of Object.entries(VECTORS)) {
      expect(hex(unlockKeyFor(identity, askAt(A, company))), company).toBe(expected);
      expect(hex(independentUnlockKey(company)), `${company} independently`).toBe(expected);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it('THE SALT SAYS `v2`, and the old bytes for the same string are not these', () => {
    /* The domain moved with the ingredient. A round that changed what goes in
     * and left `v1` on the tin would have two different derivations sharing one
     * domain — and this is the only moment the string is free to move. */
    const v1 = hkdf(
      sha256, independentAuthority('unlock', 0),
      new TextEncoder().encode('midnight-identity/unlock/v1'),
      new TextEncoder().encode(CO_A), 32);
    expect(hex(v1)).not.toBe(keyFor(CO_A));
  });
});

describe('RULE 3 — TWO COMPANIES NEVER GET THE SAME KEY, AT FULL WIDTH', () => {
  it('five hundred companies give five hundred different keys', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(keyFor(sha256(new TextEncoder().encode(`company-${i}`))
        .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')));
    }
    expect(seen.size).toBe(500);
  });

  it('A TRUNCATED ADDRESS IS NOT THE ADDRESS: two that share sixty-three characters', () => {
    /*
     * **THE MUTATION THIS KILLS IS `company.slice(0, n)`.** The finding stands
     * and applies here unchanged: a selector narrower than the thing it selects
     * can be ground, and that round ground a pair onto one 31-bit index in
     * 2,855,179,063 tries on one unoptimised core. **The address goes in whole.**
     *
     * These two differ in the LAST character only, so any truncation shorter
     * than the whole thing makes them one company.
     */
    const first = CO_A;
    const second = `${CO_A.slice(0, 63)}${CO_A.endsWith('8') ? '9' : '8'}`;
    expect(first).not.toBe(second);
    expect(first.slice(0, 63)).toBe(second.slice(0, 63));
    expect(keyFor(first)).not.toBe(keyFor(second));
  });

  it('AND A FOLDED ONE IS NOT EITHER: two halves, swapped', () => {
    /* **THE MUTATION THIS KILLS IS ANY XOR- OR ADD-FOLD OF THE TWO HALVES.**
     * `X||Y` and `Y||X` fold to the same value under every commutative fold and
     * are plainly two different companies. No grinding required to find them. */
    const first = CO_A;
    const second = `${CO_A.slice(32)}${CO_A.slice(0, 32)}`;
    expect(first).not.toBe(second);
    expect([...first].sort().join('')).toBe([...second].sort().join(''));
    expect(keyFor(first)).not.toBe(keyFor(second));
  });

  it('THE REJECTED DESIGN’S DEFECT IS REAL, and it is found in a few thousand hashes', () => {
    /*
     * NOT HYPOTHETICAL CAUTION — THE MEASURED DEFECT, in the shape
     * `subwallets.test.ts` uses. The rejected design said to derive
     * `Purposes.Seat`, and `authority(purpose, index)`
     * selects with a NUMBER below 2^31. **Reaching a seat from a 256-bit
     * address means squeezing it into 31 bits**, and the search below finds two
     * ordinary company addresses that land on one index by walking a few
     * thousand of them.
     *
     * A measurement of the targeted version at full width — a NAMED victim's index
     * matched in 2,855,179,063 tries, 4,840.9 seconds, one core.
     * Nothing about that number changes when the
     * thing being squeezed is an address instead of a hostname.
     */
    const index31 = (company: string): number => {
      const digest = sha256(new TextEncoder().encode(company));
      return ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!)
        >>> 1;
    };
    const addressOf = (i: number): string => hex(sha256(new TextEncoder().encode(`co-${i}`)));
    const at = new Map<number, string>();
    let collision: readonly [string, string] | null = null;
    for (let i = 0; i < 400_000 && collision === null; i += 1) {
      const company = addressOf(i);
      const index = index31(company);
      const already = at.get(index);
      if (already !== undefined) collision = [already, company];
      else at.set(index, company);
    }
    expect(collision, 'no pair of companies collided in 400,000 tries').not.toBeNull();
    const [one, two] = collision!;
    expect(one).not.toBe(two);
    expect(index31(one)).toBe(index31(two));
    /* Under the rejected design those two COMPANIES ARE ONE COMPANY. */
    expect(hex(identity.authority(Purposes.Seat, index31(one))))
      .toBe(hex(identity.authority(Purposes.Seat, index31(two))));
    /* Under the shipped one they are not. */
    expect(keyFor(one)).not.toBe(keyFor(two));
  });

  it('A WALLET REBUILT FROM ITS SEED DERIVES THE IDENTICAL KEY', () => {
    /* The shape: a recovery that derived a different key would leave
     * somebody's company records unopenable for ever, with nothing broken and
     * nothing to fix. Three doors into an identity, one key. */
    const fromWordsAgain = identityFromWords(TEST_MNEMONIC);
    const fromSecret = identityFromSecret(secretFromWords(TEST_MNEMONIC));
    const ask = askAt(A);
    expect(hex(unlockKeyFor(fromWordsAgain, ask))).toBe(hex(unlockKeyFor(identity, ask)));
    expect(hex(unlockKeyFor(fromSecret, ask))).toBe(hex(unlockKeyFor(identity, ask)));
  });

  it('and the same wallet asked twice, an hour apart, gives the same bytes', () => {
    expect(hex(unlockKeyFor(identity, askAt(A, CO_A, { nonce: 'first' }))))
      .toBe(hex(unlockKeyFor(identity, askAt(B, CO_A, { nonce: 'later' }))));
  });
});

describe('RULE 4 — IT IS NEVER A MONEY KEY', () => {
  it('IS NONE OF THE KEYS ANY WALLET THIS INTERFACE OFFERS WOULD SPEND WITH', () => {
    /*
     * The standing instruction, unchanged: *walk every
     * account, role and index a wallet would show and assert the released bytes
     * are none of them.* The walk is INDEPENDENT — `@scure/bip32` straight down
     * `m/44'/2400'/account'/role/index` — so it does not inherit any belief
     * from `derivation.ts` about where a wallet lives.
     *
     * **THIS MUST NOT BE WEAKENED AND IS NOT.** The only change is which
     * identifiers the released keys are derived for.
     */
    const root = HDKey.fromMasterSeed(seedFromWords(TEST_MNEMONIC));
    const spendable = new Set<string>();
    for (const account of [...WALLET_ACCOUNTS, 1, 12, 13]) {
      for (const role of [0, 1, 2, 3, 4]) {
        for (const index of [0, 1, 2, 3]) {
          const k = root.derive(`m/44'/2400'/${account}'/${role}/${index}`).privateKey;
          if (k) spendable.add(hex(k));
        }
      }
    }
    expect(spendable.size).toBe((WALLET_ACCOUNTS.length + 3) * 5 * 4);

    /* Every key this wallet's own door hands out, too — including account 0's,
     * which `moneyAt` derives rather than the walk above. */
    for (const account of WALLET_ACCOUNTS) {
      const keys = identity.moneyAt(account);
      for (const key of [keys.zswap, keys.dust, keys.night]) spendable.add(hex(key));
    }

    for (const company of [
      CO_A, CO_B, dummyContractAddress(), sampleContractAddress(), sampleContractAddress(),
    ]) {
      const released = unlockKeyFor(identity, askAt(A, company));
      expect(released).toHaveLength(32);
      expect(spendable.has(hex(released)), `the key for ${company} is spendable`).toBe(false);
    }
  });

  it('is not the authority root, not its parent, and not any other purpose’s key', () => {
    const authority = new Set<string>([hex(independentRoot)]);
    for (const purpose of Object.values(Purposes)) {
      for (const index of [0, 1, 2, 41]) {
        authority.add(hex(independentAuthority(purpose as Purpose, index)));
      }
    }
    /* The parent is in that set, at `unlock/0`. **A released key must not be
     * it**: releasing the parent would hand one company the key to every one. */
    expect(authority.has(hex(identity.authority(Purposes.Unlock, 0)))).toBe(true);
    for (const company of [CO_A, CO_B, dummyContractAddress()]) {
      expect(authority.has(keyFor(company)), company).toBe(false);
    }
  });
});

describe('RULE 5 — THE REMEMBERED LIST IS NEVER AN INPUT', () => {
  it('THE FUNCTION HAS NOWHERE TO PUT ONE: an identity and an ask, and no third thing', () => {
    /*
     * **THE CHANGE'S QUIETEST RULE AND ITS MOST DANGEROUS ONE.** The moment the
     * list of remembered pairs reaches the derivation, a recovered wallet — or
     * one whose history was cleared, or a second device — stops opening a
     * company's records, and that is the defect arriving by a different door with
     * nothing broken and nothing to fix.
     *
     * The screen test `unlock-screen.test.tsx` drives the whole component with
     * a history and without one and compares the bytes. This is the same claim
     * said at the signature, where it is cheapest to read.
     */
    expect(unlockKeyFor).toHaveLength(2);
    const withHistory = recordRelease(emptyProfile(NOW), {
      at: NOW,
      nonce: 'n1',
      recipient: { origin: B, name: 'Payroll B', rdns: 'example.payroll-b' },
      company: CO_A,
    }, NOW);
    expect(originsFor(withHistory, CO_A)).toEqual([B]);
    /* The list exists, says something, and cannot reach the key: there is no
     * argument for it and `unlock.ts` imports nothing from `model.ts`. */
    const code = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'unlock.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(code).not.toContain('model.js');
    expect(code).not.toContain('originsFor');
    expect(code).not.toContain('releasesOf');
  });

  it('NOTHING IN THE MODULE READS A CLOCK, A STORE OR A RANDOM NUMBER', () => {
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'unlock.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '');
    for (const forbidden of [
      'getRandomValues', 'Date.now', 'localStorage', 'sessionStorage', 'indexedDB',
      'performance.now', 'fetch(',
    ]) {
      expect(code.includes(forbidden), `\`${forbidden}\` appears in unlock.ts`).toBe(false);
    }
  });

  it('A LOST LIST COSTS A WARNING AND NEVER ACCESS', () => {
    /* An empty profile knows nothing about anybody and derives every key
     * identically to one that has been used for a year. */
    const used = [CO_A, CO_B].reduce((profile, company) => recordRelease(profile, {
      at: NOW, nonce: 'n', recipient: { origin: A, name: 'A', rdns: 'a' }, company,
    }, NOW), emptyProfile(NOW));
    expect(originsFor(used, CO_A)).toEqual([A]);
    expect(originsFor(emptyProfile(NOW), CO_A)).toEqual([]);
    for (const company of [CO_A, CO_B]) {
      expect(keyFor(company)).toBe(hex(independentUnlockKey(company)));
    }
  });

  it('and it answers the question the screen asks it: which OTHER hosts, in order', () => {
    let profile = emptyProfile(NOW);
    for (const [origin, company] of [
      [A, CO_A], [A, CO_A], [B, CO_A], [B, CO_B],
    ] as const) {
      profile = recordRelease(
        profile, { at: NOW, nonce: 'n', recipient: { origin, name: 'n', rdns: 'r' }, company },
        NOW);
    }
    expect(originsFor(profile, CO_A)).toEqual([A, B]);
    expect(originsFor(profile, CO_B)).toEqual([B]);
    expect(originsFor(profile, dummyContractAddress())).toEqual([]);
  });
});

describe('THE MESSAGE THAT CROSSES, AND THE READER ON THE OTHER SIDE', () => {
  const ask = askAt(A);
  const expecting = { atOrigin: A, expectingNonce: 'n1', forCompany: CO_A };

  it('carries the key, the company, the nonce and the observed origin, and nothing else', () => {
    const released = releaseFor(identity, ask, NOW);
    expect(Object.keys(released).sort())
      .toEqual(['at', 'company', 'key', 'nonce', 'origin', 'schema']);
    expect(released.schema).toBe(RELEASE_SCHEMA);
    expect(released.origin).toBe(A);
    expect(released.company).toBe(CO_A);
    expect(released.nonce).toBe('n1');
    expect(released.at).toBe(NOW);
    expect(hex(fromBase64Url(released.key))).toBe(hex(independentUnlockKey(CO_A)));
  });

  it('is signed by nothing, and no spending key is used anywhere in the flow', () => {
    const released = releaseFor(identity, ask, NOW) as unknown as Record<string, unknown>;
    expect('signature' in released).toBe(false);
    expect('verifyingKey' in released).toBe(false);
    expect('scheme' in released).toBe(false);
    expect('address' in released).toBe(false);
  });

  it('THE READER TAKES ITS OWN ORIGIN, ITS OWN NONCE AND ITS OWN COMPANY', () => {
    const released = releaseFor(identity, ask, NOW);
    const good = readRelease(released, expecting);
    expect(good.ok).toBe(true);
    expect(good.ok && hex(good.key)).toBe(hex(independentUnlockKey(CO_A)));

    /* The message agrees with itself perfectly and is still refused at B. */
    const elsewhere = readRelease(released, { ...expecting, atOrigin: B });
    expect(!elsewhere.ok && elsewhere.code).toBe('origin-mismatch');

    /* **THE ADDITION, AND ON THIS SIDE IT IS THE ONE THAT MATTERS.** A page
     * that used a key minted for another company would seal records under bytes
     * nobody will look for again. */
    const wrongCompany = readRelease(released, { ...expecting, forCompany: CO_B });
    expect(!wrongCompany.ok && wrongCompany.code).toBe('company-mismatch');

    const stale = readRelease(released, { ...expecting, expectingNonce: 'another' });
    expect(!stale.ok && stale.code).toBe('nonce-mismatch');
  });

  it('refuses anything that is not a release, and any key that is not 32 bytes', () => {
    for (const junk of [null, undefined, 42, 'a string', {}, { schema: 'something/else' }]) {
      const read = readRelease(junk, expecting);
      expect(!read.ok && read.code).toBe('not-a-release');
    }
    const short = {
      ...releaseFor(identity, ask, NOW), key: toBase64Url(new Uint8Array(31)),
    };
    expect(readRelease(short, expecting).ok).toBe(false);
    const notBytes = { ...releaseFor(identity, ask, NOW), key: 'not base64url!!' };
    expect(readRelease(notBytes, expecting).ok).toBe(false);
  });

  it('AND A KEY FOR COMPANY A CANNOT OPEN COMPANY B, WHICH IS WHY NOTHING IS SIGNED', () => {
    /* A disclosure needs the origin inside the signed bytes or company A's
     * disclosure replays to company B. A released key cannot be replayed
     * anywhere: B's records are sealed under B's key, and the key for A is not
     * it. **Replay is impossible by construction rather than by a check.**
     * This moves that binding from a HOST to a COMPANY, which is what it should
     * always have been about. */
    expect(hex(fromBase64Url(releaseFor(identity, askAt(A, CO_A), NOW).key)))
      .not.toBe(hex(fromBase64Url(releaseFor(identity, askAt(A, CO_B), NOW).key)));
    /* And the same company from the other host is the same key on the wire. */
    expect(releaseFor(identity, askAt(B, CO_A), NOW).key)
      .toBe(releaseFor(identity, askAt(A, CO_A), NOW).key);
  });
});

describe('WHAT IS WRITTEN DOWN, AND WHAT MUST NOT BE', () => {
  const recipient = { origin: A, name: 'Payroll A', rdns: 'example.payroll-a' };

  it('records that a key went, to whom, for which company, and when', () => {
    const profile = recordRelease(
      emptyProfile(NOW), { at: NOW, nonce: 'n1', recipient, company: CO_A }, NOW);
    expect(releasesOf(profile)).toHaveLength(1);
    const entry = releasesOf(profile)[0]!;
    expect(Object.keys(entry).sort()).toEqual(['at', 'company', 'nonce', 'recipient']);
    expect(entry.recipient.origin).toBe(A);
    expect(entry.company).toBe(CO_A);
    expect(entry.at).toBe(NOW);
  });

  it('THE KEY IS IN NO PART OF WHAT IS STORED — not the bytes, not a hash of them', () => {
    /* *The key itself is never recorded. Anywhere.* The whole
     * sealed value is one JSON string, so this asks the only question that
     * covers every field at once, including ones added later. */
    const released = releaseFor(identity, askAt(A), NOW);
    const profile = recordRelease(
      emptyProfile(NOW), { at: NOW, nonce: 'n1', recipient, company: CO_A }, NOW);
    const stored = JSON.stringify(profile);
    expect(stored).not.toContain(released.key);
    expect(stored).not.toContain(hex(fromBase64Url(released.key)));
    expect(stored).not.toContain(hex(sha256(fromBase64Url(released.key))));
    /* And the first eight characters would be enough to be a leak. */
    expect(stored).not.toContain(released.key.slice(0, 8));
    /* The COMPANY is in there, and that is not a leak: it is a public address
     * on a chain, and it is the thing the warning is computed from. */
    expect(stored).toContain(CO_A);
  });

  it('A RELEASE TOUCHES NO GRANT — the erased-grant trap, one kind further along', () => {
    const withValues = grantTo(
      { ...emptyProfile(NOW), held: [] }, recipient, 3, [], NOW);
    const after = recordRelease(
      withValues, { at: NOW, nonce: 'n1', recipient, company: CO_A }, NOW);
    expect(after.grants).toEqual(withValues.grants);
    expect(releasesOf(after)).toHaveLength(1);
  });

  it('a profile written before the change reads as no releases, never as lost ones', () => {
    const old = { ...emptyProfile(NOW) } as { releases?: unknown };
    delete old.releases;
    expect(releasesOf(old as Parameters<typeof releasesOf>[0])).toEqual([]);
    expect(originsFor(old as Parameters<typeof releasesOf>[0], CO_A)).toEqual([]);
  });
});

/* ══════════════════════════ THE KEYRING KEY ══════════════════════════════ */

const PERSON = 'usr_AbCdEf123456';
const OTHER_PERSON = 'usr_ZyXwVu654321';
const SIGNED_IN = 'mn_addr_stagenet1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const SOMEBODY_ELSES = 'mn_addr_stagenet1ppppppppppppppppppppppppppppppppppppppppppppppppppppppp';
const KEYRING_SALT = new TextEncoder().encode('midnight-identity/keyring/v1');
const independentKeyringKey = (person: string): Uint8Array => hkdf(
  sha256, independentAuthority('keyring', 0), KEYRING_SALT, new TextEncoder().encode(person), 32);

/** A keyring ask on the wire. No `origin`, no `wants`; a person, and the address signed in as. */
const keyringWire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'keyring',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'So this page can open the keys saved for you here.',
  person: PERSON,
  signedInAs: SIGNED_IN,
  nonce: 'k1',
  expiresAt: NOW + 60_000,
  ...over,
});
const keyringAt = (origin: string, over: Record<string, unknown> = {}): KeyringRequest =>
  parseAsk(keyringWire(over), origin, NOW) as KeyringRequest;
const holdsSignedIn = (address: string): boolean => address === SIGNED_IN;

describe('THE KEYRING ASK IS ITS OWN KIND, AND ITS FIELDS BELONG TO IT ALONE', () => {
  it('parses: the person whole, the signed-in address whole, no company unless one is named', () => {
    const ask = keyringAt(A);
    expect(ask.kind).toBe('keyring');
    expect(ask.requester.origin).toBe(A);
    expect(ask.person).toBe(PERSON);
    expect(ask.signedInAs).toBe(SIGNED_IN);
    expect(ask.company).toBeNull();
    expect(keyringAt(A, { signedInAs: undefined }).signedInAs).toBeNull();
  });

  it('A COMPANY IN ANY SPELLING IS FOLDED, AND A MALFORMED ONE IS REFUSED BY NAME', () => {
    expect(keyringAt(A, { company: CO_A.toUpperCase() }).company).toBe(CO_A);
    expect(codeOf(() => keyringAt(A, { company: `0x${CO_A.slice(2)}` }))).toBe('not-a-company-address');
  });

  it('a person the wallet cannot use, or an address that is not one, is refused by name', () => {
    for (const person of [undefined, '', 'usr with space', 'x'.repeat(65), 12, 'usr_ab\ncd']) {
      expect(codeOf(() => keyringAt(A, { person })), String(person)).toBe('not-a-person');
    }
    for (const signedInAs of ['', 'MN_ADDR_STAGENET1QQQQQQQQ', 'not an address', 7, 'mn_addr1b']) {
      expect(codeOf(() => keyringAt(A, { signedInAs })), String(signedInAs))
        .toBe('not-a-signed-in-address');
    }
  });

  it('ATTRIBUTES OR AN INBOX KEY ON A KEYRING ASK ARE REFUSED, NOT IGNORED', () => {
    expect(codeOf(() => keyringAt(A, { wants: [] }))).toBe('attributes-on-a-keyring');
    expect(codeOf(() => keyringAt(A, { inboxPublicKey: 'ab'.repeat(32) })))
      .toBe('inbox-key-on-a-keyring');
  });

  it('EVERY OTHER KIND REFUSES A PERSON OR A SIGNED-IN ADDRESS BY PRESENCE', () => {
    expect(codeOf(() => parseAsk(unlock({ person: PERSON }), A, NOW)))
      .toBe('keyring-fields-on-another-kind');
    expect(codeOf(() => parseAsk(unlock({ signedInAs: SIGNED_IN }), A, NOW)))
      .toBe('keyring-fields-on-another-kind');
    expect(codeOf(() => parseAsk(disclosure({ person: PERSON }), A, NOW)))
      .toBe('keyring-fields-on-another-kind');
    expect(codeOf(() => parseAsk({ ...unlock(), kind: 'sign-in', company: undefined, person: PERSON }, A, NOW)))
      .toBe('keyring-fields-on-another-kind');
  });

  it('STRIPPING `kind` OFF A KEYRING ASK IN FLIGHT REFUSES IT', () => {
    const { kind: _gone, ...stripped } = keyringWire();
    expect(codeOf(() => parseAsk(stripped, A, NOW))).toBe('keyring-fields-on-another-kind');
  });
});

describe('THE KEYRING KEY IS THE PERSON\'S AT THE SITE, AND NEVER A COMPANY\'S', () => {
  it('matches the independent walk and the recorded bytes for two people', () => {
    expect(hex(keyringKeyFor(identity, keyringAt(A)))).toBe(hex(independentKeyringKey(PERSON)));
    /* Recorded from a walk outside this repository's derivation, so a changed salt,
     * parent or encoding cannot pass by moving both sides of this file together. */
    expect(hex(keyringKeyFor(identity, keyringAt(A))))
      .toBe('e6a594f1c3837597fbf9d8417c924d0aefd10083efc13ca2e9aa9a480beb37cc');
    expect(hex(keyringKeyFor(identity, keyringAt(A, { person: OTHER_PERSON }))))
      .toBe('8a0e2fc66cb70ec34eeb707135976e4ef1051751c3f5673fb3c8b572bb81f38b');
  });

  it('THE SAME PERSON FROM TWO HOSTS, AND WITH OR WITHOUT A SIGNED-IN ADDRESS, GETS THE SAME KEY', () => {
    const here = hex(keyringKeyFor(identity, keyringAt(A)));
    expect(hex(keyringKeyFor(identity, keyringAt(B)))).toBe(here);
    expect(hex(keyringKeyFor(identity, keyringAt(A, { signedInAs: SOMEBODY_ELSES })))).toBe(here);
    expect(hex(keyringKeyFor(identity, keyringAt(A, { signedInAs: undefined })))).toBe(here);
    expect(hex(keyringKeyFor(identity, keyringAt(A, { company: CO_B })))).toBe(here);
  });

  it('two people, and two wallets, never get the same key; a rebuilt wallet does', () => {
    expect(hex(keyringKeyFor(identity, keyringAt(A, { person: OTHER_PERSON }))))
      .not.toBe(hex(keyringKeyFor(identity, keyringAt(A))));
    const another = identityFromSecret(new Uint8Array(32).fill(7));
    expect(hex(keyringKeyFor(another, keyringAt(A)))).not.toBe(hex(keyringKeyFor(identity, keyringAt(A))));
    const rebuilt = identityFromSecret(secretFromWords(TEST_MNEMONIC));
    expect(hex(keyringKeyFor(rebuilt, keyringAt(A)))).toBe(hex(keyringKeyFor(identity, keyringAt(A))));
  });

  it('IS NO COMPANY KEY, NO AUTHORITY KEY AND NO MONEY KEY', () => {
    const key = hex(keyringKeyFor(identity, keyringAt(A)));
    for (const company of [CO_A, CO_B]) expect(key).not.toBe(keyFor(company));
    for (const purpose of Object.values(Purposes) as Purpose[]) {
      for (const index of [0, 1]) expect(key).not.toBe(hex(identity.authority(purpose, index)));
    }
    for (const account of WALLET_ACCOUNTS) {
      const money = identity.moneyAt(account);
      for (const k of [money.zswap, money.dust, money.night]) expect(key).not.toBe(hex(k));
    }
  });

  it('AND `unlock.ts` HAS ITS OWN DOORS FOR A HAND-BUILT ASK', () => {
    const good = keyringAt(A);
    const badOrigin = { ...good, requester: { ...good.requester, origin: 'http://payroll-a.example' } };
    expect(codeOf(() => keyringKeyFor(identity, badOrigin))).toBe('origin-not-usable');
    expect(codeOf(() => keyringKeyFor(identity, { ...good, person: 'has space' }))).toBe('person-not-usable');
    expect(() => keyringKeyFor(identity, { ...good, person: 'has space' })).toThrow(UnlockError);
  });

  it('THE ORIGIN AND THE SIGNED-IN ADDRESS ARE IN NO PART OF THE DERIVATION - the source says so too', () => {
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'unlock.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function keyringKeyFor'));
    const code = body.slice(0, body.indexOf('\n}')).replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(code).toContain('originOf(ask);');
    expect(code).toContain('Purposes.Keyring');
    expect(code).not.toContain('signedInAs');
    expect(code).not.toContain('const origin');
    expect(keyringKeyFor).toHaveLength(2);
  });
});

describe('THE KEYRING RELEASE: THE GATE IS INSIDE IT, AND THE READER TAKES ITS OWN VALUES', () => {
  it('a wallet holding the signed-in address gives the keyring key and nothing else', () => {
    const released = keyringReleaseFor(identity, keyringAt(A), NOW, holdsSignedIn);
    expect(Object.keys(released).sort()).toEqual(
      ['at', 'committeeKey', 'company', 'companyKey', 'key', 'nonce', 'origin', 'person', 'schema', 'signedInAs']);
    expect(released.committeeKey).toBeNull();
    expect(released.schema).toBe(KEYRING_RELEASE_SCHEMA);
    expect(released.origin).toBe(A);
    expect(hex(fromBase64Url(released.key))).toBe(hex(independentKeyringKey(PERSON)));
    expect(released.companyKey).toBeNull();
    expect('signature' in (released as unknown as Record<string, unknown>)).toBe(false);
  });

  it('A WALLET THAT DOES NOT HOLD THE SIGNED-IN ADDRESS BUILDS NOTHING', () => {
    const asked: string[] = [];
    const holdsNothing = (address: string): boolean => { asked.push(address); return false; };
    expect(codeOf(() => keyringReleaseFor(identity, keyringAt(A), NOW, holdsNothing)))
      .toBe('address-not-held');
    /* It was asked about the address the page named, and about nothing else. */
    expect(asked).toEqual([SIGNED_IN]);
    expect(codeOf(() => keyringReleaseFor(
      identity, keyringAt(A, { signedInAs: SOMEBODY_ELSES }), NOW, holdsSignedIn)))
      .toBe('address-not-held');
  });

  it('with no signed-in address named there is nothing to gate on, and the key is given', () => {
    const released = keyringReleaseFor(
      identity, keyringAt(A, { signedInAs: undefined }), NOW, () => false);
    expect(released.signedInAs).toBeNull();
    expect(hex(fromBase64Url(released.key))).toBe(hex(independentKeyringKey(PERSON)));
  });

  it('WITH A COMPANY, THE ANSWER CARRIES THAT COMPANY\'S KEY, DERIVED EXACTLY AS AN UNLOCK DERIVES IT', () => {
    const released = keyringReleaseFor(identity, keyringAt(A, { company: CO_B }), NOW, holdsSignedIn);
    expect(released.company).toBe(CO_B);
    expect(hex(fromBase64Url(released.companyKey!))).toBe(hex(independentUnlockKey(CO_B)));
    expect(released.companyKey).toBe(releaseFor(identity, askAt(A, CO_B), NOW).key);
    expect(released.companyKey).not.toBe(released.key);
  });

  it('WITH A COMPANY, THE ANSWER ALSO CARRIES THE PUBLIC COMMITTEE KEY FOR THAT COMPANY, AND NO SECRET BESIDE IT', () => {
    const released = keyringReleaseFor(identity, keyringAt(A, { company: CO_B }), NOW, holdsSignedIn);
    expect(released.committeeKey).toEqual(committeeKeyFor(identity, CO_B));
    expect(released.committeeKey).not.toEqual(committeeKeyFor(identity, CO_A));
    const signing = committeeSigningKeyFor(identity, CO_B).value;
    expect(JSON.stringify(released)).not.toContain(signing);
  });

  it('THE READER REFUSES AN ANSWER TO ANY OTHER QUESTION', () => {
    const expecting: {
      atOrigin: string; expectingNonce: string; person: string;
      signedInAs: string | null; forCompany: string | null;
    } = {
      atOrigin: A, expectingNonce: 'k1', person: PERSON, signedInAs: SIGNED_IN, forCompany: null,
    };
    const released = keyringReleaseFor(identity, keyringAt(A), NOW, holdsSignedIn);
    const read = readKeyringRelease(released, expecting);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(hex(read.key)).toBe(hex(independentKeyringKey(PERSON)));
      expect(read.companyKey).toBeNull();
    }
    const refused = (over: Record<string, unknown>, exp = expecting): string => {
      const r = readKeyringRelease({ ...released, ...over }, exp);
      return r.ok ? 'accepted' : r.code;
    };
    expect(refused({ schema: RELEASE_SCHEMA })).toBe('not-a-release');
    expect(refused({ origin: B })).toBe('origin-mismatch');
    expect(refused({ person: OTHER_PERSON })).toBe('person-mismatch');
    expect(refused({ signedInAs: SOMEBODY_ELSES })).toBe('person-mismatch');
    expect(refused({ signedInAs: null })).toBe('person-mismatch');
    expect(refused({ nonce: 'k2' })).toBe('nonce-mismatch');
    expect(refused({ key: toBase64Url(new Uint8Array(31)) })).toBe('unusable-key');
    expect(refused({ company: CO_A, companyKey: released.key })).toBe('company-mismatch');
    expect(refused({ companyKey: released.key })).toBe('company-mismatch');
    /* A committee key nobody asked for is an answer to another question. */
    expect(refused({ committeeKey: committeeKeyFor(identity, CO_A) })).toBe('company-mismatch');
    expect(refused({ at: 1.5 })).toBe('not-a-release');
    /* Asked about a company, answered without one, or with a different one. */
    const withCompany = { ...expecting, forCompany: CO_A };
    expect(refused({}, withCompany)).toBe('company-mismatch');
    const forB = keyringReleaseFor(identity, keyringAt(A, { company: CO_B }), NOW, holdsSignedIn);
    const r = readKeyringRelease(forB, withCompany);
    expect(r.ok ? 'accepted' : r.code).toBe('company-mismatch');
    const forA = keyringReleaseFor(identity, keyringAt(A, { company: CO_A.toUpperCase() }), NOW, holdsSignedIn);
    const good = readKeyringRelease(forA, withCompany);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(hex(good.companyKey!)).toBe(hex(independentUnlockKey(CO_A)));
      expect(good.committeeKey).toEqual(committeeKeyFor(identity, CO_A));
    }
    const committee = { company: CO_A, committeeKey: committeeKeyFor(identity, CO_A) };
    expect(refused({ ...committee, companyKey: toBase64Url(new Uint8Array(8)) }, withCompany))
      .toBe('unusable-key');
    /* A company key that is the keyring key itself has been put in the wrong place. */
    expect(refused({ ...committee, companyKey: released.key }, withCompany)).toBe('unusable-key');
    /* A company key with no committee key beside it, or with something else there. */
    expect(refused({ company: CO_A, companyKey: forA.companyKey, committeeKey: null }, withCompany))
      .toBe('unusable-key');
    expect(refused({ company: CO_A, companyKey: forA.companyKey, committeeKey: { tag: 'schnorr', value: 'ab' } }, withCompany))
      .toBe('unusable-key');
  });

  it('A COMPANY-KEY RELEASE IS NOT A KEYRING RELEASE, AND THE REVERSE', () => {
    const company = releaseFor(identity, askAt(A), NOW);
    const r = readKeyringRelease(company, {
      atOrigin: A, expectingNonce: 'n1', person: PERSON, signedInAs: null, forCompany: null,
    });
    expect(r.ok ? 'accepted' : r.code).toBe('not-a-release');
    const keyring = keyringReleaseFor(identity, keyringAt(A), NOW, holdsSignedIn);
    const back = readRelease(keyring, { atOrigin: A, expectingNonce: 'k1', forCompany: CO_A });
    expect(back.ok ? 'accepted' : back.code).toBe('not-a-release');
  });
});

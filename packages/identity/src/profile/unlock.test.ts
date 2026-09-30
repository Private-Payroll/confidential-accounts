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
import type { AccountAddress, CompanyLabel } from './company-label.js';

/**
 * **THE WALLET RELEASES A KEY, AND THE FIVE THINGS THAT MAKE THAT SAFE.**
 *
 * **ONE INGREDIENT CHANGED AND NOTHING ELSE.** An earlier version derived the released key
 * from the requesting ORIGIN. The origin is the one thing the wallet can trust,
 * so using it felt safe — **and a hostname is a deployment detail**, so anything
 * sealed under a key derived from ours can only ever be opened at ours.
 * The key is now derived from **the company's label**, which its founding
 * signer's wallet drew and its account carries, and the origin keeps deciding
 * who may be handed something.
 *
 * The five rules this file checks, in their own order:
 *
 *   1. the label goes in AT FULL WIDTH, as its own text;
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
 * **TWO COMPANIES, BY THEIR LABELS, AND THE ACCOUNT THE FIRST ONE'S LABEL SITS
 * ON.** The account address came out of `sampleContractAddress()`; the labels
 * are written the one way `company-label.ts` writes one.
 */
const ACCOUNT_A = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
const CO_A = 'co_7a1e2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8' as CompanyLabel;
const CO_B = 'co_54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e' as CompanyLabel;
/** A label for any address the SDK samples. */
const labelOf = (address: string): CompanyLabel => `co_${address}` as CompanyLabel;

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
const UNLOCK_SALT = new TextEncoder().encode('midnight-identity/unlock/v3');
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
    /* And the company's account, on its own, the same way. RED WHEN: `account` is ignored on these kinds. */
    expect(codeOf(() => parseAsk(disclosure({ account: ACCOUNT_A }), A, NOW))).toBe('company-on-a-disclosure');
    expect(codeOf(() => parseAsk(
      { ...disclosure(), kind: 'sign-in', wants: undefined, account: ACCOUNT_A }, A, NOW))).toBe('company-on-a-sign-in');
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
  it('A COMPANY IS NAMED BY ITS LABEL, AND AN ACCOUNT\'S ADDRESS IS REFUSED WHERE A LABEL IS ASKED', () => {
    /*
     * **THE ONE MISTAKE THE SPELLING EXISTS TO CATCH.** Until the label, a
     * company was named by its account's address, and every caller that still
     * does must be refused at the door rather than have a key derived for a
     * string that names nothing.
     * RED WHEN: the parser's label check accepts a bare sixty-four hex address.
     */
    for (let i = 0; i < 20; i += 1) {
      const address = sampleContractAddress();
      expect(codeOf(() => parseAsk(unlock({ company: address }), A, NOW)), address).toBe('not-a-company-label');
    }
    expect(codeOf(() => parseAsk(unlock({ company: ACCOUNT_A }), A, NOW))).toBe('not-a-company-label');
    expect(codeOf(() => parseAsk(unlock({ company: dummyContractAddress() }), A, NOW))).toBe('not-a-company-label');
    /* And the address is carried in a field of its own, where a label is refused. */
    expect((parseAsk(unlock({ account: ACCOUNT_A.toUpperCase() }), A, NOW) as UnlockRequest).account).toBe(ACCOUNT_A);
    /* RED WHEN: the account reader accepts a label. */
    expect(codeOf(() => parseAsk(unlock({ account: CO_B }), A, NOW))).toBe('not-an-account-address');
    expect(encodeContractAddress(ACCOUNT_A)).toHaveLength(32);
  });

  it('A LABEL HAS ONE SPELLING: UPPER CASE IS REFUSED, NOT FOLDED', () => {
    /* A label is ours, not the chain's, so there is no second spelling to
     * accept. Folding one would make two spellings one company; refusing makes
     * the second spelling nothing at all.
     * RED WHEN: the reader folds case. */
    for (const spelling of [CO_A.toUpperCase(), `CO_${CO_A.slice(3)}`, `co_${CO_A.slice(3).toUpperCase()}`]) {
      expect(codeOf(() => parseAsk(unlock({ company: spelling }), A, NOW)), spelling).toBe('not-a-company-label');
      const forged = { ...askAt(A), company: spelling } as UnlockRequest;
      expect(() => unlockKeyFor(identity, forged), `${spelling} hand-built`).toThrow(UnlockError);
    }
    expect((parseAsk(unlock(), A, NOW) as UnlockRequest).company).toBe(CO_A);
  });

  it('A MALFORMED IDENTIFIER IS A REQUEST THAT DOES NOT KNOW WHAT IT IS ASKING FOR', () => {
    for (const bad of [
      undefined, null, 42, '', 'payroll-a', CO_A.slice(0, 66), `${CO_A}0`, `0x${ACCOUNT_A}`,
      CO_A.replace('a', 'g'), ` ${CO_A}`, `${CO_A} `, `co_${'0'.repeat(64)}`, `co-${CO_A.slice(3)}`,
    ]) {
      expect(codeOf(() => parseAsk(unlock({ company: bad }), A, NOW)), String(bad))
        .toBe('not-a-company-label');
    }
    /* And an unlock that names no company at all is the same refusal. */
    const { company, ...withoutCompany } = unlock();
    expect(company).toBe(CO_A);
    expect(codeOf(() => parseAsk(withoutCompany, A, NOW))).toBe('not-a-company-label');
  });

  it('AND `unlock.ts` HAS ITS OWN DOOR, so a hand-built ask meets it too', () => {
    /* The same argument made for the origin: `request.ts` is one door and a
     * caller that assembled an `UnlockRequest` itself never went through it.
     * RED WHEN: `unlock.ts` trusts the ask's `company` without reading it. */
    for (const bad of ['', 'payroll-a', CO_A.slice(0, 66), ACCOUNT_A, CO_A.toUpperCase(), `co_${'0'.repeat(64)}`]) {
      const forged = { ...askAt(A), company: bad } as UnlockRequest;
      expect(() => unlockKeyFor(identity, forged), bad).toThrow(UnlockError);
    }
  });

  it('THE ACCOUNT IS NEVER AN INGREDIENT: the same label with any account, or none, is the same key', () => {
    /* RED WHEN: the account reaches the derivation. */
    const none = keyFor(CO_A);
    expect(hex(unlockKeyFor(identity, askAt(A, CO_A, { account: ACCOUNT_A })))).toBe(none);
    expect(hex(unlockKeyFor(identity, askAt(A, CO_A, { account: sampleContractAddress() })))).toBe(none);
    expect(none).toBe(hex(independentUnlockKey(CO_A)));
  });

  it('NO KEY IS DERIVED FROM AN ADDRESS ANY MORE: the label\'s key is not what the old derivation gave its account', () => {
    /* RED WHEN: the label's `co_` is stripped before the key is derived, so a label written over an
     * account's address gives that address's key. The salt itself is held by the fixed vectors above. */
    const oldFromAddress = hkdf(sha256, independentAuthority('unlock', 0),
      new TextEncoder().encode('midnight-identity/unlock/v2'), new TextEncoder().encode(ACCOUNT_A), 32);
    const newSaltAddress = hkdf(sha256, independentAuthority('unlock', 0), UNLOCK_SALT, new TextEncoder().encode(ACCOUNT_A), 32);
    const labelOnThatAccount = labelOf(ACCOUNT_A);
    expect(keyFor(labelOnThatAccount)).not.toBe(hex(oldFromAddress));
    expect(keyFor(labelOnThatAccount)).not.toBe(hex(newSaltAddress));
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
     * derived from our host can only ever be opened at our host, so the
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
     * DELIBERATE, DECLARED AND ARGUED.** The key moved from a company's account
     * address to its label, and every company that existed under the address
     * is discarded: nothing is kept derivable for them. The four purposes older
     * than `Unlock` are untouched and their vectors in
     * `derivation.portability.test.ts` are byte-identical.
     *
     * Every number below was produced by the INDEPENDENT walk above and is
     * checked against both it and `unlock.ts`, so it is not this repository's
     * code agreeing with itself.
     */
    const VECTORS: Readonly<Record<string, string>> = {
      [CO_A]: 'f213b0ee0326c1c1b54e2024dc4c3e643d3d5808881d42fc488792574b7c76be',
      [CO_B]: 'd53f45bb2d57f00cbd8d6e0e4da208d97fe3dcfb7d65dabedf7acab6b6a6b4ad',
      /* The smallest label there is: thirty-one zero bytes and a one. The
       * all-zero one is refused (the account refuses it), below. */
      [`co_${'0'.repeat(63)}1`]: '599cbb8fd6a9bc1b576c4c25f6556ef91d6542104df03a72e8bf7efd19cb1f0e',
    };
    let checked = 0;
    for (const [company, expected] of Object.entries(VECTORS)) {
      expect(hex(unlockKeyFor(identity, askAt(A, company))), company).toBe(expected);
      expect(hex(independentUnlockKey(company)), `${company} independently`).toBe(expected);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it('THE SALT SAYS `v3`, and the old bytes for the same string are not these', () => {
    /* The domain moved with the ingredient, so no derivation of a label shares
     * a domain with the derivation of an address or an origin.
     * RED WHEN: the salt is left at `v2` or `v1`. */
    for (const old of ['midnight-identity/unlock/v1', 'midnight-identity/unlock/v2']) {
      const before = hkdf(
        sha256, independentAuthority('unlock', 0),
        new TextEncoder().encode(old),
        new TextEncoder().encode(CO_A), 32);
      expect(hex(before), old).not.toBe(keyFor(CO_A));
    }
  });

  it('THE ALL-ZERO LABEL IS NO COMPANY: it is refused, as the account refuses it', () => {
    /* RED WHEN: the reader lets thirty-two zero bytes through. */
    expect(codeOf(() => parseAsk(unlock({ company: `co_${'0'.repeat(64)}` }), A, NOW))).toBe('not-a-company-label');
  });
});

describe('RULE 3 — TWO COMPANIES NEVER GET THE SAME KEY, AT FULL WIDTH', () => {
  it('five hundred companies give five hundred different keys', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(keyFor(labelOf(sha256(new TextEncoder().encode(`company-${i}`))
        .reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''))));
    }
    expect(seen.size).toBe(500);
  });

  it('A TRUNCATED LABEL IS NOT THE LABEL: two that share all but their last character', () => {
    /*
     * **THE MUTATION THIS KILLS IS `company.slice(0, n)`.** The finding stands
     * and applies here unchanged: a selector narrower than the thing it selects
     * can be ground, and that round ground a pair onto one 31-bit index in
     * 2,855,179,063 tries on one unoptimised core. **The label goes in whole.**
     *
     * These two differ in the LAST character only, so any truncation shorter
     * than the whole thing makes them one company.
     */
    const first = CO_A;
    const second = `${CO_A.slice(0, 66)}${CO_A.endsWith('8') ? '9' : '8'}`;
    expect(first).not.toBe(second);
    expect(first.slice(0, 66)).toBe(second.slice(0, 66));
    expect(keyFor(first)).not.toBe(keyFor(second));
  });

  it('AND A FOLDED ONE IS NOT EITHER: two halves, swapped', () => {
    /* **THE MUTATION THIS KILLS IS ANY XOR- OR ADD-FOLD OF THE TWO HALVES.**
     * `X||Y` and `Y||X` fold to the same value under every commutative fold and
     * are plainly two different companies. No grinding required to find them. */
    const body = CO_A.slice(3);
    const first = CO_A;
    const second = labelOf(`${body.slice(32)}${body.slice(0, 32)}`);
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
     * ordinary company labels that land on one index by walking a few
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
    const addressOf = (i: number): string => labelOf(hex(sha256(new TextEncoder().encode(`co-${i}`))));
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
      CO_A, CO_B, labelOf(sampleContractAddress()), labelOf(sampleContractAddress()), labelOf(sampleContractAddress()),
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
    for (const company of [CO_A, CO_B, labelOf(sampleContractAddress())]) {
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
    expect(originsFor(withHistory, CO_A, null)).toEqual([B]);
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
    expect(originsFor(used, CO_A, null)).toEqual([A]);
    expect(originsFor(emptyProfile(NOW), CO_A, null)).toEqual([]);
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
    expect(originsFor(profile, CO_A, null)).toEqual([A, B]);
    expect(originsFor(profile, CO_B, null)).toEqual([B]);
    expect(originsFor(profile, labelOf(dummyContractAddress()), null)).toEqual([]);
  });

  it('IT COMPARES THE LABEL AND THE ACCOUNT TOGETHER: the same label on another account is a company it has never seen', () => {
    /* RED WHEN: `originsFor` compares the label alone. */
    const OTHER = sampleContractAddress() as AccountAddress;
    const profile = recordRelease(emptyProfile(NOW), {
      at: NOW, nonce: 'n', recipient: { origin: A, name: 'n', rdns: 'r' }, company: CO_A, account: ACCOUNT_A,
    }, NOW);
    expect(originsFor(profile, CO_A, ACCOUNT_A)).toEqual([A]);
    expect(originsFor(profile, CO_A, OTHER)).toEqual([]);
    expect(originsFor(profile, CO_A, null)).toEqual([]);
  });
});

describe('THE MESSAGE THAT CROSSES, AND THE READER ON THE OTHER SIDE', () => {
  const ask = askAt(A);
  const expecting = { atOrigin: A, expectingNonce: 'n1', forCompany: CO_A, forAccount: null };

  it('carries the key, the company, the nonce and the observed origin, and nothing else', () => {
    const released = releaseFor(identity, ask, NOW);
    expect(Object.keys(released).sort())
      .toEqual(['account', 'at', 'company', 'key', 'nonce', 'origin', 'schema']);
    expect(released.account).toBeNull();
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

    /* **THE PAIR.** A key for the right label said to be about another account
     * answers a question nobody asked. RED WHEN: the reader ignores `account`. */
    const onA = releaseFor(identity, askAt(A, CO_A, { account: ACCOUNT_A }), NOW);
    expect(onA.account).toBe(ACCOUNT_A);
    expect(readRelease(onA, { ...expecting, forAccount: ACCOUNT_A }).ok).toBe(true);
    const otherAccount = readRelease(onA, { ...expecting, forAccount: sampleContractAddress() as AccountAddress });
    expect(!otherAccount.ok && otherAccount.code).toBe('company-mismatch');
    const noAccount = readRelease(onA, expecting);
    expect(!noAccount.ok && noAccount.code).toBe('company-mismatch');
    /* An upper-case echo of the label is not the label. */
    const shouted = readRelease({ ...released, company: CO_A.toUpperCase() }, expecting);
    expect(!shouted.ok && shouted.code).toBe('company-mismatch');
  });

  it('CARRIES THE INDEXER THE WALLET READS THE CHAIN THROUGH WHEN IT IS GIVEN ONE, AND THE READER HANDS IT BACK', () => {
    const indexer = { indexerUri: 'https://indexer.example/graphql', indexerWsUri: 'wss://indexer.example/graphql/ws' };
    const released = releaseFor(identity, ask, NOW, indexer);
    /* Public addresses, beside the key. RED WHEN they are dropped or renamed. */
    expect(Object.keys(released).sort())
      .toEqual(['account', 'at', 'company', 'indexer', 'key', 'nonce', 'origin', 'schema']);
    const read = readRelease(released, expecting);
    expect(read.ok && read.indexer).toEqual(indexer);
    /* The key is the same key whether or not an indexer went with it. */
    expect(read.ok && hex(read.key)).toBe(hex(independentUnlockKey(CO_A)));
    /* A wallet that names none, or names something that is not two addresses, reads as none - and still releases. */
    const none = readRelease(releaseFor(identity, ask, NOW), expecting);
    expect(none.ok && none.indexer).toBeNull();
    for (const said of [42, 'https://x', { indexerUri: 'https://x' }, { indexerUri: '', indexerWsUri: 'wss://x' },
      { indexerUri: 'https://x', indexerWsUri: 'w'.repeat(513) }]) {
      const odd = readRelease({ ...releaseFor(identity, ask, NOW), indexer: said }, expecting);
      /* RED WHEN something that is not two addresses is handed on as an indexer. */
      expect(odd.ok && odd.indexer, JSON.stringify(said)).toBeNull();
    }
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
    /* The COMPANY is in there, and that is not a leak: its label is public on
     * its account, and it is the thing the warning is computed from. */
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
    expect(originsFor(old as Parameters<typeof releasesOf>[0], CO_A, null)).toEqual([]);
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
    expect(ask.account).toBeNull();
    expect(ask.drawLabel).toBe(false);
    expect(keyringAt(A, { signedInAs: undefined }).signedInAs).toBeNull();
  });

  it('A COMPANY IS A LABEL IN ITS ONE SPELLING, AND AN ADDRESS OR ANY OTHER SPELLING IS REFUSED BY NAME', () => {
    /* RED WHEN: the keyring kind reads its company with anything but the label reader. */
    expect(keyringAt(A, { company: CO_A }).company).toBe(CO_A);
    expect(codeOf(() => keyringAt(A, { company: CO_A.toUpperCase() }))).toBe('not-a-company-label');
    expect(codeOf(() => keyringAt(A, { company: ACCOUNT_A }))).toBe('not-a-company-label');
    expect(keyringAt(A, { company: CO_A, account: ACCOUNT_A }).account).toBe(ACCOUNT_A);
    expect(codeOf(() => keyringAt(A, { company: CO_A, account: CO_B }))).toBe('not-an-account-address');
    /* An account with no company is a question with no subject. */
    expect(codeOf(() => keyringAt(A, { account: ACCOUNT_A }))).toBe('malformed-field');
  });

  it('AN ASK TO START A COMPANY NAMES NO COMPANY AND NO ACCOUNT, AND SAYS YES OR NO', () => {
    /* RED WHEN: a page can ask for a drawn label and name the label it wants in the same breath. */
    expect(keyringAt(A, { drawLabel: true }).drawLabel).toBe(true);
    expect(codeOf(() => keyringAt(A, { drawLabel: true, company: CO_A }))).toBe('malformed-field');
    expect(codeOf(() => keyringAt(A, { drawLabel: true, company: CO_A, account: ACCOUNT_A }))).toBe('malformed-field');
    expect(codeOf(() => keyringAt(A, { drawLabel: 'yes' }))).toBe('malformed-field');
    expect(codeOf(() => parseAsk(unlock({ drawLabel: true }), A, NOW))).toBe('keyring-fields-on-another-kind');
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
      ['account', 'at', 'committeeKey', 'company', 'companyKey', 'key', 'nonce', 'origin', 'person', 'schema', 'signedInAs']);
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

  it('ASKED TO START A COMPANY, THE WALLET DRAWS THE LABEL ITSELF AND ANSWERS WITH IT AND ITS KEYS', () => {
    /* RED WHEN: the label comes from anywhere but the wallet's own draw, or the
     * keys in the answer are not that label's. */
    const drawn = labelOf(sampleContractAddress());
    let draws = 0;
    const released = keyringReleaseFor(identity, keyringAt(A, { drawLabel: true }), NOW, holdsSignedIn,
      () => { draws += 1; return drawn; });
    expect(draws).toBe(1);
    expect(released.company).toBe(drawn);
    expect(released.account).toBeNull();
    expect(hex(fromBase64Url(released.companyKey!))).toBe(hex(independentUnlockKey(drawn)));
    expect(released.committeeKey).toEqual(committeeKeyFor(identity, drawn));
    /* The real draw: two asks, two labels, each a label. */
    const one = keyringReleaseFor(identity, keyringAt(A, { drawLabel: true }), NOW, holdsSignedIn).company!;
    const two = keyringReleaseFor(identity, keyringAt(A, { drawLabel: true }), NOW, holdsSignedIn).company!;
    expect(one).toMatch(/^co_[0-9a-f]{64}$/u);
    expect(one).not.toBe(two);
    /* And a hand-built ask that asks for both is refused before anything is drawn. */
    const both = { ...keyringAt(A, { drawLabel: true }), company: CO_A } as KeyringRequest;
    expect(codeOf(() => keyringReleaseFor(identity, both, NOW, holdsSignedIn, () => { draws += 1; return drawn; })))
      .toBe('company-not-usable');
    expect(draws).toBe(1);
    /* The page reads which label was drawn, and only a label. */
    const read = readKeyringRelease(released, {
      atOrigin: A, expectingNonce: 'k1', person: PERSON, signedInAs: SIGNED_IN, forCompany: 'drawn', forAccount: null,
    });
    expect(read.ok && read.company).toBe(drawn);
    const notALabel = readKeyringRelease({ ...released, company: ACCOUNT_A }, {
      atOrigin: A, expectingNonce: 'k1', person: PERSON, signedInAs: SIGNED_IN, forCompany: 'drawn', forAccount: null,
    });
    expect(notALabel.ok ? 'accepted' : notALabel.code).toBe('company-mismatch');
    const none = readKeyringRelease({ ...released, company: null, companyKey: null, committeeKey: null }, {
      atOrigin: A, expectingNonce: 'k1', person: PERSON, signedInAs: SIGNED_IN, forCompany: 'drawn', forAccount: null,
    });
    expect(none.ok ? 'accepted' : none.code).toBe('company-mismatch');
  });

  it('THE READER REFUSES AN ANSWER TO ANY OTHER QUESTION', () => {
    const expecting: {
      atOrigin: string; expectingNonce: string; person: string;
      signedInAs: string | null; forCompany: CompanyLabel | null; forAccount: AccountAddress | null;
    } = {
      atOrigin: A, expectingNonce: 'k1', person: PERSON, signedInAs: SIGNED_IN, forCompany: null, forAccount: null,
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
    const forA = keyringReleaseFor(identity, keyringAt(A, { company: CO_A }), NOW, holdsSignedIn);
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
    /* The account, too: asked about a label on one account, answered for another. */
    const onA = keyringReleaseFor(identity, keyringAt(A, { company: CO_A, account: ACCOUNT_A }), NOW, holdsSignedIn);
    expect(readKeyringRelease(onA, { ...withCompany, forAccount: ACCOUNT_A }).ok).toBe(true);
    const r2 = readKeyringRelease(onA, withCompany);
    expect(r2.ok ? 'accepted' : r2.code).toBe('company-mismatch');
  });

  it('A COMPANY-KEY RELEASE IS NOT A KEYRING RELEASE, AND THE REVERSE', () => {
    const company = releaseFor(identity, askAt(A), NOW);
    const r = readKeyringRelease(company, {
      atOrigin: A, expectingNonce: 'n1', person: PERSON, signedInAs: null, forCompany: null, forAccount: null,
    });
    expect(r.ok ? 'accepted' : r.code).toBe('not-a-release');
    const keyring = keyringReleaseFor(identity, keyringAt(A), NOW, holdsSignedIn);
    const back = readRelease(keyring, { atOrigin: A, expectingNonce: 'k1', forCompany: CO_A, forAccount: null });
    expect(back.ok ? 'accepted' : back.code).toBe('not-a-release');
  });
});

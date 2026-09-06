/**
 * The lock. M-90, and the fix for S-8 and S-9.
 *
 * Written as the properties a customer is actually being sold — "our provider
 * cannot read our payroll", "letting the bookkeeper see the rules does not show
 * them salaries" — rather than as checks that encryption encrypts.
 *
 * The most important test in the file is the last one, and it is the one that
 * was missing when the salary leak survived: it serialises what the SERVER
 * would hold and asserts a salary cannot be found in it.
 */
import { describe, it, expect } from 'vitest';
import {
  purposeKey, sealRecord, openRecord, reseal, keyFingerprint,
  type SealedRecord,
} from './sealed-records.js';
import { newSymmetricKey } from './crypto.js';
import { redactHex } from '../testing/redact.js';

const ACCOUNT = 'acc_1';
const STAFF = [
  { name: 'Priya Raman', email: 'priya@acme.test', title: 'CTO', salary: 9_000 },
  { name: 'Tom Okafor', email: 'tom@acme.test', title: 'Designer', salary: 4_800 },
];

describe('separate keys per purpose', () => {
  it('a key for one purpose does not open another', async () => {
    /*
     * THE REASON THIS FILE EXISTS. One key for everything means anyone allowed
     * to see anything can see everything, permanently — a bookkeeper given the
     * spending rules would get every salary with them.
     */
    const vk = newSymmetricKey();
    const rules = sealRecord('policy', ACCOUNT, { limit: 50_000 }, vk);
    expect(() => openRecord('payroll', ACCOUNT, rules, vk)).toThrow(/will not open/);
  });

  it('the same purpose on two accounts derives different keys', async () => {
    // The account id is the salt. Without it, one leaked key would open the
    // same purpose on every account in the system.
    const vk = newSymmetricKey();
    expect(purposeKey(vk, 'acc_1', 'payroll')).not.toBe(purposeKey(vk, 'acc_2', 'payroll'));
  });

  it('derivation is deterministic, or a new device could not read anything', async () => {
    const vk = newSymmetricKey();
    expect(purposeKey(vk, ACCOUNT, 'roster')).toBe(purposeKey(vk, ACCOUNT, 'roster'));
  });

  it('every purpose gets its own key', async () => {
    const vk = newSymmetricKey();
    const keys = (['roster', 'policy', 'payroll', 'audit'] as const).map((p) => purposeKey(vk, ACCOUNT, p));
    expect(new Set(keys).size).toBe(4);
  });
});

describe('sealing and opening', () => {
  it('round-trips a staff list', async () => {
    const vk = newSymmetricKey();
    const sealed = sealRecord('payroll', ACCOUNT, STAFF, vk);
    expect(openRecord('payroll', ACCOUNT, sealed, vk)).toEqual(STAFF);
  });

  it('a wrong key fails loudly rather than returning rubbish', async () => {
    /*
     * A record opened with the wrong key must not silently look like data.
     * AES-GCM authenticates, so this fails rather than decrypting to noise that
     * something downstream might treat as a salary.
     */
    const sealed = sealRecord('payroll', ACCOUNT, STAFF, newSymmetricKey());
    expect(() => openRecord('payroll', ACCOUNT, sealed, newSymmetricKey())).toThrow();
  });

  it('says what to check, because the two causes are indistinguishable', async () => {
    // Wrong purpose and rotated-key look identical from the ciphertext. A
    // message that says "corrupt" would send someone looking in the wrong place.
    const vk = newSymmetricKey();
    const sealed = sealRecord('roster', ACCOUNT, STAFF, vk);
    expect(() => openRecord('payroll', ACCOUNT, sealed, vk)).toThrow(/rotated|purpose/);
  });

  it('seals the same value identically regardless of key order', async () => {
    // Canonical JSON: otherwise the same record re-saved produces a different
    // commitment later and looks like it changed when it did not.
    const vk = newSymmetricKey();
    const a = openRecord('roster', ACCOUNT, sealRecord('roster', ACCOUNT, { b: 2, a: 1 }, vk), vk);
    const b = openRecord('roster', ACCOUNT, sealRecord('roster', ACCOUNT, { a: 1, b: 2 }, vk), vk);
    expect(a).toEqual(b);
  });
});

describe('changing the locks (K-4)', () => {
  const recordsFor = (vk: string): SealedRecord[] => [
    { id: 'e1', keyEpoch: 0, sealed: sealRecord('payroll', ACCOUNT, STAFF[0], vk) },
    { id: 'e2', keyEpoch: 0, sealed: sealRecord('payroll', ACCOUNT, STAFF[1], vk) },
  ];

  it('re-seals everything so the old key stops working', async () => {
    /*
     * Removing a signer does not un-teach them a key they hold. This is what
     * makes "remove signer" mean something.
     */
    const oldKey = newSymmetricKey();
    const newKey = newSymmetricKey();
    const rotated = reseal('payroll', ACCOUNT, recordsFor(oldKey), oldKey, newKey);

    expect(openRecord('payroll', ACCOUNT, rotated[0].sealed, newKey)).toEqual(STAFF[0]);
    expect(() => openRecord('payroll', ACCOUNT, rotated[0].sealed, oldKey)).toThrow();
  });

  it('advances the epoch, which is how a client knows which key applies', async () => {
    const oldKey = newSymmetricKey();
    const rotated = reseal('payroll', ACCOUNT, recordsFor(oldKey), oldKey, newSymmetricKey());
    expect(rotated.map((r) => r.keyEpoch)).toEqual([1, 1]);
  });

  it('keeps ids stable, so nothing else has to be rewritten', async () => {
    const oldKey = newSymmetricKey();
    const rotated = reseal('payroll', ACCOUNT, recordsFor(oldKey), oldKey, newSymmetricKey());
    expect(rotated.map((r) => r.id)).toEqual(['e1', 'e2']);
  });

  it('returns a new set without destroying the old one', async () => {
    /*
     * A caller that cannot write the new set must still have the old. This is
     * the M-74 ordering rule: an account half-rotated is worse than one not
     * rotated at all.
     */
    const oldKey = newSymmetricKey();
    const before = recordsFor(oldKey);
    reseal('payroll', ACCOUNT, before, oldKey, newSymmetricKey());
    expect(openRecord('payroll', ACCOUNT, before[0].sealed, oldKey)).toEqual(STAFF[0]);
  });
});

describe('the cache fingerprint', () => {
  it('changes when the key changes, so a rotation orphans the old cache', async () => {
    expect(keyFingerprint(newSymmetricKey())).not.toBe(keyFingerprint(newSymmetricKey()));
  });

  it('does not reveal the key it identifies', async () => {
    const vk = newSymmetricKey();
    const fp = keyFingerprint(vk);
    expect(vk).not.toContain(fp);
    expect(fp.length).toBeLessThan(vk.length);
  });
});

describe('what the server would hold', () => {
  /*
   * THE DETECTOR ITSELF, PINNED. `C29`, found by audit 17 Aug.
   *
   * Every "the server cannot read a salary" assertion in this repo is a
   * substring search over `redactHex`'s output, so the detector's threshold is
   * load-bearing for all of them at once — and it was quietly lowered from 32
   * hex characters to 24 to stop a 12-byte `iv` showing up. That blinded every
   * one of those assertions to any 24-to-31 character lowercase-hex plaintext,
   * and no test noticed, because nothing tested the detector. **A guard whose
   * failure mode is to disable itself is not a guard** — `C16`, in a test file.
   */
  it('THE LEAK DETECTOR REDACTS SECRETS AND LEAVES PLAINTEXT VISIBLE — C29', () => {
    /* Short fixed-width secrets go by NAME, which is what the `iv` needed. */
    expect(redactHex({ iv: 'a'.repeat(24) })).not.toContain('a'.repeat(24));
    expect(redactHex({ nonce: 'b'.repeat(24), tag: 'c'.repeat(32) }))
      .toBe('{"nonce":"<hex>","tag":"<hex>"}');

    /* And a long body goes on length, wherever it is. */
    expect(redactHex({ sealed: { body: 'd'.repeat(64) } })).not.toContain('d'.repeat(64));

    /*
     * THE PART THE LOWERED THRESHOLD BROKE. A plaintext that happens to be
     * 24-to-31 lowercase hex characters — an id, a slug, a name in a hex-ish
     * alphabet — must remain VISIBLE, or a search for it can never find it.
     */
    const plaintext = 'deadbeefcafebabefeedface';   // 24 characters
    expect(plaintext).toHaveLength(24);
    expect(redactHex({ note: plaintext })).toContain(plaintext);
  });

  it('CANNOT BE SEARCHED FOR A SALARY, A NAME OR AN EMAIL', async () => {
    /*
     * THE TEST THAT WAS MISSING.
     *
     * `leaks no individual salary to a public observer` serialises the
     * blockchain's public view and asserts no salary appears. That is a correct
     * test of what the CHAIN leaks, and it is why S-9 survived: the name reads
     * as "everyone" when it means "the chain".
     *
     * This one serialises what WE would store. It is the claim a customer
     * actually cares about: our payroll provider cannot see what we pay people.
     */
    const vk = newSymmetricKey();
    const stored: SealedRecord[] = STAFF.map((s, i) => ({
      id: `e${i}`,
      keyEpoch: 0,
      sealed: sealRecord('payroll', ACCOUNT, s, vk),
    }));

    /*
     * `redactHex`, NOT `JSON.stringify`. T-12, and the reason is in that file:
     * ciphertext is hex, every decimal digit is a hex digit, so searching a raw
     * serialisation for a salary fails on correct code about one run in a
     * hundred and twenty. It did, twice, before anybody read the failure.
     */
    const whatWeHold = redactHex(stored);

    /*
     * NAMES AND EMAILS ARE SEARCHED AS SUBSTRINGS; SALARIES ARE NOT.
     *
     * `expect(whatWeHold).not.toContain('9000')` looks like the same check and
     * is a different one, because the ciphertext is rendered as HEX and every
     * decimal digit is also a hex digit. **A salary can appear in a hex body by
     * pure chance**, and did: caught on 16 Aug in
     * `...5155c89000fa982e...`, after two earlier runs failed and were lost.
     *
     * Roughly 260 hex characters per record, two records, four digits sought:
     * about 520 positions at 16^-4 each, so **near enough one run in a hundred
     * and twenty**. Rare enough to look like flakiness, frequent enough to
     * appear twice in an afternoon — and a test that fails at random trains
     * whoever runs it to re-run rather than to look, which is how a real
     * failure gets waved through.
     *
     * Names and emails carry letters past `f`, so no hex string could ever
     * contain one; those checks were sound either way. The salary is the one
     * that could only be made sound by redacting first — and it is kept,
     * because "the server cannot see what we pay people" is the claim a
     * customer actually cares about.
     */
    for (const salary of [9_000, 4_800]) {
      expect(whatWeHold).not.toContain(String(salary));
    }
    for (const text of ['Priya Raman', 'Tom Okafor', 'priya@acme.test', 'tom@acme.test', 'CTO']) {
      expect(whatWeHold).not.toContain(text);
    }

    /*
     * Every value we hold, flattened. The record is `{id, keyEpoch, sealed:{iv,
     * tag, body}}` and nothing else, so asserting on the SHAPE catches a salary
     * that leaked into a field nobody thought to search — which a substring
     * check over one serialisation never could.
     */
    for (const r of stored) {
      expect(Object.keys(r).sort()).toEqual(['id', 'keyEpoch', 'sealed']);
      expect(Object.keys(r.sealed).sort()).toEqual(['body', 'iv', 'tag']);
      // The parts are hex, so nothing readable is being carried in any of them.
      for (const part of [r.sealed.iv, r.sealed.tag, r.sealed.body]) {
        expect(part).toMatch(/^[0-9a-f]*$/);
      }
    }

    // And the body is genuinely not the plaintext, whatever it happens to spell.
    for (const [i, r] of stored.entries()) {
      expect(r.sealed.body).not.toBe(Buffer.from(JSON.stringify(STAFF[i])).toString('hex'));
    }
  });

  it('holds only an id, an epoch and ciphertext', async () => {
    // Anything else in the record is something we can read.
    const vk = newSymmetricKey();
    const record: SealedRecord = { id: 'e1', keyEpoch: 0, sealed: sealRecord('payroll', ACCOUNT, STAFF[0], vk) };
    expect(Object.keys(record).sort()).toEqual(['id', 'keyEpoch', 'sealed']);
    expect(Object.keys(record.sealed).sort()).toEqual(['body', 'iv', 'tag']);
  });
});

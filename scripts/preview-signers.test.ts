/**
 * **THE FILE THAT DECIDES WHO IS ON THE PREVIEW ACCOUNT.**
 *
 * Five identities live in `.midnight/` because two processes have to agree on
 * them and a formula both could compute is what `C334` is. So what this file
 * pins is the three ways that arrangement can go wrong:
 *
 *   the file is SHARED between accounts  → `C275`, and `payroll-test-1`'s pool
 *                                          is unopenable today because of it
 *   the file is OVERWRITTEN on a rerun   → every signer already on chain is
 *                                          stranded, `C275` in reverse
 *   the material is not really random    → `C334` again, one file over
 *
 * It does NOT test that the contract accepts these values. That is
 * `contracts/test/what-a-signer-is.test.ts`, in circuit.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertPreviewAccountId, previewSignersFile, parsePreviewSigners,
  readOrCreatePreviewSigners, signerBytes, PREVIEW_SIGNER_IDS,
} from './preview-signers.js';
import { toHex } from '../src/core/crypto.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'preview-signers-'));

describe('C334 — the preview signers file', () => {
  it('refuses a traversing account id THROUGH THE FUNCTION THAT SHIPS, not just the guard', () => {
    /*
     * **THE GUARD IS NOT WHAT SHIPS — `previewSignersFile` IS.** `S34`'s
     * test-coverage pass named this shape one file over: a test that enters through
     * the helper proves the helper and proves nothing about the caller calling
     * it. Delete `assertPreviewAccountId(...)` from `previewSignersFile` and
     * the direct test below stays green while a `..` escapes `.midnight/`.
     */
    expect(() => previewSignersFile('/x/.midnight', 'stagenet', '../../etc/passwd'))
      .toThrow(/not a usable account id/);
    expect(() => previewSignersFile('/x/.midnight', 'stagenet', 'a/b'))
      .toThrow(/not a usable account id/);
  });

  it('names a file per network AND per account, never one shared between them', () => {
    /* `C275` is one shared file, each run overwriting the last. The account id
     * is IN the name, so two accounts cannot collide however often either
     * runs. */
    expect(previewSignersFile('/x/.midnight', 'stagenet', 'default'))
      .toBe('/x/.midnight/stagenet-preview-signers-default.json');
    expect(previewSignersFile('/x/.midnight', 'stagenet', 'payroll-test-1'))
      .not.toBe(previewSignersFile('/x/.midnight', 'stagenet', 'default'));
    expect(previewSignersFile('/x/.midnight', 'undeployed', 'default'))
      .not.toBe(previewSignersFile('/x/.midnight', 'stagenet', 'default'));
  });

  it('refuses an account id that could escape the directory or shadow another', () => {
    /* The id becomes a FILENAME. `..` and a slash are the two that matter and
     * neither can be spelled under the rule; the message is read rather than
     * the fact of a throw, because a `TypeError` from a renamed helper would
     * satisfy a bare `toThrow()`. */
    for (const bad of ['../../etc/passwd', 'a/b', '.', '..', 'Default', 'x', '', 'a b']) {
      expect(() => assertPreviewAccountId(bad)).toThrow(/not a usable account id/);
    }
    expect(assertPreviewAccountId('payroll-test-1')).toBe('payroll-test-1');
  });

  it('generates five signers with REAL entropy — no two runs agree', () => {
    /*
     * **THE ASSERTION `C334` IS ABOUT.** `seededBytes(1)` returns the same 32
     * bytes on every machine for ever; these must not. Two independent
     * directories, so this compares two first-generations rather than a
     * generation against a reuse.
     */
    const a = readOrCreatePreviewSigners(tmp(), 'stagenet', 'default');
    const b = readOrCreatePreviewSigners(tmp(), 'stagenet', 'default');
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    for (const id of PREVIEW_SIGNER_IDS) {
      expect(a.signers[id].signingSecret).not.toBe(b.signers[id].signingSecret);
      expect(a.signers[id].blinding).not.toBe(b.signers[id].blinding);
    }
    /*
     * **WHAT THIS MEASURES IS "DIFFERS BETWEEN RUNS", WHICH IS LESS THAN
     * "UNPREDICTABLE", AND THE TITLE IS ONE CLAUSE STRONGER THAN THE
     * ASSERTION.** `S35`'s test-coverage pass. A counter or a `Date.now()` seed
     * would pass this. It does catch `C334`'s actual defect — `seededBytes(1)`
     * returns the same 32 bytes on every machine for ever — and the generator
     * it is guarding is named at `preview-signers.ts`: `randomSecretKey` and
     * `randomBytes(32)`. What no unit test can hold is the quality of a CSPRNG.
     */
    /* And the five are five, not one value copied. */
    const secrets = new Set(PREVIEW_SIGNER_IDS.map(id => a.signers[id].signingSecret));
    expect(secrets.size).toBe(PREVIEW_SIGNER_IDS.length);
  });

  it('reuses an existing file and never overwrites it', () => {
    /*
     * The deploy runs again — after a stagenet reset, or a failed attempt.
     * Regenerating here would strand every signer already seated on chain
     * under the previous material, which is `C275`'s failure with the
     * direction reversed, and it would do it silently.
     */
    const dir = tmp();
    const first = readOrCreatePreviewSigners(dir, 'stagenet', 'default');
    const onDisk = readFileSync(first.file, 'utf8');
    const second = readOrCreatePreviewSigners(dir, 'stagenet', 'default');
    expect(second.created).toBe(false);
    expect(second.signers).toEqual(first.signers);
    expect(readFileSync(first.file, 'utf8')).toBe(onDisk);
  });

  it('refuses a truncated or hand-edited file rather than handing back a signer nobody seated', () => {
    /*
     * The failure this prevents is the most expensive message this project
     * has: "you are not a signer on this account", minutes later, against a
     * contract that deployed perfectly — and every hour it has cost was spent
     * looking at the contract.
     */
    const dir = tmp();
    const { file } = readOrCreatePreviewSigners(dir, 'stagenet', 'default');

    expect(() => parsePreviewSigners({}, file)).toThrow(/does not carry usable material/);
    expect(() => parsePreviewSigners({ signers: {} }, file)).toThrow(/signer A/);

    /*
     * **ONE BAD FIELD AT A TIME, AND THAT IS THE WHOLE POINT.** `S35`'s
     * test-coverage pass: a case with BOTH fields malformed passes for either check
     * alone, so deleting one of the two conditions leaves the suite green. Each
     * of the two is covered by a case in which the OTHER field is valid.
     */
    const ok64 = 'ab'.repeat(32);
    expect(() => parsePreviewSigners(
      { signers: { A: { signingSecret: 'nothex', blinding: ok64 } } }, file),
    ).toThrow(/signer A/);
    expect(() => parsePreviewSigners(
      { signers: { A: { signingSecret: ok64, blinding: 'NOTHEX'.repeat(11) } } }, file),
    ).toThrow(/signer A/);
    /* Upper case is not lower case: the leaf is derived from the BYTES, and two
     * spellings of one value is how two processes stop agreeing. */
    expect(() => parsePreviewSigners(
      { signers: { A: { signingSecret: ok64.toUpperCase(), blinding: ok64 } } }, file),
    ).toThrow(/signer A/);

    /* Four of five is still a refusal, and it names the one that is missing. */
    const good = JSON.parse(readFileSync(file, 'utf8'));
    delete good.signers.E;
    writeFileSync(file, JSON.stringify(good));
    expect(() => readOrCreatePreviewSigners(dir, 'stagenet', 'default'))
      .toThrow(/signer E/);
  });

  it('hands the two values out AS THEMSELVES, not merely as two 32-byte arrays', () => {
    /*
     * **THE SWAP IS THE FAILURE THIS ASSERTS AGAINST.** `S35`'s test-coverage pass:
     * `secretKey: fromHex(s.blinding), blinding: fromHex(s.signingSecret)` gives
     * two 32-byte `Uint8Array`s and satisfies every shape assertion — and the
     * deploy then seats A's leaf from one pair while the run derives from the
     * other, which surfaces minutes later on chain as "you are not a signer on
     * this account" against a contract that deployed perfectly. So the VALUES
     * are read back, not the types.
     */
    const { signers } = readOrCreatePreviewSigners(tmp(), 'stagenet', 'default');
    const { secretKey, blinding } = signerBytes(signers.A);
    expect(secretKey.length).toBe(32);
    expect(blinding.length).toBe(32);
    expect(toHex(secretKey)).toBe(signers.A.signingSecret);
    expect(toHex(blinding)).toBe(signers.A.blinding);
    expect(signers.A.signingSecret).not.toBe(signers.A.blinding);
  });

  it('writes the file 0600, because it is key material on a shared disk', () => {
    /* A truth claim the file makes about itself (rule 14), pinned rather than
     * asserted in a comment. `S35`'s test-coverage pass. */
    const { file } = readOrCreatePreviewSigners(tmp(), 'stagenet', 'default');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

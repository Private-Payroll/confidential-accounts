/**
 * **THE FILE THAT DECIDES WHO IS ON AN ACCOUNT DEPLOYED FROM THIS MACHINE.**
 *
 * Five identities live in `.midnight/` because two processes have to agree on
 * them, and a formula both could compute would be an identity any reader could
 * take. So what this file pins is the three ways that arrangement can go wrong:
 *
 *   the file is SHARED between accounts  → one account's run overwrites another's
 *                                          signers, and that account's pool can no
 *                                          longer be opened
 *   the file is OVERWRITTEN on a rerun   → every signer already on chain is
 *                                          stranded
 *   the material is not really random    → a reader can compute the identities
 *
 * It does NOT test that the contract accepts these values. That is
 * `contracts/test/what-a-signer-is.test.ts`, in circuit.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertPreviewAccountId,
  previewSignersFile,
  parsePreviewSigners,
  readOrCreatePreviewSigners,
  signerBytes,
  PREVIEW_SIGNER_IDS
} from './preview-signers.js';
import { toHex } from '../src/core/crypto.js';
import { NETWORK } from 'midnight-identity/network';

const tmp = () => mkdtempSync(join(tmpdir(), 'preview-signers-'));

describe('the signers file of an account deployed from this machine', () => {
  it('refuses a traversing account id THROUGH THE FUNCTION THAT SHIPS, not just the guard', () => {
    /*
     * **THE GUARD IS NOT WHAT IS CALLED — `previewSignersFile` IS.** A test that
     * enters through the helper proves the helper and proves nothing about the
     * caller calling it. Delete `assertPreviewAccountId(...)` from `previewSignersFile` and
     * the direct test below stays green while a `..` escapes `.midnight/`.
     */
    expect(() => previewSignersFile('/x/.midnight', NETWORK, '../../etc/passwd')).toThrow(/not a usable account id/);
    expect(() => previewSignersFile('/x/.midnight', NETWORK, 'a/b')).toThrow(/not a usable account id/);
  });

  it('names a file per network AND per account, never one shared between them', () => {
    /* One shared file would have each run overwriting the last. The account id
     * is IN the name, so two accounts cannot collide however often either
     * runs. */
    expect(previewSignersFile('/x/.midnight', NETWORK, 'default')).toBe(
      `/x/.midnight/${NETWORK}-preview-signers-default.json`
    );
    expect(previewSignersFile('/x/.midnight', NETWORK, 'payroll-test-1')).not.toBe(
      previewSignersFile('/x/.midnight', NETWORK, 'default')
    );
    expect(previewSignersFile('/x/.midnight', 'undeployed', 'default')).not.toBe(
      previewSignersFile('/x/.midnight', NETWORK, 'default')
    );
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
     * **THE ASSERTION THIS FILE IS FOR.** A formula returns the same 32 bytes
     * on every machine for ever; these must not. Two independent
     * directories, so this compares two first-generations rather than a
     * generation against a reuse.
     */
    const a = readOrCreatePreviewSigners(tmp(), NETWORK, 'default');
    const b = readOrCreatePreviewSigners(tmp(), NETWORK, 'default');
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    for (const id of PREVIEW_SIGNER_IDS) {
      expect(a.signers[id].signingSecret).not.toBe(b.signers[id].signingSecret);
      expect(a.signers[id].blinding).not.toBe(b.signers[id].blinding);
    }
    /*
     * **WHAT THIS MEASURES IS "DIFFERS BETWEEN RUNS", WHICH IS LESS THAN
     * "UNPREDICTABLE", AND THE TITLE IS ONE CLAUSE STRONGER THAN THE
     * ASSERTION.** A counter or a `Date.now()` seed would pass this. It does
     * catch the defect it is for — a formula that returns the same 32 bytes on
     * every machine for ever — and the generator
     * it is guarding is named at `preview-signers.ts`: `randomSecretKey` and
     * `randomBytes(32)`. What no unit test can hold is the quality of a CSPRNG.
     */
    /* And the five are five, not one value copied. */
    const secrets = new Set(PREVIEW_SIGNER_IDS.map((id) => a.signers[id].signingSecret));
    expect(secrets.size).toBe(PREVIEW_SIGNER_IDS.length);
  });

  it('reuses an existing file and never overwrites it', () => {
    /*
     * The deploy runs again — after a stagenet reset, or a failed attempt.
     * Regenerating here would strand every signer already seated on chain
     * under the previous material, and it would do it silently.
     */
    const dir = tmp();
    const first = readOrCreatePreviewSigners(dir, NETWORK, 'default');
    const onDisk = readFileSync(first.file, 'utf8');
    const second = readOrCreatePreviewSigners(dir, NETWORK, 'default');
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
    const { file } = readOrCreatePreviewSigners(dir, NETWORK, 'default');

    expect(() => parsePreviewSigners({}, file)).toThrow(/does not carry usable material/);
    expect(() => parsePreviewSigners({ signers: {} }, file)).toThrow(/signer A/);

    /*
     * **ONE BAD FIELD AT A TIME, AND THAT IS THE WHOLE POINT.** A case with BOTH
     * fields malformed passes for either check
     * alone, so deleting one of the two conditions leaves the suite green. Each
     * of the two is covered by a case in which the OTHER field is valid.
     */
    const ok64 = 'ab'.repeat(32);
    expect(() => parsePreviewSigners({ signers: { A: { signingSecret: 'nothex', blinding: ok64 } } }, file)).toThrow(
      /signer A/
    );
    expect(() =>
      parsePreviewSigners({ signers: { A: { signingSecret: ok64, blinding: 'NOTHEX'.repeat(11) } } }, file)
    ).toThrow(/signer A/);
    /* Upper case is not lower case: the leaf is derived from the BYTES, and two
     * spellings of one value is how two processes stop agreeing. */
    expect(() =>
      parsePreviewSigners({ signers: { A: { signingSecret: ok64.toUpperCase(), blinding: ok64 } } }, file)
    ).toThrow(/signer A/);

    /* Four of five is still a refusal, and it names the one that is missing. */
    const good = JSON.parse(readFileSync(file, 'utf8'));
    delete good.signers.E;
    writeFileSync(file, JSON.stringify(good));
    expect(() => readOrCreatePreviewSigners(dir, NETWORK, 'default')).toThrow(/signer E/);
  });

  it('hands the two values out AS THEMSELVES, not merely as two 32-byte arrays', () => {
    /*
     * **THE SWAP IS THE FAILURE THIS ASSERTS AGAINST.**
     * `secretKey: fromHex(s.blinding), blinding: fromHex(s.signingSecret)` gives
     * two 32-byte `Uint8Array`s and satisfies every shape assertion — and the
     * deploy then seats A's leaf from one pair while the run derives from the
     * other, which surfaces minutes later on chain as "you are not a signer on
     * this account" against a contract that deployed perfectly. So the VALUES
     * are read back, not the types.
     */
    const { signers } = readOrCreatePreviewSigners(tmp(), NETWORK, 'default');
    const { secretKey, blinding } = signerBytes(signers.A);
    expect(secretKey.length).toBe(32);
    expect(blinding.length).toBe(32);
    expect(toHex(secretKey)).toBe(signers.A.signingSecret);
    expect(toHex(blinding)).toBe(signers.A.blinding);
    expect(signers.A.signingSecret).not.toBe(signers.A.blinding);
  });

  it('writes the file 0600, because it is key material on a shared disk', () => {
    /* A claim the file makes about itself, pinned rather than asserted in a comment. */
    const { file } = readOrCreatePreviewSigners(tmp(), NETWORK, 'default');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

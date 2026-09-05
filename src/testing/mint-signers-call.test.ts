/**
 * **THE DOOR STILL ASKS THE RULE. `C275`.**
 *
 * `MAKE-TEST-SIGNERS.command` writes a generated script to
 * `.midnight/_mint-signers.ts` and runs it. `S30` moved the rule that decides a
 * vault's signer ids out of that heredoc and into `mintedSignerIds`
 * (`src/midnight/vault-record.ts`), where `vault-record.test.ts` holds it —
 * because a rule living inside a heredoc is a rule no test can reach.
 *
 * **MOVING THE RULE IS HALF THE MECHANISM. THIS IS THE OTHER HALF.** The
 * `test-auditor` pass over `S30` found four one-line edits to that heredoc that
 * reintroduce `C275` in full **with every one of the rule's own tests still
 * green**: pass `[]` as the existing ids; inline the id construction and drop
 * the import; write the secrets file before the check; or catch a parse failure
 * and fall back to an empty record. Each is a plausible edit a later round
 * makes for a good reason, and none of them is visible to a test of the rule.
 *
 * **WHAT `C275` COSTS, so nobody weakens this without reading it.** The ids are
 * the names a signer's SECRET is filed under. A sealed pool record names its
 * signers by id and never by public key, so an id reused across two vaults
 * replaces the first vault's key with the second's and nothing can compare them
 * to notice. The pool is the only record of a note's nonce, colour and value
 * (`C284`) and a commitment on chain cannot be inverted to recover them. **It
 * had already fired twice on disk before it was found**: `payroll-test-1`'s
 * pool is wrapped to three keys whose secret halves exist nowhere.
 *
 * This is the same shape as `command-index.test.ts` and for the same reason: a
 * check somebody has to remember to run is a check that stops being run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOOR = join(process.cwd(), 'MAKE-TEST-SIGNERS.command');
const source = readFileSync(DOOR, 'utf8');

/** The generated script, exactly as the door writes it — not the whole door. */
const heredoc = (() => {
  const open = source.indexOf("cat > .midnight/_mint-signers.ts <<'TS'");
  expect(open, 'the door no longer writes .midnight/_mint-signers.ts').toBeGreaterThan(-1);
  const body = source.slice(open);
  const end = body.indexOf('\nTS\n');
  expect(end, 'the generated script has no terminator').toBeGreaterThan(-1);
  return body.slice(0, end);
})();

describe('C275: the mint door still asks the rule rather than spelling it again', () => {
  it('imports the rule from the module the tests hold', () => {
    expect(heredoc).toMatch(/import \{[\s\S]*?mintedSignerIds[\s\S]*?\} from '\.\.\/src\/midnight\/vault-record\.js'/);
  });

  it('calls it with the ids that ALREADY EXIST, not with an empty list', () => {
    // Passing [] is the single edit that turns the refusal into a no-op while
    // every test of the rule stays green, because the rule is never wrong —
    // it is just never told anything.
    expect(heredoc).toMatch(/mintedSignerIds\(\s*name,\s*n,\s*Object\.keys\(secrets\.signers/);
  });

  it('does not build signer ids by hand anywhere in the generated script', () => {
    // The second edit: inline the ids and drop the import. The rule's tests
    // cannot see it because the rule is still correct and simply unused.
    expect(heredoc).not.toMatch(/`\$\{name\}-signer-\$\{/);
    expect(heredoc).not.toMatch(/`test-signer-\$\{/);
  });

  it('checks BEFORE it writes the shared secrets file', () => {
    // The third edit: move the write above the check. Ordering is the whole
    // protection — a check after a write is a report, not a guard.
    const check = heredoc.indexOf('mintedSignerIds(');
    const write = heredoc.indexOf('writeSecretsAtomically(');
    expect(check).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(check).toBeLessThan(write);
  });

  it('REFUSES a secrets file it cannot read, rather than treating it as empty', () => {
    // The fourth edit, and the one that looks most like a fix: wrap the parse
    // in a try/catch that falls back to a fresh record. The existing ids become
    // [], the guard is off, and the file is overwritten whole. The repository's
    // own doctrine for this is `parseVaultRegistry` — an unreadable record is a
    // refusal and never an empty one.
    expect(heredoc).toMatch(/C110|refus/i);
    expect(heredoc).not.toMatch(/catch[\s\S]{0,120}signers:\s*\{\s*\}/);
  });

  it('writes the shared secrets file atomically, because a truncated one is C275 again', () => {
    // A crash mid-write leaves every previously minted vault's pool as
    // ciphertext with no key — the same money outcome, reached by a mechanism
    // the id rule does not touch. The repository writes key material through a
    // temp file and a rename in three other places.
    // NOT /renameSync/. That word is on the import line too, so the expectation
    // was satisfied by an unrelated line and the mutation SURVIVED when it was
    // run — found by running the negative control rather than by reading it.
    // `T-70`'s family: an expectation loose enough for something else to meet.
    expect(heredoc).toMatch(/renameSync\(\s*staging\s*,\s*secretsPath\s*\)/);
    // And the staging file has to be what was written, or the rename moves
    // something else over the only copy of every vault's pool key.
    expect(heredoc).toMatch(/writeFileSync\(\s*staging\s*,/);
  });
});

/**
 * THE PIN FOR WHAT THE IGNORE FILE EXCLUDES.
 *
 * ── THE EVENT THIS FILE EXISTS BECAUSE OF ───────────────────────────────
 *
 * Shapes for key material lived in one folder's own ignore file. A merge moved
 * the files out from under it and left the shapes behind, so a whole subtree
 * was covered for two exact filenames and for no SHAPE at all - under a commit
 * door that stages files by a list somebody types. **Nothing said so.** The gap
 * was found by reading, which is not a mechanism.
 *
 * ── WHY THESE ASSERTIONS ASK ABOUT PATHS AND NOT ABOUT LINES ────────────
 *
 * A test that greps the ignore file for `*.seed` stays green when that rule is
 * later anchored to the top of the tree, when a negation written below it
 * reaches back over it, and when a trailing slash turns it into a rule about
 * directories. **All three leave the text present and the subtree uncovered.**
 * So every assertion below asks the only question that matters: would this path
 * be excluded.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseIgnore, isIgnored, unsupportedRules, SECRET_SHAPES, shapeProbes } from './gitignore-rules.mjs';

const ignoreText = () => readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
const rules = () => parseIgnore(ignoreText());

const takeList = () => readFileSync(new URL('../PUBLIC-REPO-TAKE-LIST.txt', import.meta.url), 'utf8')
  .split('\n').map((l) => l.split('#')[0].trim()).filter(Boolean);

/**
 * THE SECRET ROOTS, WRITTEN OUT HERE RATHER THAN READ OUT OF THE CONFIG.
 *
 * Reading them from the file the scanner reads would make this test agree with
 * that file by construction, including on the day somebody empties it. **Two
 * independent lists that must agree is the point**, and when they disagree the
 * failure names which one moved.
 */
const SECRET_ROOTS = [
  '.midnight/params/bls', '.env', '.env.example', '.keys-backup/2026-01-01/a',
  '.pre-reset-2026-08-14/midnight-level-db/000001.ldb', '.wallet-state/state.json',
  'midnight-level-db/000001.ldb', 'apps/wallet/test-wallet.seed', 'apps/wallet/.env.example',
];

describe('the ignore file excludes every place this repository keeps key material', () => {
  it('excludes all nine secret roots, at the depth the files actually sit at', () => {
    const r = rules();
    const tracked = SECRET_ROOTS.filter((p) => !isIgnored(r, p));
    expect(tracked, `these secret roots would be TRACKED: ${tracked.join(', ')}`).toEqual([]);
  });

  it('excludes the folder that holds unremovable scratch, WHATEVER a file in it is called', () => {
    /**
     * THE PROBE IS DELIBERATELY NOT A `.seed`, AND THIS ASSERTION WAS WRITTEN
     * ONCE THE WRONG WAY BEFORE IT WAS WATCHED FAIL. With `_to_delete/wallet.seed`
     * as the probe, removing `_to_delete/` from the ignore file left the test
     * GREEN - `*.seed` was still covering it, and the assertion was pinning a
     * rule it was not about. **An assertion that cannot fail for its own reason
     * is the shape this project has already paid for twice.**
     *
     * A folder that exists because deletion is unavailable fills with whole
     * copies of working directories, and what is in them is not knowable from
     * their names. So the rule that matters is that the FOLDER is excluded.
     */
    expect(isIgnored(rules(), '_to_delete/some-old-run/notes.md')).toBe(true);
  });

  it('excludes every secret-bearing SHAPE, at the top of the tree and buried deep in it', () => {
    const r = rules();
    const missed = shapeProbes().filter((p) => !isIgnored(r, p));
    expect(
      missed,
      'the ignore file does not cover these, and a shape that stops covering a '
      + `subtree fails towards silence: ${missed.join(', ')}`,
    ).toEqual([]);
  });

  it('names a shape for every container of a private key, seed or passphrase this list knows', () => {
    // The list is the assertion. A shape removed from it removes an exclusion
    // nobody will notice is gone, so the count is written down here too.
    expect(SECRET_SHAPES.length).toBeGreaterThanOrEqual(21);
    for (const s of ['a.pem', 'a.key', 'a.seed', 'a.mnemonic', 'id_rsa', 'a.kdbx']) {
      expect(SECRET_SHAPES).toContain(s);
    }
  });
});

describe('and it excludes NOTHING that ships, which is the other direction', () => {
  it('leaves every file on the take list tracked', () => {
    const r = rules();
    const excluded = takeList().filter((f) => isIgnored(r, f));
    expect(
      excluded,
      'a file that would be published is excluded by the ignore file, so the '
      + `publication would silently drop it: ${excluded.slice(0, 10).join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * ── THE MATCHER ITSELF, PINNED BY THE THREE WAYS A RULE STOPS COVERING ──
 *
 * These are the mutations the assertions above were watched failing against.
 * They are here as well as in the account because the next person to touch the
 * matcher needs them beside the code, not in a document.
 */
describe('the three ways a present rule covers less than it reads as covering', () => {
  it('ANCHORING narrows it: `/x.seed` stops covering a subtree that `x.seed` covered', () => {
    expect(isIgnored(parseIgnore('*.seed'), 'apps/wallet/a.seed')).toBe(true);
    expect(isIgnored(parseIgnore('/*.seed'), 'apps/wallet/a.seed')).toBe(false);
  });

  it('A NEGATION BELOW IT reaches back over it, and the last match wins', () => {
    expect(isIgnored(parseIgnore('*.seed'), 'a.seed')).toBe(true);
    expect(isIgnored(parseIgnore('*.seed\n!a.seed'), 'a.seed')).toBe(false);
    expect(isIgnored(parseIgnore('*.seed\n!a.seed\n*.seed'), 'a.seed')).toBe(true);
  });

  it('A TRAILING SLASH makes it a rule about directories, and a file of that name escapes', () => {
    expect(isIgnored(parseIgnore('keys'), 'keys')).toBe(true);
    expect(isIgnored(parseIgnore('keys/'), 'keys', false)).toBe(false);
    expect(isIgnored(parseIgnore('keys/'), 'keys/private.pem')).toBe(true);
  });

  it('a comment and a blank line are not rules, and an escaped `#` names a file', () => {
    expect(parseIgnore('# *.seed\n\n   \n*.key')).toHaveLength(1);
    // The second half of this name used to go unchecked, which is a test that
    // reads as a two-sided pin and is one-sided.
    expect(parseIgnore('\\#notes.txt')[0].pattern).toBe('#notes.txt');
    expect(isIgnored(parseIgnore('\\#notes.txt'), '#notes.txt')).toBe(true);
  });

  it('`*` stops at a separator, and `**` crosses one only where it is a WHOLE SEGMENT', () => {
    expect(isIgnored(parseIgnore('/a/*/c'), 'a/b/c')).toBe(true);
    expect(isIgnored(parseIgnore('/a/*/c'), 'a/b/x/c')).toBe(false);
    expect(isIgnored(parseIgnore('/a/**/c'), 'a/b/x/c')).toBe(true);
    expect(isIgnored(parseIgnore('/a/**/c'), 'a/c')).toBe(true);
    expect(isIgnored(parseIgnore('/a/**'), 'a/b/c')).toBe(true);
    /*
     * ── THE HALF THIS TEST USED TO LEAVE OUT, AND IT WAS THE HALF THAT WAS
     *    WRONG ─────────────────────────────────────────────────────────────
     *
     * It asserted only that a double star crosses a separator. It never
     * asserted that it does not cross anything ELSE - and the matcher wrote it
     * as *anything at all*, so a rule about a `keys` directory matched a file
     * called `mykeys` and this module said IGNORED about a path the real thing
     * tracks. **That is the fatal direction**: an assertion built on it stays
     * green while the tree is unprotected.
     */
    expect(isIgnored(parseIgnore('**/keys'), 'mykeys')).toBe(false);
    expect(isIgnored(parseIgnore('**/keys'), 'a/keys')).toBe(true);
    expect(isIgnored(parseIgnore('/a/**/c'), 'a/bc')).toBe(false);
  });

  it('cannot re-include a file that sits under an EXCLUDED DIRECTORY, because the real thing cannot', () => {
    // The real thing never descends into a directory it excluded, so a
    // re-inclusion below one reaches nothing. Reading such a file as tracked
    // here would mean a published file silently absent from the publication.
    expect(isIgnored(parseIgnore('sec/\n!sec/a.key'), 'sec/a.key')).toBe(true);
    // and the idiom that DOES work, which this repository uses for one file:
    expect(isIgnored(parseIgnore('k/*\n!k/m.json'), 'k/m.json')).toBe(false);
    expect(isIgnored(parseIgnore('k/*\n!k/m.json'), 'k/other.bin')).toBe(true);
  });

  it('FLAGS a rule shape it does not implement, rather than answering with a guess', () => {
    /*
     * A character class is spelled differently here: `[!x]` is a negation in an
     * ignore file and a four-character literal class in a regular expression.
     * Translated by eye it under-matches, and under-matching a NEGATION leaves
     * this saying IGNORED about a path the real thing tracks. **A shape this
     * cannot spell is declined and reported**, which is the only answer that
     * cannot be wrong in the dangerous direction.
     */
    const rules = parseIgnore('*.key\n![!z]*.key');
    expect(unsupportedRules(rules).map((r) => r.unsupported)).toEqual(['a character class']);
    expect(isIgnored(rules, 'a.key')).toBe(true);
  });

  it('and the ignore file this repository ships contains no shape this declines', () => {
    // The assertions in this file are only worth their words while every rule
    // was actually interpreted. If this goes red, a rule was added that the
    // matcher declines and every verdict above was computed without it.
    expect(unsupportedRules(rules()).map((r) => r.source)).toEqual([]);
  });
});

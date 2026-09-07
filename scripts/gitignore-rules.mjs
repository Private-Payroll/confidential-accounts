/**
 * WHAT THE IGNORE FILE ACTUALLY DECIDES, AS RULES SOMETHING CAN TEST.
 *
 * ── WHY THIS IS A MODULE AND NOT A GREP ─────────────────────────────────
 *
 * The thing worth asserting is not that a line of text is present. It is that a
 * PATH would be excluded. Those come apart in every direction that matters: a
 * pattern can be anchored later and stop covering a subtree, a negation added
 * below it can reach back over it, a trailing slash can turn a rule that
 * covered a file into one that only covers a directory. **A test that greps for
 * `*.seed` stays green through all three.**
 *
 * The half this replaces is a real event rather than a hypothetical. Shapes for
 * key material lived in one folder's own ignore file; a merge moved the files
 * out from under it and left the shapes behind, so for a period a whole subtree
 * was covered for two exact filenames and for no shape at all. Nothing said so,
 * because nothing was asking the question in a form that could be answered.
 *
 * ── SOUNDNESS, AND WHICH WAY IT ERRS ────────────────────────────────────
 *
 * This implements the part of the ignore syntax this repository uses: last
 * matching pattern wins, `!` negates, a trailing `/` matches directories only,
 * a pattern containing a slash anywhere but at its end is anchored to the top,
 * anything else matches at any depth, `*` does not cross a separator, and `**`
 * crosses one only where it is a whole path segment.
 *
 * **THE DANGEROUS ANSWER IS `true`.** An assertion built on this reads *would
 * this path be excluded*, so a rule shape that made it answer `true` where the
 * real thing answers `false` would leave a test green over an unprotected tree.
 * That is why a shape this does not implement is FLAGGED rather than
 * approximated: `parseIgnore` marks such a rule `unsupported`, `isIgnored`
 * ignores it entirely rather than guessing, and `unsupportedRules` lets a
 * caller refuse. **The first draft of this file claimed that property in this
 * paragraph and had no mechanism for it**, which is the same failure it exists
 * to catch, one level up.
 *
 * WHAT IS FLAGGED, EACH MEASURED AGAINST THE REAL THING BEFORE BEING LISTED:
 *   a `[…]` character class, whose `[!x]` negation is spelled `[^x]` here and
 *   would otherwise silently under-match; and a re-inclusion below an excluded
 *   DIRECTORY, which the real thing cannot perform at all and this would.
 */

/** One rule, in the order it was written. */
export const parseIgnore = (text) => {
  const rules = [];
  for (const raw of String(text).split('\n')) {
    let line = raw;
    if (/^\s*$/.test(line)) continue;
    if (/^\s*#/.test(line)) continue;
    line = line.replace(/\s+$/, '');
    let negated = false;
    if (line.startsWith('!')) { negated = true; line = line.slice(1); }
    if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    if (!line) continue;
    let anchored = false;
    if (line.startsWith('/')) { anchored = true; line = line.slice(1); }
    else if (line.slice(0, -1).includes('/')) anchored = true;
    // A CHARACTER CLASS IS NOT SPELLED THE SAME WAY HERE, so it is flagged
    // rather than translated: `[!x]` means `[^x]` in an ignore file and means a
    // four-character literal class in a regular expression, which under-matches
    // - and under-matching a NEGATION leaves this saying "ignored" about a path
    // the real thing would track.
    const unsupported = /\[/.test(line) ? 'a character class' : null;
    rules.push({ pattern: line, negated, dirOnly, anchored, unsupported, source: raw });
  }
  return rules;
};

/**
 * THE RULES THIS MODULE DECLINED TO INTERPRET. A caller that needs a sound
 * answer refuses when this is not empty, rather than reading a verdict that was
 * computed with some of the file left out.
 */
export const unsupportedRules = (rules) => rules.filter((r) => r.unsupported);

/**
 * A GLOB, SEGMENT BY SEGMENT. `*` stops at a separator, `**` does not, `?` is
 * one character that is not a separator, and a character class is passed
 * through. Everything else is a literal.
 */
const toRegExp = (pattern) => {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      /**
       * `**` CROSSES A SEPARATOR ONLY WHERE IT IS A WHOLE SEGMENT.
       *
       * Collapsing every `**` to `.*` makes it cross non-separator boundaries
       * as well: a double star followed by a slash and `keys` then matches
       * `mykeys`, which the real thing does not.
       * **That is the fatal direction** - this module saying "ignored" about a
       * path git would track leaves an assertion green over an unprotected
       * tree. So a `**` that is not a whole segment is treated as the two
       * single stars it is written as.
       */
      const wholeSegment = (i === 0 || pattern[i - 1] === '/')
        && (pattern[i + 2] === '/' || i + 2 === pattern.length);
      if (pattern[i + 1] === '*' && wholeSegment) {
        if (pattern[i + 2] === '/') {
          // A LEADING OR MIDDLE `**/` IS *ZERO OR MORE WHOLE DIRECTORIES*, and
          // writing it as `.*` makes it half a directory as well.
          out += '(?:[^/]*/)*'; i += 2;
        } else {
          // A TRAILING `/**` IS EVERYTHING BENEATH.
          out += '.*'; i++;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      // Flagged at parse time; never reached for a rule `isIgnored` acts on.
      out += '\\[';
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
};

const matchesRule = (rule, path, isDir) => {
  if (rule.dirOnly && !isDir) {
    // A directory-only rule still excludes everything under that directory.
    const re = toRegExp(rule.pattern);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (rule.anchored ? re.test(prefix) : re.test(prefix) || re.test(parts[i - 1])) return true;
    }
    return false;
  }
  const re = toRegExp(rule.pattern);
  if (rule.anchored) {
    if (re.test(path)) return true;
    // and everything beneath a directory the rule names
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (re.test(parts.slice(0, i).join('/'))) return true;
    return false;
  }
  // Unanchored: the rule matches at any depth, against a path suffix.
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (re.test(parts.slice(i).join('/'))) return true;
    if (i < parts.length - 1 && re.test(parts[i])) return true;
  }
  return re.test(parts[parts.length - 1]);
};

/**
 * TRUE WHEN GIT WOULD IGNORE `path`. Last matching rule wins, which is what
 * makes a negation written later able to reach back over a rule written
 * earlier - the exact shape that nearly reversed this repository's own
 * exclusion of one file during a merge.
 */
export const isIgnored = (rules, path, isDir = false) => {
  let verdict = false;
  let excludedDirectory = false;
  for (const r of rules) {
    if (r.unsupported) continue;
    if (!matchesRule(r, path, isDir)) continue;
    /**
     * A FILE UNDER AN EXCLUDED DIRECTORY CANNOT BE RE-INCLUDED. The real thing
     * never descends into a directory it excluded, so a `!` below such a rule
     * reaches nothing. Without this, a take-list file sitting under one would
     * read as tracked here and be silently dropped from the publication.
     */
    if (!r.negated) {
      verdict = true;
      if (r.dirOnly || (!r.dirOnly && path.startsWith(`${r.pattern.replace(/^\//, '')}/`))) {
        excludedDirectory = excludedDirectory || matchesParentDirectory(r, path);
      }
      continue;
    }
    if (excludedDirectory) continue;
    verdict = false;
  }
  return verdict;
};

/** True when the rule excluded a DIRECTORY on `path`'s way down, rather than the path itself. */
const matchesParentDirectory = (rule, path) => {
  const re = toRegExp(rule.pattern);
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (rule.anchored ? re.test(prefix) : (re.test(prefix) || re.test(parts[i - 1]))) return true;
  }
  return false;
};

/**
 * THE SHAPES A REPOSITORY THAT HOLDS KEY MATERIAL MUST EXCLUDE, AND THE
 * FILENAME EACH ONE STANDS FOR.
 *
 * **A LIST, RATHER THAN A JUDGEMENT MADE AGAIN EACH TIME.** Every entry is a
 * container for a private key, a seed or a passphrase. Public halves are
 * deliberately absent: a certificate and a public key are meant to be read, and
 * a rule that excluded them would be a rule somebody eventually deletes for
 * being wrong, taking the rest of the list with it.
 */
export const SECRET_SHAPES = [
  'a.pem', 'a.key', 'a.mnemonic', 'a.p12', 'a.pfx', 'a.p8', 'a.jks',
  'a.keystore', 'a.kdbx', 'a.seed', 'seed-phrase.txt', 'wallet.seed',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'a.ppk', 'a.asc', 'a.gpg',
  '.env.local', '.env.production',
];

/** Each shape, at the top and buried deep, because depth is where a rule stops covering. */
export const shapeProbes = (shapes = SECRET_SHAPES) => {
  const out = [];
  for (const s of shapes) {
    out.push(s);
    out.push(`apps/wallet/${s}`);
    out.push(`packages/identity/src/deep/${s}`);
  }
  return out;
};

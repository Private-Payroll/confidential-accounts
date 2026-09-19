/**
 * THE SECRET SCAN. IT EXTRACTS, IT DOES NOT RECOGNISE.
 *
 * ── WHY THIS FILE EXISTS, AND WHY THE ORDER OF ITS TWO HALVES IS THE WHOLE
 *    DESIGN ────────────────────────────────────────────────────────────────
 *
 * A scanner that matches PATTERNS answers a different question from the one
 * being asked, and answers it confidently. `sk-`, `ghp_`, `AKIA`, a PEM header
 * and a connection string are the shapes somebody thought of. **A wallet seed
 * is sixty-four hexadecimal characters and so is a contract address. Nothing
 * about the shape separates them, and the file that settles it is on disk.**
 *
 * That is not a hypothetical. The door that stood here before this one printed
 * `contents clean` over a file carrying this project's wallet seed, and on the
 * same night a person looked straight at the same value, reasoned from its
 * shape, and ruled it public. The value was four directories away in a file
 * neither of them opened.
 *
 * **SO: READ THE SECRETS FIRST. THEN SEARCH FOR WHAT YOU READ.** A value's
 * shape is a hypothesis; the only evidence is the file it came from.
 *
 * ── THE REPORT MAY NOT CONTAIN THE THING IT IS ABOUT ─────────────────────
 *
 * This scanner's own report is written to disk, in the same folder family as
 * the files where the seed already is. **A report that prints the value, a
 * prefix of it, or a hash anybody could compare against a candidate, IS the
 * defect it was built to stop.** So a finding names a PLACE — `file:line` —
 * and the NAME of the file the value was read out of. Never the value.
 *
 * `assertReportCarriesNoValue()` at the bottom is the mechanical half of that
 * sentence: the report text is checked against every extracted value before it
 * is handed back, and a report that carries one is refused rather than
 * written. A rule that depends on every future edit remembering is not a rule.
 *
 * ── WHAT IT SCANS: THE LIST IT IS GIVEN ─────────────────────────────────
 *
 * Not the tracked tree. Nothing here asks `git` anything — this module is read
 * by a session that may not run `git` at all, and more importantly a fresh
 * `git init` re-decides what is ignored from nothing. **`REPORT-*.txt` and
 * `logs/` are ignored TODAY; that is a fact about a file somebody wrote, not a
 * property of the repository.** The caller supplies the paths.
 *
 * ── IT CARRIES TWO NON-SECRET SHAPES, BECAUSE ONE ACCIDENT PUBLISHES ALL
 *    THREE ──────────────────────────────────────────────────────────────
 *
 *   A PERSON'S HOME DIRECTORY — refuses. A file may not name a person, and a
 *   home directory names one. Derived from the running machine rather than
 *   written down, so nothing here has to carry the name it is looking for.
 *
 *   THE PROCESS — reports, and does not refuse. Work-session ids, audit
 *   definition names, the vocabulary of how work reaches a machine. Removing
 *   those is a sweep over every file that ships and it is somebody else's
 *   round; a door that refuses until an unscheduled sweep lands is a door that
 *   gets switched off. **So it counts them and says so, loudly, in its own
 *   section.**
 *
 * ── NOTHING IN THIS FILE NAMES THIS REPOSITORY ──────────────────────────
 *
 * Every root, hint, pattern and limit arrives in a config object. A second
 * repository is set up by the same code with a different config, which is why
 * there is no constant here holding a folder name.
 */
import { readFileSync, readdirSync, lstatSync, existsSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { join, sep, basename } from 'node:path';
import { homedir } from 'node:os';

/* ------------------------------------------------------------------ glob --- */

/**
 * `*` matches within a segment, `**` across segments, `?` one character.
 * Written out rather than imported: this file is copied into other folders and
 * a dependency is a thing that can be absent there.
 */
export const globToRegExp = (pattern) => {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i++; if (pattern[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
};

/** True when `rel` (POSIX-spelled, repository-relative) matches any pattern. */
export const matchesAny = (rel, patterns) =>
  patterns.some((p) => {
    const re = globToRegExp(p);
    if (re.test(rel)) return true;
    // A bare directory name means the directory and everything under it. Said
    // here once rather than requiring every config line to end in `/**`, which
    // is the kind of detail a config gets wrong silently.
    return globToRegExp(p.replace(/\/+$/, '') + '/**').test(rel);
  });

/* ---------------------------------------------------------------- config --- */

export const CONFIG_DEFAULTS = {
  secrets: {
    roots: [],
    /** A JSON key or dotenv name containing one of these makes its value a candidate whatever its shape. */
    fieldHints: ['key', 'secret', 'seed', 'salt', 'blinding', 'wrapping', 'mnemonic',
      'private', 'password', 'passphrase', 'token', 'credential', 'auth'],
    /** Below this, a value matches everywhere and the door becomes noise. Dropped values are COUNTED and reported. */
    minLength: 12,
    /**
     * READ NO MORE THAN THIS AT ONCE. IT IS A WINDOW, NOT A LIMIT.
     *
     * It used to be a limit, and a limit is the wrong shape here: the comment
     * beside it said a file too big to read is a NAMED blind spot and never a
     * pass, and the code did the opposite - the file was named on the page and
     * the run still exited clean. A limit also goes stale in one direction
     * only. Every file in this tree is under it today; the next one that is not
     * arrives on its own, and the failure it produces is a pass.
     *
     * So a file larger than this is read in overlapping windows of this size
     * rather than skipped. There is no size at which a file stops being looked
     * at, and nothing has to remember to raise a number.
     */
    maxFileBytes: 2 * 1024 * 1024,
    /**
     * THE LONGEST RUN A WINDOW BOUNDARY CAN PROMISE TO SHOW WHOLE.
     *
     * Windows overlap by this much, so any value shorter than it lies wholly
     * inside at least one window. A run longer than it is a NAMED BLIND SPOT
     * that refuses, rather than a value quietly cut in half at a boundary and
     * searched for as two halves that match nothing.
     */
    maxValueBytes: 64 * 1024,
    /**
     * A line carrying this text is exempt, and nothing else is. The exemption
     * is visible in the source next to the thing exempted. A real secret would
     * have to be deliberately labelled as not one, which is a different kind of
     * mistake from an accident.
     */
    marker: 'not-a-secret',
    /**
     * Values that are extracted, matched, COUNTED and reported — and do not
     * refuse. **Every entry needs a written reason, and the default is empty
     * on purpose.** Declaring a value public because of what its field is
     * called is the exact reasoning this scanner exists to replace.
     */
    publicValues: [],
  },
  person: { patterns: [], deriveHomeDirectory: true },
  process: { patterns: [] },
};

/**
 * THE DEFAULTS ARE APPLIED WHERE THE VALUE IS USED, NOT ONLY WHERE THE FILE IS
 * READ. `loadConfig` is one way in; a caller with a literal object is another,
 * and an exported function that silently loses the `marker` or the size cap
 * because somebody passed a partial object is an exemption switching itself
 * off. So every entry point runs this.
 */
export const withDefaults = (cfg) => ({
  ...cfg,
  secrets: { ...CONFIG_DEFAULTS.secrets, ...(cfg?.secrets ?? {}) },
  person: { ...CONFIG_DEFAULTS.person, ...(cfg?.person ?? {}) },
  process: { ...CONFIG_DEFAULTS.process, ...(cfg?.process ?? {}) },
});

/**
 * A JSON syntax error's message quotes the text around the fault, and THE ONE
 * FILE THIS PARSES IS THE FILE DESIGNED TO HOLD REAL VALUES in `publicValues`.
 * So the position is kept and the quotation is not.
 */
const safeParseComplaint = (e) => {
  const m = /(at position \d+(?: \(line \d+ column \d+\))?|line \d+ column \d+)/.exec(String(e?.message ?? ''));
  return m ? `not readable JSON, ${m[1]}` : 'not readable JSON';
};

export const loadConfig = (configPath) => {
  if (!existsSync(configPath)) throw new Error(`no config at ${configPath}`);
  let raw;
  try { raw = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch (e) { throw new Error(`the config at ${configPath} is ${safeParseComplaint(e)}`); }
  const cfg = withDefaults(raw);
  if (!Array.isArray(cfg.secrets.roots) || cfg.secrets.roots.length === 0) {
    throw new Error(`${configPath}: secrets.roots is empty — a scanner with no secret roots passes everything`);
  }
  return cfg;
};

/* ------------------------------------------------------------ extraction --- */

const HEX = /\b[0-9a-fA-F]{32,}\b/g;
const HEX_WHOLE = /^[0-9a-fA-F]{32,}$/;
const B64 = /\b[A-Za-z0-9+/]{40,}={0,2}/g;

const isBinary = (buf) => {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
};

/**
 * DECIDED FROM THE FIRST EIGHT KILOBYTES, BEFORE THE SIZE CAP, AND THAT ORDER
 * IS THE POINT. Proving parameters are tens of megabytes of binary. Reported as
 * *larger than the cap* they sit in the blind-spot block on every single run and
 * teach a reader to skim the one block that has to be read. Reported as *binary*
 * they are what they are, and the size cap then names only the case worth
 * looking at: a large TEXT file nobody scanned.
 */
const looksBinary = (abs) => {
  let fd;
  try { fd = openSync(abs, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } catch { return false; } finally { try { closeSync(fd); } catch { /* nothing to do */ } }
};

/**
 * READ A FILE IN OVERLAPPING WINDOWS, SO THAT SIZE IS NEVER AN ANSWER.
 *
 * `onWindow(buf, baseOffset)` is called with a slice of the file and the byte
 * offset that slice starts at. Consecutive windows OVERLAP by `overlapBytes`,
 * so any run of bytes shorter than the overlap lies wholly inside at least one
 * window and cannot be halved by a boundary.
 *
 * **THE BUFFER HANDED TO `onWindow` IS REUSED BETWEEN WINDOWS.** A caller that
 * wants to keep bytes past the call copies them. Said here because the
 * alternative is a caller holding a view that silently becomes the next window.
 *
 * A file at or under one window is one call at offset 0, which is the path
 * every file in this repository takes today - so the common case is not a new
 * code path, it is this one with a single window.
 */
const readWindows = (abs, size, windowBytes, overlapBytes, onWindow) => {
  const win = Math.max(1, windowBytes);
  const step = Math.max(1, win - Math.max(0, overlapBytes));
  const fd = openSync(abs, 'r');
  /**
   * READ ANY STRETCH OF THE FILE, WHICHEVER WINDOW IS CURRENT. A run that
   * reaches a window edge may continue past it, and a caller that can read
   * outward settles how far it goes instead of guessing from one window.
   */
  const readAt = (offset, length) => {
    if (offset < 0 || length <= 0 || offset >= size) return Buffer.alloc(0);
    const want = Math.min(length, size - offset);
    const b = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, b, got, want - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    return b.subarray(0, got);
  };
  try {
    const buf = Buffer.alloc(Math.min(win, Math.max(size, 1)));
    for (let start = 0; start < size || start === 0; start += step) {
      let read = 0;
      while (read < buf.length && start + read < size) {
        const n = readSync(fd, buf, read, Math.min(buf.length - read, size - start - read), start + read);
        if (n <= 0) break;
        read += n;
      }
      onWindow(buf.subarray(0, read), start, readAt);
      if (start + read >= size) break;
      if (read === 0) break;
    }
  } finally { try { closeSync(fd); } catch { /* nothing to do */ } }
};

/**
 * GROW A RUN THAT REACHED A WINDOW EDGE UNTIL IT ENDS, OR UNTIL IT PASSES THE
 * CEILING AND BECOMES A NAMED BLIND SPOT.
 *
 * Without this, a value lying across a window boundary is seen as two pieces,
 * neither of which is the value, and a literal search for either finds nothing.
 * **That is a boundary deciding what gets looked for, which is the same class
 * of defect as a size limit deciding it.**
 *
 * Returns the whole run and whether it is complete. `ok === false` means the
 * run passed `ceiling` and nothing can promise to have seen it whole.
 */
const growRun = (readAt, absStart, absEnd, size, isMember, ceiling) => {
  const STEP = 4096;
  let a = absStart;
  let b = absEnd;
  while (a > 0) {
    const from = Math.max(0, a - STEP);
    const chunk = readAt(from, a - from);
    let i = chunk.length;
    while (i > 0 && isMember(chunk[i - 1])) i--;
    a = from + i;
    if (i > 0 || from === 0) break;
    if (b - a > ceiling) return { start: a, end: b, ok: false };
  }
  while (b < size) {
    const chunk = readAt(b, STEP);
    if (chunk.length === 0) break;
    let i = 0;
    while (i < chunk.length && isMember(chunk[i])) i++;
    b += i;
    if (i < chunk.length) break;
    if (b - a > ceiling) return { start: a, end: b, ok: false };
  }
  if (b - a > ceiling) return { start: a, end: b, ok: false };
  return { start: a, end: b, ok: true };
};

/**
 * A READ THAT STOPPED SHORT OF THE FILE IS A BLIND SPOT.
 *
 * The size comes from an `lstat` taken before the read. A file that shrinks
 * between the two, or a short read from the operating system, ends the loop
 * with a tail nobody looked at - and without this, nothing anywhere says so and
 * the verdict is still clean. **A partial read is only not a blind spot when
 * something has checked that it was not partial.**
 *
 * SEPARATED FROM THE READING SO IT CAN BE TESTED WITHOUT STAGING A RACE. A rule
 * that can only be exercised by making a file shrink underneath a running
 * process is a rule nobody watches fail.
 */
export const shortReadSkip = (path, expected, reached) => (
  reached >= expected ? null : {
    path,
    kind: 'short-read',
    why: `${expected} bytes were expected and ${reached} were read, so the rest of it was never looked at`,
  }
);

const HEX_BYTE = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const B64_BYTE = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61;

/**
 * `lstat`, NOT `stat`, AND THAT IS NOT A DETAIL. `.keys-backup/latest` is a
 * symlink into its own parent; following links means reading everything twice
 * today and looping for ever the day one points at an ancestor. A link is
 * NAMED and not followed, so what was skipped is on the page.
 */
const walkFiles = (root, absRoot, out, skipped) => {
  let st;
  try { st = lstatSync(absRoot); } catch { skipped.push({ path: root, kind: 'absent', why: 'absent' }); return; }
  if (st.isSymbolicLink()) { skipped.push({ path: root, kind: 'symlink', why: 'a symbolic link, not followed' }); return; }
  if (st.isFile()) { out.push({ rel: root, abs: absRoot, size: st.size }); return; }
  if (!st.isDirectory()) { skipped.push({ path: root, kind: 'not-regular', why: 'not a regular file' }); return; }
  let names;
  try { names = readdirSync(absRoot).sort(); } catch { skipped.push({ path: root, kind: 'unreadable', why: 'unreadable' }); return; }
  for (const n of names) {
    const childRel = `${root}/${n}`;
    const childAbs = join(absRoot, n);
    let cst;
    // A CHILD IS RECORDED THE SAME WAY A ROOT IS. Until 7 Sep the root branch
    // above named a thing it could not read and this loop dropped it: a socket,
    // a device node, or an entry whose `lstat` throws left no trace at all, so
    // a file that was not read reached a clean verdict without appearing on the
    // page. **Not read and not named is worse than not read.**
    try { cst = lstatSync(childAbs); } catch { skipped.push({ path: childRel, kind: 'unreadable', why: 'unreadable' }); continue; }
    if (cst.isSymbolicLink()) { skipped.push({ path: childRel, kind: 'symlink', why: 'a symbolic link, not followed' }); continue; }
    if (cst.isDirectory()) walkFiles(childRel, childAbs, out, skipped);
    else if (cst.isFile()) out.push({ rel: childRel, abs: childAbs, size: cst.size });
    else skipped.push({ path: childRel, kind: 'not-regular', why: 'not a regular file' });
  }
};

/** Every string leaf of a parsed JSON value, with the key that carried it. */
const jsonLeaves = (node, keyPath, out) => {
  if (typeof node === 'string') { out.push({ key: keyPath, value: node }); return out; }
  if (Array.isArray(node)) { node.forEach((v, i) => jsonLeaves(v, `${keyPath}[${i}]`, out)); return out; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) jsonLeaves(v, keyPath ? `${keyPath}.${k}` : k, out);
  }
  return out;
};

/**
 * EVERY VALUE THIS REPOSITORY HOLDS THAT COULD BE KEY MATERIAL.
 *
 * Four routes into the candidate set, and a value found by any of them counts:
 *
 *   1. THE WHOLE FILE. A `.seed` file is sixty-four characters and a newline.
 *      Nothing about its CONTENT says what it is; its being in the secret root
 *      is what says it.
 *   2. A NAMED FIELD. A JSON key or a dotenv name containing `key`, `secret`,
 *      `seed`, … makes its value a candidate WHATEVER ITS SHAPE — because a
 *      shape test is the thing that failed.
 *   3. A HEX OR BASE64 RUN, anywhere in the text of a file in the root.
 *   4. A DOTENV ASSIGNMENT's right-hand side.
 *
 * Every value carries the file it came from, so a finding can name the source
 * without naming the value.
 */
export const extractCandidates = (repoRoot, rawCfg) => {
  const cfg = withDefaults(rawCfg);
  const { roots, fieldHints, minLength, maxFileBytes, maxValueBytes } = cfg.secrets;
  const files = [];
  const skipped = [];
  for (const r of roots) {
    // A root may be a glob; resolve it against the repository's top level only,
    // which is where every secret root in this project's shape lives.
    if (r.includes('*')) {
      const re = globToRegExp(r);
      let names = [];
      try { names = readdirSync(repoRoot).sort(); } catch { /* named below */ }
      const hit = names.filter((n) => re.test(n));
      if (hit.length === 0) skipped.push({ path: r, kind: 'matched-nothing', why: 'matched nothing' });
      for (const n of hit) walkFiles(n, join(repoRoot, n), files, skipped);
    } else {
      walkFiles(r, join(repoRoot, r), files, skipped);
    }
  }

  const byValue = new Map();
  const tooShort = [];
  const asPath = [];

  /**
   * A VALUE THAT IS A PATH TO A FILE IN THIS REPOSITORY IS A PATH, NOT A SECRET.
   *
   * **WHY THIS RULE EXISTS.** Route 3 reads any base64 run out of a file in a
   * secret root, and `/` is a base64 character, so a FILE PATH is a valid run.
   * `.midnight/take-list-purpose.baseline` lists every published path with its
   * purpose, and it lives in a secret root - so every path in this repository is
   * a candidate secret, and any file that names one in a comment refuses.
   * On 19 Sep that refused a commit over
   * `packages/identity/src/profile/disclosure`, a file that is on disk and in
   * the published set. The run stops at the dot, which is why the value looks
   * like a path with its extension shorn off.
   *
   * **THIS IS NARROWER THAN AN EXEMPTION AND THAT IS THE POINT.** The config
   * already carries `publicValues`, and adding one line to it per round would
   * have worked and would have grown a hole nobody re-reads. A rule that says
   * *this resolves to a file* is checkable by anybody, needs no reason written
   * beside it, and cannot be used to wave through a value that is not a file.
   *
   * **WHAT IT DOES NOT EXEMPT.** A value with no `/` is never excluded, so a
   * sixty-four character seed stays a candidate whatever it resembles. A value
   * that does not resolve on disk is never excluded, so a base64 key containing
   * slashes stays a candidate. Both halves must hold.
   */
  const resolvesToAFile = (v) => {
    if (!v.includes('/')) return false;
    if (v.startsWith('/') || v.includes('..')) return false;
    try {
      if (existsSync(join(repoRoot, v)) && !lstatSync(join(repoRoot, v)).isDirectory()) return true;
      // The run stops at a dot, so the extension is shorn off. Ask the parent
      // directory whether anything there is this name plus an extension.
      const cut = v.lastIndexOf('/');
      const dir = join(repoRoot, v.slice(0, cut));
      const stem = v.slice(cut + 1);
      if (!stem) return false;
      return readdirSync(dir).some((n) => n.startsWith(stem + '.'));
    } catch { return false; }
  };

  const add = (value, sourceFile, field, kind) => {
    if (typeof value !== 'string') return;
    const v = value.trim();
    if (v.length < minLength) { tooShort.push({ sourceFile, field }); return; }
    if (resolvesToAFile(v)) { asPath.push({ sourceFile, field, value: v }); return; }
    if (!byValue.has(v)) byValue.set(v, { value: v, sources: [], kinds: new Set() });
    const c = byValue.get(v);
    if (!c.sources.some((s) => s.sourceFile === sourceFile && s.field === field)) {
      c.sources.push({ sourceFile, field });
    }
    c.kinds.add(kind);
  };

  const hinted = (name) => {
    const l = String(name).toLowerCase();
    return fieldHints.some((h) => l.includes(String(h).toLowerCase()));
  };

  /**
   * READ BUT NOT BY EVERY ROUTE. REPORTED, AND NOT A REFUSAL, BECAUSE THE
   * ROUTES THAT DID NOT APPLY COULD NOT HAVE APPLIED.
   *
   * A file that is not text has no whole-file token, no JSON leaf and no
   * dotenv assignment. What it can still carry is an ASCII run, and until
   * 7 Sep this scanner did not look: a binary file was skipped whole.
   * **MEASURED IN THIS TREE ON THE DAY THAT CHANGED: 46 distinct high-entropy
   * ASCII values live inside the wallet's own database pages, every one of
   * them invisible to the extraction, and one of the 46 stands in a file that
   * ships.** The pages are binary; the values in them are not.
   */
  const partial = [];
  /**
   * A RUN LONGER THAN THE CEILING. A NAMED BLIND SPOT.
   *
   * RECORDED ONCE PER RUN AND NOT ONCE PER PATTERN. The hex and base64
   * alphabets overlap, so a run of hexadecimal characters is matched by both
   * and was counted twice - two blind spots reported where one exists, on the
   * one page whose whole subject is an honest count of what was not looked at.
   */
  const tooLong = [];
  const tooLongSeen = new Set();
  const noteTooLong = (path, start, length) => {
    const key = `${path}@${start}`;
    if (tooLongSeen.has(key)) return;
    tooLongSeen.add(key);
    tooLong.push({ path, start, length, ceiling: maxValueBytes });
  };

  for (const f of files) {
    const windowBytes = Math.max(1, maxFileBytes);
    const overlap = Math.max(1, Math.min(maxValueBytes, windowBytes - 1));
    let binary = looksBinary(f.abs);
    let unreadable = false;

    /**
     * ROUTE 3 RUNS OVER BYTES, DECODED `latin1` SO THAT ONE BYTE IS ONE
     * CHARACTER AND AN OFFSET IS AN OFFSET. Hex and base64 are ASCII, so
     * nothing a run can be made of is altered by that decoding - and a
     * `utf8` decode of a window would move every offset after the first
     * multi-byte character, which is how a boundary calculation goes wrong
     * silently.
     */
    const runsIn = (win, base, readAt) => {
      const t = win.toString('latin1');
      for (const re of [HEX, B64]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(t)) !== null) {
          const startsAtEdge = m.index === 0 && base > 0;
          const endsAtEdge = m.index + m[0].length === win.length && base + win.length < f.size;
          if (!startsAtEdge && !endsAtEdge) {
            if (m[0].length > maxValueBytes) noteTooLong(f.rel, base + m.index, m[0].length);
            else add(m[0], f.rel, '(value in text)', re === HEX ? 'hex' : 'base64');
            continue;
          }
          const grown = growRun(
            readAt, base + m.index, base + m.index + m[0].length, f.size,
            re === HEX ? HEX_BYTE : B64_BYTE, maxValueBytes,
          );
          if (!grown.ok) { noteTooLong(f.rel, grown.start, grown.end - grown.start); continue; }
          const whole = readAt(grown.start, grown.end - grown.start).toString('latin1');
          if (whole.length >= minLength) add(whole, f.rel, '(value in text)', re === HEX ? 'hex' : 'base64');
        }
      }
    };

    // ROUTE 4 IS LINE-SHAPED, SO IT SURVIVES WINDOWING ON ITS OWN TERMS: a
    // window's first and last lines may be cut, and the overlap means a
    // neighbouring window carries them whole. A line longer than the overlap
    // is the case `tooLong` already names.
    const dotenvIn = (win, base) => {
      const t = win.toString('utf8');
      const lines = t.split('\n');
      const first = base > 0 ? 1 : 0;
      const last = base + win.length < f.size ? lines.length - 1 : lines.length;
      for (let i = first; i < last; i++) {
        const line = lines[i];
        if (/^\s*#/.test(line)) continue;
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const raw = m[2].trim();
        if (raw) add(raw, f.rel, m[1], 'named-field');
        const quoted = /^(['\"])([\s\S]*)\1$/.exec(raw);
        if (quoted) { if (quoted[2]) add(quoted[2], f.rel, m[1], 'named-field'); continue; }
        const uncommented = raw.replace(/\s+#.*$/, '').trim();
        if (uncommented && uncommented !== raw) add(uncommented, f.rel, m[1], 'named-field');
      }
    };

    const name = basename(f.rel);
    const isDotenv = name === '.env' || name.startsWith('.env.') || name === '.envrc';

    // 0. THE FILENAME ITSELF, whatever the contents turn out to be.
    if (name.length >= minLength && (HEX_WHOLE.test(name) || HEX_WHOLE.test(name.replace(/\.[^.]*$/, '')))) {
      add(name.replace(/\.[^.]*$/, ''), f.rel, '(the file name)', 'filename');
    }

    if (!binary && f.size <= windowBytes) {
      // THE PATH EVERY FILE IN THIS REPOSITORY TAKES TODAY, UNCHANGED.
      let buf;
      try { buf = readFileSync(f.abs); } catch { skipped.push({ path: f.rel, kind: 'unreadable', why: 'unreadable' }); continue; }
      if (isBinary(buf)) {
        // Text for eight kilobytes and binary after. Fall through to the byte
        // routes rather than dropping the file, which is what used to happen.
        binary = true;
      } else {
        const text = buf.toString('utf8');

        // 1. the whole file, when it is one token and nothing else
        const whole = text.trim();
        if (whole.length >= minLength && !/\s/.test(whole)) add(whole, f.rel, '(whole file)', 'whole-file');

        // 2. named fields
        if (name.endsWith('.json')) {
          try {
            for (const leaf of jsonLeaves(JSON.parse(text), '', [])) {
              if (hinted(leaf.key)) add(leaf.value, f.rel, leaf.key, 'named-field');
            }
          } catch { /* not JSON after all; routes 3 and 4 still apply */ }
        }

        // 4. dotenv assignments. BOTH FORMS OF EVERY VALUE GO IN, because
        //    guessing which one is the secret is the guessing this scanner
        //    exists to stop: the raw right-hand side, and the value with
        //    quotes and a trailing comment removed. A candidate that matches
        //    nothing costs nothing; a secret that was mis-parsed into a
        //    candidate nobody will ever find is a scanner reporting clean.
        if (isDotenv) dotenvIn(buf, 0);

        // 3. hex and base64 runs, wherever they are
        runsIn(buf, 0, (offset, length) => buf.subarray(offset, offset + length));
      }
    }

    if (binary || f.size > windowBytes) {
      /**
       * THE WINDOWED PATH: a file that is not text, or a file larger than one
       * window, or both. NEITHER IS A REASON TO STOP LOOKING, AND UNTIL 7 Sep
       * BOTH WERE.
       */
      /**
       * HOW FAR THE READ ACTUALLY GOT, AND NOT HOW FAR IT WAS ASKED TO GO.
       *
       * The size comes from an earlier `lstat`. A file that shrinks between the
       * two, or a short read, ends the loop with a tail nobody looked at - and
       * without this, nothing anywhere would have said so and the verdict would
       * still have been clean. **A partial read is a blind spot; it is only not
       * one when something checks that it was not partial.**
       */
      let reached = 0;
      try {
        readWindows(f.abs, f.size, windowBytes, overlap, (win, base, readAt) => {
          reached = Math.max(reached, base + win.length);
          if (isDotenv && !binary) dotenvIn(win, base);
          runsIn(win, base, readAt);
        });
      } catch { skipped.push({ path: f.rel, kind: 'unreadable', why: 'unreadable' }); unreadable = true; }
      const short = shortReadSkip(f.rel, f.size, reached);
      if (!unreadable && short) { skipped.push(short); unreadable = true; }
      if (!unreadable) {
        /**
         * TWO DIFFERENT SENTENCES, AND CONFLATING THEM WAS THIS CHANGE'S OWN
         * FIRST DEFECT.
         *
         * `partial` means READ, AND EVERY ROUTE THAT COULD APPLY DID. A file
         * that is not text has no whole-file token, no JSON leaf and no dotenv
         * assignment, so nothing was lost by those routes not running, and
         * saying so is honest.
         *
         * **A LARGE JSON FILE IS NOT THAT.** Its named fields would have been
         * extracted had it been smaller, and the JSON route needs the whole
         * text. Reported as `partial` it sat under a heading asserting nothing
         * was lost, with a clean verdict underneath - which is the exact shape
         * this whole change was made to remove, reproduced one line over. So it
         * is a BLIND SPOT and it refuses.
         */
        const routeMissed = !binary && basename(f.rel).endsWith('.json');
        if (routeMissed) {
          skipped.push({
            path: f.rel,
            kind: 'route-not-run',
            why: `larger than one ${windowBytes}-byte window, and its named fields cannot be read without parsing it whole`,
          });
        } else {
          partial.push({
            path: f.rel,
            why: binary
              ? 'not text, so it was read for ASCII runs only - the whole-file, JSON and dotenv routes cannot apply to it'
              // AND WHAT THE WHOLE-FILE ROUTE WOULD HAVE SAID IS NOT LOST BY
              // NOT RUNNING: a file this size that is one token and nothing
              // else is a run longer than the ceiling, which the run route
              // finds and names as a blind spot of its own.
              : `larger than one ${windowBytes}-byte window, so it was read in overlapping windows`,
          });
        }
      }
    }
  }

  /**
   * A DECLARED-PUBLIC VALUE CARRIES ITS REASON, AND THE REASON IS READ.
   *
   * The config's own note has always said an entry here needs a written reason.
   * **Nothing read it.** It was never parsed, never printed, and an entry
   * without one was accepted in silence - a property asserted in a comment and
   * enforced by nobody, which is how a decision becomes folklore and then a
   * value nobody can account for.
   *
   * So: a bare string is no longer an entry. An entry is an object with a
   * `value` and a `why`, the `why` is printed beside every hit it clears, and
   * an entry missing one is REFUSED rather than honoured - because an exemption
   * whose reason is absent is an exemption nobody can review.
   */
  const publicWhy = new Map();
  for (const entry of cfg.secrets.publicValues ?? []) {
    const value = typeof entry === 'string' ? entry : entry?.value;
    const why = typeof entry === 'string' ? '' : String(entry?.why ?? '').trim();
    if (!value) continue;
    if (!why) {
      throw new Error(
        'A VALUE IS DECLARED PUBLIC IN THE CONFIG WITH NO WRITTEN REASON. '
        + 'An exemption nobody can review is not an exemption, it is a hole. '
        + 'Add a "why" saying what the value IS and how that was established, '
        + 'or take the entry out and let the scan refuse.',
      );
    }
    publicWhy.set(value, why);
  }
  const publicSet = new Set(publicWhy.keys());
  const candidates = [...byValue.values()].map((c) => ({
    value: c.value,
    sources: c.sources,
    kinds: [...c.kinds].sort(),
    declaredPublic: publicSet.has(c.value),
    publicWhy: publicWhy.get(c.value) ?? null,
  }));
  // Longest first: a longer value containing a shorter one should be the one
  // named in a finding, and a shorter one is reported separately anyway.
  candidates.sort((a, b) => b.value.length - a.value.length || a.value.localeCompare(b.value));
  /**
   * A SYMBOLIC LINK IS NOT FOLLOWED, AND WHETHER THAT COSTS ANYTHING DEPENDS ON
   * WHERE IT POINTS. `.keys-backup/latest` points at a sibling directory that
   * this walk reads anyway, so nothing is missed; a link out of the tree, or at
   * something no root covers, is a directory nobody read. **The difference was
   * never computed, so every link read the same on the page - which meant the
   * one that matters would have read like the one that does not.**
   */
  const readRels = new Set(files.map((f) => f.rel));

  /**
   * BOTH SIDES OF THIS COMPARISON ARE RESOLVED, AND THE COST OF ONLY ONE OF
   * THEM BEING RESOLVED WAS A DOOR THAT REFUSED A CLEAN TREE.
   *
   * `realpathSync` resolves the LINK. Nothing resolved the ROOT, so on any
   * machine that reaches this repository through a symbolic link anywhere in
   * its path the two strings could not share a prefix and every accountable
   * link read as a blind spot. **Since a blind spot makes the verdict refuse,
   * that is the publication door refusing a tree with nothing wrong with it** -
   * which is the failure that teaches somebody to wave a refusal through.
   *
   * AND THE DEFECT IS PLATFORM-SHAPED, WHICH IS HOW IT PASSED EVERY TEST IN ONE
   * PLACE WHILE FAILING EVERY TIME IN ANOTHER. On macOS a temporary directory
   * is reached through a symbolic link and on Linux it is not, so a comparison
   * between a resolved path and an unresolved one holds on the second and fails
   * on the first. Nothing about that is intermittent: the same code is green on
   * one machine and red on another, always, and a result that reproduces
   * perfectly in both places is easy to read as a difference of opinion between
   * them rather than as a defect in the comparison.
   *
   * **SO, WHEN A PATH COMPARISON DISAGREES ACROSS TWO MACHINES, THE THING TO
   * CHECK IS WHETHER BOTH SIDES OF IT WENT THROUGH `realpathSync`** - and not
   * only here: any code that resolves one path and compares it against a path
   * it was handed has this shape.
   *
   * **BOTH RESOLUTIONS ARE IN ONE `try` AND SHARE ONE FAILURE PATH**, which is
   * the same sentence as the fix: either both sides are resolved or neither
   * side is used. A root that cannot be resolved accounts for nothing, so every
   * link becomes a blind spot and the run refuses - the safe direction, since
   * the unsafe one is a link waved through because a comparison could not be
   * made.
   *
   * THE PREFIX TEST IS WRITTEN TO A PATH BOUNDARY (`/a/repo-backup` starts with
   * `/a/repo` and is not inside it) AND THAT IS NOT SEPARATELY PINNED, said
   * here rather than left for somebody to assume otherwise: the relative path
   * that a lookalike sibling produces fails the `readRels` test below anyway,
   * so no assertion can tell the two spellings apart. It is written correctly
   * because it is one line, not because a test watches it.
   */
  const accountedLink = (linkRel) => {
    let root;
    let target;
    try {
      root = realpathSync(repoRoot);
      target = realpathSync(join(repoRoot, linkRel.split('/').join(sep)));
    } catch { return false; }
    const boundary = root.endsWith(sep) ? root : root + sep;
    if (target !== root && !target.startsWith(boundary)) return false;
    const rel = target.slice(root.length).replace(/^[\\/]+/, '').split(sep).join('/');
    if (!rel) return false;
    if (readRels.has(rel)) return true;
    for (const r of readRels) if (r.startsWith(`${rel}/`)) return true;
    return false;
  };
  for (const sk of skipped) {
    if (sk.kind === 'symlink' && accountedLink(sk.path)) {
      sk.accounted = true;
      sk.why = `${sk.why}, and its target is read under its own name`;
    }
  }
  return {
    candidates, filesRead: files.length, skipped, partial, tooLong,
    tooShort: tooShort.length,
  };
};

/* --------------------------------------------------------------- search --- */

/**
 * THE MOST PLACES ANY ONE THING IS LISTED AT. A cap nobody is told about is a
 * silent blind spot, so a list that hit it says so.
 */
const PLACE_CAP = 200;

const isHexOnly = (s) => /^[0-9a-fA-F]+$/.test(s);

/**
 * SEARCH EVERY GIVEN FILE FOR EVERY EXTRACTED VALUE, LITERALLY.
 *
 * `files` are repository-relative POSIX paths. A file that IS one of the
 * secret sources is never matched against a value it supplied — otherwise a
 * root that also ships (a `.env.example` showing placeholder shapes) refuses
 * itself for ever, which is how a door stops being run.
 *
 * A hex value is searched case-insensitively as well: the same seed printed by
 * one library in lower case and another in upper is the same seed.
 */
export const scanFiles = (repoRoot, files, candidates, rawCfg) => {
  const cfg = withDefaults(rawCfg);
  const marker = cfg.secrets.marker;
  const personPatterns = [...(cfg.person.patterns ?? [])];
  if (cfg.person.deriveHomeDirectory !== false) {
    const h = homedir();
    if (h && h !== '/' && h.length > 3) personPatterns.push(h);
  }
  /**
   * THE CASE RULE IS THE CONFIG'S, AND UNTIL 6 Sep THIS FILE IGNORED IT.
   *
   * `PUBLIC-REPO-CONFIG.json` has carried a `caseSensitive` field on a pattern
   * since it was written, and the commit-message guard has honoured it since it
   * was written. **This one compiled every pattern with `'g'` and nothing
   * else**, so the sweep read the file's declaration and did the opposite of
   * what it said, silently, and the number it printed was the number a sweep
   * gets sized from.
   *
   * **MEASURED OVER THE 347 SHIPPING FILES, BEFORE AND AFTER: 7,539 -> 9,007
   * occurrences, 290 -> 298 files.** The 1,468 it was blind to are not an even
   * spread: 1,250 of them belong to the one pattern that DECLARES itself
   * case-sensitive and therefore does not move. **What moves is the other ten
   * patterns, by 218, and every distinct token in that 218 was checked by hand
   * and is a real match** - capitals and sentence-initial capitals, which is
   * how this project writes. Zero false positives in the added set.
   *
   * **THE ENGINE IS FIXED HERE RATHER THAN THE PATTERNS RE-SPELLED IN CHARACTER
   * CLASSES**, which was the other route and is the one that has already failed
   * once: applied to a single pattern in a sibling configuration, written down
   * at length, and forgotten for the other fifteen. A spelling has to be
   * remembered by whoever adds the next pattern. This cannot be forgotten, it
   * makes every reader of that list agree, and it leaves the list readable by
   * the person who approves it.
   */
  const processPatterns = (cfg.process.patterns ?? []).map((p) => {
    if (typeof p === 'string') return { name: p, re: null, literal: p, fold: false };
    const fold = p.caseSensitive !== true;
    return {
      name: p.name ?? p.pattern,
      re: p.pattern ? new RegExp(p.pattern, fold ? 'gi' : 'g') : null,
      literal: p.literal ?? null,
      fold,
    };
  });

  const secretHits = [];
  const publicHits = [];
  const personHits = [];
  const processHits = [];
  /**
   * A FILE ON THE LIST WHOSE BYTES DID NOT ARRIVE. There is one such list here
   * and not two: a second, empty one used to sit beside it and be consumed
   * downstream, which reads as a case somebody handled. **Nothing wrote to it,
   * so it covered nothing.**
   */
  const unreadable = [];
  /**
   * A VALUE IS NEVER MATCHED AGAINST THE FILE IT WAS READ OUT OF — otherwise a
   * secret root that also ships refuses itself for ever, which is how a door
   * stops being run. **THAT EXEMPTION IS RECORDED HERE AND PRINTED**, because a
   * file that is both a source and a target is the one file this scanner cannot
   * clear, and a page that does not say so reads as a page that checked it.
   */
  const suppressed = new Map();

  /**
   * THE LONGEST NEEDLE DECIDES THE OVERLAP, SO NO OCCURRENCE IS EVER HALVED BY
   * A WINDOW EDGE. A file bigger than one window is read in windows that
   * overlap by more than the longest value being searched for, which means
   * every occurrence of every value lies wholly inside at least one window.
   * **That is why the size of a file can no longer decide whether it is
   * looked at.**
   */
  const maxNeedle = candidates.reduce((a, c) => Math.max(a, c.value.length), 0);
  const windowBytes = Math.max(1, cfg.secrets.maxFileBytes);
  const overlap = Math.min(windowBytes - 1, Math.max(maxNeedle - 1, 4096));

  for (const rel of files) {
    const abs = join(repoRoot, rel.split('/').join(sep));
    let st;
    try { st = lstatSync(abs); } catch { unreadable.push({ path: rel, kind: 'missing', why: 'missing' }); continue; }
    if (st.isSymbolicLink()) { unreadable.push({ path: rel, kind: 'symlink', why: 'a symbolic link, not followed' }); continue; }
    if (!st.isFile()) { unreadable.push({ path: rel, kind: 'not-regular', why: 'not a regular file' }); continue; }

    /**
     * A FILE THAT IS NOT TEXT IS STILL SEARCHED, AS BYTES.
     *
     * It used to be skipped, on the reasoning that a binary file is not prose.
     * **A value does not stop being present because the bytes around it are
     * not printable**, and a skipped file was decorating the page rather than
     * failing the run, so a shipping image with a seed in its metadata read as
     * clean. Line numbers over such a file mean "how many newline bytes came
     * first", which is still a place and is still followable.
     */
    const binary = looksBinary(abs);

    /** value -> absolute byte offsets kept, so two windows cannot count one occurrence twice. */
    const valueAt = new Map();
    const valueCut = new Set();
    const personAt = new Map();
    const personCut = new Set();
    const processAt = new Map();
    const processCut = new Set();
    let broke = false;

    try {
      readWindows(abs, st.size, windowBytes, overlap, (win, base) => {
        const t = win.toString('latin1');
        const tl = t.toLowerCase();

        /**
         * THE MARKER EXEMPTS A LINE, AND A LINE CUT BY A WINDOW EDGE CANNOT BE
         * READ WHOLE HERE. Such a line is treated as NOT exempt, which reports
         * an occurrence that might have been marked. **The error direction is
         * deliberate: a missed exemption is a refusal somebody reads, and a
         * missed refusal is a key in a public history.**
         */
        const exemptAt = (i) => {
          if (!marker) return false;
          let ls = i;
          while (ls > 0 && win[ls - 1] !== 10) ls--;
          let le = i;
          while (le < win.length && win[le] !== 10) le++;
          if (ls === 0 && base > 0) return false;
          if (le === win.length && base + win.length < st.size) return false;
          return win.subarray(ls, le).toString('utf8').includes(marker);
        };
        const put = (map, cut, key, i) => {
          if (exemptAt(i)) return;
          let set = map.get(key);
          if (!set) { set = new Set(); map.set(key, set); }
          if (set.size >= PLACE_CAP) { cut.add(key); return; }
          set.add(base + i);
        };
        const sweep = (hay, needle, key, map, cut) => {
          if (!needle) return;
          let from = 0;
          for (;;) {
            const i = hay.indexOf(needle, from);
            if (i < 0) break;
            put(map, cut, key, i);
            from = i + Math.max(1, needle.length);
          }
        };

        for (const c of candidates) {
          if (c.sources.some((s) => s.sourceFile === rel)) continue;
          sweep(t, c.value, c.value, valueAt, valueCut);
          // A hex value printed up by one library and down by another is one
          // value. BOTH passes run now: the old code ran the folded pass only
          // when the exact pass found nothing anywhere in the file, so an
          // upper-case occurrence beside a lower-case one was never counted.
          if (isHexOnly(c.value)) sweep(tl, c.value.toLowerCase(), c.value, valueAt, valueCut);
        }

        for (const p of personPatterns) sweep(t, p, p, personAt, personCut);

        for (const p of processPatterns) {
          if (p.literal) { sweep(p.fold === true ? tl : t, p.fold === true ? p.literal.toLowerCase() : p.literal, p.name, processAt, processCut); continue; }
          if (!p.re) continue;
          p.re.lastIndex = 0;
          let m;
          while ((m = p.re.exec(t)) !== null) {
            put(processAt, processCut, p.name, m.index);
            if (m.index === p.re.lastIndex) p.re.lastIndex++;
            if ((processAt.get(p.name)?.size ?? 0) >= PLACE_CAP) { processCut.add(p.name); break; }
          }
        }

      });
    } catch { unreadable.push({ path: rel, kind: 'unreadable', why: 'unreadable' }); broke = true; }
    if (broke) continue;

    for (const c of candidates) {
      if (c.sources.some((s) => s.sourceFile === rel)) {
        suppressed.set(rel, (suppressed.get(rel) ?? 0) + 1);
      }
    }

    /**
     * A BYTE OFFSET BECOMES A LINE NUMBER ONCE, AT THE END, FROM THE FILE.
     * Counting newlines to an offset needs the bytes before it, and a windowed
     * read has already passed them. Reading the file once more here costs one
     * pass over the files that actually carried something, which is nearly
     * always none of them.
     */
    const offsets = new Set();
    for (const s of valueAt.values()) for (const o of s) offsets.add(o);
    for (const s of personAt.values()) for (const o of s) offsets.add(o);
    for (const s of processAt.values()) for (const o of s) offsets.add(o);
    const lineOfOffset = new Map();
    if (offsets.size) {
      const sorted = [...offsets].sort((a, b) => a - b);
      let idx = 0;
      let line = 1;
      let seen = 0;
      readWindows(abs, st.size, windowBytes, 0, (win, base) => {
        for (let i = 0; i < win.length && idx < sorted.length; i++) {
          while (idx < sorted.length && sorted[idx] === base + i) { lineOfOffset.set(sorted[idx], line); idx++; }
          if (win[i] === 10) line++;
        }
        seen = base + win.length;
      });
      while (idx < sorted.length) { lineOfOffset.set(sorted[idx], line); idx++; }
      void seen;
    }
    const linesOf = (set) => [...set].sort((a, b) => a - b).map((o) => lineOfOffset.get(o) ?? 1);

    for (const c of candidates) {
      const set = valueAt.get(c.value);
      if (!set || set.size === 0) continue;
      const hit = {
        path: rel, lines: linesOf(set), truncated: valueCut.has(c.value),
        from: c.sources.map((s) => `${s.sourceFile} ${s.field}`), kinds: c.kinds,
        binary,
      };
      if (c.declaredPublic) publicHits.push({ ...hit, why: c.publicWhy });
      else secretHits.push(hit);
    }

    for (const p of personPatterns) {
      const set = personAt.get(p);
      if (!set || set.size === 0) continue;
      personHits.push({ path: rel, lines: linesOf(set), truncated: personCut.has(p), what: 'a home directory naming a person' });
    }

    for (const p of processPatterns) {
      const set = processAt.get(p.name);
      if (!set || set.size === 0) continue;
      processHits.push({ path: rel, lines: linesOf(set), truncated: processCut.has(p.name), what: p.name });
    }
  }

  return {
    secretHits, publicHits, personHits, processHits, unreadable,
    suppressed: [...suppressed.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)),
    filesScanned: files.length,
  };
};

/* ---------------------------------------------------------- blind spots --- */

/**
 * A FILE THIS COULD NOT READ IS NOT A FILE THAT PASSED.
 *
 * ── WHAT THIS FUNCTION IS FOR, AND WHAT IT COST TO NOT HAVE IT ──────────
 *
 * The size limit above used to carry the sentence *a file too big to read is a
 * NAMED blind spot, never a pass*, and the code did the opposite of its own
 * comment: an unread file was pushed onto a list, printed on the page under a
 * heading that said BLIND SPOT, and the run exited clean anyway. **A door that
 * prints the word REFUSED nowhere and exits 0 says clean, whatever its report
 * contains** - and this is the door standing between a key in a working folder
 * and a key in a public history, which is the one place a wrong answer cannot
 * be taken back.
 *
 * The other half was quieter and worse. The EXTRACTION side has its own list of
 * what it could not read, and nothing anywhere - not this file, not the caller
 * that builds the publication report - ever looked at it. **A secret that is
 * never extracted is never searched for, so every later stage reports clean
 * about a value it has never held.** That is a false clean at every site
 * downstream of it, from one file nobody could open.
 *
 * ── THE RULE, WHICH IS DELIBERATELY NOT A JUDGEMENT ─────────────────────
 *
 * Every not-read file is one of two things and the caller does not choose:
 *
 *   A BLIND SPOT - the file exists in the set being cleared and its content
 *   never reached this scanner. It REFUSES. There is no reading of it that is
 *   a pass, because nobody knows what is in it.
 *
 *   ACCOUNTED - the bytes were reached by another name. Today that is exactly
 *   one shape: a symbolic link whose target this walk reads under its real
 *   name. It is REPORTED and does not refuse, and the report says which.
 *
 * A file that was read but not by every route is neither: it is in `partial`,
 * it is reported, and it does not refuse - because the routes that did not
 * apply to it could not have applied to it.
 */
export const blindSpotsOf = (extraction, scan) => {
  const out = [];
  for (const s of extraction?.skipped ?? []) {
    if (s.accounted) continue;
    out.push({ where: 'the secret roots', path: s.path, why: s.why });
  }
  for (const t of extraction?.tooLong ?? []) {
    out.push({
      where: 'the secret roots',
      path: t.path,
      // THE REASON IS THE CEILING, NOT THE WINDOW. A run can be longer than
      // this scanner will promise to hold and still have been seen whole by one
      // window; saying no window saw it would be a false sentence on the page
      // whose subject is exactly what was and was not looked at.
      why: `carries a run of ${t.length} bytes, past the ${t.ceiling}-byte ceiling on a single value, so it is not searched for`,
    });
  }
  for (const u of scan?.unreadable ?? []) out.push({ where: 'the files being cleared', path: u.path, why: u.why });
  return out;
};

/* --------------------------------------------------------------- report --- */

/**
 * WHEN NAMING THE PLACE AND DISCLOSING THE VALUE ARE THE SAME ACT.
 *
 * ── WHAT THE FIRST REAL RUN FOUND, AND THE DESIGN HAD NOT ANTICIPATED ────
 *
 * A sealed pool is stored in a file whose NAME STEM IS BYTE-IDENTICAL TO THE
 * `commitment` INSIDE IT. LevelDB's `CURRENT` holds `MANIFEST-000005`, and the
 * file `MANIFEST-000005` is sitting in the same directory. **In both shapes the
 * path IS the value**, so a report that names the file contains the thing the
 * report exists to keep out — and the assertion at the bottom of this file
 * refused the whole page, correctly, three times.
 *
 * **THE FIX IS THE RENDERER, NOT THE SCAN.** Adding these to `publicValues`
 * would declare a real secret public because printing it was inconvenient,
 * which is the reasoning this whole file replaces; relaxing the assertion would
 * remove the only mechanical guarantee there is.
 *
 * ── SO: A POSITIONAL LABEL, AND THE PLACE IS STILL NAMED ─────────────────
 *
 * `.midnight/sealed/default/<sealed 1>.k0.json`. The directory survives whole,
 * the rest of the file name survives whole, and the part that is a value
 * becomes a NUMBER. **The number is keyed on the value**, so the same file is
 * always the same number, two paths carrying one value read as one thing, and
 * the count is printed.
 *
 * **NO PREFIX, EITHER — WHICH IS WHY THIS IS NOT TRUNCATION.** Four leading
 * characters of a 64-hex commitment is a filter that turns a guess into a
 * search. Nothing of the value is printed at all.
 *
 * ── THE NOUN COMES FROM THE TREE, NOT FROM A TABLE ──────────────────────
 *
 * The nearest enclosing directory that is not itself a value and is not a word
 * too generic to name anything. `.midnight/sealed/default/…` gives `sealed`.
 * **A table of this repository's directory meanings would be this repository's
 * name inside a file that must work in any folder**, so there is none.
 */
const GENERIC_SEGMENTS = /^(default|src|lib|data|files?|out|tmp|temp|current)$/i;

export const makeSafePath = (candidates) => {
  // Longest first, so a value containing a shorter one is replaced whole rather
  // than leaving the tail of the longer one on the page.
  const values = [...new Set(candidates.map((c) => c.value))]
    .filter((v) => typeof v === 'string' && v.length >= 8)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));

  const labelOf = new Map();   // value -> `<noun n>`
  const counters = new Map();  // noun -> next number
  const cache = new Map();     // path -> rendered path

  const nounFor = (segments, i) => {
    for (let k = i - 1; k >= 0; k--) {
      const seg = (segments[k] ?? '').replace(/^\.+/, '');
      if (!seg || seg === '.' || seg === '..') continue;
      if (GENERIC_SEGMENTS.test(seg)) continue;
      if (values.some((v) => segments[k].includes(v))) continue;
      return seg;
    }
    return 'name';
  };

  const labelFor = (value, noun) => {
    if (labelOf.has(value)) return labelOf.get(value);
    const n = (counters.get(noun) ?? 0) + 1;
    counters.set(noun, n);
    const label = `<${noun} ${n}>`;
    labelOf.set(value, label);
    return label;
  };

  const safe = (p) => {
    if (!p || values.length === 0) return p;
    const key = String(p);
    if (cache.has(key)) return cache.get(key);
    const segments = key.split('/');
    const out = segments.map((segment, i) => {
      let seg = segment;
      // A segment can carry more than one value. Bounded, because a replacement
      // that produced another match would otherwise loop.
      for (let guard = 0; guard < 8; guard++) {
        const hit = values.find((v) => seg.includes(v));
        if (!hit) break;
        seg = seg.split(hit).join(labelFor(hit, nounFor(segments, i)));
      }
      return seg;
    });
    const rendered = out.join('/');
    cache.set(key, rendered);
    return rendered;
  };

  /** How many distinct values have been withheld from paths so far. */
  safe.withheld = () => labelOf.size;
  /** True once anything has been withheld, so the legend is printed only when it is needed. */
  safe.used = () => labelOf.size > 0;
  return safe;
};

const listPlaces = (hit, safe) => {
  const shown = hit.lines.slice(0, 5).join(', ');
  const more = hit.lines.length > 5 ? ` … and ${hit.lines.length - 5} more` : '';
  const capped = hit.truncated ? `  [MORE THAN ${PLACE_CAP} OCCURRENCES — THIS LIST IS CUT SHORT]` : '';
  return `${safe(hit.path)}:${shown}${more}${capped}`;
};

const occurrences = (hits) => hits.reduce((a, h) => a + h.lines.length, 0);

/** The same words on every page that withholds anything, and the count with them. */
export const withheldLegend = (safe) => (safe.used() ? [
  'A NAME IN ANGLE BRACKETS IS A PATH SEGMENT THAT IS ITSELF ONE OF THE',
  'EXTRACTED VALUES — a sealed pool stored under its own commitment, a',
  'manifest named after its own pointer. **Naming the place and disclosing',
  'the value are the same act for those files**, so the segment is a number',
  'instead. The same number always means the same value, and no part of it',
  'is printed — not a prefix, which is a filter that turns a guess into a',
  'search.',
  `  ${safe.withheld()} value(s) withheld from paths on this page.`,
  '',
] : []);

/**
 * THE REPORT NAMES PLACES. IT NEVER NAMES A VALUE, A PREFIX OF ONE, OR ANY
 * DIGEST THAT COULD BE COMPARED AGAINST A CANDIDATE.
 */
/**
 * `injectedSafe` LETS A LARGER PAGE HAND IN ITS OWN RENDERER, so one number
 * means one value across the WHOLE page and the count at the bottom is true of
 * all of it. A caller that injects one owns the legend too — printing it here
 * as well would state a total that is only true of this section.
 */
export const renderReport = (extraction, scan, rawCfg, injectedSafe) => {
  const cfg = withDefaults(rawCfg);
  const safe = injectedSafe ?? makeSafePath(extraction.candidates);
  const L = [];
  const secretFiles = new Set(scan.secretHits.map((h) => h.path));
  const personFiles = new Set(scan.personHits.map((h) => h.path));

  L.push('EXTRACTION — read first, so that nothing is recognised by its shape');
  L.push(`  secret roots            ${(cfg.secrets.roots ?? []).join('  ')}`);
  L.push(`  files read              ${extraction.filesRead}`);
  L.push(`  candidate values        ${extraction.candidates.length}`);
  const bySource = new Map();
  for (const c of extraction.candidates) {
    for (const s of c.sources) bySource.set(s.sourceFile, (bySource.get(s.sourceFile) ?? 0) + 1);
  }
  for (const [f, n] of [...bySource.entries()].sort()) L.push(`      ${String(n).padStart(5)}  ${safe(f)}`);
  if (extraction.tooShort) {
    L.push(`  values below the ${cfg.secrets.minLength}-character floor, not searched for: ${extraction.tooShort}`);
  }
  if (extraction.partial?.length) {
    L.push('  READ, BUT NOT BY EVERY ROUTE. Reported, and not a refusal, because');
    L.push('  the routes that did not apply could not have applied:');
    const byWhy = new Map();
    for (const q of extraction.partial) {
      if (!byWhy.has(q.why)) byWhy.set(q.why, []);
      byWhy.get(q.why).push(q.path);
    }
    // THE FILES ARE NAMED AND NOT ONLY COUNTED. A reader asking whether one
    // particular store was read whole cannot answer it from a number. The list
    // is capped because proving parameters would otherwise fill the page every
    // run and teach a reader to skim the block that has to be read.
    const NAME_CAP = 12;
    for (const [why, paths] of [...byWhy.entries()].sort((a, b) => b[1].length - a[1].length)) {
      L.push(`      ${String(paths.length).padStart(5)}  file(s)  ${why}`);
      for (const q of paths.slice(0, NAME_CAP)) L.push(`               ${safe(q)}`);
      if (paths.length > NAME_CAP) L.push(`               ... and ${paths.length - NAME_CAP} more`);
    }
  }
  const accounted = (extraction.skipped ?? []).filter((q) => q.accounted);
  if (accounted.length) {
    L.push('  REACHED BY ANOTHER NAME. Not read here, and not a blind spot:');
    for (const q of accounted) L.push(`      ${safe(q.path)}  -  ${q.why}`);
  }
  L.push('');

  L.push('SECRETS — a value read out of the secret roots, found in a file that would ship');
  if (scan.secretHits.length === 0) {
    L.push(`  none, across ${scan.filesScanned} files`);
  } else {
    L.push(`  REFUSED — ${occurrences(scan.secretHits)} occurrence(s) of ${scan.secretHits.length} value(s) in ${secretFiles.size} file(s)`);
    for (const h of scan.secretHits) {
      L.push(`      ${listPlaces(h, safe)}`);
      L.push(`          a value read out of: ${h.from.map(safe).join('; ')}`);
    }
  }
  if (scan.publicHits.length) {
    L.push(`  declared public in the config, so not a refusal — ${occurrences(scan.publicHits)} occurrence(s):`);
    for (const h of scan.publicHits) {
      L.push(`      ${listPlaces(h, safe)}  (from ${h.from.map(safe).join('; ')})`);
      // THE REASON IS ON THE PAGE BESIDE THE THING IT CLEARS. A reader deciding
      // whether to believe an exemption cannot open the config: it does not
      // ship, and on this page the exemption would otherwise be a bare claim.
      for (const line of String(h.why ?? '(no reason recorded)').split('\n')) L.push(`          ${line}`);
    }
  }
  if (scan.suppressed?.length) {
    L.push('  SUPPRESSED — a file that is BOTH a secret root and a file being cleared.');
    L.push('  Its own values are not searched for inside it, so this scanner cannot');
    L.push('  clear it. Nothing below is a refusal and nothing below has been checked:');
    for (const s of scan.suppressed) L.push(`      ${safe(s.path)}  —  ${s.count} of its own value(s) not searched for`);
  }
  L.push('');

  L.push('A PERSON — a home directory names one, and a file may not name a person');
  if (scan.personHits.length === 0) L.push('  none');
  else {
    L.push(`  REFUSED — ${occurrences(scan.personHits)} occurrence(s) in ${personFiles.size} file(s)`);
    for (const h of scan.personHits) L.push(`      ${listPlaces(h, safe)}  —  ${h.what}`);
  }
  L.push('');

  L.push('THE PROCESS — REPORTED, NEVER REFUSED. The sweep that removes these is its own round.');
  if (scan.processHits.length === 0) L.push('  none');
  else {
    const byWhat = new Map();
    for (const h of scan.processHits) byWhat.set(h.what, (byWhat.get(h.what) ?? 0) + h.lines.length);
    const files = new Set(scan.processHits.map((h) => h.path));
    const cut = scan.processHits.some((h) => h.truncated);
    L.push(`  ${occurrences(scan.processHits)} occurrence(s) in ${files.size} file(s)${cut ? ` — AND AT LEAST ONE FILE HAS MORE THAN ${PLACE_CAP}, SO THIS IS A FLOOR` : ''}:`);
    for (const [what, n] of [...byWhat.entries()].sort((a, b) => b[1] - a[1])) {
      L.push(`      ${String(n).padStart(5)}  ${what}`);
    }
    L.push('  the files, so the sweep has a list:');
    for (const f of [...files].sort()) L.push(`      ${safe(f)}`);
  }
  L.push('');

  /**
   * THE BLIND SPOTS, AND THE WORD REFUSED IS ON THE PAGE BESIDE THEM.
   *
   * This block used to read NOT SCANNED and the run exited clean underneath it.
   * A heading that says a thing was not checked, over an exit code that says it
   * was, teaches a reader to believe the exit code.
   */
  const blind = blindSpotsOf(extraction, scan);
  if (blind.length) {
    L.push('NOT READ AT ALL - and a file this could not read is not a file that passed');
    L.push(`  REFUSED - ${blind.length} file(s), and nobody knows what is in them:`);
    for (const b of blind) L.push(`      ${safe(b.path)}  -  ${b.why}   [${b.where}]`);
    L.push('');
  } else {
    L.push('NOT READ AT ALL');
    L.push('  none. Every file in both sets was read, whatever its size and');
    L.push('  whether or not it was text.');
    L.push('');
  }

  if (!injectedSafe && safe.used()) {
    for (const line of withheldLegend(safe)) L.push(line);
  }

  L.push('WHAT THIS DOES NOT LOOK FOR — named, because a blind spot nobody wrote');
  L.push('down is the difference between a door and a comfort:');
  L.push('  a value re-encoded on the way in (base64 of hex, hex of bytes, JSON or');
  L.push('  percent escaping); a value split across two lines by a log formatter;');
  L.push('  a value with separators inserted; and — for anything that is not pure');
  L.push('  hex — a change of case. The search is LITERAL, on purpose: a scanner');
  L.push('  that transforms is guessing again.');
  L.push('  AND A VALUE printed short. A file that carries the first and last');
  L.push('  few characters of a value, as an illustration in a comment, holds no');
  L.push('  run this searches for - the search is for whole values, and the');
  L.push('  extraction floor is a length. **A truncated value goes past this**,');
  L.push('  and whether that matters is a judgement about the value, which is');
  L.push('  why it is named here rather than guessed at.');
  L.push('  AND ONE MORE, NAMED SINCE 7 Sep BECAUSE IT IS THE RESIDUE LEFT AFTER');
  L.push('  BINARY FILES STOPPED BEING SKIPPED: key material that exists ONLY as');
  L.push('  raw bytes inside a file that is not text is not extracted, because');
  L.push('  hex and base64 runs are what can be read out of such a file. What IS');
  L.push('  now extracted from one, and was not before, is every ASCII run in it.');
  L.push('');

  return L.join('\n');
};

/**
 * THE MECHANICAL HALF OF *THE REPORT MAY NOT CONTAIN THE THING IT IS ABOUT*.
 *
 * Every extracted value is looked for in the rendered text. A report carrying
 * one is REFUSED rather than written — which turns *did somebody remember* into
 * a measurement. It also catches the subtler case: a value that happens to be a
 * substring of a path or a field name this report prints.
 */
export const assertReportCarriesNoValue = (report, candidates) => {
  const lower = report.toLowerCase();
  // THE REFUSAL NAMES THE SOURCE FILES, AND A SOURCE FILE'S NAME CAN BE THE
  // VALUE. The first real refusal printed five paths to the screen, three of
  // which WERE the values — so the message that reports a disclosure was the
  // same disclosure. It goes through the same renderer as the report.
  const safe = makeSafePath(candidates);
  const leaked = [];
  for (const c of candidates) {
    const v = c.value;
    if (v.length < 8) continue;
    if (lower.includes(v.toLowerCase())) leaked.push(c.sources.map((s) => safe(s.sourceFile)).join(', '));
  }
  if (leaked.length) {
    throw new Error(
      'THIS SCANNER WAS ABOUT TO WRITE A REPORT CONTAINING A SECRET. Nothing was written. '
      + `The value(s) came from: ${[...new Set(leaked)].join('; ')}. `
      + 'A scanner whose report leaks the secret is the defect it was built to stop.',
    );
  }
};

/** Everything a caller needs, in one call. `ok === false` means REFUSE. */
export const runSecretScan = (repoRoot, files, rawCfg) => {
  const cfg = withDefaults(rawCfg);
  const extraction = extractCandidates(repoRoot, cfg);
  const scan = scanFiles(repoRoot, files, extraction.candidates, cfg);
  const report = renderReport(extraction, scan, cfg);
  assertReportCarriesNoValue(report, extraction.candidates);
  const blindSpots = blindSpotsOf(extraction, scan);
  return {
    /**
     * A BLIND SPOT REFUSES. Nothing was found in it because nothing was read
     * from it, and those are not the same answer.
     */
    ok: scan.secretHits.length === 0 && scan.personHits.length === 0 && blindSpots.length === 0,
    blindSpots,
    secretPlaces: scan.secretHits.length,
    secretOccurrences: occurrences(scan.secretHits),
    personPlaces: scan.personHits.length,
    personOccurrences: occurrences(scan.personHits),
    processPlaces: occurrences(scan.processHits),
    candidates: extraction.candidates.length,
    extraction, scan, report,
  };
};

/* -------------------------------------------------------------------- cli --- */
/*
 * node scripts/secret-scan.mjs --config <path> --files-from <path>
 * node scripts/secret-scan.mjs --config <path> --files a b c
 * node scripts/secret-scan.mjs --config <path> --files-from <path> --report <path>
 *
 * Exit 0 = nothing found. Exit 1 = a refusal, and every line of it names a
 * PLACE. Exit 2 = this scanner could not run, which is not the same answer and
 * must never be read as one.
 */
const isMain = (() => {
  try { return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const repoRoot = valueOf('--root') ?? process.cwd();
  const configPath = valueOf('--config');
  const reportPath = valueOf('--report');

  const fail = (msg) => { console.log(`  SECRET SCAN COULD NOT RUN: ${msg}`); process.exit(2); };
  if (!configPath) fail('no --config was given, and a scanner with no secret roots passes everything');

  let files = [];
  const from = valueOf('--files-from');
  if (from) {
    if (!existsSync(from)) fail(`--files-from names ${from}, which does not exist`);
    files = readFileSync(from, 'utf8').split('\n')
      .map((l) => l.split('#')[0].trim()).filter(Boolean).map((l) => l.replace(/^\.\//, ''));
  } else {
    const i = argv.indexOf('--files');
    if (i < 0) fail('neither --files-from nor --files was given');
    // STOP AT THE NEXT FLAG. Filtering flags out instead swallows the VALUE of
    // a later flag — `--files a --report out.txt` would scan `out.txt`.
    files = [];
    for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) files.push(argv[k]);
  }
  if (files.length === 0) fail('the file list is empty, and an empty list is not a clean tree');

  let cfg;
  try { cfg = loadConfig(configPath); } catch (e) { fail(String(e?.message ?? e)); }

  let result;
  try { result = runSecretScan(repoRoot, files, cfg); }
  catch (e) {
    const msg = String(e?.message ?? e);
    console.log(`  ${msg}`);
    // THE REFUSAL IS WRITTEN WHERE A PASS WOULD HAVE BEEN WRITTEN. A door whose
    // output on the one path that matters exists only on a screen has not been
    // handed over. The message has already been through the path renderer, so
    // writing it discloses nothing the screen did not.
    if (reportPath) {
      try {
        const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs');
        const { dirname: dn } = await import('node:path');
        mk(dn(reportPath), { recursive: true });
        wf(reportPath, [
          'SECRET SCAN',
          `  taken at  ${new Date().toISOString()}`,
          '',
          '  THIS COULD NOT RUN, WHICH IS NOT THE SAME ANSWER AS CLEAN.',
          '  NOTHING WAS CHECKED.',
          '',
          `      ${msg}`,
          '',
        ].join('\n'));
        console.log(`  report: ${reportPath}`);
      } catch { console.log('  AND THE REFUSAL COULD NOT BE WRITTEN DOWN EITHER.'); }
    }
    // A REPORT THAT WOULD HAVE CARRIED A SECRET IS A REFUSAL, NOT A BREAKDOWN.
    // Exit 1 means "this must not proceed"; exit 2 means "nothing was checked",
    // and reading the first as the second is how a leak becomes a retry.
    process.exit(/CONTAINING A SECRET/.test(msg) ? 1 : 2);
  }

  console.log(result.report);
  if (reportPath) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, result.report);
    console.log(`  report: ${reportPath}`);
  }
  process.exit(result.ok ? 0 : 1);
}

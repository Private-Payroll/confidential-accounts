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
import { readFileSync, readdirSync, lstatSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
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
    /** Read no further than this. A file too big to read is a NAMED blind spot, never a pass. */
    maxFileBytes: 2 * 1024 * 1024,
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
 * `lstat`, NOT `stat`, AND THAT IS NOT A DETAIL. `.keys-backup/latest` is a
 * symlink into its own parent; following links means reading everything twice
 * today and looping for ever the day one points at an ancestor. A link is
 * NAMED and not followed, so what was skipped is on the page.
 */
const walkFiles = (root, absRoot, out, skipped) => {
  let st;
  try { st = lstatSync(absRoot); } catch { skipped.push({ path: root, why: 'absent' }); return; }
  if (st.isSymbolicLink()) { skipped.push({ path: root, why: 'a symbolic link, not followed' }); return; }
  if (st.isFile()) { out.push({ rel: root, abs: absRoot, size: st.size }); return; }
  if (!st.isDirectory()) { skipped.push({ path: root, why: 'not a regular file' }); return; }
  let names;
  try { names = readdirSync(absRoot).sort(); } catch { skipped.push({ path: root, why: 'unreadable' }); return; }
  for (const n of names) {
    const childRel = `${root}/${n}`;
    const childAbs = join(absRoot, n);
    let cst;
    try { cst = lstatSync(childAbs); } catch { continue; }
    if (cst.isSymbolicLink()) { skipped.push({ path: childRel, why: 'a symbolic link, not followed' }); continue; }
    if (cst.isDirectory()) walkFiles(childRel, childAbs, out, skipped);
    else if (cst.isFile()) out.push({ rel: childRel, abs: childAbs, size: cst.size });
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
  const { roots, fieldHints, minLength, maxFileBytes } = cfg.secrets;
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
      if (hit.length === 0) skipped.push({ path: r, why: 'matched nothing' });
      for (const n of hit) walkFiles(n, join(repoRoot, n), files, skipped);
    } else {
      walkFiles(r, join(repoRoot, r), files, skipped);
    }
  }

  const byValue = new Map();
  const tooShort = [];
  const add = (value, sourceFile, field, kind) => {
    if (typeof value !== 'string') return;
    const v = value.trim();
    if (v.length < minLength) { tooShort.push({ sourceFile, field }); return; }
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

  for (const f of files) {
    if (looksBinary(f.abs)) { skipped.push({ path: f.rel, why: 'binary' }); continue; }
    if (f.size > maxFileBytes) { skipped.push({ path: f.rel, why: `text, and larger than ${maxFileBytes} bytes` }); continue; }
    let buf;
    try { buf = readFileSync(f.abs); } catch { skipped.push({ path: f.rel, why: 'unreadable' }); continue; }
    if (isBinary(buf)) { skipped.push({ path: f.rel, why: 'binary' }); continue; }
    const text = buf.toString('utf8');

    // 1. the whole file, when it is one token and nothing else
    const whole = text.trim();
    if (whole.length >= minLength && !/\s/.test(whole)) add(whole, f.rel, '(whole file)', 'whole-file');

    // 2. named fields
    const name = basename(f.rel);

    // 0. THE FILENAME ITSELF. A sealed pool is stored under a name that IS its
    //    identifier, so a route that only reads contents never sees it — and
    //    the report prints file names, which is where it would then surface.
    //    `renderReport` elides a basename that is itself a candidate.
    if (name.length >= minLength && (HEX_WHOLE.test(name) || HEX_WHOLE.test(name.replace(/\.[^.]*$/, '')))) {
      add(name.replace(/\.[^.]*$/, ''), f.rel, '(the file name)', 'filename');
    }
    if (name.endsWith('.json')) {
      try {
        for (const leaf of jsonLeaves(JSON.parse(text), '', [])) {
          if (hinted(leaf.key)) add(leaf.value, f.rel, leaf.key, 'named-field');
        }
      } catch { /* not JSON after all; routes 3 and 4 still apply */ }
    }

    // 4. dotenv assignments. BOTH FORMS OF EVERY VALUE GO IN, because guessing
    //    which one is the secret is the guessing this scanner exists to stop:
    //    the raw right-hand side, and the value with quotes and a trailing
    //    comment removed. A candidate that matches nothing costs nothing; a
    //    secret that was mis-parsed into a candidate nobody will ever find is
    //    a scanner reporting clean.
    if (name === '.env' || name.startsWith('.env.') || name === '.envrc') {
      for (const line of text.split('\n')) {
        if (/^\s*#/.test(line)) continue;
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const raw = m[2].trim();
        if (raw) add(raw, f.rel, m[1], 'named-field');
        const quoted = /^(['"])([\s\S]*)\1$/.exec(raw);
        if (quoted) { if (quoted[2]) add(quoted[2], f.rel, m[1], 'named-field'); continue; }
        const uncommented = raw.replace(/\s+#.*$/, '').trim();
        if (uncommented && uncommented !== raw) add(uncommented, f.rel, m[1], 'named-field');
      }
    }

    // 3. hex and base64 runs, wherever they are
    for (const re of [HEX, B64]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) add(m[0], f.rel, '(value in text)', re === HEX ? 'hex' : 'base64');
    }
  }

  const publicSet = new Set((cfg.secrets.publicValues ?? []).map((p) => (typeof p === 'string' ? p : p.value)));
  const candidates = [...byValue.values()].map((c) => ({
    value: c.value,
    sources: c.sources,
    kinds: [...c.kinds].sort(),
    declaredPublic: publicSet.has(c.value),
  }));
  // Longest first: a longer value containing a shorter one should be the one
  // named in a finding, and a shorter one is reported separately anyway.
  candidates.sort((a, b) => b.value.length - a.value.length || a.value.localeCompare(b.value));
  return { candidates, filesRead: files.length, skipped, tooShort: tooShort.length };
};

/* --------------------------------------------------------------- search --- */

const lineOf = (text, index) => {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

const PLACE_CAP = 200;

/** Line numbers, and whether the list is complete. A cap nobody is told about is a silent blind spot. */
const placesOf = (text, needle, caseInsensitive) => {
  const hay = caseInsensitive ? text.toLowerCase() : text;
  const nee = caseInsensitive ? needle.toLowerCase() : needle;
  const lines = [];
  let truncated = false;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(nee, from);
    if (i < 0) break;
    lines.push(lineOf(text, i));
    from = i + Math.max(1, nee.length);
    if (lines.length >= PLACE_CAP) { truncated = hay.indexOf(nee, from) >= 0; break; }
  }
  return { lines, truncated };
};

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
  const processPatterns = (cfg.process.patterns ?? []).map((p) =>
    typeof p === 'string' ? { name: p, re: null, literal: p } : { name: p.name ?? p.pattern, re: p.pattern ? new RegExp(p.pattern, 'g') : null, literal: p.literal ?? null });

  const secretHits = [];
  const publicHits = [];
  const personHits = [];
  const processHits = [];
  const unreadable = [];
  const skipped = [];
  /**
   * A VALUE IS NEVER MATCHED AGAINST THE FILE IT WAS READ OUT OF — otherwise a
   * secret root that also ships refuses itself for ever, which is how a door
   * stops being run. **THAT EXEMPTION IS RECORDED HERE AND PRINTED**, because a
   * file that is both a source and a target is the one file this scanner cannot
   * clear, and a page that does not say so reads as a page that checked it.
   */
  const suppressed = new Map();

  for (const rel of files) {
    const abs = join(repoRoot, rel.split('/').join(sep));
    let st;
    try { st = lstatSync(abs); } catch { unreadable.push({ path: rel, why: 'missing' }); continue; }
    if (st.isSymbolicLink()) { unreadable.push({ path: rel, why: 'a symbolic link, not followed' }); continue; }
    if (!st.isFile()) { unreadable.push({ path: rel, why: 'not a regular file' }); continue; }
    if (looksBinary(abs)) { skipped.push({ path: rel, why: 'binary' }); continue; }
    if (st.size > cfg.secrets.maxFileBytes) { skipped.push({ path: rel, why: `text, and larger than ${cfg.secrets.maxFileBytes} bytes` }); continue; }
    let buf;
    try { buf = readFileSync(abs); } catch { unreadable.push({ path: rel, why: 'unreadable' }); continue; }
    if (isBinary(buf)) { skipped.push({ path: rel, why: 'binary' }); continue; }
    const text = buf.toString('utf8');
    const textLines = text.split('\n');
    const exempt = (line) => marker && (textLines[line - 1] ?? '').includes(marker);

    for (const c of candidates) {
      if (c.sources.some((s) => s.sourceFile === rel)) {
        suppressed.set(rel, (suppressed.get(rel) ?? 0) + 1);
        continue;
      }
      let found = placesOf(text, c.value, false);
      if (found.lines.length === 0 && isHexOnly(c.value)) found = placesOf(text, c.value, true);
      const kept = found.lines.filter((l) => !exempt(l));
      if (kept.length === 0) continue;
      const hit = {
        path: rel, lines: kept, truncated: found.truncated,
        from: c.sources.map((s) => `${s.sourceFile} ${s.field}`), kinds: c.kinds,
      };
      (c.declaredPublic ? publicHits : secretHits).push(hit);
    }

    for (const p of personPatterns) {
      const found = placesOf(text, p, false);
      const kept = found.lines.filter((l) => !exempt(l));
      if (kept.length) personHits.push({ path: rel, lines: kept, truncated: found.truncated, what: 'a home directory naming a person' });
    }

    for (const p of processPatterns) {
      let lines = [];
      let truncated = false;
      if (p.literal) { const f2 = placesOf(text, p.literal, false); lines = f2.lines; truncated = f2.truncated; }
      else if (p.re) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(text)) !== null) {
          lines.push(lineOf(text, m.index));
          if (m.index === p.re.lastIndex) p.re.lastIndex++;
          if (lines.length >= PLACE_CAP) { truncated = true; break; }
        }
      }
      const kept = lines.filter((l) => !exempt(l));
      if (kept.length) processHits.push({ path: rel, lines: kept, truncated, what: p.name });
    }
  }

  return {
    secretHits, publicHits, personHits, processHits, unreadable, skipped,
    suppressed: [...suppressed.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)),
    filesScanned: files.length,
  };
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
  if (extraction.skipped.length) {
    L.push('  NOT READ — a named blind spot, not a pass:');
    for (const s of extraction.skipped) L.push(`      ${safe(s.path)}  —  ${s.why}`);
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
    for (const h of scan.publicHits) L.push(`      ${listPlaces(h, safe)}  (from ${h.from.map(safe).join('; ')})`);
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

  if (scan.skipped.length || scan.unreadable.length) {
    L.push('NOT SCANNED — a named blind spot, not a pass:');
    for (const s of [...scan.unreadable, ...scan.skipped]) L.push(`      ${safe(s.path)}  —  ${s.why}`);
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
  return {
    ok: scan.secretHits.length === 0 && scan.personHits.length === 0,
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

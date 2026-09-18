/**
 * FINDING EVERY ASSERTION THAT DOES NOT RUN EVERYWHERE, AND SAYING SO WHEN IT
 * CANNOT.
 *
 * A test that stands down when something is not on disk is behaving correctly -
 * a check that invented its own input would be checking its invention - but the
 * cost is invisible from outside: the run goes green, quieter than it was, and
 * nothing says which assertions were not among the ones that passed.
 *
 * The rules live here, as functions, for one reason: two versions of this
 * matcher have now been wrong, and neither could be driven because both were
 * private to the test that used them. A rule nothing can drive is a rule
 * nothing has measured.
 *
 * -- WHY THERE ARE TWO DETECTORS AND NOT ONE --------------------------------
 *
 * A reader can write a stand-down at least five ways, and one of them chooses
 * the runner as a VALUE - `(HAVE_DB ? describe : describe.skip)` - sometimes
 * binding it to a name and calling it a hundred lines later. A matcher that
 * reads one shape reports nothing about the others, its emptiness check is
 * satisfied by the shapes it does read, and the gap is then quiet at both ends.
 * That has happened twice.
 *
 * So `standDowns` reads the shapes it knows, and `mentionsStandingDown` asks
 * the cruder question: does this file's live code mention standing down at all?
 * The two are compared, and a file that mentions it while the finder reports
 * nothing - or reports something it could not finish reading - is a REFUSAL
 * rather than a silence. A detector that cannot see something must say which
 * something it could not see; that is the whole difference between a gap and a
 * report.
 *
 * -- AND WHY THE SENSE CAN BE UNKNOWN --------------------------------------
 *
 * `skipIf` over a negated condition and `runIf` over a plain one both mean
 * *this runs only where the thing IS*. Deciding that by asking whether the
 * condition starts with `!` is a spelling match, and `!!X`, `(!X)` and
 * `X === undefined` all defeat it - in both directions. So anything the rules
 * below cannot reduce to a single plain negation is reported as `unknown`, and
 * an unknown sense is a refusal rather than a guess.
 */

/** What a stand-down is: an assertion or a group that does not run everywhere. */
export type Sense = 'present' | 'absent' | 'unknown';

export type StandDown = {
  /** `skipIf`, `runIf`, or `chosen` when the runner itself was picked. */
  readonly kind: 'skipIf' | 'runIf' | 'chosen';
  /** The condition as written, comments removed. */
  readonly condition: string;
  /** The title, or '' when the reader could not reach one. */
  readonly title: string;
  /** Whether it runs only where the thing IS, only where it is NOT, or unclear. */
  readonly sense: Sense;
};

export type Reading = {
  readonly found: readonly StandDown[];
  /**
   * False when the reader's own lexer did not finish where it should have - a
   * quotation it opened and never closed. Everything it says about that file
   * after the disagreement is worth nothing, so a caller refuses rather than
   * believing a shorter list.
   */
  readonly ended: boolean;
  /**
   * How many times the reader found a stand-down and could NOT finish reading
   * it. Never dropped silently: a file with any of these has to be named.
   */
  readonly unreadable: number;
};

/**
 * THE SAME SOURCE WITH ITS COMMENTS BLANKED, LINE STRUCTURE KEPT.
 *
 * A check that a statement is PRESENT by looking for its text is satisfied by
 * that statement commented out. Strings and template literals are left alone,
 * because a comment marker inside one is not a comment; a regex literal is
 * recognised well enough that a slash inside one does not start a comment.
 *
 * It removes comments wherever they START, not only where a line starts with
 * one: `let x = 1; // survived += 1;` and `let y = 2; /*` both hid a
 * commented-out statement from the previous version of this rule.
 */
export function codeOnly(source: string): string {
  return scan(source).code;
}
/**
 * ONE SCANNER, TWO ANSWERS: the source with its comments gone, and where its
 * string literals are in that result.
 *
 * They come from the same pass for a measured reason. They were two passes, and
 * the second did not know what the first did about regex literals - an
 * apostrophe inside a pattern desynchronised it, every span after that point
 * was wrong, and a whole file's stand-downs became invisible because the reader
 * believed they were inside a string. Two readers of the same syntax disagreeing
 * is a defect waiting for an input; one reader cannot disagree with itself.
 */
/**
 * Whether what has been read so far ends in a word that can be followed by a
 * pattern rather than by a division.
 *
 * `return /don't/.test(s)` is a pattern holding an apostrophe, and reading it
 * as a division opened a string that swallowed the rest of the file. Measured:
 * a real stand-down after such a line became invisible to BOTH readers below.
 */
const KEYWORDS_BEFORE_A_PATTERN = [
  'return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'throw', 'void',
  'yield', 'await', 'delete', 'do', 'else',
];
const afterKeyword = (soFar: string): boolean => {
  const word = /([A-Za-z$_][\w$]*)\s*$/.exec(soFar);
  return word !== null && KEYWORDS_BEFORE_A_PATTERN.includes(word[1]);
};

function scan(source: string): { code: string; strings: [number, number][]; ended: boolean } {
  let out = '';
  const strings: [number, number][] = [];
  let i = 0;
  const n = source.length;
  let prevMeaningful = '';
  let unterminated = false;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += i < n ? '  ' : '';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const from = out.length;
      out += c;
      i += 1;
      let closed = false;
      while (i < n) {
        if (source[i] === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
        if (source[i] === c) { out += c; i += 1; closed = true; break; }
        if (c === '`' && source[i] === '$' && source[i + 1] === '{') {
          let depth = 1;
          out += '${';
          i += 2;
          while (i < n && depth > 0) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') depth -= 1;
            out += source[i];
            i += 1;
          }
          continue;
        }
        out += source[i];
        i += 1;
      }
      if (!closed) unterminated = true;
      strings.push([from, out.length]);
      prevMeaningful = c;
      continue;
    }
    /*
     * A REGEX LITERAL, RECOGNISED BY WHAT CAN PRECEDE ONE. A slash after a
     * value is division; after an operator, a comma, an opening bracket or the
     * start of an expression it opens a pattern - and a pattern may hold
     * slashes that must not start a comment and quotes that are not quotes.
     */
    if (c === '/' && ('=(,:[!&|?{};+-*%~^<>'.includes(prevMeaningful) || afterKeyword(out))) {
      out += c;
      i += 1;
      let inClass = false;
      while (i < n) {
        if (source[i] === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) { out += '/'; i += 1; break; }
        else if (source[i] === '\n') break;
        out += source[i];
        i += 1;
      }
      prevMeaningful = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevMeaningful = c;
    i += 1;
  }
  /*
   * WHETHER THE READER FINISHED WHERE IT SHOULD HAVE. A quotation this lexer
   * opened and never closed means it disagreed with the real syntax somewhere
   * above, and everything it said after that point is worth nothing. Saying so
   * is the difference between a reader that is unable and one that is wrong.
   */
  return { code: out, strings, ended: !unterminated };
}

/**
 * Whether a position in the source lies inside a string literal.
 *
 * A file that WRITES ABOUT stand-downs holds their spelling in its own string
 * literals - the guard beside this module drives these rules over a dozen of
 * them - and a reader that matched inside a string reported that file as
 * holding a dozen unnamed stand-downs it does not have. A quotation is not a
 * statement.
 *
 * IT ASKS ABOUT ONE POSITION BECAUSE EVERY SEARCH BELOW IS ANCHORED ON A SHORT,
 * RARE PART - `describe.skipIf(`, or one runner beside another - which is
 * entirely inside a quotation or entirely outside one. An earlier version
 * anchored on the condition, which may contain almost anything and could begin
 * outside a quotation and run into it; that version needed to ask about the
 * whole match, and the anchoring is what removed the need.
 */
const quoted = (spans: readonly [number, number][], from: number): boolean =>
  spans.some(([start, end]) => from > start && from < end);

/** The three names the runner offers, and the modifiers that may sit between. */
const RUNNER = String.raw`(?:describe|it|test)`;
const MODIFIERS = String.raw`(?:\.(?:concurrent|sequential|each\s*\([^)]*\)|for\s*\([^)]*\)|extend\s*\([^)]*\)))*`;

/** Walks from just after an opening parenthesis to its match, or -1. */
const closeOf = (source: string, open: number): number => {
  let depth = 1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
};

/**
 * The first string literal at `from`, skipping whitespace and one closing
 * parenthesis - the one that ends a parenthesised choice of runner.
 */
const titleAt = (source: string, from: number): string | null => {
  const m = source.slice(from).match(/^\s*\)?\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1/);
  return m ? m[2] : null;
};

/**
 * WHICH WAY A CONDITION POINTS, OR THAT IT CANNOT BE TOLD.
 *
 * Only a condition that reduces to a single plain negation of one expression is
 * answered. Double negation, a comparison, a nested negation inside brackets -
 * anything that needs reading rather than matching - is `unknown`, which the
 * guard above treats as a refusal. Being unsure out loud is the point.
 */
export function senseOf(kind: StandDown['kind'], condition: string): Sense {
  let c = codeOnly(condition).trim();
  while (c.startsWith('(') && closeOf(c, 1) === c.length - 1) c = c.slice(1, -1).trim();
  const bangs = /^!+/.exec(c);
  const depth = bangs ? bangs[0].length : 0;
  const rest = c.slice(depth).trim();
  /* A condition that keeps negating, compares, or combines cannot be reduced. */
  if (depth > 1) return 'unknown';
  if (/===|!==|==|!=|<=|>=|<|>|&&|\|\||\?|\?\?/.test(rest)) return 'unknown';
  if (rest.startsWith('!')) return 'unknown';
  const negated = depth === 1;
  if (kind === 'chosen') return negated ? 'unknown' : 'present';
  return kind === 'skipIf'
    ? (negated ? 'present' : 'absent')
    : (negated ? 'absent' : 'present');
}

/**
 * EVERY STAND-DOWN THIS READER CAN FIND, AND A COUNT OF THE ONES IT COULD NOT
 * FINISH READING.
 *
 * Three shapes, because all three are in use:
 *   `describe.skipIf(C)('title', ...)`         - the condition names the case
 *   `(C ? describe : describe.skip)('title')`  - the runner is chosen
 *   `const g = C ? describe : describe.skip;`  - and called later by its name
 */
export function standDowns(source: string): Reading {
  const { code: live, strings: spans, ended } = scan(source);
  const found: StandDown[] = [];
  let unreadable = 0;

  const direct = new RegExp(`\\b${RUNNER}${MODIFIERS}\\.(skipIf|runIf)\\s*\\(`, 'g');
  for (let m = direct.exec(live); m !== null; m = direct.exec(live)) {
    if (quoted(spans, m.index)) continue;
    const open = m.index + m[0].length;
    const close = closeOf(live, open);
    if (close === -1) { unreadable += 1; continue; }
    const condition = live.slice(open, close).trim();
    const title = titleAt(live, close + 1);
    if (title === null) { unreadable += 1; continue; }
    const kind = m[1] as 'skipIf' | 'runIf';
    found.push({ kind, condition, title, sense: senseOf(kind, condition) });
  }

  /*
   * THE RUNNER CHOSEN AS A VALUE. `describe.skip` is the runner that never
   * runs, so a conditional expression selecting it is a stand-down however it
   * is spelled - and one bound to a name is called somewhere else entirely,
   * which is why the name is followed rather than only the expression.
   *
   * THE SEARCH IS ANCHORED ON THE RARE PART AND THEN READS BACKWARDS, which is
   * a correction rather than a style: anchoring on the condition meant trying
   * two hundred lazy expansions at every position of every file, and over a
   * hundred files of this size that does not finish.
   */
  const pair = new RegExp(
    `(${RUNNER}(?:\\.skip)?)\\s*:\\s*(${RUNNER}(?:\\.skip)?)`, 'g');
  for (let m = pair.exec(live); m !== null; m = pair.exec(live)) {
    if (quoted(spans, m.index)) continue;
    const [whole, whenTrue, whenFalse] = m;
    const skips = [whenTrue, whenFalse].filter((r) => r.endsWith('.skip')).length;
    if (skips !== 1) continue;
    /* Backwards to the `?`, then to where the condition starts. */
    const before = live.slice(Math.max(0, m.index - 220), m.index);
    const q = before.lastIndexOf('?');
    if (q === -1) continue;
    const head = before.slice(0, q);
    const stop = Math.max(head.lastIndexOf(';'), head.lastIndexOf('\n'), head.lastIndexOf('='));
    const condition = head.slice(stop + 1).trim().replace(/^\(/, '').trim();
    if (condition === '') { unreadable += 1; continue; }
    const runsWhenTrue = !whenTrue.endsWith('.skip');
    const sense = senseOf('chosen', runsWhenTrue ? condition : `!(${condition})`);
    /* Bound to a name? Then every call of that name is one of these. */
    const binding = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;=\n]*$/.exec(head);
    if (binding === null) {
      const title = titleAt(live, m.index + whole.length);
      if (title === null) { unreadable += 1; continue; }
      found.push({ kind: 'chosen', condition, title, sense });
      continue;
    }
    const calls = new RegExp(String.raw`\b${binding[1]}\s*\(\s*(['"` + '`' + String.raw`])((?:\\.|[^\\])*?)\1`, 'g');
    let seen = 0;
    for (let c = calls.exec(live); c !== null; c = calls.exec(live)) {
      if (quoted(spans, c.index)) continue;
      seen += 1;
      found.push({ kind: 'chosen', condition, title: c[2], sense });
    }
    if (seen === 0) unreadable += 1;
  }

  return { found, unreadable, ended };
}

/**
 * THE SAME QUESTION ASKED OF LIVE CODE, EXACTLY, SO THE TWO NUMBERS CAN BE
 * COMPARED.
 *
 * Every place the runner is told to stand down, in code the comments have been
 * taken out of and outside string literals. A file where this is larger than
 * the number the reader above resolved is a file holding a stand-down in a
 * shape the reader does not know, and the caller refuses rather than reporting
 * the smaller number. PRESENCE IS NOT A COUNT: a bare `it.skip` beside a
 * properly named stand-down satisfied a check that only asked whether the
 * reader had found ANYTHING.
 */
export function lexedMentions(source: string): number {
  const { code: live, strings: spans } = scan(source);
  const marks = new RegExp(`\\b${RUNNER}${MODIFIERS}\\.(?:skipIf|runIf|skip|only)\\b`, 'g');
  return [...live.matchAll(marks)]
    .filter((m) => !quoted(spans, m.index ?? 0)).length;
}

/**
 * AND THE CRUDEST QUESTION OF ALL, ASKED OF THE UNTOUCHED BYTES.
 *
 * No lexer, no comment stripping, no notion of a string: just the shapes that
 * mean an assertion may not run, counted wherever they appear. IT OVER-REPORTS
 * ON PURPOSE, AND THAT IS THE WHOLE VALUE OF IT.
 *
 * **WHY IT CANNOT BE THE LEXED ONE.** The reader above and the count beside it
 * share a lexer, and a lexer can be wrong. It was: a pattern holding an
 * apostrophe after `return` opened a quotation that ran to the end of the file,
 * and a real `describe.skipIf` below it became invisible to BOTH of them at
 * once - measured, with a control. Two questions sharing a lexer are one
 * question. **So the question that decides whether a file must account for
 * itself reads the bytes and can be fooled only into asking for MORE.** The
 * cost of over-reporting is a line in a list; the cost of under-reporting is an
 * assertion nobody knows stopped running.
 */
export function mentionsStandingDown(source: string): number {
  const RUN = '(?:describe|it|test)';
  const shapes = [
    new RegExp(`\\b${RUN}\\s*\\.\\s*(?:skipIf|runIf|skip|only)\\b`, 'g'),
    /\.(?:skipIf|runIf)\s*\(/g,
    /* A conditional choice of runner, with a runner in either arm. The other
     * arm may be anything - a no-op function is how one of these was written,
     * and a shape that only recognised `.skip` in the other arm missed it. */
    new RegExp(`\\?[^?:;\\n]{0,120}:\\s*${RUN}\\b`, 'g'),
    new RegExp(`\\?\\s*${RUN}(?:\\.skip)?[^?:;\\n]{0,120}:`, 'g'),
  ];
  return shapes.reduce((n, shape) => n + [...source.matchAll(shape)].length, 0);
}

/**
 * HOW MANY ASSERTIONS SIT UNDER A STAND-DOWN, so a number stated about it can
 * be checked rather than believed.
 *
 * A group that stands down takes every assertion inside it with it, and the
 * useful number to a reader is the assertions rather than the groups. Counted
 * inside the group's own body, found by matching its braces.
 */
export function assertionsUnder(source: string, title: string): number {
  const { code: live } = scan(source);
  const at = live.indexOf(title);
  if (at === -1) return 0;
  const open = live.indexOf('{', at);
  if (open === -1) return 0;
  let depth = 0;
  let close = -1;
  for (let i = open; i < live.length; i += 1) {
    if (live[i] === '{') depth += 1;
    else if (live[i] === '}') { depth -= 1; if (depth === 0) { close = i; break; } }
  }
  if (close === -1) return 0;
  const body = live.slice(open, close);
  const spans = scan(body).strings;
  const calls = /\b(?:it|test)(?:\.(?:concurrent|sequential|skipIf\s*\([^)]*\)|runIf\s*\([^)]*\)|each\s*\([^)]*\)))*\s*\(/g;
  return [...body.matchAll(calls)].filter((m) => !quoted(spans, m.index ?? 0)).length;
}

// Rules for comments in shipped code: short, with no dates or work ids, and a reason after every disable.

const MONTH =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
// What a comment may not carry: when it was written, which piece of work or finding it came from, or who decided it.
const NOT_IN_A_COMMENT = [
  [
    'a date',
    new RegExp(`\\b\\d{1,2}\\s+${MONTH}\\b|\\b${MONTH}\\.?\\s+\\d{1,2}\\b|\\b20[0-3]\\d\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`)
  ],
  ['a time', /\b(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:am|pm)\b|\bIST\b/],
  ['a work or finding id', /\b(?:IMIG|MIG|MG|SC|PI|S|R|X|T|C|M|D|F)(?:-\d{1,4}[0-9a-z]{0,3}|\d{1,4}[a-z]?)\b/],
  ['a ruling', /\bthe\s+founder\b|\bruled\b|\brulings?\b/i]
];
const DIRECTIVE = /^\s*(?:eslint[-\s]|@ts-|@vitest-|global\s|prettier-ignore)/;
const TAG_LINE = /^@(?:param|returns?|throws)\b/;
const isLicence = (comment, sourceCode) =>
  sourceCode.getAllComments()[0] === comment && /licen[cs]e|copyright|SPDX/i.test(comment.value);
// The text lines of a comment, its markers and blank lines left out.
const textLines = (comment) =>
  comment.value
    .split('\n')
    .map((l) => l.replace(/^\s*\*?\s?/, '').trim())
    .filter((l) => l && l !== '*');

export default {
  rules: {
    'at-most-two-lines': {
      meta: {
        type: 'suggestion',
        messages: {
          long: "A comment block of {{n}} lines; keep it to two (a public export's @param, @returns and @throws lines aside)."
        }
      },
      create(context) {
        const sourceCode = context.sourceCode;
        return {
          Program() {
            const blocks = [];
            for (const c of sourceCode.getAllComments()) {
              if (c.type === 'Shebang' || DIRECTIVE.test(c.value) || isLicence(c, sourceCode)) continue;
              const last = blocks.at(-1);
              const joins = c.type === 'Line' && last?.type === 'Line' && c.loc.start.line === last.end + 1;
              let lines = textLines(c);
              if (c.type === 'Block' && c.value.startsWith('*') && sourceCode.getTokenAfter(c)?.value === 'export') {
                lines = lines.filter((l) => !TAG_LINE.test(l));
              }
              if (joins) Object.assign(last, { end: c.loc.end.line, n: last.n + lines.length });
              else blocks.push({ type: c.type, loc: c.loc, end: c.loc.end.line, n: lines.length });
            }
            for (const b of blocks) if (b.n > 2) context.report({ loc: b.loc, messageId: 'long', data: { n: b.n } });
          }
        };
      }
    },
    'disable-needs-reason': {
      meta: {
        type: 'suggestion',
        messages: { bare: 'A disable comment with no reason; say why after "--".' }
      },
      create(context) {
        const sourceCode = context.sourceCode;
        return {
          Program() {
            for (const c of sourceCode.getAllComments()) {
              if (/^\s*eslint-disable/.test(c.value) && !/\s--\s+\S/.test(c.value))
                context.report({ loc: c.loc, messageId: 'bare' });
            }
          }
        };
      }
    },
    'no-dates-or-ids': {
      meta: {
        type: 'suggestion',
        messages: {
          carries: 'A comment carrying {{what}}; say what the code does and why, not when or for which piece of work.'
        }
      },
      create(context) {
        const sourceCode = context.sourceCode;
        return {
          Program() {
            for (const c of sourceCode.getAllComments()) {
              if (c.type === 'Shebang' || isLicence(c, sourceCode)) continue;
              for (const [what, re] of NOT_IN_A_COMMENT)
                if (re.test(c.value)) context.report({ loc: c.loc, messageId: 'carries', data: { what } });
            }
          }
        };
      }
    }
  }
};

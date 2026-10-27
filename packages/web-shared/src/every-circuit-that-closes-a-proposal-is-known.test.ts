import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PROPOSAL_CLOSING_CIRCUITS } from './governed-call-builder.js';

/* The history reader binds a seat to an invitation only when the block that closed its proposal holds no other call
 * that closes a proposal (`seatsInvitedIn`). The steps it reads carry no call's arguments, so it knows such a call
 * only by its circuit's name. Every circuit of the account that reaches `closeProposal` must be named, or a block
 * where one of them closed this proposal beside another's seating binds that seating's leaf to this invitation. */

/** The source with every line and block comment blanked, so a circuit or a call named only in a comment is not read as code. */
const withoutComments = (text: string): string => {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      out += c;
      if (c === '\\' && i + 1 < text.length) { out += text[++i]!; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += ' '.repeat(stop - i); i = stop - 1; continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/gu, ' '); i = stop - 1; continue;
    }
    out += c;
  }
  return out;
};

/** The exported circuits that reach `closeProposal`, by name, read from the source's code and not its comments. */
const exportedClosersOf = (compact: string): string[] => {
  const source = withoutComments(compact);
  const defs = [...source.matchAll(/(export\s+)?circuit\s+(\w+)\s*[(<]/gu)].map((m) => ({ at: m.index!, name: m[2]!, exported: m[1] !== undefined }));
  const bodies = new Map(defs.map((d, i) => [d.name, { exported: d.exported, body: source.slice(d.at, defs[i + 1]?.at ?? source.length) }]));
  const closers = new Set(['closeProposal']);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, { body }] of bodies) {
      if (!closers.has(name) && [...closers].some((c) => new RegExp(`\\b${c}\\s*\\(`, 'u').test(body))) { closers.add(name); grew = true; }
    }
  }
  return [...closers].filter((c) => bodies.get(c)?.exported).sort();
};

describe('every circuit of the account that closes a proposal is one the history reader knows', () => {
  it('RED WHEN: a circuit of the account that closes a proposal is missing from what the history reader treats as one', () => {
    const source = readFileSync(new URL('../../../contracts/src/ConfidentialAccount.compact', import.meta.url), 'utf8');
    const exported = exportedClosersOf(source);
    expect(exported).toContain('cancel');
    expect([...PROPOSAL_CLOSING_CIRCUITS].sort()).toEqual(exported);
  });

  it('a circuit or a call named only in a comment is not counted as one that closes a proposal', () => {
    /* RED WHEN: a circuit or a call that appears only in a comment is counted as one that closes a proposal. */
    const exported = exportedClosersOf([
      'circuit closeProposal(id: Bytes<32>): [] { remove(id); }',
      'export circuit real(id: Bytes<32>): [] { closeProposal(id); }',
      'export circuit quiet(id: Bytes<32>): [] { /* closeProposal(id); */ // closeProposal(id);',
      '}',
      '// export circuit ghost(id: Bytes<32>): [] { closeProposal(id); }',
      '/* export circuit hidden(id: Bytes<32>): [] { closeProposal(id); } */',
    ].join('\n'));
    expect(exported).toEqual(['real']);
  });
});

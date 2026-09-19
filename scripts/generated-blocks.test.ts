/**
 * THE BLOCK FORMAT IS THE THING THAT MAKES THREE BANDS POSSIBLE, so what it
 * must never do is eat the other two.
 *
 * The design set puts GENERATED, RULED and NARRATIVE in every design
 * document and only the first is machine-written. If a regeneration can drift
 * one byte past its marker, the reasoning a person wrote is gone and nothing
 * says so. So the tests below are mostly about what is left ALONE.
 */
import { describe, expect, it } from 'vitest';

import { digest, parseBlocks, renderBlock, replaceBlock } from './generated-blocks.js';

const header = { id: 'x', door: 'the generator' };
const doc = (body: string) => `# Title\n\nBEFORE\n\n${renderBlock(header, body)}\n\nAFTER\n`;

describe('a block round-trips, and its digest answers exactly one question', () => {
  it('records its id, its door and a digest of its own body', () => {
    const [b] = parseBlocks(doc('rows\n'));
    expect(b.id).toBe('x');
    expect(b.door).toBe('the generator');
    expect(b.body).toBe(digest(b.text));
  });

  it('the body digest changes when the body does — the hand-edit question', () => {
    const [a] = parseBlocks(doc('one\n'));
    const [c] = parseBlocks(doc('two\n'));
    expect(a.body).not.toBe(c.body);
  });

  it('CARRIES NO INPUT DIGEST, because a list of inputs is a proxy. T-167.', () => {
    // Three versions of the gate hashed a list of files each block was believed
    // to be generated from, and the list was wrong three times in one round.
    // Staleness is now answered by rendering and comparing, so there is nothing
    // stored here that can go out of date with what the render depends on.
    expect(doc('rows\n')).not.toContain('inputs="');
  });
});

describe('IT LEAVES EVERY BYTE OUTSIDE THE MARKERS ALONE', () => {
  it('replaces only the block, keeping prose above and below', () => {
    const before = doc('old rows\n');
    const after = replaceBlock(before, header, 'new rows\n');
    expect(after).toContain('BEFORE');
    expect(after).toContain('AFTER');
    expect(after).toContain('new rows');
    expect(after).not.toContain('old rows');
    expect(after.split('BEFORE')).toHaveLength(2);
  });

  it('replaces the RIGHT block when a document has two', () => {
    const two = `${renderBlock({ ...header, id: 'one' }, 'first\n')}\n\nmiddle\n\n${renderBlock({ ...header, id: 'two' }, 'second\n')}\n`;
    const after = replaceBlock(two, { ...header, id: 'two' }, 'changed\n');
    expect(after).toContain('first');
    expect(after).toContain('middle');
    expect(after).toContain('changed');
    expect(after).not.toContain('second');
  });
});

describe('IT REFUSES RATHER THAN INVENTING', () => {
  it('will not create a region in a document that has none', () => {
    // A generator that could invent a region could invent it in the wrong
    // place, and a person would find their prose below a table that ate it.
    expect(() => replaceBlock('# Just prose\n', header, 'rows\n')).toThrow(/no block id="x"/);
  });

  it('treats a half-delimited block as an error, not as nothing to check', () => {
    // This is the state a truncated write leaves behind. Skipping it means the
    // gate reports nothing wrong about a file that has been cut in half.
    const cut = doc('rows\n').replace(/<!-- GENERATED:END[^>]*-->/, '');
    expect(() => parseBlocks(cut)).toThrow(/opens and never closes/);
  });

  it('treats an unpaired END as an error too', () => {
    expect(() => parseBlocks('<!-- GENERATED:END id="x" body="0" -->\n')).toThrow(/must pair/);
  });
});

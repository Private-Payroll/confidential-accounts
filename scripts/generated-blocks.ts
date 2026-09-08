/**
 * A REGION OF A MARKDOWN FILE THAT A PERSON MAY NOT EDIT AND A REGENERATION MAY
 * NOT EAT.
 *
 * The design set asks for three bands in every design document:
 * GENERATED, RULED and NARRATIVE. Only the first is machine-written, and the
 * whole value of the arrangement is that regenerating it cannot touch the other
 * two. That needs a delimiter, and this repository had none — 176 markdown
 * files carry exactly one HTML comment between them and it is prose. So the
 * shape is invented here, once, and every generated region in the repository
 * uses it.
 *
 * ONE DIGEST HERE, AND IT ANSWERS ONE QUESTION: HAS A PERSON TYPED INSIDE THE
 * BLOCK? `body` is a digest of the block's own text, recorded when it was
 * written. When it stops matching, somebody edited a generated region — and no
 * door fixes that, because a regeneration would silently delete whatever they
 * wrote, so it is named and the person decides.
 *
 * THE OTHER QUESTION — IS THE BLOCK STALE — IS NOT ANSWERED BY A DIGEST STORED
 * HERE. It used to be, by hashing a list of files the block was believed to be
 * generated from, and `T-167` is the record of that list being wrong three
 * times in one round. `scripts/doc-freshness.ts` now RENDERS the block and
 * compares, which is the question itself rather than a proxy for it.
 *
 * WHY NOT MTIMES, WHICH IS WHAT `scripts/artifact-freshness.ts` USES.
 * `scripts/source-hash.mjs` already argues this out for the commit guard and
 * the argument transfers: every `mutate-*.mjs` writes a file, runs a suite and
 * writes the ORIGINAL BYTES back, so an eighty-eight-mutation run leaves
 * eighty-eight new mtimes and no new content. A doc gate on mtimes would refuse
 * after every mutation run and pass a file that was edited and reverted. A
 * content digest is immune to both. `artifact-freshness.ts` compares two files
 * neither of which it can hash a subset of, which is why it is still right to
 * use a clock and this is not.
 *
 * THE DIGEST IS NOT A SECURITY DEVICE and this file does not pretend otherwise.
 * Anybody may recompute it. It exists to catch the accident — an edit inside a
 * block, a contract change nobody regenerated — which is the failure this
 * project actually keeps having, not the forgery it does not.
 */
import { createHash } from 'node:crypto';

export const BEGIN = '<!-- GENERATED:BEGIN';
export const END = '<!-- GENERATED:END';

export type BlockHeader = {
  readonly id: string;
  readonly door: string;
};

export type Block = {
  readonly id: string;
  readonly door: string;
  /** The digest of the body, as recorded when the block was written. */
  readonly body: string;
  /** The body as it is on disk now. */
  readonly text: string;
  /** Offsets of the whole block including both delimiters. */
  readonly from: number;
  readonly to: number;
  readonly line: number;
};

export const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

const attrs = (line: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/([a-z]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};

/**
 * Every generated block in one markdown file.
 *
 * A BEGIN with no END, or an END with no BEGIN, THROWS rather than being
 * skipped. A half-delimited block is the state a truncated write leaves behind,
 * and skipping it means the gate reports nothing wrong about a file that has
 * been cut in half.
 */
export function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  for (;;) {
    const b = text.indexOf(BEGIN, i);
    if (b === -1) break;
    const bEnd = text.indexOf('-->', b);
    if (bEnd === -1) throw new Error('generated-blocks: a BEGIN delimiter is not closed with `-->`.');
    const head = attrs(text.slice(b, bEnd));
    const e = text.indexOf(END, bEnd);
    if (e === -1) {
      throw new Error(
        `generated-blocks: block "${head.id ?? '?'}" opens and never closes. ` +
          'A half-delimited block is what a truncated write leaves behind, so this is an error rather than a block to skip.',
      );
    }
    const eEnd = text.indexOf('-->', e);
    if (eEnd === -1) throw new Error('generated-blocks: an END delimiter is not closed with `-->`.');
    const tail = attrs(text.slice(e, eEnd));
    const body = text.slice(bEnd + 3, e);
    out.push({
      id: head.id ?? '',
      door: head.door ?? '',
      body: tail.body ?? '',
      text: body,
      from: b,
      to: eEnd + 3,
      line: text.slice(0, b).split('\n').length,
    });
    i = eEnd + 3;
  }
  const opens = text.split(BEGIN).length - 1;
  const closes = text.split(END).length - 1;
  if (opens !== closes) {
    throw new Error(`generated-blocks: ${opens} BEGIN delimiters and ${closes} END delimiters. They must pair.`);
  }
  return out;
}

/** The delimited text for a block, ready to be written into a document. */
export function renderBlock(header: BlockHeader, body: string): string {
  const inner = body.endsWith('\n') ? body : body + '\n';
  const wrapped = '\n' + inner;
  return (
    `${BEGIN} id="${header.id}" door="${header.door}" -->` +
    wrapped +
    `${END} id="${header.id}" body="${digest(wrapped)}" -->`
  );
}

/**
 * Replace one block's text in a document, leaving every byte outside it alone.
 * Creating a block is not this function's job: a generator that could invent a
 * region in a hand-written document could also invent it in the wrong place.
 */
export function replaceBlock(text: string, header: BlockHeader, body: string): string {
  const blocks = parseBlocks(text);
  const found = blocks.find((b) => b.id === header.id);
  if (!found) {
    throw new Error(
      `generated-blocks: no block id="${header.id}" in this document. ` +
        'A generator does not create regions in a document it did not write; add the delimiters by hand, once, where the block belongs.',
    );
  }
  return text.slice(0, found.from) + renderBlock(header, body) + text.slice(found.to);
}

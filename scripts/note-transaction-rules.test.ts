/**
 * The rules behind recording which transaction created a note.
 *
 * Each assertion names the change to the rules that turns it red, because an
 * assertion nobody has watched fail is not evidence that it can.
 */
import { describe, it, expect } from 'vitest';
import {
  transactionFromText, notesWithNoTransaction, theNoteNamed, assertReplacingIsMeant,
  NotUsable, type PooledNote,
} from './note-transaction-rules.js';

/* The real values of the one shielded note this project has ever created, as
 * the chain served them. They are here so the shapes under test are the shapes
 * that actually occur, rather than ones convenient to write. */
const HASH = '6519fd029e9d51bba5929465844ef71d0faed4de7894283cc8b02f43f205d524';
const IDENTIFIER = '00e3e5577d1e6e107a99781c5149ba84295d961ecc591191a33be22c9cdf6d8d68';

const note = (nonce: string, createdIn?: string): PooledNote => ({
  nonce, token: 'ab'.repeat(32), value: 10_000n, ...(createdIn === undefined ? {} : { createdIn }),
});

describe('what a person may name as the transaction that created a note', () => {
  it('takes the 33-byte identifier a deposit reports, as an identifier', () => {
    /* RED WHEN: transactionFromText stops accepting length 66, or returns it
     * under `hash`. That is the repair being impossible for anybody who only
     * has what the deposit printed. */
    expect(transactionFromText(IDENTIFIER)).toEqual({ identifier: IDENTIFIER });
  });

  it('takes the 32-byte hash the pool records, as a hash', () => {
    /* RED WHEN: length 64 stops being routed to `hash`. */
    expect(transactionFromText(HASH)).toEqual({ hash: HASH });
  });

  it('is not fooled by spacing or an 0x prefix or capitals', () => {
    /* RED WHEN: `bare` stops trimming, lowercasing or stripping 0x — each of
     * which makes a correct value from a wallet screen refused. */
    expect(transactionFromText(`  0x${HASH.toUpperCase()}  `)).toEqual({ hash: HASH });
  });

  it('refuses a value of any other length, and says how long it was', () => {
    /* RED WHEN: a length other than 64 or 66 is allowed through — a shortened
     * value would then be sent to the chain as though it named a transaction. */
    const short = HASH.slice(0, 40);
    expect(() => transactionFromText(short)).toThrow(NotUsable);
    expect(() => transactionFromText(short)).toThrow(/20 bytes/);
    expect(() => transactionFromText(HASH + 'abcd')).toThrow(/34 bytes/);
  });

  it('refuses something that is not hexadecimal at all, and says so', () => {
    /* RED WHEN: the hex test is dropped; a pasted sentence would then be
     * measured by length and could pass as an identifier at 66 characters. */
    expect(() => transactionFromText('the one from the deposit, i think about tuesday tea')).toThrow(NotUsable);
    expect(() => transactionFromText('z'.repeat(64))).toThrow(/hexadecimal/);
  });

  it('refuses nothing at all rather than defaulting', () => {
    /* RED WHEN: an empty answer gains a default. */
    expect(() => transactionFromText('   ')).toThrow(/no transaction was named/);
  });
});

describe('which notes cannot be spent', () => {
  it('is exactly the notes with no recorded transaction, in the pool\'s order', () => {
    /* RED WHEN: the filter is inverted, or reordered. A wrong list here sends
     * somebody to repair a note that is already spendable and leaves the
     * unspendable one alone. */
    const pool = [note('aa11'), note('bb22', HASH), note('cc33'), note('dd44', HASH)];
    expect(notesWithNoTransaction(pool).map((n) => n.nonce)).toEqual(['aa11', 'cc33']);
  });

  it('is empty when every note records one', () => {
    /* RED WHEN: the filter answers on something other than createdIn. */
    expect(notesWithNoTransaction([note('aa11', HASH), note('bb22', HASH)])).toEqual([]);
  });
});

describe('which note a person named', () => {
  const pool = [note('abcd1234' + '00'.repeat(28)), note('abce9999' + '11'.repeat(28)), note('ffff0000' + '22'.repeat(28))];

  it('takes the first few characters of a nonce when they pick out one note', () => {
    /* RED WHEN: prefix matching becomes exact matching — nobody types 64
     * characters correctly, so the repair becomes unusable. */
    expect(theNoteNamed(pool, 'ffff').nonce).toBe(pool[2].nonce);
  });

  it('REFUSES a prefix that matches two notes rather than taking the first', () => {
    /* RED WHEN: the ambiguous case resolves by order instead of refusing. That
     * is the wrong note being repaired, silently, and the wrong note here is
     * the wrong money. */
    expect(() => theNoteNamed(pool, 'abc')).toThrow(NotUsable);
    expect(() => theNoteNamed(pool, 'abc')).toThrow(/2 of this vault's notes/);
  });

  it('names what the pool does hold when nothing matches', () => {
    /* RED WHEN: the refusal stops listing the nonces — a person who mistyped
     * then has nothing to correct against. */
    expect(() => theNoteNamed(pool, 'dead')).toThrow(/abcd12340000, abce99991111, ffff00002222/);
  });

  it('says the pool is empty when it is, rather than listing nothing', () => {
    /* RED WHEN: the empty-pool branch is dropped and the message ends in a
     * colon with no list, which reads as a display fault. */
    expect(() => theNoteNamed([], 'abcd')).toThrow(/holds no notes at all/);
  });
});

describe('replacing a transaction a note already records', () => {
  it('is refused unless it is meant', () => {
    /* RED WHEN: the guard stops looking at createdIn. A note that can already
     * be spent would then be made unspendable by a mistyped repair. */
    expect(() => assertReplacingIsMeant(note('aa11', HASH), false)).toThrow(NotUsable);
    expect(() => assertReplacingIsMeant(note('aa11', HASH), false)).toThrow(/can already be spent/);
    /* RED WHEN: the refusal stops naming REPLACE_RECORDED=yes. A refusal that
     * names no way through it is the shape this whole door exists to end: the
     * payment refusal that sent people to a function no operator could call. */
    expect(() => assertReplacingIsMeant(note('aa11', HASH), false)).toThrow(/REPLACE_RECORDED=yes/);
  });

  it('is allowed when it is meant', () => {
    /* RED WHEN: the `replacing` argument stops being honoured, and a wrongly
     * recorded transaction can never be corrected. */
    expect(() => assertReplacingIsMeant(note('aa11', HASH), true)).not.toThrow();
  });

  it('never stands in the way of a note that records nothing', () => {
    /* RED WHEN: the guard fires on an unrecorded note — the repair this door
     * exists for would refuse itself. */
    expect(() => assertReplacingIsMeant(note('aa11'), false)).not.toThrow();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ContractMaintenanceAuthority, ContractState } from '@midnightntwrk/ledger-v9';
import { authorityIn, type ContractAuthority } from './contract-authority.js';

/*
 * Who holds a contract, read off the state the chain holds. The reader is
 * structural, so a plain object and the runtime's own state read the same way.
 */
const KEY_A = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const KEY_B = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const stateWith = (authority: unknown) => ({ data: {}, maintenanceAuthority: authority });
const held = (over: Record<string, unknown> = {}) => stateWith({
  committee: [{ tag: 'schnorr', value: KEY_A }, { tag: 'schnorr', value: KEY_B }], threshold: 2, counter: 0n, ...over,
});
const refusal = (read: unknown): string => {
  expect(read).toHaveProperty('why');
  return (read as { why: string }).why;
};

describe('reading who holds a contract', () => {
  it('reads the committee, the threshold and the counter of a held contract', () => {
    const read = authorityIn(held({ counter: 3n })) as ContractAuthority;
    /* RED WHEN: the committee, the threshold or the counter is dropped or changed on the way out. */
    expect(read).toEqual({ committee: [{ tag: 'schnorr', value: KEY_A }, { tag: 'schnorr', value: KEY_B }], threshold: 2, counter: 3n });
  });

  it('returns a result nobody can change afterwards', () => {
    const read = authorityIn(held()) as ContractAuthority;
    /* RED WHEN: the committee or a member of it can be altered by a caller after it was read. */
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.committee)).toBe(true);
    expect(Object.isFrozen(read.committee[0])).toBe(true);
  });

  it('lower-cases every key once, so no caller compares by case', () => {
    const read = authorityIn(held({ committee: [{ tag: 'schnorr', value: KEY_A.toUpperCase() }] })) as ContractAuthority;
    /* RED WHEN: a key is handed on in the case it was found in. */
    expect(read.committee[0]!.value).toBe(KEY_A);
  });

  it('reads a threshold of zero rather than refusing it', () => {
    /* RED WHEN: a state the chain accepts with a threshold of zero is refused instead of read. */
    expect((authorityIn(held({ threshold: 0 })) as ContractAuthority).threshold).toBe(0);
  });

  it('reads a contract with an empty committee', () => {
    /* RED WHEN: an empty committee is refused, so an unheld contract cannot be told apart from an unreadable one. */
    expect((authorityIn(held({ committee: [], threshold: 0 })) as ContractAuthority).committee).toEqual([]);
  });

  it('reads the runtime\'s own state the way it reads a plain object', () => {
    const state = new ContractState();
    state.maintenanceAuthority = new ContractMaintenanceAuthority(
      [{ tag: 'schnorr', value: KEY_A }, { tag: 'schnorr', value: KEY_B }], 2, 0n,
    );
    /* RED WHEN: the reader asks for something only a plain object has, so the runtime's state is refused. */
    expect(authorityIn(ContractState.deserialize(state.serialize()))).toEqual(authorityIn(held()));
  });

  it('refuses a state that is not an object', () => {
    /* RED WHEN: a missing or non-object state is read as if it were held by nobody. */
    for (const bad of [undefined, null, 'state', 7]) expect(refusal(authorityIn(bad))).toMatch(/not an object/u);
  });

  it('refuses a state that carries no authority', () => {
    /* RED WHEN: a state with no maintenance authority, or one that is not an object, is read as an empty committee. */
    expect(refusal(authorityIn({ data: {} }))).toMatch(/no maintenance authority/u);
    expect(refusal(authorityIn(stateWith(null)))).toMatch(/no maintenance authority/u);
    for (const bad of [7, 'x', true]) expect(refusal(authorityIn(stateWith(bad)))).toMatch(/no maintenance authority/u);
  });

  it('refuses an unmaintainable contract as one with no committee', () => {
    /* RED WHEN: an unmaintainable contract is read as one with an empty committee. */
    expect(refusal(authorityIn({ maintenanceAuthority: { kind: 'unmaintainable' } }))).toMatch(/committee is not a list/u);
  });

  it('refuses a committee that is not a list', () => {
    /* RED WHEN: the committee is not checked to be a list, so an object or a string is walked as if it were one. */
    for (const bad of [undefined, { length: 1 }, 'ab', null]) expect(refusal(authorityIn(held({ committee: bad })))).toMatch(/committee is not a list/u);
  });

  it('refuses a member with no kind of key', () => {
    /* RED WHEN: a member without a tag, or with an empty or non-text tag, is accepted. */
    for (const bad of [{ value: KEY_A }, { tag: '', value: KEY_A }, { tag: 1, value: KEY_A }, null, 'schnorr']) {
      expect(refusal(authorityIn(held({ committee: [bad] })))).toMatch(/no kind of key/u);
    }
  });

  it('refuses a member whose key is not hex digits', () => {
    /* RED WHEN: a key that is empty, prefixed, padded with space, not text or not hex is accepted. */
    for (const bad of [undefined, 7, '', '0x' + KEY_A, ` ${KEY_A}`, `${KEY_A}\n`, 'zz', 'ab cd']) {
      expect(refusal(authorityIn(held({ committee: [{ tag: 'schnorr', value: bad }] })))).toMatch(/not hex digits/u);
    }
  });

  it('refuses a threshold that is not a whole number of at least zero', () => {
    /* RED WHEN: a fractional, negative, text, infinite or unsafe threshold is accepted. */
    for (const bad of [1.5, -1, '2', 2n, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, undefined]) {
      expect(refusal(authorityIn(held({ threshold: bad })))).toMatch(/threshold/u);
    }
  });

  it('refuses a counter that is not a bigint of at least zero', () => {
    /* RED WHEN: a counter that is a plain number, text, missing or negative is accepted. */
    for (const bad of [0, 1, '0', undefined, -1n]) expect(refusal(authorityIn(held({ counter: bad })))).toMatch(/counter/u);
  });

  it('refuses a committee when any one member of it is malformed', () => {
    /* RED WHEN: only the first member is checked. */
    const read = authorityIn(held({ committee: [{ tag: 'schnorr', value: KEY_A }, { tag: 'schnorr', value: 'nope' }] }));
    expect(refusal(read)).toMatch(/not hex digits/u);
  });
});

describe('what the reader loads', () => {
  it('imports nothing that loads the ledger', () => {
    const text = readFileSync(new URL('./contract-authority.ts', import.meta.url), 'utf8');
    const source = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    /* RED WHEN: the reader imports anything, on one line or several, so the modules that must load without the ledger cannot call it. */
    expect(source).not.toMatch(/(^|[;}\n])\s*import\b/u);
    expect(source).not.toMatch(/\bexport\b[^;]*\bfrom\s*['"]/u);
    expect(source).not.toMatch(/\bfrom\s*['"]/u);
    expect(source).not.toMatch(/require\s*\(|import\s*\(/u);
  });
});

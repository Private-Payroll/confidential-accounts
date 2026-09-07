import { describe, expect, it } from 'vitest';
import { RegistryError, abbreviate, check, define, kindOf } from './definition.js';
import type { Kind, Rule } from './definition.js';
import { EMAIL, GIVEN_NAME, REGISTRY, registryOf } from './attributes.js';

const definitionOf = (name: string) => {
  const found = REGISTRY.definitionOf(name);
  if (!found) throw new Error(`no definition for ${name}`);
  return found;
};

describe('a definition cannot disagree with itself', () => {
  it('`kind` is read off the rule and is never written by hand', () => {
    for (const definition of REGISTRY.all) {
      expect(definition.kind).toBe(definition.validate.of);
      expect(kindOf(definition)).toBe(definition.validate.of);
    }
  });

  it('AND FOR A KIND NO SHIPPED ATTRIBUTE USES — which is what the survivor found', () => {
    /*
     * The first version of this block iterated `REGISTRY.all`, and **every
     * shipped attribute is `text`** — so `kind: 'text'` written by hand instead
     * of read off the rule passed it. A mutation survived and said so. The
     * check has to stand on a rule the shipped vocabulary does not use.
     */
    const made = (rule: Rule): Kind => define({
      name: 'a-shape',
      version: 1,
      source: 'stated',
      validate: rule,
      selfAssertable: true,
      acceptedIssuers: null,
      multiple: false,
      sensitivity: 'ordinary',
      render: { label: 'A shape', hint: '', abbreviate: 'none' },
      provable: [],
    }).kind;
    expect(made({ of: 'enum', members: [{ value: 'a', label: 'A' }] })).toBe('enum');
    expect(made({ of: 'date' })).toBe('date');
    expect(made({ of: 'number' })).toBe('number');
    expect(made({ of: 'text', minLength: 1, maxLength: 2 })).toBe('text');
  });

  it('refuses an attribute nobody may ever state — it would hold nothing', () => {
    expect(() => define({
      name: 'nobody-can-say-this',
      version: 1,
      source: 'stated',
      validate: { of: 'text', minLength: 1, maxLength: 10 },
      selfAssertable: false,
      acceptedIssuers: null,
      multiple: false,
      sensitivity: 'ordinary',
      render: { label: 'X', hint: '', abbreviate: 'none' },
      provable: [],
    })).toThrow(RegistryError);
  });

  it('refuses a name that is not a vocabulary name', () => {
    for (const bad of ['Given Name', 'given_name', '1st', '']) {
      expect(() => define({
        name: bad,
        version: 1,
        source: 'stated',
        validate: { of: 'text', minLength: 1, maxLength: 10 },
        selfAssertable: true,
        acceptedIssuers: null,
        multiple: false,
        sensitivity: 'ordinary',
        render: { label: 'X', hint: '', abbreviate: 'none' },
        provable: [],
      })).toThrow(RegistryError);
    }
  });

  it('refuses two definitions of one name in one registry', () => {
    const one = definitionOf(GIVEN_NAME);
    expect(() => registryOf([one, { ...one, version: 2 }])).toThrow(/defined twice/u);
  });
});

describe('checking a typed value uses the RULE and never the name', () => {
  it('says what is wrong in the person\'s language, not in a code', () => {
    const outcome = check(definitionOf(EMAIL), 'not-an-email');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.says).toBe('An email address looks like name@example.com.');
  });

  it('accepts an email a stricter pattern would have refused', () => {
    for (const good of ['a+b@example.co.uk', "o'brien@example.com", 'x@a.b.c']) {
      expect(check(definitionOf(EMAIL), good).ok).toBe(true);
    }
  });

  it('trims and normalises before checking, so a pasted value is not refused for space', () => {
    const outcome = check(definitionOf(GIVEN_NAME), '  Sarah  ');
    expect(outcome).toEqual({ ok: true, value: 'Sarah' });
  });

  it('refuses empty by name rather than by falling through a length rule', () => {
    expect(check(definitionOf(GIVEN_NAME), '   ')).toMatchObject({ ok: false });
  });

  it('a date rule refuses a date that does not exist', () => {
    const dob = define({
      name: 'a-date',
      version: 1,
      source: 'stated',
      validate: { of: 'date', earliest: '1900-01-01', latest: '2020-12-31' },
      selfAssertable: true,
      acceptedIssuers: null,
      multiple: false,
      sensitivity: 'sensitive',
      render: { label: 'A date', hint: '', abbreviate: 'none' },
      provable: [],
    });
    expect(check(dob, '2001-02-30')).toMatchObject({ ok: false });
    expect(check(dob, '2001-02-28')).toMatchObject({ ok: true });
    expect(check(dob, '1899-12-31')).toMatchObject({ ok: false });
    expect(check(dob, '2021-01-01')).toMatchObject({ ok: false });
  });

  it('an enum names its members when it refuses', () => {
    const colour = define({
      name: 'a-choice',
      version: 1,
      source: 'stated',
      validate: { of: 'enum', members: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] },
      selfAssertable: true,
      acceptedIssuers: null,
      multiple: false,
      sensitivity: 'ordinary',
      render: { label: 'A choice', hint: '', abbreviate: 'none' },
      provable: [],
    });
    const outcome = check(colour, 'c');
    expect(outcome.ok === false && outcome.says).toContain('Alpha, Beta');
  });

  it('a pattern is ANCHORED — a rule that matches part of a string is not a rule', () => {
    const digits = define({
      name: 'digits-only',
      version: 1,
      source: 'stated',
      validate: { of: 'text', minLength: 1, maxLength: 20, pattern: '\\d+' },
      selfAssertable: true,
      acceptedIssuers: null,
      multiple: false,
      sensitivity: 'ordinary',
      render: { label: 'Digits', hint: '', abbreviate: 'none' },
      provable: [],
    });
    expect(check(digits, '123')).toMatchObject({ ok: true });
    expect(check(digits, 'abc123def')).toMatchObject({ ok: false });
  });
});

describe('abbreviating keeps both ends', () => {
  it('a middle abbreviation shows the start AND the end', () => {
    const definition = { ...definitionOf(GIVEN_NAME), render: { ...definitionOf(GIVEN_NAME).render, abbreviate: 'middle' as const } };
    const shown = abbreviate(definition, 'abcdefghijklmnop');
    expect(shown.startsWith('abcde')).toBe(true);
    expect(shown.endsWith('lmnop')).toBe(true);
  });

  it('an email keeps its whole domain, because the domain is the point', () => {
    expect(abbreviate(definitionOf(EMAIL), 'sarah@work.example')).toBe('s…h@work.example');
  });
});

/**
 * **THE SECOND SOURCE, AND THE COMBINATIONS `define` REFUSES.**
 */
describe('a derived attribute is stated by nobody, and that is checked', () => {
  const derived = {
    name: 'a-derived-thing',
    version: 1,
    source: 'derived' as const,
    validate: { of: 'text' as const, minLength: 1, maxLength: 20 },
    selfAssertable: false,
    acceptedIssuers: null,
    multiple: false,
    sensitivity: 'ordinary' as const,
    render: { label: 'A derived thing', hint: '', abbreviate: 'none' as const },
    provable: [],
  };

  it('one that nobody states and nobody issues is ACCEPTED, where a stated one is not', () => {
    /* The same three lines on a `stated` attribute mean *this can never hold
     * anything* and are refused. On a derived one they are the point. */
    expect(define(derived).source).toBe('derived');
    expect(() => define({ ...derived, source: 'stated' }))
      .toThrow(/can never hold anything/u);
  });

  it('AND ONE THAT CLAIMS SOMEBODY STATES IT IS REFUSED', () => {
    /* A text box for a value nothing typed into it could change, and whatever
     * was typed would be sent as though the wallet had computed it. */
    expect(() => define({ ...derived, selfAssertable: true }))
      .toThrow(/nobody states it and nobody issues it/u);
    expect(() => define({ ...derived, acceptedIssuers: 'any' }))
      .toThrow(/nobody states it and nobody issues it/u);
    /* `multiple` asks how many of a STORED thing are held, and nothing derived
     * is ever stored. */
    expect(() => define({ ...derived, multiple: true }))
      .toThrow(/holds no second value/u);
  });
});

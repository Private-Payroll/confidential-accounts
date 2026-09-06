/**
 * The redactor, on its own.
 *
 * The round's real deliverable is the test that greps the sink's own report —
 * `src/server/web-console-sink.test.ts`. This file is the layer beneath it:
 * the shapes, one at a time, including the two that must NOT be touched,
 * because a redactor that eats stack traces is a redactor somebody switches off.
 */
import { describe, it, expect } from 'vitest';
import { redactSecrets, MAX_MESSAGE } from './redact-secrets.js';

describe('removing a secret from a line of text', () => {
  it('THE LINE C145 IS ABOUT: the SDK printing its own seed', () => {
    const line = 'INFO (18260): Your wallet seed is: '
      + '39aebaeb0a2f4c1d8e7b6a5940312233445566778899aabbccddeeff00112233';
    const out = redactSecrets(line);
    expect(out).toContain('<redacted:seed>');
    expect(out).not.toContain('39aebaeb');
    // The line still says what it was, which is the point of redacting rather
    // than dropping: a report that silently loses lines teaches nobody anything.
    expect(out).toContain('Your wallet seed is:');
  });

  it('a seed phrase is a shape, not a word list', () => {
    const phrase = 'abandon ability able about above absent absorb abstract '
      + 'absurd abuse access accident account accuse achieve acid acoustic '
      + 'acquire across act action actor actress';
    expect(redactSecrets(`recovered ${phrase} ok`)).toBe('recovered <redacted:seed-phrase> ok');
  });

  /*
   * `C148`, and the two cases the row names. Both of these were written to disk
   * IN FULL by the rule this suite shipped with: it read `[a-z]` without `i`,
   * so `above Absent` ended the run of lower-case words and the whole phrase
   * survived. The words are a working wallet in either shape.
   *
   * `scripts/mutate-refusals.mjs` 03 takes the flag back off, and these are the
   * two tests that have to die when it does.
   */
  it('C148: a phrase with ONE capitalised word in it, which a phone keyboard produces', () => {
    const phrase = 'abandon ability able about above Absent absorb abstract '
      + 'absurd abuse access accident account accuse achieve acid acoustic '
      + 'acquire across act action actor actress';
    const out = redactSecrets(`restore failed for: ${phrase}`);
    expect(out).toBe('restore failed for: <redacted:seed-phrase>');
    // Named explicitly: it is the ONE capital that used to turn the rule off.
    expect(out).not.toContain('Absent');
  });

  it('C148: and a phrase in capitals, which is the same wallet', () => {
    const phrase = 'ABANDON ABILITY ABLE ABOUT ABOVE ABSENT ABSORB ABSTRACT '
      + 'ABSURD ABUSE ACCESS ACCIDENT ACCOUNT ACCUSE ACHIEVE ACID';
    const out = redactSecrets(`pasted ${phrase} into the wrong field`);
    expect(out).not.toContain('ABANDON');
    expect(out).toContain('<redacted:seed-phrase>');
    /*
     * **AND THE OVER-REDACTION, PINNED RATHER THAN DESCRIBED.** The words
     * around the phrase are themselves short and unpunctuated, so the run does
     * not stop at the phrase — `pasted … into the wrong field` goes with it and
     * this line is redacted whole.
     *
     * That is the cost the header names, made visible: a report loses a
     * sentence. It is the trade the file already says it wants, and a test that
     * asserted the surrounding words survived would be asserting the rule is
     * narrower than it is.
     */
    expect(out).toBe('<redacted:seed-phrase>');
  });

  it('C148: and what the over-redaction costs — twelve short title-case words', () => {
    // The header's own example, pinned so the price is a fact rather than a
    // prediction. This is ordinary text in an error message and it goes.
    const prose = 'Could Not Open The Record For This Person Upon That Run Today';
    expect(redactSecrets(prose)).toBe('<redacted:seed-phrase>');
    // Eleven does not, so the threshold is still a decision and not an accident.
    const eleven = 'Could Not Open The Record For This Person Upon That Run';
    expect(redactSecrets(eleven)).toBe(eleven);
  });

  it('thirty-two hex characters or more, the same threshold as the sealed-record helper', () => {
    expect(redactSecrets('key 0123456789abcdef0123456789abcdef')).toBe('key <redacted:hex>');
    // Thirty-one is left alone. The threshold is a decision, not an accident.
    expect(redactSecrets('id 0123456789abcdef0123456789abcde')).toBe('id 0123456789abcdef0123456789abcde');
  });

  it('a bearer token, and the word Bearer survives so the line still says what went', () => {
    const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig');
    expect(out).toBe('Authorization: Bearer <redacted:token>');
  });

  it('a value is redacted by the NAME beside it, in every shape text arrives in', () => {
    expect(redactSecrets('{"password":"hunter2","email":"a@b.c"}'))
      .toBe('{"password":"<redacted>","email":"a@b.c"}');
    expect(redactSecrets('authKey=short')).toBe('authKey=<redacted>');
    expect(redactSecrets('sessionToken: abc')).toBe('sessionToken: <redacted>');
  });

  it('a Midnight bech32 string goes whole, address or not', () => {
    expect(redactSecrets('to mn_addr_stagenet1ku4g25nwe6reyqqpqxk9lz7ryd0d7lz9wq2mm4ku8x0k'))
      .toBe('to <redacted:bech32>');
  });

  it('THE ONE THAT KEEPS IT USABLE: a stack trace is not a secret', () => {
    const stack = 'TypeError: t is not a function\n'
      + '    at App (/Users/somebody/work/confidential-accounts-v5/src/web/App.tsx:12:5)\n'
      + '    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom.js:1234:9)';
    expect(redactSecrets(stack)).toBe(stack);
  });

  it('and an ordinary sentence with the word task in it is not a secret either', () => {
    expect(redactSecrets('task: 5 disk: full risk: none')).toBe('task: 5 disk: full risk: none');
  });

  it('an enormous message is truncated rather than persisted whole', () => {
    // Ordinary prose, deliberately: a long run of one character is token-shaped
    // and would be redacted before it could be truncated, which would make this
    // case pass for a reason that has nothing to do with length.
    const out = redactSecrets('the cat sat. '.repeat(MAX_MESSAGE));
    expect(out.length).toBeLessThan(MAX_MESSAGE + 40);
    expect(out).toContain('<truncated>');
  });

  it('it never throws, whatever it is handed', () => {
    expect(redactSecrets(undefined)).toBe('undefined');
    expect(redactSecrets(null)).toBe('null');
    expect(redactSecrets({ a: 1 })).toBe('[object Object]');
  });
});

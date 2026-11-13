/**
 * **A REFUSAL IS SAID IN THE WORDS IT WAS THROWN WITH**, once for every file that quotes one inside a sentence of its own:
 * the error's message, or the thing thrown when it carries none, and without its closing full stop where the quoting
 * sentence goes on after it.
 */
import { describe, expect, it } from 'vitest';
import { lowerHex, said, saidWithoutStop } from './vault-info-here.js';

describe('A REFUSAL QUOTED INSIDE ANOTHER SENTENCE', () => {
  it('is the error\'s message, or what was thrown, and drops only one closing full stop and the space after it', () => {
    expect(said(new Error('the chain did not answer.'))).toBe('the chain did not answer.');
    expect(said('no indexer')).toBe('no indexer');
    /* RED WHEN: a quoted refusal keeps its full stop, so the sentence around it reads "answer.)." */
    expect(saidWithoutStop(new Error('the chain did not answer.'))).toBe('the chain did not answer');
    expect(saidWithoutStop(new Error('the chain did not answer. '))).toBe('the chain did not answer');
    /* RED WHEN: a full stop inside the words is taken off as well as the closing one. */
    expect(saidWithoutStop(new Error('one.two.'))).toBe('one.two');
    expect(saidWithoutStop('no stop')).toBe('no stop');
  });

  it('an address or an identity on the chain is compared in lower case, whatever case it was written in', () => {
    /* RED WHEN: the same identity written in capitals is read as another. */
    expect(lowerHex('AB'.repeat(32))).toBe('ab'.repeat(32));
  });
});

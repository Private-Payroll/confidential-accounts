// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { CREATION_STEPS } from '../../../../src/midnight/deferral.js';
import { secondStepIsOn } from './creation-chain.js';

/*
 * Whether a company's creation has finished is read from which circuits its
 * account carries. The keys those circuits hold are judged where they are
 * signed for; here an operation whose keys cannot be read must not turn a
 * finished creation into one that is waited on for ever.
 */
const holding = (names: readonly string[]) => ({
  operations: () => [...names],
  /* An operation with no serialized form: its key slots cannot be read. */
  operation: () => ({ verifierKey: new Uint8Array([1]) })
});

describe('A FINISHED CREATION IS READ BY ITS CIRCUITS', () => {
  it('IS FINISHED WHEN EVERY SECOND-STEP CIRCUIT IS ON, WHATEVER CAN BE READ OF THEIR KEYS', () => {
    /* RED WHEN: an account whose keys cannot be read reads as not finished, and the wallet waits for ever. */
    expect(secondStepIsOn(holding([...CREATION_STEPS.first, ...CREATION_STEPS.second]))).toBe(true);
    /* RED WHEN: an account missing one second-step circuit reads as finished. */
    expect(secondStepIsOn(holding([...CREATION_STEPS.first, ...CREATION_STEPS.second.slice(1)]))).toBe(false);
    expect(secondStepIsOn(null)).toBe(false);
    expect(
      secondStepIsOn({
        operations: () => {
          throw new Error('no');
        }
      })
    ).toBe(false);
  });
});

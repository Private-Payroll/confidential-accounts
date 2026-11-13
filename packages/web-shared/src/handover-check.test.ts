/**
 * Why nothing is built for a committee while a seat the chain holds has no signer this device believes: the refusal
 * names each such seat and what clears it, so a signer waiting to be admitted is never a wait nobody can end.
 */
import { describe, expect, it } from 'vitest';
import { whyNotWhole } from './handover-check.js';

const WAITING = 'ab'.repeat(32);
const ALSO = 'cd'.repeat(32);

describe('a committee is built only from a roster that names a signer at every seat', () => {
  it('builds for a roster believed at every seat', () => {
    expect(whyNotWhole({ id: 'acme', signers: [], notBelieved: [] })).toBeNull();
  });

  it('names each seat waiting for its signer and what ends the wait', () => {
    const why = whyNotWhole({ id: 'acme', signers: [], notBelieved: [WAITING, ALSO] });
    /* RED WHEN: the refusal does not say which seats hold it up, so nobody can tell whose wallet ends it. */
    expect(why).toContain(WAITING);
    expect(why).toContain(ALSO);
    /* RED WHEN: the refusal says giving keys admits a waiting signer: only Admit a signer, from a seat that may file the list, does. */
    expect(why).toMatch(/still waiting to be admitted is admitted from the wallet of a seat that may file the list of signers \(Admit a signer\)/u);
    expect(why).not.toMatch(/gives their keys .* admits them/u);
    /* RED WHEN: a signer already admitted whose keys are not in the list is not told to give them, for the next seat action to fold in. */
    expect(why).toMatch(/already admitted whose keys are not in the list gives their keys from their own wallet .* folds them in/u);
  });
});

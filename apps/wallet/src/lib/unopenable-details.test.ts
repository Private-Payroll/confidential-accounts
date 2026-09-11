import { describe, expect, it } from 'vitest';
import { OTHER_DETAILS_HERE, sayingForUnopenable } from './unopenable-details.js';
import type { UnopenableCause } from 'midnight-identity/profile/seal';

const STORE_WHY = 'the details saved for this wallet here will not open with its key, so they are not '
  + 'what it saved: they have been changed since.';
const unopenable = (cause: UnopenableCause) => ({ of: 'unopenable' as const, cause, why: STORE_WHY });

describe('what a wallet says about details it cannot open', () => {
  it('EVERY failure that reaches a screen is this wallet\'s own record, so it keeps the warning and the store\'s sentence', () => {
    for (const cause of ['another-key', 'not-sealed-by-this-wallet', 'unreadable', 'not-a-profile'] as const) {
      const said = sayingForUnopenable(unopenable(cause));
      expect(said.tone, cause).toBe('danger');
      expect(said.sentence, cause).toBe(STORE_WHY);
      expect(said.title, cause).toBe('There are details here that this account cannot open');
    }
  });

  it('a record it cannot open that is not provably its own is described as either, and promised nothing', () => {
    expect(OTHER_DETAILS_HERE).toContain('another wallet used here saved them');
    expect(OTHER_DETAILS_HERE).toContain('changed after they were saved');
    expect(OTHER_DETAILS_HERE).toContain('do not stop this wallet saving its own');
    expect(OTHER_DETAILS_HERE, 'the wallet that saved them may be gone').not.toMatch(/will open|open when/);
  });
});

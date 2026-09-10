import { describe, expect, it } from 'vitest';
import { sayingForUnopenable } from './unopenable-details.js';
import type { UnopenableCause } from 'midnight-identity/profile/seal';

const LIBRARY_WHY = 'the details stored here will not open with this account\'s key. They belong to '
  + 'another account, or they have been altered.';
const unopenable = (cause: UnopenableCause) => ({ of: 'unopenable' as const, cause, why: LIBRARY_WHY });

describe('what a wallet says about details it cannot open', () => {
  it('A KEY FAILURE IN A BROWSER HOLDING SEVERAL WALLETS names the other wallets, and raises no alarm', () => {
    const said = sayingForUnopenable(unopenable('another-key'), 3);
    expect(said.anotherWalletHere).toBe(true);
    expect(said.tone).toBe('info');
    expect(said.sentence).toContain('This browser holds 3 wallets');
    expect(said.sentence).toContain('most likely saved by another wallet used in this browser');
    expect(said.sentence, 'the other wallet may no longer be here').not.toMatch(/open when/);
    expect(said.sentence).not.toMatch(/altered|tamper/i);
    expect(said.title).not.toMatch(/cannot open/);
  });

  it('the same failure in a browser holding ONE wallet keeps the library\'s sentence and its warning', () => {
    for (const count of [0, 1]) {
      const said = sayingForUnopenable(unopenable('another-key'), count);
      expect(said.anotherWalletHere).toBe(false);
      expect(said.tone).toBe('danger');
      expect(said.sentence).toBe(LIBRARY_WHY);
    }
  });

  it('every OTHER failure keeps the warning, however many wallets are here', () => {
    for (const cause of ['not-sealed-by-this-wallet', 'unreadable', 'not-a-profile'] as const) {
      const said = sayingForUnopenable(unopenable(cause), 4);
      expect(said.anotherWalletHere, cause).toBe(false);
      expect(said.tone, cause).toBe('danger');
      expect(said.title, cause).toBe('There are details here that this account cannot open');
    }
  });
});

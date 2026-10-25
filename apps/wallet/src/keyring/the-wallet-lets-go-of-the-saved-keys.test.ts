import { describe, expect, it, vi } from 'vitest';

/* Every key the wallet derives to open saved keys is kept here too, so the test can see what became of its bytes. */
const derived: Uint8Array[] = [];
vi.mock('./seal-key.js', async (original) => {
  const real = await original<typeof import('./seal-key.js')>();
  return {
    ...real,
    keyringSealKeyFor: (...args: Parameters<typeof real.keyringSealKeyFor>) => {
      const k = real.keyringSealKeyFor(...args);
      derived.push(k);
      return k;
    },
    keyringKeyBeforeTheSeal: (...args: Parameters<typeof real.keyringKeyBeforeTheSeal>) => {
      const k = real.keyringKeyBeforeTheSeal(...args);
      derived.push(k);
      return k;
    },
  };
});

import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { keyringKeyFor } from 'midnight-identity/profile/unlock';
import { keyringSealKeyFor } from './seal-key.js';
import { toHex } from '../../../../src/core/crypto.js';
import { sealKeyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import { openHeldKeyring, type KeyringMarks } from './held-keyring.js';

/*
 * **THE WALLET LETS GO OF THE KEY AND THE SAVED KEYS AS SOON AS IT CAN.** The keyring key's bytes are zeroed once the
 * key is in the form the seal takes, a step is handed copies rather than the keys the wallet holds, and letting go
 * leaves nothing more to read.
 */

const identity = identityFromSecret(newSecret());
const ASK = { requester: { origin: 'https://app.payroll.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a' };
const KEY = toHex(keyringSealKeyFor(identity, ASK));
const OLD = toHex(keyringKeyFor(identity, ASK));
const SEAT = { signerId: 'sig_1', signingSecret: '11'.repeat(32), wrappingSecret: '22'.repeat(32), blinding: '33'.repeat(32), scope: '44'.repeat(32) };
const marks = (): KeyringMarks => ({ markOf: () => null, raise: () => {} });
const opened = () => openHeldKeyring({
  identity, ask: ASK, handedIn: { sealed: sealKeyring({ accounts: { acc_A: SEAT } }, KEY).sealed, version: 1 }, marks: marks(),
});

describe('the wallet lets go of the key and the saved keys', () => {
  it('zeroes the keyring key\'s bytes once it has the key in the form the seal takes', () => {
    derived.length = 0;
    opened();
    /* RED WHEN: the 32 bytes the key was derived as are left in memory after opening. */
    expect(derived).toHaveLength(1);
    expect([...derived[0]!].every((b) => b === 0)).toBe(true);
  });

  it('zeroes the old key\'s bytes too, when a copy sealed under it is opened once', () => {
    derived.length = 0;
    openHeldKeyring({ identity, ask: ASK, handedIn: { sealed: sealKeyring({ accounts: { acc_A: SEAT } }, OLD).sealed, version: 1 }, marks: marks() });
    /* RED WHEN: the old key, or the new, is left in memory after a copy under the old key is opened. */
    expect(derived).toHaveLength(2);
    for (const d of derived) expect([...d].every((b) => b === 0)).toBe(true);
  });

  it('hands a step a copy, so what the step keeps is not the saved keys the wallet holds', () => {
    const held = opened();
    const view = held.read();
    (view.accounts['acc_A'] as { blinding: string }).blinding = '99'.repeat(32);
    /* RED WHEN: a step that writes into what it read changes the saved keys the wallet holds and will seal. */
    expect(held.read().accounts['acc_A']?.blinding).toBe(SEAT.blinding);
  });

  it('leaves nothing more to read or seal after letting go', () => {
    const held = opened();
    held.letGo();
    /* RED WHEN: the saved keys can still be read, listed or sealed once the action has let them go. */
    expect(() => held.read()).toThrow();
    expect(() => held.metadata()).toThrow();
    expect(() => held.seal((k) => k)).toThrow();
  });
});

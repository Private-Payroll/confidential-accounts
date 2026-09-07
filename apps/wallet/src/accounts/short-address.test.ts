import { describe, expect, it } from 'vitest';
import { splitShortAddress } from './short-address.js';

/*
 * The rule on the screen: which part of an address is faded and which is strong.
 * The faded run must be exactly the shared network prefix (separator
 * included), and both of this address's own ends must survive as the strong
 * parts — a split that eats a character of either end weakens the only
 * comparison the short form supports.
 */
describe('splitShortAddress', () => {
  it('splits a testnet short form into prefix, head and tail', () => {
    const parts = splitShortAddress('mn_shield-addr_testnet1wsswq8lg…kgluvmmw');
    expect(parts.network).toBe('mn_shield-addr_testnet1');
    expect(parts.head).toBe('wsswq8lg');
    expect(parts.tail).toBe('kgluvmmw');
  });

  /* The bech32 character set excludes '1', so the LAST '1' is the separator
   * even though the human prefix contains none here — and even if a network
   * name ever contained one, lastIndexOf keeps the split at the separator. */
  it('keeps the whole prefix when the network name is different', () => {
    const parts = splitShortAddress('mn_shield-addr_mainnet1abcdefgh…zyxwvuts');
    expect(parts.network).toBe('mn_shield-addr_mainnet1');
    expect(parts.head).toBe('abcdefgh');
    expect(parts.tail).toBe('zyxwvuts');
  });

  it('handles a short form with no ellipsis — nothing was elided', () => {
    const parts = splitShortAddress('mn_shield-addr_testnet1abc');
    expect(parts.network).toBe('mn_shield-addr_testnet1');
    expect(parts.head).toBe('abc');
    expect(parts.tail).toBeNull();
  });

  /* Two `1`s before the payload: the LAST one is the separator. An
   * `indexOf` here would fade only up to the first and promote half the
   * prefix to "this address's own characters" — exactly the wrong emphasis. */
  it('splits at the LAST separator when the prefix itself contains a 1', () => {
    const parts = splitShortAddress('net1work1abcdefgh…zyxwvuts');
    expect(parts.network).toBe('net1work1');
    expect(parts.head).toBe('abcdefgh');
    expect(parts.tail).toBe('zyxwvuts');
  });

  it('does not invent a prefix when there is no separator', () => {
    const parts = splitShortAddress('nosuchthing…end');
    expect(parts.network).toBe('');
    expect(parts.head).toBe('nosuchthing');
    expect(parts.tail).toBe('end');
  });

  it('reassembles to exactly what it was given', () => {
    for (const short of [
      'mn_shield-addr_testnet1wsswq8lg…kgluvmmw',
      'mn_shield-addr_undeployed1aaaa…bbbb',
      'plain',
    ]) {
      const parts = splitShortAddress(short);
      const whole = parts.network + parts.head + (parts.tail === null ? '' : `…${parts.tail}`);
      expect(whole).toBe(short);
    }
  });
});

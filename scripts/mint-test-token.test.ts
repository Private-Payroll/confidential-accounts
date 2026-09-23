/**
 * **THE REFUSALS OF THE DOOR THAT MAKES THE FIRST SHIELDED COIN, DRIVEN
 * WITHOUT A CHAIN.**
 *
 * `scripts/mint-test-token.ts` deploys a contract and proves a mint on a real
 * network, so almost none of it can be tested here. **What can be, and what
 * this file covers, is every decision it takes before the wallet, plus the one
 * decision it takes afterwards that decides what the NEXT door does** — which
 * coin arrived, and therefore which colour is written into the record.
 *
 * That last one is the reason this file exists rather than being a smaller
 * version of `fund-vault.test.ts`: **a colour written wrongly is a deposit
 * aimed at the wrong money**, and the only defence is that the function refuses
 * ignorance instead of picking a coin.
 *
 * **AND THE IMPORT ITSELF IS PART OF THE TEST.** If the `RUN_DIRECTLY` guard at
 * the bottom of that file were ever removed, importing it here would go to the
 * network, deploy a contract and spend money.
 */
import { describe, it, expect } from 'vitest';

import { readFileSync } from 'node:fs';
import { amountFromText, parseTestTokenRecord, theMintedCoin, testTokenFile } from './mint-test-token.js';
import {
  TEST_SETTLEMENT_ASSET, TEST_SETTLEMENT_MINTED_ON, testAssetsFor,
} from '../src/core/assets.js';

describe('the amount, and the unit it is in', () => {
  it('takes a whole number of the smallest unit', () => {
    expect(amountFromText('5000')).toBe(5000n);
    expect(amountFromText('  5000  ')).toBe(5000n);
  });

  it('refuses a decimal point rather than interpreting it', () => {
    /*
     * The door takes whole smallest units. The registry does declare a scale
     * for the test asset, and the refusal says so; converting a figure with a
     * point is still the person's to do, never the door's to guess.
     * RED WHEN the refusal stops saying the unit is the smallest unit, as a
     * whole number, with no point.
     */
    expect(() => amountFromText('5.5')).toThrow(/digits and nothing else/i);
    expect(() => amountFromText('5.5'))
      .toThrow(/smallest unit, as a whole number, and never a decimal point/i);
  });

  it('states the same scale the asset registry declares for the test asset', () => {
    /*
     * The refusal's decimal places and whole-unit figure are read against the
     * registry's own row, not against a copy of it.
     * RED WHEN the refusal says the token has no scale, or names a number of
     * decimal places or a whole-unit figure the registry does not declare.
     */
    const [row] = testAssetsFor(TEST_SETTLEMENT_MINTED_ON[0]!);
    expect(row?.code).toBe(TEST_SETTLEMENT_ASSET);
    const decimals = row!.decimals;
    expect(() => amountFromText('5.5')).toThrow(`with ${decimals} decimal places`);
    expect(() => amountFromText('5.5')).toThrow(`is ${10n ** BigInt(decimals)} here`);
    expect(() => amountFromText('5.5')).not.toThrow(/no decimal places|nothing declares a scale/i);
    /* RED WHEN the refusal states the scale as if every mint were that asset:
     * the door is asked before it knows which colour it will mint. */
    expect(() => amountFromText('5.5')).toThrow(/at the colour it names/);
    expect(() => amountFromText('5.5')).toThrow(/any other colour is a\s+token with no declared scale/);
    const source = readFileSync(new URL('./mint-test-token.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/nothing anywhere declares a scale/i);
    expect(source).toContain(`${decimals} decimal places, for the one`);
  });

  it('refuses an empty answer rather than defaulting', () => {
    expect(() => amountFromText('')).toThrow(/deliberately no default/);
  });

  it('refuses nothing, because there would be no coin to deposit', () => {
    expect(() => amountFromText('0')).toThrow(/not a mint/);
  });

  it('refuses more than the Uint<64> the mint circuit declares', () => {
    /*
     * The ceiling is the compiler's own, printed in `REPORT-PROBE-MINT.txt`:
     * `mintShieldedToken(Bytes<32>, Uint<64>, Bytes<32>, Either<…>)`. Refusing
     * it here costs nothing; discovering it after a proof server costs eight
     * minutes and a fee.
     */
    expect(amountFromText('18446744073709551615')).toBe(18_446_744_073_709_551_615n);
    expect(() => amountFromText('18446744073709551616')).toThrow(/Uint<64>/);
  });
});

describe('the record of the minter, and which chain it belongs to', () => {
  const address = 'ab'.repeat(32);

  it('reads back a record this door wrote', () => {
    expect(parseTestTokenRecord({ network: 'stagenet', contractAddress: address }, 'stagenet'))
      .toEqual({ contractAddress: address, colour: undefined });
  });

  it('carries the colour when there is one', () => {
    const colour = 'cd'.repeat(32);
    expect(parseTestTokenRecord(
      { network: 'stagenet', contractAddress: address, colour }, 'stagenet').colour).toBe(colour);
  });

  it('refuses a record from another network, because an address means nothing there', () => {
    expect(() => parseTestTokenRecord(
      { network: 'undeployed', contractAddress: address }, 'stagenet'))
      .toThrow(/means nothing on another chain/);
  });

  it('refuses a record with no usable address rather than reaching for one', () => {
    expect(() => parseTestTokenRecord({ network: 'stagenet', contractAddress: 'nope' }, 'stagenet'))
      .toThrow(/no usable contract address/);
  });

  it('refuses a colour that is not 32 bytes of hex by leaving it absent', () => {
    /*
     * ABSENT rather than rejected: the deposit door refuses a record with no
     * colour and names the door that writes one. A half-read colour that
     * reached that door would be a deposit built on it.
     */
    expect(parseTestTokenRecord(
      { network: 'stagenet', contractAddress: address, colour: 'short' }, 'stagenet').colour)
      .toBeUndefined();
  });

  it('names the file per network', () => {
    expect(testTokenFile('/x/.midnight', 'stagenet')).toBe('/x/.midnight/stagenet-test-token.json');
  });
});

describe('which coin was minted', () => {
  const colour = 'ab'.repeat(32);

  it('takes the coin the call reported', () => {
    const got = theMintedCoin([{ type: colour, value: 500n, nonce: 'cd'.repeat(32) }]);
    expect(got.type).toBe(colour);
    expect(got.value).toBe(500n);
  });

  it('refuses when the call reported no coins at all', () => {
    /*
     * `newCoins` is built by midnight-js out of the circuit's own Zswap
     * outputs. Its absence is a version difference, not a chain problem, and
     * saying so is the difference between an operator waiting and an operator
     * looking at the right thing.
     */
    expect(() => theMintedCoin([])).toThrow(/creates exactly one/);
    expect(() => theMintedCoin(undefined)).toThrow(/not the shape this door was written against/);
  });

  it('refuses to choose when more than one coin was reported', () => {
    expect(() => theMintedCoin([{ type: colour, value: 1n }, { type: 'cd'.repeat(32), value: 2n }]))
      .toThrow(/will not choose between them/);
  });

  it('refuses a token type that is not a colour, WHERE IT IS WRITTEN', () => {
    /*
     * **THE ONE THAT MATTERS.** Every reader of the record requires 32 bytes of
     * lower hex. A value that fails that check, written anyway, produces a
     * record the next door reports as having no colour — and it explains that
     * absence to the operator as a mint whose coin could not be identified,
     * which did not happen. The shape is checked where it is written.
     */
    expect(() => theMintedCoin([{ type: 'AB'.repeat(32), value: 1n }])).toThrow(/does not recognise as a colour/);
    expect(() => theMintedCoin([{ type: 'short', value: 1n }])).toThrow(/32 bytes of lower-case hex/);
  });
});

describe('the wait for the coin to be scanned, which is no longer this door\'s own', () => {
  it('HAS NO SECOND COPY OF THE COIN READ, AND NO INVENTED DEADLINE', () => {
    /*
     * **`M-104` AT THE SOURCE LEVEL, BECAUSE THAT IS WHERE THE DEFECT LIVED.**
     *
     * This door had `heldOf` reading `availableCoins` and a `5 * 60_000`
     * deadline it chose. The door beside it had a third reading of the same
     * list and no wait at all, and refused twice against a wallet that held the
     * coin. Both copies are gone; one implementation is in
     * `shielded-wallet.ts`. Nothing else can catch this coming back — calling a
     * shared function or not calling it is not a type error.
     */
    const src = readFileSync(new URL('./mint-test-token.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/state\(\)\??\.?\s*\??\.?shielded\?\.availableCoins/);
    expect(src.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/availableCoins/);
    expect(src).not.toMatch(/5 \* 60_000/);
    expect(src).toMatch(/waitForShieldedScan/);
    expect(src).toMatch(/shieldedHeldOf/);
  });

  it('still prints the two states as different states', () => {
    // The door composes `whyNoCoin`'s message rather than a sentence of its
    // own, so the refusal it prints cannot drift from the deposit door's.
    const src = readFileSync(new URL('./mint-test-token.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/whyNoCoin/);
    expect(src).toMatch(/why\.holding/);
  });
});

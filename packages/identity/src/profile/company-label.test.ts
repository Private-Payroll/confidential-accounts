import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sampleContractAddress } from '@midnightntwrk/ledger-v9';
import {
  COMPANY_LABEL_ENTRY, CompanyLabelError, companyLabelBytes, companyLabelOf, drawCompanyLabel, isCompanyLabel,
  readAccountAddress, readCompanyLabel, readVaultAddress,
} from './company-label.js';
import type { AccountAddress, CompanyLabel, VaultAddress } from './company-label.js';

/*
 * A company's label: one reader, one writer, one draw, and three types that do
 * not stand in for one another.
 */
const BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const LABEL = `co_${Buffer.from(BYTES).toString('hex')}`;
const ADDRESS = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';

describe('THE LABEL IS co_ AND SIXTY-FOUR LOWER-CASE HEX, AND NOTHING ELSE', () => {
  it('writes thirty-two bytes as a label and reads them back, byte for byte', () => {
    /* RED WHEN: the writer's prefix, case or width changes, or the bytes do not round-trip. */
    expect(companyLabelOf(BYTES)).toBe(LABEL);
    expect(Array.from(companyLabelBytes(companyLabelOf(BYTES)))).toEqual(Array.from(BYTES));
    expect(readCompanyLabel(LABEL)).toBe(LABEL);
  });

  it('REFUSES A CONTRACT ADDRESS WHERE A LABEL IS ASKED, AND A LABEL WHERE AN ADDRESS IS ASKED', () => {
    /* The two confusions the spelling exists to catch, at the first check.
     * RED WHEN: either reader accepts the other's shape. */
    for (let i = 0; i < 20; i += 1) {
      const address = sampleContractAddress();
      expect(readCompanyLabel(address), address).toBeNull();
      expect(readAccountAddress(address)).toBe(address);
      expect(readVaultAddress(address)).toBe(address);
    }
    expect(readAccountAddress(LABEL)).toBeNull();
    expect(readVaultAddress(LABEL)).toBeNull();
    expect(readAccountAddress(LABEL.slice(3))).toBe(LABEL.slice(3));
  });

  it('HAS ONE SPELLING: upper case, whitespace, another prefix, another width and the zero label are not labels', () => {
    /* RED WHEN: the reader folds, trims, or accepts thirty-two zero bytes. */
    for (const bad of [
      LABEL.toUpperCase(), `CO_${LABEL.slice(3)}`, `co_${LABEL.slice(3).toUpperCase()}`, ` ${LABEL}`, `${LABEL} `,
      `co-${LABEL.slice(3)}`, `cx_${LABEL.slice(3)}`, LABEL.slice(0, 66), `${LABEL}0`, `co_${'0'.repeat(64)}`,
      '', 'co_', 42, null, undefined, {},
    ]) {
      expect(readCompanyLabel(bad), String(bad)).toBeNull();
      expect(isCompanyLabel(bad), String(bad)).toBe(false);
    }
    expect(() => companyLabelBytes(LABEL.toUpperCase() as CompanyLabel)).toThrow(CompanyLabelError);
  });

  it('an address is read in either case and folded, as Midnight\'s own validator accepts it', () => {
    expect(readAccountAddress(ADDRESS.toUpperCase())).toBe(ADDRESS);
    for (const bad of [`0x${ADDRESS}`, ADDRESS.slice(1), `${ADDRESS}0`, ADDRESS.replace('d', 'g'), '']) {
      expect(readAccountAddress(bad), bad).toBeNull();
    }
  });

  it('the writer refuses anything but thirty-two bytes, and thirty-two zero bytes', () => {
    /* RED WHEN: a short, long or zero value is written as a label. */
    for (const bad of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(32)]) {
      expect(() => companyLabelOf(bad)).toThrow(CompanyLabelError);
    }
  });
});

describe('THE DRAW', () => {
  it('takes thirty-two bytes from the generator it is given, and spells them as a label', () => {
    /* RED WHEN: the draw asks for another width, or spells the bytes another way. */
    const asked: number[] = [];
    const label = drawCompanyLabel((n) => { asked.push(n); return BYTES; });
    expect(asked).toEqual([32]);
    expect(label).toBe(LABEL);
  });

  it('draws a different label every time from the platform\'s generator', () => {
    const seen = new Set(Array.from({ length: 200 }, () => drawCompanyLabel()));
    expect(seen.size).toBe(200);
    for (const label of seen) expect(readCompanyLabel(label)).toBe(label);
  });

  it('refuses a generator that answers with zero bytes rather than writing the zero label', () => {
    expect(() => drawCompanyLabel(() => new Uint8Array(32))).toThrow(CompanyLabelError);
  });

  it('REACHES NO WEBASSEMBLY AND NO LEDGER, so the page, the service and the wallet share it', () => {
    const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'company-label.ts'), 'utf8');
    expect(source.split('\n').filter((l) => /^import /u.test(l))).toEqual([]);
  });
});

describe('THE THREE TYPES DO NOT STAND IN FOR ONE ANOTHER', () => {
  it('passing one where another is wanted does not build', () => {
    /*
     * Checked when the code is built, not when this runs: each line below
     * carries `@ts-expect-error`, so the typecheck fails the day any of these
     * assignments is accepted. RED WHEN: two of the three types become the
     * same type (or plain `string`), which makes the expected error vanish.
     */
    const label = companyLabelOf(BYTES);
    const account = readAccountAddress(ADDRESS)!;
    const vault = readVaultAddress(ADDRESS)!;
    // @ts-expect-error an account's address is not a company's label
    const a: CompanyLabel = account;
    // @ts-expect-error a vault's address is not a company's label
    const b: CompanyLabel = vault;
    // @ts-expect-error a vault's address is not an account's address
    const c: AccountAddress = vault;
    // @ts-expect-error an account's address is not a vault's address
    const d: VaultAddress = account;
    // @ts-expect-error a label is not an account's address
    const e: AccountAddress = label;
    // @ts-expect-error a bare string is not a label
    const f: CompanyLabel = LABEL;
    expect([a, b, c, d, e, f].length).toBe(6);
  });
});

describe('WHERE THE LABEL SITS IN THE ACCOUNT', () => {
  it('is the key the account\'s constructor writes it under: thirty-two bytes of hex', () => {
    /* The contract derives it; the test beside the contract holds this copy equal to it. */
    expect(COMPANY_LABEL_ENTRY).toMatch(/^[0-9a-f]{64}$/u);
  });
});

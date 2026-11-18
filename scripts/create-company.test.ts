/**
 * THE CHECK THAT CREATES A COMPANY ON THE CHAIN BUILDS ITS FEE PAYER AND COMPANY HALF AS THE LAUNCHER DOES.
 *
 * The launcher's half of these rules is held beside it, in `serve-with-wallets-rules.test.ts`. This is the creator's
 * half, read from its source because the creator spends a fee and is run only against a live network.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const creator = readFileSync(join(import.meta.dirname, 'create-company.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the company creator pays its fee through the one pair', () => {
  /* RED WHEN: the creator brings a wallet up before it has read its ceiling, or builds its pair without passing it on. */
  it('reads the fee ceiling before any wallet, and hands it to the pair', () => {
    const ceiling = creator.indexOf('feeCeilingFrom(process.env)');
    const bringUp = creator.indexOf('bringUpWallet(');
    expect(ceiling, 'the creator does not read the ceiling').toBeGreaterThan(-1);
    expect(ceiling, 'the creator brings a wallet up before reading the ceiling').toBeLessThan(bringUp);
    expect(creator, 'the creator does not pass the ceiling to the fee payer')
      .toMatch(/(fundedPartiesOver|feePayerOver)\([\s\S]*?\bceiling,\s*\)/);
  });

  /* RED WHEN: the creator goes back to building its own fee payer and company half, two constructions of one pair. */
  it('builds its pair the same way the launcher does', () => {
    expect(creator).toMatch(/const \{ sponsor, customer \} = fundedPartiesOver\(/);
    expect(creator).not.toMatch(/new WalletFeeSponsor|customerWalletOver|sponsorWalletOver/);
  });

  /* RED WHEN: the creator reaches a wallet or a network before it has asked whether it has what it waits for. */
  it('stands down before it reads anything, when the network or the funded seed is missing', () => {
    const standDown = creator.indexOf('standDownWhenMissing(');
    expect(standDown).toBeGreaterThan(-1);
    expect(standDown).toBeLessThan(creator.indexOf('const NETWORK = theNetwork()'));
  });
});

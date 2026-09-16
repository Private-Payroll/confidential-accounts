/**
 * **THE FEE PAYER'S PROCESS REFUSES TO START ON ANYTHING IT CAN KNOW BEFORE A
 * WALLET IS BROUGHT UP, AND IT NAMES ALL OF IT AT ONCE.**
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  feePayerSetupFrom, FEE_PAYER_PORT_SETTING, FEE_PAYER_SEED_SETTING, FEE_PAYER_HOST,
} from './serve-fee-payer-rules.js';
import { FEE_CEILING_SETTING } from '../src/midnight/fee-ceiling.js';
import { FEE_PAYER_SECRET_SETTING } from '../src/fee-payer/client.js';

const ROOT = '/deployment';
const good = {
  [FEE_PAYER_SEED_SETTING]: '/deployment/fee-payer.seed',
  [FEE_PAYER_PORT_SETTING]: '6310',
  [FEE_PAYER_SECRET_SETTING]: 'not-a-secret: a test literal of enough length',
  [FEE_CEILING_SETTING]: '20000',
};
const everywhere = () => true;

describe('what the fee payer needs before it brings a wallet up', () => {
  /* RED WHEN: any setting is dropped from the setup. */
  it('starts with the settings it needs', () => {
    expect(feePayerSetupFrom(good, ROOT, everywhere)).toEqual({
      port: 6310,
      seedFile: '/deployment/fee-payer.seed',
      secret: good[FEE_PAYER_SECRET_SETTING],
      ceiling: { perTransaction: 20_000n },
    });
  });

  /* RED WHEN: the named seed file is not the one used, so the wallet that pays cannot be swapped. */
  it('pays from the seed its settings name', () => {
    const s = feePayerSetupFrom({ ...good, [FEE_PAYER_SEED_SETTING]: '/elsewhere/payer.seed' }, ROOT, everywhere);
    expect((s as { seedFile: string }).seedFile).toBe('/elsewhere/payer.seed');
  });

  /* RED WHEN: a named seed file that is not there is accepted. */
  it('refuses a seed file that is not there', () => {
    const s = feePayerSetupFrom(good, ROOT, () => false);
    expect('refusals' in s, 'a fee payer started without its seed').toBe(true);
    expect((s as { refusals: string[] }).refusals.join()).toMatch(/no seed for the wallet that pays/);
  });

  /*
   * RED WHEN: the seed gets a default - the obvious one is the seed the other
   * doors on this machine pay from, which would put two processes on one wallet.
   */
  it('has no default seed', () => {
    const { [FEE_PAYER_SEED_SETTING]: _unset, ...rest } = good;
    const s = feePayerSetupFrom(rest, ROOT, everywhere);
    expect('refusals' in s, 'a fee payer started with a seed nobody named').toBe(true);
    expect((s as { refusals: string[] }).refusals.join()).toMatch(new RegExp(`${FEE_PAYER_SEED_SETTING} is not set`));
    expect(join(ROOT, '.midnight', 'wallet.seed')).not.toBe((s as any).seedFile);
  });

  /* RED WHEN: the refusals stop at the first, or any one of the four checks is removed. */
  it('names everything missing in one go', () => {
    const s = feePayerSetupFrom({}, ROOT, () => false) as { refusals: string[] };
    expect(s.refusals).toHaveLength(4);
    expect(s.refusals.join('\n')).toContain(FEE_PAYER_PORT_SETTING);
    expect(s.refusals.join('\n')).toContain(FEE_PAYER_SECRET_SETTING);
    expect(s.refusals.join('\n')).toContain(FEE_PAYER_SEED_SETTING);
    expect(s.refusals.join('\n')).toContain(FEE_CEILING_SETTING);
  });

  /* RED WHEN: the port or secret checks are loosened. */
  it('refuses a port that is not one and a secret that is too short', () => {
    for (const port of ['0', '65536', 'http', '-1', '', '1e3', '0x10', '80.5']) {
      const s = feePayerSetupFrom({ ...good, [FEE_PAYER_PORT_SETTING]: port }, ROOT, everywhere);
      expect('refusals' in s, port).toBe(true);
    }
    const s = feePayerSetupFrom({ ...good, [FEE_PAYER_SECRET_SETTING]: 'x'.repeat(31) }, ROOT, everywhere);
    expect('refusals' in s, 'a 31-character secret was accepted').toBe(true);
    expect((s as { refusals: string[] }).refusals.join()).toMatch(/too short/);
  });

  /* RED WHEN: the refusal prints the secret it refused. */
  it('never prints the secret', () => {
    const secret = 'short-but-secret';
    const s = feePayerSetupFrom({ ...good, [FEE_PAYER_SECRET_SETTING]: secret }, ROOT, everywhere);
    expect('refusals' in s, 'a short secret was accepted').toBe(true);
    expect((s as { refusals: string[] }).refusals.join()).not.toContain(secret);
  });
});

describe('the process itself, read rather than run', () => {
  const text = readFileSync(join(import.meta.dirname, 'serve-fee-payer.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /* RED WHEN: the service is served on anything but loopback. */
  it('listens on loopback only', () => {
    expect(FEE_PAYER_HOST).toBe('127.0.0.1');
    expect(text).toMatch(/\.listen\(\s*setup\.port\s*,\s*FEE_PAYER_HOST\b/);
    expect(text.match(/\.listen\(/g)).toHaveLength(1);
  });

  /* RED WHEN: a wallet is brought up before the settings are checked. */
  it('checks its settings before it brings a wallet up', () => {
    const check = text.indexOf('feePayerSetupFrom(');
    const bringUp = text.indexOf('bringUpWallet(');
    expect(check).toBeGreaterThan(-1);
    expect(bringUp).toBeGreaterThan(check);
  });

  /* RED WHEN: the fee payer is built some way other than the shared construction, which carries the ceiling. */
  it('builds each payment\'s fee payer through the shared construction, with the ceiling', () => {
    expect(text).toMatch(/feePayerOver\([\s\S]*?setup\.ceiling\s*,?\s*\)/);
    expect(text).not.toMatch(/new WalletFeeSponsor/);
  });
});

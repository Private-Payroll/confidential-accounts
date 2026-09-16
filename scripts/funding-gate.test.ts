import { describe, it, expect } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { keysThisMachineHolds, refusalToFund } from './funding-gate.js';

/*
 * The operator tools' funding gate: who holds a vault's rules is read from the
 * chain, and the state folder says only which keys this machine keeps.
 */
const sk = (n: number) => L.signingKeyFromBip340(new Uint8Array(32).fill(n));
const vk = (n: number) => L.signatureVerifyingKey(sk(n));
const files = (by: Record<string, unknown>) => (path: string) => {
  for (const [end, body] of Object.entries(by)) if (path.endsWith(end)) return JSON.stringify(body);
  return null;
};
const derive = (k: { tag: string; value: string }) => L.signatureVerifyingKey(k as never);
const chainWith = (authority: unknown) => async () => ({ maintenanceAuthority: authority });

describe('THE KEYS THIS MACHINE KEEPS', () => {
  it('are the vault\'s single key and the account\'s, when the files hold one', () => {
    const held = keysThisMachineHolds('/r', '/r/.midnight', 'payroll', derive, files({
      'vault-authority-payroll.json': { kind: 'single-key', signingKey: sk(1), temporary: { fixedBy: 'x' } },
      'maintenance-authority.json': { kind: 'single-key', signingKey: sk(2), temporary: { fixedBy: 'x' } },
    }));
    expect(held).toEqual([vk(1), vk(2)]);
  });

  it('are none when the files are absent, unreadable or say a committee', () => {
    expect(keysThisMachineHolds('/r', '/r/.midnight', 'payroll', derive, () => null)).toEqual([]);
    expect(keysThisMachineHolds('/r', '/r/.midnight', 'payroll', derive, () => 'not json')).toEqual([]);
    expect(keysThisMachineHolds('/r', '/r/.midnight', 'payroll', derive, files({
      'vault-authority-payroll.json': { kind: 'committee', committee: [vk(1)], threshold: 1 },
    }))).toEqual([]);
  });
});

describe('WHETHER A DOOR FUNDS A VAULT', () => {
  const vault = 'ab'.repeat(32);
  it('REFUSES A VAULT THE CHAIN SAYS IS HELD BY ONE KEY - WHICHEVER KEY, AND WHATEVER THE FILES SAY', async () => {
    expect(await refusalToFund({ vault, vaultName: 'payroll', readState: chainWith({ committee: [vk(5)], threshold: 1, counter: 0n }), held: [] }))
      .toMatch(/still held by a single key/);
  });

  it('REFUSES A COMMITTEE WITH A KEY THIS MACHINE KEEPS, AND A CHAIN THAT CANNOT BE ASKED', async () => {
    expect(await refusalToFund({ vault, vaultName: 'payroll', readState: chainWith({ committee: [vk(1), vk(3)], threshold: 2, counter: 1n }), held: [vk(1)] }))
      .toMatch(/a key this machine keeps/);
    expect(await refusalToFund({ vault, vaultName: 'payroll', readState: async () => { throw new Error('down'); }, held: [] }))
      .toMatch(/could not be asked/);
    expect(await refusalToFund({ vault, vaultName: 'payroll', readState: async () => null, held: [] }))
      .toMatch(/could not be asked/);
  });

  it('funds a vault the chain says a committee holds that this machine has no key of', async () => {
    expect(await refusalToFund({ vault, vaultName: 'payroll', readState: chainWith({ committee: [vk(3), vk(4)], threshold: 2, counter: 1n }), held: [vk(1)] }))
      .toBeNull();
  });
});

describe('BOTH FUNDING DOORS ASK BEFORE THEY DEPOSIT', () => {
  it('reads the chain and stops on a refusal, before the deposit call', async () => {
    const { readFileSync } = await import('node:fs');
    for (const [door, call] of [['fund-vault.ts', 'ledger.depositUnshielded('], ['deposit-to-vault.ts', 'ledger.deposit(']] as const) {
      const text = readFileSync(new URL(`./${door}`, import.meta.url), 'utf8');
      const asked = text.indexOf('await refusalToFund({');
      const stopped = text.indexOf('if (refusal !== null) throw new Error(refusal);', asked);
      const deposited = text.indexOf(call);
      expect(asked, door).toBeGreaterThan(-1);
      expect(stopped, door).toBeGreaterThan(asked);
      expect(deposited, door).toBeGreaterThan(stopped);
      expect(text.slice(asked, stopped)).toContain('providers.publicDataProvider.queryContractState');
    }
  });
});

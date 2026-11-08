import { describe, expect, it, vi } from 'vitest';
import { approverRosterFrom, vaultsLeftShort } from '../../../src/core/vault-approvers.js';
import type { Hex } from '../../../src/core/crypto.js';

/*
 * **A REMOVAL'S APPROVERS ARE COUNTED AT THE BANDS OF THE SPENDING POLICIES IN FORCE**, by the one count the wallet's
 * early check and the device's check before each send both make (`removalApproversHere`). The policies' read is stood
 * in, so what it hands the count can be chosen.
 */

const t = vi.hoisted(() => ({ bands: [] as { vault: string; band: number }[], asked: [] as unknown[] }));
vi.mock('./spending-policy-here.js', async (real) => ({
  ...(await real<typeof import('./spending-policy-here.js')>()),
  bandsInForceHere: async (here: unknown, o: unknown) => { t.asked.push(o); return t.bands; },
}));

const { removalApproversHere } = await import('./removal-approvers-here.js');

const VAULT = 'ab'.repeat(32) as Hex;
const WIDE = 'cc'.repeat(32) as Hex;
const SEATS = ['a1', 'a2', 'a3'].map((x) => x.repeat(32));
const roster = () => approverRosterFrom({
  threshold: 1, vaultThresholds: [], seated: SEATS.map((leaf) => ({ leaf })), adoptedVaults: [VAULT], companyWide: WIDE,
} as never);
const doors = (policies: boolean) => ({
  approvers: async () => roster(), accountId: 'acc_1', records: (policies ? { spendingPolicies: {} } : {}) as never,
});

describe('A REMOVAL COUNTS EACH VAULT\'S APPROVERS AT THE HIGHEST BAND IN FORCE ON IT', () => {
  it('a vault whose policy asks for every signer is left short by any removal; with no policy it is not', async () => {
    const removal = { kind: 'remove', leaf: SEATS[2]! } as never;
    expect(vaultsLeftShort(await removalApproversHere(doors(true), {} as never), removal)).toEqual([]);
    t.bands = [{ vault: VAULT.toUpperCase(), band: 2 }, { vault: VAULT, band: 3 }];
    /* RED WHEN: the count leaves out the bands in force. */
    expect(vaultsLeftShort(await removalApproversHere(doors(true), {} as never), removal).length).toBeGreaterThan(0);
    /* RED WHEN: the band kept for a vault is the last one handed in, not the highest: the same two bands the other way round, and the vault named in either case. */
    t.bands = [{ vault: VAULT, band: 3 }, { vault: VAULT.toUpperCase(), band: 2 }];
    expect(vaultsLeftShort(await removalApproversHere(doors(true), {} as never), removal).length).toBeGreaterThan(0);
    /* RED WHEN: a policy in force this device cannot open is left out of the count rather than refused. */
    expect(t.asked.every((o) => (o as { strict?: boolean }).strict === true)).toBe(true);
  });

  it('a page that cannot read the spending policies is refused, never counted as having none', async () => {
    /* RED WHEN: a removal is counted with no bands because the policies were not read. */
    await expect(removalApproversHere(doors(false), {} as never)).rejects.toThrow(/cannot read the company's spending policies/);
  });
});

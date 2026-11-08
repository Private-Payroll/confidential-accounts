import { describe, expect, it, vi } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';

/*
 * **WHO IS LEAVING THE COMPANY IS READ STRICTLY BY THE WALLET'S SEAT ACTIONS.** The company key's change and each vault
 * secret's change after a removal ask the same read (`rotationDoorsIn`'s `leaving`): a removal proposal open on the chain
 * that this wallet cannot open stops that read, so a new key or a new secret is never sealed to a seat whose removal this
 * wallet could not see. The listing and the opening of the company's proposals stand in here; the read is the wallet's own.
 */

const t = vi.hoisted(() => ({ opens: 'fails' as 'fails' | 'not-a-removal' }));
vi.mock('../../../../packages/web-shared/src/vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vault-page-doors.js')>()),
  listedHere: (_dir: unknown, _kind: unknown, served: unknown) => served,
}));
vi.mock('../../../../packages/web-shared/src/run-rebuilt-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/run-rebuilt-here.js')>()),
  standingOnChainHere: async (_records: unknown, listed: unknown) => listed,
}));
vi.mock('../../../../packages/web-shared/src/round-opened-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/round-opened-here.js')>()),
  openTheRoundHere: async () => {
    if (t.opens === 'fails') throw new Error('this proposal is sealed under a company key this wallet does not hold');
    return { governance: { kind: 'add-signer' } };
  },
}));

const { rotationDoorsIn } = await import('./upkeep.js');

const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const reach = () => ({
  accountId: 'acc_1', label: drawCompanyLabel(), account: 'c0'.repeat(32), sealed: { id: 'acc_1' },
  seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32) },
  judges: {
    keysFoundFor: async () => KEYS,
    directoryHereFor: () => async () => ({ dir: { seats: [] }, holders: { seats: [] }, records: { history: new Map(), notYetAnchored: [] } }),
    leavesFor: () => async () => [],
    anchorsOnChainFor: () => async () => ({ landed: [] }),
    vouchingFor: () => ({}),
    tagSeatsFor: () => async () => new Map(),
  },
  roster: async () => null,
  builder: { roundsOnChain: async () => ({}) },
  chain: { indexer: {} },
}) as never;
const api = async (path: string) => (path === '/api/accounts/acc_1/proposals' ? [{ id: 'prp_9', accountId: 'acc_1', status: 'open' }] : null);

describe('A REMOVAL THIS WALLET CANNOT OPEN STOPS THE READ OF WHO IS LEAVING', () => {
  it('an open proposal this wallet cannot open stops the read, never read as nobody leaving; one that opens as another kind is passed over', async () => {
    const doors = await rotationDoorsIn(reach(), api as never);
    /* RED WHEN: a removal this wallet cannot open is read as nobody leaving, so a new key or vault secret is sealed to the seat leaving. */
    await expect(doors.leaving()).rejects.toThrow(/did not open on this device/);
    /* RED WHEN: the stop does not name the proposal that holds it up, or does not say only the signer who raised it can withdraw it. */
    await expect(doors.leaving()).rejects.toThrow(/proposal prp_9 did not open on this device \(this proposal is sealed under a company key this wallet does not hold\)\. Its kind could not be read/u);
    t.opens = 'not-a-removal';
    expect([...await doors.leaving()]).toEqual([]);
  });
});

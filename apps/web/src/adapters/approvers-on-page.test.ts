// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EVERY_RIGHT } from '../../../../src/core/vault-approvers.js';
import { invitedSeatRightsOf, scopeOfRole } from '../../../../src/core/seat-rights.js';
import type { SeatRights } from '../../../../src/core/vault-approvers.js';

/*
 * THE PAGE REFUSES THE INVITATION THE WALLET REFUSES: the same check over the same count, from what the page reads with its
 * own read key and its own wallet. Each read is stood in for here; the check and the count are the real ones.
 */
const PAYROLL = 'aa'.repeat(32);
const TREASURY = 'bb'.repeat(32);
const WIDE = 'cc'.repeat(32);
const SEATS = ['e1', 'e2'];
const read = vi.hoisted(() => ({
  keys: { signingPublicKey: 'ab'.repeat(32) } as { signingPublicKey: string } | null,
  notBelieved: [] as string[], seats: ['e1', 'e2'], approvals: 1, rights: [] as Array<{ seat: string; retired: null; rights?: unknown }>,
  adopted: [] as string[], holdersFail: false, checkFault: false,
}));
vi.mock('../../../../src/core/vault-approvers.js', async (real) => {
  const actual = await real<typeof import('../../../../src/core/vault-approvers.js')>();
  return {
    ...actual,
    seatThresholdRefusal: (...args: Parameters<typeof actual.seatThresholdRefusal>) => {
      if (read.checkFault) throw new Error('a fault in the check');
      return actual.seatThresholdRefusal(...args);
    },
  };
});
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  api: async () => ({ companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) }),
  holdersFromTheWallet: async () => {
    if (read.holdersFail) throw new Error('the wallet did not answer');
    return { holders: { seats: read.seats, approvals: read.approvals, vaultThresholds: [], adoptedVaults: read.adopted }, indexer: null };
  },
}));
vi.mock('./keyring-person.js', () => ({ keysOnTheWayIn: async () => read.keys }));
vi.mock('./vault-builder.js', () => ({ theVaultBuilder: async () => ({ companyWide: async () => WIDE }) }));
vi.mock('./filing-judge.js', () => ({
  openedQuietly: async () => ({
    id: 'acc_1', name: 'Acme', notBelieved: read.notBelieved,
    signers: SEATS.map((leaf, i) => ({ id: `s${i}`, status: 'active', leafCommitment: leaf })),
  }),
  companyKeysQuietlyFor: async () => ({}),
  directoryHereFor: () => async () => ({ dir: { seats: read.rights } }),
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./approvers-on-page.js');
}
const believe = (...rights: Array<SeatRights | undefined>): void => {
  read.rights = rights.flatMap((r, i) => (r === undefined ? [] : [{ seat: SEATS[i]!, retired: null as null, rights: r }]));
};
const reset = (): void => {
  Object.assign(read, { keys: { signingPublicKey: 'ab'.repeat(32) }, notBelieved: [], seats: ['e1', 'e2'], approvals: 1, adopted: [PAYROLL, TREASURY], holdersFail: false, checkFault: false });
  believe(EVERY_RIGHT, EVERY_RIGHT);
};

describe('an invitation\'s threshold is checked on the page as the wallet checks it', () => {
  /* RED WHEN: the page lets through an invitation whose new threshold leaves a vault with fewer approvers than its runs need, which the wallet refuses. */
  it('refuses a threshold an initiator cannot meet, naming each vault it leaves short', async () => {
    reset();
    const m = await load();
    const said = await m.seatThresholdRefusedOnThePage('acc_1', { role: 'initiator', threshold: 3 });
    expect(said).toMatch(/^This change would leave vaults unable to pay: /u);
    for (const vault of [PAYROLL, TREASURY, WIDE]) expect(said).toContain(vault);
    expect(said).toMatch(/\(its runs need 3 approvals and 2 signers could give them\)/u);
  });

  /* RED WHEN: the new seat is counted as approving where its role gives it no right, so an invitation the wallet refuses is let through on the page. */
  it('counts the new seat on the vaults its role reaches: an approver meets the threshold an initiator cannot', async () => {
    reset();
    const m = await load();
    expect(await m.seatThresholdRefusedOnThePage('acc_1', { role: 'approver', threshold: 3 })).toBeNull();
    expect(await m.seatThresholdRefusedOnThePage('acc_1', { role: 'initiator', threshold: 2 })).toBeNull();
    expect(await m.seatThresholdRefusedOnThePage('acc_1', { role: 'initiator', threshold: 3 })).not.toBeNull();
  });

  /* RED WHEN: each seat's rights are not read from the directory the page believes, so a seat scoped to one vault is counted on all. */
  it('counts a seat scoped to one vault on that vault only', async () => {
    reset();
    believe(EVERY_RIGHT, invitedSeatRightsOf({ role: 'approver', vaults: [PAYROLL as never] }, scopeOfRole('approver', [PAYROLL as never])));
    const m = await load();
    const said = (await m.seatThresholdRefusedOnThePage('acc_1', { role: 'initiator', threshold: 3 }))!;
    expect(said).toContain(`${PAYROLL} (its runs need 3 approvals and 2 signers could give them)`);
    expect(said).toContain(`${TREASURY} (its runs need 3 approvals and 1 signer could give them)`);
  });

  /* RED WHEN: a seat whose directory entry the page does not believe is counted as approving everywhere. */
  it('counts a seat with no believed entry on no vault', async () => {
    reset();
    believe(EVERY_RIGHT, undefined);
    const m = await load();
    expect(await m.seatThresholdRefusedOnThePage('acc_1', { role: 'approver', threshold: 3 })).toMatch(/\(its runs need 3 approvals and 2 signers could give them\)/u);
  });

  /* RED WHEN: a page that cannot read what the count needs refuses the invitation on a guess, or stops with an error instead of leaving it to the wallet. */
  it('refuses nothing when it cannot read the keys, the roster, the chain or a seat\'s name, and leaves it to the wallet', async () => {
    const m = await load();
    reset(); read.keys = null;
    expect(await m.seatThresholdRefusedOnThePage('acc_1', { role: 'initiator', threshold: 3 })).toBeNull();
    reset(); read.notBelieved = ['x'];
    expect(await m.seatThresholdRefusedOnThePage('acc_1', { role: 'initiator', threshold: 3 })).toBeNull();
    reset(); read.holdersFail = true;
    expect(await m.seatThresholdRefusedOnThePage('acc_1', { role: 'initiator', threshold: 3 })).toBeNull();
  });

  /* RED WHEN: a fault in the page's own check is passed over as a read it could not make, so the page silently refuses nothing. */
  it('lets a fault in the check itself surface: only the reads are passed over', async () => {
    reset(); read.checkFault = true;
    const m = await load();
    await expect(m.seatThresholdRefusedOnThePage('acc_1', { role: 'initiator', threshold: 3 })).rejects.toThrow(/a fault in the check/u);
  });

  /* RED WHEN: the page and the wallet, given the same roster, directory and chain, refuse an invitation in different sentences. */
  it('refuses in the sentence the wallet refuses in, from the same roster, directory and chain', async () => {
    reset();
    believe(EVERY_RIGHT, invitedSeatRightsOf({ role: 'approver', vaults: [PAYROLL as never] }, scopeOfRole('approver', [PAYROLL as never])));
    const m = await load();
    const page = await m.seatThresholdRefusedOnThePage('acc_1', { role: 'initiator', threshold: 3 });
    /* The wallet's own check, from the wallet's source: named by a path the page's typecheck does not follow, since it builds the page alone. */
    const walletCheck = '../../../wallet/src/actions/invite.js';
    const { refuseASeatThresholdInTheWallet } = await import(/* @vite-ignore */ walletCheck) as {
      refuseASeatThresholdInTheWallet: (r: unknown, rights: SeatRights, threshold: number) => Promise<void>;
    };
    const reach = {
      accountId: 'acc_1', label: 'label-1', account: 'c0'.repeat(32), companyKeys: {}, chain: { indexer: null },
      roster: async () => ({ id: 'acc_1', name: 'Acme', notBelieved: [], signers: SEATS.map((leaf, i) => ({ id: `s${i}`, status: 'active', leafCommitment: leaf })) }),
      holders: async () => ({ seats: read.seats, approvals: read.approvals, vaultThresholds: [], adoptedVaults: read.adopted }),
      builder: { companyWide: async () => WIDE, runsOutrun: async () => ({}) },
      judges: { directoryHereFor: () => async () => ({ dir: { seats: read.rights } }) },
    };
    const rights = invitedSeatRightsOf({ role: 'initiator' }, scopeOfRole('initiator'));
    const wallet = await refuseASeatThresholdInTheWallet(reach, rights, 3).then(() => null, (e: { words?: { values?: { says?: unknown } } }) => e.words?.values?.says);
    expect(page).not.toBeNull();
    expect(wallet).toBe(page);
  });
});

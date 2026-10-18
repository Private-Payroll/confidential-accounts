/**
 * **A NEW VAULT'S TWO PROPOSALS, AS EVERY SIGNER'S DEVICE OPENS THEM.** The
 * adoption and the first secret run are written down by the device setting the
 * vault up (`createCompanyVault`, pinned in `vault-operation.test.ts`); here,
 * what every device makes of those records afterwards: each opens as a
 * proposal setting up a vault, acted on only from that vault, never as a change
 * a page approves from the company's proposals.
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from '../../../src/core/crypto.js';
import { NO_ASSET } from '../../../src/core/assets.js';
import { sealGovernanceProposal, sealVaultSecretProposal, signProposalFiling } from '../../../src/core/proposal-filing.js';
import type { SealedProposal } from '../../../src/core/types.js';
import { NotOpenedOnThisDevice, openTheRoundHere } from './round-opened-here.js';
import type { GovernedCallService } from './governed-call-on-device.js';

const COMPANY = 'acc_1';
const KEY = '44'.repeat(32) as Hex;
const VAULT = 'ab'.repeat(32) as Hex;
const change = { asset: NO_ASSET, amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: 'a4'.repeat(32) as Hex };

const filed = (id: string, sealed: SealedProposal['sealed']): SealedProposal => {
  const f = signProposalFiling(COMPANY, {
    id, digest: 'a2'.repeat(32) as Hex, chainId: 'a1'.repeat(32) as Hex, keyEpoch: 0, createdAt: new Date(0).toISOString(), sealed,
  }, '11'.repeat(32) as Hex);
  return { ...f, accountId: COMPANY, status: 'open', approvalCount: 0 };
};

const ADOPTION = filed('prp_adoptionAAAA', sealGovernanceProposal({
  accountId: COMPANY, viewingKey: KEY, kind: 'adopt-vault', summary: 'Add a new vault to the company', noVault: 'a3'.repeat(32) as Hex,
  body: { vault: VAULT }, change, proposedBy: 'ada',
}));
const FIRST_SECRET = filed('prp_firstsecretA', sealVaultSecretProposal({
  accountId: COMPANY, viewingKey: KEY, summary: 'Finish setting up a new vault',
  run: { vault: VAULT, root: 'b5'.repeat(32) as Hex, payees: '1', opensAt: '1', closesAt: '2' }, change, proposedBy: 'ada',
}));

const service = { sealedProposals: async () => [ADOPTION, FIRST_SECRET] } as unknown as GovernedCallService;

describe('A NEW VAULT\'S TWO PROPOSALS, AS EVERY DEVICE OPENS THEM', () => {
  it('a vault\'s setup proposals open on any device as setting up a vault, never as a change approved there', async () => {
    for (const [rec, kind] of [[ADOPTION, 'adopt-vault'], [FIRST_SECRET, 'vault-secret']] as const) {
      const e = await openTheRoundHere(service, COMPANY, rec.id, KEY, false).catch((x: unknown) => x);
      /* RED WHEN: either kind opens as a governance change, or is refused as a kind no device knows. */
      expect(e).toBeInstanceOf(NotOpenedOnThisDevice);
      expect((e as NotOpenedOnThisDevice).kind).toBe(kind);
      expect((e as Error).message).toMatch(/sets up one of the company's vaults, and it is raised and approved only from setting that vault up/);
    }
  });
});

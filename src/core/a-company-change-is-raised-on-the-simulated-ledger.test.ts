/**
 * The simulated ledger raises a change to the company as the account's `proposeCompanyChange` circuit does: the id
 * `propose` gives the same payload, salt and no vault; no run window; a fixed mark stored where `propose` stores its
 * change commitment; the raiser's approval counted; and an id already open refused. An approval given stays spent
 * across the proposal's close, as the contract's approval set keeps it.
 */
import { describe, it, expect } from 'vitest';
import {
  SimulatedLedger, SimulatedCommitments, SIMULATED_COMPANY_CHANGE_MARK, type StateChange, type SignerRef,
} from './ledger.js';
import { toHex, randomBytes, type Hex } from './crypto.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';

const change = (): StateChange => ({
  asset: 'GBP', amount: 0n, batchDigest: toHex(randomBytes(32)), salt: toHex(randomBytes(32)),
});

const aSigner = (n: number): SignerRef => ({
  signerId: `sig_${n}`,
  leaf: SimulatedCommitments.signerLeaf(
    SimulatedCommitments.signerPublicKey(toHex(randomBytes(32))), toHex(randomBytes(32))),
});

/** An account on the simulated ledger with `seats` seats and a threshold of `threshold`; `by` is the first seat. */
const anAccount = async (seats = 1, threshold = 1) => {
  const ledger = new SimulatedLedger(SimulatedCommitments);
  const signers = Array.from({ length: seats }, (_, i) => aSigner(i + 1));
  await ledger.open('acct', {
    signerLeaves: signers.map((s) => s.leaf),
    threshold,
    assetBlinding: toHex(randomBytes(32)),
    sealedState: { keyEpoch: 0, sealed: { iv: '', ct: '', tag: '' } as never },
  });
  return { ledger, by: signers[0]!, signers };
};

const openOf = async (ledger: SimulatedLedger, id: Hex) =>
  (await ledger.status('acct'))!.openProposals.find((p) => p.id === id);

describe('a change to the company raised on the simulated ledger', () => {
  it('RED WHEN: it opens another id than `propose` gives, writes a run window, stores the change commitment, or does not count its raiser', async () => {
    const { ledger, by } = await anAccount();
    const payload = toHex(randomBytes(32));
    const c = change();
    await ledger.proposeCompanyChange('acct', payload, c.salt, by);
    const id = SimulatedCommitments.proposalId(payload, c.salt, SimulatedCommitments.noVault());
    const open = await openOf(ledger, id);
    expect(open).toBeDefined();
    expect(open!.approvals).toBe(1);
    expect(open!.change).toBe(SIMULATED_COMPANY_CHANGE_MARK);
    expect(ledger.runWindowOf('acct', id)).toBeUndefined();

    /* The same payload and salt through `propose` is the same id, with its change commitment beside it instead. */
    const { ledger: other, by: raiser } = await anAccount();
    await other.propose('acct', payload, c, raiser, SimulatedCommitments.noVault());
    expect((await openOf(other, id))).toBeDefined();
    expect(open!.change).not.toBe((await openOf(other, id))!.change);
  });

  it('RED WHEN: a company change already open is raised again', async () => {
    const { ledger, by } = await anAccount();
    const payload = toHex(randomBytes(32));
    const salt = toHex(randomBytes(32));
    await ledger.proposeCompanyChange('acct', payload, salt, by);
    await expect(ledger.proposeCompanyChange('acct', payload, salt, by)).rejects.toThrow(/that proposal is already open/);
  });

  it('RED WHEN: the simulated mark is not the bytes the contract stores beside a company change', () => {
    expect(SIMULATED_COMPANY_CHANGE_MARK).toBe(toHex(pureCircuits.companyChangeMark()));
  });

  it('RED WHEN: a signer who approved a withdrawn proposal can approve it again once it is raised again with the same salt', async () => {
    const { ledger, signers } = await anAccount(3, 2);
    const [a, b] = signers as [SignerRef, SignerRef];
    const payload = toHex(randomBytes(32));
    const salt = toHex(randomBytes(32));
    const id = SimulatedCommitments.proposalId(payload, salt, SimulatedCommitments.noVault());
    await ledger.proposeCompanyChange('acct', payload, salt, a);
    await ledger.approve('acct', id, b);
    await ledger.cancel('acct', id, a);
    await ledger.proposeCompanyChange('acct', payload, salt, a);
    /* The raiser is counted once more, as the contract counts them; the earlier approver's mark is still spent. */
    expect((await openOf(ledger, id))!.approvals).toBe(1);
    await expect(ledger.approve('acct', id, b)).rejects.toThrow(/you have already approved this proposal/);
    await ledger.approve('acct', id, signers[2]!);
    expect((await openOf(ledger, id))!.approvals).toBe(2);
  });
});

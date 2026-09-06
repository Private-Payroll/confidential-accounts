/**
 * **THE `Ledger` BOUNDARY CAN RAISE A PAYROLL RUN, AND A RUN IS NOT A
 * GOVERNANCE ROUND WITH A DIFFERENT NAME.** `C375`, `T-213`, board row
 * `2y7d4`.
 *
 * **WHY THIS FILE EXISTS BESIDE `contracts/test/the-payroll-run-meets-the-chain.test.ts`
 * RATHER THAN INSTEAD OF IT.** That file is the one that matters: it drives the
 * SERVICE's own id into the compiled circuits and pays against it, which is the
 * only place the question *would a vault accept this* can be put. **A green run
 * through `SimulatedLedger` is not evidence of that and this file does not
 * claim to be.** What it pins is the half the contract tests cannot see: that
 * the ledger the product actually runs on tells the two kinds of round apart,
 * and refuses the four ways a run can be built that nobody could ever pay.
 *
 * **AND IT EXISTS BECAUSE `runWindows` HAD NO READER.** `S47`'s own
 * money-safety pass measured that the window write could be deleted with
 * the whole suite staying green — so the distinction was held up by the comment
 * asserting it. Rule 27, and the reason `runWindowOf` was added.
 */
import { describe, it, expect } from 'vitest';
import {
  SimulatedLedger, SimulatedCommitments, type StateChange, type SignerRef, type RunProposal,
} from './ledger.js';
import { toHex, randomBytes, type Hex } from './crypto.js';

const ROOT: Hex = 'ab'.repeat(32);
const VAULT: Hex = 'a1'.repeat(32);
const OPENS = 1_800_000_000n;
const CLOSES = 1_800_604_800n;

const run = (over: Partial<RunProposal> = {}): RunProposal => ({
  root: ROOT, payees: 3n, opensAt: OPENS, closesAt: CLOSES, vault: VAULT, ...over,
});

const change = (): StateChange => ({
  asset: 'GBP', amount: 300_00n, batchDigest: toHex(randomBytes(32)), salt: toHex(randomBytes(32)),
});

/** An account on the ledger, with one seat and a threshold of one. */
const anAccount = async () => {
  const ledger = new SimulatedLedger(SimulatedCommitments);
  const signingSecret = toHex(randomBytes(32));
  const blinding = toHex(randomBytes(32));
  const leaf = SimulatedCommitments.signerLeaf(
    SimulatedCommitments.signerPublicKey(signingSecret), blinding);
  const by: SignerRef = { signerId: 'sig_1', leaf };
  await ledger.open('acct', {
    signerLeaves: [leaf],
    threshold: 1,
    assetBlinding: toHex(randomBytes(32)),
    sealedState: { keyEpoch: 0, sealed: { iv: '', ct: '', tag: '' } as never },
  });
  return { ledger, by };
};

describe('C375: the boundary raises a run, and a run carries a window', () => {
  it('THE DISTINCTION: a run gets a window row, a governance round gets none', async () => {
    const { ledger, by } = await anAccount();

    const c = change();
    const raised = await ledger.proposeRun('acct', run(), c, by);
    expect(ledger.runWindowOf('acct', raised.proposalId))
      .toEqual({ opensAt: OPENS, closesAt: CLOSES });

    /*
     * The same account, the same signer, the governance door. On chain the run
     * branch is the ONLY writer of `runWindow`
     * (`contracts/src/ConfidentialAccount.compact:2156`) and the governance
     * branch writes none at all — which is what `cancel` and `closeExpiredRun`
     * read, and what `C375` was the absence of at this layer.
     */
    const g = change();
    const payload = toHex(randomBytes(32));
    await ledger.propose('acct', payload, g, by, SimulatedCommitments.noVault());
    const governanceId = SimulatedCommitments.proposalId(
      payload, g.salt, SimulatedCommitments.noVault());
    expect(ledger.runWindowOf('acct', governanceId)).toBeUndefined();
  });

  it('the id is folded from the run payload, not from an opaque hash', async () => {
    const { ledger, by } = await anAccount();
    const c = change();
    const raised = await ledger.proposeRun('acct', run(), c, by);

    /*
     * Derived independently from the scheme, which is the whole of `C375`: the
     * id has to be one `recordPayment` can recompute from the run's four parts.
     * Under the governance door it was folded from an APPLICATION digest and
     * could not be.
     */
    expect(raised.proposalId).toBe(SimulatedCommitments.proposalId(
      SimulatedCommitments.runPayload(ROOT, 3n, OPENS, CLOSES), c.salt, VAULT));
  });

  it('the window comes off with the proposal when it is cancelled', async () => {
    const { ledger, by } = await anAccount();
    const raised = await ledger.proposeRun('acct', run(), change(), by);
    await ledger.cancel('acct', raised.proposalId, by);
    /* A window outliving its proposal answers "yes, a run" about an id that is
     * no longer open — `closeProposal` drops the contract's row at `:1338`. */
    expect(ledger.runWindowOf('acct', raised.proposalId)).toBeUndefined();
  });

  /**
   * **THE FOUR REFUSALS, AND EACH IS A RUN THAT WOULD HAVE BEEN APPROVED AND
   * THEN NEVER PAID.** Two mirror the contract's own asserts (`:2126`,
   * `:2127`); the millisecond ceiling and the vault sentinel have no contract
   * counterpart and are refused here anyway, because a guard one implementation
   * of this boundary has and the other does not is the permissive direction —
   * `T-215`'s species.
   */
  it.each([
    ['a run with no payees', { payees: 0n }, /at least one payee/],
    ['a backwards window', { opensAt: CLOSES, closesAt: OPENS }, /no payment could ever fall inside it/],
    ['a window in milliseconds', { closesAt: CLOSES * 1000n }, /not a time in seconds/],
    ['the no-vault sentinel', { vault: SimulatedCommitments.noVault() }, /must name the vault/],
  ])('refuses %s before anything is raised', async (_what, over, message) => {
    const { ledger, by } = await anAccount();
    await expect(ledger.proposeRun('acct', run(over), change(), by)).rejects.toThrow(message);
  });
});

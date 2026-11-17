import { describe, it, expect } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { SimulatedCommitments } from './ledger.js';
import { approvalMessage } from './account.js';
import { NO_ASSET } from './assets.js';
import { newWrappingKeypair, newSigningKeypair, commit, newProposalSalt } from './crypto.js';
import { sign } from './crypto.js';
import { TEST_TOKEN } from '../testing/assets.js';
import { present, harness, readableStore, LEAF, editAccount, THREE_SIGNERS } from '../testing/an-account-harness.js';

describe('removing a signer', () => {
  /*
   * Stopping a departing signer ACTING, on the chain double. Stopping them
   * reading what is filed after they leave is the devices' change of the
   * company's key (packages/web-shared/src/company-key-here.test.ts).
   *
   * Each signer holds a SLOT in the tree, and removing somebody clears that one
   * slot. Nobody else is touched, nothing is recomputed, and nobody is ever
   * identified: the removal proves membership exactly as approving a payment
   * does.
   */

  async function threeSigners() {
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE_SIGNERS, 2, undefined, drawCompanyLabel());
    return { h, c, ada: c.secrets[0], blake: c.secrets[1], cleo: c.secrets[2] };
  }

  /**
   * What a removal leaves, with the removal itself made on the chain double. The service no longer carries a removal
   * out (it is the devices', pinned in packages/web-shared/src/a-signer-is-removed-from-the-devices.test.ts): the
   * chain takes the leaf off the tree and the roster record drops the row; the company's key is changed on the devices,
   * not here.
   */
  async function carryOut(h: ReturnType<typeof harness>, c: any, p: { chainId: string }, leaving: number) {
    const account = h.accounts.open(c.account.id, c.viewingKey);
    const leaver = account.signers.find((s) => s.id === c.secrets[leaving].signerId)!;
    const by = { signerId: account.signers[0]!.id, leaf: account.signers[0]!.leafCommitment! };
    await h.ledger.removeSigner(c.account.id, leaver.leafCommitment!, p.chainId as never, by);
    const left = editAccount(h, c.account.id, c.viewingKey, (a) => { a.signers = a.signers.filter((s) => s.id !== leaver.id); });
    return { account: left, viewingKey: c.viewingKey as string, keyEpoch: 0 };
  }

  /**
   * Raises the removal of one signer on the chain double, from the first seat, and approves it from the seats named.
   * The service raises no removal: a removal is raised on the devices.
   */
  async function raiseRemoval(h: ReturnType<typeof harness>, c: any, leaving: number, approvers: readonly number[]) {
    const account = h.accounts.open(c.account.id, c.viewingKey);
    const ref = (i: number) => {
      const s = account.signers.find((x) => x.id === c.secrets[i].signerId)!;
      return { signerId: s.id, leaf: s.leafCommitment! };
    };
    const before = new Set((await h.ledger.status(c.account.id))!.openProposals.map((p) => p.id));
    await h.ledger.propose(
      c.account.id, SimulatedCommitments.signerRemovePayload(ref(leaving).leaf, 0),
      { asset: NO_ASSET, amount: 0n, batchDigest: commit('', ''), salt: newProposalSalt() }, ref(0),
      SimulatedCommitments.noVault());
    const round = (await h.ledger.status(c.account.id))!.openProposals.find((p) => !before.has(p.id))!;
    for (const i of approvers) await h.ledger.approve(c.account.id, round.id, ref(i));
    return { chainId: round.id as string };
  }

  /** Runs the whole round: raise, reach the threshold, remove. */
  async function removeCleo(h: ReturnType<typeof harness>, c: any) {
    return carryOut(h, c, await raiseRemoval(h, c, 2, [1]), 2);
  }

  it('the removed signer can no longer act on chain, which changing the locks alone could not do', async () => {
    const { h, c, cleo } = await threeSigners();
    expect((await h.accounts.ledgerStatus(c.account.id))!.signerCount).toBe(3);

    const out = await removeCleo(h, c);

    // One fewer seat on chain, and the chain and the roster agree about it.
    expect((await h.accounts.ledgerStatus(c.account.id))!.signerCount).toBe(2);
    expect(h.accounts.open(c.account.id, out.viewingKey).signers).toHaveLength(2);

    // THE POINT. Their old leaf is not in the tree any more, so the ledger
    // refuses them — without anyone having said which signer they are.
    await expect(h.accounts.propose({
      accountId: c.account.id, viewingKey: out.viewingKey, kind: 'transfer',
      summary: 'after removal', payload: { entries: [] }, asset: TEST_TOKEN,
      proposedBy: present(cleo).signerId,
    })).rejects.toThrow(/not a signer/);
  });

  it('the ledger refuses a removal that has not reached the threshold', async () => {
    const { h, c } = await threeSigners();
    const p = await raiseRemoval(h, c, 2, []);

    await expect(carryOut(h, c, p, 2)).rejects.toThrow(/approv/);
    // Nothing moved: they are still a signer on the chain and in the roster.
    expect((await h.accounts.ledgerStatus(c.account.id))!.signerCount).toBe(3);
    expect(h.accounts.open(c.account.id, c.viewingKey).signers).toHaveLength(3);
  });

  it('the ledger refuses a removal with no approved round at all', async () => {
    const { h, c } = await threeSigners();
    await expect(carryOut(h, c, { chainId: 'ab'.repeat(32) }, 2)).rejects.toThrow();
    expect((await h.accounts.ledgerStatus(c.account.id))!.signerCount).toBe(3);
  });

  it('a signer arriving between the proposal and the removal does not invalidate it', async () => {
    /*
     * Under the generation design the proposal digest covered the whole
     * survivor list, so anything that changed the signer set between proposing
     * and removing made the approved digest describe something that would no
     * longer happen — the proposal reached its threshold and was then refused by
     * the chain with the fee paid. The digest is one leaf now, so the only
     * thing that can invalidate it is a change to WHO is leaving.
     */
    const { h, c } = await threeSigners();
    const p = await raiseRemoval(h, c, 2, [1]);

    // Adding a signer between proposing and removing changes the survivor set,
    // so the approved digest no longer describes what would happen.
    const invite = h.accounts.inviteSigner(c.account.id, 'Devi', 'devi@acme.co', 'approver');
    const sk = newSigningKeypair(); const wk = newWrappingKeypair();
    const pending = h.accounts.acceptSignerInvite(
      invite.token, null, sk.publicKey, wk.publicKey, LEAF);
    expect(pending.status).toBe('pending');
    // Pending signers are not seated, so the set is unchanged and it still works.
    const out = await carryOut(h, c, p, 2);
    expect(out.account.signers.map(s => s.id)).not.toContain(present(c.secrets[2]).signerId);
    expect((await h.accounts.ledgerStatus(c.account.id))!.signerCount).toBe(2);
  });

  it('the LEDGER refuses the removed signer, not merely our own roster', async () => {
    /*
     * Added because a mutation survived, and it showed the headline test above
     * was passing for the wrong reason.
     *
     * `AccountService` refuses a removed signer because they are no longer in
     * its roster — which is our own bookkeeping, and worth nothing against
     * somebody who calls the chain directly. That is the entire threat: a
     * departing signer does not have to use our server.
     *
     * So this goes around the service and asks the ledger, holding exactly what
     * the removed signer still holds: their old leaf.
     */
    const { h, c, cleo } = await threeSigners();
    const oldLeaf = h.accounts.open(c.account.id, c.viewingKey)
      .signers.find(s => s.id === present(cleo).signerId)!.leafCommitment!;

    /*
     * A governance change moves no money, so its asset is the reserved `NONE`.
     * It derives a perfectly valid map key that can never appear in
     * `assetBalances`, because no governance circuit writes to the map — and
     * naming a real asset would be a lie in the ledger a client could read as
     * "this proposal concerns pounds".
     */
    const change = { asset: NO_ASSET, amount: 0n, batchDigest: 'bb'.repeat(32), salt: 'cc'.repeat(32) };

    // It works before the removal, so the test can fail for the right reason.
    await h.ledger.propose(
      c.account.id, 'aa'.repeat(32), change, { signerId: present(cleo).signerId, leaf: oldLeaf },
      SimulatedCommitments.noVault());
    // The id is read back from what the chain publishes rather than derived.
    const [opened] = (await h.ledger.status(c.account.id))!.openProposals;
    await h.ledger.cancel(c.account.id, present(opened).id, { signerId: present(cleo).signerId, leaf: oldLeaf });

    await removeCleo(h, c);

    await expect(h.ledger.propose(
      c.account.id, 'aa'.repeat(32), change, { signerId: present(cleo).signerId, leaf: oldLeaf },
      SimulatedCommitments.noVault(),
    )).rejects.toThrow(/not a signer/);
    // The signer check comes before the proposal lookup, so any id shows it.
    await expect(h.ledger.approve(
      c.account.id, present(opened).id, { signerId: present(cleo).signerId, leaf: oldLeaf },
    )).rejects.toThrow(/not a signer/);
  });

  it('a leaf never changes, so a survivor cannot be locked out by somebody else leaving',
    async () => {
      /*
       * The inverse of the test this replaces, and the reason the new design is
       * worth doing rather than only cheaper.
       *
       * A leaf used to be bound to the signer set's generation, so every
       * removal gave every remaining signer a NEW leaf that the account had to
       * recompute correctly for all of them. That computation was once wrong by
       * a domain tag, and its consequence was an account with money in it that
       * nobody — not the person removed, everybody — could act on.
       *
       * A leaf is now `commit(publicKey, blinding)` and never moves. There is
       * no recomputation, so there is no way for it to be wrong.
       */
      const { h, c, ada } = await threeSigners();
      const before = h.accounts.open(c.account.id, c.viewingKey)
        .signers.find(s => s.id === present(ada).signerId)!;
      const out = await removeCleo(h, c);
      const after = h.accounts.open(c.account.id, out.viewingKey)
        .signers.find(s => s.id === present(ada).signerId)!;

      expect(after.signingPublicKey).toBe(before.signingPublicKey);
      expect(after.leafCommitment).toBe(before.leafCommitment);

      // And it still works against the ledger, which is the claim that matters.
      await h.ledger.propose(
        c.account.id, 'aa'.repeat(32),
        { asset: NO_ASSET, amount: 0n, batchDigest: 'bb'.repeat(32), salt: 'cc'.repeat(32) },
        { signerId: present(ada).signerId, leaf: before.leafCommitment! },
        SimulatedCommitments.noVault(),
      );
      expect((await h.ledger.status(c.account.id))!.openProposals).toHaveLength(1);
    });

  it('the product cannot express a threshold the chain does not enforce', async () => {
    /*
     * The assertion this file used to make was that `setThreshold` DID NOT
     * EXIST. That was right while the contract's threshold was a `sealed`
     * ledger field with no circuit able to move it: the method wrote our own
     * copy and nothing else, so the product could tell a customer three
     * approvals were required while the chain settled at two — a lie in the
     * dangerous direction, claiming more safety than existed.
     *
     * The field is unsealed now and there is a circuit. So the property under
     * test is no longer "you cannot change it" but the one that always
     * mattered: **the product cannot hold a threshold the chain does not.**
     */
    const { h, c } = await threeSigners();
    const chainThreshold = (await h.accounts.ledgerStatus(c.account.id))!.threshold;
    expect(chainThreshold).toBe(2);
    expect(Object.keys(h.accounts.open(c.account.id, c.viewingKey).policy)).toEqual(['limitsByRole']);
    expect(Object.keys(h.accounts.require(c.account.id))).not.toContain('threshold');
    /*
     * A THIRD ASSERTION STOOD HERE — the same read again, after an operation
     * that rewrote the sealed account. The operation was `accounts.deposit`,
     * and it was deleted, so repeating the read would assert nothing that the
     * line above has not already asserted. Removed rather than left looking
     * like a second check.
     */
  });

  it('A ROUND SURVIVES ITS PROPOSER BEING REMOVED, AND THE NEXT APPROVAL DOES NOT THROW', async () => {
    /*
     * **THE SEQUENCE HAS NO FAILURE IN IT, WHICH IS WHY THIS IS A ROW AND NOT
     * AN EDGE CASE.** Cleo raises a round; Cleo is removed by a properly
     * governed round; Blake approves the one Cleo raised. Every step is an
     * ordinary governance action a screen offers.
     *
     * **WHAT IT USED TO DO.** `recordStanding` read `account.signers.find(s =>
     * s.id === proposal.proposedBy)!` — and `removeSigner` DELETES the row
     * rather than marking it, with nothing closing a removed proposer's
     * still-open rounds. So the lookup returned `undefined` and `.role` threw a
     * `TypeError`. **Making the approval durable before the reconcile runs
     * turned that from costly into permanent:** the approval is durable by the
     * time this runs, so the reconcile re-entered on Blake's every later call
     * and threw the same `TypeError` again — Blake never reached the honest
     * `already approved`, and the proposal could never reach `'approved'`.
     *
     * **THE ASSERTION IS THE ABSENCE OF A THROW, AND THEN THAT THE STANDING
     * WAS ACTUALLY RECORDED** — a `catch` that swallowed the failure would
     * satisfy the first and not the second.
     */
    const { h, c, blake, cleo } = await threeSigners();

    const raised = await h.accounts.propose({
      accountId: c.account.id, viewingKey: c.viewingKey, kind: 'transfer',
      summary: "Cleo's round", payload: { entries: [] }, asset: TEST_TOKEN,
      proposedBy: present(cleo).signerId,
    });

    /* The removal takes Cleo off the chain and the roster; the proposal
     * Cleo raised is still read with the company's key. */
    const out = await removeCleo(h, c);
    expect(h.accounts.open(c.account.id, out.viewingKey).signers
      .some(sg => sg.id === present(cleo).signerId)).toBe(false);

    await h.accounts.approve(
      raised.id, present(blake).signerId,
      sign(approvalMessage(raised), present(blake).signingSecret), out.viewingKey);

    const after = h.accounts.requireProposal(raised.id, out.viewingKey);
    expect(after.approvals.map(a => a.signerId)).toEqual([present(blake).signerId]);
    /* The standing was computed, not skipped: `recordStanding` is the only
     * writer of this field and it needed the proposer's role to get here. */
    expect(after.approvalRound).toBeDefined();

    /*
     * **AND THE RECONCILE IS NOT A PERMANENT REFUSAL ANY MORE.** Blake comes
     * back; the gate fires because his approval is on an `open` round; and he
     * is told the true thing rather than handed a `TypeError` for ever.
     */
    await expect(h.accounts.approve(
      raised.id, present(blake).signerId,
      sign(approvalMessage(raised), present(blake).signingSecret), out.viewingKey))
      .rejects.toThrow(/already approved/);
  });

  it('AND THE SAME THROUGH A GOVERNANCE DOOR, WHICH IS THE HALF THE FIRST DRAFT MISSED', async () => {
    /*
     * **A MONEY-SAFETY PASS FOUND THAT THE CASE ABOVE COVERED TWO PROPOSE DOORS
     * OF SIX**, and the four it did not cover are the GOVERNANCE doors — where
     * a proposer being removed between raising and approving is the ordinary
     * case rather than the odd one. The fix now records `proposerRole` at all
     * six; this drives one of the four that had no role at all in the first
     * draft.
     *
     * `proposeVaultThresholdChange` is chosen because it is the one of the four
     * with a live product route (`POST /api/accounts/:id/vault-threshold`).
     */
    const { h, c, blake, cleo } = await threeSigners();
    const VAULT = 'd1'.repeat(32);

    const raised = await h.accounts.proposeVaultThresholdChange(
      c.account.id, c.viewingKey, VAULT, 2, present(cleo).signerId);

    const out = await removeCleo(h, c);
    expect(h.accounts.open(c.account.id, out.viewingKey).signers
      .some(sg => sg.id === present(cleo).signerId)).toBe(false);

    await h.accounts.approve(
      raised.id, present(blake).signerId,
      sign(approvalMessage(raised), present(blake).signingSecret), out.viewingKey);

    const after = h.accounts.requireProposal(raised.id, out.viewingKey);
    expect(after.approvals.map(a => a.signerId)).toEqual([present(blake).signerId]);
    expect(after.approvalRound).toBeDefined();
  });

  it('changes the threshold through a round, and both sides move together', async () => {
    const { h, c, ada, blake } = await threeSigners();
    expect((await h.accounts.ledgerStatus(c.account.id))!.threshold).toBe(2);

    const p = await h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 3, present(ada).signerId);
    await h.accounts.approve(p.id, present(blake).signerId, sign(approvalMessage(p), present(blake).signingSecret), c.viewingKey);
    await h.accounts.setThreshold(c.account.id, c.viewingKey, 3);

    // The chain moved, and the service holds no number to move with it.
    expect((await h.accounts.ledgerStatus(c.account.id))!.threshold).toBe(3);
    expect(Object.keys(h.accounts.open(c.account.id, c.viewingKey).policy)).toEqual(['limitsByRole']);
  });

  it('a threshold change the chain refuses changes nothing', async () => {
    /*
     * The proposal is never approved, so the ledger refuses, and the threshold
     * stays the chain's.
     */
    const { h, c, ada } = await threeSigners();
    await h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 3, present(ada).signerId);

    await expect(h.accounts.setThreshold(c.account.id, c.viewingKey, 3))
      .rejects.toThrow(/not enough approvals/);

    expect((await h.accounts.ledgerStatus(c.account.id))!.threshold).toBe(2);
  });

  it('refuses a threshold above the number of signers, at the earliest point', async () => {
    /*
     * A threshold above the seated count leaves an account that can never
     * approve anything again.
     *
     * Refused when the proposal is PROPOSED, so nobody signs something that was
     * always going to be rejected. The chain refuses it too, which is the test
     * in signer-governance.test.ts.
     */
    const { h, c, ada } = await threeSigners();
    await expect(h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 4, present(ada).signerId,
    )).rejects.toThrow(/cannot exceed the 3 signers/);

    expect((await h.accounts.ledgerStatus(c.account.id))!.openProposals).toEqual([]);
    expect((await h.accounts.ledgerStatus(c.account.id))!.threshold).toBe(2);
  });

  it('refuses zero, a fraction, and a change to what it already is', async () => {
    const { h, c, ada } = await threeSigners();
    const propose = (n: number) => h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, n, present(ada).signerId);
    await expect(propose(0)).rejects.toThrow(/at least one/);
    await expect(propose(2.5)).rejects.toThrow(/whole number/);
    await expect(propose(2)).rejects.toThrow(/already 2/);
  });

  it('the ledger itself refuses to strand the account, not just the layer above it', async () => {
    /*
     * Added because a mutation survived: a guard in the service also refused
     * this, so the service-level test passed with the ledger's own guard
     * removed, and the ledger's guard is the one that models what the contract
     * does.
     */
    /*
     * A 3-of-3 account, created that way rather than raised with
     * `setThreshold`.
     *
     * The reason USED TO BE that it could not be raised at all: the contract
     * declared `threshold` as a SEALED ledger field, writable once in the
     * constructor. It was unsealed and given a circuit, so raising it is now
     * possible — and would be a second approval round to set up, for a test
     * that is about the strand guard rather than about the threshold.
     */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE_SIGNERS, 3, undefined, drawCompanyLabel());
    const ada = c.secrets[0];
    const cleo = c.secrets[2];
    const account = h.accounts.open(c.account.id, c.viewingKey);
    const goneLeaf = account.signers.find(s => s.id === present(cleo).signerId)!.leafCommitment!;
    const by = { signerId: present(ada).signerId, leaf: present(account.signers[0]).leafCommitment! };

    /*
     * The proposal is opened ON THE LEDGER DIRECTLY: this test is about what
     * the thing underneath does when no code of ours is in the way, which is the
     * only guard that counts against a signer calling the contract themselves.
     */
    await h.ledger.propose(
      c.account.id, SimulatedCommitments.signerRemovePayload(goneLeaf, 0),
      { asset: NO_ASSET, amount: 0n, batchDigest: commit('', ''), salt: newProposalSalt() }, by,
      SimulatedCommitments.noVault());
    const [round] = (await h.ledger.status(c.account.id))!.openProposals;
    for (const s of account.signers) {
      if (s.id === by.signerId) continue;
      await h.ledger.approve(c.account.id, present(round).id, { signerId: s.id, leaf: s.leafCommitment! });
    }

    await expect(h.ledger.removeSigner(c.account.id, goneLeaf, present(round).id, by))
      .rejects.toThrow(/could never approve anything again/);
  });

  it('the LEDGER binds the removal to the leaf that was approved, not just our roster', async () => {
    /*
     * This one goes around the service, because the roster is our own
     * bookkeeping and worth nothing against somebody calling the chain directly.
     *
     * Its predecessor asserted that the digest covered the SURVIVOR LIST as
     * well, which was a real guard against a removal that seated a set nobody
     * approved. The list was deleted rather than guarded: nothing is supplied,
     * so nothing can be swapped.
     */
    const { h, c, ada, blake } = await threeSigners();
    const account = h.accounts.open(c.account.id, c.viewingKey);
    const by = { signerId: present(ada).signerId, leaf: present(account.signers[0]).leafCommitment! };
    const blakeLeaf = account.signers.find(s => s.id === present(blake).signerId)!.leafCommitment!;

    const p = await raiseRemoval(h, c, 2, [1]);

    // Approved to remove Cleo; the ledger is asked to remove Blake, naming the
    // very proposal that approved Cleo's removal.
    await expect(h.ledger.removeSigner(c.account.id, blakeLeaf, p.chainId, by))
      .rejects.toThrow(/not for this removal/);
  });

  it('leaves nothing readable behind, and no leafCommitment anywhere', async () => {
    const { h, c, cleo } = await threeSigners();
    const goneLeaf = h.accounts.open(c.account.id, c.viewingKey)
      .signers.find(s => s.id === present(cleo).signerId)!.leafCommitment!;
    const out = await removeCleo(h, c);

    const raw = JSON.stringify((h.store as any).data);
    expect(raw).not.toContain(goneLeaf);
    for (const s of h.accounts.open(c.account.id, out.viewingKey).signers) {
      expect(raw).not.toContain(s.leafCommitment!);
    }
    expect(readableStore((h.store as any).data)).not.toContain('Northwind');
  });

  it('the store holds no blinding factor for anybody, sealed or otherwise', async () => {
    /*
     * The reason the new design is worth more than the 13x.
     *
     * Every signer's blinding factor used to go into the sealed roster, because
     * a removal re-seated the survivors and could not compute their new leaves
     * without it. Decision 0003 says a blinding lives on one device and nowhere
     * else — whoever holds a blinding and a leaf holds the mapping from leaf to
     * person that the on-chain blinding exists to destroy.
     *
     * Sealed is not the same as absent. This asserts absent: the value is not
     * in the store in any form, ciphertext included, because the only copy is
     * the one handed to the signer at creation.
     */
    const { h, c } = await threeSigners();
    await removeCleo(h, c);
    const raw = JSON.stringify((h.store as any).data);
    for (const secret of c.secrets) {
      expect(secret.blinding).toBeTruthy();
      expect(raw).not.toContain(secret.blinding);
    }
  });
});

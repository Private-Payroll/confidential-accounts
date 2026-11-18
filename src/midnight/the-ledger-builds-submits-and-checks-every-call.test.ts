/**
 * MidnightLedger's lifecycle, against a fake chain.
 *
 * These pin bugs that all type-checked and none of which could have been
 * caught by reading: an argument passed to a circuit that takes none, the same
 * transaction submitted twice, and a boundary that handed this class a
 * commitment it could not open. An account holds several proposals at once and
 * every step names the one it is spending, so the assertions say "this
 * proposal is open", not "a proposal is open". The account keeps no balance,
 * so nothing here is about one.
 *
 * Four rules are not about money at all: callTx submits and must not be
 * submitted again, a device with no private state refuses before calling, a
 * proposal below its threshold refuses before a fee is spent, and a
 * transaction id comes from the chain's answer rather than being invented.
 *
 * No node, no proof server, no Docker. The point is that this whole class of
 * bug was reachable offline: the only thing needed was a stand-in for `callTx`
 * that records what it was called with.
 */
import { served, testAddress } from '../testing/served-state.js';
import { describe, it, expect } from 'vitest';
import { MidnightLedger } from './ledger.js';
import type { AccountOpening } from '../core/ledger.js';
import { MidnightCommitments } from './commitments.js';
import { fromHex, toHex } from '../core/crypto.js';
import type { Hex } from '../core/crypto.js';
import { assetIdBytes } from '../core/assets.js';
import { policyBarKey } from './spending-policy.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { ASSET, argHex, BY, CFG, CHANGE, CHANGE_COMMITMENT, harness, OTHER, PAYLOAD_HASH, PROPOSAL_ID, RAISE_BY } from './a-ledger-on-a-fake-chain.test-support.js';

/**
 * Four rules that are not about money, each exercised through a circuit that
 * reaches the same code path of `MidnightLedger`: `buildCall`, `stageChange`,
 * `requireApproved`, `txRef`.
 */
describe('MidnightLedger: a call is submitted once, refused early, and answered by the chain', () => {
  it('does not submit a second time; callTx already submitted', async () => {
    /*
     * The rule is `buildCall`'s and belongs to every circuit alike: the SDK's
     * `callTx` proves, balances and submits, and this class must not submit the
     * result again. A boundary that read it the other way once submitted twice.
     *
     * `approve` is used because it is the shortest path through `buildCall`, and
     * there is no path through it that submits differently.
     */
    const { ledger, submits } = harness({});
    await ledger.approve('acct', PROPOSAL_ID, BY);
    expect(submits).toEqual([]);
  });

  it('refuses when the device holds no private state for the account', async () => {
    /*
     * `stageChange` reads the device's record, and refuses rather than writing a
     * fresh one, because a stage that invents a record replaces the secret key and
     * blinding that are the signer's only way back into their own account.
     *
     * `propose` is used because it is the caller of `stageChange`.
     */
    const { ledger, calls } = harness({ openProposals: [], privateState: null });
    await expect(ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault(), RAISE_BY))
      .rejects.toThrow(/no private state/);
    // And nothing reached the chain, which is the half that costs a fee.
    expect(calls).toHaveLength(0);
  });

  it('refuses below the threshold, before spending anything', async () => {
    /*
     * `requireApproved` has four live callers (`addSigner`, `setThreshold`,
     * `setVaultThreshold`, `removeSigner`), and this is the test of this class's
     * refusal, through one of the four. (The contract has a circuit helper of the
     * same name; the contract's own tests cover that one, and it is not this.) The
     * same refusal discovered on chain costs a block time, a fee and the proving
     * before it.
     */
    const { ledger, calls } = harness({ approvals: 1n, threshold: 2n });
    await expect(ledger.prepare('acct', {
      kind: 'setThreshold', newThreshold: 3, proposalId: PROPOSAL_ID,
    })).rejects.toThrow(/1 of 2 approvals/);
    expect(calls).toHaveLength(0);
  });

  it('returns the transaction id from the call, not a fabricated one', async () => {
    /*
     * `txRef` reads the id out of whichever field this SDK version answers in, and
     * every method on this class returns through it. A fabricated id is worse than
     * none: it is a handle a person can look up and never find.
     */
    const { ledger } = harness({});
    const ref = await ledger.approve('acct', PROPOSAL_ID, BY);
    expect(ref.ref).toBe('tx_deadbeef');
  });
});

describe('MidnightLedger: proposals, approvals and status', () => {
  it('propose passes the payload hash and the no-vault scope, and nothing else', async () => {
    /*
     * A proposal names the vault it concerns, and the value this boundary must
     * pass is `noVault()`: nothing reachable from here raises a proposal against a
     * vault, and passing a real vault by accident would make the proposal
     * claimable by that vault's signers at that vault's threshold.
     *
     * The sentinel is asserted explicitly rather than by re-reading whatever the
     * ledger passed: the point is which scope, not that some scope arrived.
     */
    const { ledger, calls } = harness({ openProposals: [] });
    await ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault(), RAISE_BY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.circuit).toBe('propose');
    expect(calls[0]!.args).toHaveLength(9);
    expect(argHex(calls[0]!.args[0])).toBe(PAYLOAD_HASH);
    /*
     * One merged circuit, so the run's four slots and the discriminator travel
     * too. `isRun` is false and the fillers are zero: the branch that would read
     * them is not taken. The vault sentinel is still asserted explicitly.
     */
    expect(argHex(calls[0]!.args[1])).toBe('00'.repeat(32));
    expect(calls[0]!.args[2]).toBe(0n);
    expect(calls[0]!.args[3]).toBe(0n);
    expect(calls[0]!.args[4]).toBe(0n);
    expect(calls[0]!.args[5]).toBe(0n);
    expect(calls[0]!.args[6]).toBe(false);
    expect(argHex(calls[0]!.args[7])).toBe(toHex(pureCircuits.noVault()));
    /* RED WHEN: the raise is sent without the deadline it was handed, or with another. */
    expect(calls[0]!.args[8]).toBe(RAISE_BY);
  });

  /*
   * The two ways `propose`'s post-check finds nothing, pinned separately.
   *
   * `landed` is undefined either because the state read came back empty, so
   * nothing was ever searched, or because a state arrived and holds no matching
   * id. A read that failed and a commitment that disagrees are diagnosed in
   * opposite directions, and one message for both leaves a failure unreadable:
   * it names neither.
   */
  it('says the state could not be read back when the post-check read returns nothing', async () => {
    const { ledger } = harness({ openProposals: [], stateGoneAfterCall: true });
    const failed = await ledger
      .propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault(), RAISE_BY)
      .then(() => null, (e: Error) => e);
    expect(failed?.message).toMatch(/could not be read back/);
    // And NOT the other branch's words: naming the wrong fault is the defect.
    expect(failed?.message).not.toMatch(/has no open proposal with this id/);
    expect(failed?.message).toContain(`looked for id: ${PROPOSAL_ID}`);
    expect(failed?.message).toContain('state read back: none');
  });

  it('says no id matched, and prints the id looked for beside the ids held', async () => {
    // Any payload but this test's, so the id differs from PROPOSAL_ID.
    const OTHER = MidnightCommitments.proposalId('99'.repeat(32) as Hex, CHANGE.salt);
    const { ledger } = harness({
      openProposals: [{ id: OTHER, change: CHANGE_COMMITMENT }],
      proposeLands: false,
    });
    const failed = await ledger
      .propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault(), RAISE_BY)
      .then(() => null, (e: Error) => e);
    expect(failed?.message).toMatch(/has no open proposal with this id/);
    expect(failed?.message).not.toMatch(/could not be read back/);
    expect(failed?.message).toContain(`looked for id: ${PROPOSAL_ID}`);
    // The ids actually held, so a mismatch can be READ rather than guessed at.
    expect(failed?.message).toContain(`ids on chain (1): ${OTHER}`);
  });

  it('says how many ids were held when the chain holds none at all', async () => {
    const { ledger } = harness({ openProposals: [], proposeLands: false });
    const failed = await ledger
      .propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault(), RAISE_BY)
      .then(() => null, (e: Error) => e);
    expect(failed?.message).toContain('ids on chain (0): none');
  });

  it('stages the approved change at propose time', async () => {
    // The circuit reads the change from private state at propose. Without
    // staging, the proposal reaches its threshold and can then never settle, with
    // the fees already paid.
    const { ledger, staged } = harness({ openProposals: [] });
    await ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault(), RAISE_BY);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.value.changeAmount).toBe(20_000n);
    // Which asset leaves, because that is part of what the signers approve
    // rather than something the executor picks.
    expect(staged[0]!.value.assetId).toEqual(assetIdBytes(ASSET));
    // The proposer's salt, which later circuits reuse to recompute the
    // proposal's id.
    expect(staged[0]!.value.proposalSalt).toBeInstanceOf(Uint8Array);
  });

  /*
   * There is deliberately no "propose refuses while another proposal is open"
   * test: nothing refuses a second one. `openProposals` is a map keyed by
   * proposal id, so an admin can raise a vendor invoice while payroll collects
   * signatures. The test below is that fact.
   */
  it('a second proposal may be raised while the first is still collecting approvals', async () => {
    const { ledger, calls } = harness({});
    const invoice = 'dd'.repeat(32) as Hex;
    await ledger.propose('acct', invoice, CHANGE, BY, MidnightCommitments.noVault(), RAISE_BY);
    expect(calls.map(c => c.circuit)).toEqual(['propose']);
  });

  it('propose fails loudly when the chain records a different change', async () => {
    /*
     * Every approval gathered against a proposal whose recorded change is not the
     * one supplied is unusable, and the proposal can never settle. Found by id,
     * because "the change the chain recorded" is only a question about one
     * proposal: asking it of the account would compare this proposal against
     * whichever was written last.
     */
    const { ledger } = harness({ openProposals: [], changeOnPropose: OTHER });
    await expect(ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault(), RAISE_BY))
      .rejects.toThrow(/recorded a different change/);
  });

  it('approve names the proposal, and nothing about the signer', async () => {
    /*
     * One argument, and it is public on chain already. Who approved is absent: the
     * nullifier is H(domain, address, proposal, secretKey), derived inside the
     * circuit from a secret that never leaves the device. The call takes the
     * proposal id because an account holds several proposals at once, and
     * approving payroll is not the same act as approving whatever else happens to
     * be open.
     */
    const { ledger, calls } = harness({});
    await ledger.approve('acct', PROPOSAL_ID, BY);
    expect(calls[0]!.circuit).toBe('approve');
    expect(calls[0]!.args).toHaveLength(1);
    expect(argHex(calls[0]!.args[0])).toBe(PROPOSAL_ID);
  });

  it('approve refuses when that proposal is not open', async () => {
    const { ledger } = harness({ openProposals: [] });
    await expect(ledger.approve('acct', PROPOSAL_ID, BY)).rejects.toThrow(/no open proposal/);
  });

  it('cancel closes the proposal it names, and only that one', async () => {
    const other = 'ab'.repeat(32) as Hex;
    const { ledger, calls } = harness({
      openProposals: [
        { id: PROPOSAL_ID, change: CHANGE_COMMITMENT },
        { id: other, change: CHANGE_COMMITMENT },
      ],
    });
    await ledger.cancel('acct', PROPOSAL_ID, BY);
    expect(calls[0]!.circuit).toBe('cancel');
    expect(argHex(calls[0]!.args[0])).toBe(PROPOSAL_ID);
    // The other proposal is untouched: nobody else's approvals are burned.
    expect((await ledger.status('acct'))?.openProposals.map(p => p.id)).toEqual([other]);
  });

  it('status reports every open proposal, and no assets at all', async () => {
    /*
     * An open proposal is present in the map and a settled one is absent, so
     * presence is the whole answer and there is no stale value to misread.
     */
    const other = 'ab'.repeat(32) as Hex;
    const open = harness({
      openProposals: [
        { id: PROPOSAL_ID, change: CHANGE_COMMITMENT },
        { id: other, change: OTHER },
      ],
      approvals: 1n,
      threshold: 2n,
    });
    expect(await open.ledger.status('acct')).toEqual({
      /*
       * Empty, always. The account keeps no book, so there is no map of per-asset
       * commitments to report and nothing that could put an entry here. The field
       * stays on `LedgerStatus` because it is the shape both implementations answer
       * in. It is kept as `[]` in the whole-object `toEqual` rather than dropped,
       * because a field silently disappearing from a boundary is what this style of
       * assertion catches.
       */
      assets: [],
      openProposals: [
        { id: other, change: OTHER, approvals: 1 },
        { id: PROPOSAL_ID, change: CHANGE_COMMITMENT, approvals: 1 },
      ].sort((x, y) => x.id.localeCompare(y.id)),
      threshold: 2,
      /*
       * Asserted rather than tolerated: a whole-object `toEqual`, so every field the
       * boundary grows makes it fail, where a field that grows silently is one whose
       * readers each discover it separately. Empty and zero are statements, not
       * defaults; the `null` options tell them from a field never sent.
       */
      vaultThresholds: [],
      signerCount: 3,
      movementCount: 0,
      retiredVaults: [],
    });

    const quiet = harness({ openProposals: [] });
    const status = await quiet.ledger.status('acct');
    // An account proposing nothing reports two empty lists, and the empty asset
    // list is not a zero balance: the chain is not asked about assets at all.
    expect(status?.openProposals).toEqual([]);
    expect(status?.assets).toEqual([]);
  });
});

/*
 * There is no `credit` test: the contract has no `credit` circuit and
 * `MidnightLedger.credit` does not exist, because the account keeps no book.
 * The harness checks every name it fakes against the compiled ABI, so a stub
 * for a circuit the contract no longer declares fails every test at
 * construction.
 */

/**
 * The arity guard must fire against the real shape of a generated circuit
 * function, which is `(...args) => {}` and therefore has length 0. A stub
 * written with `(...args)` too would share the guard's blind spot and pass
 * against a guard that could never fire. These tests assert the guard rejects
 * a wrong-arity call.
 */
describe('buildCall arity, against the real wrapper shape', () => {

  /*
   * The guard is `buildCall`'s and knows nothing about which circuit it is
   * checking: it reads the declared arity out of the compiled
   * `contract-info.json` and compares. `approve` is used because it is a
   * one-argument circuit.
   */
  it('rejects a call that omits an argument the contract declares', async () => {
    const { ledger } = harness({});
    await expect(
      (ledger as any).buildCall(testAddress(1), 'approve', [], 'a-key:acct'),
    ).rejects.toThrow(/takes 1 argument/);
  });

  it('accepts the correct arity', async () => {
    const { ledger } = harness({});
    await expect(
      (ledger as any).buildCall(testAddress(1), 'approve', [fromHex(PROPOSAL_ID)], 'a-key:acct'),
    ).resolves.toBeDefined();
  });

  it('the run circuits, against the REAL generated wrapper and not the harness stub', async () => {
    /*
     * The harness records calls without checking how many arguments a circuit
     * takes, so every test above would pass with a five-argument call built
     * wrong. This one goes at the generated contract, which is the only thing
     * that actually knows.
     */
    const { ledger } = harness({});
    /*
     * The merged `propose` takes nine declared arguments (the run's four parts,
     * its required approvals and the deadline a raise may land by), and the real
     * `contract-info.json` is what says so. An old five-argument call must be
     * refused by the guard with the arity named, not discovered by the runtime as
     * an undefined halfway into `runPayload`.
     */
    await expect((ledger as any).buildCall(testAddress(1), 'propose', [
      fromHex('00'.repeat(32)), fromHex('aa'.repeat(32)), 50n, 1_800_000_000n, 1_800_604_800n,
      0n, true, fromHex('bb'.repeat(32)), RAISE_BY,
    ], 'a-key:acct')).resolves.toBeDefined();
    await expect((ledger as any).buildCall(testAddress(1), 'propose', [
      fromHex('aa'.repeat(32)), 50n, 1_800_000_000n, 1_800_604_800n, fromHex('bb'.repeat(32)),
    ], 'a-key:acct')).rejects.toThrow(/takes 9 argument/);
    // `proposeRun` is not a circuit of the contract, and a call to it must fail
    // by name, not by a guess about its arguments.
    await expect((ledger as any).buildCall(testAddress(1), 'proposeRun', [
      fromHex('aa'.repeat(32)), 50n, 1_800_000_000n, 1_800_604_800n, fromHex('bb'.repeat(32)),
    ], 'a-key:acct')).rejects.toThrow(/no circuit "proposeRun"/);
    /* `null`, because that is what `prepare` hands this circuit: it reads no
     * witness and must stay callable by a client holding no record. */
    await expect((ledger as any).buildCall(testAddress(1), 'closeExpiredRun', [fromHex(PROPOSAL_ID)], null))
      .resolves.toBeDefined();
  });
});

/**
 * **A CALL BUILT WITHOUT SAYING WHERE ITS PRIVATE STATE IS FILED IS REFUSED BY
 * NAME, RATHER THAN RUNNING AGAINST NONE.**
 *
 * The compiler holds this for every caller it can see. It cannot hold it for a
 * caller reaching the method through `any`, and every call above this one in
 * this file is such a caller - which is exactly the shape that would return
 * this client to running circuits with no private state, silently, if the
 * argument were ever dropped again.
 *
 * RED WHEN: the guard at the top of `buildCall` is removed - the call then
 * resolves, because the harness's fake find ignores the argument entirely.
 */
describe('a call must say where its private state is filed', () => {
  it('refuses a call built with no answer at all, and names the circuit', async () => {
    const { ledger } = harness({});
    await expect(
      (ledger as any).buildCall(testAddress(1), 'approve', [fromHex(PROPOSAL_ID)]),
    ).rejects.toThrow(/the "approve" call was built without saying where its private state/);
  });

  /* `null` is an ANSWER and must not be refused: it is what the one circuit
   * that reads no witness is prepared with. RED WHEN: the guard is widened
   * from `=== undefined` to a falsiness test. */
  it('accepts null, which is what a circuit that reads no witness is given', async () => {
    const { ledger } = harness({});
    await expect(
      (ledger as any).buildCall(testAddress(1), 'closeExpiredRun', [fromHex(PROPOSAL_ID)], null),
    ).resolves.toBeDefined();
  });

  /*
   * **AN EMPTY STRING IS A DROPPED ARGUMENT THAT GOT AS FAR AS A VARIABLE**,
   * and the SDK treats it exactly as it treats a missing one. The key builder
   * cannot produce one today; the guard covers it because what it promises is
   * about a dropped argument rather than about one way of dropping it.
   *
   * RED WHEN: the guard narrows back to `=== undefined` alone.
   */
  it('refuses an empty key, which the SDK would treat as no key at all', async () => {
    const { ledger } = harness({});
    await expect(
      (ledger as any).buildCall(testAddress(1), 'approve', [fromHex(PROPOSAL_ID)], ''),
    ).rejects.toThrow(/the "approve" call was built without saying where its private state/);
  });
});

/**
 * **AND THE ANSWER IS CHECKED AGAINST THE CIRCUIT IT IS MADE ABOUT.**
 *
 * Saying "this call needs no private state" is a claim, and a claim about the
 * wrong circuit puts the client back where it started: running a signer check
 * against nothing, with the types satisfied and nothing red. So the claim is
 * checked in both directions, at the one point every call this client builds
 * passes through. The job runner builds its own call options and is not
 * behind this guard.
 */
describe('a call that says it needs no private state is checked against its circuit', () => {
  it('refuses null for a circuit that opens with a signer check', async () => {
    const { ledger } = harness({});
    await expect(
      (ledger as any).buildCall(testAddress(1), 'approve', [fromHex(PROPOSAL_ID)], null),
    ).rejects.toThrow(/reads one/);
  });

  it('refuses a key for the circuit that reads no witness at all', async () => {
    const { ledger } = harness({});
    await expect(
      (ledger as any).buildCall(testAddress(1), 'closeExpiredRun', [fromHex(PROPOSAL_ID)], 'a-key:acct'),
    ).rejects.toThrow(/reads no witness at all/);
  });
});

describe('a payroll run, raised and swept through the client', () => {
  const RUN = {
    root: 'aa'.repeat(32) as Hex,
    payees: 50n,
    opensAt: 1_800_000_000n,
    closesAt: 1_800_604_800n,   // seven days later
    vault: 'bb'.repeat(32) as Hex,
  };

  const runId = () => MidnightCommitments.proposalId(
    MidnightCommitments.runPayload(RUN.root, RUN.payees, RUN.opensAt, RUN.closesAt),
    CHANGE.salt, RUN.vault);

  it('names the merged circuit, the run parts, isRun — and THE VAULT, not the sentinel', async () => {
    /*
     * The vault is committed inside the proposal's identity, so passing
     * `noVault()` here would not fail loudly. It would produce a proposal that
     * looks perfectly healthy, collects its approvals, and matches no payment
     * any vault can ever make.
     */
    const { ledger, calls } = harness({ openProposals: [] });
    await ledger.proposeRun('acct', RUN, CHANGE, BY, RAISE_BY);

    expect(calls).toHaveLength(1);
    /* The run travels through the merged `propose`, `isRun` true. */
    expect(calls[0]!.circuit).toBe('propose');
    expect(calls[0]!.args).toHaveLength(9);
    /* The opaque payload slot is a filler the run branch never reads. */
    expect(argHex(calls[0]!.args[0])).toBe('00'.repeat(32));
    expect(argHex(calls[0]!.args[1])).toBe(RUN.root);
    expect(calls[0]!.args[2]).toBe(50n);
    expect(calls[0]!.args[3]).toBe(RUN.opensAt);
    expect(calls[0]!.args[4]).toBe(RUN.closesAt);
    /* The approvals the run's total needs: none named, so zero. */
    expect(calls[0]!.args[5]).toBe(0n);
    expect(calls[0]!.args[6]).toBe(true);
    expect(argHex(calls[0]!.args[7])).toBe(RUN.vault);
    expect(argHex(calls[0]!.args[7])).not.toBe(toHex(pureCircuits.noVault()));
    /* RED WHEN: a run is raised without the deadline it was handed, or with another. */
    expect(calls[0]!.args[8]).toBe(RAISE_BY);
  });

  /*
   * The slot order, read off the compiled artifact rather than written out a
   * second time.
   *
   * What the case above pins, and what it does not: it asserts
   * `args[1] === RUN.root`, `args[3] === RUN.opensAt`, `args[4] === RUN.closesAt`
   * and so on, against indices typed into this file. So the argument vector
   * `MidnightLedger` builds and the expectations here are two hand-written
   * copies of one slot order, and they agree because the same person wrote both.
   * A transposition applied to both in one edit is green everywhere, because
   * nothing else asks the contract what order it declared. `payees`, `opensAt`
   * and `closesAt` are all `bigint` and `root`/`vault` are both `Bytes<32>`, so
   * the compiler cannot see a swap among them either.
   *
   * It matters on this vector: a run's identity is
   * `proposalIdOf(runPayload(root, payees, opensAt, closesAt), vault, salt)`, and
   * `recordPayment` recomputes it from its own arguments. Transpose `opensAt` and
   * `closesAt` and the chain refuses an inverted window, which is loud; but
   * transpose them in `MidnightLedger` only, while `MidnightCommitments`
   * computes the id the honest way, and the client's post-check is what fires
   * instead. The arity guard cannot see any of it: all the slots are still
   * there.
   *
   * So the third party is the artifact. `contract-info.json` is the compiler's
   * own declaration of `propose`'s argument names in order, and this case maps
   * each value to its slot by name. Nothing here is derived from
   * `MidnightLedger` and nothing is typed twice, so an edit to the vector alone
   * reddens it, and an edit to the vector and this file cannot make them agree:
   * the order is not ours to state. `arityFrom` reads this same file and keeps
   * only the count, which is why the names are read here.
   *
   * With the vector transposed and every typed copy edited to agree, all the
   * other cases stay green; this case is the only one that goes red.
   */
  it('puts every run part in the slot the COMPILED ARTIFACT names for it, not the slot we typed',
    async () => {
      /* The compiled artifact is read here, where it is used. */
      const { readFileSync } = await import('node:fs');
      const info = JSON.parse(
        readFileSync(`${CFG.zkConfigPath}/compiler/contract-info.json`, 'utf8'));
      const declared: Array<{ name: string }> =
        info.circuits.find((c: { name: string }) => c.name === 'propose').arguments;

      /*
       * The artifact is only a third party if it really answered. A lookup that
       * silently returned nothing would make every assertion below vacuous.
       */
      const slot = (name: string): number => {
        const i = declared.findIndex((a) => a.name === name);
        if (i < 0) throw new Error(`the compiled contract declares no argument "${name}" on propose`);
        return i;
      };
      expect(declared).toHaveLength(9);

      const { ledger, calls } = harness({ openProposals: [] });
      await ledger.proposeRun('acct', RUN, CHANGE, BY, RAISE_BY);
      const args = calls[0]!.args;

      expect(argHex(args[slot('root')])).toBe(RUN.root);
      expect(args[slot('payees')]).toBe(RUN.payees);
      expect(args[slot('opensAt')]).toBe(RUN.opensAt);
      expect(args[slot('closesAt')]).toBe(RUN.closesAt);
      expect(args[slot('isRun')]).toBe(true);
      expect(args[slot('required')]).toBe(0n);
      expect(argHex(args[slot('vault')])).toBe(RUN.vault);
      /* The opaque slot the run branch never reads. */
      expect(argHex(args[slot('payloadHash')])).toBe('00'.repeat(32));

      /*
       * The four run parts are distinct values, which is what makes the assertions
       * above capable of failing: a fixture whose fields collide pins nothing,
       * because a swap of two equal values is invisible. `payees` is small and the
       * two times are seconds apart, so no two of them can be confused for one
       * another.
       */
      expect(new Set([RUN.root, RUN.vault]).size).toBe(2);
      expect(new Set([RUN.payees, RUN.opensAt, RUN.closesAt]).size).toBe(3);
    });

  /*
   * The governance `propose` vector has the same two-copies exposure on the same
   * slots, and is asserted above against indices typed into this file.
   */
  it('hands back the id every approval and every payment will be made against', async () => {
    const { ledger } = harness({ openProposals: [] });
    const r = await ledger.proposeRun('acct', RUN, CHANGE, BY, RAISE_BY);
    expect(r.proposalId).toBe(runId());
  });

  it('stages the change, because the circuit reads it from private state', async () => {
    const { ledger, staged } = harness({ openProposals: [] });
    await ledger.proposeRun('acct', RUN, CHANGE, BY, RAISE_BY);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.value.proposalSalt).toBeInstanceOf(Uint8Array);
  });

  it('REFUSES A WINDOW IN MILLISECONDS, which would build a run that opens in the year 56000',
    async () => {
    /*
     * The contract compares against `secondsSinceEpoch`. A JavaScript timestamp
     * passed straight through is approved, paid for, and unpayable, with
     * nothing anywhere to say why. The mistake costs one character to make.
     */
    const { ledger, calls } = harness({ openProposals: [] });
    await expect(ledger.proposeRun(
      'acct', { ...RUN, opensAt: 1_800_000_000_000n, closesAt: 1_800_604_800_000n }, CHANGE, BY, RAISE_BY))
      .rejects.toThrow(/not a time in seconds|year 5/i);
    expect(calls).toEqual([]);
  });

  it('refuses a backwards window and an empty run before spending a fee', async () => {
    const { ledger, calls } = harness({ openProposals: [] });
    await expect(ledger.proposeRun(
      'acct', { ...RUN, opensAt: RUN.closesAt, closesAt: RUN.opensAt }, CHANGE, BY, RAISE_BY))
      .rejects.toThrow(/no payment could ever fall inside it/i);
    await expect(ledger.proposeRun('acct', { ...RUN, payees: 0n }, CHANGE, BY, RAISE_BY))
      .rejects.toThrow(/at least one payee/i);
    expect(calls).toEqual([]);
  });

  it('SAYS SO when the run did not land, rather than returning an id nobody can pay', async () => {
    const { ledger } = harness({ openProposals: [], proposeLands: false });
    await expect(ledger.proposeRun('acct', RUN, CHANGE, BY, RAISE_BY))
      .rejects.toThrow(/no open proposal with this run's id/i);
  });

  it('SAYS SO when the chain recorded a different change', async () => {
    const { ledger } = harness({ openProposals: [], changeOnPropose: 'cd'.repeat(32) as Hex });
    await expect(ledger.proposeRun('acct', RUN, CHANGE, BY, RAISE_BY))
      .rejects.toThrow(/different change/i);
  });

  it('sweeps an expired run by id, and takes it out of the open set', async () => {
    const { ledger, calls } = harness({ openProposals: [] });
    const r = await ledger.proposeRun('acct', RUN, CHANGE, BY, RAISE_BY);
    await ledger.closeExpiredRun('acct', r.proposalId, BY);

    const sweep = calls.find(c => c.circuit === 'closeExpiredRun');
    expect(sweep).toBeDefined();
    expect(argHex(sweep!.args[0])).toBe(r.proposalId);
  });

  it('does not pre-check the window before sweeping, because we have no second opinion on the time',
    async () => {
    /*
     * The contract asserts the window has closed. Refusing here would need our
     * own view of the block time, which is a guess — and a guess that refuses
     * is worse than a transaction that fails, because it cannot be retried into
     * correctness.
     */
    const { ledger } = harness({ openProposals: [] });
    await expect(ledger.closeExpiredRun('acct', runId(), BY)).resolves.toBeDefined();
  });
});

describe('prepare: the same round, stopped before the chain', () => {
  /*
   * `prepare` is the half of each method that a job needs on its own: check and
   * stage, then stop. It is not a second implementation: every method above
   * calls it, so the tests already in this file test it too. What is left to
   * test here is what only `prepare` can get wrong: submitting when it should
   * not, and staging or refusing in the wrong order.
   */

  /*
   * `propose` is used for the three tests below that are about `prepare` itself
   * rather than about a spend: it stages before it returns, it names a circuit
   * and an arity, and it refuses on a chain read. The `approve` step used
   * further down covers the check-only path.
   */
  const step = {
    kind: 'propose' as const,
    payloadHash: PAYLOAD_HASH,
    change: CHANGE,
    vault: MidnightCommitments.noVault(),
    raiseBy: RAISE_BY,
  };

  it('touches nothing on chain', async () => {
    // The whole point. Proving is eighty seconds against the WASM prover, and a
    // job has to be able to do all of this, crash, and owe the chain nothing.
    const { ledger, calls, submits, ...rest } = harness({ openProposals: [] });
    await ledger.prepare('acct', step);
    expect(calls).toEqual([]);
    expect(submits).toEqual([]);
    void rest;
  });

  it('stages the witnesses, because the circuit reads them from private state', async () => {
    /*
     * Staging is not a side effect that can be deferred to submission time. The
     * circuit reads the approved change out of this device's private state, as
     * there is no argument for it, so it has to be there before the transaction is
     * built, not before it is sent. Nothing in this class writes a sealed blob, so
     * `puts` is empty for every step.
     */
    const { ledger, staged } = harness({ openProposals: [] });
    await ledger.prepare('acct', step);
    expect(staged.length).toBeGreaterThan(0);
  });

  it('names the circuit and passes the arity the contract declares', async () => {
    const { ledger } = harness({ openProposals: [] });
    const call = await ledger.prepare('acct', step);
    expect(call.circuit).toBe('propose');
    // Eight since the run's required approvals joined it, and the guard reads that off the compiled ABI.
    expect(call.args).toHaveLength(9);
    expect(argHex(call.args[0])).toBe(PAYLOAD_HASH);
    expect(call.address).toBe(testAddress(1));
  });

  /*
   * `PreparedCall.expectCommitment` is still declared and no case of `prepare`
   * sets it, so it is `undefined` for every step. The test below asserts exactly
   * that for `approve`: it is left asserting the narrow claim rather than the
   * general one, because a test saying no step ever sets it would pin the field
   * in place.
   */

  it('leaves it unset for the steps that move no state', async () => {
    // `approve` changes no commitment, so there is nothing to compare against —
    // what makes a retry safe there is the circuit's own nullifier instead.
    const { ledger } = harness({});
    const call = await ledger.prepare('acct', { kind: 'approve', proposalId: PROPOSAL_ID });
    expect(call.expectCommitment).toBeUndefined();
    expect(call.circuit).toBe('approve');
  });

  it('refuses before doing any work, not after', async () => {
    /*
     * Every refusal here is free. The same refusal discovered on chain costs a
     * block time, a fee, and eighty seconds of proving before it.
     *
     * It uses the `approve` step, because `propose` deliberately has no "already
     * open" refusal and so cannot demonstrate this. `approve` goes through
     * `requireOpen`, which is the same read.
     */
    const { ledger, puts } = harness({ openProposals: [] });
    await expect(ledger.prepare('acct', { kind: 'approve', proposalId: PROPOSAL_ID }))
      .rejects.toThrow(/no open proposal/);
    expect(puts).toEqual([]);
  });
});

/**
 * An empty map and a missing one are different answers, and the boundary keeps
 * them apart.
 *
 * A read that assumed a decoded field was present passed both typechecks (the
 * scripts tsconfig has `strict: false` and the generated types are loose) and
 * then died on `parsed.thresholds is not iterable`. The generated reader
 * declares all the maps as non-optional accessors iterating as pairs; what is
 * not declared anywhere is that the field is there.
 *
 * The obvious repair is the defect. `?? []` makes the failure go away and
 * turns "we could not read the exceptions" into "there are no exceptions", and
 * for `thresholds` those have opposite consequences, because no exceptions
 * means every vault inherits the account's threshold. A vault somebody
 * deliberately gave a higher threshold would then be judged by the account's
 * lower one, and its proposals would settle early. `NaN` at least fails a
 * `< 1` check somewhere, while `[]` passes every check there is.
 *
 * So both sides are pinned. A property that holds only while nobody writes
 * `?? []` is not a property.
 */
describe('the boundary tells an empty map apart from a missing one', () => {
  /**
   * Drops one map from what the reader hands over, and changes nothing else.
   *
   * Reaching past the fake's own state is the only way to exercise a reader that
   * returns less than it declares, the case no type can express, because the
   * generated `.d.ts` declares every one of these maps as a non-optional
   * accessor.
   */
  const withoutMap = (ledger: unknown, field: string) => {
    const inner: any = ledger;
    const original = inner.providers;
    inner.providers = async () => {
      const p = await original.call(inner);
      const state = (await p.publicDataProvider.queryContractState()).contractState.deserialize();
      delete state.data[field];
      return { ...p, publicDataProvider: { queryContractState: async () => served(state) } };
    };
  };

  /*
   * One test per map, and the count is the point. A test per map is the shape
   * where a map added to the contract and not to this list is a gap somebody can
   * see, rather than a loop that still passes.
   *
   * Every one of them pins both sides. A refusal test alone would pass against a
   * boundary that refused everything, and an empty-map test alone is what
   * `?? []` passes.
   *
   * There are three maps and one set, and four tests. The seat count is a read
   * of `signerLeaves`, which is a set: `setSize` is `mapField`'s sibling and the
   * fourth test below is that one's. The guards over `openProposals`,
   * `approvalCounts` and `thresholds` are the other three. Reading
   * `parsed.signerLeaves.size()` directly would skip the guard, and a paragraph
   * is not a gate: these tests are.
   */

  it('openProposals: empty means nothing is open; missing refuses', async () => {
    const empty = harness({ openProposals: [] });
    expect((await empty.ledger.status('acct'))!.openProposals).toEqual([]);

    const absent = harness({});
    withoutMap(absent.ledger, 'openProposals');
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/"openProposals" map was not in the decoded state/);
  });

  it('thresholds: empty means every vault inherits; missing refuses, and says so', async () => {
    const { ledger } = harness({ vaultThresholds: [] });
    const status = await ledger.status('acct');
    expect(status!.vaultThresholds).toEqual([]);
    // And the account's own threshold is still answered, because nothing failed.
    expect(status!.threshold).toBe(2);

    /*
     * `null` is the fake reader omitting the field, which is precisely what it
     * did before this was noticed. The refusal has to NAME the field and has to
     * say that missing is not empty — a `TypeError` about an internal
     * expression is the right outcome for the wrong reason, and it is one
     * careless `?? []` away from becoming the wrong outcome.
     */
    const absent = harness({ vaultThresholds: null });
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/"thresholds" map was not in the decoded state/);
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/not the same as the map being empty/);
  });

  it('thresholds: the policy bar, kept under its own key in the same map as each vault\'s, is handed over with them', async () => {
    const vault = 'a1'.repeat(32) as Hex;
    const { ledger } = harness({ vaultThresholds: [[vault, 2n], [policyBarKey(), 3n]] });
    /*
     * RED WHEN: the status hands over only the vaults' entries of the map - a
     * device setting a spending policy or its bar then never finds the bar
     * the chain keeps, and asks for approvals against the account's own
     * threshold instead.
     */
    expect((await ledger.status('acct'))!.vaultThresholds).toEqual(expect.arrayContaining([
      { vault, threshold: 2 }, { vault: policyBarKey(), threshold: 3 },
    ]));
  });

  it('approvalCounts: empty means nobody has approved anything; missing refuses', async () => {
    /*
     * The fourth map, and the one that was once read outside the guard. An account
     * with no open proposals has an empty `approvalCounts` (the contract inserts a
     * zero at `propose` and removes it when the proposal closes), and that is a
     * true statement about the account: nothing is open, so nothing has approvals.
     * A map the reader never supplied is not that, and the refusal keeps them
     * apart.
     *
     * What it costs without the guard: `Number(undefined.lookup(id))` is a
     * `TypeError` naming an internal expression, and the repair anybody reaches
     * for is `?? 0n`, a proposal that has the approvals it needs reported as
     * having none, and a proposal nobody reading this boundary can settle.
     */
    const empty = harness({ openProposals: [] });
    expect((await empty.ledger.status('acct'))!.openProposals).toEqual([]);

    /*
     * Absent WITH a proposal open, because that is the only state in which the
     * count is ever fetched — a missing map behind an empty proposal list would
     * pass against the unguarded read too, and would prove nothing.
     */
    const absent = harness({ approvalCounts: null });
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/"approvalCounts" map was not in the decoded state/);
    // NOT a TypeError about an internal expression, which is what it threw before.
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/not the same as the map being empty/);
  });

  it('signerLeaves: the seat count is read, and a missing SET refuses rather than reading zero', async () => {
    /*
     * The fourth collection, and the one that is not a map. The empty side is not
     * reachable for this field, and that is a property of the contract rather than
     * of this boundary: the constructor seats exactly one signer, so a live
     * account's set is never empty. What is reachable is a reader that hands the
     * accessor over and one that does not, and those two must not produce the same
     * number.
     *
     * What zero would cost, which is why this is a refusal and not a `?? 0n`:
     * `signerCount: 0` makes `bootstrapping` true on a live account, and refuses
     * every `setThreshold` and every `removeSigner`. The contract still refuses
     * correctly and our refusals stop refusing, which is denial rather than loss
     * and is still the wrong answer given confidently.
     */
    const seated = harness({ signerCount: 4n });
    expect((await seated.ledger.status('acct'))!.signerCount).toBe(4);

    const absent = harness({ signerCount: null });
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/"signerLeaves" set was not in the decoded state/);
    // The noun is `set`, not `map`, and the sentence that matters is the same one.
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/not the same as the map being empty/);
  });

  it('reports the exceptions the chain holds, sorted, when there are some', async () => {
    const A = 'a1'.repeat(32) as Hex;
    const B = 'b2'.repeat(32) as Hex;
    // Supplied out of order, because a map's iteration order is not a promise
    // and anything that gets compared has to be stable.
    const { ledger } = harness({ vaultThresholds: [[B, 4n], [A, 2n]] });
    const status = await ledger.status('acct');
    expect(status!.vaultThresholds).toEqual([
      { vault: A, threshold: 2 },
      { vault: B, threshold: 4 },
    ]);
  });

  it('reports the approvals the chain holds for an open proposal', async () => {
    /*
     * The everyday path, pinned so a refusal is not the only thing this map is
     * tested for. A guard nobody can see working is a guard somebody removes.
     */
    const { ledger } = harness({ approvals: 3n });
    const status = await ledger.status('acct');
    expect(status!.openProposals).toHaveLength(1);
    expect(status!.openProposals[0]!.approvals).toBe(3);
  });
});

/**
 * A ledger is bound to the harness it was built with, reproduced
 * deterministically in one file.
 *
 * Without the fix, a failure appears only in the full suite, because it needs
 * two harnesses to exist before a ledger is used: alone in this file every
 * test built exactly one and used it immediately, so "the harness I built" and
 * "the harness the module registry holds" were the same object. Build a second
 * one first and the failure is every time, with the signature
 * `ids on chain (0): none`: the no-match branch, the state read back fine and
 * holding zero proposals.
 */
describe('a ledger is bound to the harness it was built with', () => {
  it('keeps using ITS OWN chain after a later harness is constructed', async () => {
    const first = harness({ openProposals: [] });
    /*
     * A second harness, built before the first one is used — which is all the
     * full suite was ever doing, spread across two tests instead of two lines.
     */
    const second = harness({});

    await first.ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault(), RAISE_BY);

    // The call landed in the first harness, and the first harness read it back.
    expect(first.calls.map(c => c.circuit)).toEqual(['propose']);
    // And nothing at all reached the second, which is the other half of the claim.
    expect(second.calls).toEqual([]);
  });

  it('serves each of two live ledgers from its own chain, in either order', async () => {
    /*
     * The same property from the direction the suite actually failed in: the
     * OLDER harness's `callTx` serving the NEWER ledger. One binding per
     * providers bundle makes both directions impossible rather than making one
     * of them rarer.
     */
    const a = harness({ openProposals: [] });
    const b = harness({ openProposals: [] });

    await b.ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault(), RAISE_BY);
    await a.ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault(), RAISE_BY);

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });
});

/**
 * What `open` refuses before it spends anything.
 *
 * Three refusals of `MidnightLedger.open` sit between a mistake and a deployed
 * contract: past this point there is a transaction on chain, a fee spent, and
 * an account that may be impossible to fix. They run before the
 * maintenance-authority check and before any provider is built, so a harness
 * with nothing else wired reaches them.
 *
 * They are not the first guard in `open`, which refuses a ledger built without
 * deployment credentials before it looks at the opening at all. So each test
 * below hands `open` a real deployment bag and gets past the credentials guard
 * deliberately: the three refusals are reached because the credentials are
 * present, not because they are missing. A harness that built the ledger with
 * six arguments where the constructor takes seven would land `{}` on
 * `compiled`, leave `deployment` undefined, and make every refusal test fail
 * with the credentials message.
 *
 * The message is read, not the fact of a throw: `rejects.toThrow()` passes for
 * a `TypeError` from a renamed helper, and all three refusals would otherwise
 * be indistinguishable from each other.
 *
 * What is green here is that `open` refuses four specific malformed openings
 * before it spends anything. It is not that the founding seat is safe: `open`
 * never asks whether the leaf it has belongs to anyone, so an account can
 * still be founded on 32 bytes nobody holds. The contract's half of the
 * founding-seat rules is pinned in the contract's own tests.
 */
describe('MidnightLedger.open refuses an opening it cannot honour', () => {
  /* The two values the contract will not seat, in the spellings the product
   * itself produces: `ZERO_32`'s and `pureCircuits.vacantSlot()`'s. */
  const ZERO_LEAF = '00'.repeat(32) as Hex;
  const VACANT_LEAF = toHex(pureCircuits.vacantSlot());

  const opening = (over: Partial<AccountOpening> = {}): AccountOpening => ({
    companyLabel: 'co_' + 'c5'.repeat(32) as AccountOpening['companyLabel'],
    signerLeaves: ['aa'.repeat(32)],
    threshold: 2,
    assetBlinding: 'bb'.repeat(32),
    sealedState: { keyEpoch: 1, sealed: { iv: '', tag: '', body: '' } },
    ...over,
  });

  /**
   * Credentials that exist, carrying an authority the next gate refuses, and
   * both halves are deliberate.
   *
   * They must exist, or `open`'s first guard fires and none of the three
   * refusals below is ever reached. The authority must be refusable, or the
   * positive control runs on past `requireMaintenanceAuthority` into
   * `submitPartialDeployTx` and a chain this harness does not have.
   *
   * A `single-key` authority whose `temporary.fixedBy` is empty is refused by
   * name: one key is acceptable only as a recorded temporary state. That refusal
   * is what the control asserts it reached, which is a statement about where
   * `open` stopped rather than about which messages it avoided.
   */
  const deployment: ConstructorParameters<typeof MidnightLedger>[6] = {
    register: async () => {},
    maintenanceAuthority: {
      kind: 'single-key',
      signingKey: { tag: 'schnorr', value: 'ff'.repeat(32) },
      temporary: { fixedBy: '' },
    },
  };

  it('refuses an opening that names no founding signer', async () => {
    /*
     * The account's only seat is the constructor's argument. Deployed without
     * one, nobody can ever raise the invitation that adds the
     * first — the account is dead, permanently, along with every vault that
     * named it. There is no on-chain guard for an argument never supplied.
     */
    const h = harness({}, deployment);
    await expect(h.ledger.open('acct', opening({ signerLeaves: [] })))
      .rejects.toThrow(/names no founding signer/);
  });

  it('refuses an opening with no company label, or anything else where the label belongs, before anything is asked of a chain', async () => {
    /*
     * The account carries the label its founding signer's wallet made up, and
     * every signer derives the company's keys from it. RED WHEN the refusal is
     * taken out: an opening with no label goes on to the next guard.
     */
    for (const companyLabel of [undefined, null, 'c5'.repeat(32), 'co_' + 'c5'.repeat(32).toUpperCase(), 'co_' + '00'.repeat(32)]) {
      const h = harness({}, deployment);
      await expect(h.ledger.open('acct', opening({ companyLabel: companyLabel as never })), String(companyLabel))
        .rejects.toThrow(/no company label was given, or what was given is not one/);
    }
  });

  it('refuses an opening that names more than one, rather than seating the first and dropping the rest', async () => {
    /*
     * `SimulatedLedger` seats every leaf and `AccountService` writes all N onto
     * the durable record. Silently seating one would leave a roster saying
     * three signers and a chain holding one — a client and a chain that
     * disagree about who may approve.
     */
    const h = harness({}, deployment);
    await expect(h.ledger.open('acct', opening({
      signerLeaves: ['aa'.repeat(32), 'cc'.repeat(32)],
    }))).rejects.toThrow(/can seat exactly one/);
  });

  it('refuses a threshold the chain will never be told about', async () => {
    /*
     * This test pins what the refusal guards today. The constructor takes no
     * threshold and sets `threshold = 1`, so zero is unrepresentable on chain
     * rather than refused here, and this refusal is not what stands between an
     * account and a zero threshold; a name claiming it were would be a falsehood
     * in a test title, which a reader trusts without opening.
     *
     * What it pins: `opening.threshold` never reaches the chain, but it still
     * becomes `account.policy.threshold` and still drives `SimulatedLedger.open`,
     * so a zero, a negative or a `NaN` is still a bad value entering our own
     * record of the account. The boundary refuses it for its own reason, not the
     * contract's.
     */
    const h = harness({}, deployment);
    await expect(h.ledger.open('acct', opening({ threshold: 0 })))
      .rejects.toThrow(/is not a rule/);
    await expect(h.ledger.open('acct', opening({ threshold: -1 })))
      .rejects.toThrow(/is not a rule/);
    /*
     * The other half of the guard, which zero and minus one do not reach. The
     * refusal is `!Number.isInteger(opening.threshold) || opening.threshold < 1`.
     * Both cases above are caught by the second clause alone, so deleting
     * `!Number.isInteger(...)` would leave them green. `NaN < 1` is `false`, so
     * without that clause a `NaN` threshold passes the door and gets as far as
     * `account.policy.threshold` and `SimulatedLedger`, where it makes every later
     * comparison against the policy `false` silently. No money moves, so this is a
     * pin and not a hole.
     */
    await expect(h.ledger.open('acct', opening({ threshold: 1.5 })))
      .rejects.toThrow(/is not a rule/);
    await expect(h.ledger.open('acct', opening({ threshold: NaN })))
      .rejects.toThrow(/is not a rule/);
  });

  /*
   * The fourth refusal in this function. `refuseUnusableLeaf`'s own message says
   * the contract refuses this value, a claim of safety, and a claim is only held
   * if an assert exists and something goes red when it is removed. The
   * contract's half is pinned separately, through the simulator, in the
   * contract's own tests; those stay green with this client guard deleted, which
   * is why this half needs its own.
   */
  it('refuses a founding leaf of thirty-two zero bytes, which is what an empty slot reads as', async () => {
    /*
     * RED WHEN: the `if (leaf === ZERO_32)` branch is removed from
     * `refuseUnusableLeaf`. Watched.
     */
    const h = harness({}, deployment);
    await expect(h.ledger.open('acct', opening({ signerLeaves: [ZERO_LEAF] })))
      .rejects.toThrow(/thirty-two zero bytes/);
  });

  it('refuses a founding leaf that is the vacancy marker itself', async () => {
    /*
     * RED WHEN: the `if (leaf === toHex(pureCircuits.vacantSlot()))` branch is
     * removed from `refuseUnusableLeaf`. Watched.
     *
     * The marker is read off `pureCircuits` here for the same reason the
     * product reads it there — a TypeScript constant would be a second
     * definition of a value the chain compares against.
     */
    const h = harness({}, deployment);
    await expect(h.ledger.open('acct', opening({ signerLeaves: [VACANT_LEAF] })))
      .rejects.toThrow(/vacancy marker itself/);
  });

  it('DOES NOT catch the same marker spelled in upper case — a known limit, recorded rather than repaired', async () => {
    /*
     * This test documents a hole. It is not a passing guard and must not be read
     * as one.
     *
     * `refuseUnusableLeaf` compares hex strings; the contract compares bytes. So
     * the vacancy marker written `6D69...` is the same value to the chain and a
     * different string to this guard, walks past it, and is refused on chain
     * instead, after a proof and after a fee. No money is lost and nothing is
     * seated; what is not delivered is the "before a fee is paid" benefit the
     * guard exists for, against a caller who spells it that way deliberately. The
     * leaf comparison in `signer-leaf.ts` lower-cases both sides, so the fix is
     * one line.
     *
     * The refusal messages above deliberately promise nothing about a fee, because
     * this is the state of the guard.
     *
     * RED WHEN: the guard is made case-insensitive, with `.toLowerCase()` on both
     * sides of either comparison. Whoever makes that fix should rewrite this test
     * as the guard catching the uppercase spelling, not delete it.
     */
    const h = harness({}, deployment);
    const why = await h.ledger
      .open('acct', opening({ signerLeaves: [VACANT_LEAF.toUpperCase()] }))
      .then(() => '', (e: Error) => e.message);
    expect(why).not.toMatch(/thirty-two zero bytes|vacancy marker itself/);
    /*
     * AND WHERE IT GOT TO INSTEAD, NAMED — the same gate the positive control
     * below names. A bare `not.toMatch` would be satisfied by any other
     * refusal firing earlier, including one that happened to stop this for a
     * different reason, and would then read as *the hole is closed*. It is
     * the refusal that ends every creation on a chain: this service deploys no
     * company's account, and that refusal comes after the three guards above.
     */
    expect(why).toMatch(/created only from its founding signer's browser, held by their own committee key/);
  });

  it('DEPLOYS NOTHING ON A CHAIN, WHATEVER AUTHORITY IT WAS GIVEN: A COMPANY\'S ACCOUNT IS CREATED IN ITS FOUNDING SIGNER\'S BROWSER', async () => {
    /*
     * On a chain a company's account is deployed from its founding signer's
     * browser, held by their own committee key from its first transaction, and
     * this service deploys none: an opening that passes the three guards above
     * is refused by name, before any chain is asked for anything. RED WHEN the
     * refusal is dropped or moved after the deploy: the call then asks this
     * chain for its providers, which refuses at once, and the refusal read is
     * not this one.
     */
    for (const authority of [
      { kind: 'unmaintainable' },
      { kind: 'committee', committee: [{ tag: 'schnorr', value: 'cd'.repeat(32) }], threshold: 1 },
      { kind: 'single-key', signingKey: { tag: 'schnorr', value: 'ff'.repeat(32) }, temporary: { fixedBy: 'a recorded state' } },
    ] as const) {
      const h = harness({ providersRefused: true }, { register: async () => {}, maintenanceAuthority: authority as never });
      const why = await h.ledger.open('acct', opening()).then(() => '', (e: Error) => e.message);
      expect(why, authority.kind).toMatch(/created only from its founding signer's browser, held by their own committee key/);
      expect(why, authority.kind).toMatch(/Nothing was deployed and nothing was spent/);
      expect(why).not.toMatch(/submitPartialDeployTx was reached/);
    }
  });

  it('IN THE FOUNDING SIGNER\'S MODE, OPENS NOTHING EITHER: A COMPANY ON A CHAIN IS MADE ON THAT DEVICE', async () => {
    /*
     * RED WHEN opening here keeps a state or deploys in the mode every chain
     * deployment runs in: the company's secrets and first state are made on
     * the founding signer's device, and this service keeps only what it sealed.
     */
    const h = harness({ providersRefused: true, keptOnly: true }, { register: async () => {}, fromTheFoundingSigner: true } as never);
    await expect(h.ledger.open('acct', opening())).rejects.toThrow(/created only from its founding signer's browser/);
    expect(h.puts).toEqual([]);
  });

  it('SAYS WHETHER IT TAKES COMPANIES MADE ON THEIR FOUNDING SIGNER\'S DEVICE', async () => {
    /* RED WHEN: a deployment outside the founding signer's mode says it takes such companies, or the one in it says it does not. */
    expect(harness({ providersRefused: true, keptOnly: true }, { register: async () => {} } as never).ledger
      .takesCompaniesFromTheirFoundingSigner).toBe(false);
    const h = harness({ providersRefused: true, keptOnly: true }, { register: async () => {}, fromTheFoundingSigner: true } as never);
    expect(h.ledger.takesCompaniesFromTheirFoundingSigner).toBe(true);
  });

  it('lets a well-formed opening past all three', async () => {
    /*
     * **THE POSITIVE CONTROL, AND WITHOUT IT THE THREE ABOVE PASS ON A METHOD
     * THAT REFUSES EVERYTHING.** It is not asserted that this deploys — the
     * harness has no chain — only that it gets PAST these three and fails
     * further in, at the maintenance authority, which is the next gate.
     */
    const h = harness({}, deployment);
    /* `rejects.not.toThrow` is not a thing, and a bare `rejects.toThrow()` here
     * would pass for the very refusals this is meant to rule out — so the
     * message is caught and read. */
    const why = await h.ledger.open('acct', opening()).then(() => '', (e: Error) => e.message);
    expect(why).not.toMatch(
      /names no founding signer|can seat exactly one|is not a rule|thirty-two zero bytes|vacancy marker itself/);
    /*
     * And where it did stop. The line above is a negative, and a negative can be
     * satisfied by a refusal that fires before all three. So this says which gate
     * was reached: `requireMaintenanceAuthority`, which `open` calls immediately
     * after the three. A refusal from anywhere earlier fails this line, including
     * the credentials one. On a chain the gate after the three is the one that
     * refuses every creation this service would make.
     */
    expect(why).toMatch(/created only from its founding signer's browser, held by their own committee key/);
  });
});

/**
 * The two reads for the burn check, and the guards that keep them honest.
 *
 * `LedgerStatus` carries `movementCount` and `retiredVaults` for the check that
 * compares payments against the movement count. Both go through
 * `setSize`/`mapField`, which refuse rather than repair. Replacing both reads
 * with the `?? 0n` / `?? []` repair would leave every other test green, so
 * these tests are what hold the refusal.
 *
 * The whole-object `toEqual` above asserts `movementCount: 0,
 * retiredVaults: []`, exactly the values an unguarded read produces, so it
 * agrees with the defect; a test that agrees with the repair it was written to
 * forbid holds nothing.
 *
 * A confident zero from `movements` is not a missing number, it is a wrong
 * answer to the only question the field exists for: the check compares the sum
 * of payments against this count, and a silent zero reports a burn that has
 * not happened or, on a quiet account where payments is also zero, hides one
 * that has. A check that answers instead of refusing is worse than no check.
 */
describe('the burn check\'s two fields are read, and a reader that omits them refuses', () => {
  it('reports the count and the retired vaults the chain holds, sorted', async () => {
    /*
     * **THE NON-DEFAULT READ, WHICH IS WHAT SAYS THE FIELDS ARE WIRED TO THE
     * RIGHT COLLECTIONS AT ALL.** Zero and empty are what a wrong wiring
     * produces too. A count of five and two retired vaults are not.
     *
     * Supplied out of order for the reason the `vaultThresholds` case above
     * gives: a map's iteration order is not a promise, and anything compared
     * has to be stable. **And the VALUES are deliberately not 1**, so a reader
     * that returned `retiredAt`'s values instead of its keys could not pass —
     * the contract stores a marker there (`retireVault` inserts `1`), and
     * *ever retired* is the KEY's presence.
     */
    const A = 'a1'.repeat(32) as Hex;
    const B = 'b2'.repeat(32) as Hex;
    const { ledger } = harness({ movementCount: 5n, retiredVaults: [[B, 7n], [A, 9n]] });
    const status = await ledger.status('acct');
    expect(status!.movementCount).toBe(5);
    expect(status!.retiredVaults).toEqual([A, B]);
  });

  it('refuses when the reader hands over no "movements" set, rather than reporting zero', async () => {
    /*
     * **THE WHOLE POINT OF THE GUARD, AND THE DIRECTION MATTERS.** *No payment
     * has completed* is a statement about the account; *we could not read
     * `movements`* is our ignorance. The detector cannot tell them apart from a
     * number, so the boundary must not hand it one.
     */
    const absent = harness({ movementCount: null });
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/"movements" set was not in the decoded state/);
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/not the same as the map being empty/);

    /* The positive control: present and empty is an ANSWER, and it lands. */
    expect((await harness({ movementCount: 0n }).ledger.status('acct'))!.movementCount).toBe(0);
  });

  it('refuses when the reader hands over no "retiredAt" map, rather than reporting none retired', async () => {
    /*
     * Same rule, the other collection and the other noun — `mapField` says
     * *map* where `setSize` says *set*, and the sentence they share is the one
     * that carries the meaning.
     */
    const absent = harness({ retiredVaults: null });
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/"retiredAt" map was not/);
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/not the same as the map being empty/);

    expect((await harness({ retiredVaults: [] }).ledger.status('acct'))!.retiredVaults).toEqual([]);
  });
});

/**
 * The governance branch refuses a vault, at the layer that pays for it.
 */
describe('a governance proposal may not name a vault, and the boundary says so first', () => {
  it('propose REFUSES a real vault before the fee and before the proving', async () => {
    /*
     * `Accounts.propose` carries a documented `vault?: Hex` and this boundary
     * threads it into the governance branch verbatim. On chain that branch asserts
     * `vault == noVault()`, so a call naming a vault is a paid-for failed
     * transaction, arriving after eighty seconds of WASM proving, which is exactly
     * what `prepare` exists to avoid. Tests on `SimulatedLedger` would stay green.
     *
     * No circuit call is made, and that is the half a thrown error cannot show: a
     * refusal that still built and proved has saved nothing.
     */
    const { ledger, calls } = harness({ openProposals: [] });
    await expect(ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, 'a1'.repeat(32)))
      .rejects.toThrow(/governance round cannot name a vault/);
    expect(calls).toHaveLength(0);

    /*
     * The positive control. The sentinel still goes through, so this is a refusal
     * of one value and not of the door, and `proposeRun`, which is the branch that
     * does carry a vault, is untouched and pinned above.
     */
    await ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault(), RAISE_BY);
    expect(calls).toHaveLength(1);
  });
});

/**
 * A refused `proposeRun` stages nothing.
 */
describe('a refused run leaves no salt behind, because nothing was staged', () => {
  const RUN = {
    root: 'aa'.repeat(32) as Hex,
    payees: 50n,
    opensAt: 1_800_000_000n,
    closesAt: 1_800_604_800n,
    vault: 'bb'.repeat(32) as Hex,
  };

  /*
   * What a durable write on a refused call costs, and it is not the write.
   * `stageChange` puts one record per `(network, account)` holding
   * `proposalSalt`, and that salt is the witness every governance apply-circuit
   * reads to recompute the proposal's id. A refusal after the write clobbers the
   * salt of whatever proposal the device was already holding, so the next apply
   * for a legitimately open proposal recomputes the wrong id and is refused
   * about the wrong thing, with nothing for an operator to attribute it to. The
   * refused call is not the victim; the proposal already open is.
   *
   * `calls` alone is not enough: no fee is spent on a refusal, so asserting
   * `calls` is right about what it checks and silent about this. `staged` is
   * what shows the write.
   */
  it('refuses a window in milliseconds without staging a salt', async () => {
    const { ledger, calls, staged } = harness({ openProposals: [] });
    await expect(ledger.proposeRun(
      'acct', { ...RUN, opensAt: 1_800_000_000_000n, closesAt: 1_800_604_800_000n }, CHANGE, BY, RAISE_BY))
      .rejects.toThrow(/not a time in seconds|year 5/i);
    expect(calls).toEqual([]);
    expect(staged).toEqual([]);
  });

  it('refuses a raise with no deadline, or one in milliseconds, without staging a salt or spending a fee', async () => {
    const { ledger, calls, staged } = harness({ openProposals: [] });
    /* RED WHEN: a raise is built with no deadline, which the chain would refuse only after the proving and the fee. */
    await expect(ledger.proposeRun('acct', RUN, CHANGE, BY)).rejects.toThrow(/does not carry the time it must reach the chain by/u);
    await expect(ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault()))
      .rejects.toThrow(/does not carry the time it must reach the chain by/u);
    /* RED WHEN: a deadline in milliseconds is sent, one the chain would never reach. */
    await expect(ledger.proposeRun('acct', RUN, CHANGE, BY, RAISE_BY * 1000n)).rejects.toThrow(/is not a time in seconds/u);
    expect(calls).toEqual([]);
    expect(staged).toEqual([]);
  });

  it('refuses a backwards window without staging a salt', async () => {
    const { ledger, calls, staged } = harness({ openProposals: [] });
    await expect(ledger.proposeRun(
      'acct', { ...RUN, opensAt: RUN.closesAt, closesAt: RUN.opensAt }, CHANGE, BY, RAISE_BY))
      .rejects.toThrow(/no payment could ever fall inside it/i);
    expect(calls).toEqual([]);
    expect(staged).toEqual([]);
  });

  it('refuses an empty run without staging a salt', async () => {
    const { ledger, calls, staged } = harness({ openProposals: [] });
    await expect(ledger.proposeRun('acct', { ...RUN, payees: 0n }, CHANGE, BY, RAISE_BY))
      .rejects.toThrow(/at least one payee/i);
    expect(calls).toEqual([]);
    expect(staged).toEqual([]);
  });

  /*
   * **THE POSITIVE CONTROL, AND WITHOUT IT THE THREE ABOVE PASS ON A DOOR THAT
   * STAGES NOTHING AT ALL.** Staging is not optional on this branch — the
   * circuit reads the change from private state because there is no argument
   * for it — so a run that is ACCEPTED must still stage exactly one record
   * carrying the salt.
   */
  it('and an accepted run still stages exactly one record, carrying the salt', async () => {
    const { ledger, staged } = harness({ openProposals: [] });
    await ledger.proposeRun('acct', RUN, CHANGE, BY, RAISE_BY);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.value.proposalSalt).toBeInstanceOf(Uint8Array);
  });
});

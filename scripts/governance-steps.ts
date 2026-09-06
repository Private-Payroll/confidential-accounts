/**
 * Removing a signer, reusing the slot they left, and moving the threshold —
 * on a real chain.
 *
 * WHY THIS EXISTS SEPARATELY. `run-preview.ts` drives the proposal path:
 * propose, approve, and the durable-job version of the same. `execute` and
 * `credit` STOOD ON THAT LIST and went with the account's balance ledger under
 * `C292`/`S26`; see `run-preview.ts` where its own circuit guard records that
 * they left. It predates M-106 and M-102 and calls neither `removeSigner` nor
 * `setThreshold`, so the three circuits this week's work was actually about
 * had never been proved by a real prover against a real ledger.
 *
 * WHY IT IS A MODULE AND NOT A SCRIPT. Everything above these steps — wallet
 * bring-up, dust, the providers, `findDeployedContract`, the watchdog — is
 * several hundred lines that were proved working minutes before this file was
 * written. Re-implementing that to get a standalone script would put the risk
 * in the plumbing rather than in the thing being tested. So this takes the
 * working context as an argument and adds only the steps.
 *
 * PORTED TO M-128, AND WHAT THE PORT WAS REALLY ABOUT.
 *
 * This file compiled cleanly for a fortnight while being wrong in every circuit
 * call it made: it called `approve()` and `cancel()` with no arguments and read
 * `round`, `proposalOpen` and `approvalCount` off a ledger that has held none of
 * the three since M-128. It compiled because `GovernanceContext` typed `found`
 * and `readState()` as `any`, and `any` switches off the one gate that catches
 * exactly this class of drift. That is M-42 in a costume — the same lesson as
 * M-107, where the compiler caught the three TYPED call sites when a signature
 * changed and said nothing about the two hidden behind a cast.
 *
 * So the context below names real types, and `found.callTx` is declared with the
 * arity `contracts/managed/contract/index.d.ts` actually publishes. Getting a
 * circuit call wrong here is now a compile error rather than six minutes of
 * proving followed by a runtime arity failure.
 *
 * WHAT IT ASSERTS, and each one is a claim the in-process tests already make
 * that has never been made against a node:
 *
 *   1. a signer can be removed, and it clears THEIR slot and nobody else's
 *   2. the signers either side of the one removed can still act
 *   3. the vacated slot is REUSED by the next signer added
 *   4. the threshold can be raised, and a proposal below the new number is
 *      visibly below it on chain
 *   5. the threshold can be lowered again
 *   6. none of it moved any money
 *
 * The one to read most carefully is 1 and 3 together: a removal that cleared
 * the wrong slot, or a reuse that landed on top of a live signer, is the
 * failure this design can produce that no other design could.
 */
import type { AccountPrivateState } from '../contracts/src/witnesses.js';
import {
  pureCircuits, type Ledger, type ImpureCircuits,
} from '../contracts/managed/contract/index.js';
import { NO_ASSET } from '../src/core/assets.js';

/*
 * S11: the merged `propose` and `amendSigner` have fixed arity, so the branch
 * a call does not take still needs filler arguments. A 32-byte zero is the
 * honest filler — `persistentCommit` can never produce it.
 */
const ZERO_32 = new Uint8Array(32);

/**
 * The circuits this file calls, DERIVED from the generated contract rather than
 * transcribed from it.
 *
 * This block used to be eight signatures written out by hand, with a comment
 * saying they had been copied from `contracts/managed/contract/index.d.ts` "by
 * hand rather than from memory". That is the fix M-104 keeps warning about
 * wearing a disguise: a hand copy is a SECOND definition of the arity, and
 * recompiling the contract regenerates the first one and leaves this one
 * untouched. It compiles either way, so the drift is silent — which is the
 * exact property the `as any` it replaced had, minus the warning label.
 *
 * `callTx` is the same set of circuits with the context argument already bound,
 * so the type is the generated one with its first parameter dropped. Change a
 * circuit's arity in the Compact source, recompile, and every call site in this
 * file stops compiling — which is what the previous comment claimed and this
 * actually does.
 */
type CallTxOf<T> = {
  [K in keyof T]: T[K] extends (context: never, ...rest: infer A) => unknown
    ? (...args: A) => Promise<unknown>
    : never;
};
type AccountCallTx = CallTxOf<ImpureCircuits<AccountPrivateState>>;

/** As much of `findDeployedContract`'s result as these steps touch. */
interface DeployedAccount {
  readonly callTx: AccountCallTx;
}

/** Everything the steps need, all of it already built and proven by the caller. */
export interface GovernanceContext {
  found: DeployedAccount;
  /** The contract's public state, as `ledger()` reads it. Never `any` again. */
  readState: () => Promise<Ledger>;
  callCircuit: (
    name: string, fn: () => Promise<unknown>, landed?: () => Promise<boolean>,
  ) => Promise<unknown>;
  becomeSigner: (s: AccountPrivateState, name: string) => Promise<void>;
  /** Sets the salt the next propose commits under, so the follow-up call matches it. */
  setProposalSalt: (salt: Uint8Array) => void;
  seededBytes: (seed: number) => Uint8Array;
  /**
   * 32 fresh random bytes, DIFFERENT ON EVERY RUN.
   *
   * A proposal's id is `commit(payloadHash, salt)` and an approval's nullifier
   * is bound to that id, in a set the contract never clears. Seeded salts
   * therefore produce the same ids every run, and the second run of this file
   * against the same account dies on `you have already approved this proposal`
   * at the first approve — with the nullifier burned and no way to unburn it.
   * Cancelling frees the id and deliberately leaves the nullifier; only a new
   * salt gives a new proposal.
   */
  freshSalt: () => Uint8Array;
  note: (s: string) => void;
  good: (s: string) => void;
  signers: Record<string, AccountPrivateState>;
}

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

export async function runGovernanceSteps(ctx: GovernanceContext): Promise<void> {
  const {
    found, readState, callCircuit, becomeSigner, setProposalSalt, seededBytes, freshSalt, note, good,
  } = ctx;
  const { A, B, C, D, E } = ctx.signers;

  const leafOf = (s: AccountPrivateState) =>
    pureCircuits.signerLeaf(pureCircuits.signerPublicKey(s.secretKey), s.blinding, s.scope);

  /**
   * Which slot a signer sits in, read off the LEDGER rather than remembered.
   *
   * `slotOf` is the contract's own circuit, so this asks the chain the same
   * question the circuit asks, rather than trusting a number this file kept.
   * Returns null when the leaf is not in the tree at all, which is what a
   * successful removal looks like.
   *
   * The `as never` that used to be on the argument is gone with the `any` on
   * `readState`: `findPathForLeaf` returns a real `MerkleTreePath<Uint8Array>`
   * now, which is what `slotOf` takes, so the cast was hiding nothing and
   * would have hidden a genuine mismatch if one appeared.
   */
  const slotOf = async (s: AccountPrivateState): Promise<bigint | null> => {
    const path = (await readState()).signers.findPathForLeaf(leafOf(s));
    return path ? pureCircuits.slotOf(path) : null;
  };

  const slots = async () => ({
    A: await slotOf(A), B: await slotOf(B), C: await slotOf(C),
    D: await slotOf(D), E: await slotOf(E),
  });

  const showSlots = async (label: string) => {
    const s = await slots();
    const fmt = (v: bigint | null) => (v === null ? '—' : String(v));
    note(`${label}  A:${fmt(s.A)}  B:${fmt(s.B)}  C:${fmt(s.C)}  D:${fmt(s.D)}  E:${fmt(s.E)}`);
    return s;
  };

  /* ------------------------------------------------------------------ *
   * reading the account
   *
   * The same four readers `run-preview.ts` uses, for the same reason: M-128
   * turned three scalar fields into two maps, so every question this file used
   * to ask of a field is a question about one entry in one of them. They sort,
   * because a map's iteration order is not a promise and anything compared has
   * to be stable.
   * ------------------------------------------------------------------ */

  /** Every proposal open at once, not "the" open one. */
  const openProposalsOf = (l: Ledger): Array<{ id: string; change: string; approvals: number }> =>
    [...l.openProposals]
      .map(([id, change]) => ({
        id: hex(id), change: hex(change), approvals: Number(l.approvalCounts.lookup(id)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

  /**
   * Is this proposal open? BY ID, and BY PRESENCE.
   *
   * The contract removes a proposal when it settles or is cancelled rather than
   * zeroing a flag beside it, so presence is the whole answer — where the old
   * shape had to read `proposalOpen` and hope it agreed with the commitment
   * sitting next to it.
   */
  const isOpen = (l: Ledger, id: Uint8Array): boolean =>
    openProposalsOf(l).some(p => p.id === hex(id));

  /**
   * How many approvals THAT proposal has. Zero once it is gone.
   *
   * Read off the list rather than by looking the id up directly, because
   * `lookup` on a key a map does not hold is an error rather than a zero, and
   * "that proposal is finished" is an ordinary thing to be asking about.
   */
  const approvalsFor = (l: Ledger, id: Uint8Array): number =>
    openProposalsOf(l).find(p => p.id === hex(id))?.approvals ?? 0;

  /*
   * `assetsOf` STOOD HERE — every entry in `assetBalances` rendered as
   * `blindedKey=commitment`, so step 8 could compare the account's whole
   * balance ledger before and after a governance run. It went with that ledger
   * under `C292`/`S26`.
   *
   * WHAT IT ENFORCED SURVIVES IN PART, in step 8: that a governance run moves
   * no money. `movements` is now the only on-chain record of a payment, so that
   * is what the check reads. WHAT IT CAN NO LONGER SEE is a held balance
   * changing without a movement being recorded — there is no balance on chain
   * to look at.
   */

  /**
   * What the chain calls a proposal: `commit(payloadHash, salt)`.
   *
   * COMPUTED HERE, BEFORE ANYTHING IS SUBMITTED. Every call that spends
   * a proposal names which one, so the id has to be derivable without a round
   * trip — which is why the contract exports `proposalIdOf` rather than writing
   * the commitment inline.
   */
  const proposalIdFor = (payloadHash: Uint8Array, salt: Uint8Array) =>
    pureCircuits.proposalIdOf(payloadHash, pureCircuits.noVault(), salt);

  /**
   * Checks a proposal was CONSUMED, which is what replaced "the round advanced".
   *
   * `closeProposal` REMOVES the id from `openProposals` and `approvalCounts`,
   * so absence is the whole answer and it is a claim about this proposal alone —
   * where the old check read an account-wide round counter and would have said
   * yes to any transaction that happened to land in between.
   *
   * A SECOND HALF OF THIS NOTE STOOD HERE and went with the balance ledger
   * under `C292`/`S26`. It said that an EXECUTED proposal also landed in the
   * `settled` tree, that only `execute` inserted there, and that a governance
   * proposal being absent from `settled` was therefore correct rather than a
   * gap this check was missing. The tree and that circuit are both gone, so
   * there is no second place a consumed proposal could be looked for, and no
   * distinction left to draw between a governance proposal and any other.
   * Absence from `openProposals` is the whole on-chain record that a proposal
   * was consumed.
   */
  const wasConsumed = async (label: string, id: Uint8Array) => {
    const l = await readState();
    if (isOpen(l, id)) {
      throw new Error(`the ${label} proposal ${hex(id).slice(0, 16)}… is still open on chain`);
    }
    good(
      `${label}: proposal ${hex(id).slice(0, 16)}… consumed — gone from openProposals ` +
        `(${l.openProposals.size()} still open), which since C292 is the whole on-chain ` +
        'record that a proposal was spent',
    );
  };

  /**
   * Opens a proposal for `payloadHash` and takes it to the threshold.
   *
   * IT RETURNS THE ID NOW, and that is the shape of M-128 in one line: an
   * account holds as many proposals as have been raised, so every call that
   * follows has to name the one it means. Approvals are counted per proposal,
   * so "did that approval land" is "has THIS proposal's count gone up" rather
   * than a reading of an account-wide counter that any other signer's activity
   * could have moved.
   *
   * The salt matters and is the reason `setProposalSalt` is in the context: the
   * circuit recomputes `proposalIdOf(payload, proposalSalt())` from the
   * CALLER'S private state, so the device performing the governance call has to
   * hold the same salt the proposer used. It travels in the sealed payload in
   * the real product (decision 0002); here it is set explicitly so the failure
   * mode is visible rather than incidental. Since M-128 the salt does more than
   * blind the commitment — it is half of the proposal's identity.
   */
  const approvedRound = async (
    label: string,
    payloadHash: Uint8Array,
    salt: Uint8Array,
    approvers: [string, AccountPrivateState][],
  ): Promise<Uint8Array> => {
    setProposalSalt(salt);
    const id = proposalIdFor(payloadHash, salt);
    note(`${label}: proposal id ${hex(id).slice(0, 24)}…`);

    await becomeSigner(A, 'A');
    await callCircuit(`propose (${label})`, () => found.callTx.propose(payloadHash, ZERO_32, 0n, 0n, 0n, false, pureCircuits.noVault()),
      async () => isOpen(await readState(), id));

    for (const [name, who] of approvers) {
      await becomeSigner(who, name);
      const was = approvalsFor(await readState(), id);
      await callCircuit(`approve ${label} (${name})`, () => found.callTx.approve(id),
        async () => approvalsFor(await readState(), id) > was);
    }

    const st = await readState();
    const have = approvalsFor(st, id);
    /*
     * Refuse here rather than let the governance call fail inside a proof.
     *
     * `requireApproved` asserts `approvalCounts.lookup(id) >= threshold`, so a
     * short round produces "not enough approvals yet" after six minutes of
     * proving. This says the same thing immediately and names the numbers.
     */
    if (have < Number(st.threshold)) {
      throw new Error(
        `${label}: ${have} approvals against a threshold of ${st.threshold} — the call that ` +
        'spends this proposal would be refused by requireApproved',
      );
    }
    good(`${label}: ${have} of ${st.threshold} approvals on this proposal`);
    return id;
  };

  /* ------------------------------------------------------------------ *
   * 1. Where everybody is now
   * ------------------------------------------------------------------ */

  /**
   * Enough approvers for whatever threshold the chain holds.
   *
   * Every round below used to name two signers, which is correct only on an
   * account whose threshold is exactly 2 — the number RUN-PROPOSAL leaves
   * behind. Against an account at 3 the first `approvedRound` refuses before
   * submitting anything, which is the right failure and still a failure this
   * script causes rather than finds.
   *
   * E BEFORE D IS DELIBERATE. E is the signer seated into the REUSED slot, and
   * until it approves something this run proves only that its leaf is in the
   * tree — not that a leaf in a re-seated slot produces a membership proof the
   * chain accepts, which is the half of M-106 that could fail silently.
   */
  const approversFrom = (
    pool: [string, AccountPrivateState][], threshold: bigint, label: string,
  ): [string, AccountPrivateState][] => {
    const want = Number(threshold);
    if (pool.length < want) {
      throw new Error(
        `${label}: the threshold is ${threshold} but only ${pool.length} signer(s) are seated ` +
          'and able to approve at this point in the run',
      );
    }
    return pool.slice(0, want);
  };

  const start = await readState();
  /*
   * `round` USED TO BE PRINTED HERE and M-128 deleted the field. It existed to
   * scope approval nullifiers, which is what limited an account to one proposal
   * at a time; nullifiers bind to the proposal now, so there is no global
   * sequence number to report. What replaced it on this line is the honest
   * equivalent: how many proposals the account is actually carrying.
   */
  note(
    `threshold ${start.threshold}, ${start.signerLeaves.size()} signers, ` +
    `${start.openProposals.size()} proposal(s) open`,
  );
  const before = await showSlots('slots before');

  /*
   * What the account's money looks like before any of this. M-125.
   *
   * Kept so the end of the run can say that governance moved none of it, rather
   * than leaving a reader to assume so.
   *
   * `assetsBefore` STOOD BESIDE THIS — a snapshot of the whole `assetBalances`
   * map, taken because there was no single `stateCommitment` left to compare.
   * The map went with the balance ledger under `C292`, so the movement count is
   * the whole snapshot now: it is the only on-chain record of a payment there
   * is.
   */
  const movementsBefore = start.movements.size();

  if (before.A === null || before.B === null || before.C === null) {
    throw new Error(
      'this run expects signers A, B and C already seated — run RUN-PROPOSAL.command first',
    );
  }

  /*
   * Clearing out anything an earlier run left open.
   *
   * This used to be one `if (start.proposalOpen)`, because an account could hold
   * exactly one proposal and a stale one blocked the next `propose` outright.
   * An account holds as many as have been raised now, and a stale one blocks
   * nothing on its own — every proposal this run raises takes a FRESH salt
   * and therefore an id no earlier run can have used. So this is
   * housekeeping rather than a precondition: a run interrupted midway leaves
   * proposals behind that nothing will ever spend, and an account carrying a
   * growing pile of them makes every later reading of the chain harder to
   * follow. Cancelled by id, one at a time, because there is no longer any
   * such thing as "the" open proposal.
   */
  const stale = openProposalsOf(start);
  if (stale.length) {
    note(`${stale.length} proposal(s) left open by an earlier run; cancelling each by id`);
    for (const p of stale) {
      await becomeSigner(A, 'A');
      const id = Uint8Array.from(Buffer.from(p.id, 'hex'));
      await callCircuit(`cancel ${p.id.slice(0, 12)}… (left open by an earlier run)`,
        () => found.callTx.cancel(id),
        async () => !isOpen(await readState(), id));
    }
  }

  /* ------------------------------------------------------------------ *
   * 2. Seat a fourth, so the one removed is in the MIDDLE
   *
   * Removing the last signer added would not distinguish a correct slot
   * derivation from several wrong ones. The middle of four does.
   * ------------------------------------------------------------------ */

  const leafD = leafOf(D);
  const addDId = await approvedRound('add D', pureCircuits.signerAddPayload(leafD),
    freshSalt(), approversFrom([['A', A], ['B', B], ['C', C]], start.threshold, 'add D'));
  await becomeSigner(A, 'A');
  // Three arguments. `addDId` names WHICH approved proposal authorises this —
  // the contract recomputes it from the caller's `proposalSalt` and refuses a
  // proposal that commits to a different leaf. `false` asks for a fresh
  // slot: nothing has been vacated yet, and asking to reuse one that does not
  // exist is refused rather than quietly corrected.
  await callCircuit('amendSigner D (seat)', () => found.callTx.amendSigner(leafD, addDId, false, false),
    async () => !!(await readState()).signers.findPathForLeaf(leafD));
  await wasConsumed('add D', addDId);

  const withD = await showSlots('slots after adding D');
  if (withD.D === null) throw new Error('D was not seated');
  good(`D took slot ${withD.D}, a fresh one`);

  /* ------------------------------------------------------------------ *
   * 3. Remove B — the middle one — and check nobody else moved
   * ------------------------------------------------------------------ */

  const leafB = leafOf(B);
  const vacated = withD.B!;
  const removeBId = await approvedRound('remove B', pureCircuits.removeSignerPayload(leafB),
    freshSalt(), approversFrom([['A', A], ['C', C], ['D', D]], start.threshold, 'remove B'));

  await becomeSigner(A, 'A');
  await callCircuit('amendSigner B (unseat)', () => found.callTx.amendSigner(leafB, removeBId, false, true),
    async () => !(await readState()).signers.findPathForLeaf(leafB));
  await wasConsumed('remove B', removeBId);

  const afterRemove = await showSlots('slots after removing B');
  if (afterRemove.B !== null) throw new Error('B is still in the tree');
  if (afterRemove.A !== before.A) throw new Error(`A moved from ${before.A} to ${afterRemove.A}`);
  if (afterRemove.C !== before.C) throw new Error(`C moved from ${before.C} to ${afterRemove.C}`);
  if (afterRemove.D !== withD.D) throw new Error(`D moved from ${withD.D} to ${afterRemove.D}`);
  /*
   * THE MARKER IS READ BACK, and absence of B is not enough.
   *
   * `removeSigner` writes `vacantSlot()` into the slot rather than blanking it,
   * and that distinction IS M-106: a blanked slot has no path in a sparse tree,
   * so the witness can never prove it is free and the slot is lost forever.
   * Both outcomes look identical from "B is no longer in the tree", so checking
   * only that proved the half that was never in doubt.
   */
  const marker = (await readState()).signers.findPathForLeaf(pureCircuits.vacantSlot());
  if (!marker) {
    throw new Error(
      `slot ${vacated} does not hold the vacancy marker — the removal blanked it instead of ` +
        'writing the marker, so nothing can ever prove it is free and the slot is lost',
    );
  }
  if (pureCircuits.slotOf(marker) !== vacated) {
    throw new Error(
      `the vacancy marker is in slot ${pureCircuits.slotOf(marker)}, not the ${vacated} B left`,
    );
  }
  good(
    `B's slot ${vacated} cleared and holds the vacancy marker — A, C and D untouched, ` +
      'which is the whole of M-106',
  );

  const counted = await readState();
  good(`seated signers ${counted.signerLeaves.size()} on chain`);

  /* ------------------------------------------------------------------ *
   * 4. The signers either side of the one removed can still act
   *
   * D is the one a wrong slot derivation would most plausibly have hit, being
   * seated after B. C is the one immediately after B in the tree.
   * ------------------------------------------------------------------ */

  const survivorSalt = freshSalt();
  const survivorPayload = seededBytes(801);
  const survivorId = proposalIdFor(survivorPayload, survivorSalt);
  setProposalSalt(survivorSalt);
  await becomeSigner(A, 'A');
  await callCircuit('propose (can the survivors still act?)',
    () => found.callTx.propose(survivorPayload, ZERO_32, 0n, 0n, 0n, false, pureCircuits.noVault()),
    async () => isOpen(await readState(), survivorId));
  for (const [name, who] of [['C', C], ['D', D]] as [string, AccountPrivateState][]) {
    await becomeSigner(who, name);
    // Per proposal, so an approval landing on some other open proposal cannot
    // be misread as this one's. That was not distinguishable before M-128.
    const was = approvalsFor(await readState(), survivorId);
    await callCircuit(`approve as ${name} (seated either side of the removal)`,
      () => found.callTx.approve(survivorId),
      async () => approvalsFor(await readState(), survivorId) > was);
  }
  good(
    `the survivors approve — ${approvalsFor(await readState(), survivorId)} approvals on that ` +
    'proposal, so their membership proofs still verify',
  );
  await becomeSigner(A, 'A');
  await callCircuit('cancel (the survivors\' proposal)', () => found.callTx.cancel(survivorId),
    async () => !isOpen(await readState(), survivorId));

  /* ------------------------------------------------------------------ *
   * 5. The vacated slot is REUSED
   *
   * Without reuse the tree would bound how many ADDITIONS an account can ever
   * make rather than how many signers it can hold.
   * ------------------------------------------------------------------ */

  const leafE = leafOf(E);
  const addEId = await approvedRound('add E into the vacated slot',
    pureCircuits.signerAddPayload(leafE), freshSalt(),
    approversFrom([['A', A], ['C', C], ['D', D]], start.threshold, 'add E'));
  await becomeSigner(A, 'A');
  // `true` — take the slot B left. The witness finds it by looking for the
  // vacancy marker the removal wrote; a blanked slot would be unfindable,
  // which is what the first version of this design got wrong.
  await callCircuit('addSigner E (reusing B\'s slot)',
    () => found.callTx.amendSigner(leafE, addEId, true, false),
    async () => !!(await readState()).signers.findPathForLeaf(leafE));
  await wasConsumed('add E', addEId);

  const afterReuse = await showSlots('slots after adding E');
  if (afterReuse.E !== vacated) {
    throw new Error(`E took slot ${afterReuse.E}, expected the vacated ${vacated}`);
  }
  good(`E took slot ${vacated} — the one B left, not a fresh one`);

  /* ------------------------------------------------------------------ *
   * 6. The threshold moves, and a proposal below the new one shows it
   * ------------------------------------------------------------------ */

  const live = await readState();
  const raised = live.threshold + 1n;
  if (raised > live.signerLeaves.size()) {
    throw new Error(
      `cannot raise the threshold to ${raised} with ${live.signerLeaves.size()} signers — the contract ` +
      'refuses it, and rightly: above the signer count the bootstrap window reopens (M-37)',
    );
  }

  const raiseId = await approvedRound(`raise the threshold to ${raised}`,
    pureCircuits.setThresholdPayload(raised), freshSalt(), [['A', A], ['C', C]]);
  await becomeSigner(A, 'A');
  await callCircuit(`setThreshold ${raised}`, () => found.callTx.setThreshold(raised, raiseId),
    async () => (await readState()).threshold === raised);
  await wasConsumed(`raise to ${raised}`, raiseId);
  good(`threshold is ${(await readState()).threshold} on chain`);

  /*
   * And it SHOWS UP immediately on the next proposal.
   *
   * The old comment here said the new threshold "BITES", and the step below was
   * offered as proof of it. Read against the contract that was always an
   * overstatement, and it is worth being exact about what changed and what did
   * not. What this checks — then and now — is that a proposal with two approvals
   * reports two against a threshold of three, which is the state in which
   * `requireApproved` refuses. What it does NOT do is submit a call with too few
   * approvals and watch the chain reject it: that costs a full proof to be told
   * something the simulator tests already prove, and this script is here for the
   * things only a real prover and a real ledger can settle.
   *
   * Asserting only that the `threshold` FIELD changed would still be the M-102
   * mistake — that defect was a number that moved in one place and was enforced
   * in another — which is why the count is read back per proposal and compared
   * against the threshold the chain now holds, rather than against a 3 written
   * into this file.
   */
  const biteSalt = freshSalt();
  const bitePayload = seededBytes(802);
  const biteId = proposalIdFor(bitePayload, biteSalt);
  setProposalSalt(biteSalt);
  await becomeSigner(A, 'A');
  await callCircuit('propose (is the new threshold visible on a fresh proposal?)',
    () => found.callTx.propose(bitePayload, ZERO_32, 0n, 0n, 0n, false, pureCircuits.noVault()),
    async () => isOpen(await readState(), biteId));
  /*
   * ONE SHORT OF THE RAISED THRESHOLD, then the one more it now demands.
   *
   * This used to be a hardcoded A and C, then D — correct only when the raised
   * threshold is exactly 3, and silently the wrong test at any other number:
   * two approvals against a threshold of 4 would still read "below", and the
   * third would not reach it, so the run would fail claiming the raise had
   * moved the target too far. The counts are derived from the threshold the
   * chain holds, which is the M-102 rule applied to this file.
   *
   * E IS IN THIS POOL, ahead of D. It is the signer sitting in the reused slot,
   * and this is where it proves a re-seated leaf still produces a membership
   * proof the chain accepts.
   */
  const bitePool: [string, AccountPrivateState][] = [['A', A], ['C', C], ['E', E], ['D', D]];
  const short = approversFrom(bitePool, raised - 1n, 'the threshold check');
  for (const [name, who] of short) {
    await becomeSigner(who, name);
    const was = approvalsFor(await readState(), biteId);
    await callCircuit(`approve (${name})`, () => found.callTx.approve(biteId),
      async () => approvalsFor(await readState(), biteId) > was);
  }

  const two = await readState();
  const twoCount = approvalsFor(two, biteId);
  if (twoCount >= Number(two.threshold)) {
    throw new Error(
      `${twoCount} approvals already meet the raised threshold of ${two.threshold} — ` +
        'the raise did not take',
    );
  }
  good(
    `${twoCount} approvals on that proposal is below the new threshold of ${two.threshold}, ` +
    'as it must be — this is the state in which requireApproved refuses',
  );

  const [lastName, lastWho] = bitePool[short.length];
  await becomeSigner(lastWho, lastName);
  const beforeLast = approvalsFor(await readState(), biteId);
  await callCircuit(`approve (${lastName}) — the one the raise now requires`,
    () => found.callTx.approve(biteId),
    async () => approvalsFor(await readState(), biteId) > beforeLast);

  const three = await readState();
  const threeCount = approvalsFor(three, biteId);
  if (threeCount < Number(three.threshold)) {
    throw new Error(
      `after the extra approval the proposal has ${threeCount} against a threshold of ` +
      `${three.threshold}, so the raise moved the target further than one approval`,
    );
  }
  good(
    `the ${lastName} approval landed: ${threeCount} of ${three.threshold} — the number the ` +
      `raise made necessary, and ${lastName === 'E' ? 'E is the signer in the REUSED slot, so a ' +
      're-seated leaf proves membership on chain' : 'from a signer seated either side of the removal'}`,
  );

  await becomeSigner(A, 'A');
  await callCircuit('cancel (the threshold-check proposal)', () => found.callTx.cancel(biteId),
    async () => !isOpen(await readState(), biteId));

  /* ------------------------------------------------------------------ *
   * 7. And back down again, on the same rule
   * ------------------------------------------------------------------ */

  /*
   * BACK TO WHERE THE RUN FOUND IT, not to a literal 2.
   *
   * `raised` is derived from the chain and the descent was hardcoded, so this
   * script LOWERED the threshold of any account that started above 2 and then
   * printed "threshold back to 2" — a permanent weakening of a live account,
   * reported as a restoration. The one number that makes the run leave no
   * trace is the one it started with.
   */
  const lowered = start.threshold;
  const lowerId = await approvedRound(`lower the threshold to ${lowered}`,
    pureCircuits.setThresholdPayload(lowered), freshSalt(),
    approversFrom([['A', A], ['C', C], ['E', E], ['D', D]], raised, 'lower the threshold'));
  await becomeSigner(A, 'A');
  await callCircuit(`setThreshold ${lowered}`, () => found.callTx.setThreshold(lowered, lowerId),
    async () => (await readState()).threshold === lowered);
  await wasConsumed(`lower to ${lowered}`, lowerId);

  /* ------------------------------------------------------------------ *
   * 8. And none of it moved any money
   *
   * NEW WITH M-125, and cheap enough to be worth stating rather than assuming.
   * Every round above carries the reserved `NONE` asset and a change amount of
   * 0 minor units — see the note where `run-preview.ts` sets `pendingChange`
   * before calling in — and no governance circuit inserts a movement. So the
   * one place money is visible on chain must be exactly what it was when this
   * run started.
   *
   * HALF OF THIS CHECK STOOD HERE AND IS GONE. It compared the whole
   * `assetBalances` map as well, because there was no single `stateCommitment`
   * to compare and a governance circuit writing a balance would have shown up
   * there. The map and the circuits that wrote it went under `C292`/`S26`.
   *
   * WHAT IT STILL PROVES: that a governance run leaves `movements` untouched —
   * no payment was recorded while the account was governing itself. Since
   * `C292` that set is the only on-chain record of a payment, so it is the
   * whole of what "no money moved" can be shown to mean on chain, and keeping
   * this half is the reason the step is still here at all.
   *
   * WHAT IT CAN NO LONGER SEE: a balance the account holds changing without a
   * movement being recorded. There is no balance on chain to look at.
   * ------------------------------------------------------------------ */

  const end = await readState();
  if (end.movements.size() !== movementsBefore) {
    throw new Error(
      `the movement set went from ${movementsBefore} to ${end.movements.size()} entries during ` +
      'a governance run, which records no movements',
    );
  }
  good(
    `no money moved: every round above carried 0 ${NO_ASSET} minor units (the reserved ` +
    `"no asset"), and the ${end.movements.size()} movement(s) on chain are unchanged from ` +
    'the start of this run — the only on-chain record of a payment there is',
  );

  /*
   * `round` USED TO CLOSE THIS LINE and there is nothing to put in its place —
   * the field is gone, and printing a substitute that looked like a sequence
   * number would be inventing a fact. The proposal count is the real equivalent
   * and is what is printed.
   */
  if (end.threshold !== start.threshold) {
    throw new Error(
      `this run started at a threshold of ${start.threshold} and is leaving the account at ` +
        `${end.threshold}. A governance run that changes the account it was only meant to ` +
        'exercise is a defect, not a result.',
    );
  }
  good(
    `threshold back to ${end.threshold}, where this run found it — ${end.signerLeaves.size()} signers, ` +
    `${end.openProposals.size()} proposal(s) left open`,
  );
  const atEnd = await showSlots('slots at the end');
  if (atEnd.B !== null) {
    throw new Error(`B is back in the tree at slot ${atEnd.B} — nothing here should reseat them`);
  }

  console.log();
  console.log('\x1b[32m\x1b[1m  A signer was removed, their slot reused, and the threshold moved\x1b[0m');
  console.log('\x1b[32m\x1b[1m  both ways — all of it settled on chain, and no money moved.\x1b[0m');
  console.log(`  ${hex(leafB).slice(0, 16)}… is in no tree this contract will accept.`);
}

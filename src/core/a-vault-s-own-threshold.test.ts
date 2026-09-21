import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedCommitments } from './ledger.js';
import type { Ledger } from './ledger.js';
import { AccountService, openAccount, approvalMessage } from './account.js';
import { sign } from './crypto.js';
import type { Hex } from './crypto.js';
import { registryWithTestPrivateForms, aVaultHolding, testPrivateToken } from '../testing/assets.js';

/**
 * **R5 — A VAULT'S OWN THRESHOLD DECIDES ITS ROUNDS, ABSENCE INHERITS THE
 * ACCOUNT'S, AND NEITHER NUMBER MAY MAKE A VAULT UNSPENDABLE.** `C172`,
 * and the traps are the contract's own two comments.
 *
 * Three claims, and they fail in three different directions, which is why they
 * are in one file:
 *
 * 1. **A vault somebody gave its own threshold is judged by THAT number**, and
 *    a vault nobody gave one is judged by the account's. **The two sources are
 *    set to DIFFERENT values throughout** — the account holds 3, the vault
 *    holds 2 — because with them equal both rules produce the same answer and
 *    the test would pass against a version that reads either. That is the exact
 *    coincidence `C172` was found underneath: the capability was complete in
 *    the contract, invisible from the application, and nothing went wrong,
 *    because nobody had ever set an exception.
 * 2. **Zero is refused by THIS APPLICATION, before anything is signed.** The
 *    contract refuses it too (`ConfidentialAccount.compact:2121`, *"a vault
 *    threshold of zero would authorise anything"*), and a refusal that only
 *    arrives from the chain arrives after every signer has approved and the fee
 *    is paid. The test asserts the absence of a proposal as well as the throw:
 *    *"before anything is signed"* is a claim about what did NOT happen.
 * 3. **A threshold nobody could meet is refused as well, and that refusal is
 *    OURS.** The circuit deliberately does not bound this by the seat count
 *    (`:2103-2107`) — a vault has no bootstrap window to reopen, and an
 *    unmeetable threshold makes that vault unspendable until a governed round
 *    lowers it, which the contract judges recoverable rather than dangerous.
 *    **Recoverable is not a state this product helps a company reach**, and the
 *    message has to say whose rule stopped them, because the chain would have
 *    accepted it.
 *
 * **THESE TESTS CAN ONLY EVER BE AS GOOD AS `SimulatedLedger`,** which runs in
 * this process. They do not show that a chain applied a vault's threshold. They
 * show that this service asks for the right one, asks once, and has no path
 * left by which the account's number can answer for a vault that has its own.
 */

/** Ada, Blake and Cleo. Threshold 3 of 3, so the account's number is not 2. */
const THREE = [
  { name: 'Ada', role: 'admin' as const },
  { name: 'Blake', role: 'approver' as const },
  { name: 'Cleo', role: 'approver' as const },
];

/**
 * **TWO VAULTS THAT EXIST ONLY AS ADDRESSES, AND THAT IS ALL A VAULT IS HERE.**
 *
 * There is no vault deploy path anywhere in this repository
 * (`docs/vaults.md`), so nothing in these tests deploys one and nothing
 * pretends to. A vault is a `Bytes<32>` key in the contract's `thresholds` map
 * and a value committed inside a proposal's identity — both of which are
 * exercised in full by two constants, because neither the map nor the identity
 * asks whether anything is deployed at that address.
 */
const FAST: Hex = 'a1'.repeat(32);
const SLOW: Hex = 'b2'.repeat(32);

function harness() {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-r5-')), 'db.json'));
  const ledger: Ledger = new SimulatedLedger(SimulatedCommitments);
  const accounts = new AccountService(
    store, ledger, SimulatedCommitments, registryWithTestPrivateForms(), aVaultHolding());
  return { store, ledger, accounts };
}

const entry = (amount: bigint) => ({
  entries: [{
    id: 'e1', kind: 'transfer', asset: 'GBP', amount,
    counterparty: 'a supplier', memo: '', at: '',
  }],
});

/**
 * **A RUN, WHICH IS THE ONLY ROUND THAT MAY NAME A VAULT.**
 *
 *
 * Every case below used to name its vault on a GOVERNANCE round, through
 * `AccountService.propose` or `SimulatedLedger.propose`. **That round cannot
 * exist**: `contracts/src/ConfidentialAccount.compact:2319` asserts
 * `vault == noVault()` on that branch, so the state these tests were built on
 * is one the chain refuses — and both layers now refuse it too, which is what
 * turned five of them red before they were moved here.
 *
 * **SO THE FIXTURE MOVED TO THE DOOR THE CONTRACT ACTUALLY HAS.** A run round
 * carries a real vault (`compact:2115`), lands in `openProposals` with it, and
 * is the one thing `recordPayment` — the single circuit that reads a vault's
 * own threshold — will ever be handed. The property under test is unchanged;
 * what changed is that the round it is tested on is one that can exist.
 *
 * A fresh root per call, because two runs raised in one test must not collide
 * on an id, and `AccountService.proposeRun` requires 64 lower-case hex.
 */
let runNonce = 0;

/** The one payment such a run makes, in the token the test registry gives GBP paid privately. */
const onePayment = (amount: bigint) =>
  [{ payee: { kind: 'shielded' as const }, token: testPrivateToken('GBP'), amount }];

const aRunAt = (vault: Hex) => ({
  root: ((runNonce = (runNonce % 254) + 1)).toString(16).padStart(2, '0').repeat(32),
  payees: 1n,
  opensAt: 1_800_000_000n,
  closesAt: 1_800_003_600n,
  vault,
});

/*
 * A 3-of-N account. IT WAS `fundedAccount` AND IT FUNDED NOTHING THAT MATTERED:
 * the deposit here was scaffolding for the `execute` calls below, and `C292`
 * removed the account's balance along with them. Every assertion in this file
 * is about which THRESHOLD a vault's round is judged by, which the balance
 * never entered.
 */
async function openAccountAt3(h: ReturnType<typeof harness>) {
  return h.accounts.create('Acme', THREE, 3);
}

/**
 * Approves as the NAMED signers, and answers with the last proposal seen.
 *
 * Indices rather than a count, because a count invites `approveAs(…, 1)` then
 * `approveAs(…, 2)` and the second call re-approves as the first signer — which
 * the service correctly refuses with *"already approved"*, from a line that has
 * nothing to do with thresholds. Naming who signs makes the sequence readable
 * and makes a second approval by the same person a thing the test would have to
 * ask for.
 */
async function approveAs(
  h: ReturnType<typeof harness>,
  p: { id: string; digest: Hex; chainId: Hex },
  secrets: Array<{ signerId: string; signingSecret: Hex }>,
  viewingKey: Hex,
  who: number[],
) {
  let last;
  for (const i of who) {
    last = await h.accounts.approve(
      p.id, secrets[i].signerId, sign(approvalMessage(p), secrets[i].signingSecret), viewingKey);
  }
  return last!;
}

/**
 * Gives `FAST` a threshold of 2 on an account whose own threshold is 3.
 *
 * A governed round, driven the whole way rather than written into the ledger by
 * hand: the round is measured against the ACCOUNT's threshold — all three
 * signers — which is itself part of what is being proved. A vault whose bar is
 * 2 must not be able to authorise changes to itself with 2.
 */
async function giveFastItsOwnThreshold(
  h: ReturnType<typeof harness>,
  account: { id: string },
  viewingKey: Hex,
  secrets: Array<{ signerId: string; signingSecret: Hex }>,
) {
  const round = await h.accounts.proposeVaultThresholdChange(
    account.id, viewingKey, FAST, 2, secrets[0].signerId);
  const done = await approveAs(h, round, secrets, viewingKey, [0, 1, 2]);
  expect(done.status).toBe('approved');
  await h.accounts.setVaultThreshold(account.id, viewingKey, FAST, 2);
}

describe('R5: the bar is the vault\'s own, and absence inherits the account\'s', () => {
  it('publishes the exception on the boundary, and only the exception', async () => {
    /*
     * **A ROW PER VAULT IS NOT THE SAME STATE AS AN EXCEPTION**, and this is
     * the assertion that says so. `C172`'s second trap: a map holding the
     * account's own number against every vault agrees with inheritance today
     * and stops agreeing the day the account's threshold moves, while the map
     * goes on reporting the old number.
     *
     * So the boundary must publish ONE entry after one exception is set —
     * `FAST` — and nothing for `SLOW`, which was never mentioned to it.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt3(h);

    const before = (await h.accounts.ledgerStatus(account.id))!;
    expect(before.vaultThresholds).toEqual([]);
    expect(before.threshold).toBe(3);

    await giveFastItsOwnThreshold(h, account, viewingKey, secrets);

    const after = (await h.accounts.ledgerStatus(account.id))!;
    expect(after.vaultThresholds).toEqual([{ vault: FAST, threshold: 2 }]);
    // The account's own number is untouched by a vault's. Two rules, one state.
    expect(after.threshold).toBe(3);
  });

  it('judges a vault that has its own threshold by that threshold, not the account\'s', async () => {
    /*
     * The account requires 3. `FAST` requires 2. Two approvals must be enough
     * for a round against `FAST`, the recorded outcome must name **2** as the
     * bar it was measured against, and the money must actually move — a verdict
     * that says `satisfied` while `execute` refuses would be the two halves
     * disagreeing about the same number, which is the failure the boundary's
     * one-to-one shape exists to prevent.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt3(h);
    await giveFastItsOwnThreshold(h, account, viewingKey, secrets);

    const p = await h.accounts.proposeRun({
      accountId: account.id, viewingKey,
      summary: 'out of the fast vault', payload: entry(25_00n),
      run: aRunAt(FAST), payments: onePayment(25_00n), proposedBy: secrets[0].signerId,
    });

    /*
     * **`vault` IS NOT IN THE RECORDED OUTCOME, AND `proposal.vault` IS WHY.**
     * The outcome carries what the chain said about the round; which vault the
     * round is for is already on the proposal, and it is the value the chain's
     * answer was read against. A second copy in this object would be one more
     * place for the same fact to be written and to disagree.
     */
    const one = await approveAs(h, p, secrets, viewingKey, [0]);
    expect(one.vault).toBe(FAST);
    expect(one.approvalRound).toEqual({ state: 'short', approvals: 1, threshold: 2 });

    const two = await approveAs(h, p, secrets, viewingKey, [1]);
    expect(two.status).toBe('approved');
    expect(two.approvalRound).toEqual({ state: 'satisfied', approvals: 2, threshold: 2 });

    /*
     * A THIRD CHECK STOOD HERE and is deleted with the thing it called.
     * It settled the round through `accounts.execute` and asserted the
     * proposal reached `executed` — the ledger agreeing at 2 as well as our
     * record, which was the point of asserting it twice over.
     *
     * WHAT IS LOST IS THE SECOND WITNESS, not the property: the two assertions
     * above are still our record, and the LEDGER's agreement is now only shown
     * on the refusal side, in the test below. Nothing acts on an approved round
     * any more, so there is nothing left to ask.
     */
  });

  it('judges a vault with no threshold of its own by the account\'s, in the same account', async () => {
    /*
     * **THE SAME ACCOUNT, THE SAME MOMENT, THE OTHER VAULT.** `SLOW` was never
     * given a threshold, so absence must mean inherit and the bar must be 3 —
     * while `FAST`'s exception of 2 is sitting in the very same map.
     *
     * Written as one test with both vaults rather than two tests on two
     * accounts, deliberately: the failure being excluded is a lookup that finds
     * SOMETHING in the map and uses it, and an account with only one vault in
     * play cannot tell that apart from a correct lookup.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt3(h);
    await giveFastItsOwnThreshold(h, account, viewingKey, secrets);

    const p = await h.accounts.proposeRun({
      accountId: account.id, viewingKey,
      summary: 'out of the ordinary vault', payload: entry(25_00n),
      run: aRunAt(SLOW), payments: onePayment(25_00n), proposedBy: secrets[0].signerId,
    });

    const two = await approveAs(h, p, secrets, viewingKey, [0, 1]);
    expect(two.status).toBe('open');
    expect(two.vault).toBe(SLOW);
    expect(two.approvalRound).toEqual({ state: 'short', approvals: 2, threshold: 3 });
    /*
     * `await expect(h.accounts.execute(p.id, viewingKey)).rejects.toThrow(/not
     * approved/)` STOOD HERE — the ledger agreeing rather than merely our
     * record. `C292`, `S26` deleted `accounts.execute`, and nothing else acts
     * on an approved round, so there is no call left to refuse.
     */

    const three = await approveAs(h, p, secrets, viewingKey, [2]);
    expect(three.approvalRound).toEqual({ state: 'satisfied', approvals: 3, threshold: 3 });
  });
});

describe('R5: a vault threshold nobody can meet is refused before anybody signs', () => {
  it('refuses zero, and no proposal exists afterwards', async () => {
    /*
     * **THE ABSENCE IS HALF THE ASSERTION.** *"Refused before anything is
     * signed"* is not shown by a throw: it is shown by there being no round for
     * anybody to sign. A version that raised the proposal and let the chain
     * refuse it at the end would throw here too, from a different place, having
     * spent every signer's attention first.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt3(h);

    await expect(h.accounts.proposeVaultThresholdChange(
      account.id, viewingKey, FAST, 0, secrets[0].signerId,
    )).rejects.toThrow(/zero would authorise anything/);

    expect(h.accounts.listProposals(account.id, viewingKey)).toEqual([]);
    expect((await h.accounts.ledgerStatus(account.id))!.openProposals).toEqual([]);
    expect((await h.accounts.ledgerStatus(account.id))!.vaultThresholds).toEqual([]);
  });

  it('refuses the RESERVED NAME on the apply path too, which is the half nothing guarded', async () => {
    /*
     * **`T-265` `P1`, closed by `S56`, and the shape is the reason it is worth a
     * test rather than a line.**
     *
     * `AccountService.setVaultThreshold`'s own comment said the zero refusal is
     * repeated at the boundary *"because the two are reachable independently"* —
     * and it repeated the zero and not the sentinel. So the raise path refused
     * `noVault()` and the apply path took it. **The apply path is reachable on
     * its own**: `POST /api/accounts/:id/vault-threshold`
     * (`src/server/index.ts:887-899`) types `vault` as
     * `z.string().regex(/^[0-9a-f]{64}$/)`, and `noVault()` is 64 lowercase hex
     * characters, so nothing between the wire and the ledger looked at it.
     *
     * **THE POSITIVE CONTROL AT THE END IS NOT DECORATION.** A refusal test
     * passes just as happily when the method has stopped working altogether, so
     * the same apply path is driven with a REAL vault in the same case and is
     * required to land. That is what makes the two `rejects` above mean *this
     * value is refused* rather than *this method throws*.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt3(h);
    const NONE = SimulatedCommitments.noVault();

    /* The half that was already guarded — kept so the pair is visible together. */
    await expect(h.accounts.proposeVaultThresholdChange(
      account.id, viewingKey, NONE, 2, secrets[0].signerId,
    )).rejects.toThrow(/reserved name for a proposal that concerns no vault/);

    /* The half that was not. */
    await expect(h.accounts.setVaultThreshold(account.id, viewingKey, NONE, 2))
      .rejects.toThrow(/reserved name for a proposal that concerns no vault/);

    /*
     * And nothing was written on the way through. A row against `noVault()` can
     * never be READ — it is not a key the contract's map can hold — so a version
     * that wrote one would look identical from the outside until somebody
     * wondered why the number they set did nothing.
     */
    const after = (await h.accounts.ledgerStatus(account.id))!;
    expect(after.vaultThresholds).toEqual([]);
    expect(after.threshold).toBe(3);
    expect(h.accounts.listProposals(account.id, viewingKey)).toEqual([]);

    /* THE POSITIVE CONTROL: the same apply path, a real vault, and it lands. */
    await giveFastItsOwnThreshold(h, account, viewingKey, secrets);
    expect((await h.accounts.ledgerStatus(account.id))!.vaultThresholds)
      .toEqual([{ vault: FAST, threshold: 2 }]);
  });

  it('refuses a threshold above the seats the LEDGER holds, and says the refusal is ours', async () => {
    /*
     * Four signers' worth of threshold on a three-signer account. The contract
     * would take it (`:2103-2107` says so in as many words) and the vault would
     * become unspendable until another governed round lowered the number.
     *
     * **THE MESSAGE HAS TO SAY WHOSE RULE THIS IS**, because a refusal phrased
     * as the chain's is a promise this product cannot keep: a signer calling
     * the contract directly can still set it.
     *
     * **AND THE OTHER HALF OF THE PAIR IS NOW RUN RATHER THAN QUOTED.**
     * *"The contract would take it"* was, until this round, a claim read off
     * the circuit's own comment. `contracts/test/vault-threshold-recovery.test.ts`
     * now sets a vault threshold of nine on a two-signer account against the
     * REAL compiled circuit and watches it land — and, in the same file, runs
     * the recovery that makes the chain's permissiveness survivable: raise a
     * vault above its seats, watch a payment refused for *"not enough approvals
     * yet"*, lower it by a governed round at the ACCOUNT's threshold, and pay.
     *
     * **SO THE TWO REFUSALS ARE PINNED SEPARATELY AND NEITHER COVERS THE
     * OTHER.** This one is ours and stops a company reaching the unspendable
     * state by accident. It is NOT what makes the recovery possible — that is
     * `requireApproved` inside `setVaultThreshold`, in the contract — so
     * deleting this test does not make anything in that file fail, and a later
     * round must not read the contract's recovery as covering this.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt3(h);

    await expect(h.accounts.proposeVaultThresholdChange(
      account.id, viewingKey, FAST, 4, secrets[0].signerId,
    )).rejects.toThrow(/this company's own policy, applied by this service and not by the chain/);

    expect(h.accounts.listProposals(account.id, viewingKey)).toEqual([]);
    expect((await h.accounts.ledgerStatus(account.id))!.vaultThresholds).toEqual([]);
  });
});

/**
 * **AND THE OTHER HALF OF `R5`, WHICH IS THE HALF THAT WAS MISSING: A
 * GOVERNANCE ROUND IS JUDGED BY THE ACCOUNT'S THRESHOLD AND NEVER BY A
 * VAULT'S.**
 *
 * Everything above this line is the PAYMENT rule — a vault's own number decides
 * rounds against that vault — and it is right. The contract has a second rule
 * beside it that this file never asserted: **governance does not look a vault
 * up at all.** On chain that is two circuits, not one flag:
 * `requireApprovedForVault` (`contracts/src/ConfidentialAccount.compact:1384`)
 * takes the lookup and has exactly ONE caller, `recordPayment` (`:2697`);
 * `requireApproved` (`:1407`) has none, and every governance circuit lands
 * there — `amendSigner` (`:1756`, `:1921`), `setThreshold` (`:2014`),
 * `setVaultThreshold` (`:2775`), `adopt` (`:2810`), `retireVault` (`:2869`).
 * All six measured at source by `S52`.
 *
 * **`SimulatedLedger.requireApproved` TOOK THE LOOKUP UNTIL 4 Sep**, so on the
 * ledger the product actually runs (`src/wiring/selection.ts:144`) a governance
 * round naming a vault with a lowered bar was judged at that lower bar. The
 * consequence is the recovery path: `setThreshold` and `removeSigner` executing
 * below the account's own threshold, and a vault's lowered bar authorising its
 * own further lowering.
 *
 * **WHY THESE TWO DRIVE `SimulatedLedger` DIRECTLY AND NOT `AccountService`,
 * WHICH IS THE WHOLE REASON THE DEFECT SURVIVED EVERY TEST IN THE
 * REPOSITORY.** All four of the service's governance doors hard-code
 * `noVault()` (`src/core/account.ts:1105`, `:1210`, `:1406`, `:1571`), and
 * `noVault()` can never be a key in the map, so **no test written through the
 * service can reach the line at all** — `SC10`'s test-coverage pass measured
 * exactly that and reported the branch dead in every test. A rule the product
 * obeys only because no caller has yet passed the argument that would break it
 * is `C286`'s shape and rule 27's own question, and the answer has to be a test
 * that passes the argument.
 *
 * **THE POSITIVE CONTROL IS NOT OPTIONAL**: each case ends by adding
 * the missing approval and watching the same call SUCCEED, so a service that
 * refused everything could not pass.
 *
 * **WHAT THESE STILL DO NOT SHOW.** That a chain applied a threshold — this is
 * `SimulatedLedger` in this process. And they do not close the second half of
 * the contract's defence: `propose`'s `assert(vault == noVault())` on the
 * governance branch (`:2254`, `C363`) is still not mirrored here, deliberately,
 * both positions written above `SimulatedLedger.propose` under rule 20. That is
 * `T-237`, and it is why these rounds can be raised naming a vault at all.
 */
describe('R5: a governance round is judged by the ACCOUNT\'s threshold, never a vault\'s', () => {
  /**
   * Raises a round through the LEDGER that carries a REAL vault, and answers
   * with the id and the seats.
   *
   * **IT WAS `governanceRoundNaming` AND IT RAISED THE ROUND THROUGH
   * `SimulatedLedger.propose` WITH A VAULT. THAT ROUND CANNOT EXIST.**
   * `contracts/src/ConfidentialAccount.compact:2319` asserts
   * `vault == noVault()` on the governance branch and this layer now mirrors
   * it, so the setup these three cases were built on is a state the chain
   * refuses — which is `C286`'s shape inside the pin that was written to catch
   * `C286`, and it is why the three of them went red the moment the mirror
   * landed.
   *
   * **THE PROPERTY IS UNCHANGED AND THE ROUND IT IS TESTED ON IS ONE THAT CAN
   * EXIST.** A run lands in `openProposals` carrying its vault
   * (`SimulatedLedger.proposeRun`), so `requireApproved` is still handed a
   * proposal whose `vault` is a live key in `vaultThresholds` — which is the
   * only thing the old vault-aware bar ever needed to bite.
   */
  async function runRoundNaming(
    h: ReturnType<typeof harness>,
    account: { id: string },
    viewingKey: Hex,
    vault: Hex,
  ) {
    const opened = openAccount(h.accounts.require(account.id), viewingKey);
    const refs = opened.signers.map(s => ({ signerId: s.id, leaf: s.leafCommitment! }));
    const change = {
      asset: 'GBP', amount: 0n, batchDigest: 'cd'.repeat(32), salt: 'ef'.repeat(32),
    };
    const raised = await h.ledger.proposeRun(account.id, aRunAt(vault), change, refs[0]);
    return { id: raised.proposalId, refs };
  }

  /** The governance round the contract DOES allow: `noVault()`, named out loud. */
  async function governanceRound(
    h: ReturnType<typeof harness>,
    account: { id: string },
    viewingKey: Hex,
    payloadHash: Hex,
  ) {
    const opened = openAccount(h.accounts.require(account.id), viewingKey);
    const refs = opened.signers.map(s => ({ signerId: s.id, leaf: s.leafCommitment! }));
    const change = {
      asset: 'GBP', amount: 0n, batchDigest: 'cd'.repeat(32), salt: 'ef'.repeat(32),
    };
    const noVault = SimulatedCommitments.noVault();
    await h.ledger.propose(account.id, payloadHash, change, refs[0], noVault);
    return { id: SimulatedCommitments.proposalId(payloadHash, change.salt, noVault), refs };
  }

  it('refuses a setThreshold round that has only met the vault it names', async () => {
    /*
     * **THIS IS THE RECOVERY PATH, WHICH IS WHY IT IS THE FIRST CASE.** The
     * account requires 3 and `FAST` requires 2. A round carrying `FAST` is
     * spent at `setThreshold` on two approvals. Under a vault-aware bar that
     * was enough and the account's own threshold moved on two signatures out of
     * three; the third signer never saw it.
     *
     * **THE POSITIVE CONTROL IS THE SECOND MESSAGE AND NOT A SUCCESS**, and
     * that is the change `S55` had to make. The round is a RUN — the only round
     * that may carry a vault — so its payload is a `runPayload` and
     * `setThreshold` will refuse it on the payload no matter how many approvals
     * it has. **What the third approval proves is that the refusal MOVED**:
     * from the threshold gate to the payload check, which is exactly the claim
     * *the gate was the thing refusing, and it was refusing at 3 and not at 2*.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt3(h);
    await giveFastItsOwnThreshold(h, account, viewingKey, secrets);

    const { id, refs } = await runRoundNaming(h, account, viewingKey, FAST);

    await h.ledger.approve(account.id, id, refs[0]);
    await h.ledger.approve(account.id, id, refs[1]);

    /* The vault's bar is met and the account's is not. The account's is the one. */
    await expect(h.ledger.setThreshold(account.id, 1, id, refs[0]))
      .rejects.toThrow(/not enough approvals yet: 2 of 3/);
    expect((await h.ledger.status(account.id))!.threshold).toBe(3);

    await h.ledger.approve(account.id, id, refs[2]);
    await expect(h.ledger.setThreshold(account.id, 1, id, refs[0]))
      .rejects.toThrow(/that proposal is not for this threshold/);
    expect((await h.ledger.status(account.id))!.threshold).toBe(3);
  });

  it('refuses to lower a vault\'s bar on the authority of that same lowered bar', async () => {
    /*
     * **THE SENTENCE THIS CASE EXISTS TO MAKE TRUE.**
     * `SimulatedLedger.setVaultThreshold`'s own comment says *"a vault's own
     * lowered bar can never be the bar that lowers it further — otherwise one
     * governed round down to 1 would make every subsequent change to that vault
     * a single signature."* Until `S52` that sentence was FALSE at source: the
     * bar it named came from `requireApproved`, which looked the vault up.
     * Rule 14 and `C286` — a claim about what the system does, checked when it
     * is written, and this is the check.
     *
     * `FAST` is at 2 and the account at 3, and the round carrying `FAST` is
     * spent at `setVaultThreshold`. Under the old bar two signatures moved it —
     * and from 1, one signature would have moved it thereafter.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt3(h);
    await giveFastItsOwnThreshold(h, account, viewingKey, secrets);

    const { id, refs } = await runRoundNaming(h, account, viewingKey, FAST);

    await h.ledger.approve(account.id, id, refs[0]);
    await h.ledger.approve(account.id, id, refs[1]);

    await expect(h.ledger.setVaultThreshold(account.id, FAST, 1, id, refs[0]))
      .rejects.toThrow(/not enough approvals yet: 2 of 3/);
    expect((await h.ledger.status(account.id))!.vaultThresholds)
      .toEqual([{ vault: FAST, threshold: 2 }]);

    /* The positive control: at three the threshold gate is passed and the
     * refusal becomes the payload's. `FAST` is untouched either way. */
    await h.ledger.approve(account.id, id, refs[2]);
    await expect(h.ledger.setVaultThreshold(account.id, FAST, 1, id, refs[0]))
      .rejects.toThrow(/that proposal does not authorise this vault threshold/);
    expect((await h.ledger.status(account.id))!.vaultThresholds)
      .toEqual([{ vault: FAST, threshold: 2 }]);
  });

  it('judges a round naming a vault whose bar is HIGHER by the account\'s lower one', async () => {
    /*
     * **THE CASE THAT SEPARATES *does not look a vault up* FROM *takes the
     * stricter of the two*, AND IT IS HERE BECAUSE `S52`'s OWN test-coverage pass
     * SHOWED THE FIRST TWO DID NOT.** It demonstrated that
     * `const bar = Math.max(a.threshold, a.vaultThresholds.get(p.vault) ?? 0)`
     * — an implementation that still performs the lookup the contract's
     * `requireApproved` does not have — **passes both cases above**, because
     * both seat the vault BELOW the account and a maximum is then the
     * account's number by coincidence. `C286` in the tests rather than in the
     * source: two instruments agreeing for a reason that is not the property.
     *
     * So this one seats `FAST` ABOVE the account — 5 against 3 — and requires
     * the round to be judged at THREE. A lookup of any kind names five.
     *
     * **AND IT IS NOT A CONTRIVANCE: the ledger deliberately puts no upper
     * bound on a vault's threshold** (`SimulatedLedger.setVaultThreshold` says
     * so, copying `compact:2693-2697` — a vault has no bootstrap window to
     * reopen, so an unmeetable vault threshold is judged recoverable rather
     * than dangerous). It is seated through the LEDGER rather than the service
     * because the service refuses to raise one above the seat count, and that
     * refusal is ours — the case two describes above pins it.
     *
     * **WHICH MAKES THIS THE DIVERGENCE HALF OF THE SAME ROW.** Under a
     * stricter-of-the-two bar this round is refused here and ACCEPTED on chain,
     * so the ledger the product runs and the contract disagree about a
     * governed round — liveness rather than loss, and exactly what this file
     * exists to catch.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt3(h);

    const seat = SimulatedCommitments.vaultThresholdPayload(FAST, 5);
    const seatRound = await governanceRound(h, account, viewingKey, seat);
    for (const r of seatRound.refs) await h.ledger.approve(account.id, seatRound.id, r);
    await h.ledger.setVaultThreshold(account.id, FAST, 5, seatRound.id, seatRound.refs[0]);
    expect((await h.ledger.status(account.id))!.vaultThresholds)
      .toEqual([{ vault: FAST, threshold: 5 }]);

    const { id, refs } = await runRoundNaming(h, account, viewingKey, FAST);
    await h.ledger.approve(account.id, id, refs[0]);
    await h.ledger.approve(account.id, id, refs[1]);

    /* Two is short of the ACCOUNT's three, and the message names three — not
     * five, which is what any lookup would have produced. */
    await expect(h.ledger.setThreshold(account.id, 2, id, refs[0]))
      .rejects.toThrow(/not enough approvals yet: 2 of 3/);

    /* **AND THREE IS ENOUGH TO PASS THE GATE, WHICH IS THE HALF `Math.max`
     * FAILS** — under it the message would still name five here. */
    await h.ledger.approve(account.id, id, refs[2]);
    await expect(h.ledger.setThreshold(account.id, 2, id, refs[0]))
      .rejects.toThrow(/that proposal is not for this threshold/);
    expect((await h.ledger.status(account.id))!.threshold).toBe(3);
  });

  it('judges a GOVERNANCE round by the account, with the SENTINEL seated in the map — `C368`', async () => {
    /*
     * **THE PIN THE OTHER THREE CASES CAN NO LONGER CARRY, AND THIS ROUND'S
     * money-safety pass IS WHY IT IS HERE.**
     *
     * `C376`'s property is *a GOVERNANCE round is judged by the account's
     * threshold, never a vault's*. After `T-237` no governance proposal can
     * carry a vault at all, so the three cases above pin the bar on a RUN fed
     * to a governance method — outcomes right, but resting on this class
     * checking approvals BEFORE the payload, which is the opposite order to the
     * chain. **A future vault-aware bar reached by a genuine governance round
     * would turn nothing red.**
     *
     * **`C368` IS THE STATE THAT RESTORES IT, AND IT IS REACHABLE.**
     * `compact:2778` inserts whatever key `setVaultThreshold` is handed and the
     * contract's *by construction* sentence at `:1372` does not stop it, so the
     * SENTINEL can be a live key in `thresholds`. Seat it at 1 on an account of
     * 3 and a bar that looks the round's own vault up finds 1 — on a round
     * whose vault is `noVault()`, which is every governance round there is.
     *
     * **AND THE POSITIVE CONTROL IS A REAL SUCCESS**, which is what the run
     * cases had to give up: the payload genuinely is `signerThresholdPayload`,
     * so the third approval both passes the gate and moves the number.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt3(h);
    const NONE = SimulatedCommitments.noVault();

    const seat = SimulatedCommitments.vaultThresholdPayload(NONE, 1);
    const seatRound = await governanceRound(h, account, viewingKey, seat);
    for (const r of seatRound.refs) await h.ledger.approve(account.id, seatRound.id, r);
    await h.ledger.setVaultThreshold(account.id, NONE, 1, seatRound.id, seatRound.refs[0]);
    expect((await h.ledger.status(account.id))!.vaultThresholds)
      .toEqual([{ vault: NONE, threshold: 1 }]);

    const payload = SimulatedCommitments.signerThresholdPayload(2);
    const { id, refs } = await governanceRound(h, account, viewingKey, payload);
    await h.ledger.approve(account.id, id, refs[0]);

    /* One approval meets the sentinel's seated bar of 1 and not the account's
     * three, and the account's is the one. */
    await expect(h.ledger.setThreshold(account.id, 2, id, refs[0]))
      .rejects.toThrow(/not enough approvals yet: 1 of 3/);
    expect((await h.ledger.status(account.id))!.threshold).toBe(3);

    await h.ledger.approve(account.id, id, refs[1]);
    await h.ledger.approve(account.id, id, refs[2]);
    await h.ledger.setThreshold(account.id, 2, id, refs[0]);
    expect((await h.ledger.status(account.id))!.threshold).toBe(2);
  });

  it('REFUSES a governance round that names a vault at all — `T-237`, `C367`, `S55`', async () => {
    /*
     * **THE MIRROR ITSELF, AT BOTH LAYERS, AND IT IS THE PIN THE THREE CASES
     * ABOVE USED TO STAND ON.**
     *
     * `contracts/src/ConfidentialAccount.compact:2319` refuses a governance
     * round that names a vault; `S47` wrote this assert into
     * `SimulatedLedger.propose`, measured what it cost and removed it again,
     * and `S55` overturned that decision. Without both halves of this case the
     * simulator accepts a round the contract does not — which on `SIMULATED`
     * wiring (`src/wiring/selection.ts:144`) is the product accepting it.
     *
     * The service half is `C367`: the same refusal one layer up, so it arrives
     * before a fee rather than as a failed transaction after one.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt3(h);
    const opened = openAccount(h.accounts.require(account.id), viewingKey);
    const refs = opened.signers.map(s => ({ signerId: s.id, leaf: s.leafCommitment! }));

    await expect(h.ledger.propose(
      account.id,
      SimulatedCommitments.signerThresholdPayload(2),
      { asset: 'GBP', amount: 0n, batchDigest: 'cd'.repeat(32), salt: 'ef'.repeat(32) },
      refs[0],
      FAST,
    )).rejects.toThrow(/governance round cannot name a vault/);

    await expect(h.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer',
      summary: 'a round scoped to a vault', payload: entry(25_00n),
      vault: FAST, proposedBy: secrets[0].signerId,
    })).rejects.toThrow(/governance round cannot name a vault/);

    /*
     * **THE POSITIVE CONTROL, AND IT IS THE ONE THAT STOPS THIS BEING A DOOR
     * THAT REFUSES EVERYTHING.** The same round with the sentinel is raised,
     * and so is a RUN naming `FAST` — the vault-carrying door is open and it is
     * the branch the contract actually has.
     */
    const fine = await governanceRound(
      h, account, viewingKey, SimulatedCommitments.signerThresholdPayload(2));
    expect(fine.id).toBeTruthy();
    const run = await runRoundNaming(h, account, viewingKey, FAST);
    expect(run.id).toBeTruthy();
  });

  it('refuses a removeSigner round that has only met the vault it names — `T-290`, `S58`', async () => {
    /*
     * **THE FOURTH CALLER, AND UNTIL THIS CASE IT WAS DRIVEN BY NOTHING.**
     * `SimulatedLedger.requireApproved` has exactly four
     * callers — `addSigner`, `removeSigner`, `setThreshold` and
     * `setVaultThreshold` — and the three cases above drive two of them.
     * **`grep -c removeSigner` over this file returned 1 before this case, and
     * that one hit was PROSE** (the consequence sentence a few lines up), so
     * the file named `removeSigner` as the injury and then tested the other
     * door.
     *
     * **WHY THAT IS NOT A FORMALITY.** `removeSigner` is the RECOVERY path, and
     * it is the one the register's own consequence sentence names first:
     * *"`setThreshold` and `removeSigner` executing below the account's own
     * threshold"*. A vault-aware bar here removes a seat on the authority of a
     * vault's lowered number — and the seat is gone, on chain, in a way no
     * later round undoes. The two cases above pin the shared line; this pins
     * that the shared line is actually shared by the caller with the worst
     * consequence.
     *
     * **THE SAME SHAPE AS THE THREE ABOVE, DELIBERATELY**, including the
     * positive control being the SECOND message rather than a success: the
     * round is a RUN, so `removeSigner` refuses it on the payload once the
     * threshold gate is passed. What the third approval proves is that the
     * refusal MOVED — from the bar to the payload — which is the claim.
     */
    const h = harness();
    const { account, viewingKey, secrets } = await openAccountAt3(h);
    await giveFastItsOwnThreshold(h, account, viewingKey, secrets);

    const { id, refs } = await runRoundNaming(h, account, viewingKey, FAST);
    const doomed = refs[2].leaf;
    const before = (await h.ledger.status(account.id))!.signerCount;

    await h.ledger.approve(account.id, id, refs[0]);
    await h.ledger.approve(account.id, id, refs[1]);

    /* `FAST`'s bar is met at 2. The account's is 3, and the account's is the one. */
    await expect(h.ledger.removeSigner(account.id, doomed, id, refs[0]))
      .rejects.toThrow(/not enough approvals yet: 2 of 3/);
    expect((await h.ledger.status(account.id))!.signerCount).toBe(before);

    await h.ledger.approve(account.id, id, refs[2]);
    await expect(h.ledger.removeSigner(account.id, doomed, id, refs[0]))
      .rejects.toThrow(/that proposal is not for this removal/);
    expect((await h.ledger.status(account.id))!.signerCount).toBe(before);
  });
});

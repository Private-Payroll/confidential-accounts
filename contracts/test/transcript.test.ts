/**
 * THE INSTRUMENT THAT READS WHAT A TRANSACTION PUBLISHES. `S50`, board row
 * `2y9f0`, `C389` `P1`.
 *
 * `contracts/test/transcript.ts` is the instrument and its header carries the
 * mechanism. This file is its SELF-TEST and its first real use, and it is
 * organised in the order a sceptic should read it:
 *
 *   1. the runtime really does hand a test a transcript, measured;
 *   2. the instrument can FIND things — the positive control, without which an
 *      absence check is green for no reason;
 *   3. the founder's three priorities over a real cross-contract payout;
 *   4. `SC14`'s worked example: what a LEDGER READ does to the transcript;
 *   5. the PLANTED LEAK, and the instrument going red on it.
 *
 * **THE ACCEPTANCE BAR IS `CHECK-BOARD.command`'s: a check is not real until
 * its first run is clean on correct code and RED on a deliberate leak.** §5 is
 * that plant. It is a real compiled circuit call — nothing is stubbed and no
 * operation is hand-built — and the leak it produces is the exact shape `C389`
 * describes: a private value in a LEDGER READ's argument position.
 *
 * **NOTHING HERE CLAIMS THE CONTRACT LEAKS.** §3 measures the account's payout
 * path CLEAN on two of the three priorities and says plainly why the third is
 * not covered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract as Vault, pureCircuits as vaultCircuits } from '../managed-vault/contract/index.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountSimulator, privateStateFor, change, type Change } from './simulator.js';
import { buildPayoutTree, type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';
import { Transcript, encodeUint, asHex } from './transcript.js';

/* §7 constructs its own vault, so the fixture pieces §3 uses are shared. */

const NOW = 1_800_000_000;
const WIN_FROM = BigInt(NOW - 3_600);
const WIN_UNTIL = BigInt(NOW + 3_600);
const BLOCK = '0'.repeat(64);

const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const A = privateStateFor(1);
const B = privateStateFor(2);

const GBP = bytes(0x9b);
/** A payee's shielded public key. THIS IS "WHO IS BEING PAID". */
const ALICE = bytes(0x0a);
const BOB = bytes(0x0b);
const CAROL = bytes(0x0c);

/** THIS IS "HOW MUCH". Three distinct amounts, so a hit names one of them. */
const TO_ALICE = 250n;
const TO_BOB = 400n;
const TO_CAROL = 700n;

interface VaultPrivate {
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
}
const vaultWitnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
};
const govChange = (seed: number): Change => change(0n, seed);

describe('S50 §1 — the runtime hands a test the public transcript of a real circuit call', () => {
  /*
   * THE MEASUREMENT THE ROUND'S BRIEF SAID WOULD OUTRANK EVERYTHING ELSE IF IT
   * CAME OUT THE OTHER WAY. It did not: the field is populated, on the calls
   * this repository's tests already make, with no new plumbing.
   *
   * `proof-data.d.ts:13` declares it, `circuit-context.d.ts:124` threads it,
   * and `contracts/managed/contract/index.js:323` finalises it. This asserts
   * the three of them are true together at runtime rather than in a type.
   */
  it('a governance propose publishes a non-empty transcript, and the instrument reads it', async () => {
    const sim = await AccountSimulator.liveAccount([A], 1n);
    const tape = Transcript.watch(sim.contract).clear();

    await sim.propose(bytes(7));

    const t = tape.last;
    t.assertNotVacuous();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.circuitId).toBe('propose');
    /*
     * NOT `toBe(22)`. A pin on the op count is a number nothing certifies and
     * this repository has `T-247` and `T-255` as two separate rulings against
     * hand-written counts beside instruments. What matters is that there is a
     * transcript with ledger operations in it.
     */
    expect(t.opCount).toBeGreaterThan(0);
    expect(t.calls[0]!.tags).toContain('member');
    tape.stop();
  });
});

describe('S50 §2 — the positive control: the instrument can find what IS published', () => {
  /*
   * **WITHOUT THIS, EVERY ABSENCE ASSERTION BELOW IS WORTHLESS.**
   * `scripts/cross-contract-spike.ts:144` hand-builds an EMPTY
   * `publicTranscript` and every claim over it would be green — that is the
   * failure this repository already contains an example of, and this is the
   * check that makes it impossible here.
   */
  it('finds the run window, which the contract writes to runWindow in the clear', async () => {
    const sim = await AccountSimulator.liveAccount([A], 1n);
    sim.at(NOW);
    const tape = Transcript.watch(sim.contract).clear();
    const c = govChange(41);
    const tree = buildPayoutTree([{ details: toHex(bytes(1)), nonce: toHex(bytes(101)) }]);

    await sim.as(sim.applying(A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: bytes(0xa1),
    });

    /*
     * A run's window is PUBLIC and is meant to be: `C356`, ruled accepted for
     * v1 — the amount, the recipient and the asset are private; the run TIMING
     * is not. So this is the right thing to demand the instrument can see.
     */
    tape.last.assertPublishes({
      'the moment the run window opens': WIN_FROM,
      'the moment the run window closes': WIN_UNTIL,
    });
    tape.stop();
  });

  it('encodes a Uint the way the VM does, or every absence claim is vacuous', () => {
    /*
     * MEASURED AGAINST THE TRANSCRIPT ABOVE, NOT ASSUMED. Little-endian,
     * minimal length, zero as the empty string. A big-endian needle would
     * never match anything and every `assertAbsent` would pass by not looking.
     */
    expect(encodeUint(WIN_FROM)).toBe('f0c3496b');
    expect(encodeUint(WIN_UNTIL)).toBe('10e0496b');
    expect(encodeUint(250n)).toBe('fa');
    expect(encodeUint(3n)).toBe('03');
    expect(encodeUint(0n)).toBe('');
    expect(asHex(ALICE)).toBe(hex(ALICE));
  });
});

describe('S50 §3 — the founder\'s three priorities, over a real cross-contract payout', () => {
  /*
   * THE CALL IS THE PRODUCT'S OWN MONEY PATH, NOT A FIXTURE SHAPED LIKE ONE: a
   * vault pays one payee of an approved run by calling into the account, both
   * contracts execute, and the returned context carries the transcript of BOTH.
   * `vault-payout.test.ts` is where that arrangement is established and
   * explained; this borrows it to read the other channel.
   *
   * The three, in the founder's own words:
   *   "how much is the company paying out"  — COVERED, §3a
   *   "who is it paying to"                 — COVERED, §3b
   *   "how many payouts is it issuing"      — NOT COVERED, §3c, and why
   */
  let sim: AccountSimulator;
  let vault: any;
  let vaultAddr: string;
  let vaultState: any;
  let priv: VaultPrivate;

  const provider = () => ({
    getContractState: async (_b: string, address: unknown) =>
      String(address) === String(sim.address) ? (sim.contractStateForCall as never) : undefined,
  });

  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    vault = new (Vault as any)(vaultWitnesses as never);
    vaultAddr = sampleContractAddress() as never as string;
    const init = await vault.initialState(
      createConstructorContext({} as VaultPrivate, BLOCK),
      { bytes: Uint8Array.from(Buffer.from(String(sim.address), 'hex')) } as never);
    vaultState = init.currentContractState;
    const coin = { nonce: bytes(0x77), color: GBP, value: 5_000n };
    priv = { coin: { ...coin, mt_index: 0n } };
    const dep = await vault.impureCircuits.deposit(
      createCircuitContext<VaultPrivate>(
        'deposit' as never, vaultAddr as never, BLOCK, vaultState, priv),
      coin);
    vaultState = dep.context.callContext.currentQueryContext.state;
  });

  /** A three-payee run, approved, and everything a payer needs to pay one. */
  const approvedRun = async (c: Change) => {
    const payments = [
      { to: ALICE, amount: TO_ALICE, nonce: 0xc1 },
      { to: BOB, amount: TO_BOB, nonce: 0xc2 },
      { to: CAROL, amount: TO_CAROL, nonce: 0xc3 },
    ];
    const leaves: PayoutLeafInput[] = payments.map((p, i) => ({
      details: toHex(vaultCircuits.payoutDetails(p.to, GBP, p.amount, bytes(0x40 + i))),
      nonce: toHex(bytes(p.nonce)),
    }));
    const tree = buildPayoutTree(leaves);
    const payload = pureCircuits.runPayload(
      fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL);
    const vaultBytes = Uint8Array.from(Buffer.from(vaultAddr, 'hex'));
    await sim.as(sim.applying(A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes,
    });
    const id = sim.proposalId(payload, c.salt, vaultBytes);
    await sim.as(sim.applying(A, c)).approve(id);
    await sim.as(sim.applying(B, c)).approve(id);
    return { tree, id, leaves, vaultBytes };
  };

  /** Pays ALICE her 250, through both contracts, and hands back the transcript. */
  const payAlice = async (c: Change) => {
    const run = await approvedRun(c);
    const r = await vault.impureCircuits.payout(
      createCircuitContext<VaultPrivate>(
        'payout' as never, vaultAddr as never, BLOCK, vaultState, priv,
        provider() as never, undefined, undefined, NOW, BLOCK),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, TO_ALICE, bytes(0x40), bytes(0xc1), run.tree.pathFor(0) as never);
    return { run, transcript: Transcript.of(r.context) };
  };

  it('THE HEADLINE: a real payout publishes neither the amount nor the payee', async () => {
    const { transcript } = await payAlice(govChange(51));

    /*
     * BOTH CONTRACTS' TRANSCRIPTS, not just the entry circuit's. The trace is
     * depth-first, so the account's `recordPayment` is first and the vault's
     * `payout` is last. A check that read only one of them would be a check
     * that stops at the contract boundary, which is the boundary money crosses.
     */
    transcript.assertNotVacuous();
    expect(transcript.calls.map((c) => c.circuitId)).toEqual(['recordPayment', 'payout']);

    transcript.assertAbsent({
      // §3a — HOW MUCH.
      'the amount paid to this payee': TO_ALICE,
      'an amount approved for another payee in the same run': TO_BOB,
      'a third amount in the same run': TO_CAROL,
      // §3b — WHO.
      'the payee being paid': ALICE,
      'another payee of the same run': BOB,
      'a third payee of the same run': CAROL,
      // and the asset, which the founder's list treats as part of "how much".
      'the token being paid in': GBP,
    });
  });

  it('§3a HOW MUCH — the amount survives being the thing the whole call is about', async () => {
    /*
     * The amount is an argument to `payout` and it is in `PartialProofData.input`
     * in the clear. **`input` IS NOT PUBLIC** — it is the proof's witness, and
     * `docs/corrections.md` carries the standing form of that distinction. What
     * this asserts is the public half: no operation in either contract's
     * transcript carries the number.
     *
     * **AND THE HONEST BOUND, WHICH IS §5's SUBJECT: the shielded OUTPUT that
     * actually moves the money is a Zswap coin, and Zswap outputs are not in
     * this transcript at all.** So the sentence this test earns is *the two
     * contracts do not publish the amount*, and not *nobody can see it*.
     */
    const { transcript } = await payAlice(govChange(52));
    expect(transcript.occurrences(TO_ALICE)).toHaveLength(0);
    expect(transcript.occurrences(5_000n)).toHaveLength(0); // nor the vault's balance
  });

  it('§3b WHO — the payee is thirty-two bytes and none of them reach the transcript', async () => {
    /*
     * A 32-byte needle cannot collide with a ledger field index or a small
     * constant, so a hit here would not need reading. **THAT IS A STATEMENT
     * ABOUT COLLISIONS AND NOT ABOUT SOUNDNESS**, and §6 is the reason the
     * distinction is written out: a needle at the wrong WIDTH misses silently,
     * and the first version of this file had exactly that defect.
     */
    const { transcript, run } = await payAlice(govChange(53));
    for (const who of [ALICE, BOB, CAROL]) {
      expect(transcript.occurrences(who)).toHaveLength(0);
    }
    /* Nor the payout leaf, which commits to the payee and the amount together. */
    expect(transcript.occurrences(fromHex(run.tree.leaves[0]!))).toHaveLength(0);

    /*
     * **AND THE SENTENCE THAT ABSENCE ALONE WOULD LET A READER GET WRONG.**
     * The leaf is not published; a DOMAIN-SEPARATED, UNBLINDED HASH OF IT is —
     * `paidMovementOf(leaf) = persistentHash(["…:paid:", leaf])`,
     * `ConfidentialAccount.compact:1082-1085`, inserted into `movements`.
     * **So anyone who can reconstruct a candidate leaf can confirm from public
     * data that that payment happened, and by design every signer can**
     * (`docs/accepted-risks.md` §1 rests on that). An instrument that reported
     * only "the leaf is absent" would be telling the truth and leaving a reader
     * with a false impression, which is what §5 of the build log is about.
     */
    transcript.assertPublishes({
      'the movement, which is an unblinded hash of the payout leaf':
        pureCircuits.paidMovementOf(fromHex(run.tree.leaves[0]!)),
    });
  });

  it('and BOTH contract addresses are published, which absence claims must not obscure', async () => {
    /*
     * `C356` already rules that which contract a transaction calls is public on
     * Midnight. This is that fact, measured for the first time rather than
     * read: the cross-contract call publishes the callee's address, and the
     * vault publishes its own. A privacy document may say the payee is private;
     * it may not say the transaction is unattributable to a company.
     */
    const { transcript } = await payAlice(govChange(55));
    transcript.assertPublishes({
      'the account contract being called': Uint8Array.from(Buffer.from(String(sim.address), 'hex')),
      'the vault contract making the call': Uint8Array.from(Buffer.from(vaultAddr, 'hex')),
    });
  });

  it('§3c HOW MANY — NOT COVERED, and this test records why rather than pretending', async () => {
    const { transcript, run } = await payAlice(govChange(54));
    expect(run.tree.payees).toBe(3n);

    /*
     * **TWO SEPARATE REASONS, AND ONLY THE SECOND IS THE REAL ONE.**
     *
     * (1) WIDTH. A `Uint<64>` of 3 encodes as the single byte `03`, and so does
     *     the ledger field index of `approvalCounts`. The instrument therefore
     *     reports occurrences of `03` in every transcript that touches that
     *     field, and every one of them is structural. Absence claims stay
     *     sound — a value that is not there is not there — but a PRESENCE
     *     claim at this width is unreadable without opening the op, which is
     *     why `Published` carries its op index and kind.
     *
     * (2) **THE COUNT IS NOT A SINGLE-TRANSACTION FACT.** `C356`, ruled
     *     accepted for v1: the payout COUNT and the run TIMING are public and
     *     the headcount is inferable from settlement transactions. A run of
     *     three payees is three `recordPayment` transactions on chain. **No
     *     instrument that reads one transaction's transcript can see that, and
     *     an instrument that reported this priority GREEN would be making
     *     precisely the claim `C356` says is false.**
     *
     * So this test asserts the measurement it can make — that the count is not
     * pushed as a value by these two circuits — and refuses the claim it
     * cannot.
     */
    const three = transcript.occurrences(3n);
    /*
     * **THIS LINE FIRST, AND IT IS NOT DECORATION.** Without it both assertions
     * below pass over an empty result set and the comment above them claims a
     * collision the test never required to exist — `C238`/`C263`'s shape, a
     * check that cannot fail, in the file whose whole subject is checks that
     * cannot fail.
     */
    expect(three.length).toBeGreaterThan(0);
    const asValue = three.filter((p) => p.kind === 'push');
    expect(asValue).toHaveLength(0);
    /* And every hit is structural, which is why this priority is open. */
    expect(three.every((p) => p.kind === 'key' || p.kind === 'popeq')).toBe(true);
  });
});

describe('S50 §4 — SC14\'s worked example: what a LEDGER READ does to the transcript', () => {
  /*
   * **THE CASE THAT MOVED THIS ROW TO THE FRONT** — and the framing needs one
   * correction before the measurement, because `S50`'s brief and `SC16` do not
   * agree and rule 20 says `SC16` is the source.
   *
   * **`SC16` DID NOT LEAVE `assert(vaults.member(disclose(vault)), …)` OPEN AS
   * A NEUTRAL ALTERNATIVE.** `docs/build-log.md:28558` §2 is
   * *"RECOMMENDATION: COMPILE `S48`'s ASSERT AS IT STANDS. BUILD NEITHER HALF
   * OF THE PAIR"*, and its reason is that nothing in this system can satisfy
   * the check: no product code and no door has ever adopted a vault, so the
   * assert would refuse every run this system can raise. **The publicity cost
   * measured below is one input to a question `SC16` had already answered *not
   * now* on grounds this round does not touch.**
   *
   * What `S49` §3 warned about still stands and is what the measurement is
   * for: a round reading `C388`'s reasoning would conclude such a check
   * publishes nothing because it writes no ledger field.
   *
   * **IT DOES NOT NEED TO BE BUILT TO BE MEASURED, BECAUSE THE SHIPPING
   * CONTRACT ALREADY CONTAINS ONE.** `ConfidentialAccount.compact:1359` —
   * `thresholds.member(vault) ? thresholds.lookup(vault) : threshold` — is a
   * ledger read on the run's vault, reached by `recordPayment` through
   * `requireApprovedForVault`, and `contracts/managed/contract/index.js:1617-1633`
   * compiles it to `dup / idx(6n) / push(cell(vault)) / member / popeq`.
   *
   * So `SC14` can weigh the membership check's PUBLICITY by measurement:
   * `recordPayment` publishes the vault id today, `propose` does not, and
   * adding `vaults.member(disclose(vault))` to `propose` would put the same
   * five operations into `propose`'s transcript.
   *
   * **THE LAST STEP OF THAT IS AN INFERENCE AND IS WRITTEN AS ONE — RULE 9.**
   * What is measured is `thresholds.member(vault)` inside `recordPayment`.
   * That `vaults.member(…)` inside `propose` would compile the same way follows
   * from both being `Set.member` on a `Bytes<32>`; it has not been compiled and
   * rule 1 forbids a session to compile it.
   *
   * **AND THE SHAPE OF THE NEW DISCLOSURE, WHICH IS NOT THE SAME AS THE OLD
   * ONE:** `propose` publishing the vault id links a run to a vault AT RAISE
   * TIME — before any settlement, including for runs later cancelled and never
   * paid. `C356` accepts the vault address being visible on SETTLEMENT
   * transactions. Those are different disclosures and `SC14` needs the
   * difference stated, not the ops count.
   */
  it('a ledger read pushes its argument into the transcript verbatim and writes nothing', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    const VAULT = bytes(0xa1);
    const c = govChange(61);
    const payments = [{ details: toHex(bytes(1)), nonce: toHex(bytes(101)) }];
    const tree = buildPayoutTree(payments);
    const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL);
    await sim.as(sim.applying(A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: VAULT,
    });
    const id = sim.proposalId(payload, c.salt, VAULT);
    await sim.as(sim.applying(A, c)).approve(id);
    await sim.as(sim.applying(B, c)).approve(id);

    /* Only the payment is recorded, so the fixture's own calls do not count. */
    const tape = Transcript.watch(sim.contract).clear();
    const before = JSON.stringify(sim.ledger, (_k, v) =>
      v instanceof Uint8Array ? hex(v) : typeof v === 'bigint' ? String(v) : v);

    await sim.as(sim.applying(A, c)).recordPayment({
      proposal: id, vault: VAULT, root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, salt: c.salt,
      details: fromHex(payments[0]!.details), nonce: fromHex(payments[0]!.nonce),
      path: tree.pathFor(0),
    });

    const t = tape.last;
    tape.stop();

    /* THE FIRST HALF: the read's argument is in the transcript, as a `push`. */
    const hits = t.occurrences(VAULT);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.kind === 'push')).toBe(true);
    expect(t.calls[0]!.tags).toContain('member');

    /*
     * THE SECOND HALF, AND IT IS THE WHOLE OF `C389`: THE EXISTING GUARD RAIL
     * CANNOT SEE IT. `signer-governance.test.ts:496` counts occurrences in
     * `JSON.stringify(sim.ledger, …)` before and after an action. Run that
     * method here, over the same value, across the same call — and it reports
     * no change, because the read stored nothing.
     */
    const after = JSON.stringify(sim.ledger, (_k, v) =>
      v instanceof Uint8Array ? hex(v) : typeof v === 'bigint' ? String(v) : v);
    const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;
    expect(occurrences(after, hex(VAULT))).toBe(occurrences(before, hex(VAULT)));
  });

  it('and `propose` does NOT read the vault today, which is the number SC14 needs', async () => {
    /*
     * The other half of the measurement, and the one that makes it a decision
     * rather than a warning: `propose`'s transcript carries no vault id, so the
     * membership check `SC16` weighed would ADD one. Rule 42a: a value, not a
     * verdict — what the change costs in publicity is measured here; whether to
     * make it is `SC14`'s and the founder's.
     */
    const sim = await AccountSimulator.liveAccount([A], 1n);
    sim.at(NOW);
    const VAULT = bytes(0xa1);
    const tape = Transcript.watch(sim.contract).clear();
    const c = govChange(62);
    const tree = buildPayoutTree([{ details: toHex(bytes(1)), nonce: toHex(bytes(101)) }]);
    await sim.as(sim.applying(A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: VAULT,
    });
    const t = tape.last;
    tape.stop();

    expect(t.calls[0]!.circuitId).toBe('propose');
    expect(t.occurrences(VAULT)).toHaveLength(0);
  });
});

describe('S50 §5 — THE SENSITIVITY CONTROL: the instrument goes red, and what that does and does not prove', () => {
  /*
   * **A PRIVACY INSTRUMENT THAT HAS NEVER GONE RED IS ONE NOBODY CAN TRUST**,
   * and this project has `C302`, `C286` and rule 27 as three separate names for
   * that failure. So the instrument is made to go red here, permanently, on a
   * real compiled circuit call — nothing stubbed, no hand-built operation.
   *
   * **AND THE HONEST LABEL, WHICH IS THIS ROUND'S `money-safety-auditor`'s AND
   * NOT MINE. THIS IS A SENSITIVITY CONTROL AND NOT A DEMONSTRATED LEAK.**
   * The value put into the ledger read's argument is the VAULT IDENTIFIER, and
   * the vault identifier is PUBLIC by the founder's own ruling — `C356`, 1 Sep:
   * the vault address of payouts is accepted public for v1, and which contract
   * a transaction calls is public on Midnight anyway. On every real path that
   * argument is `disclose(kernel.self().bytes)`, the vault's own address; a
   * vault cannot put anything else there. So this test names one constant twice
   * and calls one of the names private.
   *
   * **WHAT IT THEREFORE PROVES, EXACTLY:** the instrument can see a 32-byte
   * value carried into the public transcript by a ledger read's argument, and
   * the ledger-state guard rail cannot see the same value on the same call.
   * **WHAT IT DOES NOT PROVE: that this contract can leak a private value.**
   *
   * **AND NO PLANT A SESSION MAY BUILD COULD PROVE THAT**, which is worth
   * writing down rather than leaving as a gap: the contract is BYTE-IDENTICAL
   * between §3's green run and this red one, because rule 1 forbids a round to
   * touch `.compact` or recompile. A mutation-based control is the missing one
   * and `MUTATE.command` cannot supply it — it mutates only the two `.compact`
   * files, which is `T-189`'s standing subject.
   */
  const plantedLeak = async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    /* The payee's own key, put where the contract performs a ledger read. */
    const LEAKED = ALICE;
    const c = govChange(71);
    const payments = [{ details: toHex(bytes(1)), nonce: toHex(bytes(101)) }];
    const tree = buildPayoutTree(payments);
    const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL);
    await sim.as(sim.applying(A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: LEAKED,
    });
    const id = sim.proposalId(payload, c.salt, LEAKED);
    await sim.as(sim.applying(A, c)).approve(id);
    await sim.as(sim.applying(B, c)).approve(id);

    const tape = Transcript.watch(sim.contract).clear();
    /* The ledger channel, read exactly the way `signer-governance.test.ts:496`
     * reads it — same stringifier, same before/after occurrence count. */
    const publicState = () => JSON.stringify(sim.ledger, (_k, v) =>
      (v instanceof Uint8Array ? hex(v) : typeof v === 'bigint' ? String(v) : v));
    const before = publicState();

    await sim.as(sim.applying(A, c)).recordPayment({
      proposal: id, vault: LEAKED, root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, salt: c.salt,
      details: fromHex(payments[0]!.details), nonce: fromHex(payments[0]!.nonce),
      path: tree.pathFor(0),
    });
    const t = tape.last;
    tape.stop();
    return { sim, transcript: t, before, after: publicState(), leaked: LEAKED };
  };

  it('the SAME assertion that passes in §3 fails here, and says which op', async () => {
    const { transcript: t } = await plantedLeak();

    let caught: Error | undefined;
    try {
      t.assertAbsent({ 'the payee being paid': ALICE });
    } catch (e) { caught = e as Error; }

    expect(caught, 'THE INSTRUMENT DID NOT GO RED ON A VALUE IT CAN SEE').toBeDefined();
    expect(caught!.message).toContain('PUBLISHES A VALUE THIS TEST CALLS PRIVATE');
    expect(caught!.message).toContain('the payee being paid');
    /* It names the operation, because "expected 1 to be 0" teaches nobody. */
    expect(caught!.message).toMatch(/recordPayment op \d+ as a push/);
  });

  it('and the LEDGER-STATE guard rail stays green on the same call — which is C389', async () => {
    /*
     * **THE POINT OF THE WHOLE ROUND, IN ONE ASSERTION.** The leaked value
     * never enters ledger state, so the method `signer-governance.test.ts:496`
     * uses — counting occurrences in `JSON.stringify(sim.ledger, …)` — reports
     * nothing wrong. Two channels; a claim needs both; and until this file only
     * one of them was ever read.
     */
    const { sim, transcript, before, after, leaked } = await plantedLeak();

    /* The transcript channel SEES it. */
    expect(transcript.occurrences(leaked).length).toBeGreaterThan(0);
    expect(transcript.occurrences(leaked).some((h) => h.kind === 'push')).toBe(true);

    /* The ledger channel — the ONLY channel this repository could read until
     * today — reports nothing at all. Same call, same value, same moment. */
    const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;
    expect(occurrences(after, hex(leaked))).toBe(occurrences(before, hex(leaked)));

    /*
     * **AND THE REASON IT REPORTS NOTHING IS WORSE THAN THE CHANNEL, WHICH IS A
     * FINDING THIS ROUND DID NOT GO LOOKING FOR AND DOES NOT FIX.** `T-256`.
     *
     * `JSON.stringify(sim.ledger, …)` renders EVERY container field as `{}`.
     * `signers`, `signerLeaves`, `openProposals`, `movements`, `vaults`,
     * `approvals` — all of them. Only the scalar fields survive: on a live
     * 2-of-2 account the whole string is 290 characters and contains neither
     * signer's leaf, though `signerLeaves` holds both.
     *
     * So the before/after occurrence counts at
     * `contracts/test/signer-governance.test.ts:536` and `:1031` compare 0 with
     * 0 for every identifying value, and cannot go red for the thing they are
     * written to catch.
     *
     * **THE TWO SITES ARE NOT EQUALLY BAD AND THE FINDING MUST SAY SO.**
     * `:536`'s test has a half that is NOT vacuous — `:552-557` iterates
     * `sim.ledger.approvals` directly rather than stringifying it, and that
     * half is real. **`:1031`'s test has no such half: its closing line
     * `expect(after).not.toContain(hex(sim.publicKeyOf(FA)))` asserts a public
     * key is missing from 290 characters of `{}`. That site is vacuous end to
     * end.**
     *
     * The string is not entirely inert — `threshold` and `successor` are
     * scalars and do render — so a change to one of those two fields could
     * still move it. **For the identifying values those tests name, leaves and
     * public keys, it is 0 against 0.**
     *
     * **NOTHING LEAKS AND NOTHING IS BEING FIXED HERE.** `S50`'s brief forbids
     * rewriting that guard rail and it is right to: it checks a real channel
     * and its second half checks it correctly. This is recorded, at the place a
     * later round will meet it, as a measurement — `C302`, `C286` and rule 27's
     * shape on the OTHER channel from the one this round was convened for.
     */
    expect(before).toBe(after);
    expect(before).not.toContain(hex(sim.leafOf(A)));
  });
});

describe('S50 §6 — THE DEFECT THE AUDITOR FOUND IN THIS INSTRUMENT, PINNED', () => {
  /*
   * **THE FIRST VERSION OF `transcript.ts` REPORTED "NOT PUBLISHED" FOR ROUGHLY
   * ONE PAYEE IN 256, AND REPORTED IT GREEN.**
   *
   * `CompactTypeBytes.toValue`
   * (`node_modules/@midnight-ntwrk/compact-runtime/dist/compact-types.js:409-414`)
   * strips TRAILING ZERO BYTES, and `_descriptor_0`
   * (`contracts/managed/contract/index.js:4`) is that type on every 32-byte
   * `push` — including the `push(cell(vault))` at `:1617-1633` this round's
   * worked example is built on. The needle was built at full width. A payee key
   * ending in `0x00` therefore reached the transcript as 31 bytes, missed a
   * 32-byte needle, and `assertAbsent` returned green over a value sitting in
   * plain sight.
   *
   * **THE LOUD DIRECTION WAS SAFE AND THE QUIET ONE WAS NOT**, which is the
   * whole reason it survived: `assertPublishes` fails when it cannot find
   * something; `assertAbsent` succeeds. That is `C286`'s and rule 27's shape,
   * inside the instrument built to catch it.
   *
   * **IT IS `C369` ON THE OTHER SIDE OF THE SAME RUNTIME, AT THE SAME ODDS**, and
   * `C369`'s own sentence is why nothing found it: a 1-in-256 defect on a
   * deterministic corpus is invisible until the corpus moves. Every needle in
   * this file is `bytes(0x0a)`, `bytes(0x9b)`, `bytes(0xa1)` — repeated
   * constants that can never exhibit it.
   *
   * **SO THE VALUE HERE IS CONSTRUCTED AND NOT HOPED FOR**, and it is pinned at
   * BOTH ends: the encoding is what the VM writes, and the instrument finds it.
   */
  const TRAILING_ZERO = (() => {
    const b = new Uint8Array(32).fill(0x0a);
    b[31] = 0x00;                 // the one byte that broke it
    return b;
  })();

  it('encodes a Bytes needle the way the VM writes the value', () => {
    expect(hex(TRAILING_ZERO)).toHaveLength(64);
    /* 31 bytes, not 32 — this is the assertion the first version failed. */
    expect(asHex(TRAILING_ZERO)).toHaveLength(62);
    expect(asHex(TRAILING_ZERO)).toBe(hex(TRAILING_ZERO.slice(0, 31)));
    /* And a value with no trailing zero is untouched. */
    expect(asHex(ALICE)).toBe(hex(ALICE));
  });

  it('FINDS a published 32-byte value whose last byte is zero', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    const c = govChange(91);
    const payments = [{ details: toHex(bytes(1)), nonce: toHex(bytes(101)) }];
    const tree = buildPayoutTree(payments);
    const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL);
    await sim.as(sim.applying(A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: TRAILING_ZERO,
    });
    const id = sim.proposalId(payload, c.salt, TRAILING_ZERO);
    await sim.as(sim.applying(A, c)).approve(id);
    await sim.as(sim.applying(B, c)).approve(id);

    const tape = Transcript.watch(sim.contract).clear();
    await sim.as(sim.applying(A, c)).recordPayment({
      proposal: id, vault: TRAILING_ZERO, root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, salt: c.salt,
      details: fromHex(payments[0]!.details), nonce: fromHex(payments[0]!.nonce),
      path: tree.pathFor(0),
    });
    const t = tape.last;
    tape.stop();

    /* THE PIN. Before the fix this was 0 and the suite was green. */
    const hits = t.occurrences(TRAILING_ZERO);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.kind === 'push')).toBe(true);

    /* And it is genuinely the truncated form that is on the wire. */
    expect(t.published.some((p) => p.hex === hex(TRAILING_ZERO))).toBe(false);
    expect(t.published.some((p) => p.hex === hex(TRAILING_ZERO.slice(0, 31)))).toBe(true);
  });
});

describe('S50 §7 — the tape keeps the whole call tree, not the entry circuit', () => {
  /*
   * **THE SECOND DEFECT THE AUDITOR FOUND, AND IT WAS LATENT RATHER THAN
   * LIVE.** `Tape` recorded `trace[trace.length - 1]`, which by the SDK's own
   * depth-first ordering (`circuit-context.d.ts:81-85`) is the ROOT call alone,
   * while the comment above it claimed it held *"this call and everything under
   * it"*. Every callee was dropped.
   *
   * Nothing was wrong today — §3 reads the returned context directly and every
   * other `Tape` use is a single-contract call. **It would have failed GREEN the
   * first time a round watched a vault through a payout**, which is the obvious
   * next use of this instrument and the reason it is pinned now rather than
   * filed. `C286`'s shape again: a guard whose written reason no longer matches
   * its behaviour.
   */
  it('one watched cross-contract payout hands back BOTH contracts\' transcripts', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    const vault: any = new (Vault as any)(vaultWitnesses as never);
    const vaultAddr = sampleContractAddress() as never as string;
    const init = await vault.initialState(
      createConstructorContext({} as VaultPrivate, BLOCK),
      { bytes: Uint8Array.from(Buffer.from(String(sim.address), 'hex')) } as never);
    let vaultState = init.currentContractState;
    const coin = { nonce: bytes(0x77), color: GBP, value: 5_000n };
    const priv: VaultPrivate = { coin: { ...coin, mt_index: 0n } };
    const dep = await vault.impureCircuits.deposit(
      createCircuitContext<VaultPrivate>(
        'deposit' as never, vaultAddr as never, BLOCK, vaultState, priv),
      coin);
    vaultState = dep.context.callContext.currentQueryContext.state;

    const c = govChange(95);
    const leaves: PayoutLeafInput[] = [{
      details: toHex(vaultCircuits.payoutDetails(ALICE, GBP, TO_ALICE, bytes(0x40))),
      nonce: toHex(bytes(0xc1)),
    }];
    const tree = buildPayoutTree(leaves);
    const payload = pureCircuits.runPayload(
      fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL);
    const vaultBytes = Uint8Array.from(Buffer.from(vaultAddr, 'hex'));
    await sim.as(sim.applying(A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes,
    });
    const id = sim.proposalId(payload, c.salt, vaultBytes);
    await sim.as(sim.applying(A, c)).approve(id);
    await sim.as(sim.applying(B, c)).approve(id);

    /* THE POINT: watch the VAULT, make one call, and require two back. */
    const tape = Transcript.watch(vault).clear();
    await vault.impureCircuits.payout(
      createCircuitContext<VaultPrivate>(
        'payout' as never, vaultAddr as never, BLOCK, vaultState, priv,
        {
          getContractState: async (_b: string, address: unknown) =>
            String(address) === String(sim.address) ? (sim.contractStateForCall as never) : undefined,
        } as never, undefined, undefined, NOW, BLOCK),
      id, fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, TO_ALICE, bytes(0x40), bytes(0xc1), tree.pathFor(0) as never);

    const t = tape.last;
    tape.stop();

    /* Before the fix this was ['payout'] and the callee's 41 ops were gone. */
    expect(t.calls.map((x) => x.circuitId)).toEqual(['recordPayment', 'payout']);
    /* And the absence claim still holds when it is made over the whole tree. */
    t.assertAbsent({ 'the payee': ALICE, 'the amount': TO_ALICE });
  });
});

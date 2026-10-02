/**
 * THE CLIENT'S OWN VAULT STATE, AGAINST THE REAL CONTRACT.
 *
 * `vault-notes.test.ts` proves the rules agree with themselves. This proves
 * they agree with the chain — which is the only agreement that matters, because
 * the chain holds nothing but commitments and a client that computes a blinding
 * differently produces a vault whose money cannot be moved.
 *
 * The one to read first is "pays twice from a derived pool with nothing carried
 * by hand". Every earlier test in this repo carried the change blinding
 * forward manually between payments; if that carrying was what made them pass,
 * this fails.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import * as ocrt from '@midnightntwrk/onchain-runtime-v4';
import {
  Contract as Vault, ledger as vaultLedger, pureCircuits as vaultCircuits,
} from '../managed-vault/contract/index.js';
import { pureCircuits, ledger as accountLedger } from '../managed/contract/index.js';
import {
  AccountSimulator, privateStateFor, change, type Change, vaultRunOf, tokenBytes, NOT_IN_THE_APPROVED_RUN,
} from './simulator.js';
import { carryTheAccount, startTheVault, TEST_VAULT_SECRET } from './start-a-vault.js';
import {
  buildRun, buildRetryRun, type PaymentFacts, type PayrollRun,
} from '../../src/midnight/payout-tree.js';
import { payeeFor, unshieldedPayeeFor } from '../../src/testing/payees.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { recipientOf } from '../../src/midnight/payee-address.js';
import type { PayoutSeed, RunIdentity } from '../../src/midnight/run-keys.js';
import {
  witnessesOver, afterDeposit, afterPayment, balanceOf, withIndexRead,
  type VaultNotes,
} from '../../src/midnight/vault-notes.js';
import type { ChainReadIndex } from '../../src/midnight/note-index.js';

/*
 * **THE ONE PLACE THIS TEST STANDS IN FOR THE CHAIN.** The circuits here run
 * in process, with no commitment tree and no transaction events, so there is
 * no index to read. A spend still needs one, and `0n` is handed over through
 * the same single door a chain-read index goes through, cast here and nowhere
 * in the client.
 */
const noTreeHere = 0n as ChainReadIndex;

/**
 * **EVERY CALL RECORDS THE TRANSACTION THAT MADE ITS NOTE, AS THE CLIENT DOES.**
 * A deposit and a payment each write it onto the note they create, and a
 * payment only spends a note that records one. There is no chain here to name a
 * real hash, so each call gets the next of these; nothing reads them but the
 * choice of which note can be spent.
 */
let transactions = 0;
const aTransaction = (): Hex => {
  transactions += 1;
  return transactions.toString(16).padStart(64, '0') as Hex;
};
import { changeCoinOf } from '../../src/midnight/vault-coins.js';
import { toHex, fromHex, type Hex } from '../../src/core/crypto.js';
import { payFor } from '../../src/testing/payees.js';
import { OTHER_TEST_TOKEN, TEST_TOKEN } from '../../src/testing/assets.js';
import { NIGHT as NIGHT_TOKEN } from '../../src/core/assets.js';
import { noFurtherNote } from '../../src/midnight/vault-step-notes.js';

const NOW = 1_800_000_000;
const FROM = BigInt(NOW - 3_600);
const UNTIL = BigInt(NOW + 3_600);
const BLOCK = '0'.repeat(64);

const bytes = (n: number) => new Uint8Array(32).fill(n);
const A = privateStateFor(1);
const B = privateStateFor(2);
/*
 * Each token is the asset a run names, because the account checks the token a
 * payment sends against the asset the run's root commits to, and the product
 * builds a run's root over the token itself. The fixture token has both forms.
 */
const TOKEN_BYTES = tokenBytes(TEST_TOKEN);
/** The token the product launches with, and it is UNSHIELDED by definition. */
const NIGHT = tokenBytes(NIGHT_TOKEN);
const ALICE = bytes(0x0a);
const BOB = bytes(0x0b);
const CAROL = bytes(0x0c);

const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) =>
  sim.applying(d, c);

describe('a vault driven by the client\'s own note pool', () => {
  let sim: AccountSimulator;
  let vault: Vault<VaultNotes>;
  let vaultAddr: string;
  let vaultState: any;
  let notes: VaultNotes;
  const pending: { spending?: string } = {};

  const provider = () => ({
    getContractState: async (_b: string, address: unknown) =>
      String(address) === String(sim.address) ? (sim.contractStateForCall as never) : undefined,
  });
  const vaultBytes = () => Uint8Array.from(Buffer.from(vaultAddr, 'hex'));
  const ctx = (circuit: string) => createCircuitContext<VaultNotes>(
    circuit, vaultAddr as never, BLOCK, vaultState, notes,
    provider() as never, undefined, undefined, NOW, BLOCK);

  /**
   * **THE VAULT'S STATE, PLUS WHAT THE CHAIN SAYS IT HOLDS IN PUBLIC
   * MONEY.**
   *
   * `unshieldedBalanceGte` reads `CallContext.balance`, and the runtime fills
   * it **only when it is handed a real `ContractState`** —
   * `compact-runtime/dist/circuit-context.js:113` is
   *
   *     contractState instanceof ocrt.ContractState ? contractState.balance : new Map()
   *
   * A circuit's result carries a `ChargedState`, and `ctx` above threads exactly
   * that. **So every balance question asked through `ctx` gets an EMPTY MAP.**
   *
   * **WHICH OF THE TWO THINGS EACH TEST BELOW IS DOING, said plainly:**
   *
   *   · The two kind-confusion tests refuse at `recordPaymentFromVault`, which is step 1
   *     of `payoutUnshielded` and runs BEFORE the balance assert. They are
   *     nonetheless given a balance that COMFORTABLY COVERS the payment —
   *     through this helper — so that a refusal cannot possibly be the balance's.
   *     **If the domain separation were removed, those payments would succeed**,
   *     which is exactly what was watched happening at the contract level.
   *   · The mixed-run test needs the assert to PASS, so it states a balance and
   *     the balance it states is not applied by anything. **That is a second
   *     model of the ledger's arithmetic**, in the sense `CLAUDE.md` warns
   *     about, and it is why that test asserts on the DECLARED EFFECTS —
   *     `unshieldedOutputs`, which is what the ledger actually subtracts
   *     (`midnight-ledger` `ledger-9.1.0.0-rc.3`, `ledger/src/semantics.rs:1462-1490`) — and not on any balance.
   *
   * **THE SIMULATOR STILL HAS THE HOLE**, and it stays open: nothing here
   * fixes `AccountSimulator`, and a test that asked a balance question through
   * `ctx` would still pass for the wrong reason.
   */
  const chainSays = (balances: Array<[Uint8Array, bigint]> = []) => {
    const cs = new ocrt.ContractState();
    (cs as { data: unknown }).data = (vaultState as { data?: unknown })?.data ?? vaultState;
    cs.balance = new Map(
      balances.map(([t, v]) => [{ tag: 'unshielded', raw: toHex(t) } as never, v]));
    return cs;
  };

  const ctxWith = (circuit: string, state: unknown) => createCircuitContext<VaultNotes>(
    circuit, vaultAddr as never, BLOCK, state as never, notes,
    provider() as never, undefined, undefined, NOW, BLOCK);

  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);

    /*
     * The witnesses read `notes` through a getter, so the contract always sees
     * the pool as it stands rather than a copy taken when the vault was built.
     * A snapshot here is the "one payment only" defect wearing a closure.
     */
    vault = new Vault<VaultNotes>({
      ...witnessesOver(() => notes, pending),
      /* The vault's nonce secret, opened on the paying device, as the client hands it over. */
      nonceSecret: (c: { privateState: unknown }) => [c.privateState, TEST_VAULT_SECRET],
    } as never);
    vaultAddr = sampleContractAddress() as never as string;
    notes = { notes: [] };

    const init = await vault.initialState(
      createConstructorContext(notes, BLOCK),
      { bytes: Uint8Array.from(Buffer.from(String(sim.address), 'hex')) } as never);
    vaultState = init.currentContractState;
    /* A vault takes no money until the account has adopted it and approved its first secret. */
    await startTheVault({
      sim, vault: vaultBytes(), approvers: [A, B], now: NOW,
      call: async (circuit, ...a) => {
        const r: any = await (vault.impureCircuits as any)[circuit](ctx(circuit), ...a);
        vaultState = r.context.callContext.currentQueryContext.state;
        carryTheAccount(sim, r.context);
      },
    });
  });

  /**
   * A deposit. The client supplies the coin and nothing else; the
   * commitment's blinding is the contract's own derivation, which is why this
   * file no longer has to agree with it about anything.
   */
  const deposit = async (nonce: number, value: bigint, token: Uint8Array = TOKEN_BYTES) => {
    const coin = { nonce: bytes(nonce), color: token, value };
    const r = await vault.impureCircuits.deposit(ctx('deposit'), coin);
    vaultState = r.context.callContext.currentQueryContext.state;
    notes = afterDeposit(notes, { nonce: toHex(coin.nonce), token: toHex(token), value, createdIn: aTransaction() });
    notes = withIndexRead(notes, toHex(coin.nonce), noTreeHere);
  };

  /** `people` names who each payment is for, so two runs of one payroll pay two people rather than one person twice. */
  const approvedRun = async (payroll: PaymentFacts[], c: Change, runId: string, asset: string = TEST_TOKEN, people?: string[]) => {
    const seeds: PayoutSeed[] = [{ epoch: 0, seed: toHex(bytes(0x77)) }];
    const identity: RunIdentity = { accountId: 'acct-v74', runId, epoch: 0 };
    const run = buildRun(seeds, identity, payroll, vaultDetails, payFor(payroll, people === undefined ? {} : { people }), asset);
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(run.tree.root), payees: run.tree.payees,
      from: FROM, until: UNTIL, vault: vaultBytes(),
    });
    const id = sim.proposalId(
      pureCircuits.runPayload(fromHex(run.tree.root), run.tree.payees, FROM, UNTIL, 0n),
      c.salt, vaultBytes());
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);
    return { run, id };
  };

  /** The run payee `i` of an approved run hands the account, read from the payee's own arguments. */
  const runOf = (run: PayrollRun, id: Uint8Array, c: Change, i: number) => {
    const a = run.payeeArgs(i);
    return vaultRunOf({
      proposal: id, vault: vaultBytes(), tree: run.tree, i: a.originalIndex,
      opensAt: FROM, closesAt: UNTIL, salt: c.salt, nonce: a.nonce,
    });
  };

  const pay = async (run: any, id: Uint8Array, c: Change, i: number) => {
    const a = run.payeeArgs(i);
    const before = pending.spending;
    void before;
    const r = await vault.impureCircuits.payout(
      ctx('payout'), runOf(run, id, c, i),
      fromHex(recipientOf(a.payee)), fromHex(a.token), a.amount, fromHex(a.blinding), noFurtherNote());
    vaultState = r.context.callContext.currentQueryContext.state;
    sim.adoptFromCall(r.context);
    /*
     * The pool moves on. `pending.spending` is the note the witness actually
     * handed the contract — read back rather than guessed at, because a client
     * that assumed which note was spent would drift from the chain on the first
     * payment where the assumption was wrong.
     */
    /*
     * **AND THE CHANGE IS READ OUT OF THE CALL, NOT DERIVED**, taken by
     *
     *
     * This line used to hand `afterPayment` an index and let it compute the
     * change note's nonce with `changeNonceOf`. It is now the coin the circuit
     * actually produced, read from the call's own Zswap local state — which is
     * what the answer actually is: *the change coin is an OUTPUT of the
     * transaction*.
     *
     * **THIS TEST IS THE PROOF THE READ SPENDS**, not merely that it parses:
     * the payments below come out of notes this line put in the pool, through
     * the real compiled circuit, and a wrong coin is refused by
     * `notes.member(spent)` rather than noticed by an assertion here.
     *
     * `noTreeHere` for the index is the same in-process stand-in the deposit
     * above uses: there is no commitment tree in this test to assign one.
     */
    const kept = changeCoinOf(r.context.callContext.currentZswapLocalState, toHex(vaultBytes()));
    notes = afterPayment(notes, pending.spending!, a.amount, kept, aTransaction());
    if (kept) notes = withIndexRead(notes, kept.nonce, noTreeHere);
    return r;
  };

  it('THE ONE THAT MATTERS: pays three people from a derived pool, with nothing carried by hand',
    async () => {
    /*
     * Every earlier vault test in this repo carried the change blinding forward
     * between payments. Nothing here does. If the derivation and the contract
     * disagreed by a single byte, the second payment would be refused as "that
     * note is not in this vault's pool" and the money would be stuck.
     */
    await deposit(0x71, 1_000n);

    const c = change(0n, 74);
    const { run, id } = await approvedRun([
      { payee: payeeFor(ALICE, 'undeployed'), token: toHex(TOKEN_BYTES), amount: 100n },
      { payee: payeeFor(BOB, 'undeployed'), token: toHex(TOKEN_BYTES), amount: 250n },
      { payee: payeeFor(CAROL, 'undeployed'), token: toHex(TOKEN_BYTES), amount: 400n },
    ], c, 'payroll-v74');

    await pay(run, id, c, 0);
    await pay(run, id, c, 1);
    await pay(run, id, c, 2);

    expect(vaultLedger(vaultState as never).payments).toBe(3n);
    expect(balanceOf(notes, toHex(TOKEN_BYTES))).toBe(250n);
    // One note left, and the chain agrees there is exactly one.
    expect(notes.notes).toHaveLength(1);
    expect([...vaultLedger(vaultState as never).notes]).toHaveLength(1);
  });

  it('spends the SMALLEST covering note, leaving the big one whole', async () => {
    await deposit(0x81, 1_000n);
    await deposit(0x82, 300n);

    const c = change(0n, 75);
    const { run, id } = await approvedRun(
      [{ payee: payeeFor(ALICE, 'undeployed'), token: toHex(TOKEN_BYTES), amount: 200n }], c, 'payroll-small');
    await pay(run, id, c, 0);

    expect(notes.notes.map(n => n.value).sort((a, b) => Number(a - b))).toEqual([100n, 1_000n]);
  });

  it('a note spent EXACTLY leaves no change, and the pool agrees with the chain', async () => {
    await deposit(0x91, 500n);
    await deposit(0x92, 1_000n);

    const c = change(0n, 76);
    const { run, id } = await approvedRun(
      [{ payee: payeeFor(ALICE, 'undeployed'), token: toHex(TOKEN_BYTES), amount: 500n }], c, 'payroll-exact');
    await pay(run, id, c, 0);

    expect(balanceOf(notes, toHex(TOKEN_BYTES))).toBe(1_000n);
    expect(notes.notes).toHaveLength(1);
    expect([...vaultLedger(vaultState as never).notes]).toHaveLength(1);
  });

  it('THROUGH THE COMPILED CIRCUIT: a note that records no transaction is passed over, the larger one is spent, and the passed-over note is still the vault\'s', async () => {
    await deposit(0xc1, 5_000n);
    await deposit(0xc2, 150n);
    /* The 150 as a note recorded before its transaction was kept. */
    notes = { notes: notes.notes.map(({ createdIn, ...n }) => (n.value === 150n ? n : { ...n, createdIn })) };

    const c = change(0n, 78);
    const { run, id } = await approvedRun(
      [{ payee: payeeFor(ALICE, 'undeployed'), token: toHex(TOKEN_BYTES), amount: 100n }], c, 'payroll-passed-over');
    await pay(run, id, c, 0);

    expect(vaultLedger(vaultState as never).payments).toBe(1n);
    expect(
      pending.spending,
      'RED WHEN: the witness the circuit calls takes the smallest covering note whether or not a payment can spend it',
    ).toBe(toHex(bytes(0xc1)));
    expect(notes.notes.map((n) => n.value).sort((a, b) => Number(a - b))).toEqual([150n, 4_900n]);
    /* Both are on chain: the one passed over is the vault's, and so is the change. */
    expect([...vaultLedger(vaultState as never).notes]).toHaveLength(2);
    expect(notes.notes.find((n) => n.value === 150n)).not.toHaveProperty('createdIn');
  });

  it('REFUSES A PAYMENT NO SINGLE NOTE COVERS rather than paying part of it', async () => {
    await deposit(0xa1, 60n);
    await deposit(0xa2, 60n);

    const c = change(0n, 77);
    const { run, id } = await approvedRun(
      [{ payee: payeeFor(ALICE, 'undeployed'), token: toHex(TOKEN_BYTES), amount: 100n }], c, 'payroll-merge');

    await expect(pay(run, id, c, 0)).rejects.toThrow(/no single note covers 100/i);
    expect(vaultLedger(vaultState as never).payments).toBe(0n);
  });
  /* ------------------------------------------------------------------ *
   * KIND SEPARATION AT THE CLIENT, WHERE THE LEAF IS ACTUALLY BUILT.
   * ------------------------------------------------------------------ */

  /**
   * **THE SECOND JOB, AND THE ONE THAT LOSES MONEY IF IT IS WRONG.**
   *
   * `contracts/test/vault-unshielded.test.ts` proves both directions at the
   * CONTRACT level, with leaves hand-built from `vaultCircuits.payoutDetails`
   * and `vaultCircuits.unshieldedPayoutDetails` by the test itself. **That is
   * not the same claim as this file's.** The client is what builds a run's
   * leaves in production, `buildRun` is where the derivation is chosen, and
   * until recently it chose ONE for the whole run. So these tests drive
   * `buildRun` and assert against the real compiled circuits.
   *
   * **EVERY PAYEE BELOW IS BUILT FROM THE SAME 32 BYTES**, `ALICE`, in the two
   * key spaces. A `ZswapCoinPublicKey` and a `UserAddress` of the same bytes
   * are indistinguishable to everything downstream of the address type — that
   * is the whole of the separation — so a fixture using different bytes would
   * let these pass because the values differed rather than because the KIND
   * did.
   */
  const publicAlice = () => unshieldedPayeeFor(ALICE, 'undeployed');
  const privateAlice = () => payeeFor(ALICE, 'undeployed');

  /** One payee of an approved run, paid through the PUBLIC door. */
  const payPublicly = (
    run: any, id: Uint8Array, c: Change, i: number, state: unknown,
  ) => {
    const a = run.payeeArgs(i);
    return vault.impureCircuits.payoutUnshielded(
      ctxWith('payoutUnshielded', state) as never,
      runOf(run, id, c, i),
      fromHex(recipientOf(a.payee)), fromHex(a.token), a.amount, fromHex(a.blinding));
  };

  it('THE SAME 32 BYTES, TWO KINDS, TWO RUNS - and the two leaves are not the same leaf',
    async () => {
    /* One run pays one form, so the same person paid privately and publicly is two runs side by side. */
    const priv = await approvedRun([{ payee: privateAlice(), token: toHex(TOKEN_BYTES), amount: 100n }], change(0n, 90), 'payroll-both-kinds:shielded');
    const pub = await approvedRun([{ payee: publicAlice(), token: toHex(NIGHT), amount: 100n }], change(0n, 97), 'payroll-both-kinds:unshielded', NIGHT_TOKEN);
    const [run, other] = [priv.run, pub.run];

    /*
     * The bytes that reach the two circuits ARE identical. If `buildRun` used
     * one derivation for every payee, the details would be identical too - and an
     * approval for either would satisfy the other.
     */
    expect(recipientOf(run.facts[0].payee)).toBe(recipientOf(other.facts[0].payee));
    expect(run.payments[0].details).not.toBe(other.payments[0].details);
    /* RED WHEN the two derivations agree on the same person, token, amount and blinding, so a kind is not part of the leaf. */
    const blinding = fromHex(run.secrets[0].blinding);
    expect(toHex(vaultCircuits.payoutDetails(ALICE, TOKEN_BYTES, 100n, blinding)))
      .not.toBe(toHex(vaultCircuits.unshieldedPayoutDetails(ALICE, TOKEN_BYTES, 100n, blinding)));

    /*
     * AND EACH IS THE VAULT'S OWN CIRCUIT'S ANSWER, not this file's. One
     * definition, and `one-definition.test.ts` is where copies are policed.
     */
    expect(run.payments[0].details).toBe(toHex(vaultCircuits.payoutDetails(
      ALICE, TOKEN_BYTES, 100n, fromHex(run.secrets[0].blinding))));
    expect(other.payments[0].details).toBe(toHex(vaultCircuits.unshieldedPayoutDetails(
      ALICE, NIGHT, 100n, fromHex(other.secrets[0].blinding))));
  });

  it('A PAYROLL WITH BOTH KINDS OF PAYEE IS TWO APPROVED RUNS, AND BOTH PEOPLE ARE PAID', async () => {
    /*
     * Both in one token. A run's root commits to one token in one form, and the
     * vault hands the account the token each payment actually sends, so a
     * payroll with a private and a public payee is two runs side by side, each
     * approved on its own, and each person is paid through their own door.
     */
    await deposit(0xb1, 1_000n);
    /* And public money arrives with no note, no nonce and nothing in the pool. */
    const funded = await vault.impureCircuits.depositUnshielded(
      ctxWith('depositUnshielded', chainSays()) as never, TOKEN_BYTES, 500n);
    vaultState = funded.context.callContext.currentQueryContext.state;
    expect(vaultLedger(vaultState as never).unshieldedTokens.member(TOKEN_BYTES)).toBe(true);

    const payroll = [
      { payee: privateAlice(), token: toHex(TOKEN_BYTES), amount: 100n },
      { payee: publicAlice(), token: toHex(TOKEN_BYTES), amount: 250n },
    ];
    /* RED WHEN one run is built over both kinds of payee, so one approval covers two kinds of money. */
    await expect(approvedRun(payroll, change(0n, 96), 'payroll-mixed')).rejects.toThrow(/^This run has both private and public payments/);

    const cPrivate = change(0n, 91);
    const cPublic = change(0n, 98);
    const priv = await approvedRun([payroll[0]!], cPrivate, 'payroll-mixed:shielded', TEST_TOKEN, ['person-0']);
    const pub = await approvedRun([payroll[1]!], cPublic, 'payroll-mixed:unshielded', TEST_TOKEN, ['person-1']);

    /* The private run's payee goes through the private door and moves the pool. */
    await pay(priv.run, priv.id, cPrivate, 0);
    expect(balanceOf(notes, toHex(TOKEN_BYTES))).toBe(900n);

    /* The public run's payee goes through the public one and moves nothing local. */
    const before = notes.notes.length;
    const paid = await payPublicly(pub.run, pub.id, cPublic, 0, chainSays([[TOKEN_BYTES, 500n]]));
    vaultState = paid.context.callContext.currentQueryContext.state;
    sim.adoptFromCall(paid.context);
    expect(notes.notes).toHaveLength(before);

    /*
     * **ASSERTED ON THE DECLARED EFFECT, WHICH IS WHAT THE LEDGER APPLIES**, and
     * not on the balance this test stated. See the `chainSays` block above.
     */
    const effects = (paid as any).context.callContext.currentQueryContext.effects;
    const outs = [...effects.unshieldedOutputs];
    expect(outs).toHaveLength(1);
    expect(outs[0][0].raw).toBe(toHex(TOKEN_BYTES));
    expect(outs[0][1]).toBe(250n);
    /* And to the PERSON, in the right half of the reversed Either; beside it, the vault's receipt to the account. */
    const spends = [...effects.claimedUnshieldedSpends];
    const ofPay = spends.filter(([[token]]: any) => token.raw === toHex(TOKEN_BYTES));
    /* RED WHEN the public payment is claimed to anyone but the person, or more than once. */
    expect(ofPay.map(([[, to], v]: any) => [to.tag, to.address, v])).toEqual([['user', publicAlice().userAddress, 250n]]);

    /* The account recorded BOTH leaves, one from each run, and it never learned there was a difference. */
    const acct = accountLedger((paid.context as any).queryContexts[sim.address as never].state);
    expect(acct.movements.member(
      pureCircuits.paidMovementOf(fromHex(priv.run.tree.leaves[0])))).toBe(true);
    expect(acct.movements.member(
      pureCircuits.paidMovementOf(fromHex(pub.run.tree.leaves[0])))).toBe(true);
  });

  /*
   * A LEAF APPROVED FOR ONE TOKEN IS NOT PAID BY MOVING ANOTHER. The vault hands
   * the account the token it actually moves - the spent coin's colour, or the
   * public token it sends - and the leaf and the run's root commit to the token
   * the signers approved, so a payment moving any other token is refused by the
   * contracts themselves, whichever form it is in.
   */
  it('A LEAF APPROVED FOR ONE TOKEN IS REFUSED WHEN A COIN OF ANOTHER IS WHAT MOVES, privately and publicly', async () => {
    const OTHER = tokenBytes(OTHER_TEST_TOKEN);
    /* The vault holds only the other token: a note of it, and a public balance of it. */
    await deposit(0xd1, 1_000n, OTHER);
    vaultState = (await vault.impureCircuits.depositUnshielded(
      ctxWith('depositUnshielded', chainSays()) as never, OTHER, 5_000n)).context.callContext.currentQueryContext.state;

    const c = change(0n, 120);
    const priv = await approvedRun([{ payee: privateAlice(), token: toHex(TOKEN_BYTES), amount: 250n }], c, 'payroll-token:shielded', TEST_TOKEN, ['person-0']);
    const a = priv.run.payeeArgs(0);
    /* RED WHEN the vault pays out a coin whose colour is not the token the approved leaf and root commit to. */
    await expect(vault.impureCircuits.payout(
      ctx('payout'), runOf(priv.run, priv.id, c, 0), fromHex(recipientOf(a.payee)), OTHER, a.amount, fromHex(a.blinding), noFurtherNote()))
      .rejects.toThrow(NOT_IN_THE_APPROVED_RUN);

    const cp = change(0n, 121);
    const pub = await approvedRun([{ payee: publicAlice(), token: toHex(TOKEN_BYTES), amount: 250n }], cp, 'payroll-token:unshielded', TEST_TOKEN, ['person-1']);
    const p = pub.run.payeeArgs(0);
    /* RED WHEN the vault sends a public token other than the one the approved leaf and root commit to. */
    await expect(vault.impureCircuits.payoutUnshielded(
      ctxWith('payoutUnshielded', chainSays([[OTHER, 5_000n]])) as never,
      runOf(pub.run, pub.id, cp, 0), fromHex(recipientOf(p.payee)), OTHER, p.amount, fromHex(p.blinding)))
      .rejects.toThrow(NOT_IN_THE_APPROVED_RUN);

    /* Nothing was paid, and neither person is recorded as paid. */
    expect(vaultLedger(vaultState as never).payments).toBe(0n);
    expect(sim.ledger.movements.member(pureCircuits.paidMovementOf(fromHex(priv.run.tree.leaves[0])))).toBe(false);
    expect(sim.ledger.movements.member(pureCircuits.paidMovementOf(fromHex(pub.run.tree.leaves[0])))).toBe(false);

    /* The control: once the vault holds the approved token, the same two payments are made, so the refusals were the token's. */
    await deposit(0xd2, 1_000n);
    await pay(priv.run, priv.id, c, 0);
    vaultState = (await vault.impureCircuits.depositUnshielded(
      ctxWith('depositUnshielded', chainSays([[OTHER, 5_000n]])) as never, TOKEN_BYTES, 500n)).context.callContext.currentQueryContext.state;
    const paid = await payPublicly(pub.run, pub.id, cp, 0, chainSays([[OTHER, 5_000n], [TOKEN_BYTES, 500n]]));
    sim.adoptFromCall(paid.context);
    expect(sim.ledger.movements.member(pureCircuits.paidMovementOf(fromHex(priv.run.tree.leaves[0])))).toBe(true);
    expect(sim.ledger.movements.member(pureCircuits.paidMovementOf(fromHex(pub.run.tree.leaves[0])))).toBe(true);
  });

  it('THE ONE THAT LOSES THE MONEY: a payee the client approved PRIVATELY cannot be paid publicly',
    async () => {
    await deposit(0xb2, 1_000n);
    vaultState = (await vault.impureCircuits.depositUnshielded(
      ctxWith('depositUnshielded', chainSays()) as never, NIGHT, 5_000n))
      .context.callContext.currentQueryContext.state;

    const c = change(0n, 92);
    /* One payee, shielded — so `buildRun` derives the leaf with `payoutDetails`. */
    const { run, id } = await approvedRun(
      [{ payee: privateAlice(), token: toHex(NIGHT), amount: 250n }], c, 'payroll-private-only', NIGHT_TOKEN);

    /*
     * **THE BALANCE IS DELIBERATELY GENEROUS.** 5,000 against a payment of 250,
     * so `unshieldedBalanceGte` passes and cannot be the reason this refuses.
     * Without the domain separator the money LEAVES here — to a `UserAddress`
     * built out of a Zswap coin public key, which nobody holds, against a real
     * approval, with no unshielded burn address to tell it from an intention.
     */
    /* RED WHEN a leaf approved for private money settles in public money, or this is refused for another reason. */
    await expect(payPublicly(run, id, c, 0, chainSays([[NIGHT, 5_000n]])))
      .rejects.toThrow(NOT_IN_THE_APPROVED_RUN);
    expect(vaultLedger(vaultState as never).payments).toBe(0n);
  });

  it('AND THE REVERSE: a payee the client approved PUBLICLY is not a private one either',
    async () => {
    /* A note the vault genuinely holds, so the refusal cannot come from the pool. */
    await deposit(0xb3, 1_000n);

    const c = change(0n, 93);
    const { run, id } = await approvedRun(
      [{ payee: publicAlice(), token: toHex(TOKEN_BYTES), amount: 250n }], c, 'payroll-public-only');

    /* RED WHEN a leaf approved for public money settles in private money, or this is refused for another reason. */
    await expect(pay(run, id, c, 0))
      .rejects.toThrow(NOT_IN_THE_APPROVED_RUN);
    expect(vaultLedger(vaultState as never).payments).toBe(0n);
  });

  /**
   * **THE HALF THAT IS EASY TO LEAVE OUT: a retry keeps each payee's kind.**
   *
   * `buildRetryRun` reuses the ORIGINAL secrets, which is what stops a retry
   * being a second payment. It also reuses the original `payments` — the
   * derived leaves — so the kind travels with them. If it rebuilt the leaves,
   * a mixed run's retry would be a run of one kind and half of it would be
   * unpayable, or payable through the wrong door.
   */
  it('a RETRY of a run keeps each payee on their own side', async () => {
    /* One run pays one form, so a retry of the public run pays publicly and of the private run privately. */
    const pub = await approvedRun([
      { payee: publicAlice(), token: toHex(TOKEN_BYTES), amount: 100n },
      { payee: unshieldedPayeeFor(BOB, 'undeployed'), token: toHex(TOKEN_BYTES), amount: 250n },
    ], change(0n, 94), 'payroll-retry:unshielded');
    const priv = await approvedRun([
      { payee: privateAlice(), token: toHex(TOKEN_BYTES), amount: 100n },
      { payee: payeeFor(BOB, 'undeployed'), token: toHex(TOKEN_BYTES), amount: 250n },
    ], change(0n, 99), 'payroll-retry:shielded');

    for (const [run, kind] of [[pub.run, 'unshielded'], [priv.run, 'shielded']] as const) {
      const retry = buildRetryRun(run, [1, 0]);
      expect(retry.facts.map(f => f.payee.kind)).toEqual([kind, kind]);
      /* Byte for byte the originals, in the new order, which is why paid-once
       * still holds. */
      expect(retry.payments[0].details).toBe(run.payments[1].details);
      expect(retry.payments[1].details).toBe(run.payments[0].details);
    }
  });
});

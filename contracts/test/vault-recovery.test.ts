/**
 * THE DEVICE DIED MID-CALL. CAN THE MONEY STILL MOVE? `C199`, `C200`, `B1`.
 *
 * The vault's pool lives on the owner's device; the chain holds only
 * commitments, which disclose nothing. The pool is written AFTER the
 * transaction — deliberately, because that is the recoverable ordering — so a
 * crash in between leaves the chain holding notes the pool has never heard of.
 * **`replayVault` is what makes that ordering safe**, which is `C199`, and
 * `C200` was that `replayVault` modelled a vault that no longer exists: one
 * coin chained forward, where the contract has held a POOL since `V-58`.
 *
 * **THESE TESTS THROW THE POOL AWAY AND THEN PAY FROM WHAT THEY REBUILD.** That
 * is the only evidence that counts: a derivation checked against another
 * derivation proves the two agree and nothing about whether the money moves.
 * `V-47` was exactly that mistake — a plausible nonce derivation that compiled,
 * read well, and was wrong. **A recovered note that cannot be spent is not
 * recovered.**
 *
 * ------------------------------------------------------------------------
 * THE TWO CRASH WINDOWS, AND WHY ONE MECHANISM ANSWERS BOTH
 *
 *   **W1 — inside the call.** Submitted, outcome unknown. The chain may or may
 *   not hold the new notes; the pool still holds the old ones.
 *   **W2 — after the call, before the pool write.** The chain definitely holds
 *   the new notes; the pool definitely does not.
 *
 * A replay that simply applied the history would have to know which window it
 * is in, and it cannot. So the replay proposes **every note the history has
 * ever held** and the chain's own `notes` set decides which are live — which
 * makes the two windows the same question, *did it land?*, and that is the only
 * question a commitment set can answer. Both are driven below, per operation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract as Vault, ledger as vaultLedger, pureCircuits as vaultCircuits,
} from '../managed-vault/contract/index.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountSimulator, privateStateFor, change, type Change } from './simulator.js';
import { buildPayoutTree, type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { changeCoinOf, paidCoinTo } from '../../src/midnight/vault-coins.js';
import {
  replayVault, reconcileVaultPool, commitmentForNote, paidCoinOf, changeNoteOf, type VaultEvent,
} from '../../src/midnight/vault-recovery.js';
import { noteToSpend, type Note } from '../../src/midnight/vault-notes.js';
import { toHex, fromHex, type Hex } from '../../src/core/crypto.js';

/*
 * THE CLOCK AND THE RUN'S WINDOW. `V-67`. Payments assert they fall inside the
 * window the signers approved, so the account simulator and the vault's circuit
 * context have to agree about the time. Seconds since the Unix epoch.
 */
const VAULT_NOW = 1_800_000_000;
const WIN_FROM = BigInt(VAULT_NOW - 3_600);
const WIN_UNTIL = BigInt(VAULT_NOW + 3_600);
const BLOCK = '0'.repeat(64);

const bytes = (n: number) => new Uint8Array(32).fill(n);

const A = privateStateFor(1);
const B = privateStateFor(2);
const GBP = bytes(0x9b);
const ALICE = bytes(0x0a);
const BOB = bytes(0x0b);
const CAROL = bytes(0x0c);

/**
 * The device's pool, and the witness the contract calls over it.
 *
 * **Coin selection is the PRODUCTION rule**, imported rather than written here:
 * `noteToSpend` picks the smallest note that covers the payment, ties broken by
 * nonce. A test with its own selection would be a second implementation of the
 * thing `B3` is about — two operators picking differently and both
 * half-succeeding — and would also let these tests pass while the client's rule
 * was wrong.
 */
interface VaultPrivate { notes: Note[] }

const vaultWitnesses = {
  noteToSpend: (
    ctx: { privateState: VaultPrivate }, token: Uint8Array, amount: bigint,
  ) => {
    const n = noteToSpend(ctx.privateState.notes, toHex(token), amount);
    return [ctx.privateState, {
      nonce: fromHex(n.nonce), color: fromHex(n.token), value: n.value, mt_index: n.index,
    }];
  },
};

/**
 * `mt_index` IS NOT WHAT RECOVERY GIVES BACK, and this constant is where that is
 * said rather than buried.
 *
 * The commitment tree assigns an index and it is not a function of anything the
 * owner holds, so `replayVault` reports it as absent and a caller re-reads it
 * from the chain. **Losing it costs a rescan; losing a nonce costs the money.**
 * These tests run against an in-process contract with no real tree, so a
 * placeholder is correct here AND these tests are not evidence that an index is
 * recoverable. Nothing claims they are.
 */
const NO_INDEX_YET = 0n;

const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) =>
  sim.applying(d, c);

describe('a vault whose pool is gone, and the chain that still knows', () => {
  let sim: AccountSimulator;
  let vault: Vault<VaultPrivate>;
  let vaultAddr: string;
  let vaultState: any;
  let priv: VaultPrivate;

  /* TWO notes, of one token. A vault holding two notes of a token is the normal
   * case, not a mess to tidy — `Vault.compact`'s own words, and the whole of
   * what the function this replaces could not model. */
  const FIRST = { nonce: toHex(bytes(0x77)), token: toHex(GBP), value: 1_000n };
  const SECOND = { nonce: toHex(bytes(0x88)), token: toHex(GBP), value: 400n };

  const provider = () => ({
    getContractState: async (_b: string, address: unknown) =>
      String(address) === String(sim.address) ? (sim.contractStateForCall as never) : undefined,
  });

  const ctx = (circuit: string) => createCircuitContext<VaultPrivate>(
    circuit, vaultAddr as never, BLOCK, vaultState, priv,
    provider() as never, undefined, undefined, VAULT_NOW, BLOCK);

  /** The vault's note set exactly as the chain publishes it: commitments. */
  const chainNotes = (): Hex[] =>
    [...vaultLedger(vaultState as never).notes].map((c: Uint8Array) => toHex(c));

  const held = (coin: { nonce: Hex; token: Hex; value: bigint }) =>
    commitmentForNote(vaultCircuits, vaultAddr as Hex, coin);

  const asNotes = (coins: readonly { nonce: Hex; token: Hex; value: bigint }[]): Note[] =>
    coins.map((c) => ({ ...c, index: NO_INDEX_YET }));

  const deposit = async (coin: { nonce: Hex; token: Hex; value: bigint }) => {
    const r = await vault.impureCircuits.deposit(ctx('deposit'), {
      nonce: fromHex(coin.nonce), color: fromHex(coin.token), value: coin.value,
    });
    vaultState = r.context.callContext.currentQueryContext.state;
    return r;
  };

  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(VAULT_NOW);

    vault = new Vault<VaultPrivate>(vaultWitnesses as never);
    vaultAddr = sampleContractAddress() as never as string;
    const init = await vault.initialState(
      createConstructorContext({} as VaultPrivate, BLOCK),
      { bytes: Uint8Array.from(Buffer.from(String(sim.address), 'hex')) } as never);
    vaultState = init.currentContractState;

    priv = { notes: [] };
    await deposit(FIRST);
    priv = { notes: asNotes([FIRST]) };
    await deposit(SECOND);
    priv = { notes: asNotes([FIRST, SECOND]) };
  });

  const approvedRun = async (
    payments: Array<{ to: Uint8Array; amount: bigint; nonce: number }>, c: Change,
  ) => {
    const leaves: PayoutLeafInput[] = payments.map((p, i) => ({
      details: toHex(vaultCircuits.payoutDetails(p.to, GBP, p.amount, bytes(0x40 + i))),
      nonce: toHex(bytes(p.nonce)),
    }));
    const tree = buildPayoutTree(leaves);
    const payload = pureCircuits.runPayload(
      fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL);
    const vaultBytes = Uint8Array.from(Buffer.from(vaultAddr, 'hex'));
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes });
    const id = sim.proposalId(payload, c.salt, vaultBytes);
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);
    return { tree, id };
  };

  /** One payee of an approved run. Returns the call, and does NOT touch the pool. */
  const pay = async (
    run: { tree: ReturnType<typeof buildPayoutTree>; id: Uint8Array }, c: Change,
    i: number, to: Uint8Array, amount: bigint, nonce: number,
  ) => {
    const r = await vault.impureCircuits.payout(
      ctx('payout'), run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL,
      c.salt, to, GBP, amount, bytes(0x40 + i), bytes(nonce), run.tree.pathFor(i) as never);
    vaultState = r.context.callContext.currentQueryContext.state;
    return r;
  };

  const recover = (history: VaultEvent[], pool: readonly Note[]) => replayVault({
    vault: vaultAddr as Hex,
    chain: chainNotes(),
    pool,
    history,
    circuits: vaultCircuits,
  });

  /** The history that produced the two notes every test starts from. */
  const OPENING: VaultEvent[] = [
    { kind: 'deposit', coin: FIRST },
    { kind: 'deposit', coin: SECOND },
  ];

  /* ---------------------------------------------------------------- *
   * deposit
   * ---------------------------------------------------------------- */

  it('W2, DEPOSIT: the chain took the note, the pool never learned — and it SPENDS', async () => {
    /*
     * The deposit landed and the process died before `pool.save`. The pool knows
     * about the first note only. This is `C199`'s window at the deposit site,
     * which is the cheapest of the three to recover because a deposit's coin is
     * the depositor's own record — and public in their transaction besides.
     */
    const poolBeforeCrash = asNotes([FIRST]);

    const r = recover(OPENING, poolBeforeCrash);
    expect(r.held).toHaveLength(2);
    expect(r.recovered).toHaveLength(1);
    expect(r.recovered[0].nonce).toBe(SECOND.nonce);
    expect(r.recovered[0].value).toBe(400n);
    expect(r.stale).toHaveLength(0);
    expect(r.unexplained).toHaveLength(0);

    /* The index is NOT recovered, and the shape says so rather than a comment. */
    expect(r.recovered[0].index).toBeUndefined();

    /* And now the only proof that counts: pay somebody out of the note nobody
     * had written down. 400 is the smaller note, so a payment of 300 selects it. */
    priv = { notes: asNotes(r.held) };
    const c = change(0n, 51);
    const run = await approvedRun([{ to: ALICE, amount: 300n, nonce: 0xe1 }], c);
    const paid = await pay(run, c, 0, ALICE, 300n, 0xe1);

    expect(vaultLedger(vaultState as never).payments).toBe(1n);
    const spentTheRecoveredOne = changeCoinOf(
      paid.context.callContext.currentZswapLocalState, vaultAddr as Hex);
    expect(spentTheRecoveredOne!.value).toBe(100n);
  });

  it('W1, DEPOSIT: the call never landed, so the chain refuses the note and nothing invents it',
    async () => {
      /*
       * The other window: submitted, outcome unknown, and in fact it did not
       * land. The history records the deposit because the owner made it; the
       * chain does not hold it. **The replay must not hand back a note the
       * vault cannot spend** — that is the pool claiming more than the chain
       * will honour, which is every later payment refused.
       */
      const NEVER_LANDED = { nonce: toHex(bytes(0x99)), token: toHex(GBP), value: 5_000n };
      const r = recover([...OPENING, { kind: 'deposit', coin: NEVER_LANDED }],
        asNotes([FIRST, SECOND]));

      expect(r.held.map((n) => n.nonce).sort())
        .toEqual([FIRST.nonce, SECOND.nonce].sort());
      expect(r.held.some((n) => n.nonce === NEVER_LANDED.nonce)).toBe(false);
      expect(r.recovered).toHaveLength(0);
      expect(r.unexplained).toHaveLength(0);
    });

  /* ---------------------------------------------------------------- *
   * REBUILT FROM THE POOL'S OWN FILED VERSIONS, WITH NO HISTORY AT ALL
   * ---------------------------------------------------------------- */

  /**
   * **`replayVault` NEEDS A HISTORY, AND NOTHING IN THIS REPOSITORY PRODUCES
   * ONE.** Fourteen refusals on the money path have been naming it as the remedy,
   * so for as long as that is true they name something nobody can do.
   *
   * `reconcileVaultPool` is the route with no history in it: the pool's versions
   * are filed one per write instead of overwriting each other, so the union of
   * them is every note this pool has ever believed in. That union is proposed to
   * the chain and the chain chooses -- the same design, reached from a different
   * record of what has existed.
   *
   * **THESE TESTS DRIVE THE REAL CONTRACT AND READ ITS OWN NOTE SET**, exactly as
   * every test above does, so what accepts or rejects a rebuilt note is the
   * chain's commitment set and not a fixture's opinion of it.
   */
  const rebuild = (versions: { version: number; notes: readonly Note[] }[]) =>
    reconcileVaultPool({
      vault: vaultAddr as Hex,
      chain: chainNotes(),
      versions,
      circuits: vaultCircuits,
    });

  it('AGREES when the newest filed version is what the chain holds', () => {
    const r = rebuild([
      { version: 1, notes: asNotes([FIRST]) },
      { version: 2, notes: asNotes([FIRST, SECOND]) },
    ]);
    expect(r.held).toHaveLength(2);
    expect(
      r.recovered,
      'RED WHEN: a note the newest version already knew about is reported as recovered, which sends somebody looking for a problem that is not there',
    ).toHaveLength(0);
    expect(r.stale).toHaveLength(0);
    expect(r.unexplained).toHaveLength(0);
  });

  it('RECOVERS a note a later write dropped while the chain still held it — AND IT SPENDS', async () => {
    /*
     * The overwrite. Until the change below each write replaced the last, so a write
     * built on a stale copy erased whatever came in between and there was nothing
     * left to recover FROM. The note is in an older filed version, the chain still
     * holds it, and that is the whole mechanism.
     */
    const r = rebuild([
      { version: 1, notes: asNotes([FIRST, SECOND]) },
      { version: 2, notes: asNotes([FIRST]) },        // SECOND erased by a stale write
    ]);
    expect(
      r.recovered.map((n) => n.nonce),
      'RED WHEN: the union is not taken across every filed version, so a note only an OLDER version names is lost even though the chain still holds it -- which is the reason the versions are kept at all',
    ).toEqual([SECOND.nonce]);
    expect(r.held).toHaveLength(2);
    expect(r.stale).toHaveLength(0);

    /*
     * **AND THE ONLY PROOF THAT COUNTS, WHICH IS THIS FILE'S OWN STANDARD: A
     * RECOVERED NOTE THAT CANNOT BE SPENT IS NOT RECOVERED.** 400 is the smaller
     * note, so a payment of 300 selects the one that was erased.
     */
    priv = { notes: asNotes(r.held) };
    const c = change(0n, 71);
    const run = await approvedRun([{ to: ALICE, amount: 300n, nonce: 0xe7 }], c);
    const paid = await pay(run, c, 0, ALICE, 300n, 0xe7);
    expect(vaultLedger(vaultState as never).payments).toBe(1n);
    const kept = changeCoinOf(paid.context.callContext.currentZswapLocalState, vaultAddr as Hex);
    expect(
      kept!.value,
      'RED WHEN: the note handed back cannot actually be spent, which is a rebuild that reports success and leaves the money where it was',
    ).toBe(100n);
  });

  it('takes the NEWEST version by its number, not by where it sits in the list', () => {
    /*
     * **THREE, SO THAT NEITHER END OF THE LIST IS THE NEWEST.** With two the first
     * element WAS the newest, so `versions[0]` left this green and only the
     * last-element mistake was caught -- a second reading found that half of the RED WHEN
     * below was unearned.
     */
    const shuffled = rebuild([
      { version: 1, notes: asNotes([FIRST, SECOND]) },
      { version: 3, notes: asNotes([FIRST]) },
      { version: 2, notes: asNotes([FIRST, SECOND]) },
    ]);
    /*
     * RED WHEN: the newest is taken as the first or last element. The versions come
     * from a directory listing, whose order is the filesystem's business -- and
     * "which notes does the pool currently believe in" would then be answered by
     * whichever file the kernel happened to name first.
     */
    expect(shuffled.recovered.map((n) => n.nonce), 'RED WHEN: the newest filed version is chosen by list position rather than by its number').toEqual([SECOND.nonce]);
  });

  it('does NOT resurrect a note from an old version that the chain no longer holds', async () => {
    /*
     * The other half of keeping every version, and the dangerous one. A note that
     * was spent is in every version filed before the spend. Proposing it is right;
     * KEEPING it would be a pool claiming more than the chain will honour, which
     * is every later payment refused after two fees.
     */
    const c = change(0n, 72);
    const run = await approvedRun([{ to: ALICE, amount: 900n, nonce: 0xe8 }], c);
    await pay(run, c, 0, ALICE, 900n, 0xe8);   // spends FIRST, 1000

    const r = rebuild([
      { version: 1, notes: asNotes([FIRST, SECOND]) },
      { version: 2, notes: asNotes([FIRST, SECOND]) },
    ]);
    expect(
      r.held.some((n) => n.nonce === FIRST.nonce),
      'RED WHEN: a note that has been spent comes back because an old version still names it -- the chain has nullified its commitment, so the pool would offer the next payment money that is gone',
    ).toBe(false);
    expect(r.stale.map((n) => n.nonce), 'RED WHEN: the spent note is not reported as stale, so nobody learns the pool was wrong').toEqual([FIRST.nonce]);
    expect(r.held.map((n) => n.nonce)).toEqual([SECOND.nonce]);
    /*
     * **AND THE CHANGE NOTE IS UNEXPLAINED, WHICH IS THE GAP AND NOT A BUG.** The
     * payment's change is on chain and no filed version has ever named it, because
     * the write that would have named it is the one that was lost. Its nonce is
     * derivable from the spent note and its colour is that note's colour, but its
     * VALUE is the spent value minus an amount only the payment knew -- and a
     * commitment cannot be inverted. **Nothing here guesses**, and a round that
     * makes this assertion pass by guessing has invented money.
     */
    expect(
      r.unexplained,
      'RED WHEN: a commitment nothing explains is dropped from the report, which hides money the vault holds and cannot name',
    ).toHaveLength(1);
  });

  it('REFUSES to rebuild from no filed version at all, rather than answering "empty"', () => {
    expect(
      () => rebuild([]),
      'RED WHEN: a pool with no filed version reads as a vault holding nothing -- the one refusal this whole area exists to keep apart from a balance of zero',
    ).toThrow(/no filed versions/);
  });

  it('REFUSES two versions that describe one nonce differently, rather than choosing one', () => {
    /*
     * Two records of what a nonce is worth cannot both be true, and picking one
     * would be this function inventing money. It is handed to `replayVault` as two
     * deposits of one nonce, which that function already refuses by name.
     */
    expect(
      () => rebuild([
        { version: 1, notes: asNotes([FIRST]) },
        { version: 2, notes: asNotes([{ ...FIRST, value: 7_777n }]) },
      ]),
      'RED WHEN: one of two contradicting records is silently preferred, which is this function deciding what the money is worth',
    ).toThrow(/already holds/);
  });

  /* ---------------------------------------------------------------- *
   * REBUILT FROM THE VERSIONS AND THE JOURNALS: THE AMOUNT WRITTEN DOWN
   * BEFORE THE MONEY MOVED
   * ---------------------------------------------------------------- */

  /**
   * **THE CASE THE VERSIONS ALONE CANNOT ANSWER, MEASURED BEFORE AND AFTER.**
   * A payment lands and the process stops before the pool is written. The
   * chain holds the change note; no version of the pool names it; its nonce
   * and colour follow from the spent note but its value is the spent value
   * minus an amount only the payment knew. Against the versions alone that is
   * one stale note and one commitment nothing explains. **With the line the
   * payment journalled before its call, it is a named note -- and it SPENDS,
   * which is this file's standard.**
   */
  const rebuildWith = (
    versions: { version: number; notes: readonly Note[] }[],
    attempted: { deposits?: readonly typeof FIRST[]; payments?: readonly { spent: typeof FIRST; amount: bigint }[] },
  ) => reconcileVaultPool({
    vault: vaultAddr as Hex,
    chain: chainNotes(),
    versions,
    attempted: { deposits: attempted.deposits ?? [], payments: attempted.payments ?? [] },
    circuits: vaultCircuits,
  });

  it('CASE C: a payment\'s change note the versions cannot name IS named from the journal, and it SPENDS',
    async () => {
      const c = change(0n, 81);
      const run = await approvedRun([{ to: ALICE, amount: 250n, nonce: 0xf1 }], c);
      await pay(run, c, 0, ALICE, 250n, 0xf1);          // spends SECOND (400), change 150
      const versions = [{ version: 1, notes: asNotes([FIRST, SECOND]) }];  // never advanced

      /* Before: the gap, exactly as it was measured. */
      const without = rebuild(versions);
      expect(without.held.map((n) => n.nonce)).toEqual([FIRST.nonce]);
      expect(without.stale.map((n) => n.nonce)).toEqual([SECOND.nonce]);
      expect(without.unexplained, 'the versions alone cannot name the change note, by design').toHaveLength(1);

      /* After: the one line the payment wrote before its call. */
      const r = rebuildWith(versions, { payments: [{ spent: SECOND, amount: 250n }] });
      expect(
        r.unexplained,
        'RED WHEN: the journalled attempt is not proposed, so the change note stays a commitment nothing explains',
      ).toHaveLength(0);
      expect(r.recovered).toHaveLength(1);
      expect(
        r.recovered[0].value,
        'RED WHEN: the change note is derived with a value other than the spent value minus the journalled amount -- a wrong value is a wrong commitment, and the chain refuses it',
      ).toBe(150n);
      expect(r.recovered[0].nonce).not.toBe(SECOND.nonce);
      expect(r.stale.map((n) => n.nonce), 'the spent note is still stale: the journal does not resurrect it').toEqual([SECOND.nonce]);
      expect(r.held.map((n) => n.value).sort((x, y) => Number(x - y))).toEqual([150n, 1_000n]);

      /* And the only proof that counts. */
      priv = { notes: asNotes(r.held) };
      const c2 = change(0n, 82);
      const run2 = await approvedRun([{ to: BOB, amount: 120n, nonce: 0xf2 }], c2);
      await pay(run2, c2, 0, BOB, 120n, 0xf2);         // 150 is the smallest that covers it
      expect(vaultLedger(vaultState as never).payments).toBe(2n);
      expect(chainNotes()).toHaveLength(2);
      expect(chainNotes()).toContain(held({ ...FIRST }));
    });

  it('a journalled payment that NEVER LANDED names nothing: the chain, not the journal, decides', () => {
    /* No payment was made. The journal says one was attempted. */
    const r = rebuildWith([{ version: 1, notes: asNotes([FIRST, SECOND]) }],
      { payments: [{ spent: SECOND, amount: 250n }] });
    expect(
      r.held.map((n) => n.nonce).sort(),
      'RED WHEN: a journalled change note is written into the pool without the chain holding it -- a pool entry for a note that does not exist, which makes the pool unspendable rather than incomplete',
    ).toEqual([FIRST.nonce, SECOND.nonce].sort());
    expect(r.recovered).toHaveLength(0);
    expect(r.stale).toHaveLength(0);
    expect(r.unexplained).toHaveLength(0);
  });

  it('TWO attempts against one note, the first never landed: both are proposed and the chain keeps one', async () => {
    /*
     * The door was run, stopped before the chain saw it, and run again for a
     * different amount. Both lines are in the journal. A `payout` event would
     * refuse the second as a double spend; an ATTEMPT retires nothing.
     */
    const c = change(0n, 83);
    const run = await approvedRun([{ to: ALICE, amount: 100n, nonce: 0xf3 }], c);
    await pay(run, c, 0, ALICE, 100n, 0xf3);          // spends SECOND, change 300
    let r!: ReturnType<typeof rebuildWith>;
    expect(
      () => { r = rebuildWith([{ version: 1, notes: asNotes([FIRST, SECOND]) }], {
        payments: [{ spent: SECOND, amount: 250n }, { spent: SECOND, amount: 100n }],
      }); },
      'RED WHEN: an attempt is replayed as a payout, so the second attempt against the same note is refused as a double spend',
    ).not.toThrow();
    expect(
      r.recovered.map((n) => n.value),
      'RED WHEN: a second attempt against a note an earlier attempt named is refused, or the first attempt retires the note so the second cannot find it',
    ).toEqual([300n]);
    expect(r.unexplained).toHaveLength(0);
  });

  it('a journalled DEPOSIT whose pool write was lost is recovered from the deposit journal, and SPENDS', async () => {
    /* The deposit of SECOND landed; the only filed version predates it. */
    const r = rebuildWith([{ version: 1, notes: asNotes([FIRST]) }], { deposits: [SECOND] });
    expect(
      r.recovered.map((n) => n.nonce),
      'RED WHEN: the deposit journal is not proposed beside the versions, so the one record written BEFORE a deposit moved money stays unread by the rebuild',
    ).toEqual([SECOND.nonce]);
    priv = { notes: asNotes(r.held) };
    const c = change(0n, 84);
    const run = await approvedRun([{ to: CAROL, amount: 400n, nonce: 0xf4 }], c);
    await pay(run, c, 0, CAROL, 400n, 0xf4);           // SECOND, exactly
    expect(vaultLedger(vaultState as never).payments).toBe(1n);
  });

  it('a journalled attempt is named even when NO version filed the note it spent', async () => {
    /* The pool file was restored from before SECOND arrived; the journal carries SECOND whole. */
    const c = change(0n, 85);
    const run = await approvedRun([{ to: ALICE, amount: 250n, nonce: 0xf5 }], c);
    await pay(run, c, 0, ALICE, 250n, 0xf5);
    let r!: ReturnType<typeof rebuildWith>;
    expect(
      () => { r = rebuildWith([{ version: 1, notes: asNotes([FIRST]) }],
        { payments: [{ spent: SECOND, amount: 250n }] }); },
      'RED WHEN: the spent note is not carried whole into the union, so an attempt against a note the versions never filed cannot be resolved',
    ).not.toThrow();
    expect(r.recovered.map((n) => n.value)).toEqual([150n]);
  });

  it('an attempt that spent the note EXACTLY proposes nothing, and the same line twice is one line', async () => {
    const c = change(0n, 86);
    const run = await approvedRun([{ to: CAROL, amount: 400n, nonce: 0xf6 }], c);
    await pay(run, c, 0, CAROL, 400n, 0xf6);           // SECOND, exactly: no change
    const r = rebuildWith([{ version: 1, notes: asNotes([FIRST, SECOND]) }],
      { payments: [{ spent: SECOND, amount: 400n }, { spent: SECOND, amount: 400n }] });
    expect(r.held.map((n) => n.nonce)).toEqual([FIRST.nonce]);
    expect(r.stale.map((n) => n.nonce)).toEqual([SECOND.nonce]);
    expect(r.recovered, 'RED WHEN: a change note of zero is invented for an exact spend -- the contract inserts none').toHaveLength(0);
    expect(r.unexplained).toHaveLength(0);
    /* The chain would refuse a zero-value note anyway, so the derivation is pinned directly too. */
    expect(
      changeNoteOf(SECOND, 400n),
      'RED WHEN: an exact spend derives a change note of zero, which the contract never inserts',
    ).toBeUndefined();
    expect(changeNoteOf(SECOND, 399n)?.value).toBe(1n);
  });

  it('REFUSES a journal line the contract could not have taken, rather than deriving past it', () => {
    expect(
      () => rebuildWith([{ version: 1, notes: asNotes([FIRST, SECOND]) }],
        { payments: [{ spent: SECOND, amount: 5_000n }] }),
      'RED WHEN: an amount larger than the note is subtracted anyway, which is a value nothing could have committed to',
    ).toThrow(/cannot have landed/);
    expect(
      () => rebuildWith([{ version: 1, notes: asNotes([FIRST, SECOND]) }],
        { payments: [{ spent: SECOND, amount: 0n }] }),
    ).toThrow(/not a payment/);
    /* A journal line whose spent note contradicts the filed one is the existing refusal. */
    expect(
      () => rebuildWith([{ version: 1, notes: asNotes([FIRST, SECOND]) }],
        { payments: [{ spent: { ...SECOND, value: 999n }, amount: 10n }] }),
      'RED WHEN: a journal that disagrees with the pool about what a note is worth is silently preferred either way',
    ).toThrow(/already holds/);
    /* A line naming a note nothing filed is not refused: its change has a commitment the chain does not hold. */
    const stranger = { nonce: toHex(bytes(0x01)), token: toHex(GBP), value: 5_000n };
    const r = rebuildWith([{ version: 1, notes: asNotes([FIRST, SECOND]) }], { payments: [{ spent: stranger, amount: 1n }] });
    expect(r.held.map((n) => n.nonce).sort()).toEqual([FIRST.nonce, SECOND.nonce].sort());
    expect(r.recovered).toHaveLength(0);
  });

  it('`payout-attempt` in a HISTORY is derived from its own line: a payout the pool recorded AND the journal\'s line for it is one event, described twice', () => {
    let r!: ReturnType<typeof recover>;
    expect(
      () => { r = recover([
        ...OPENING,
        { kind: 'payout', spent: SECOND.nonce, amount: 250n },
        { kind: 'payout-attempt', spent: SECOND, amount: 250n },
      ], asNotes([FIRST])); },
      'RED WHEN: an attempt is refused because the note it names was already retired by the payout that recorded the same call',
    ).not.toThrow();
    /* Nothing landed on chain in this test, so nothing derived is held; the point is that it did not throw. */
    expect(r.held.map((n) => n.nonce).sort()).toEqual([FIRST.nonce, SECOND.nonce].sort());
  });

  it('an attempt RECORDS NOTHING a later event can read: its change is proposed, never made live', () => {
    /*
     * A `payout` after an attempt cannot spend the attempt's change, because an
     * attempt is not a fact about the pool. If it were made live, the LAST
     * attempt against a note would decide what its change nonce is worth for
     * every later line -- see the poisoning case below.
     */
    const kept = changeNoteOf(SECOND, 100n)!;
    expect(
      () => recover([
        ...OPENING,
        { kind: 'payout-attempt', spent: SECOND, amount: 100n },
        { kind: 'payout', spent: kept.nonce, amount: 10n },
      ], []),
      'RED WHEN: an attempt\'s change note is written into the live set, so a later event reads a value the chain never confirmed',
    ).toThrow(/never held/);
  });

  it('A STALE LINE CANNOT POISON A LATER ONE: two attempts of different amounts against one note, then a spend of its change, and the real change note is recovered', async () => {
    /*
     * The ordinary sequence after a lost pool write, found by the audit of this
     * mechanism before any door ran it. Payee 1 is paid 100 out of SECOND; the
     * call lands; the pool write is lost. The pool still holds SECOND, so the
     * next payment chooses it again, journals (SECOND, 250), and the chain
     * refuses the spend -- that line stays in the journal for ever. The pool is
     * rebuilt (change N = 300 recovered and written). Payee 2 is then paid 250
     * out of N: journal (N, 250), and the process stops before the pool write.
     *
     * A rebuild that let the (SECOND, 250) line decide what N is worth would
     * measure the (N, 250) line against 150, refuse it as wrong while it is
     * right, and leave N's real change note as money nobody can name.
     */
    const c1 = change(0n, 87);
    const run1 = await approvedRun([{ to: ALICE, amount: 100n, nonce: 0xf7 }], c1);
    await pay(run1, c1, 0, ALICE, 100n, 0xf7);        // spends SECOND (400), change N = 300
    const N = changeNoteOf(SECOND, 100n)!;
    priv = { notes: asNotes([FIRST, N]) };
    const c2 = change(0n, 88);
    const run2 = await approvedRun([{ to: BOB, amount: 250n, nonce: 0xf8 }], c2);
    await pay(run2, c2, 0, BOB, 250n, 0xf8);          // spends N (300), change 50

    const versions = [
      { version: 1, notes: asNotes([FIRST, SECOND]) },
      { version: 2, notes: asNotes([FIRST, N]) },     // the rebuild that recovered N
    ];
    let r!: ReturnType<typeof rebuildWith>;
    expect(
      () => { r = rebuildWith(versions, { payments: [
        { spent: SECOND, amount: 100n },              // landed
        { spent: SECOND, amount: 250n },              // refused by the chain; the line stays
        { spent: N, amount: 250n },                   // landed, pool write lost
      ] }); },
      'RED WHEN: the stale (SECOND, 250) line decides what N is worth, and the correct (N, 250) line is refused as "the journal line is wrong"',
    ).not.toThrow();
    expect(
      r.recovered.map((n) => n.value),
      'RED WHEN: the correct line is derived from a poisoned value, so the real change note of 50 is reported as a commitment nothing explains',
    ).toEqual([50n]);
    expect(r.unexplained).toHaveLength(0);
    expect(r.stale.map((n) => n.nonce)).toEqual([N.nonce]);

    /* And the 50 spends. */
    priv = { notes: asNotes(r.held) };
    const c3 = change(0n, 89);
    const run3 = await approvedRun([{ to: CAROL, amount: 40n, nonce: 0xf9 }], c3);
    await pay(run3, c3, 0, CAROL, 40n, 0xf9);
    expect(vaultLedger(vaultState as never).payments).toBe(3n);
  });

  /* ---------------------------------------------------------------- *
   * payout
   * ---------------------------------------------------------------- */

  it('W2, PAYOUT: the change is on chain, the pool still holds the spent note — and it SPENDS',
    async () => {
      /*
       * **THE WORST OF THE WINDOWS AND THE ONE `C199` NAMES.** The payment
       * landed: the chain has nullified the note that was spent and holds the
       * change instead. The pool believes it can still spend something the
       * contract has already removed.
       *
       * Two things must come out of the recovery and both matter: the change
       * note, which nobody wrote down, and the fact that the spent note is
       * STALE — carrying it forward is a payment refused at the contract's
       * membership check.
       */
      const c = change(0n, 52);
      const run = await approvedRun([{ to: ALICE, amount: 250n, nonce: 0xd1 }], c);
      await pay(run, c, 0, ALICE, 250n, 0xd1);          // spends SECOND (400), change 150

      const poolBeforeCrash = asNotes([FIRST, SECOND]);   // never advanced
      const history: VaultEvent[] = [
        ...OPENING, { kind: 'payout', spent: SECOND.nonce, amount: 250n }];

      const r = recover(history, poolBeforeCrash);
      expect(r.stale.map((n) => n.nonce)).toEqual([SECOND.nonce]);
      expect(r.recovered).toHaveLength(1);
      expect(r.recovered[0].value).toBe(150n);
      expect(r.recovered[0].nonce).not.toBe(SECOND.nonce);
      expect(r.held.map((n) => n.value).sort((x, y) => Number(x - y))).toEqual([150n, 1_000n]);
      expect(r.unexplained).toHaveLength(0);

      /*
       * **AND THE CHANGE NOTE IS SPENT.** If `changeNonceOf` were the almost-right
       * derivation `V-47` is about, the note would not be in the pool the
       * contract checks and this fails at "that note is not in this vault's
       * pool". Nothing else in this file would notice.
       */
      priv = { notes: asNotes(r.held) };
      const c2 = change(0n, 53);
      const run2 = await approvedRun([{ to: BOB, amount: 120n, nonce: 0xd2 }], c2);
      await pay(run2, c2, 0, BOB, 120n, 0xd2);           // 150 is the smallest that covers it

      expect(vaultLedger(vaultState as never).payments).toBe(2n);
      const after = chainNotes();
      expect(after).toContain(held({ ...FIRST }));
      expect(after).toHaveLength(2);
    });

  it('W1, PAYOUT: recorded but never landed, so the note the pool spent is still the vault\'s',
    async () => {
      /*
       * The mirror image, and the reason the replay proposes every note that has
       * EVER existed rather than the ones it believes are live. The owner's
       * history says a payment was made; the chain says the note was never
       * spent. **The note the replay had already retired comes back**, because
       * the chain is what decides.
       */
      const history: VaultEvent[] = [
        ...OPENING, { kind: 'payout', spent: SECOND.nonce, amount: 250n }];

      const r = recover(history, asNotes([FIRST]));
      expect(r.held.map((n) => n.nonce).sort()).toEqual([FIRST.nonce, SECOND.nonce].sort());
      expect(r.recovered.map((n) => n.nonce)).toEqual([SECOND.nonce]);
      expect(r.unexplained).toHaveLength(0);

      /* And the note that was never really spent still spends. */
      priv = { notes: asNotes(r.held) };
      const c = change(0n, 54);
      const run = await approvedRun([{ to: CAROL, amount: 400n, nonce: 0xd3 }], c);
      await pay(run, c, 0, CAROL, 400n, 0xd3);           // SECOND, exactly
      expect(vaultLedger(vaultState as never).payments).toBe(1n);
    });

  it('a note spent EXACTLY leaves no change, and the replay does not invent one', async () => {
    /*
     * `payout` inserts the change only `if (result.change.is_some)`. A pool
     * entry for a zero note would be a note the chain does not have, which is
     * the divergence that makes a pool unspendable.
     */
    const c = change(0n, 55);
    const run = await approvedRun([{ to: ALICE, amount: 400n, nonce: 0xd4 }], c);
    await pay(run, c, 0, ALICE, 400n, 0xd4);

    const r = recover(
      [...OPENING, { kind: 'payout', spent: SECOND.nonce, amount: 400n }],
      asNotes([FIRST, SECOND]));

    expect(r.held.map((n) => n.nonce)).toEqual([FIRST.nonce]);
    expect(r.recovered).toHaveLength(0);
    expect(r.stale.map((n) => n.nonce)).toEqual([SECOND.nonce]);
    expect(r.unexplained).toHaveLength(0);
    expect(chainNotes()).toHaveLength(1);
  });

  /* ---------------------------------------------------------------- *
   * presplit
   * ---------------------------------------------------------------- */

  it('W2, PRESPLIT: BOTH halves are recovered, and one of them SPENDS', async () => {
    /*
     * `splitNote` removes one note and inserts two, so a crash after it leaves
     * the pool short by two notes and holding a third the chain has dropped.
     *
     * **THIS IS THE NEWLY DERIVED VALUE OF THIS ROUND AND IT IS SPENT RATHER
     * THAN COMPARED.** The piece a split sends to itself takes the SENT
     * derivation and the remainder takes the CHANGE one — two hashes whose
     * domains differ by the four characters `/2`, which is precisely the shape
     * `V-47` cost two days over. Comparing them against each other would prove
     * nothing; the assertion that matters is the payment at the end.
     */
    const r0 = await vault.impureCircuits.splitNote(ctx('splitNote'), GBP, 300n);
    vaultState = r0.context.callContext.currentQueryContext.state;   // splits SECOND (400)

    const r = recover(
      [...OPENING, { kind: 'split', spent: SECOND.nonce, amount: 300n }],
      asNotes([FIRST, SECOND]));

    expect(r.stale.map((n) => n.nonce)).toEqual([SECOND.nonce]);
    expect(r.recovered.map((n) => n.value).sort((x, y) => Number(x - y))).toEqual([100n, 300n]);
    expect(r.held).toHaveLength(3);
    expect(r.unexplained).toHaveLength(0);

    priv = { notes: asNotes(r.held) };
    const c = change(0n, 56);
    const run = await approvedRun([{ to: ALICE, amount: 80n, nonce: 0xc1 }], c);
    await pay(run, c, 0, ALICE, 80n, 0xc1);          // 100 is the smallest that covers it
    expect(vaultLedger(vaultState as never).payments).toBe(1n);

    /* And the larger half spends too, so neither derivation is right by luck. */
    const r2 = recover(
      [...OPENING,
        { kind: 'split', spent: SECOND.nonce, amount: 300n },
        { kind: 'payout', spent: r.recovered.find((n) => n.value === 100n)!.nonce, amount: 80n }],
      []);
    priv = { notes: asNotes(r2.held) };
    const c2 = change(0n, 57);
    const run2 = await approvedRun([{ to: BOB, amount: 250n, nonce: 0xc2 }], c2);
    await pay(run2, c2, 0, BOB, 250n, 0xc2);         // 300 is the smallest that covers it
    expect(vaultLedger(vaultState as never).payments).toBe(2n);
  });

  /* ---------------------------------------------------------------- *
   * what the pool buys, and what is not recoverable at all
   * ---------------------------------------------------------------- */

  it('payments against DIFFERENT notes need no order between them', async () => {
    /*
     * The property the old shape could not have. It required every payment in
     * order because each coin followed from the one before; a pool has no such
     * order, which is exactly why one stuck payment does not stall the eleven
     * behind it. Here the history is given with the two payments swapped and the
     * answer is identical.
     */
    const c = change(0n, 58);
    const run = await approvedRun([
      { to: ALICE, amount: 300n, nonce: 0xb1 },
      { to: BOB, amount: 100n, nonce: 0xb2 },
    ], c);
    await pay(run, c, 0, ALICE, 300n, 0xb1);        // SECOND (400) → change 100
    priv = { notes: asNotes([FIRST]) };             // force the other note
    await pay(run, c, 1, BOB, 100n, 0xb2);          // FIRST (1000) → change 900

    const inOrder: VaultEvent[] = [...OPENING,
      { kind: 'payout', spent: SECOND.nonce, amount: 300n },
      { kind: 'payout', spent: FIRST.nonce, amount: 100n }];
    const swapped: VaultEvent[] = [...OPENING,
      { kind: 'payout', spent: FIRST.nonce, amount: 100n },
      { kind: 'payout', spent: SECOND.nonce, amount: 300n }];

    const a = recover(inOrder, []);
    const b = recover(swapped, []);
    expect(a.held.map((n) => n.value).sort((x, y) => Number(x - y))).toEqual([100n, 900n]);
    expect(b.held.map((n) => n.nonce).sort()).toEqual(a.held.map((n) => n.nonce).sort());
    expect(a.unexplained).toHaveLength(0);
    expect(b.unexplained).toHaveLength(0);
  });

  it('A NOTE NOTHING EXPLAINS IS REPORTED AS SUCH, NEVER GUESSED AT', async () => {
    /*
     * **The one case this round does not recover, and it is a finding rather
     * than a gap in the code.** `deposit` takes a coin from anybody — that is
     * the point, nobody needs permission to be paid — so an outsider can put a
     * note into this vault that the company has no record of. A commitment
     * discloses nothing, so there is no path from those 32 bytes to a spendable
     * note. The money is visibly on chain and only the depositor can say what it
     * is.
     *
     * The right behaviour is to say so, loudly, and never to offer a plausible
     * note in its place: a wrong note is refused at payment time and looks like
     * a broken vault rather than a missing record.
     */
    const OUTSIDER = { nonce: toHex(bytes(0x5e)), token: toHex(GBP), value: 700n };
    await deposit(OUTSIDER);

    const r = recover(OPENING, asNotes([FIRST, SECOND]));
    expect(r.held).toHaveLength(2);
    expect(r.recovered).toHaveLength(0);
    expect(r.unexplained).toEqual([held(OUTSIDER)]);

    /* And it is genuinely the outsider's note, not a mis-derivation of ours. */
    expect(chainNotes()).toContain(held(OUTSIDER));
  });

  it('A PAYEE WHO LOST THEIR PAYSLIP CAN BE SERVED AGAIN, from the payer\'s history alone',
    async () => {
      /*
       * `B4`, and the backstop `C7` still leans on: a payment built with the
       * wrong encryption key settles perfectly into a coin the payee's wallet
       * never shows them. The payee's coin is derived from the note it was paid
       * out of, so it falls out of the same replay — **and with a pool, "the
       * note it was paid out of" is a thing the history has to name**, which is
       * why every spending event carries `spent`.
       */
      const c = change(0n, 59);
      const run = await approvedRun([
        { to: ALICE, amount: 100n, nonce: 0xa1 },
        { to: BOB, amount: 200n, nonce: 0xa2 },
      ], c);
      const first = await pay(run, c, 0, ALICE, 100n, 0xa1);   // SECOND (400)
      priv = { notes: asNotes([FIRST]) };
      const second = await pay(run, c, 1, BOB, 200n, 0xa2);    // FIRST (1000)

      const alices = paidCoinTo(first.context.callContext.currentZswapLocalState, toHex(ALICE));
      const bobs = paidCoinTo(second.context.callContext.currentZswapLocalState, toHex(BOB));

      const { paid } = recover([...OPENING,
        { kind: 'payout', spent: SECOND.nonce, amount: 100n },
        { kind: 'payout', spent: FIRST.nonce, amount: 200n }], []);

      expect(paid[0]).toEqual(alices);
      expect(paid[1]).toEqual(bobs);
    });

  it('the coin that LEAVES and the coin that STAYS are different derivations', () => {
    /*
     * Three derivations exist and no two are the same; two share a domain and
     * differ only by an argument. This pins that neither is quietly standing in
     * for the other — the failure `V-47` was.
     */
    const r = replayVault({
      vault: vaultAddr as Hex,
      chain: [],
      pool: [],
      history: [{ kind: 'deposit', coin: FIRST },
        { kind: 'payout', spent: FIRST.nonce, amount: 1n }],
      circuits: vaultCircuits,
    });
    const leaving = paidCoinOf(FIRST.nonce, toHex(GBP), 1n).nonce;
    expect(r.paid[0].nonce).toBe(leaving);
    expect(leaving).not.toBe(FIRST.nonce);
    /* The staying coin is not on chain here, so it is not in `held` — which is
     * itself the rule: nothing is returned that the chain has not confirmed. */
    expect(r.held).toHaveLength(0);
  });

  it('refuses a history that cannot be true rather than deriving from it', () => {
    const run = (history: VaultEvent[]) => () => replayVault({
      vault: vaultAddr as Hex, chain: chainNotes(), pool: [], history, circuits: vaultCircuits,
    });

    /* A note the vault has never held. With one chained coin this could not be
     * expressed; with a pool it is the commonest way a history goes wrong. */
    expect(run([...OPENING, { kind: 'payout', spent: toHex(bytes(0x01)), amount: 1n }]))
      .toThrow(/never held/i);
    /* The same note spent twice — the second spend has nothing to spend. */
    expect(run([...OPENING,
      { kind: 'payout', spent: FIRST.nonce, amount: 10n },
      { kind: 'payout', spent: FIRST.nonce, amount: 10n }])).toThrow(/never held|already spent/i);
    expect(run([...OPENING, { kind: 'payout', spent: FIRST.nonce, amount: 5_000n }]))
      .toThrow(/which holds 1000/i);
    expect(run([...OPENING, { kind: 'payout', spent: FIRST.nonce, amount: 0n }]))
      .toThrow(/not a pays/i);
    /* A split has to leave something behind — the contract refuses it, so a
     * history claiming one happened is a history that is wrong. */
    expect(run([...OPENING, { kind: 'split', spent: FIRST.nonce, amount: 1_000n }]))
      .toThrow(/leave something behind/i);
    /* Two notes cannot share a nonce. */
    expect(run([...OPENING, { kind: 'deposit', coin: FIRST }])).toThrow(/already holds/i);
  });

  it('the rebuilt pool is what the CHAIN holds, not what the history says', async () => {
    /*
     * The whole contract of this file in one assertion. Every note returned has
     * been checked for membership in the set the chain published, so a caller
     * has nothing left to verify — which is the difference from the function
     * this replaces, whose result was a candidate and whose callers had to know
     * that.
     */
    const r = recover(OPENING, []);
    const onChain = new Set(chainNotes());
    expect(r.held).toHaveLength(2);
    for (const n of r.held) {
      expect(onChain.has(n.commitment)).toBe(true);
      expect(n.commitment).toBe(held(n));
    }
  });
});

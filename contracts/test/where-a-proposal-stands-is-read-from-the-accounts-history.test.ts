/**
 * **WHERE EACH OF A COMPANY'S PROPOSALS STANDS, READ FROM ITS ACCOUNT'S OWN
 * HISTORY IN THE PAGE'S WORKER**, never from the company's service.
 *
 * What is real here: the account is the compiled account, moved on by its own
 * `propose`, `approve` and `cancel` circuits; each state of its history is that
 * account's own serialised state; the worker's own handler reads them with the
 * account's own ledger reader. What is the test's: the indexer, which serves
 * those states as the account's history, each step naming the circuit its call
 * called, and every step of one block carrying the state after that whole
 * block, as the indexer serves it. The last case drives the reader alone over a
 * ledger view of the test's, for the one standing no circuit here reaches: a
 * run charged to its period.
 */
import { describe, expect, it } from 'vitest';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as accountModule from '../managed/contract/index.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountSimulator, change, leafOfDevice, privateStateFor } from './simulator.js';
import { answerVaultAsk } from 'vaults-web-shared/vault-worker-entry.js';
import { roundsOnChainIn, vouchedRunIdentityOf, vouchingRunsIn } from 'vaults-web-shared/governed-call-builder.js';
import { vouchedFreshOf } from '../../src/midnight/record-tree.js';
import { NO_LEG } from '../../src/midnight/spending-policy-record.js';
import type { ContractHistory, ContractHistoryEntry } from '../../src/midnight/contract-history.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const INDEXER = { indexerUri: 'https://indexer.example/api/v4/graphql', indexerWsUri: 'wss://indexer.example/api/v4/graphql/ws' };
const stateOf = (sim: AccountSimulator): Uint8Array => (sim.contractStateForCall as { serialize(): Uint8Array }).serialize();

const roundsAsked = (history: ContractHistory, chainIds: readonly string[]) => answerVaultAsk(async () => ({
  accountPure: pureCircuits, accountLedger: (accountModule as any).ledger, runtimeState: (runtime as any).ContractState,
  historyAt: (indexer: typeof INDEXER) => { expect(indexer).toEqual(INDEXER); return history; },
}) as never, { id: 1, network: 'undeployed', ask: 'rounds-on-chain', account: 'ad'.repeat(32), indexer: INDEXER, chainIds } as never);

/** A governance proposal `by` raises, with the salt `seed` picks: its payload, the device carrying its salt, and its identity. */
const aChange = (sim: AccountSimulator, by: typeof A, n: number, seed: number) => {
  const c = change(0n, seed);
  const payload = pureCircuits.signerAddPayload(leafOfDevice(privateStateFor(n)));
  return { payload, by: sim.applying(by, c), id: sim.proposalId(payload, c.salt) };
};

describe('WHERE A PROPOSAL STANDS, READ FROM THE ACCOUNT\'S HISTORY IN THE WORKER', () => {
  it('OPEN WITH THE CHAIN\'S COUNT, WITHDRAWN BY THE CALL THAT CLOSED IT, OR NEVER HELD; RAISED AT ITS BLOCK\'S TIME BY ITS ONE PROPOSE CALL', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const steps: ContractHistoryEntry[] = [];
    /* Every step of one block carries the state after the whole block, as the indexer serves it. */
    const block = (height: number, calls: ReadonlyArray<readonly [string, string]>) => {
      const state = stateOf(sim);
      for (const [entryPoint, tx] of calls) steps.push({ kind: 'call', transaction: tx, entryPoint, state, block: { height, at: 1_800_000_000_000 + height }, succeeded: true });
    };
    steps.push({ kind: 'deploy', transaction: '00'.repeat(32), state: stateOf(sim), block: { height: 10, at: 1_800_000_000_010 }, succeeded: true });
    const kept = aChange(sim, A, 3, 711);
    const withdrawn = aChange(sim, A, 4, 712);
    const never = aChange(sim, A, 5, 713);
    const twice = aChange(sim, B, 6, 714);
    await sim.as(kept.by).propose(kept.payload);
    block(11, [['propose', '11'.repeat(32)]]);
    await sim.as(B).approve(kept.id);
    await sim.as(withdrawn.by).propose(withdrawn.payload);
    block(12, [['approve', '12'.repeat(32)], ['propose', '13'.repeat(32)]]);
    await sim.as(withdrawn.by).cancel(withdrawn.id);
    await sim.as(twice.by).propose(twice.payload);
    block(13, [['cancel', '14'.repeat(32)], ['propose', '15'.repeat(32)], ['propose', '16'.repeat(32)]]);
    const history: ContractHistory = { latest: async () => steps.at(-1)!.transaction, of: async () => [...steps] };
    const answer = await roundsAsked(history, [kept.id, withdrawn.id, never.id, twice.id].map((id) => hex(id).toUpperCase())) as any;
    expect(answer.ok).toBe(true);
    const r = answer.rounds as Record<string, unknown>;
    /* RED WHEN: a proposal the account holds is read with a count other than the account's, or raised at another block or by another call. */
    expect(r[hex(kept.id)]).toEqual({ held: 'open', approvals: 2, raisedAt: 1_800_000_000_011, txRef: '11'.repeat(32), needed: 2 });
    /* RED WHEN: a proposal the account held and no longer holds reads as open, or as closed by anything but the calls of the block that closed it. */
    expect(r[hex(withdrawn.id)]).toEqual({
      held: 'closed', approvals: 0, raisedAt: 1_800_000_000_012, txRef: '13'.repeat(32), closedBy: ['cancel', 'propose'],
    });
    /* RED WHEN: a proposal the account never held is given a time or a call it was raised by. */
    expect(r[hex(never.id)]).toEqual({ held: 'never', approvals: 0 });
    /* RED WHEN: one of two propose calls in a block is named as the call that raised it - a state is the whole block's. */
    expect(r[hex(twice.id)]).toEqual({ held: 'open', approvals: 1, raisedAt: 1_800_000_000_013, needed: 2 });
  });

  it('A CLOSE IS READ FROM THE CALLS THAT SUCCEEDED; AN IDENTITY HELD AGAIN IS READ FROM ITS LATEST TIME; ONE OPENED AND CLOSED IN A BLOCK IS NEVER SEEN', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const steps: ContractHistoryEntry[] = [];
    /* Every step of one block carries the state after the whole block; a call names whether its transaction succeeded in full. */
    const block = (height: number, calls: ReadonlyArray<readonly [string, string, boolean?]>) => {
      const state = stateOf(sim);
      for (const [entryPoint, tx, ok] of calls) {
        steps.push({ kind: 'call', transaction: tx, entryPoint, state, block: { height, at: 1_800_000_000_000 + height }, succeeded: ok !== false });
      }
    };
    steps.push({ kind: 'deploy', transaction: '00'.repeat(32), state: stateOf(sim), block: { height: 10, at: 1_800_000_000_010 }, succeeded: true });
    const carried = aChange(sim, A, 3, 721);
    const again = aChange(sim, A, 4, 722);
    const quick = aChange(sim, A, 5, 723);
    await sim.as(carried.by).propose(carried.payload);
    await sim.as(again.by).propose(again.payload);
    /* A propose that failed beside the one that raised `carried`: the one that succeeded raised it. */
    block(11, [['propose', '21'.repeat(32), false], ['propose', '22'.repeat(32)], ['propose', '23'.repeat(32), false]]);
    await sim.as(B).approve(carried.id);
    await sim.as(again.by).cancel(again.id);
    block(12, [['approve', '25'.repeat(32)], ['cancel', '26'.repeat(32)]]);
    /* `carried` is carried out in a block where somebody's withdrawal of another proposal failed. */
    await sim.as(carried.by).addSigner(leafOfDevice(privateStateFor(3)), carried.id);
    block(13, [['cancel', '27'.repeat(32), false], ['amendSigner', '28'.repeat(32)]]);
    /* `again` is proposed again under the same salt: the same identity, held a second time. */
    await sim.as(again.by).propose(again.payload);
    /* `quick` is proposed and withdrawn within one block: no block's state ever holds it. */
    await sim.as(quick.by).propose(quick.payload);
    await sim.as(quick.by).cancel(quick.id);
    block(14, [['propose', '29'.repeat(32)], ['propose', '2a'.repeat(32)], ['cancel', '2b'.repeat(32)]]);
    const history: ContractHistory = { latest: async () => steps.at(-1)!.transaction, of: async () => [...steps] };
    const answer = await roundsAsked(history, [carried.id, again.id, quick.id].map((id) => hex(id))) as any;
    expect(answer.ok).toBe(true);
    const r = answer.rounds as Record<string, any>;
    /* RED WHEN: a failed call of the block that closed it is named among the calls that closed it - a change carried out beside a failed withdrawal would read withdrawn. */
    expect(r[hex(carried.id)].closedBy).toEqual(['amendSigner']);
    /* RED WHEN: a propose whose transaction failed is counted beside the one that raised it, so the one that did is not named. */
    expect(r[hex(carried.id)].txRef).toBe('22'.repeat(32));
    /* RED WHEN: an identity held again after it closed is read from its first time held - closed, with that time's block and call. */
    /* Raised again under the same salt, it counts its raiser once more although the raiser's approval was burned the first time. */
    expect(r[hex(again.id)]).toEqual({ held: 'open', approvals: 1, raisedAt: 1_800_000_000_014, needed: 2 });
    /* What the chain cannot show: a proposal opened and closed within one block reads as never held. */
    expect(r[hex(quick.id)]).toEqual({ held: 'never', approvals: 0 });
  });

  it('A RUN CHARGED TO ITS PERIOD IS CLEARED, AND AN IDENTITY THAT IS NOT THIRTY-TWO BYTES IS NOT ASKED ABOUT', () => {
    const ID = 'ab'.repeat(32);
    /* A ledger view of the test's: the run held under the mark `clearRun` writes. */
    const view = (entry: Uint8Array | null) => ({
      openProposals: { member: () => entry !== null, lookup: () => entry! },
      approvalCounts: { member: () => entry !== null, lookup: () => 2n },
    });
    const deps = (entry: Uint8Array | null) => ({
      accountPure: pureCircuits, accountLedger: () => view(entry), runtimeState: { deserialize: () => ({ data: null }) },
    }) as never;
    const steps = [{ kind: 'call', transaction: '21'.repeat(32), entryPoint: 'propose', state: new Uint8Array(1), block: { height: 21, at: 21 }, succeeded: true }];
    /* RED WHEN: a run charged to its period reads as merely open. */
    expect(roundsOnChainIn(deps(pureCircuits.clearedMark()), steps, [ID]).get(ID)).toEqual({ held: 'cleared', approvals: 2, raisedAt: 21, txRef: '21'.repeat(32) });
    expect(roundsOnChainIn(deps(new Uint8Array(32).fill(7)), steps, [ID]).get(ID)?.held).toBe('open');
    /* RED WHEN: an identity of any other length is asked of the account. */
    expect(() => roundsOnChainIn(deps(null), steps, ['ab'])).toThrow(/not thirty-two bytes/);
  });
});

describe('A PAYROLL RUN VOUCHES FOR THE HEAD IT WAS RAISED OVER ONLY ONCE PAID OR CHARGED WITH THE ACCOUNT\'S THRESHOLD OF APPROVALS', () => {
  const RUN = 'a1'.repeat(32);
  const OTHER = 'a2'.repeat(32);
  type Held = { change: Uint8Array; approvals: bigint; raisedAtRemovals: bigint; paid?: boolean; needed?: bigint; noHold?: boolean };
  /** One block's state, as a ledger view of the test's: the account's threshold, its removals so far, and each proposal it holds. */
  type State = { threshold: bigint; removals: bigint; held: Record<string, Held> };
  const COMMITMENT = new Uint8Array(32).fill(7);
  const viewOf = (st: State) => {
    const ids = Object.keys(st.held);
    const hold = (h: Held | undefined, removals: bigint) => ({
      needed: h?.needed ?? 0n, withdrawKey: new Uint8Array(32), removals,
      runHold: { placedBy: h?.paid === true ? pureCircuits.paidFromMark() : new Uint8Array(32), releaseNeeded: 0n, releaseApprovals: 0n, releaseRemovals: 0n },
    });
    return {
      threshold: st.threshold,
      openProposals: {
        member: (id: Uint8Array) => hex(id) in st.held, lookup: (id: Uint8Array) => st.held[hex(id)]!.change,
        [Symbol.iterator]: function* () { for (const id of ids) yield [Buffer.from(id, 'hex'), st.held[id]!.change]; },
      },
      approvalCounts: { member: (id: Uint8Array) => hex(id) in st.held, lookup: (id: Uint8Array) => st.held[hex(id)]!.approvals },
      proposalHolds: {
        member: (id: Uint8Array) => (hex(id) in st.held && st.held[hex(id)]!.noHold !== true) || hex(id) === hex(pureCircuits.removalCountKey()),
        lookup: (id: Uint8Array) => (hex(id) === hex(pureCircuits.removalCountKey()) ? hold(undefined, st.removals) : hold(st.held[hex(id)], st.held[hex(id)]!.raisedAtRemovals)),
      },
    };
  };
  const vouching = (states: readonly State[], accountPure: Partial<typeof pureCircuits> = pureCircuits) => vouchingRunsIn({
    accountPure, accountLedger: (data: unknown) => viewOf(states[data as number]!),
    runtimeState: { deserialize: (state: Uint8Array) => ({ data: state[0] }) },
  } as never, states.map((_, i) => ({ state: Uint8Array.of(i), block: { height: 30 + i, at: 3000 + i } })));
  const cleared = (approvals: bigint, raisedAtRemovals = 0n): Held => ({ change: pureCircuits.clearedMark(), approvals, raisedAtRemovals });
  const paid = (approvals: bigint, raisedAtRemovals = 0n): Held => ({ change: COMMITMENT, approvals, raisedAtRemovals, paid: true });
  const open = (approvals: bigint): Held => ({ change: COMMITMENT, approvals, raisedAtRemovals: 0n });

  it('AN OPEN PROPOSAL RAISED BEFORE A SIGNER WAS REMOVED IS READ AS ONE THE ACCOUNT WILL NEVER CARRY OUT', () => {
    const standing = (states: readonly State[]) => roundsOnChainIn({
      accountPure: pureCircuits, accountLedger: (data: unknown) => viewOf(states[data as number]!),
      runtimeState: { deserialize: (state: Uint8Array) => ({ data: state[0] }) },
    } as never, states.map((_, i) => ({
      kind: 'call', transaction: `3${i}`.repeat(32), entryPoint: 'propose', state: Uint8Array.of(i), block: { height: 30 + i, at: 3000 + i }, succeeded: true,
    })), [RUN]).get(RUN);
    /* RED WHEN: a proposal whose hold took a count of removals the account has since moved past is read as one it can still carry out. */
    expect(standing([{ threshold: 2n, removals: 0n, held: { [RUN]: open(2n) } }, { threshold: 2n, removals: 1n, held: { [RUN]: open(2n) } }])?.outrun).toBe(true);
    expect(standing([{ threshold: 2n, removals: 1n, held: { [RUN]: { ...open(2n), raisedAtRemovals: 1n } } }])?.outrun).toBeUndefined();
  });

  it('AN OPEN PROPOSAL CARRIES THE APPROVALS THE ACCOUNT RECORDED IT AS NEEDING WHEN IT WAS RAISED, AND NONE WHERE IT HOLDS NO HOLD FOR IT', () => {
    const standing = (states: readonly State[]) => roundsOnChainIn({
      accountPure: pureCircuits, accountLedger: (data: unknown) => viewOf(states[data as number]!),
      runtimeState: { deserialize: (state: Uint8Array) => ({ data: state[0] }) },
    } as never, states.map((_, i) => ({
      kind: 'call', transaction: `3${i}`.repeat(32), entryPoint: 'propose', state: Uint8Array.of(i), block: { height: 30 + i, at: 3000 + i }, succeeded: true,
    })), [RUN]).get(RUN);
    /* RED WHEN: the approvals the account's hold says a proposal needed when it was raised are not read off the chain, so a removal is counted against the seat bar now alone. */
    expect(standing([{ threshold: 2n, removals: 0n, held: { [RUN]: { ...open(2n), needed: 3n } } }])?.needed).toBe(3);
    /* RED WHEN: a proposal the account holds no hold for is given a number it needed. */
    expect(standing([{ threshold: 2n, removals: 0n, held: { [RUN]: { ...open(2n), noHold: true } } }])?.needed).toBeUndefined();
  });

  it('A RUN CHARGED, OR PAID, WITH AT LEAST THE ACCOUNT\'S THRESHOLD VOUCHES, AS OF THE LAST BLOCK THAT SHOWS IT SO', () => {
    /* RED WHEN: a run the account charged to its period with its threshold of approvals vouches for nothing. */
    expect(vouching([{ threshold: 2n, removals: 0n, held: { [RUN]: open(1n) } }, { threshold: 2n, removals: 0n, held: { [RUN]: cleared(2n) } }]))
      .toEqual([{ chainId: RUN, height: 31, at: 3001 }]);
    /* RED WHEN: a run marked paid from with its threshold of approvals vouches for nothing. */
    expect(vouching([{ threshold: 2n, removals: 0n, held: { [RUN]: paid(2n) } }])).toEqual([{ chainId: RUN, height: 30, at: 3000 }]);
    /* RED WHEN: a run is read from its first marked block rather than its last; one the account has since closed still vouches, as of the last block that showed it. */
    expect(vouching([
      { threshold: 1n, removals: 0n, held: { [RUN]: paid(1n) } }, { threshold: 1n, removals: 0n, held: { [RUN]: paid(1n) } }, { threshold: 1n, removals: 0n, held: {} },
    ])).toEqual([{ chainId: RUN, height: 31, at: 3001 }]);
  });

  it('A RUN SHORT OF THE ACCOUNT\'S THRESHOLD, PLUS ONE FOR EVERY SIGNER REMOVED SINCE IT WAS RAISED, OR NEVER PAID OR CHARGED, VOUCHES FOR NOTHING', () => {
    /* RED WHEN: a run approved under a vault's lower threshold, below the account's, vouches. */
    expect(vouching([{ threshold: 2n, removals: 0n, held: { [RUN]: cleared(1n) } }])).toEqual([]);
    /* RED WHEN: a removal since it was raised is not counted against its approvals, as the account counts it before it pays. */
    expect(vouching([{ threshold: 2n, removals: 1n, held: { [RUN]: paid(2n) } }])).toEqual([]);
    expect(vouching([{ threshold: 2n, removals: 1n, held: { [RUN]: paid(3n) } }])).toEqual([{ chainId: RUN, height: 30, at: 3000 }]);
    expect(vouching([{ threshold: 2n, removals: 3n, held: { [RUN]: paid(3n, 2n) } }])).toEqual([{ chainId: RUN, height: 30, at: 3000 }]);
    /* RED WHEN: the last block showing it marked is not the one counted: a removal after it was paid stops it vouching. */
    expect(vouching([{ threshold: 2n, removals: 0n, held: { [RUN]: paid(2n) } }, { threshold: 2n, removals: 1n, held: { [RUN]: paid(2n) } }])).toEqual([]);
    /* RED WHEN: an open proposal, approved but neither paid nor charged, vouches. */
    expect(vouching([{ threshold: 1n, removals: 0n, held: { [RUN]: open(5n), [OTHER]: cleared(1n) } }])).toEqual([{ chainId: OTHER, height: 30, at: 3000 }]);
    /* RED WHEN: a run the account charged but holds no hold for vouches, or stops the read: its bar when raised cannot be known. */
    expect(vouching([{ threshold: 1n, removals: 0n, held: { [RUN]: { ...cleared(5n), noHold: true }, [OTHER]: cleared(1n) } }]))
      .toEqual([{ chainId: OTHER, height: 30, at: 3000 }]);
  });

  it('A RUN RAISED NEEDING MORE THAN THE ACCOUNT\'S THRESHOLD VOUCHES ONLY AT THE BAR IT WAS RAISED AT, AS THE ACCOUNT COUNTS IT', () => {
    /* RED WHEN: the device counts a run against the account's threshold alone, below the bar the run was raised at. */
    expect(vouching([{ threshold: 2n, removals: 0n, held: { [RUN]: { ...paid(2n), needed: 3n } } }])).toEqual([]);
    expect(vouching([{ threshold: 2n, removals: 0n, held: { [RUN]: { ...paid(3n), needed: 3n } } }])).toEqual([{ chainId: RUN, height: 30, at: 3000 }]);
    /* RED WHEN: the device adds the removals to the account's threshold instead of to the higher of it and the run's bar. */
    expect(vouching([{ threshold: 2n, removals: 1n, held: { [RUN]: { ...cleared(3n), needed: 3n } } }])).toEqual([]);
    expect(vouching([{ threshold: 2n, removals: 1n, held: { [RUN]: { ...cleared(4n), needed: 3n } } }])).toEqual([{ chainId: RUN, height: 30, at: 3000 }]);
  });

  it('THE BAR IS THE ACCOUNT\'S OWN COUNT: A DEVICE NOT GIVEN IT REFUSES TO READ RATHER THAN COUNTING FOR ITSELF', () => {
    const { runApprovalsNeeded: _, ...without } = pureCircuits;
    /* RED WHEN: vouchingRunsIn counts a run's approvals by a sum of its own when the account's circuit is missing. */
    expect(() => vouching([{ threshold: 2n, removals: 0n, held: { [RUN]: paid(2n) } }], without)).toThrow(/was not read. Reload the page/);
    /* RED WHEN: vouchingRunsIn stops asking the account's circuit, so a bar the account sets is not the one a run vouches at. */
    const asked: bigint[][] = [];
    const counting = { ...pureCircuits, runApprovalsNeeded: (...a: [bigint, bigint, bigint, bigint]) => { asked.push(a); return 9n; } };
    expect(vouching([{ threshold: 2n, removals: 1n, held: { [RUN]: { ...paid(5n, 0n), needed: 3n } } }], counting)).toEqual([]);
    expect(asked).toEqual([[3n, 2n, 1n, 0n]]);
  });
});

describe('THE IDENTITY A LEG\'S RUN HAS, RAISED OVER THE HEAD IT SEALS, IS MADE AGAIN BY THE ACCOUNT\'S OWN FUNCTIONS', () => {
  const run = {
    root: 'ab'.repeat(32), payees: '3', opensAt: '1800000000', closesAt: '1800600000', required: '2', vault: 'cd'.repeat(32),
    head: '1a'.repeat(32), r: '2b'.repeat(32),
  };
  const raisedAs = (head: string) => hex(pureCircuits.proposalIdOf(
    pureCircuits.runPayload(Buffer.from(run.root, 'hex'), 3n, 1_800_000_000n, 1_800_600_000n, 2n), Buffer.from(run.vault, 'hex'),
    pureCircuits.retrySaltOf(NO_LEG(), Buffer.from(vouchedFreshOf(head as never, run.r as never), 'hex'))));

  it('IS THE IDENTITY ITS RAISER PROPOSED, AND ANOTHER HEAD, WINDOW OR VAULT MAKES ANOTHER; A RUN OF NO VAULT VOUCHES FOR NOTHING', () => {
    const deps = { accountPure: pureCircuits } as never;
    /* RED WHEN: the identity is made other than as every raising device makes it - its salt over no leg and the fresh half made from the head and value. */
    expect(vouchedRunIdentityOf(deps, run)).toBe(raisedAs(run.head));
    /* RED WHEN: the head is left out of what the identity is made from, so a run vouches for any head. */
    expect(vouchedRunIdentityOf(deps, { ...run, head: '1c'.repeat(32) })).not.toBe(raisedAs(run.head));
    expect(vouchedRunIdentityOf(deps, { ...run, closesAt: '1800600001' })).not.toBe(raisedAs(run.head));
    /* RED WHEN: a run of no vault - a governance record - is taken to vouch. */
    expect(vouchedRunIdentityOf(deps, { ...run, vault: hex(pureCircuits.noVault()) })).toBeNull();
    /* RED WHEN: a sealed pair naming the empty head is made into an identity. */
    expect(vouchedRunIdentityOf(deps, { ...run, head: '00'.repeat(32) })).toBeNull();
  });
});

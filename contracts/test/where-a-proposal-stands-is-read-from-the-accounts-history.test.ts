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
 * block, as the indexer serves it: it reads one contract state per block, at
 * that block, for every action of the contract in it. Approvals given in the
 * block that closes a proposal are never seen. Which call of a block raised or
 * closed a proposal is read from its transaction's bytes where a step carries
 * them: those transactions are the ledger's own, built from the operations the
 * compiled circuits ran, left unproven because no proof is made here. A step
 * that carries no bytes is read with the rest of its block. One case drives the
 * reader alone over a ledger view of the test's, for the one standing no
 * circuit here reaches: a run charged to its period.
 */
import { describe, expect, it } from 'vitest';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as accountModule from '../managed/contract/index.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountSimulator, change, invitePayloadFor, privateStateFor, rootOfTestLeaves, TEST_AMOUNT, TEST_TOKEN_BYTES, transactionOfCalls } from './simulator.js';
import { payoutLeafOf, sumTreeOfLeaves } from '../../src/midnight/payout-tree.js';
import { answerVaultAsk } from 'vaults-web-shared/vault-worker-entry.js';
import { roundsOnChainIn, vouchedRunIdentityOf, vouchingRunsIn } from 'vaults-web-shared/governed-call-builder.js';
import { vouchedFreshOf } from '../../src/midnight/record-tree.js';
import { NO_LEG } from '../../src/midnight/spending-policy-record.js';
import { adoptionRoundOf } from '../../src/midnight/vault-start.js';
import type { ContractHistory, ContractHistoryEntry } from '../../src/midnight/contract-history.js';
import * as L from '@midnightntwrk/ledger-v9';
import { standingOnChainHere } from 'vaults-web-shared/run-rebuilt-here.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const INDEXER = { indexerUri: 'https://indexer.example/api/v4/graphql', indexerWsUri: 'wss://indexer.example/api/v4/graphql/ws' };
const stateOf = (sim: AccountSimulator): Uint8Array => (sim.contractStateForCall as { serialize(): Uint8Array }).serialize();

const roundsAsked = (
  history: ContractHistory, chainIds: readonly string[], seat?: { readonly account: string; readonly signingSecret: string },
) => answerVaultAsk(async () => ({
  accountPure: pureCircuits, accountLedger: (accountModule as any).ledger, runtimeState: (runtime as any).ContractState,
  historyAt: (indexer: typeof INDEXER) => { expect(indexer).toEqual(INDEXER); return history; },
}) as never, {
  id: 1, network: 'undeployed', ask: 'rounds-on-chain', account: seat?.account ?? 'ad'.repeat(32), indexer: INDEXER, chainIds,
  ...(seat === undefined ? {} : { seat: seat.signingSecret }),
} as never);

/*
 * The ledger the worker is handed: the installed one, reading the test's transactions, which carry no proof, with the
 * `pre-proof` marker, and recording which form it was asked for.
 */
const formsAsked: string[][] = [];
const unprovenLedger = {
  Transaction: {
    deserialize: (s: string, p: string, b: string, raw: Uint8Array) => {
      formsAsked.push([s, p, b]);
      return L.Transaction.deserialize('signature', 'pre-proof', 'binding', raw);
    },
  },
};

/** A governance proposal `by` raises, with the salt `seed` picks: its payload, the device carrying its salt, and its identity. */
const aChange = (sim: AccountSimulator, by: typeof A, n: number, seed: number) => {
  const c = change(0n, seed);
  const payload = invitePayloadFor(privateStateFor(n));
  return { payload, by: sim.applying(by, c), id: sim.proposalId(payload, c.salt), invitee: sim.invited(privateStateFor(n), c) };
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
    /* RED WHEN: a closed proposal loses the count and the bar it stood at when it closed: its raiser's approval, of the two it needed. */
    expect(r[hex(withdrawn.id)]).toEqual({
      held: 'closed', approvals: 1, needed: 2, raisedAt: 1_800_000_000_012, txRef: '13'.repeat(32), closedBy: ['cancel', 'propose'],
    });
    /* RED WHEN: a proposal the account never held is given a time or a call it was raised by. */
    expect(r[hex(never.id)]).toEqual({ held: 'never', approvals: 0 });
    /* RED WHEN: one of two propose calls in a block is named as the call that raised it - a state is the whole block's. */
    expect(r[hex(twice.id)]).toEqual({ held: 'open', approvals: 1, raisedAt: 1_800_000_000_013, needed: 2 });
  });

  it("WITH A SEAT, EACH SAYS WHETHER THAT SEAT'S APPROVAL IS ON THE CHAIN, MADE WITH THE ACCOUNT'S OWN DERIVATION OVER THIS ACCOUNT", async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const steps: ContractHistoryEntry[] = [];
    const block = (height: number, calls: ReadonlyArray<readonly [string, string]>) => {
      const state = stateOf(sim);
      for (const [entryPoint, tx] of calls) steps.push({ kind: 'call', transaction: tx, entryPoint, state, block: { height, at: 1_800_000_000_000 + height }, succeeded: true });
    };
    steps.push({ kind: 'deploy', transaction: '00'.repeat(32), state: stateOf(sim), block: { height: 10, at: 1_800_000_000_010 }, succeeded: true });
    const byA = aChange(sim, A, 3, 721);
    const byB = aChange(sim, B, 4, 722);
    const never = aChange(sim, A, 5, 723);
    await sim.as(byA.by).propose(byA.payload);
    await sim.as(byB.by).propose(byB.payload);
    block(11, [['propose', '11'.repeat(32)], ['propose', '12'.repeat(32)]]);
    const history: ContractHistory = { latest: async () => steps.at(-1)!.transaction, of: async () => [...steps] };
    const ids = [byA.id, byB.id, never.id].map(hex);
    const account = hex(sim.selfBytes());
    const asA = (await roundsAsked(history, ids, { account, signingSecret: hex(A.secretKey) }) as any).rounds as Record<string, any>;
    /* RED WHEN: a raise counted as its raiser's approval is not read as that seat's - the raiser is then asked to approve again. */
    expect(asA[hex(byA.id)].approvedHere).toBe(true);
    /* RED WHEN: another seat's approval is read as this one's - this seat then never approves. */
    expect(asA[hex(byB.id)].approvedHere).toBe(false);
    expect(asA[hex(never.id)]).toEqual({ held: 'never', approvals: 0, approvedHere: false });
    await sim.as(B).approve(byA.id);
    block(12, [['approve', '13'.repeat(32)]]);
    const asB = (await roundsAsked(history, ids, { account, signingSecret: hex(B.secretKey) }) as any).rounds as Record<string, any>;
    /* RED WHEN: an approval landing is not read as the seat that sent it. */
    expect([asB[hex(byA.id)].approvedHere, asB[hex(byB.id)].approvedHere]).toEqual([true, true]);
    const elsewhere = (await roundsAsked(history, ids, { account: 'ad'.repeat(32), signingSecret: hex(A.secretKey) }) as any).rounds as Record<string, any>;
    /* RED WHEN: the marker is made over another account than the one asked about, so a seat's approval elsewhere reads as approved here. */
    expect(elsewhere[hex(byA.id)].approvedHere).toBe(false);
    /* Asked with no seat, nothing is said of any seat's approval. */
    expect('approvedHere' in ((await roundsAsked(history, ids) as any).rounds[hex(byA.id)])).toBe(false);
  });

  it("WITH A SEAT, A PROPOSAL HELD SAYS WHETHER THAT SEAT RAISED IT, BY THE WITHDRAW KEY ITS HOLD CARRIES", async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const steps: ContractHistoryEntry[] = [];
    const block = (height: number, calls: ReadonlyArray<readonly [string, string]>) => {
      const state = stateOf(sim);
      for (const [entryPoint, tx] of calls) steps.push({ kind: 'call', transaction: tx, entryPoint, state, block: { height, at: 1_800_000_000_000 + height }, succeeded: true });
    };
    steps.push({ kind: 'deploy', transaction: '00'.repeat(32), state: stateOf(sim), block: { height: 10, at: 1_800_000_000_010 }, succeeded: true });
    const byA = aChange(sim, A, 3, 731);
    const byB = aChange(sim, B, 4, 732);
    const never = aChange(sim, A, 5, 733);
    await sim.as(byA.by).propose(byA.payload);
    await sim.as(byB.by).propose(byB.payload);
    block(11, [['propose', '21'.repeat(32)], ['propose', '22'.repeat(32)]]);
    await sim.as(B).approve(byA.id);
    block(12, [['approve', '23'.repeat(32)]]);
    const history: ContractHistory = { latest: async () => steps.at(-1)!.transaction, of: async () => [...steps] };
    const ids = [byA.id, byB.id, never.id].map(hex);
    const account = hex(sim.selfBytes());
    const asA = (await roundsAsked(history, ids, { account, signingSecret: hex(A.secretKey) }) as any).rounds as Record<string, any>;
    const asB = (await roundsAsked(history, ids, { account, signingSecret: hex(B.secretKey) }) as any).rounds as Record<string, any>;
    /* RED WHEN: the seat that raised a proposal is not read as its raiser - its raiser then cannot withdraw it from the wallet. */
    expect([asA[hex(byA.id)].raisedHere, asB[hex(byB.id)].raisedHere]).toEqual([true, true]);
    /* RED WHEN: a seat that approved, or never touched, another seat's proposal is read as its raiser - the wallet then builds a withdrawal the account refuses. */
    expect([asA[hex(byB.id)].raisedHere, asB[hex(byA.id)].raisedHere]).toEqual([false, false]);
    const elsewhere = (await roundsAsked(history, ids, { account: 'ad'.repeat(32), signingSecret: hex(A.secretKey) }) as any).rounds as Record<string, any>;
    /* RED WHEN: the withdraw key is made over another account than the one asked about. */
    expect(elsewhere[hex(byA.id)].raisedHere).toBe(false);
    /* Never held, or asked with no seat, nothing is said of who raised it. */
    expect('raisedHere' in asA[hex(never.id)]).toBe(false);
    expect('raisedHere' in ((await roundsAsked(history, ids) as any).rounds[hex(byA.id)])).toBe(false);
    /* The account takes the raiser's own withdrawal; once it no longer holds the proposal, nothing is said of who raised it. */
    await sim.as(A).cancel(byA.id);
    block(13, [['cancel', '24'.repeat(32)]]);
    const closed = (await roundsAsked(history, ids, { account, signingSecret: hex(A.secretKey) }) as any).rounds[hex(byA.id)];
    expect(closed.held).toBe('closed');
    expect('raisedHere' in closed).toBe(false);
  });

  it("A VAULT'S START, ASKED WITH A SEAT, SAYS WHETHER THAT SEAT'S APPROVAL OF ITS ADOPTION IS ON THE CHAIN, OVER THIS ACCOUNT", async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const VAULT = '5a'.repeat(32);
    const round = adoptionRoundOf(pureCircuits as never, VAULT);
    await sim.as(sim.applying(A, { ...change(0n, 731), salt: Buffer.from(round.salt, 'hex') })).propose(Buffer.from(round.payload, 'hex'));
    expect(hex(sim.proposalId(Buffer.from(round.payload, 'hex'), Buffer.from(round.salt, 'hex')))).toBe(round.proposal);
    const state = Buffer.from(stateOf(sim)).toString('base64');
    /* The worker's own handler, over the account's own ledger reader; no first secret is asked about, so the vault's state is not read. */
    const standingAsked = async (account: string, seat?: Uint8Array) => ((await answerVaultAsk(async () => ({
      accountPure: pureCircuits, accountLedger: (accountModule as any).ledger, runtimeState: (runtime as any).ContractState,
      vault: { pureCircuits: {}, ledger: () => ({}) },
    }) as never, {
      id: 1, network: 'undeployed', ask: 'start-standing', vault: VAULT, account, accountState: state, vaultState: state, now: '1',
      ...(seat === undefined ? {} : { seat: hex(seat) }),
    } as never)) as any).standing.adoption;
    const account = hex(sim.selfBytes());
    /* RED WHEN: the worker drops the seat it was asked with - the raiser's start then cannot tell its raise counted. */
    expect((await standingAsked(account, A.secretKey)).approvedHere).toBe(true);
    /* RED WHEN: another seat's approval is read as this one's - that seat then never approves the adoption. */
    expect((await standingAsked(account, B.secretKey)).approvedHere).toBe(false);
    /* RED WHEN: the marker is made over another account than the one asked about. */
    expect((await standingAsked('ad'.repeat(32), A.secretKey)).approvedHere).toBe(false);
    expect('approvedHere' in (await standingAsked(account))).toBe(false);
    const whole = ((await answerVaultAsk(async () => ({
      accountPure: pureCircuits, accountLedger: (accountModule as any).ledger, runtimeState: (runtime as any).ContractState,
      vault: { pureCircuits: {}, ledger: () => ({}) },
    }) as never, { id: 2, network: 'undeployed', ask: 'start-standing', vault: VAULT, account, accountState: state, vaultState: state, now: '1' } as never)) as any).standing;
    /* RED WHEN: the worker drops the account's count of removals, so no device can tell a secret a leaver may open. */
    expect(whole.removals).toBe(0);
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
    await sim.seatInvited(carried.id, carried.invitee);
    block(13, [['cancel', '27'.repeat(32), false], ['seatInvited', '28'.repeat(32)]]);
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
    expect(r[hex(carried.id)].closedBy).toEqual(['seatInvited']);
    /* RED WHEN: a propose whose transaction failed is counted beside the one that raised it, so the one that did is not named. */
    expect(r[hex(carried.id)].txRef).toBe('22'.repeat(32));
    /* RED WHEN: a proposal carried out reads with no approvals, or without the bar it was carried at: it closed at 2 of 2. */
    expect(r[hex(carried.id)]).toMatchObject({ held: 'closed', approvals: 2, needed: 2 });
    /* RED WHEN: an identity held again after it closed is read from its first time held - closed, with that time's block and call. */
    /* Raised again under the same salt, it counts its raiser once more although the raiser's approval was burned the first time. */
    expect(r[hex(again.id)]).toEqual({ held: 'open', approvals: 1, raisedAt: 1_800_000_000_014, needed: 2 });
    /* What the chain cannot show: a proposal opened and closed within one block reads as never held. */
    expect(r[hex(quick.id)]).toEqual({ held: 'never', approvals: 0 });
  });

  it("EACH CALL OF A BLOCK IS READ FROM ITS TRANSACTION'S BYTES: TWO RAISES IN ONE BLOCK KEEP THEIR OWN TRANSACTIONS, AND A CARRY BESIDE ANOTHER PROPOSAL'S WITHDRAWAL CLOSES ONLY ITS OWN", async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const steps: ContractHistoryEntry[] = [];
    let pending: Array<{ readonly tx: string; readonly entryPoint: string; readonly calls: Array<{ call: unknown; entryPoint: string; address?: string }> }> = [];
    /* The call the simulator just ran, in a transaction of its own, with any call to another contract the test adds beside it. */
    const ran = (tx: string, entryPoint: string, beside: Array<{ call: unknown; entryPoint: string; address?: string }> = []) => {
      pending.push({ tx, entryPoint, calls: [{ call: sim.lastCall, entryPoint }, ...beside] });
    };
    const block = (height: number) => {
      const state = stateOf(sim);
      for (const t of pending) {
        steps.push({ kind: 'call', transaction: t.tx, entryPoint: t.entryPoint, state, block: { height, at: 1_800_000_000_000 + height }, succeeded: true, raw: transactionOfCalls(t.calls) });
      }
      pending = [];
    };
    steps.push({ kind: 'deploy', transaction: '00'.repeat(32), state: stateOf(sim), block: { height: 10, at: 1_800_000_000_010 }, succeeded: true });
    const carried = aChange(sim, A, 3, 751);
    const withdrawn = aChange(sim, A, 4, 752);
    await sim.as(carried.by).propose(carried.payload);
    ran('51'.repeat(32), 'propose');
    await sim.as(withdrawn.by).propose(withdrawn.payload);
    ran('52'.repeat(32), 'propose');
    block(11);
    await sim.as(B).approve(carried.id);
    ran('53'.repeat(32), 'approve');
    block(12);
    await sim.as(withdrawn.by).cancel(withdrawn.id);
    /* Beside the withdrawal, a call to another contract that runs the same operations on that contract's own state. */
    ran('54'.repeat(32), 'cancel', [{ call: sim.lastCall, entryPoint: 'payout', address: 'cd'.repeat(32) }]);
    await sim.seatInvited(carried.id, carried.invitee);
    ran('55'.repeat(32), 'seatInvited');
    block(13);
    const history: ContractHistory = { latest: async () => steps.at(-1)!.transaction, of: async () => [...steps] };
    formsAsked.length = 0;
    const asked = await answerVaultAsk(async () => ({
      accountPure: pureCircuits, accountLedger: (accountModule as any).ledger, runtimeState: (runtime as any).ContractState, ledger: unprovenLedger,
      historyAt: () => history,
    }) as never, { id: 1, network: 'undeployed', ask: 'rounds-on-chain', account: sim.address, indexer: INDEXER, chainIds: [hex(carried.id), hex(withdrawn.id)] } as never) as any;
    expect(asked.ok).toBe(true);
    const r = asked.rounds as Record<string, any>;
    /* RED WHEN: a raise is named only when it is the one propose of its block, so two raised in one block name no transaction. */
    expect([r[hex(carried.id)].txRef, r[hex(withdrawn.id)].txRef]).toEqual(['51'.repeat(32), '52'.repeat(32)]);
    /* RED WHEN: a close is named by every call of its block: a change carried out beside another proposal's withdrawal reads withdrawn. */
    expect(r[hex(carried.id)]).toMatchObject({ held: 'closed', approvals: 2, needed: 2, closedBy: ['seatInvited'] });
    /* RED WHEN: a call to another contract in the withdrawal's transaction is read as the account's. */
    expect(r[hex(withdrawn.id)]).toMatchObject({ held: 'closed', closedBy: ['cancel'] });
    const [wasCarried, wasWithdrawn] = await standingOnChainHere({ roundsOnChain: async () => r } as never, [
      { id: 'carried', chainId: hex(carried.id), status: 'open' }, { id: 'withdrawn', chainId: hex(withdrawn.id), status: 'open' },
    ]);
    /* RED WHEN: the change carried out reads withdrawn because another proposal was withdrawn in its block. */
    expect([wasCarried!.status, wasWithdrawn!.status]).toEqual(['executed', 'cancelled']);
    /* RED WHEN: the bytes are read in any form but the one the chain holds them in: signed, proved and bound. */
    expect(formsAsked.length).toBeGreaterThan(0);
    expect(new Set(formsAsked.map((f) => f.join(' ')))).toEqual(new Set(['signature proof binding']));
    /* RED WHEN: bytes that are not a transaction are passed over, so the block is read as though they were not there. */
    const broken: ContractHistory = { latest: history.latest, of: async () => [...steps] };
    await expect(answerVaultAsk(async () => ({
      accountPure: pureCircuits, accountLedger: (accountModule as any).ledger, runtimeState: (runtime as any).ContractState,
      ledger: { Transaction: { deserialize: () => { throw new Error('not a transaction'); } } }, historyAt: () => broken,
    }) as never, { id: 2, network: 'undeployed', ask: 'rounds-on-chain', account: 'ab'.repeat(32), indexer: INDEXER, chainIds: [hex(carried.id)] } as never))
      .rejects.toThrow(/could not be read/u);
    /* RED WHEN: a close no call of its block's transactions explains is answered as closed by no call - read as withdrawn, or as carried out. Asked at another indexer, so the worker reads this history afresh. */
    const unexplained: ContractHistory = {
      latest: history.latest,
      of: async () => steps.map((x) => (x.block.height === 13 ? { ...x, raw: steps.find((y) => y.transaction === '53'.repeat(32))!.raw } : x)),
    };
    await expect(answerVaultAsk(async () => ({
      accountPure: pureCircuits, accountLedger: (accountModule as any).ledger, runtimeState: (runtime as any).ContractState, ledger: unprovenLedger,
      historyAt: () => unexplained,
    }) as never, { id: 3, network: 'undeployed', ask: 'rounds-on-chain', account: sim.address, indexer: { ...INDEXER, indexerUri: 'https://another.indexer.example' }, chainIds: [hex(carried.id)] } as never))
      .rejects.toThrow(/no call read from that block's transactions closed it/u);
  });

  it('A CLOSED PROPOSAL IS READ AT THE LAST STATE THAT HELD IT: APPROVALS GIVEN IN THE BLOCK THAT CLOSED IT ARE NOT SEEN', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const steps: ContractHistoryEntry[] = [];
    const block = (height: number, calls: ReadonlyArray<readonly [string, string]>) => {
      const state = stateOf(sim);
      for (const [entryPoint, tx] of calls) steps.push({ kind: 'call', transaction: tx, entryPoint, state, block: { height, at: 1_800_000_000_000 + height }, succeeded: true });
    };
    steps.push({ kind: 'deploy', transaction: '00'.repeat(32), state: stateOf(sim), block: { height: 10, at: 1_800_000_000_010 }, succeeded: true });
    const carried = aChange(sim, A, 3, 741);
    await sim.as(carried.by).propose(carried.payload);
    block(11, [['propose', '31'.repeat(32)]]);
    /* Approved and carried out in one block: no state the indexer serves shows the second approval. */
    await sim.as(B).approve(carried.id);
    await sim.seatInvited(carried.id, carried.invitee);
    block(12, [['approve', '32'.repeat(32)], ['seatInvited', '33'.repeat(32)]]);
    const history: ContractHistory = { latest: async () => steps.at(-1)!.transaction, of: async () => [...steps] };
    const r = (await roundsAsked(history, [hex(carried.id)]) as any).rounds as Record<string, unknown>;
    /* RED WHEN: a closed proposal is read with no count at all, rather than the count of the last state that held it. */
    expect(r[hex(carried.id)]).toEqual({
      held: 'closed', approvals: 1, needed: 2, raisedAt: 1_800_000_000_011, txRef: '31'.repeat(32), closedBy: ['approve', 'seatInvited'],
    });
  });

  it("A RUN HELD READS THE TIME ITS WINDOW OPENS, AS THE ACCOUNT HOLDS IT; THE PAID ASK SAYS WHICH OF ITS LEAVES THE ACCOUNT RECORDS PAID", async () => {
    const NOW = 1_800_000_000;
    const OPENS = BigInt(NOW - 3_600);
    const CLOSES = BigInt(NOW + 3_600);
    const VAULT = new Uint8Array(32).fill(0xa1);
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    await sim.adoptVault(VAULT, [A, B]);
    const steps: ContractHistoryEntry[] = [];
    const block = (height: number, calls: ReadonlyArray<readonly [string, string]>) => {
      const state = stateOf(sim);
      for (const [entryPoint, tx] of calls) steps.push({ kind: 'call', transaction: tx, entryPoint, state, block: { height, at: 1_800_000_000_000 + height }, succeeded: true });
    };
    steps.push({ kind: 'deploy', transaction: '00'.repeat(32), state: stateOf(sim), block: { height: 10, at: 1_800_000_000_010 }, succeeded: true });
    const leaves = [0x41, 0x42].map((n) => payoutLeafOf({ details: hex(new Uint8Array(32).fill(n)) as never, nonce: hex(new Uint8Array(32).fill(n + 0x10)) as never }));
    const root = rootOfTestLeaves(leaves);
    const c = change(0n, 751);
    await sim.as(sim.applying(A, c)).proposeRun({ root: Buffer.from(root, 'hex'), payees: 2n, from: OPENS, until: CLOSES, vault: VAULT });
    const id = sim.proposalId(pureCircuits.runPayload(Buffer.from(root, 'hex'), 2n, OPENS, CLOSES, 0n), c.salt, VAULT);
    block(11, [['propose', '41'.repeat(32)]]);
    const asked = await roundsAsked({ latest: async () => steps.at(-1)!.transaction, of: async () => [...steps] }, [hex(id)]) as any;
    /* RED WHEN: a run's window is not read off the chain, so a device cannot tell a run that has not opened yet from one that has. */
    expect(asked.rounds[hex(id)]).toMatchObject({ held: 'open', approvals: 1, opensAt: Number(OPENS) });
    await sim.as(sim.applying(B, c)).approve(id);
    await sim.as(sim.applying(A, c)).recordPaymentFromVault({
      proposal: id, vault: VAULT, root: Buffer.from(root, 'hex'), payees: 2n, from: OPENS, until: CLOSES, salt: c.salt,
      details: new Uint8Array(32).fill(0x41), nonce: new Uint8Array(32).fill(0x51), amount: TEST_AMOUNT, asset: TEST_TOKEN_BYTES,
      path: sumTreeOfLeaves(leaves, leaves.map(() => TEST_AMOUNT), hex(TEST_TOKEN_BYTES) as never).pathFor(0),
    });
    block(12, [['approve', '42'.repeat(32)], ['recordPaymentFromVault', '43'.repeat(32)]]);
    const history: ContractHistory = { latest: async () => steps.at(-1)!.transaction, of: async () => [...steps] };
    const paid = await answerVaultAsk(async () => ({
      accountPure: pureCircuits, accountLedger: (accountModule as any).ledger, runtimeState: (runtime as any).ContractState,
      historyAt: (indexer: typeof INDEXER) => { expect(indexer).toEqual(INDEXER); return history; },
    }) as never, {
      id: 1, network: 'undeployed', ask: 'paid-leaves', account: 'ad'.repeat(32), indexer: INDEXER, leaves: leaves.map((l) => l.toUpperCase()),
    } as never) as any;
    /* RED WHEN: the worker cannot say from the account's latest state whether a leaf is paid, or says an unpaid leaf is paid. */
    expect(paid).toEqual({ id: 1, ok: true, ask: 'paid-leaves', paid: { [leaves[0]!.toLowerCase()]: true, [leaves[1]!.toLowerCase()]: false } });
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
  it('A PROPOSAL HELD WHOSE HOLD CARRIES NO WITHDRAW KEY SAYS NOTHING OF WHO RAISED IT, NEVER THAT ANOTHER SEAT DID', () => {
    const ID = 'ab'.repeat(32);
    const view = (holds: unknown) => ({
      approvals: { member: () => false },
      openProposals: { member: () => true, lookup: () => new Uint8Array(32).fill(7) },
      approvalCounts: { member: () => true, lookup: () => 1n },
      ...(holds === undefined ? {} : { proposalHolds: holds }),
    });
    const deps = (holds: unknown) => ({
      accountPure: pureCircuits, accountLedger: () => view(holds), runtimeState: { deserialize: () => ({ data: null }) },
    }) as never;
    const steps = [{ kind: 'call', transaction: '21'.repeat(32), entryPoint: 'propose', state: new Uint8Array(1), block: { height: 21, at: 21 }, succeeded: true }];
    const seat = { account: 'ad'.repeat(32), signingSecret: hex(A.secretKey) };
    /* RED WHEN: a raiser whose hold could not be read is told another signer raised the proposal, rather than that who raised it was not read. */
    expect('raisedHere' in roundsOnChainIn(deps(undefined), steps, [ID], seat).get(ID)!).toBe(false);
    const noKey = { member: () => true, lookup: () => ({ removals: 0n, needed: 1n }) };
    expect('raisedHere' in roundsOnChainIn(deps(noKey), steps, [ID], seat).get(ID)!).toBe(false);
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
    /* RED WHEN: how many signers were removed since a run was raised is not read off the chain, so a run is judged at its bar when the account needs one more approval for each removal. */
    expect(standing([{ threshold: 2n, removals: 0n, held: { [RUN]: open(2n) } }, { threshold: 2n, removals: 2n, held: { [RUN]: open(2n) } }])?.removals).toBe(2);
    /* RED WHEN: a proposal raised after the latest removal is said to have signers removed since it was raised. */
    expect(standing([{ threshold: 2n, removals: 1n, held: { [RUN]: { ...open(2n), raisedAtRemovals: 1n } } }])?.removals).toBeUndefined();
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

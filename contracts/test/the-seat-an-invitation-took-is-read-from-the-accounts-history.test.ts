/**
 * The seat an invitation by address took, read from the account's own history in the page's worker, never
 * from the company's service: the one leaf that entered the account's signers in the block where the
 * invitation's proposal closed with one `seatInvited` call. Real here: the compiled account, moved on by its
 * own circuits, and the worker's own handler reading its serialised states. The test's: the indexer, which
 * serves those states as the history, every step of one block carrying the state after the whole block.
 */
import { describe, expect, it } from 'vitest';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as accountModule from '../managed/contract/index.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountSimulator, change, invitePayloadFor, invitedAddressFor, leafOfDevice, privateStateFor } from './simulator.js';
import { answerVaultAsk } from 'vaults-web-shared/vault-worker-entry.js';
import type { ContractHistory, ContractHistoryEntry } from '../../src/midnight/contract-history.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const INDEXER = { indexerUri: 'https://indexer.example/api/v4/graphql', indexerWsUri: 'wss://indexer.example/api/v4/graphql/ws' };
const stateOf = (sim: AccountSimulator): Uint8Array => (sim.contractStateForCall as { serialize(): Uint8Array }).serialize();

const seatsAsked = (history: ContractHistory, proposals: readonly string[]) => answerVaultAsk(async () => ({
  accountPure: pureCircuits, accountLedger: (accountModule as any).ledger, runtimeState: (runtime as any).ContractState,
  historyAt: () => history,
}) as never, { id: 1, network: 'undeployed', ask: 'invited-seats', account: 'ad'.repeat(32), indexer: INDEXER, proposals } as never);

/** An invitation of `n`'s address, raised by A and approved by B: its id, and how `n`'s wallet takes the seat. */
const anInvitation = async (sim: AccountSimulator, n: number, seed: number) => {
  const who = privateStateFor(n);
  const c = change(0n, seed);
  const invite = invitedAddressFor(who);
  const payload = invitePayloadFor(who, invite);
  await sim.as(sim.applying(A, c)).propose(payload);
  const id = sim.proposalId(payload, c.salt);
  await sim.as(B).approve(id);
  return { id, leaf: hex(leafOfDevice(who)), take: () => sim.seatInvited(id, { ...who, invite, proposalSalt: c.salt }) };
};

describe('THE SEAT AN INVITATION TOOK, READ FROM THE ACCOUNT\'S HISTORY IN THE WORKER', () => {
  it('the one leaf that entered with the one seatInvited that closed the proposal; null where none did, or where two seated in one block', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const steps: ContractHistoryEntry[] = [];
    const block = (height: number, calls: ReadonlyArray<string>) => {
      const state = stateOf(sim);
      calls.forEach((entryPoint, i) => steps.push({
        kind: 'call', transaction: `${height}${i}`.padStart(64, '0'), entryPoint, state, block: { height, at: 1_800_000_000_000 + height }, succeeded: true,
      }));
    };
    steps.push({ kind: 'deploy', transaction: '00'.repeat(32), state: stateOf(sim), block: { height: 10, at: 1_800_000_000_010 }, succeeded: true });
    const dee = await anInvitation(sim, 3, 801);
    const eve = await anInvitation(sim, 4, 802);
    const fay = await anInvitation(sim, 5, 803);
    const gus = await anInvitation(sim, 6, 804);
    const hal = await anInvitation(sim, 7, 805);
    const ivy = await anInvitation(sim, 8, 806);
    block(11, ['propose', 'approve', 'propose', 'approve', 'propose', 'approve', 'propose', 'approve', 'propose', 'approve', 'propose', 'approve']);
    await dee.take();
    block(12, ['seatInvited']);
    await eve.take();
    await fay.take();
    block(13, ['seatInvited', 'seatInvited']);
    /* One block: hal's invitation is cancelled, and ivy takes hers. One proposal-closing call is not a seating. */
    await sim.as(A).cancel(hal.id);
    await ivy.take();
    block(14, ['cancel', 'seatInvited']);
    const history: ContractHistory = { latest: async () => steps.at(-1)!.transaction, of: async () => [...steps] };
    const answer = await seatsAsked(history, [dee.id, eve.id, fay.id, gus.id, hal.id, ivy.id].map((id) => hex(id).toUpperCase())) as any;
    expect(answer.ok).toBe(true);
    const seats = answer.seats as Record<string, string | null>;
    /* RED WHEN: the seat an invitation took is not the one leaf its seatInvited added. */
    expect(seats[hex(dee.id)]).toBe(dee.leaf);
    /* RED WHEN: a seat is bound to one of two invitations closed in one block, which the history cannot tell apart. */
    expect(seats[hex(eve.id)]).toBeNull();
    expect(seats[hex(fay.id)]).toBeNull();
    /* RED WHEN: an invitation not yet taken is given a seat. */
    expect(seats[hex(gus.id)]).toBeNull();
    /* RED WHEN: an invitation cancelled in the block where another was taken is given that other's seat. The history
     * carries no call's arguments, so neither is bound: ivy's seat waits to be removed and invited again. */
    expect(seats[hex(hal.id)]).toBeNull();
    expect(seats[hex(ivy.id)]).toBeNull();
  });

  it('an invitation cancelled and raised again under its own salt is read at the seat it took the second time', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const steps: ContractHistoryEntry[] = [];
    const block = (height: number, calls: ReadonlyArray<string>) => {
      const state = stateOf(sim);
      calls.forEach((entryPoint, i) => steps.push({
        kind: 'call', transaction: `${height}${i}`.padStart(64, '0'), entryPoint, state, block: { height, at: 1_800_000_000_000 + height }, succeeded: true,
      }));
    };
    steps.push({ kind: 'deploy', transaction: '00'.repeat(32), state: stateOf(sim), block: { height: 10, at: 1_800_000_000_010 }, succeeded: true });
    const who = privateStateFor(9);
    const c = change(0n, 901);
    const invite = invitedAddressFor(who);
    const payload = invitePayloadFor(who, invite);
    await sim.as(sim.applying(A, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    block(11, ['propose']);
    await sim.as(A).cancel(id);
    block(12, ['cancel']);
    await sim.as(sim.applying(A, c)).propose(payload);
    await sim.as(B).approve(id);
    block(13, ['propose', 'approve']);
    await sim.seatInvited(id, { ...who, invite, proposalSalt: c.salt });
    block(14, ['seatInvited']);
    const history: ContractHistory = { latest: async () => steps.at(-1)!.transaction, of: async () => [...steps] };
    const answer = await seatsAsked(history, [hex(id)]) as any;
    expect(answer.ok).toBe(true);
    /* RED WHEN: the history is read only up to the first time the proposal closed, so a seat taken after it was raised
     * again reads as no seat, and the same wallet can be invited to a second one. */
    expect((answer.seats as Record<string, string | null>)[hex(id)]).toBe(hex(leafOfDevice(who)));
  });
});

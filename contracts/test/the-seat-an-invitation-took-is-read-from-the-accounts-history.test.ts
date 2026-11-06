/**
 * The seat an invitation by address took, read from the account's own history in the page's worker, never
 * from the company's service: the one leaf the one `seatInvited` call that closed the invitation's proposal put
 * into the account's signers, read from that call's own transaction. Real here: the compiled account, moved on by
 * its own circuits, the ledger's own transactions built from the operations those circuits ran (left unproven,
 * since no proof is made here), and the worker's own handler. The test's: the indexer, which serves the history,
 * every step of one block carrying the state after the whole block, so no step's state says what its call did.
 */
import { describe, expect, it } from 'vitest';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as accountModule from '../managed/contract/index.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountSimulator, change, invitePayloadFor, invitedAddressFor, leafOfDevice, privateStateFor, transactionOfCalls } from './simulator.js';
import * as L from '@midnightntwrk/ledger-v9';
import { answerVaultAsk } from 'vaults-web-shared/vault-worker-entry.js';
import { SEAT_READ_STOP } from 'vaults-web-shared/seat-not-read-on-the-chain.js';
import type { ContractHistory, ContractHistoryEntry } from '../../src/midnight/contract-history.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const INDEXER = { indexerUri: 'https://indexer.example/api/v4/graphql', indexerWsUri: 'wss://indexer.example/api/v4/graphql/ws' };
const stateOf = (sim: AccountSimulator): Uint8Array => (sim.contractStateForCall as { serialize(): Uint8Array }).serialize();

/* The ledger the worker is handed: the installed one, reading the test's transactions, which carry no proof. */
const unprovenLedger = {
  Transaction: { deserialize: (_s: string, _p: string, _b: string, raw: Uint8Array) => L.Transaction.deserialize('signature', 'pre-proof', 'binding', raw) },
};

/* Asked at `indexer`: the worker keeps a history it read by its indexer, account and latest transaction, so another history is asked elsewhere. */
const seatsAsked = (history: ContractHistory, proposals: readonly string[], account: string, indexer = INDEXER) => answerVaultAsk(async () => ({
  accountPure: pureCircuits, accountLedger: (accountModule as any).ledger, runtimeState: (runtime as any).ContractState, ledger: unprovenLedger,
  historyAt: () => history,
}) as never, { id: 1, network: 'undeployed', ask: 'invited-seats', account, indexer, proposals } as never);

/** The account's history as the indexer serves it: each call in a transaction of its own, every step of a block carrying the block's last state. */
const historyOf = (sim: AccountSimulator) => {
  const steps: ContractHistoryEntry[] = [];
  let pending: Array<{ readonly entryPoint: string; readonly call: unknown; readonly succeeded: boolean }> = [];
  steps.push({ kind: 'deploy', transaction: '00'.repeat(32), state: stateOf(sim), block: { height: 10, at: 1_800_000_000_010 }, succeeded: true });
  return {
    steps,
    ran: (entryPoint: string, succeeded = true) => { pending.push({ entryPoint, call: sim.lastCall, succeeded }); },
    block: (height: number) => {
      const state = stateOf(sim);
      pending.forEach((c, i) => steps.push({
        kind: 'call', transaction: `${height}${i}`.padStart(64, '0'), entryPoint: c.entryPoint, state, block: { height, at: 1_800_000_000_000 + height },
        succeeded: c.succeeded, raw: transactionOfCalls([{ call: c.call, entryPoint: c.entryPoint }]),
      }));
      pending = [];
    },
    history: (): ContractHistory => ({ latest: async () => steps.at(-1)!.transaction, of: async () => [...steps] }),
  };
};

/** An invitation of `n`'s address, raised by A and approved by B: its id, and how `n`'s wallet takes the seat. */
const anInvitation = async (sim: AccountSimulator, h: ReturnType<typeof historyOf>, n: number, seed: number) => {
  const who = privateStateFor(n);
  const c = change(0n, seed);
  const invite = invitedAddressFor(who);
  const payload = invitePayloadFor(who, invite);
  await sim.as(sim.applying(A, c)).propose(payload);
  h.ran('propose');
  const id = sim.proposalId(payload, c.salt);
  await sim.as(B).approve(id);
  h.ran('approve');
  return {
    id, leaf: hex(leafOfDevice(who)),
    take: async () => { await sim.seatInvited(id, { ...who, invite, proposalSalt: c.salt }); h.ran('seatInvited'); },
  };
};

describe('THE SEAT AN INVITATION TOOK, READ FROM THE ACCOUNT\'S HISTORY IN THE WORKER', () => {
  it('each invitation reads the one leaf its own seatInvited call put in, whatever else closed in that block; none where no call took it', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const h = historyOf(sim);
    const dee = await anInvitation(sim, h, 3, 801);
    const eve = await anInvitation(sim, h, 4, 802);
    const fay = await anInvitation(sim, h, 5, 803);
    const gus = await anInvitation(sim, h, 6, 804);
    const hal = await anInvitation(sim, h, 7, 805);
    const ivy = await anInvitation(sim, h, 8, 806);
    h.block(11);
    await dee.take();
    h.block(12);
    await eve.take();
    await fay.take();
    h.block(13);
    /* One block: hal's invitation is withdrawn, and ivy takes hers. */
    await sim.as(A).cancel(hal.id);
    h.ran('cancel');
    await ivy.take();
    h.block(14);
    const answer = await seatsAsked(h.history(), [dee.id, eve.id, fay.id, gus.id, hal.id, ivy.id].map((id) => hex(id).toUpperCase()), sim.address) as any;
    expect(answer.ok).toBe(true);
    const seats = answer.seats as Record<string, string | null>;
    /* RED WHEN: the seat an invitation took is not the one leaf its seatInvited put in. */
    expect(seats[hex(dee.id)]).toBe(dee.leaf);
    /* RED WHEN: two invitations taken in one block read no seat, so both wallets may be invited again and neither person is ever admitted. */
    expect(seats[hex(eve.id)]).toBe(eve.leaf);
    expect(seats[hex(fay.id)]).toBe(fay.leaf);
    /* RED WHEN: an invitation not yet taken is given a seat. */
    expect(seats[hex(gus.id)]).toBeNull();
    /* RED WHEN: an invitation withdrawn in the block where another was taken is given that other's seat. */
    expect(seats[hex(hal.id)]).toBeNull();
    /* RED WHEN: a seat taken in a block where another proposal was withdrawn reads no seat, so that wallet may be invited again. */
    expect(seats[hex(ivy.id)]).toBe(ivy.leaf);
  });

  it('a seating call that failed takes no seat, and a seating step whose transaction was not served is a read refused, never no seat', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const h = historyOf(sim);
    const jo = await anInvitation(sim, h, 3, 811);
    h.block(11);
    await jo.take();
    h.block(12);
    const failed = h.steps.map((x) => (x.entryPoint === 'seatInvited' ? { ...x, succeeded: false } : x));
    const asFailed = await seatsAsked({ latest: async () => failed.at(-1)!.transaction, of: async () => failed }, [hex(jo.id)], sim.address,
      { indexerUri: 'https://failed.example/api', indexerWsUri: 'wss://failed.example/ws' }) as any;
    /* RED WHEN: a seating whose transaction failed is read as a seat taken. */
    expect(asFailed.seats[hex(jo.id)]).toBeNull();
    const bare = h.steps.map((x) => (x.entryPoint === 'seatInvited' ? { ...x, raw: undefined } : x)) as ContractHistoryEntry[];
    /* RED WHEN: a seating the device cannot read is answered as no seat, so the wallet seated there may be invited again. */
    await expect(seatsAsked({ latest: async () => bare.at(-1)!.transaction, of: async () => bare }, [hex(jo.id)], sim.address,
      { indexerUri: 'https://bare.example/api', indexerWsUri: 'wss://bare.example/ws' })).rejects.toThrow(/served without its transaction/);
  });

  it('two seatings in one transaction each read their own leaf; a seating step whose transaction shows no seating is a read refused', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const h = historyOf(sim);
    const kim = await anInvitation(sim, h, 3, 821);
    const lou = await anInvitation(sim, h, 4, 822);
    h.block(11);
    await kim.take();
    const first = sim.lastCall;
    await lou.take();
    const both = transactionOfCalls([{ call: first, entryPoint: 'seatInvited' }, { call: sim.lastCall, entryPoint: 'seatInvited' }]);
    const state = stateOf(sim);
    const steps: ContractHistoryEntry[] = [...h.steps, ...['seatInvited', 'seatInvited'].map((entryPoint) => ({
      kind: 'call' as const, transaction: '12'.padStart(64, '0'), entryPoint, state, block: { height: 12, at: 1_800_000_000_012 }, succeeded: true, raw: both,
    }))];
    const answer = await seatsAsked({ latest: async () => steps.at(-1)!.transaction, of: async () => steps }, [hex(kim.id), hex(lou.id)], sim.address,
      { indexerUri: 'https://one.example/api', indexerWsUri: 'wss://one.example/ws' }) as any;
    /* RED WHEN: only one call of a transaction is read, so the other invitation in it reads no seat and its wallet may be invited again. */
    expect([answer.seats[hex(kim.id)], answer.seats[hex(lou.id)]]).toEqual([kim.leaf, lou.leaf]);
    const drifted = h.steps.map((x) => (x.entryPoint === 'approve' ? { ...x, entryPoint: 'seatInvited' } : x));
    /* RED WHEN: a step the history names a seating, whose transaction holds no seating, is passed over as no seat. */
    await expect(seatsAsked({ latest: async () => drifted.at(-1)!.transaction, of: async () => drifted }, [hex(kim.id)], sim.address,
      { indexerUri: 'https://drift.example/api', indexerWsUri: 'wss://drift.example/ws' })).rejects.toThrow(/does not show one invitation and one seat/);
    /* RED WHEN: a seating no reading again can settle is told by the name of a read not made, so every reader tells the person to read again. */
    await expect(seatsAsked({ latest: async () => drifted.at(-1)!.transaction, of: async () => drifted }, [hex(kim.id)], sim.address,
      { indexerUri: 'https://drift2.example/api', indexerWsUri: 'wss://drift2.example/ws' })).rejects.toMatchObject({ name: SEAT_READ_STOP.refused });
  });

  it('asked again over the same history, the worker answers from the seatings it kept and decodes no transaction again', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const h = historyOf(sim);
    const mia = await anInvitation(sim, h, 3, 831);
    const ned = await anInvitation(sim, h, 4, 832);
    h.block(11);
    await mia.take();
    await ned.take();
    h.block(12);
    let decoded = 0;
    const counting = { Transaction: { deserialize: (...a: [string, string, string, Uint8Array]) => { decoded += 1; return unprovenLedger.Transaction.deserialize(...a); } } };
    const indexer = { indexerUri: 'https://kept.example/api', indexerWsUri: 'wss://kept.example/ws' };
    const ask = (proposals: readonly string[]) => answerVaultAsk(async () => ({
      accountPure: pureCircuits, accountLedger: (accountModule as any).ledger, runtimeState: (runtime as any).ContractState, ledger: counting,
      historyAt: () => h.history(),
    }) as never, { id: 1, network: 'undeployed', ask: 'invited-seats', account: sim.address, indexer, proposals } as never) as Promise<any>;
    expect((await ask([hex(mia.id)])).seats).toEqual({ [hex(mia.id)]: mia.leaf });
    const first = decoded;
    expect(first).toBeGreaterThan(0);
    /* RED WHEN: every ask decodes every call transaction of the history again, though the history has not moved. */
    expect((await ask([hex(ned.id)])).seats).toEqual({ [hex(ned.id)]: ned.leaf });
    expect(decoded).toBe(first);
    /* Once the account acts again, the history is read again and its seatings with it. */
    await sim.as(A).propose(invitePayloadFor(privateStateFor(5), invitedAddressFor(privateStateFor(5))));
    h.ran('propose');
    h.block(13);
    expect((await ask([hex(mia.id), hex(ned.id)])).seats).toEqual({ [hex(mia.id)]: mia.leaf, [hex(ned.id)]: ned.leaf });
    expect(decoded).toBeGreaterThan(first);
  });

  it('an invitation withdrawn and raised again under its own salt is read at the seat it took the second time', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const h = historyOf(sim);
    const who = privateStateFor(9);
    const c = change(0n, 901);
    const invite = invitedAddressFor(who);
    const payload = invitePayloadFor(who, invite);
    await sim.as(sim.applying(A, c)).propose(payload);
    h.ran('propose');
    const id = sim.proposalId(payload, c.salt);
    h.block(11);
    await sim.as(A).cancel(id);
    h.ran('cancel');
    h.block(12);
    await sim.as(sim.applying(A, c)).propose(payload);
    h.ran('propose');
    await sim.as(B).approve(id);
    h.ran('approve');
    h.block(13);
    await sim.seatInvited(id, { ...who, invite, proposalSalt: c.salt });
    h.ran('seatInvited');
    h.block(14);
    const answer = await seatsAsked(h.history(), [hex(id)], sim.address) as any;
    expect(answer.ok).toBe(true);
    /* RED WHEN: the history is read only up to the first time the proposal closed, so a seat taken after it was raised
     * again reads as no seat, and the same wallet can be invited to a second one. */
    expect((answer.seats as Record<string, string | null>)[hex(id)]).toBe(hex(leafOfDevice(who)));
  });
});

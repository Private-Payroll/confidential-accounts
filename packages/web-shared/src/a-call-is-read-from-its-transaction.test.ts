/**
 * **WHICH PROPOSAL EACH CALL TO THE ACCOUNT RAISED OR CLOSED, READ FROM ITS TRANSACTION'S BYTES.**
 *
 * What is real here: the compiled account, its circuits run by the simulator, the operations each call ran as the
 * runtime recorded them, split, bound and serialised by the installed ledger into a transaction, and that ledger
 * reading the bytes back. What is the test's: no proof is made, so the bytes carry the `pre-proof` marker and are read
 * with it, the rest of the form being the chain's (signed, bound).
 */
import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { ledger as accountReader } from '../../../contracts/managed/contract/index.js';
import { AccountSimulator, change, invitePayloadFor, privateStateFor, transactionOfCalls } from '../../../contracts/test/simulator.js';
import { callsOnTheAccountIn, OPEN_PROPOSALS_FIELD, type CallOnTheAccount } from './governed-call-builder.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unproven = { ledger: { Transaction: { deserialize: (s: string, _p: string, b: string, raw: Uint8Array) => (L as any).Transaction.deserialize(s, 'pre-proof', b, raw) } } };
const read = (raw: Uint8Array, account: string) => callsOnTheAccountIn(unproven, raw, account)
  .map((c: CallOnTheAccount) => ({ entryPoint: c.entryPoint, opened: [...c.opened], closed: [...c.closed] }));

describe('A CALL TO THE ACCOUNT, READ FROM ITS TRANSACTION', () => {
  it("THE FIELD READ AS THE OPEN PROPOSALS IS THE ONE THE COMPILED ACCOUNT'S OWN READER READS THEM FROM", async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const RT = runtime as any;
    const fields = (sim.contractStateForCall as any).data.state.asArray() as unknown[];
    const key = new Uint8Array(32).fill(9);
    const bytes32 = new RT.CompactTypeBytes(32);
    /* Each slot in turn holds a map naming `key`; the slots where the compiled reader then finds it open. */
    const slots = fields.flatMap((_, k) => {
      const map = new RT.StateMap().insert({ value: bytes32.toValue(key), alignment: bytes32.alignment() }, RT.StateValue.newNull());
      let state = RT.StateValue.newArray();
      for (const [i, f] of fields.entries()) state = state.arrayPush(i === k ? RT.StateValue.newMap(map) : f);
      try { return (accountReader(new RT.ChargedState(state)) as any).openProposals.member(key) ? [k] : []; } catch { return []; }
    });
    /* RED WHEN: the field the device reads a call's raises and closes from is not the compiled account's open proposals. */
    expect(slots).toEqual([OPEN_PROPOSALS_FIELD]);
  });

  it('A RAISE OPENS ITS PROPOSAL, AN APPROVAL OPENS AND CLOSES NOTHING, A WITHDRAWAL CLOSES IT, AND ANOTHER CONTRACT\'S CALL IS NOT THE ACCOUNT\'S', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const c = change(0n, 761);
    const payload = invitePayloadFor(privateStateFor(3));
    const id = hex(sim.proposalId(payload, c.salt));
    await sim.as(sim.applying(A, c)).propose(payload);
    const raised = transactionOfCalls([{ call: sim.lastCall, entryPoint: 'propose' }]);
    await sim.as(B).approve(sim.proposalId(payload, c.salt));
    const approved = transactionOfCalls([{ call: sim.lastCall, entryPoint: 'approve' }]);
    await sim.as(A).cancel(sim.proposalId(payload, c.salt));
    const withdrawn = transactionOfCalls([{ call: sim.lastCall, entryPoint: 'cancel' }, { call: sim.lastCall, entryPoint: 'payout', address: 'cd'.repeat(32) }]);
    /* RED WHEN: a raise is not read as opening the proposal it raised. */
    expect(read(raised, sim.address)).toEqual([{ entryPoint: 'propose', opened: [id], closed: [] }]);
    /* RED WHEN: an approval, which writes only the count of approvals beside the open proposals, is read as raising or closing one. */
    expect(read(approved, sim.address)).toEqual([{ entryPoint: 'approve', opened: [], closed: [] }]);
    /* RED WHEN: a withdrawal is not read as closing its proposal, or a call to another contract in its transaction is read as the account's. */
    expect(read(withdrawn, sim.address)).toEqual([{ entryPoint: 'cancel', opened: [], closed: [id] }]);
    /* RED WHEN: bytes that are not a transaction are read as one holding no call. */
    expect(() => read(new Uint8Array([1, 2, 3]), sim.address)).toThrow(/could not be read/u);
  });
});

/**
 * **A PROPOSAL'S RAISE IS SENT, AND WHERE IT STANDS IS READ, ONLY AS THE CHAIN SAYS, FOR A SEAT THAT MAY ACT, OVER REAL HTTP.**
 *
 * The proposal routes run over a stand-in chain (`a-proposal-relayed-on-a-stand-in-chain.test-support.ts`). Pinned
 * here: a raise is sent only while the chain does not hold it and its reference is not a confirmation, a deployment
 * with no door sends nothing, a send that fails after the door is not marked nothing sent, a withdrawal is relayed only
 * as the chain allows, and a standing read never writes a count backwards or over what changed meanwhile.
 *
 * Every assertion names the change that turns it red.
 */
import { describe, it, expect } from 'vitest';
import { store } from './a-company-of-two-seats.test-support.js';
import { DEVICE_RAISE_VERSION } from '../core/device-raise.js';
import { open, chain, sent, tx, ledger, P, CHAIN, proposal, post } from './a-proposal-relayed-on-a-stand-in-chain.test-support.js';

describe('A PROPOSAL\'S RAISE IS SENT AND ITS STANDING READ AS THE CHAIN SAYS, FOR A SEAT THAT MAY ACT', () => {
  it('WHERE A PROPOSAL STANDS IS THE CHAIN\'S, AND A COUNT ALREADY WRITTEN IS NEVER LOWERED', async () => {
    open.set(CHAIN, 2);
    expect((await post('ada', `/api/proposals/${P}/standing`, {})).body).toMatchObject({ approvalCount: 2 });
    open.set(CHAIN, 1);
    /* RED WHEN a later, lower read writes the count backwards. */
    expect((await post('ada', `/api/proposals/${P}/standing`, {})).body).toMatchObject({ approvalCount: 2 });
    chain.unreadable = true;
    /* RED WHEN a chain that did not answer is read as a count of nothing. */
    expect((await post('ada', `/api/proposals/${P}/standing`, {})).body).toMatchObject({ approvalCount: 2 });
  });

  it('A RAISE IS SENT ONLY FROM A PAGE OF THIS VERSION, ONLY WHILE THE CHAIN DOES NOT HOLD IT, AND ITS REFERENCE IS WRITTEN DOWN', async () => {
    /* RED WHEN the version is not asked. */
    expect((await post('ada', `/api/proposals/${P}/send`, { tx: tx('propose', CHAIN) })).status).toBe(422);
    const r = await post('bo', `/api/proposals/${P}/send`, { tx: tx('propose', CHAIN), version: DEVICE_RAISE_VERSION });
    expect(r.status).toBe(200);
    expect(sent.map((x) => x.circuit)).toEqual(['propose']);
    /* RED WHEN the reference is not written down, or the proposal is not marked seen. */
    expect(store.getProposal(P)).toMatchObject({ txRef: 'ref-1' });
    expect(typeof store.getProposal(P)!.raisedAt).toBe('string');
    /* RED WHEN a proposal the chain holds is sent again. */
    const again = await post('ada', `/api/proposals/${P}/send`, { tx: tx('propose', CHAIN), version: DEVICE_RAISE_VERSION });
    expect(again.status).toBe(422);
    expect(again.body.error).toMatch(/already holds this proposal/u);
    expect(sent).toHaveLength(1);
  });

  it('A RAISE SENT AND NOT YET SEEN IS SENT AGAIN ONLY ONCE THE CHAIN ANSWERS THAT IT DOES NOT HOLD IT, AND ITS REFERENCE IS NOT A CONFIRMATION', async () => {
    store.putProposal(proposal({ txRef: 'ref-dropped' }));
    chain.unreadable = true;
    const unknown = await post('bo', `/api/proposals/${P}/send`, { tx: tx('propose', CHAIN), version: DEVICE_RAISE_VERSION });
    /* RED WHEN: a chain that did not answer is read as not holding the raise, and a second copy is sent on a guess. */
    expect(unknown).toMatchObject({ status: 422, body: { nothingWasSent: true } });
    expect(unknown.body.error).toMatch(/did not answer whether it holds it/u);
    expect(sent).toEqual([]);
    chain.unreadable = false;
    const door = ledger.submitProvenCall;
    /* The door takes the call and the chain does not show it yet. */
    ledger.submitProvenCall = async (accountId, bytes, circuit) => {
      const r = await door(accountId, bytes, circuit);
      open.delete(CHAIN);
      return r;
    };
    try {
      const again = await post('bo', `/api/proposals/${P}/send`, { tx: tx('propose', CHAIN), version: DEVICE_RAISE_VERSION });
      /* RED WHEN: a raise the chain says it does not hold cannot be sent again, and is stranded. */
      expect(again.status).toBe(200);
      expect(sent.map((x) => x.circuit)).toEqual(['propose']);
      /* RED WHEN: the door's answer is written down as the chain holding the raise, before the chain shows it. */
      expect(store.getProposal(P)).toMatchObject({ txRef: 'ref-1' });
      expect(store.getProposal(P)!.raisedAt).toBeUndefined();
    } finally {
      ledger.submitProvenCall = door;
    }
  });

  it('A DEPLOYMENT WITH NO DOOR FOR A DEVICE\'S CALL SENDS NOTHING, SAYS SO, AND WRITES NO REFERENCE', async () => {
    const door = ledger.submitProvenCall;
    Object.assign(ledger, { submitProvenCall: undefined });
    try {
      open.set(CHAIN, 0);
      for (const [path, body] of [
        [`/api/proposals/${P}/send`, { tx: tx('propose', CHAIN), version: DEVICE_RAISE_VERSION }],
        [`/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN) }],
      ] as const) {
        open.delete(CHAIN);
        if (path.endsWith('/approve')) open.set(CHAIN, 0);
        const r = await post('ada', path, body);
        /* RED WHEN: a deployment that cannot send a device's call answers as if it may have sent one. */
        expect(r, path).toMatchObject({ status: 422, body: { nothingWasSent: true } });
        expect(r.body.error, path).toMatch(/does not send transactions proved on a device/u);
      }
      expect(store.getProposal(P)!.txRef).toBeUndefined();
    } finally {
      Object.assign(ledger, { submitProvenCall: door });
    }
  });

  it('AN APPROVAL WHOSE SEND FAILS AT THE DOOR OR AFTER IT IS NOT MARKED AS NOTHING SENT, AND NO COUNT IS WRITTEN FOR IT', async () => {
    open.set(CHAIN, 0);
    const door = ledger.submitProvenCall;
    ledger.submitProvenCall = async () => { throw new Error('the node dropped the connection'); };
    try {
      const r = await post('ada', `/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN) });
      /* RED WHEN: a failure from the send onwards is marked as nothing sent, though the chain may hold the approval. */
      expect(r).toMatchObject({ status: 502, body: { nothingWasSent: false, error: 'the node dropped the connection' } });
      expect(store.getProposal(P)!.approvalCount).toBe(0);
    } finally {
      ledger.submitProvenCall = door;
    }
  });

  it('THE STANDING READ NEVER WRITES BACK WHAT CHANGED WHILE IT WAS ASKING THE CHAIN', async () => {
    open.set(CHAIN, 1);
    const status = ledger.status;
    /* While the read waits on the chain, another request withdraws the proposal. */
    ledger.status = async () => {
      const answer = await status();
      store.putProposal(proposal({ status: 'cancelled' }));
      return answer;
    };
    try {
      const r = await post('ada', `/api/proposals/${P}/standing`, {});
      /* RED WHEN: the record read before the chain answered is written back whole, undoing the withdrawal. */
      expect(r.body).toMatchObject({ status: 'cancelled' });
      expect(store.getProposal(P)!.status).toBe('cancelled');
    } finally {
      ledger.status = status;
    }
  });

  it('A WITHDRAWAL: NO CALL FOR ONE ONLY WRITTEN DOWN, THE DEVICE\'S CALL FOR ONE ON THE CHAIN, AND NONE FOR ONE SENT AND NOT YET SEEN', async () => {
    /* Only written down, the chain's time past its deadline: withdrawn here with no call. RED WHEN a call is demanded for it, or one is sent. */
    chain.chainTime = Date.parse('2026-10-08T00:00:00.000Z');
    let r = await post('ada', `/api/proposals/${P}/cancel`, {});
    expect(r.body).toMatchObject({ status: 'cancelled' });
    expect(sent).toEqual([]);
    /* Sent, and not seen yet: it may still land. RED WHEN it is closed here. */
    chain.chainTime = Date.parse(proposal().createdAt);
    store.putProposal(proposal({ txRef: 'ref-x' }));
    r = await post('ada', `/api/proposals/${P}/cancel`, {});
    expect(r.status).toBe(422);
    expect(store.getProposal(P)!.status).toBe('open');
    /* On the chain: withdrawn only by the call a device proved. RED WHEN it is closed here with none. */
    open.set(CHAIN, 1);
    store.putProposal(proposal());
    r = await post('ada', `/api/proposals/${P}/cancel`, {});
    expect(r.status).toBe(422);
    expect(store.getProposal(P)!.status).toBe('open');
    r = await post('ada', `/api/proposals/${P}/cancel`, { tx: tx('cancel', CHAIN) });
    expect(sent.map((x) => x.circuit)).toEqual(['cancel']);
    /* RED WHEN it is written down withdrawn while the chain still holds it, or not once it no longer does. */
    expect(r.body).toMatchObject({ status: 'cancelled' });
    /* A ledger that does not answer withdraws nothing. */
    store.putProposal(proposal());
    chain.unreadable = true;
    expect((await post('ada', `/api/proposals/${P}/cancel`, {})).status).toBe(422);
    expect(store.getProposal(P)!.status).toBe('open');
  });
});

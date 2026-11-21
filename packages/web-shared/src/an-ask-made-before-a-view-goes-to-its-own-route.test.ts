import { describe, expect, it } from 'vitest';
import { creationSource, invitationSource, type AnsweredCall } from './records-source.js';

/** A call that keeps what it was asked and answers `answer`. */
const recorded = (answer: { status: number; body: unknown } = { status: 200, body: {} }) => {
  const calls: { readonly method: string; readonly path: string; readonly body?: string }[] = [];
  const call: AnsweredCall = async (method, path, body) => { calls.push({ method, path, ...(body === undefined ? {} : { body }) }); return answer; };
  return { calls, call };
};

describe('AN INVITATION IS ASKED BY ITS OWN ROUTES, BEFORE ANY VIEW OF ITS COMPANY', () => {
  it('reads the offer and sends each acceptance, seat and lookup to the route that takes it, its id escaped', async () => {
    const { calls, call } = recorded();
    const asks = invitationSource(call);
    await asks.offer('inv/1');
    await asks.acceptPayee('inv_2', { a: 1 });
    await asks.acceptSigner('inv_2', { b: 2 });
    await asks.seat('inv_2', { c: 3 });
    await asks.seatsNamed('inv_2', { d: 4 });
    await asks.filedTo('inv_2', { e: 5 });
    /* RED WHEN: an ask goes to another route, another method, or sends its body other than as the route takes it. */
    expect(calls).toEqual([
      { method: 'GET', path: '/api/invites/inv%2F1/offer' },
      { method: 'POST', path: '/api/invites/inv_2/accept-payee', body: '{"a":1}' },
      { method: 'POST', path: '/api/invites/inv_2/accept-signer', body: '{"b":2}' },
      { method: 'POST', path: '/api/invites/inv_2/seat', body: '{"c":3}' },
      { method: 'POST', path: '/api/invites/inv_2/seats-named', body: '{"d":4}' },
      { method: 'POST', path: '/api/invites/inv_2/filed-to', body: '{"e":5}' },
    ]);
    /* RED WHEN: the seat's call is named to the gate by another path than the one the seat is sent on, so its move is never taken. */
    expect(asks.seatCall('inv_2')).toEqual({ path: calls[3]!.path });
  });

  it('reads the directory of the company an invitation names, and refuses one the service did not answer with', async () => {
    const answered = recorded({ status: 200, body: { filings: [{ version: 1 }] } });
    expect(await invitationSource(answered.call).filings('acc/1')).toEqual([{ version: 1 }]);
    expect(answered.calls).toEqual([{ method: 'GET', path: '/api/accounts/acc%2F1/directory' }]);
    /* RED WHEN: a refused or empty answer is read as a directory with no filings, so a seat is taken against nothing believed. */
    await expect(invitationSource(recorded({ status: 503, body: { filings: [] } }).call).filings('acc_1')).rejects.toThrow(/answered 503/u);
    await expect(invitationSource(recorded({ status: 200, body: {} }).call).filings('acc_1')).rejects.toThrow(/no filing is believed/u);
  });
});

describe('A COMPANY BEING CREATED IS ASKED BY ITS OWN ROUTES', () => {
  it('sends the pay key and the proposal that raises it to their routes, for the company named', async () => {
    const { calls, call } = recorded();
    const creation = creationSource(call);
    await creation.payKey('acc_1', { call: 'approve', tx: 'AA' });
    await creation.payKeyProposal('acc_1', { proposal: { id: 'p' } });
    /* RED WHEN: the pay key or its proposal goes to another company's route, or another route of this one. */
    expect(calls).toEqual([
      { method: 'POST', path: '/api/accounts/acc_1/creation/pay-key', body: '{"call":"approve","tx":"AA"}' },
      { method: 'POST', path: '/api/accounts/acc_1/creation/pay-key/proposal', body: '{"proposal":{"id":"p"}}' },
    ]);
  });
});

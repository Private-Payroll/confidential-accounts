import { describe, expect, it } from 'vitest';
import { InvitationRefused, writtenOrRefused } from './invitation-on-device.js';
import { takenOrThrown } from './records-source.js';
import { writesOver } from '../../../src/testing/writes-over-a-send.js';

/** The company's writes over a service that answers every call with `answer`, keeping the paths it was sent. */
const over = (answer: { status: number; body: unknown }) => {
  const paths: string[] = [];
  return { paths, writes: writesOver(async (path) => { paths.push(path); return answer; }) };
};

describe('A WRITE OF THE COMPANY\'S THE SERVICE REFUSES IS REFUSED AS AN INVITATION\'S SEND WAS', () => {
  it('throws the refusal with its status, its reason and its words, as an answer to the send itself was read', async () => {
    const { paths, writes } = over({ status: 403, body: { refused: 'seat-not-seated', error: 'this seat is not seated.' } });
    const e = await writtenOrRefused(writes, 'acc_1', { to: 'invitation', body: {} }).catch((x: unknown) => x);
    /* RED WHEN: a refused write reaches the wallet as another error, or with other words, so it is told as something else. */
    expect(e).toBeInstanceOf(InvitationRefused);
    expect(e).toMatchObject({ status: 403, refused: 'seat-not-seated', message: 'this seat is not seated.' });
    expect(paths).toEqual(['/api/accounts/acc_1/invites']);
  });

  it('keeps the whole of a refusal\'s answer, so a store reads which version was refused and why', () => {
    const body = { refused: 'version-already-filed', version: 3, why: 'version 3 is filed already', error: 'taken' };
    const refused = (() => { try { return takenOrThrown({ status: 409, body }); } catch (e) { return e; } })();
    expect(refused).toMatchObject({ status: 409, refused: 'version-already-filed', body });
  });

  it('says the service said nothing when its refusal carries no words, and passes on anything that is not a refusal', async () => {
    const e = await writtenOrRefused(over({ status: 500, body: {} }).writes, 'acc_1', { to: 'self-payee', body: {} }).catch((x: unknown) => x);
    /* RED WHEN: a refusal with no words of its own is told in other words than an answer to the send itself was. */
    expect(e).toMatchObject({ refused: null, message: 'the service answered 500 and said nothing, so nothing is known to have been kept.' });
    const lost = new Error('the page did not answer');
    /* RED WHEN: a call that never reached the service is told as the service's refusal. */
    await expect(writtenOrRefused(async () => { throw lost; }, 'acc_1', { to: 'self-payee', body: {} })).rejects.toBe(lost);
  });

  it('sends each person\'s, vendor\'s and waiting signer\'s write to the route that takes it', async () => {
    const { paths, writes } = over({ status: 201, body: {} });
    for (const act of ['status', 'details', 'admit'] as const) await writes('acc_1', { to: 'person', id: 'emp/1', act, body: {} });
    await writes('acc_1', { to: 'vendor-admitted', id: 'vnd_1', body: {} });
    await writes('acc_1', { to: 'self-payee', body: {} });
    await writes('acc_1', { to: 'signer-withdrawn', signer: 'sgn_1', body: {} });
    await writes('acc_1', { to: 'fee', body: {} });
    await writes('acc_1', { to: 'fee-done', body: {} });
    /* RED WHEN: a person's, vendor's or withdrawal's write goes to another route than the one the service takes it on. */
    expect(paths).toEqual([
      '/api/people/emp%2F1/status', '/api/people/emp%2F1/details', '/api/employees/emp%2F1/admit',
      '/api/accounts/acc_1/vendors/vnd_1/admit', '/api/accounts/acc_1/self-payee', '/api/accounts/acc_1/signers/sgn_1/withdraw',
      '/api/accounts/acc_1/fee', '/api/accounts/acc_1/fee/done',
    ]);
  });
});

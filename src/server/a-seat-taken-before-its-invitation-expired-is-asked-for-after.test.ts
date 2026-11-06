/**
 * **A SEAT THE CHAIN HOLDS IS ASKED FOR AFTER ITS INVITATION EXPIRES, AND A WALLET LEARNS WHICH OF ITS SEATS THE
 * COMPANY'S DIRECTORY ALREADY NAMES.** Both are invitation routes, gated by the proof the link gives, mounted over
 * real HTTP beside the directory and the record routes (`a-company-of-two-seats.test-support.ts`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { acceptanceProofOf, signWithdrawal, tokenOfLink } from '../core/invitation.js';
import { inviteHere } from 'vaults-web-shared/invitation-on-device.js';
import { sealToInbox } from '../core/sealed-records.js';
import { aCompanyOfTwoSeats, ACME, ACME_INBOX, ADA, BO, chains, CO, fromAda, metered, ORIGIN, sendAs, store } from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats();

const REAL = 'c1'.repeat(32);
const JUNK = 'c2'.repeat(32);
const NOBODY = 'c3'.repeat(32);

/* The chain holds the two founding seats and whichever other seats a test names. */
const chainHolding = (...more: string[]): void => {
  chains.set(CO, {
    seats: { committee: [ADA.committeeKey, BO.committeeKey] as never, threshold: 1, seats: [ADA.seat, BO.seat, ...more] },
    approvals: 1, seatBar: 1,
  });
};
afterEach(() => { chains.delete(CO); });

const aSignerInvitation = async (name: string) => {
  const made = await inviteHere(ACME, ADA, 'signer', { name, role: 'approver', person: name.toLowerCase() }, ORIGIN, fromAda);
  return { id: made.id, acceptance: acceptanceProofOf(tokenOfLink(made.link)!) };
};
const expire = (id: string): void => { store.putInvite({ ...store.invitationById(id)!, expiresAt: new Date(Date.now() - 1000).toISOString() }); };
const ask = (who: string, id: string, acceptance: string, leaf?: string) => sendAs(who)(`/api/invites/${id}/accept-signer`, {
  method: 'POST', body: JSON.stringify({ acceptance, waiting: sealToInbox({}, ACME_INBOX), ...(leaf === undefined ? {} : { leaf }) }),
});

describe('a seat request is filed after the invitation expired only for a seat the chain holds and no directory entry names', () => {
  it('RED WHEN: a seat taken on the chain before the invitation expired cannot be asked for after it', async () => {
    const { id, acceptance } = await aSignerInvitation('Fay');
    expire(id);
    chainHolding(REAL);
    const asked = await ask('fay', id, acceptance, REAL);
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ id: expect.stringMatching(/^sgn_/u) });
    expect(store.getAccount(CO)!.pendingSigners.some((p) => p.id === (asked.body as { id: string }).id)).toBe(true);
  });

  it('RED WHEN: an expired invitation takes a request with no seat, for a seat the chain does not hold, or for one a directory entry names', async () => {
    const { id, acceptance } = await aSignerInvitation('Gus');
    expire(id);
    chainHolding(REAL);
    expect((await ask('gus', id, acceptance)).body).toMatchObject({ refused: 'expired' });
    expect((await ask('gus', id, acceptance, NOBODY)).body).toMatchObject({ refused: 'expired' });
    expect((await ask('gus', id, acceptance, ADA.seat)).body).toMatchObject({ refused: 'expired' });
    expect((await ask('gus', id, '00'.repeat(32), REAL)).status).toBe(410);
  });

  it('RED WHEN: a withdrawn or used invitation takes a request for a seat the chain holds', async () => {
    chainHolding(REAL);
    const gone = await aSignerInvitation('Hal');
    expire(gone.id);
    store.putInvite({ ...store.invitationById(gone.id)!, revokedAt: new Date().toISOString() });
    expect((await ask('hal', gone.id, gone.acceptance, REAL)).body).toMatchObject({ refused: 'withdrawn' });
    const used = await aSignerInvitation('Ida');
    store.putInvite({ ...store.invitationById(used.id)!, acceptedAt: new Date().toISOString(), subjectId: 'sgn_other' });
    expire(used.id);
    expect((await ask('ida', used.id, used.acceptance, REAL)).status).toBe(410);
  });

  it('RED WHEN: a request for one held seat stops the real invitee asking for the same or another seat on the same invitation', async () => {
    const { id, acceptance } = await aSignerInvitation('Jo');
    expire(id);
    chainHolding(JUNK, REAL);
    /* The link holder asks first, for the seat the real invitee took. */
    const junkFirst = await ask('junk', id, acceptance, REAL);
    expect(junkFirst.status).toBe(201);
    const real = await ask('jo', id, acceptance, REAL);
    expect(real.status).toBe(201);
    expect((real.body as { id: string }).id).not.toBe((junkFirst.body as { id: string }).id);
    /* Another seat asked for by somebody else is a request of its own. */
    const junkOther = await ask('junk2', id, acceptance, JUNK);
    expect(junkOther.status).toBe(201);
    expect((junkOther.body as { id: string }).id).not.toBe((junkFirst.body as { id: string }).id);
    /* The same person asking for the same seat again is told the id they were given, and no second request is kept. */
    expect((await ask('jo', id, acceptance, REAL)).body).toEqual(real.body);
    expect(store.getAccount(CO)!.pendingSigners.filter((p) => p.userId === 'jo')).toHaveLength(1);
  });

  it('RED WHEN: a person admitted after a late request asks again and a second request is kept under another id', async () => {
    const { id, acceptance } = await aSignerInvitation('Kay');
    expire(id);
    chainHolding(REAL);
    const first = await ask('kay', id, acceptance, REAL);
    /* The seat is admitted: the request waiting for it is let go. */
    const rec = store.getAccount(CO)!;
    store.putAccount({ ...rec, pendingSigners: rec.pendingSigners.filter((p) => p.id !== (first.body as { id: string }).id) });
    expect((await ask('kay', id, acceptance, REAL)).body).toEqual(first.body);
    expect(store.getAccount(CO)!.pendingSigners.filter((p) => p.userId === 'kay')).toEqual([]);
  });

  it('RED WHEN: a late request cannot be withdrawn by its own id, or its withdrawal takes the invitation back from the person it was made for', async () => {
    const { id, acceptance } = await aSignerInvitation('Lou');
    expire(id);
    chainHolding(JUNK, REAL);
    const junk = (await ask('junk3', id, acceptance, JUNK)).body as { id: string };
    const real = (await ask('lou', id, acceptance, REAL)).body as { id: string };
    const withdraw = (signerId: string, leaf: string) => fromAda(`/api/accounts/${CO}/signers/${signerId}/withdraw`, {
      method: 'POST', body: JSON.stringify({ withdrawal: signWithdrawal({ company: CO, signerId, invitation: id as never, leaf: leaf as never }, ADA.signingSecret) }),
    });
    const gone = await withdraw(junk.id, JUNK);
    expect(gone.body).toEqual({ withdrawn: junk.id });
    expect(store.getAccount(CO)!.pendingSigners.some((p) => p.id === junk.id)).toBe(false);
    expect(store.getAccount(CO)!.pendingSigners.some((p) => p.id === real.id)).toBe(true);
    expect(store.invitationById(id)!.revokedAt).toBeUndefined();
    /* The real request is asked again as before, and the junk one may be asked again once it is let go. */
    expect((await ask('lou', id, acceptance, REAL)).body).toEqual(real);
    expect((await ask('junk3', id, acceptance, JUNK)).status).toBe(201);
  });

  it('RED WHEN: a request is filed late under a company key newer than the one the invitation was made under', async () => {
    const { id, acceptance } = await aSignerInvitation('Max');
    expire(id);
    chainHolding(REAL);
    const rec = store.getAccount(CO)!;
    store.putAccount({ ...rec, keyEpoch: 1 });
    try {
      const asked = await ask('max', id, acceptance, REAL);
      expect(asked.status).toBe(410);
      expect(JSON.stringify(asked.body)).toMatch(/new invitation/u);
    } finally {
      store.putAccount(rec);
    }
  });
});

describe('a wallet asks which of its seats and keys the company\'s directory already names', () => {
  const named = (who: string, id: string, body: unknown) => sendAs(who)(`/api/invites/${id}/seats-named`, { method: 'POST', body: JSON.stringify(body) });

  it('RED WHEN: it answers anything about a leaf or key that was not asked, or leaves out one that was asked and is named', async () => {
    const { id, acceptance } = await aSignerInvitation('Kit');
    const answer = await named('kit', id, { acceptance, leaves: [ADA.seat, NOBODY], keys: [ADA.statement.signingKey, 'd1'.repeat(32)] });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ leaves: [ADA.seat], keys: [ADA.statement.signingKey] });
    expect(JSON.stringify(answer.body)).not.toContain(BO.seat);
    expect((await named('kit', id, { acceptance, leaves: [], keys: [] })).body).toEqual({ leaves: [], keys: [] });
  });

  it('RED WHEN: the question is not metered like the offer a link opens', async () => {
    const { id, acceptance } = await aSignerInvitation('Nat');
    metered.length = 0;
    await named('nat', id, { acceptance, leaves: [], keys: [] });
    expect(metered).toEqual([id]);
  });

  it('RED WHEN: a wrong proof, a withdrawn invitation or an invitation of another kind is answered', async () => {
    const { id, acceptance } = await aSignerInvitation('Lee');
    expect((await named('lee', id, { acceptance: '00'.repeat(32), leaves: [ADA.seat], keys: [] })).body).toMatchObject({ refused: 'not-accepted' });
    store.putInvite({ ...store.invitationById(id)!, revokedAt: new Date().toISOString() });
    expect((await named('lee', id, { acceptance, leaves: [ADA.seat], keys: [] })).body).toMatchObject({ refused: 'withdrawn' });
    expect((await named('lee', 'e0'.repeat(32), { acceptance, leaves: [], keys: [] })).status).toBe(404);
  });

  it('RED WHEN: it takes a list longer than the seat numbers a wallet tries, or something that is not a key', async () => {
    const { id, acceptance } = await aSignerInvitation('Moe');
    const hex = (n: number) => n.toString(16).padStart(64, '0');
    expect((await named('moe', id, { acceptance, leaves: Array.from({ length: 129 }, (_, n) => hex(n)), keys: [] })).status).toBe(400);
    expect((await named('moe', id, { acceptance, leaves: [], keys: Array.from({ length: 65 }, (_, n) => hex(n)) })).status).toBe(400);
    expect((await named('moe', id, { acceptance, leaves: ['not hex'], keys: [] })).status).toBe(400);
  });
});

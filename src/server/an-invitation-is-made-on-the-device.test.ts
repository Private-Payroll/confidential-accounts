/**
 * **AN INVITATION IS MADE ON THE INVITING SIGNER'S DEVICE, AND THE SERVICE
 * KEEPS ONLY WHAT OPENS NOTHING.** The invitation, record and directory routes
 * are mounted in a throwaway app behind a stand-in for the sign-in and the
 * member gate; the devices are the page's own functions
 * (`invitation-on-device.ts`), talking to it over real HTTP. Every request is
 * recorded, so what crosses the wire is asserted, not assumed.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { canonical } from '../core/crypto.js';
import { SimulatedCommitments } from '../core/ledger.js';
import { openFromInbox, sealToInbox } from '../core/sealed-records.js';
import { refuseASeatKeyNotFromTheInvitee } from '../core/seat-invite-proof.js';
import { openPerson } from '../core/person-record.js';
import type { PendingSignerPayload } from '../core/types.js';
import {
  acceptanceHashOf, acceptanceProofOf, invitationIdOf, InvitationNotOpened, offerKeyOf, openOffer, sealOffer, signInvitationFiling, signOffer, tokenOfLink,
  type InvitationFiling,
} from '../core/invitation.js';
import {
  acceptAsPayeeHere, acceptAsSignerHere, addPayeeFromCodeHere, addSignerFromCodeHere, CodeNotTaken, FingerprintsDiffer, invitePayeeHere, inviteSignerHere,
  InvitationRefused, makeSignerCodeHere, openInvitationHere, payeeHandoverOf, refuseASeatWhoseFingerprintIsNotTheJoiners, seatRequestFingerprint,
  type InvitationSend,
} from 'vaults-web-shared/invitation-on-device.js';
import { newSeatKeys, type NewSeatKeys } from 'vaults-web-shared/accept-seat.js';
import { signJoinCode, writeJoinCode, type JoinCode, type SignerParts } from 'midnight-identity/profile/join-code';
import {
  aCompanyOfTwoSeats, ACME, ADA, ADDRESS, BO, chains, CO, DANA, danasCode, EVE, fromAda, KEY, LABEL, metered, ORIGIN, OTHER, OTHER_ADDRESS, OTHER_LABEL, refusals,
  type Seat,
  sendAs, store, wire,
} from './a-company-of-two-seats.test-support.js';
import { payeeCodeFingerprint } from 'midnight-identity/profile/fingerprint';

aCompanyOfTwoSeats();

describe('A PAYEE IS INVITED FROM A SIGNER\'S DEVICE', () => {
  it('THE PERSON AND THE INVITATION ARE FILED TOGETHER, AND THE SERVICE KEEPS ONLY WHAT OPENS NOTHING', async () => {
    wire.length = 0;
    const made = await invitePayeeHere(ACME, ADA, DANA, ORIGIN, fromAda);
    const token = tokenOfLink(made.link)!;
    /* RED WHEN: a link's path and fragment do not come from one token. */
    expect(token).not.toBeNull();
    expect(made.link).toBe(`${ORIGIN}/join/${invitationIdOf(token)}#${token}`);
    /* The person is the person record filed, and the service's older code reads it. */
    expect(store.personVersions(made.person!).map((r) => [r.version, r.facts!.status])).toEqual([[1, 'pending']]);
    expect(openPerson(store.personVersions(made.person!)[0]!, KEY).name).toBe('Dana Whitfield');
    const kept = store.invitationById(made.id)!;
    expect(kept).toMatchObject({ kind: 'employee', accountId: CO, subjectId: made.person, acceptanceHash: acceptanceHashOf(acceptanceProofOf(token)) });
    /* RED WHEN: the token, the offer key, the acceptance proof or anything offered reaches the service, in a path or a body. */
    const sent = wire.join('\n');
    const held = canonical(store.snapshot());
    /* The salary by its field's name: its digits are hex, so a search for them could match ciphertext by chance. */
    for (const secret of [token, offerKeyOf(token), acceptanceProofOf(token), 'Dana Whitfield', 'dana@acme.co', 'baseAmount', KEY]) {
      expect(sent, secret).not.toContain(secret);
      expect(held, secret).not.toContain(secret);
    }
  });

  it('REFUSES AN UNSIGNED INVITATION, ONE SIGNED IN ANOTHER\'S SESSION, A ROLE THAT MAY NOT INVITE, AND A PERSON THAT IS NOT NEW', async () => {
    const filingFrom = async (seat: Seat, over: Partial<InvitationFiling> = {}): Promise<{ person: unknown; invitation: InvitationFiling }> => {
      let caught: { person: unknown; invitation: InvitationFiling } | null = null;
      await invitePayeeHere(ACME, seat, DANA, ORIGIN, async (_p, init) => { caught = JSON.parse(init.body!); return { status: 201, body: {} }; });
      return { person: caught!.person, invitation: { ...caught!.invitation, ...over } };
    };
    const post = (who: string, body: unknown, company = CO) => sendAs(who)(`/api/accounts/${company}/people`, { method: 'POST', body: JSON.stringify(body) });
    const good = await filingFrom(ADA);
    const { filedBy: _signed, ...unsigned } = good.invitation;
    /* RED WHEN: an invitation nobody signed is kept. */
    expect((await post('ada', { ...good, invitation: unsigned })).body).toMatchObject({ refused: 'not-signed' });
    /* RED WHEN: an invitation signed by one seat is kept in another person's session. */
    expect((await post('bo', good)).body).toMatchObject({ refused: 'no-entry' });
    /* RED WHEN: a seat whose role may not file an offer invites somebody: Bo is an approver. */
    expect((await post('bo', await filingFrom(BO))).body).toMatchObject({ refused: 'role-may-not-file' });
    /* RED WHEN: a member of another company invites somebody into this one. */
    expect((await post('eve', await filingFrom(EVE))).status).toBe(404);
    /* RED WHEN: a seat invites somebody while the chain no longer holds its seat - check S read against the chain now, as a device reads it. */
    const now = chains.get(CO)!;
    chains.set(CO, { ...now, seats: { ...now.seats, seats: now.seats.seats.filter((x) => x !== ADA.seat) } });
    try {
      const unseated = await filingFrom(ADA);
      expect((await post('ada', unseated)).body).toMatchObject({ refused: 'seat-not-seated' });
      expect(store.invitationById(unseated.invitation.id)).toBeNull();
      /* A signer's invitation files no person beside it, so its own check is the only one. */
      const before = store.listInvites(CO).length;
      await expect(inviteSignerHere(ACME, ADA, { name: 'Zed', role: 'admin' }, ORIGIN, fromAda)).rejects.toMatchObject({ refused: 'seat-not-seated', status: 403 });
      expect(store.listInvites(CO).length).toBe(before);
    } finally {
      chains.set(CO, now);
    }
    /* RED WHEN: an invitation names one person and files another. */
    const other = await filingFrom(ADA);
    expect((await post('ada', { person: other.person, invitation: good.invitation })).body).toMatchObject({ refused: 'not-a-new-person' });
    /* RED WHEN: a field the service does not read is kept beside an invitation. */
    expect((await post('ada', { ...good, invitation: { ...good.invitation, name: 'Dana' } })).body).toMatchObject({ refused: 'not-an-invitation' });
    /* RED WHEN: a signer's invitation is filed as a payee's. */
    let signerFiling: InvitationFiling | null = null;
    await inviteSignerHere(ACME, ADA, { name: 'Zed', role: 'admin' }, ORIGIN, async (_p, init) => { signerFiling = JSON.parse(init.body!).invitation; return { status: 201, body: {} }; });
    expect((await post('ada', { person: good.person, invitation: signerFiling })).body).toMatchObject({ refused: 'not-an-invitation' });
    /* RED WHEN: an invitation is kept although the person filed with it was refused. */
    const tampered = { ...(good.person as Record<string, unknown>), digest: '0'.repeat(64) };
    expect((await post('ada', { person: tampered, invitation: good.invitation })).status).toBe(400);
    expect(store.invitationById(good.invitation.id)).toBeNull();
    expect((await post('ada', good)).status).toBe(201);
    /* RED WHEN: a second invitation is filed under a lookup id already taken. */
    const fresh = await filingFrom(ADA);
    const { filedBy: _f2, ...unsignedFresh } = fresh.invitation;
    const again = { person: fresh.person, invitation: signInvitationFiling({ ...unsignedFresh, id: good.invitation.id }, ADA.signingSecret) };
    expect((await post('ada', again)).body).toMatchObject({ refused: 'invitation-taken' });
    /* RED WHEN: an invitation refused after its person was checked still files the person. */
    expect(store.personVersions(String(fresh.invitation.person))).toEqual([]);
  });
});

describe('THE INVITEE OPENS THE OFFER WITH THE LINK, AND ACCEPTS WITH WHAT ONLY THE LINK GIVES', () => {
  it('THE OFFER IS SERVED SEALED BY ITS LOOKUP ID AND OPENED ON THE INVITEE\'S DEVICE, ITS INVITER\'S SIGNATURE CHECKED', async () => {
    const made = await invitePayeeHere(ACME, ADA, DANA, ORIGIN, fromAda);
    metered.length = 0;
    const opened = await openInvitationHere(made.link, sendAs(null));
    /* RED WHEN: the offer is looked up before the caller is counted. */
    expect(metered).toEqual([made.id]);
    expect(opened.signed.offer).toMatchObject({ company: CO, companyName: 'Acme', label: LABEL, account: ADDRESS, for: { kind: 'employee', name: 'Dana Whitfield', baseAmount: 620000n } });
    /* RED WHEN: the service answers with anything it could read: the offer leaves sealed. */
    const raw = await sendAs(null)(`/api/invites/${made.id}/offer`, { method: 'GET' });
    expect(Object.keys(raw.body as object).sort()).toEqual(['expiresAt', 'kind', 'offer']);
    expect(JSON.stringify(raw.body)).not.toContain('Dana');
    /* RED WHEN: a link whose path names another invitation than its fragment opens anything. */
    expect(tokenOfLink(made.link.replace(`/join/${made.id}`, `/join/${'0'.repeat(64)}`))).toBeNull();
    /* RED WHEN: the invitee's device believes the service about which kind of invitation it is. */
    const lying: InvitationSend = async (path, init) => {
      const r = await sendAs(null)(path, init);
      return { ...r, body: { ...(r.body as object), kind: 'signer' } };
    };
    await expect(openInvitationHere(made.link, lying)).rejects.toThrow(/not the kind of invitation/);
    /* RED WHEN: an invitation that does not exist answers as anything but not found. */
    refusals.length = 0;
    expect((await sendAs(null)(`/api/invites/${'0'.repeat(64)}/offer`, { method: 'GET' })).status).toBe(404);
    /* RED WHEN: a refusal here is not written down where the service's refusals are. */
    expect(refusals).toEqual([`404 GET /api/invites/${'0'.repeat(64)}/offer not-found`]);
  });

  it('AN OFFER ITS INVITER DID NOT SIGN, OR SIGNED FOR ANOTHER ACCOUNT, IS NOT OPENED', () => {
    const token = '5'.repeat(64);
    const offer = { company: CO, companyName: 'Acme', label: LABEL, account: ADDRESS, inboxPublicKey: ACME.inboxPublicKey,
      for: { kind: 'employee' as const, person: 'emp_x', name: 'X', title: 'T', email: null, asset: 'TEST', baseAmount: 1n, startDate: '2026-10-01' },
      inviter: { committeeKey: ADA.committeeKey, statement: ADA.statement } };
    expect(openOffer(sealOffer(signOffer(offer, ADA.signingSecret), token), token).offer.for.name).toBe('X');
    /* RED WHEN: an offer changed after its inviter signed it is believed. */
    const signed = signOffer(offer, ADA.signingSecret);
    expect(() => openOffer(sealOffer({ ...signed, offer: { ...offer, for: { ...offer.for, baseAmount: 2n } } }, token), token)).toThrow(/did not sign this offer/);
    /* RED WHEN: an offer naming an account its inviter's entry was not signed for is believed. */
    expect(() => openOffer(sealOffer(signOffer({ ...offer, account: OTHER_ADDRESS }, ADA.signingSecret), token), token)).toThrow(/not on the account it names/);
    /* RED WHEN: an entry signed for another company's label vouches for this one's offer. */
    expect(() => openOffer(sealOffer(signOffer({ ...offer, label: OTHER_LABEL }, ADA.signingSecret), token), token)).toThrow(/did not sign its entry/);
    /* RED WHEN: a device signs an offer with a filing key its entry does not name. */
    expect(() => signOffer(offer, BO.signingSecret)).toThrow(/not the one its directory entry names/);
    /* RED WHEN: another token's key opens the offer. */
    expect(() => openOffer(sealOffer(signed, token), '6'.repeat(64))).toThrow(InvitationNotOpened);
  });

  it('A PAYEE ACCEPTS ONLY WITH THE PROOF THE LINK GIVES, ONCE, AND WHAT THEY HAND OVER WAITS ON THE INVITATION UNOPENED', async () => {
    const made = await invitePayeeHere(ACME, ADA, DANA, ORIGIN, fromAda);
    const opened = await openInvitationHere(made.link, sendAs(null));
    const code = danasCode();
    const handover = payeeHandoverOf(code, opened.signed.offer.inboxPublicKey);
    const accept = (body: unknown) => sendAs('dana')(`/api/invites/${made.id}/accept-employee`, { method: 'POST', body: JSON.stringify(body) });
    /* RED WHEN: an acceptance that is not the link's proof is taken. */
    expect((await accept({ acceptance: acceptanceProofOf('7'.repeat(64)), handover })).body).toMatchObject({ refused: 'not-accepted' });
    /* RED WHEN: the lookup id, which is in the path for anybody to see, accepts the invitation. */
    expect((await accept({ acceptance: made.id, handover })).body).toMatchObject({ refused: 'not-accepted' });
    /* RED WHEN: an address sent in the clear is ignored rather than refused by name. */
    expect((await accept({ acceptance: acceptanceProofOf(opened.token), handover, address: 'x' })).body).toMatchObject({ refused: 'handover-in-the-clear' });
    /* RED WHEN: a code made for another company is handed over on this one's invitation. */
    await expect(acceptAsPayeeHere(opened, danasCode(OTHER_LABEL), sendAs('dana'))).rejects.toThrow(/not a payee's code for the company/);
    const accepted = await acceptAsPayeeHere(opened, code, sendAs('dana'));
    /* RED WHEN: the payee is shown a fingerprint of anything but the address they are paid at. */
    expect(accepted.fingerprint).toBe(payeeCodeFingerprint(danasCode() as never));
    /* What was handed over waits on the invitation, for an admitting device to open: the code her wallet signed. */
    expect(openFromInbox<JoinCode>(store.getEmployee(made.person!)!.inbox!, CO, KEY)).toEqual(code);
    /* RED WHEN: an invitation is accepted twice. */
    await expect(acceptAsPayeeHere(opened, code, sendAs('mallory'))).rejects.toMatchObject({ refused: 'used' });
    /* RED WHEN: an accepted invitation's offer is still served. */
    expect((await sendAs(null)(`/api/invites/${made.id}/offer`, { method: 'GET' })).status).toBe(410);
  });

  it('A WITHDRAWN OR EXPIRED INVITATION CAN NEITHER BE OPENED NOR ACCEPTED', async () => {
    for (const close of ['withdrawn', 'expired'] as const) {
      const made = await invitePayeeHere(ACME, ADA, DANA, ORIGIN, fromAda);
      const opened = await openInvitationHere(made.link, sendAs(null));
      const row = store.invitationById(made.id)!;
      store.putInvite(close === 'withdrawn' ? { ...row, revokedAt: new Date().toISOString() } : { ...row, expiresAt: new Date(Date.now() - 1000).toISOString() });
      /* RED WHEN: a closed invitation's offer is still served. */
      await expect(openInvitationHere(made.link, sendAs(null)), close).rejects.toMatchObject({ refused: close });
      /* RED WHEN: a closed invitation is still accepted. */
      await expect(acceptAsPayeeHere(opened, danasCode(), sendAs('dana')), close).rejects.toMatchObject({ refused: close });
      expect(store.getEmployee(made.person!)!.inbox).toBeNull();
    }
  });
});

describe('A SIGNER IS INVITED AND ACCEPTS THROUGH THE ONE SEAT PATH', () => {
  it('THE SEAT REQUEST IS SEALED ON THE INVITEE\'S DEVICE WITH THE NAME AND ROLE THE OFFER GAVE, AND ITS KEYS ARE PROVED', async () => {
    wire.length = 0;
    const made = await inviteSignerHere(ACME, ADA, { name: 'Cleo', role: 'approver' }, ORIGIN, fromAda);
    const opened = await openInvitationHere(made.link, sendAs(null));
    expect(opened.signed.offer.for).toMatchObject({ kind: 'signer', name: 'Cleo', role: 'approver' });
    const kept: unknown[] = [];
    const seat = await acceptAsSignerHere(opened, SimulatedCommitments, {
      newKeys: newSeatKeys, seal: async (s) => { kept.push(s); }, promote: async () => {},
    }, sendAs('cleo'));
    const pending = store.getAccount(CO)!.pendingSigners.find((p) => p.id === seat.signerId)!;
    expect(pending.userId).toBe('cleo');
    /* The company's devices open it, and the proof of the keys holds for the name and role the offer gave. */
    const waiting = openFromInbox<PendingSignerPayload>(pending.sealed, CO, KEY);
    expect(waiting).toMatchObject({ name: 'Cleo', role: 'approver' });
    expect(() => refuseASeatKeyNotFromTheInvitee(KEY, CO, waiting)).not.toThrow();
    /* RED WHEN: a seat request names another role than the one the invitation was proved for. */
    expect(() => refuseASeatKeyNotFromTheInvitee(KEY, CO, { ...waiting, role: 'admin' })).toThrow();
    /* RED WHEN: the keys are made somewhere other than the invitee's device, or the seat secret leaves it. */
    expect(kept).toHaveLength(1);
    const sent = wire.join('\n');
    for (const secret of [opened.token, (opened.signed.offer.for as { seat: { secret: string } }).seat.secret, 'Cleo']) expect(sent).not.toContain(secret);
    expect(store.invitationById(made.id)).toMatchObject({ acceptedAt: expect.any(String), subjectId: seat.signerId });
    /* RED WHEN: a signer invitation is accepted by somebody already on the company. */
    const again = await inviteSignerHere(ACME, ADA, { name: 'Ada again', role: 'admin' }, ORIGIN, fromAda);
    await expect(acceptAsSignerHere(await openInvitationHere(again.link, sendAs(null)), SimulatedCommitments, {
      newKeys: newSeatKeys, seal: async () => {}, promote: async () => {},
    }, sendAs('ada'))).rejects.toMatchObject({ refused: 'already-on-this-account' });
    /* RED WHEN: a payee's invitation is accepted as a seat. */
    const payee = await invitePayeeHere(ACME, ADA, DANA, ORIGIN, fromAda);
    await expect(acceptAsSignerHere(await openInvitationHere(payee.link, sendAs(null)), SimulatedCommitments, {
      newKeys: newSeatKeys, seal: async () => {}, promote: async () => {},
    }, sendAs('zed'))).rejects.toThrow(/offers pay, not a seat/);
    /* RED WHEN: the service accepts a seat request against a payee's invitation. */
    expect((await sendAs('zed')(`/api/invites/${payee.id}/accept-signer`, { method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(tokenOfLink(payee.link)!), waiting: sealToInbox({}, ACME.inboxPublicKey) }) })).status).toBe(404);
  });

  it('ONLY A SEAT WHOSE ROLE MAY FILE AN OFFER INVITES A SIGNER', async () => {
    /* RED WHEN: an approver's seat invites a signer. */
    const refused = inviteSignerHere(ACME, BO, { name: 'Zed', role: 'admin' }, ORIGIN, sendAs('bo'));
    await expect(refused).rejects.toMatchObject({ refused: 'role-may-not-file', status: 403 });
    /* A screen tells a refusal the service gave apart from any other failure, and says the service's words. */
    await expect(refused).rejects.toBeInstanceOf(InvitationRefused);
    /* RED WHEN: a signer invitation is kept with no seat's signature. */
    let caught: { invitation: InvitationFiling } | null = null;
    await inviteSignerHere(ACME, ADA, { name: 'Zed', role: 'admin' }, ORIGIN, async (_p, init) => { caught = JSON.parse(init.body!); return { status: 201, body: {} }; });
    const { filedBy: _f, ...unsigned } = caught!.invitation;
    expect((await fromAda(`/api/accounts/${CO}/invites/signer`, { method: 'POST', body: JSON.stringify({ invitation: unsigned }) })).body).toMatchObject({ refused: 'not-signed' });
  });
});

describe('A CODE ENDS WHERE A LINK DOES: THE SAME PACKAGE, THE SAME SEAT REQUEST', () => {
  /* The keys one joiner's device makes, used for both ways in so the two seat requests can be compared. */
  const keysOf = (): NewSeatKeys => newSeatKeys();
  /** A joiner's wallet, signing the code it is asked for as the wallet's screen does at the press. */
  const walletOf = (n: number, person: string, label: CompanyLabel = LABEL) =>
    async (parts: SignerParts): Promise<JoinCode> => signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), label, person, parts);
  const opened = (pending: { sealed: { ephemeral: string; iv: string; tag: string; body: string } }) => openFromInbox<PendingSignerPayload>(pending.sealed, CO, KEY);
  const pendingOf = (id: string) => store.getAccount(CO)!.pendingSigners.find((p) => p.id === id)!;

  it('A SIGNER\'S CODE AND A SIGNER\'S LINK END IN THE SAME SEAT REQUEST, EACH WITH ITS OWN SPENT INVITATION', async () => {
    const keys = keysOf();
    /* By link: Dee's device accepts and files the seat request. */
    const viaLink = await inviteSignerHere(ACME, ADA, { name: 'Dee', role: 'approver' }, ORIGIN, fromAda);
    const linked = await acceptAsSignerHere(await openInvitationHere(viaLink.link, sendAs(null)), SimulatedCommitments, {
      newKeys: () => keys, seal: async () => {}, promote: async () => {},
    }, sendAs('dee'));
    /* By code: Fen's device makes the same keys into a code her wallet signs; Ada pastes it. */
    const sealedForCode: unknown[] = [];
    const made = await makeSignerCodeHere(CO, SimulatedCommitments, { newKeys: () => keys, seal: async (x) => { sealedForCode.push(x); } }, walletOf(31, 'fen'));
    /* RED WHEN: the keys of a code are not made and kept on the joiner's own device. */
    expect(sealedForCode).toHaveLength(1);
    const listedBefore = store.listInvites(CO).length;
    const added = await addSignerFromCodeHere(ACME, ADA, made.code, { name: 'Dee', role: 'approver' }, fromAda);
    const a = opened(pendingOf(linked.signerId!));
    const b = opened(pendingOf(added.id));
    /* RED WHEN: a code and a link end in seat requests that differ in anything but the invitation each was proved under. */
    const { seatProof: proofA, ...restA } = a;
    const { seatProof: proofB, ...restB } = b;
    expect(restB).toEqual(restA);
    expect(Object.keys(proofB!).sort()).toEqual(Object.keys(proofA!).sort());
    /* Both pass the check every seating device makes before it seats anybody. */
    expect(() => refuseASeatKeyNotFromTheInvitee(KEY, CO, a)).not.toThrow();
    expect(() => refuseASeatKeyNotFromTheInvitee(KEY, CO, b)).not.toThrow();
    /* RED WHEN: a code's seat request is filed under anybody but the sign-in its code names. */
    expect(pendingOf(added.id).userId).toBe('fen');
    /* RED WHEN: a code's seat has no invitation behind it, or one still open after the seat request spent it. */
    expect(store.listInvites(CO).length).toBe(listedBefore + 1);
    expect(store.listInvites(CO).find((i) => i.subjectId === added.id)).toMatchObject({ kind: 'signer', acceptedAt: expect.any(String), createdBy: 'ada' });
    /* Each way in shows its joiner the fingerprint the seating devices work out from the seat request. */
    expect(linked.fingerprint).toBe(seatRequestFingerprint(a));
    expect(made.fingerprint).toBe(seatRequestFingerprint(b));
    expect(added.fingerprint).toBe(made.fingerprint);
  });

  it('A CODE SWAPPED ON THE WAY IS CAUGHT BY THE FINGERPRINT THE JOINER READS OUT', async () => {
    /* Gus makes his code; somebody else makes theirs, and theirs is what reaches Ada. */
    const gus = await makeSignerCodeHere(CO, SimulatedCommitments, { newKeys: keysOf, seal: async () => {} }, walletOf(41, 'gus'));
    const theirs = await makeSignerCodeHere(CO, SimulatedCommitments, { newKeys: keysOf, seal: async () => {} }, walletOf(42, 'gus'));
    const added = await addSignerFromCodeHere(ACME, ADA, theirs.code, { name: 'Gus', role: 'approver' }, fromAda);
    const waiting = opened(pendingOf(added.id));
    /* A swapped code verifies: it is a real signature, by somebody else's wallet. */
    expect(() => refuseASeatKeyNotFromTheInvitee(KEY, CO, waiting)).not.toThrow();
    /* RED WHEN: the fingerprint Gus reads out is not compared with the keys about to be seated. */
    expect(() => refuseASeatWhoseFingerprintIsNotTheJoiners(waiting, gus.fingerprint)).toThrow(FingerprintsDiffer);
    /* And the honest comparison passes however it is typed. */
    expect(() => refuseASeatWhoseFingerprintIsNotTheJoiners(waiting, theirs.fingerprint.toLowerCase().replace(/-/gu, ' '))).not.toThrow();
  });

  it('A CODE WITH A PART CHANGED, FOR ANOTHER COMPANY, OR OF THE WRONG KIND IS NOT TAKEN, AND NOTHING IS FILED', async () => {
    const k = keysOf();
    const code = await walletOf(51, 'hal')({ kind: 'signer', signingPublicKey: k.signingPublicKey, wrappingPublicKey: k.wrappingPublicKey, leafCommitment: '7c'.repeat(32) });
    const before = store.listInvites(CO).length;
    /* RED WHEN: a code whose keys were changed after the wallet signed it is taken. */
    await expect(addSignerFromCodeHere(ACME, ADA, writeJoinCode({ ...code, parts: { ...(code.parts as SignerParts), signingPublicKey: '99'.repeat(32) } }), { name: 'Hal', role: 'approver' }, fromAda))
      .rejects.toThrow(/not signed by the wallet it names/);
    /* RED WHEN: a code made for another company is taken. */
    const other = await makeSignerCodeHere(OTHER, SimulatedCommitments, { newKeys: keysOf, seal: async () => {} }, walletOf(52, 'hal', OTHER_LABEL));
    await expect(addSignerFromCodeHere(ACME, ADA, other.code, { name: 'Hal', role: 'approver' }, fromAda)).rejects.toThrow(/another company/);
    /* RED WHEN: a payee's code is taken as a signer's. */
    await expect(addSignerFromCodeHere(ACME, ADA, writeJoinCode(danasCode()), { name: 'Hal', role: 'approver' }, fromAda)).rejects.toBeInstanceOf(CodeNotTaken);
    /* RED WHEN: a refused code still files an invitation. */
    expect(store.listInvites(CO).length).toBe(before);
  });

  it('ONLY THE SEAT THAT MADE THE INVITATION FILES A SEAT REQUEST FOR SOMEBODY ELSE', async () => {
    const made = await inviteSignerHere(ACME, ADA, { name: 'Ivy', role: 'approver' }, ORIGIN, fromAda);
    const token = tokenOfLink(made.link)!;
    const body = (forWhom: string) => JSON.stringify({ acceptance: acceptanceProofOf(token), waiting: sealToInbox({}, ACME.inboxPublicKey), for: forWhom });
    /* RED WHEN: somebody who holds a link files a seat request under another person's sign-in. */
    expect((await sendAs('ivy')(`/api/invites/${made.id}/accept-signer`, { method: 'POST', body: body('victim') })).body).toMatchObject({ refused: 'not-yours-to-accept-for' });
    /* RED WHEN: a seat that did not make the invitation files a seat request for somebody else on it. */
    expect((await sendAs('bo')(`/api/invites/${made.id}/accept-signer`, { method: 'POST', body: body('victim') })).body).toMatchObject({ refused: 'not-yours-to-accept-for' });
    /* RED WHEN: a seat request is filed for somebody already on the company. */
    expect((await fromAda(`/api/invites/${made.id}/accept-signer`, { method: 'POST', body: body('bo') })).body).toMatchObject({ refused: 'already-on-this-account' });
    expect(store.invitationById(made.id)!.acceptedAt).toBeUndefined();
    /* RED WHEN: a seat that may invite files a seat request for somebody else on an invitation another seat made. */
    store.putInvite({ ...store.invitationById(made.id)!, createdBy: 'bo' });
    expect((await fromAda(`/api/invites/${made.id}/accept-signer`, { method: 'POST', body: body('jo') })).body).toMatchObject({ refused: 'not-yours-to-accept-for' });
    /* RED WHEN: the seat that made it files for somebody else while the chain no longer lists its wallet on the company's committee - check S's rule, read against the chain now. */
    store.putInvite({ ...store.invitationById(made.id)!, createdBy: 'ada' });
    const now = chains.get(CO)!;
    chains.set(CO, { ...now, seats: { ...now.seats, committee: now.seats.committee.filter((k) => k.value !== ADA.committeeKey.value) } });
    try {
      expect((await fromAda(`/api/invites/${made.id}/accept-signer`, { method: 'POST', body: body('jo') })).body).toMatchObject({ refused: 'not-yours-to-accept-for' });
    } finally {
      chains.set(CO, now);
    }
    expect(store.invitationById(made.id)!.acceptedAt).toBeUndefined();
  });

  it('A PAYEE\'S CODE AND A PAYEE\'S LINK HAND OVER THE SAME PACKAGE', async () => {
    const code = danasCode(LABEL, 'dana');
    /* By code: Ada pastes Dana's code. */
    const added = await addPayeeFromCodeHere(ACME, ADA, writeJoinCode(code), DANA, fromAda);
    /* By link: Dana's device accepts with the same code. */
    const made = await invitePayeeHere(ACME, ADA, DANA, ORIGIN, fromAda);
    const linked = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs('dana'));
    /* RED WHEN: the two ways hand over different packages. */
    const byCode = openFromInbox<JoinCode>(store.getEmployee(added.person)!.inbox!, CO, KEY);
    const byLink = openFromInbox<JoinCode>(store.getEmployee(made.person!)!.inbox!, CO, KEY);
    expect(byCode).toEqual(code);
    expect(byLink).toEqual(code);
    expect(added.fingerprint).toBe(linked.fingerprint);
    /* RED WHEN: a payee added from a code is not on the payroll as a person record, waiting to be admitted. */
    expect(store.getEmployee(added.person)).toMatchObject({ accountId: CO, status: 'pending' });
  });
});

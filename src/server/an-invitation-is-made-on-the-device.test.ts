/**
 * **AN INVITATION IS MADE ON THE INVITING SIGNER'S DEVICE, AND THE SERVICE
 * KEEPS ONLY WHAT OPENS NOTHING.** The invitation, record and directory routes
 * are mounted in a throwaway app behind a stand-in for the sign-in and the
 * member gate; the devices are the page's own functions
 * (`invitation-on-device.ts`), talking to it over real HTTP. Every request is
 * recorded, so what crosses the wire is asserted, not assumed.
 */
import { seatBlinding, walletKeyProvedBy } from '../core/seat-opening.js';
import { storedSignerLeaf } from '../core/signer-leaf.js';
import type { PendingSeat } from 'vaults-web-shared/keyring.js';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import type { Hex } from '../core/crypto.js';
import { enteredHere } from '../testing/records-entered.js';
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { canonical, newSigningKeypair, newSymmetricKey } from '../core/crypto.js';
import type { CompanyKeys } from '../core/company-key.js';
import { CompanyKeyBeingChanged } from 'vaults-web-shared/company-key-here.js';
import { answerDigestOf, answerOpenedWith, AnswerToAnOldInvitation } from '../core/answer-opened.js';
import { SimulatedCommitments } from '../core/ledger.js';
import { inboxPublicKey, openFromInbox, sealToInbox } from '../core/sealed-records.js';
import { invitationSecret, refuseASeatKeyNotFromTheInvitee } from '../core/seat-invite-proof.js';
import { openPerson } from '../core/person-record.js';
import { payeeFor } from '../testing/payees.js';
import { theNetwork } from '../midnight/network.js';
import { TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import type { PendingSignerPayload } from '../core/types.js';
import {
  acceptanceHashOf, acceptanceProofOf, invitationIdOf, invitationLink, InvitationNotOpened, isUtcMoment, newInvitationToken, whyThisOfferCannotBeMade, offerKeyOf, openOffer, sealOffer, signInvitationFiling, signOffer,
  signSeatInvitation, tokenOfLink,
  type InvitationFiling,
} from '../core/invitation.js';
import {
  acceptAsPayeeHere, acceptAsSignerHere, addPayeeFromCodeHere, addSignerFromCodeHere, CodeNotTaken, FingerprintsDiffer, inviteHere,
  InvitationNotMade, InvitationRefused, makeSignerCodeHere, openInvitationHere, SeatMayNotInvite, payeeHandoverOf, refuseASeatWhoseFingerprintIsNotTheJoiners, seatRequestFingerprint,
  type InvitationSend, type InviteSpecs,
} from 'vaults-web-shared/invitation-on-device.js';
import { newSeatKeys, type NewSeatKeys } from 'vaults-web-shared/accept-seat.js';
import { readJoinCode, signJoinCode, writeJoinCode, type JoinCode, type SignerParts } from 'midnight-identity/profile/join-code';
import {
  aCompanyOfTwoSeats, ACME, ACME_INBOX, ADA, ADDRESS, BO, chains, CO, DANA, danasCode, EVE, fromAda, KEY, LABEL, metered, ORIGIN, OTHER, OTHER_ADDRESS, OTHER_LABEL, refusals,
  type Seat,
  newestPerson, peopleRecords, personVersions, sendAs, store, wire,
} from './a-company-of-two-seats.test-support.js';
import { payeeCodeFingerprint } from 'midnight-identity/profile/fingerprint';
/* The leaf each opening makes, as a device's vault worker works it out with the account's own scheme. */
const LEAVES = async (openings: readonly { publicKey: string; blinding: string; scope: string }[]) =>
  openings.map((o) => SimulatedCommitments.signerLeaf(o.publicKey as Hex, o.blinding as Hex, o.scope as Hex));
/* The key Cleo's wallet gives for the company her invitation names: the key her seat's leaf commits to. */
const CLEOS_KEY = { tag: 'schnorr', value: '4c'.repeat(32) };

aCompanyOfTwoSeats();

describe('A PAYEE IS INVITED FROM A SIGNER\'S DEVICE', () => {
  it('THE PERSON AND THE INVITATION ARE FILED TOGETHER, AND THE SERVICE KEEPS ONLY WHAT OPENS NOTHING', async () => {
    wire.length = 0;
    const made = await inviteHere(ACME, ADA, 'employee', DANA, ORIGIN, fromAda);
    const token = tokenOfLink(made.link)!;
    /* RED WHEN: a link's path and fragment do not come from one token. */
    expect(token).not.toBeNull();
    expect(made.link).toBe(`${ORIGIN}/join/${invitationIdOf(token)}#${token}`);
    /* The person is the person record filed, kept with the company's records. */
    expect((await personVersions(made.person!)).map((r) => [r.version, r.facts!.status])).toEqual([[1, 'pending']]);
    expect(openPerson((await personVersions(made.person!))[0]!, KEY).name).toBe('Dana Whitfield');
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

  it('REFUSES AN UNSIGNED INVITATION, ONE SIGNED IN ANOTHER\'S SESSION, AND A PERSON THAT IS NOT NEW; JUDGES NO ROLE', async () => {
    const filingFrom = async (seat: Seat, over: Partial<InvitationFiling> = {}): Promise<{ person: unknown; invitation: InvitationFiling }> => {
      let caught: { person: unknown; invitation: InvitationFiling } | null = null;
      /* Only caught here, never filed, so it is not entered either. */
      await inviteHere(ACME, { ...seat, entered: enteredHere() }, 'employee', DANA, ORIGIN, async (_p, init) => { caught = JSON.parse(init.body!); return { status: 201, body: {} }; });
      return { person: caught!.person, invitation: { ...caught!.invitation, ...over } };
    };
    const post = (who: string, body: unknown, company = CO) => sendAs(who)(`/api/accounts/${company}/invites`, { method: 'POST', body: JSON.stringify(body) });
    const good = await filingFrom(ADA);
    const { filedBy: _signed, ...unsigned } = good.invitation;
    /* RED WHEN: an invitation nobody signed is kept. */
    expect((await post('ada', { ...good, invitation: unsigned })).body).toMatchObject({ refused: 'not-signed' });
    /* RED WHEN: an invitation signed by one seat is kept in another person's session. */
    expect((await post('bo', good)).body).toMatchObject({ refused: 'no-entry' });
    /* RED WHEN: the service judges a role: Bo is an approver, and whether his seat may invite is every member's device's to judge. */
    expect((await post('bo', await filingFrom(BO))).status).toBe(201);
    /* RED WHEN: a member of another company invites somebody into this one. */
    expect((await post('eve', await filingFrom(EVE))).status).toBe(404);
    /* RED WHEN: a seat invites somebody while the chain no longer holds its seat - read against the chain now, as a device reads it. */
    const now = chains.get(CO)!;
    chains.set(CO, { ...now, seats: { ...now.seats, seats: now.seats.seats.filter((x) => x !== ADA.seat) } });
    try {
      const unseated = await filingFrom(ADA);
      expect((await post('ada', unseated)).body).toMatchObject({ refused: 'seat-not-seated' });
      expect(store.invitationById(unseated.invitation.id)).toBeNull();
      /* A signer's invitation files no person beside it, so its own check is the only one. */
      const before = store.listInvites(CO).length;
      await expect(inviteHere(ACME, ADA, 'signer', { name: 'Zed', role: 'admin', person: 'zed' }, ORIGIN, fromAda)).rejects.toMatchObject({ refused: 'seat-not-seated', status: 403 });
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
    await inviteHere(ACME, ADA, 'signer', { name: 'Zed', role: 'admin', person: 'zed' }, ORIGIN, async (_p, init) => { signerFiling = JSON.parse(init.body!).invitation; return { status: 201, body: {} }; });
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
    expect(await personVersions(String(fresh.invitation.person))).toEqual([]);
  });
});

describe('THE INVITEE OPENS THE OFFER WITH THE LINK, AND ACCEPTS WITH WHAT ONLY THE LINK GIVES', () => {
  it('THE OFFER IS SERVED SEALED BY ITS LOOKUP ID AND OPENED ON THE INVITEE\'S DEVICE, ITS INVITER\'S SIGNATURE CHECKED', async () => {
    const made = await inviteHere(ACME, ADA, 'employee', DANA, ORIGIN, fromAda);
    metered.length = 0;
    const opened = await openInvitationHere(made.link, sendAs(null));
    /* RED WHEN: the offer is looked up before the caller is counted. */
    expect(metered).toEqual([made.id]);
    expect(opened.signed.offer).toMatchObject({ company: CO, companyName: 'Acme', label: LABEL, account: ADDRESS, for: { kind: 'employee', name: 'Dana Whitfield', baseAmount: 620000n } });
    /* RED WHEN: the service answers with anything it could read: the offer leaves sealed, and its lookup id alone names no company. */
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
    const offer = { company: CO, companyName: 'Acme', label: LABEL, account: ADDRESS, inboxPublicKey: ACME_INBOX, expiresAt: Date.now() + 3_600_000,
      for: { kind: 'employee' as const, person: 'emp_x', name: 'X', title: 'T', email: null, asset: 'TEST', baseAmount: 1n, startDate: '2026-10-01' },
      inviter: { committeeKey: ADA.committeeKey, statement: ADA.statement, opening: ADA.opening } };
    expect(openOffer(sealOffer(signOffer(offer, ADA.signingSecret), token), token).offer.for.name).toBe('X');
    /* RED WHEN: an offer changed after its inviter signed it is believed. */
    const signed = signOffer(offer, ADA.signingSecret);
    expect(() => openOffer(sealOffer({ ...signed, offer: { ...offer, for: { ...offer.for, baseAmount: 2n } } }, token), token)).toThrow(/did not sign this offer/);
    /* RED WHEN: an offer naming an account its inviter's entry was not signed for is believed. */
    expect(() => openOffer(sealOffer(signOffer({ ...offer, account: OTHER_ADDRESS }, ADA.signingSecret), token), token)).toThrow(/not on the account it names/);
    /* RED WHEN: an entry signed for another company's label vouches for this one's offer. */
    expect(() => openOffer(sealOffer(signOffer({ ...offer, label: OTHER_LABEL }, ADA.signingSecret), token), token)).toThrow(/did not sign its entry/);
    /* RED WHEN: an offer that does not carry its inviter's own seat's opening is opened, so the invitee's wallet could not judge the inviter. */
    const { opening: _none, ...noOpening } = offer.inviter;
    expect(() => openOffer(sealOffer(signOffer({ ...offer, inviter: noOpening as never }, ADA.signingSecret), token), token)).toThrow(/did not hand over its own seat's opening/);
    /* RED WHEN: a device signs an offer with a filing key its entry does not name. */
    expect(() => signOffer(offer, BO.signingSecret)).toThrow(/not the one its directory entry names/);
    /* RED WHEN: another token's key opens the offer. */
    expect(() => openOffer(sealOffer(signed, token), '6'.repeat(64))).toThrow(InvitationNotOpened);
  });

  it('A SEAT OFFERED IS FOR THE INVITATION ITS LINK NAMES, SIGNED BY THE SEAT THAT SIGNED THE OFFER', () => {
    const token = newInvitationToken();
    const invited = { company: CO, invitation: invitationIdOf(token), person: 'usr_kit', name: 'Kit', role: 'approver' as const };
    const offerFor = (signedInvitation: ReturnType<typeof signSeatInvitation>) => ({
      company: CO, companyName: 'Acme', label: LABEL, account: ADDRESS, inboxPublicKey: ACME_INBOX, expiresAt: Date.now() + 3_600_000,
      for: { kind: 'signer' as const, name: 'Kit', role: 'approver' as const, seat: { nonce: '01'.repeat(32), secret: '02'.repeat(32) }, invited: signedInvitation },
      inviter: { committeeKey: ADA.committeeKey, statement: ADA.statement, opening: ADA.opening } });
    const opens = (signedInvitation: ReturnType<typeof signSeatInvitation>) => () => openOffer(sealOffer(signOffer(offerFor(signedInvitation), ADA.signingSecret), token), token);
    expect(opens(signSeatInvitation(invited, ADA.signingSecret as Hex))().offer.for).toMatchObject({ invited: { terms: invited } });
    /* RED WHEN: a link opens a seat signed for another invitation, so one invitation's seat could be carried under another's link. */
    expect(opens(signSeatInvitation({ ...invited, invitation: invitationIdOf(newInvitationToken()) }, ADA.signingSecret as Hex))).toThrow(/signed for another invitation than this link/);
    /* RED WHEN: a link's seat names a leaf before the joiner's device has made one. */
    expect(opens(signSeatInvitation({ ...invited, leaf: '7c'.repeat(32) as Hex }, ADA.signingSecret as Hex))).toThrow(/signed for another invitation than this link/);
    /* RED WHEN: who the seat is for is signed by another seat than the one that signed the offer. */
    expect(opens(signSeatInvitation(invited, BO.signingSecret as Hex))).toThrow(/not signed by the seat that invited/);
    /* RED WHEN: the role signed for the seat is not the role offered. */
    expect(opens(signSeatInvitation({ ...invited, role: 'admin' }, ADA.signingSecret as Hex))).toThrow(/not signed by the seat that invited/);
    /* RED WHEN: an offer of a seat that says nothing of who it is for is opened. */
    expect(opens(undefined as never)).toThrow(/does not say who the seat is for/);
  });

  it('A PAYEE ACCEPTS ONLY WITH THE PROOF THE LINK GIVES, ONCE, AND WHAT THEY HAND OVER WAITS ON THE INVITATION UNOPENED', async () => {
    const made = await inviteHere(ACME, ADA, 'employee', DANA, ORIGIN, fromAda);
    const opened = await openInvitationHere(made.link, sendAs(null));
    const code = danasCode();
    const handover = payeeHandoverOf(code, opened.signed.offer.inboxPublicKey);
    const accept = (body: unknown) => sendAs('dana')(`/api/invites/${made.id}/accept-payee`, { method: 'POST', body: JSON.stringify(body) });
    /* RED WHEN: an acceptance that is not the link's proof is taken. */
    expect((await accept({ acceptance: acceptanceProofOf('7'.repeat(64)), handover, kind: 'employee' })).body).toMatchObject({ refused: 'not-accepted' });
    /* RED WHEN: the lookup id, which is in the path for anybody to see, accepts the invitation. */
    expect((await accept({ acceptance: made.id, handover, kind: 'employee' })).body).toMatchObject({ refused: 'not-accepted' });
    /* RED WHEN: an address sent in the clear is ignored rather than refused by name. */
    expect((await accept({ acceptance: acceptanceProofOf(opened.token), handover, kind: 'employee', address: 'x' })).body).toMatchObject({ refused: 'handover-in-the-clear' });
    /* RED WHEN: a code made for another company is handed over on this one's invitation. */
    await expect(acceptAsPayeeHere(opened, danasCode(OTHER_LABEL), sendAs('dana'))).rejects.toThrow(/not a payee's code for the company/);
    const accepted = await acceptAsPayeeHere(opened, code, sendAs('dana'));
    /* RED WHEN: the payee is shown a fingerprint of anything but the address they are paid at. */
    expect(accepted.fingerprint).toBe(payeeCodeFingerprint(danasCode() as never));
    /* What was handed over waits on the invitation, for an admitting device to open: the code her wallet signed. */
    expect(openFromInbox<JoinCode>(store.handoverFor(made.person!, 'employee')!, CO, KEY)).toEqual(code);
    /* RED WHEN: an invitation is accepted twice. */
    await expect(acceptAsPayeeHere(opened, code, sendAs('mallory'))).rejects.toMatchObject({ refused: 'used' });
    /* RED WHEN: an accepted invitation's offer is still served. */
    expect((await sendAs(null)(`/api/invites/${made.id}/offer`, { method: 'GET' })).status).toBe(410);
  });

  it('A WITHDRAWN OR EXPIRED INVITATION CAN NEITHER BE OPENED NOR ACCEPTED', async () => {
    for (const close of ['withdrawn', 'expired'] as const) {
      const made = await inviteHere(ACME, ADA, 'employee', DANA, ORIGIN, fromAda);
      const opened = await openInvitationHere(made.link, sendAs(null));
      const row = store.invitationById(made.id)!;
      store.putInvite(close === 'withdrawn' ? { ...row, revokedAt: new Date().toISOString() } : { ...row, expiresAt: new Date(Date.now() - 1000).toISOString() });
      /* RED WHEN: a closed invitation's offer is still served. */
      await expect(openInvitationHere(made.link, sendAs(null)), close).rejects.toMatchObject({ refused: close });
      /* RED WHEN: a closed invitation is still accepted. */
      await expect(acceptAsPayeeHere(opened, danasCode(), sendAs('dana')), close).rejects.toMatchObject({ refused: close });
      expect(store.handoverFor(made.person!, 'employee')).toBeNull();
    }
  });
});

describe('A SIGNER IS INVITED AND ACCEPTS THROUGH THE ONE SEAT PATH', () => {
  it('THE SEAT REQUEST IS SEALED ON THE INVITEE\'S DEVICE WITH THE NAME AND ROLE THE OFFER GAVE, AND ITS KEYS ARE PROVED', async () => {
    wire.length = 0;
    const made = await inviteHere(ACME, ADA, 'signer', { name: 'Cleo', role: 'approver', person: 'cleo' }, ORIGIN, fromAda);
    const opened = await openInvitationHere(made.link, sendAs(null));
    expect(opened.signed.offer.for).toMatchObject({ kind: 'signer', name: 'Cleo', role: 'approver' });
    /* The service names the company a seat request through it is filed to, to the proof the link gives and to nothing less. */
    const filedTo = (acceptance: string) => sendAs(null)(`/api/invites/${made.id}/filed-to`, { method: 'POST', body: JSON.stringify({ acceptance }) });
    expect((await filedTo(acceptanceProofOf(opened.token))).body).toEqual({ company: { id: CO, label: LABEL, account: ADDRESS } });
    expect((await filedTo(acceptanceProofOf(newSigningKeypair().secret as Hex))).status).toBe(403);
    /*
     * RED WHEN: the invitee's device makes a seat, or asks its wallet, for an offer naming another account or label, or
     * another company, than the one its seat request is filed to: the leaf would commit to a key for that other company.
     */
    const invitation = store.invitationById(made.id)!;
    const acme = store.getAccount(CO)!;
    for (const [what, elsewhere] of [
      ['another company', () => store.putInvite({ ...invitation, accountId: OTHER })],
      ['another account', () => store.putAccount({ ...acme, contractAddress: 'ff'.repeat(32) })],
      ['another label', () => store.putAccount({ ...acme, companyLabel: OTHER_LABEL as never })],
    ] as const) {
      elsewhere();
      const madeHere: PendingSeat[] = [];
      const asked: unknown[] = [];
      try {
        await expect(acceptAsSignerHere(opened, SimulatedCommitments, {
          newKeys: newSeatKeys, seal: async (s) => { madeHere.push(s as PendingSeat); }, promote: async () => {},
        }, sendAs('cleo'), 'cleo', async (company) => { asked.push(company); return CLEOS_KEY; }), what)
          .rejects.toThrow(/names another company account or label than the company its seat request would be filed to/);
        expect([madeHere, asked], what).toEqual([[], []]);
      } finally {
        store.putInvite(invitation);
        store.putAccount(acme);
      }
    }
    expect(store.invitationById(made.id)!.acceptedAt).toBeUndefined();
    const kept: PendingSeat[] = [];
    const askedFor: unknown[] = [];
    const seat = await acceptAsSignerHere(opened, SimulatedCommitments, {
      newKeys: newSeatKeys, seal: async (s) => { kept.push(s as PendingSeat); }, promote: async () => {},
    }, sendAs('cleo'), 'cleo', async (company) => { askedFor.push(company); return CLEOS_KEY; });
    /* RED WHEN: the invitee's wallet is asked for its key for any company but the one the offer names. */
    expect(askedFor).toEqual([{ accountId: CO, label: LABEL, account: ADDRESS }]);
    /* RED WHEN: an invitee's leaf is made with a blinding that does not commit to the wallet key their wallet gave for the company. */
    const opening = kept[0]!.opening!;
    expect(kept[0]!.blinding).toBe(seatBlinding(CLEOS_KEY, opening.salt));
    /* RED WHEN: the inviter's seat - its wallet key, signed entry and opening - is not kept with the seat for the invitee's first records-key ask. */
    expect(kept[0]!.invitedBy).toEqual({ committeeKey: ADA.committeeKey, statement: ADA.statement, opening: ADA.opening });
    /* RED WHEN: who the seat is for is not kept with the seat, so the person's own directory entry could not carry it. */
    expect(kept[0]!.invited).toEqual((opened.signed.offer.for as { invited: unknown }).invited);
    expect(walletKeyProvedBy(opening, storedSignerLeaf(kept[0]!, SimulatedCommitments), (o) => SimulatedCommitments.signerLeaf(o.publicKey as Hex, o.blinding as Hex, o.scope as Hex)))
      .toEqual(CLEOS_KEY);
    const pending = store.getAccount(CO)!.pendingSigners.find((p) => p.id === seat.signerId)!;
    expect(pending.userId).toBe('cleo');
    /* The company's devices open it, and the proof of the keys holds for the name and role the offer gave. */
    const waiting = openFromInbox<PendingSignerPayload>(pending.sealed, CO, KEY);
    /* RED WHEN: the request is not sealed for the sign-in that accepted it, which every seating device holds it to. */
    expect(waiting).toMatchObject({ name: 'Cleo', role: 'approver', person: 'cleo' });
    expect(() => refuseASeatKeyNotFromTheInvitee(KEY, CO, waiting)).not.toThrow();
    /* RED WHEN: a seat request names another role than the one the invitation was proved for. */
    expect(() => refuseASeatKeyNotFromTheInvitee(KEY, CO, { ...waiting, role: 'admin' })).toThrow();
    /* RED WHEN: the keys are made somewhere other than the invitee's device, or the seat secret leaves it. */
    expect(kept).toHaveLength(1);
    const sent = wire.join('\n');
    for (const secret of [opened.token, (opened.signed.offer.for as { seat: { secret: string } }).seat.secret, 'Cleo']) expect(sent).not.toContain(secret);
    expect(store.invitationById(made.id)).toMatchObject({ acceptedAt: expect.any(String), subjectId: seat.signerId });
    /* RED WHEN: a signer invitation is accepted by somebody already on the company. */
    const again = await inviteHere(ACME, ADA, 'signer', { name: 'Ada again', role: 'admin', person: 'ada' }, ORIGIN, fromAda);
    await expect(acceptAsSignerHere(await openInvitationHere(again.link, sendAs(null)), SimulatedCommitments, {
      newKeys: newSeatKeys, seal: async () => {}, promote: async () => {},
    }, sendAs('ada'), 'ada', async () => CLEOS_KEY)).rejects.toMatchObject({ refused: 'already-on-this-account' });
    /* RED WHEN: a payee's invitation is accepted as a seat. */
    const payee = await inviteHere(ACME, ADA, 'employee', DANA, ORIGIN, fromAda);
    await expect(acceptAsSignerHere(await openInvitationHere(payee.link, sendAs(null)), SimulatedCommitments, {
      newKeys: newSeatKeys, seal: async () => {}, promote: async () => {},
    }, sendAs('zed'), 'zed', async () => CLEOS_KEY)).rejects.toThrow(/offers pay, not a seat/);
    /* RED WHEN: the service accepts a seat request against a payee's invitation. */
    expect((await sendAs('zed')(`/api/invites/${payee.id}/accept-signer`, { method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(tokenOfLink(payee.link)!), waiting: sealToInbox({}, ACME_INBOX) }) })).status).toBe(404);
  });

  it('A LINK OPENED UNDER ANOTHER SIGN-IN THAN THE PERSON INVITED MAKES NO SEAT AND SENDS NOTHING', async () => {
    const made = await inviteHere(ACME, ADA, 'signer', { name: 'Lou', role: 'approver', person: 'lou' }, ORIGIN, fromAda);
    const madeHere: PendingSeat[] = [];
    const asked: unknown[] = [];
    /* RED WHEN: somebody holding Lou's link makes a seat, or asks their wallet for a key, under their own sign-in. */
    await expect(acceptAsSignerHere(await openInvitationHere(made.link, sendAs(null)), SimulatedCommitments, {
      newKeys: newSeatKeys, seal: async (x) => { madeHere.push(x as PendingSeat); }, promote: async () => {},
    }, sendAs('mallory'), 'mallory', async (company) => { asked.push(company); return CLEOS_KEY; })).rejects.toThrow(/for somebody else/);
    expect([madeHere, asked]).toEqual([[], []]);
    expect(store.invitationById(made.id)!.acceptedAt).toBeUndefined();
  });

  it('A SIGNER\'S INVITATION IS KEPT FOR THE INVITING PERSON\'S OWN SEAT, WHATEVER ITS ROLE, AND A REFUSAL IS SAID IN THE SERVICE\'S WORDS', async () => {
    /* RED WHEN: the service judges a role: an approver's seat's signer invitation is refused there. */
    expect((await inviteHere(ACME, BO, 'signer', { name: 'Zed', role: 'admin', person: 'zed' }, ORIGIN, sendAs('bo'))).id).toMatch(/^[0-9a-f]{64}$/);
    /* RED WHEN: an invitation signed by one seat is kept in another person's session. */
    const refused = inviteHere(ACME, BO, 'signer', { name: 'Zed', role: 'admin', person: 'zed' }, ORIGIN, sendAs('ada'));
    await expect(refused).rejects.toMatchObject({ refused: 'no-entry', status: 403 });
    /* A screen tells a refusal the service gave apart from any other failure, and says the service's words. */
    await expect(refused).rejects.toBeInstanceOf(InvitationRefused);
    /* RED WHEN: a signer invitation is kept with no seat's signature. */
    let caught: { invitation: InvitationFiling } | null = null;
    await inviteHere(ACME, ADA, 'signer', { name: 'Zed', role: 'admin', person: 'zed' }, ORIGIN, async (_p, init) => { caught = JSON.parse(init.body!); return { status: 201, body: {} }; });
    const { filedBy: _f, ...unsigned } = caught!.invitation;
    expect((await fromAda(`/api/accounts/${CO}/invites`, { method: 'POST', body: JSON.stringify({ invitation: unsigned }) })).body).toMatchObject({ refused: 'not-signed' });
  });
});

describe('A CODE ENDS WHERE A LINK DOES: THE SAME PACKAGE, THE SAME SEAT REQUEST', () => {
  /* The keys one joiner's device makes, used for both ways in so the two seat requests can be compared. */
  const keysOf = (): NewSeatKeys => newSeatKeys(CLEOS_KEY);
  /** The key a joiner's wallet gives for a company. */
  const keyOf = (n: number, label: CompanyLabel = LABEL) => committeeKeyFor(identityFromSecret(new Uint8Array(32).fill(n)), label) as { tag: string; value: string };
  /** A joiner's wallet, signing the code it is asked for as the wallet's screen does at the press. */
  const walletOf = (n: number, person: string, label: CompanyLabel = LABEL) =>
    async (parts: SignerParts): Promise<JoinCode> => signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), label, person, parts);
  const opened = (pending: { sealed: { ephemeral: string; iv: string; tag: string; body: string } }) => openFromInbox<PendingSignerPayload>(pending.sealed, CO, KEY);
  const pendingOf = (id: string) => store.getAccount(CO)!.pendingSigners.find((p) => p.id === id)!;

  it('A SIGNER\'S CODE AND A SIGNER\'S LINK END IN THE SAME SEAT REQUEST, EACH WITH ITS OWN SPENT INVITATION', async () => {
    /* One wallet's keys, used both ways in, so the leaf's opening is the same in both requests. */
    const keys = newSeatKeys(keyOf(31));
    /* By link: Dee's device accepts and files the seat request. */
    const viaLink = await inviteHere(ACME, ADA, 'signer', { name: 'Dee', role: 'approver', person: 'dee' }, ORIGIN, fromAda);
    const linked = await acceptAsSignerHere(await openInvitationHere(viaLink.link, sendAs(null)), SimulatedCommitments, {
      newKeys: () => keys, seal: async () => {}, promote: async () => {},
    }, sendAs('dee'), 'dee', async () => keyOf(31));
    /* By code: Fen's device makes the same keys into a code her wallet signs; Ada pastes it. */
    const sealedForCode: unknown[] = [];
    const made = await makeSignerCodeHere(CO, SimulatedCommitments, { newKeys: () => keys, seal: async (x) => { sealedForCode.push(x); } }, walletOf(31, 'fen'), keyOf(31));
    /* RED WHEN: the keys of a code are not made and kept on the joiner's own device. */
    expect(sealedForCode).toHaveLength(1);
    const listedBefore = store.listInvites(CO).length;
    const added = await addSignerFromCodeHere(ACME, ADA, made.code, { name: 'Dee', role: 'approver' }, fromAda, LEAVES);
    const a = opened(pendingOf(linked.signerId!));
    const b = opened(pendingOf(added.id));
    /* RED WHEN: a code and a link end in seat requests that differ in anything but the invitation each was proved and signed under and the sign-in it was sealed for. */
    const { seatProof: proofA, person: personA, invited: invitedA, ...restA } = a;
    const { seatProof: proofB, person: personB, invited: invitedB, ...restB } = b;
    /* RED WHEN: a code's invitation does not name the leaf the code carries and the person its wallet signed for, so another leaf could be seated under it. */
    expect(invitedB!.terms).toMatchObject({ company: CO, person: 'fen', name: 'Dee', role: 'approver', leaf: b.leafCommitment.toLowerCase() });
    /* RED WHEN: a link's invitation names a leaf, or another person than the one it was made for. */
    expect(invitedA!.terms.leaf).toBeUndefined();
    expect(invitedA!.terms.person).toBe('dee');
    expect(restB).toEqual(restA);
    /* RED WHEN: either request is not sealed for the sign-in its seat request is filed under, so no device would seat it. */
    expect([personA, personB]).toEqual([pendingOf(linked.signerId!).userId, pendingOf(added.id).userId]);
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
    const gus = await makeSignerCodeHere(CO, SimulatedCommitments, { newKeys: newSeatKeys, seal: async () => {} }, walletOf(41, 'gus'), keyOf(41));
    const theirs = await makeSignerCodeHere(CO, SimulatedCommitments, { newKeys: newSeatKeys, seal: async () => {} }, walletOf(42, 'gus'), keyOf(42));
    const added = await addSignerFromCodeHere(ACME, ADA, theirs.code, { name: 'Gus', role: 'approver' }, fromAda, LEAVES);
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
    await expect(addSignerFromCodeHere(ACME, ADA, writeJoinCode({ ...code, parts: { ...(code.parts as SignerParts), signingPublicKey: '99'.repeat(32) } }), { name: 'Hal', role: 'approver' }, fromAda, LEAVES))
      .rejects.toThrow(/not signed by the wallet it names/);
    /* RED WHEN: a code made for another company is taken. */
    const other = await makeSignerCodeHere(OTHER, SimulatedCommitments, { newKeys: keysOf, seal: async () => {} }, walletOf(52, 'hal', OTHER_LABEL), keyOf(52, OTHER_LABEL));
    await expect(addSignerFromCodeHere(ACME, ADA, other.code, { name: 'Hal', role: 'approver' }, fromAda, LEAVES)).rejects.toThrow(/another company/);
    /* RED WHEN: a payee's code is taken as a signer's. */
    await expect(addSignerFromCodeHere(ACME, ADA, writeJoinCode(danasCode()), { name: 'Hal', role: 'approver' }, fromAda, LEAVES)).rejects.toBeInstanceOf(CodeNotTaken);
    /* RED WHEN: a refused code still files an invitation. */
    expect(store.listInvites(CO).length).toBe(before);
  });

  it('A CODE IS TAKEN ONLY WITH THE OPENING THAT MAKES ITS LEAF FOR THE WALLET THAT SIGNED IT', async () => {
    const mo = await makeSignerCodeHere(CO, SimulatedCommitments, { newKeys: newSeatKeys, seal: async () => {} }, walletOf(61, 'mo'), keyOf(61));
    const nan = await makeSignerCodeHere(CO, SimulatedCommitments, { newKeys: newSeatKeys, seal: async () => {} }, walletOf(62, 'nan'), keyOf(62));
    const code = (text: string) => readJoinCode(text, LABEL) as JoinCode;
    const before = store.listInvites(CO).length;
    const { opening: _none, ...bare } = code(mo.code);
    /* RED WHEN: a code with no opening is taken, so no approving device could see whose wallet its leaf is made for. */
    await expect(addSignerFromCodeHere(ACME, ADA, writeJoinCode(bare as JoinCode), { name: 'Mo', role: 'approver' }, fromAda, LEAVES)).rejects.toThrow(/does not show that its seat is made for the wallet that signed it/);
    /* RED WHEN: a code is taken on an opening of another wallet's leaf. */
    await expect(addSignerFromCodeHere(ACME, ADA, writeJoinCode({ ...code(mo.code), opening: code(nan.code).opening }), { name: 'Mo', role: 'approver' }, fromAda, LEAVES)).rejects.toBeInstanceOf(CodeNotTaken);
    /* RED WHEN: a code is taken on an opening that makes its leaf for another wallet than the one that signed it. */
    const forNan = makeSignerCodeHere(CO, SimulatedCommitments, { newKeys: newSeatKeys, seal: async () => {} }, walletOf(61, 'mo'), keyOf(62));
    await expect(addSignerFromCodeHere(ACME, ADA, (await forNan).code, { name: 'Mo', role: 'approver' }, fromAda, LEAVES)).rejects.toThrow(/does not show that its seat is made for the wallet that signed it/);
    /* RED WHEN: a refused code still files an invitation. */
    expect(store.listInvites(CO).length).toBe(before);
    /* RED WHEN: a payee's code carrying an opening is read as a code at all. */
    expect(readJoinCode(writeJoinCode({ ...danasCode(), opening: code(mo.code).opening }), LABEL)).toBe('not-a-code');
  });

  it('ONLY THE SEAT THAT MADE THE INVITATION FILES A SEAT REQUEST FOR SOMEBODY ELSE', async () => {
    const made = await inviteHere(ACME, ADA, 'signer', { name: 'Ivy', role: 'approver', person: 'ivy' }, ORIGIN, fromAda);
    const token = tokenOfLink(made.link)!;
    const body = (forWhom: string) => JSON.stringify({ acceptance: acceptanceProofOf(token), waiting: sealToInbox({}, ACME_INBOX), for: forWhom });
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
    /* RED WHEN: the seat that made it files for somebody else while the chain no longer holds its seat, read against the chain now. */
    store.putInvite({ ...store.invitationById(made.id)!, createdBy: 'ada' });
    const now = chains.get(CO)!;
    chains.set(CO, { ...now, seats: { ...now.seats, seats: now.seats.seats.filter((x) => x !== ADA.seat) } });
    try {
      expect((await fromAda(`/api/invites/${made.id}/accept-signer`, { method: 'POST', body: body('jo') })).body).toMatchObject({ refused: 'not-yours-to-accept-for' });
    } finally {
      chains.set(CO, now);
    }
    /* RED WHEN: the seat that made it is found by its person alone, not by the filing key it made the invitation under. */
    store.putInvite({ ...store.invitationById(made.id)!, createdByKey: 'ab'.repeat(32) as Hex });
    expect((await fromAda(`/api/invites/${made.id}/accept-signer`, { method: 'POST', body: body('jo') })).body).toMatchObject({ refused: 'not-yours-to-accept-for' });
    expect(store.invitationById(made.id)!.acceptedAt).toBeUndefined();
  });

  it('A PAYEE\'S CODE AND A PAYEE\'S LINK HAND OVER THE SAME PACKAGE', async () => {
    const code = danasCode(LABEL, 'dana');
    /* By code: Ada pastes Dana's code. */
    const added = await addPayeeFromCodeHere(ACME, ADA, writeJoinCode(code), DANA, fromAda);
    /* By link: Dana's device accepts with the same code. */
    const made = await inviteHere(ACME, ADA, 'employee', DANA, ORIGIN, fromAda);
    const linked = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs('dana'));
    /* RED WHEN: the two ways hand over different packages. */
    const byCode = openFromInbox<JoinCode>(store.handoverFor(added.person, 'employee')!, CO, KEY);
    const byLink = openFromInbox<JoinCode>(store.handoverFor(made.person!, 'employee')!, CO, KEY);
    expect(byCode).toEqual(code);
    expect(byLink).toEqual(code);
    expect(added.fingerprint).toBe(linked.fingerprint);
    /* RED WHEN: a payee added from a code is not on the payroll as a person record, waiting to be admitted. */
    expect(await peopleRecords.companyOfPerson(added.person)).toBe(CO);
    expect((await newestPerson(added.person))!.facts!.status).toBe('pending');
  });
});

describe('AN INVITATION ACROSS A CHANGE OF THE COMPANY\'S KEY', () => {
  /* The company's keys on Ada's device once its key has changed to epoch 1. */
  const KEY1 = newSymmetricKey() as Hex;
  const keysAt1: CompanyKeys = {
    epoch: 1, key: KEY1, newest: 1, keyAt: (e) => (e === 0 ? KEY : KEY1), sealing: () => ({ key: KEY1, epoch: 1 }), answered: new Map(),
  };
  const paused: CompanyKeys = { ...keysAt1, sealing: () => { throw new CompanyKeyBeingChanged('the company\'s key is being changed'); } };
  /** The service holding a change of the company's key a seated signer filed at a huge epoch, for as long as `run` takes. */
  const withAHugeChangeOfKey = async (run: () => Promise<void>) => {
    const real = store.directoryFilingsOf.bind(store);
    store.directoryFilingsOf = (id: string) => [...real(id), { company: id, version: real(id).length + 1, change: { kind: 'rotate', epoch: Number.MAX_SAFE_INTEGER } } as never];
    try { await run(); } finally { store.directoryFilingsOf = real; }
  };

  it('an invitation names the inbox and key epoch of the key in force on this device, and none while that key is being changed', async () => {
    const made = await inviteHere({ ...ACME, viewingKey: keysAt1 }, ADA, 'signer', { name: 'Ivy', role: 'approver', person: 'ivy' }, ORIGIN, fromAda);
    const opened = await openInvitationHere(made.link, sendAs(null));
    /* RED WHEN: the offer names an inbox other than the one the key in force makes, so a removed signer could read the answer. */
    expect(opened.signed.offer.inboxPublicKey).toBe(inboxPublicKey(KEY1, CO));
    /* RED WHEN: the seat's secret is made under an older key than the inbox the answer is sealed to. */
    const seat = (opened.signed.offer.for as { seat: { nonce: Hex; secret: Hex } }).seat;
    expect(seat.secret).toBe(invitationSecret(KEY1, CO, seat.nonce, 'Ivy', 'approver'));
    /* RED WHEN: the invitation's key epoch is not signed into its filing and kept with it. */
    expect(store.invitationById(made.id)!.keyEpoch).toBe(1);
    /* RED WHEN: an invitation is made while the company's key is being changed, naming an inbox the leaver holds. */
    await expect(inviteHere({ ...ACME, viewingKey: paused }, ADA, 'signer', { name: 'Jo', role: 'approver', person: 'jo' }, ORIGIN, fromAda)).rejects.toThrow(CompanyKeyBeingChanged);
    await expect(inviteHere({ ...ACME, viewingKey: paused }, ADA, 'employee', DANA, ORIGIN, fromAda)).rejects.toThrow(CompanyKeyBeingChanged);
  });

  it('a huge-epoch change filed by a seated signer refuses no invitation or answer at the service; the device still refuses an answer to an old invitation', async () => {
    const payee = await inviteHere(ACME, ADA, 'employee', { ...DANA, email: 'kai@acme.co', name: 'Kai' }, ORIGIN, fromAda);
    const payeeOpened = await openInvitationHere(payee.link, sendAs(null));
    const signer = await inviteHere(ACME, ADA, 'signer', { name: 'Lu', role: 'approver', person: 'lu' }, ORIGIN, fromAda);
    const waiting = sealToInbox({}, ACME_INBOX);
    await withAHugeChangeOfKey(async () => {
      /* RED WHEN: the service reads the company's key from a filing no device believes, so one signer stops every invitation. */
      await expect(inviteHere(ACME, ADA, 'employee', { ...DANA, email: 'mo@acme.co', name: 'Mo' }, ORIGIN, fromAda)).resolves.toMatchObject({ id: expect.any(String) });
      await expect(inviteHere(ACME, ADA, 'signer', { name: 'Nia', role: 'approver', person: 'nia' }, ORIGIN, fromAda)).resolves.toMatchObject({ id: expect.any(String) });
      /* RED WHEN: the service refuses a payee's answer or a seat request because of that filing. */
      await expect(acceptAsPayeeHere(payeeOpened, danasCode(), sendAs('kai'))).resolves.toBeDefined();
      expect(store.handoverFor(payee.person!, 'employee') ?? null).not.toBeNull();
      const r = await sendAs('lu')(`/api/invites/${signer.id}/accept-signer`, { method: 'POST', body: JSON.stringify({
        acceptance: acceptanceProofOf(tokenOfLink(signer.link)!), waiting }) });
      expect(r.status).toBe(201);
    });
    /* RED WHEN: a device that holds a newer key takes an answer sealed to the older inbox that no change of the key named as waiting. */
    expect(() => answerOpenedWith(keysAt1, waiting, CO)).toThrow(AnswerToAnOldInvitation);
    /* The control: the same answer, named as waiting by the change of the key, is taken. */
    const named: CompanyKeys = { ...keysAt1, answered: new Map([[0, new Set([answerDigestOf(waiting)])]]) };
    expect(answerOpenedWith(named, waiting, CO).epoch).toBe(0);
  });

  it('an offer past the expiry its inviter signed is refused on the invitee\'s device, whatever the service says', async () => {
    const token = newInvitationToken();
    const offer = (expiresAt: number) => ({
      company: CO, companyName: 'Acme', label: LABEL, account: ADDRESS, inboxPublicKey: ACME_INBOX, expiresAt,
      for: { kind: 'employee' as const, person: 'emp_y', name: 'Y', title: 'T', email: null, asset: 'TEST', baseAmount: 1n, startDate: '2026-10-01' },
      inviter: { committeeKey: ADA.committeeKey, statement: ADA.statement, opening: ADA.opening },
    });
    const served = (expiresAt: number): InvitationSend => async () => ({ status: 200, body: {
      kind: 'employee', offer: sealOffer(signOffer(offer(expiresAt), ADA.signingSecret), token), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } });
    const link = invitationLink(ORIGIN, token);
    await expect(openInvitationHere(link, served(Date.now() + 60_000))).resolves.toMatchObject({ token });
    /* RED WHEN: an offer past the expiry its inviter signed is opened because the service says it is still open. */
    await expect(openInvitationHere(link, served(Date.now() - 1))).rejects.toThrow(/has expired/u);
    /* RED WHEN: an offer that says nothing of when it expires is opened. */
    expect(() => openOffer(sealOffer(signOffer({ ...offer(0) }, ADA.signingSecret), token), token)).toThrow(/until when it may be answered/u);
    /* RED WHEN: an offer opened before its expiry is still answered after it. */
    const opened = { token, signed: signOffer(offer(Date.now() - 1), ADA.signingSecret), expiresAt: '', kind: 'employee' as const };
    let sent = 0;
    await expect(acceptAsPayeeHere(opened, danasCode(), async () => { sent += 1; return { status: 201, body: {} }; })).rejects.toThrow(/has expired/u);
    const invited = signSeatInvitation({ company: CO, invitation: invitationIdOf(token), person: 'ivy', name: 'Ivy', role: 'approver' }, ADA.signingSecret as Hex);
    const seatOffer = { ...offer(Date.now() - 1), for: { kind: 'signer' as const, name: 'Ivy', role: 'approver' as const, seat: { nonce: '01'.repeat(32), secret: '02'.repeat(32) }, invited } };
    /* RED WHEN: a seat offer opened before its expiry is still answered after it. */
    await expect(acceptAsSignerHere({ token, signed: signOffer(seatOffer as never, ADA.signingSecret), expiresAt: '', kind: 'signer' }, {} as never, {} as never,
      async () => { sent += 1; return { status: 200, body: {} }; }, 'ivy', async () => { throw new Error('the wallet was asked'); })).rejects.toThrow(/has expired/u);
    expect(sent).toBe(0);
  });
});

describe('ONE INVITATION SYSTEM FOR FOUR KINDS: AN EMPLOYEE, A VENDOR, A SIGNER AND A SUPER ADMIN', () => {
  const VERAS_ADDRESS = payeeFor('5a'.repeat(32), theNetwork()).bech32;
  /* What a vendor's offer says; the invitation is made with their payment terms and network besides, which stay out of it. */
  const VERA = { name: 'Vera Vendorson', email: 'vera@vendors.co', startDate: '2026-11-05', endDate: '2027-02-28', address: VERAS_ADDRESS };
  const VERA_ADDED = { ...VERA, terms: { kind: 'monthly' as const, asset: TEST_SETTLEMENT_ASSET, amount: 70000n }, network: theNetwork() };
  /*
   * A company whose vendors, as the adding device reads them, hold no address yet: this file adds Vera at one address
   * several times to read what each offer carries, never to pay her. One vendor entry per address is the vendor
   * list's own rule, tested where vendors are paid (a-vendor-is-kept-on-the-vendor-list.test.ts).
   */
  const NO_VENDOR_HELD = { vendors: async () => ({ vendors: [], notPayable: [] }) };
  const SPECS: InviteSpecs = {
    employee: { ...DANA, name: 'Emil Termson', email: 'emil@acme.co', classification: 'part-time' as const, startDate: '2026-11-05', endDate: '2027-02-28', address: 'mn_shield-addr_test1emilsaddress' },
    vendor: VERA_ADDED,
    signer: { name: 'Sid Signerson', role: 'approver' as const, person: 'sid' },
    'super-admin': { name: 'Sue Committeeson', address: 'mn_shield-addr_test1suesaddress' },
  };
  const filedPaths: string[] = [];
  const recordingFromAda: InvitationSend = async (path, init) => { filedPaths.push(`${init.method} ${path}`); return fromAda(path, init); };

  it('an employee, a vendor and a signer are filed on the one route, kept as their kind, and open as that kind with the moment it was made', async () => {
    filedPaths.length = 0;
    for (const kind of ['employee', 'vendor', 'signer'] as const) {
      const before = Date.now();
      const made = await inviteHere(ACME, ADA, kind, SPECS[kind] as never, ORIGIN, recordingFromAda, (kind === 'vendor' ? NO_VENDOR_HELD : undefined) as never);
      /* RED WHEN: a kind is kept as another kind, or not kept. */
      expect(store.invitationById(made.id), kind).toMatchObject({ kind, accountId: CO });
      const opened = await openInvitationHere(made.link, sendAs(null));
      /* RED WHEN: the invitee's device is not told which kind it opened. */
      expect(opened.kind, kind).toBe(kind);
      /* RED WHEN: an offer does not carry, signed inside it, the moment it was made, so a timeline would rest on the service's clock. */
      expect(isUtcMoment(opened.signed.offer.madeAt), kind).toBe(true);
      expect(Date.parse(opened.signed.offer.madeAt!)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      if (kind === 'vendor') {
        /* RED WHEN: a vendor entry's id is not drawn like an employee's, or the service is not told which entry it is for. */
        expect(made.person).toMatch(/^ven_[0-9a-f]{20}$/u);
        expect(store.invitationById(made.id)!.subjectId).toBe(made.person);
        expect(opened.signed.offer.for).toMatchObject({ kind: 'vendor', person: made.person, ...VERA });
        /* RED WHEN: a vendor's payment terms travel in the offer the vendor opens, beside what they are invited as. */
        expect(Object.keys(opened.signed.offer.for)).not.toContain('terms');
      }
      if (kind === 'employee') expect(opened.signed.offer.for).toMatchObject({ classification: 'part-time', endDate: '2027-02-28', address: SPECS.employee.address });
    }
    /* RED WHEN: a kind is filed on a route of its own instead of the one invitation route. */
    expect(filedPaths).toEqual(Array(3).fill(`POST /api/accounts/${CO}/invites`));
  });

  it('a super admin\'s invitation is defined but made by no seat: refused on the inviting device and at the route', async () => {
    filedPaths.length = 0;
    /* RED WHEN: a signer's seat makes a super admin's invitation, so the super admins' system would read the signers. */
    await expect(inviteHere(ACME, ADA, 'super-admin', SPECS['super-admin'], ORIGIN, recordingFromAda))
      .rejects.toThrow(/invited by the company's super admins under the committee's own rules/u);
    expect(filedPaths).toEqual([]);
    /* RED WHEN: the service keeps a super admin's invitation a seat signed. */
    let caught: { invitation: InvitationFiling } | null = null;
    await inviteHere(ACME, ADA, 'signer', SPECS.signer, ORIGIN, async (_p, init) => { caught = JSON.parse(init.body!); return { status: 201, body: {} }; });
    const { filedBy: _f, ...unsigned } = caught!.invitation;
    const asSuperAdmin = signInvitationFiling({ ...unsigned, kind: 'super-admin' }, ADA.signingSecret);
    expect((await fromAda(`/api/accounts/${CO}/invites`, { method: 'POST', body: JSON.stringify({ invitation: asSuperAdmin }) })).body)
      .toMatchObject({ refused: 'super-admin-by-the-committee', error: expect.stringMatching(/under the committee's own rules/u) });
    expect(store.invitationById(asSuperAdmin.id)).toBeNull();
  });

  it('a seat whose role may not invite invites nobody of any kind, refused on its device before anything is signed or sent', async () => {
    let sent = 0;
    const counting: InvitationSend = async (path, init) => { sent += 1; return sendAs('bo')(path, init); };
    const viewer = { ...BO, held: { role: 'viewer' as const, retired: false } };
    /* RED WHEN: a viewer's device makes a vendor's or an employee's invitation. */
    await expect(inviteHere(ACME, viewer, 'vendor', VERA_ADDED, ORIGIN, counting, NO_VENDOR_HELD)).rejects.toThrow(SeatMayNotInvite);
    await expect(inviteHere(ACME, viewer, 'employee', DANA, ORIGIN, counting)).rejects.toThrow(SeatMayNotInvite);
    expect(sent).toBe(0);
  });

  it('employees and vendors are kept apart by kind: each files its own kind of id, and hands over only as its own kind', async () => {
    /* RED WHEN: an employee's invitation is filed under a vendor's id, so the two lists could share a person. */
    let caught: { person: unknown; invitation: InvitationFiling } | null = null;
    await inviteHere(ACME, { ...ADA, entered: enteredHere() }, 'employee', DANA, ORIGIN, async (_p, init) => { caught = JSON.parse(init.body!); return { status: 201, body: {} }; });
    const { filedBy: _f, ...unsigned } = caught!.invitation;
    const asVendorsId = signInvitationFiling({ ...unsigned, person: 'ven_' + '0b'.repeat(10) }, ADA.signingSecret);
    expect((await fromAda(`/api/accounts/${CO}/invites`, { method: 'POST', body: JSON.stringify({ person: caught!.person, invitation: asVendorsId }) })).body)
      .toMatchObject({ refused: 'not-an-invitation', error: expect.stringMatching(/names an employee's id/u) });
    /* RED WHEN: a device makes an employee's offer under a vendor's id. */
    const offer = { company: CO, companyName: 'Acme', label: LABEL, account: ADDRESS, inboxPublicKey: ACME_INBOX, expiresAt: Date.now() + 3_600_000,
      madeAt: '2026-06-20T15:00:00Z', inviter: { committeeKey: ADA.committeeKey, statement: ADA.statement, opening: ADA.opening },
      for: { kind: 'employee' as const, person: 'ven_' + '0c'.repeat(10), name: 'E', title: 'T', email: null, asset: 'TEST', baseAmount: 1n, startDate: '2026-10-01', classification: 'full-time' as const } };
    expect(whyThisOfferCannotBeMade(offer)).toMatch(/names an employee's id/u);
    expect(whyThisOfferCannotBeMade({ ...offer, for: { ...offer.for, person: 'emp_' + '0c'.repeat(10) } })).toBeNull();
    /* RED WHEN: a vendor accepts as an employee. */
    const vendor = await inviteHere(ACME, ADA, 'vendor', { ...VERA_ADDED, email: 'v3@vendors.co' }, ORIGIN, fromAda, NO_VENDOR_HELD);
    const opened = await openInvitationHere(vendor.link, sendAs(null));
    const asEmployee = await sendAs('dana')(`/api/invites/${vendor.id}/accept-payee`, { method: 'POST', body: JSON.stringify({
      acceptance: acceptanceProofOf(opened.token), handover: payeeHandoverOf(danasCode(), opened.signed.offer.inboxPublicKey), kind: 'employee' }) });
    expect(asEmployee).toMatchObject({ status: 404, body: { refused: 'not-found' } });
    await acceptAsPayeeHere(opened, danasCode(), sendAs('dana'));
    /* RED WHEN: a vendor's hand-over is read as an employee's. */
    expect(store.handoverFor(vendor.person!, 'vendor')).not.toBeNull();
    expect(store.handoverFor(vendor.person!, 'employee')).toBeNull();
  });

  it('the service is told the kind and nothing of the person: no name, date, address or classification crosses in the clear', async () => {
    wire.length = 0;
    for (const kind of ['employee', 'vendor', 'signer'] as const) await inviteHere(ACME, ADA, kind, SPECS[kind] as never, ORIGIN, fromAda, (kind === 'vendor' ? NO_VENDOR_HELD : undefined) as never);
    const sent = wire.join('\n');
    const held = canonical(store.snapshot());
    /* RED WHEN: anything the person was offered reaches the service in a request body or what it keeps. */
    for (const said of ['Emil Termson', 'Vera Vendorson', 'Sid Signerson', 'vera@vendors.co', 'emil@acme.co', '2026-11-05', '2027-02-28',
      VERAS_ADDRESS.slice(-24), 'test1emilsaddress', 'part-time', 'classification', 'endDate', 'madeAt', 'terms', 'monthly']) {
      expect(sent, said).not.toContain(said);
      expect(held, said).not.toContain(said);
    }
  });

  it('an old employee offer without a classification, an end date, an address or the moment it was made still opens', async () => {
    const token = newInvitationToken();
    const old = { company: CO, companyName: 'Acme', label: LABEL, account: ADDRESS, inboxPublicKey: ACME_INBOX, expiresAt: Date.now() + 3_600_000,
      for: { kind: 'employee' as const, person: 'emp_old', name: 'Olga', title: 'T', email: null, asset: 'TEST', baseAmount: 1n, startDate: '2026-10-01' },
      inviter: { committeeKey: ADA.committeeKey, statement: ADA.statement, opening: ADA.opening } };
    const served: InvitationSend = async () => ({ status: 200, body: {
      kind: 'employee', offer: sealOffer(signOffer(old, ADA.signingSecret), token), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } });
    /* RED WHEN: an offer made before the classification, the end date, the address or the moment it was made existed is refused. */
    await expect(openInvitationHere(invitationLink(ORIGIN, token), served)).resolves.toMatchObject({ kind: 'employee', signed: { offer: { for: { name: 'Olga' } } } });
    /* RED WHEN: a moment that is not one UTC moment is believed. */
    expect(() => openOffer(sealOffer(signOffer({ ...old, madeAt: '2026-06-20 15:00' }, ADA.signingSecret), token), token)).toThrow(/not one UTC moment/u);
    /* RED WHEN: an offer of a kind no device knows is opened. */
    expect(() => openOffer(sealOffer(signOffer({ ...old, for: { kind: 'contractor', name: 'C' } as never }, ADA.signingSecret), token), token))
      .toThrow(/none of the four kinds of invitation/u);
  });

  it('what no invitation may offer is refused on the inviting device before anything is sent, and on the invitee\'s device when opened', async () => {
    let sent = 0;
    const counting: InvitationSend = async (path, init) => { sent += 1; return fromAda(path, init); };
    const notMade = (kind: 'employee' | 'vendor', spec: object) => inviteHere(ACME, ADA, kind, spec as never, ORIGIN, counting, (kind === 'vendor' ? NO_VENDOR_HELD : undefined) as never);
    /* RED WHEN: a vendor's invitation carries a salary. */
    await expect(notMade('vendor', { ...VERA_ADDED, baseAmount: 5n })).rejects.toThrow(InvitationNotMade);
    await expect(notMade('vendor', { ...VERA_ADDED, baseAmount: 5n })).rejects.toThrow(/carries no salary/u);
    /* RED WHEN: a vendor's invitation carries a full-time or part-time classification. */
    await expect(notMade('vendor', { ...VERA_ADDED, classification: 'full-time' })).rejects.toThrow(/no full-time or part-time classification/u);
    /* RED WHEN: a contractor is invited as an employee. */
    await expect(notMade('employee', { ...SPECS.employee, classification: 'contractor' })).rejects.toThrow(/a contractor is added as a vendor/u);
    /* RED WHEN: a new employee is invited as neither full-time nor part-time. */
    const { classification: _c, ...unclassified } = SPECS.employee;
    await expect(notMade('employee', unclassified)).rejects.toThrow(/full-time or part-time: choose one/u);
    /* RED WHEN: an end date before the start date is taken, for an employee or a vendor. */
    await expect(notMade('employee', { ...SPECS.employee, endDate: '2026-11-04' })).rejects.toThrow(/end date is before its start date/u);
    await expect(notMade('vendor', { ...VERA_ADDED, endDate: '2026-11-04' })).rejects.toThrow(/end date is before its start date/u);
    /* RED WHEN: a date that is not a calendar date is taken. */
    await expect(notMade('vendor', { ...VERA_ADDED, startDate: '2026-13-01' })).rejects.toThrow(/start date is not a calendar date/u);
    await expect(notMade('employee', { ...SPECS.employee, endDate: '28/02/2027' })).rejects.toThrow(/end date is not a calendar date/u);
    expect(sent).toBe(0);
    /* RED WHEN: the invitee's device opens a vendor's offer with a salary that a device other than this one signed. */
    const token = newInvitationToken();
    const base = { company: CO, companyName: 'Acme', label: LABEL, account: ADDRESS, inboxPublicKey: ACME_INBOX, expiresAt: Date.now() + 3_600_000,
      madeAt: '2026-06-20T15:00:00Z', inviter: { committeeKey: ADA.committeeKey, statement: ADA.statement, opening: ADA.opening } };
    const opening = (forWhom: object) => () => openOffer(sealOffer(signOffer({ ...base, for: forWhom as never }, ADA.signingSecret), token), token);
    const vendor = { kind: 'vendor', person: 'ven_' + '0a'.repeat(10), name: 'V', email: null, startDate: '2026-11-05' };
    expect(opening(vendor)().offer.madeAt).toBe('2026-06-20T15:00:00Z');
    expect(opening({ ...vendor, baseAmount: 5n })).toThrow(/carries no salary/u);
    expect(opening({ ...vendor, classification: 'part-time' })).toThrow(/no full-time or part-time classification/u);
    expect(opening({ ...vendor, endDate: '2026-11-01' })).toThrow(/end date is before its start date/u);
    /* RED WHEN: the service keeps an invitation of a kind that is none of the four. */
    let caught: { invitation: InvitationFiling } | null = null;
    await inviteHere(ACME, { ...ADA, entered: enteredHere() }, 'vendor', VERA_ADDED, ORIGIN, async (_p, init) => { caught = JSON.parse(init.body!); return { status: 201, body: {} }; }, NO_VENDOR_HELD);
    const { filedBy: _f, ...unsigned } = caught!.invitation;
    const odd = signInvitationFiling({ ...unsigned, kind: 'contractor' as never }, ADA.signingSecret);
    expect((await fromAda(`/api/accounts/${CO}/invites`, { method: 'POST', body: JSON.stringify({ invitation: odd }) })).body)
      .toMatchObject({ refused: 'not-an-invitation', error: expect.stringMatching(/none of the four kinds of invitation/u) });
    /* RED WHEN: a vendor's invitation is kept without the first version of their vendor entry beside it. */
    expect((await fromAda(`/api/accounts/${CO}/invites`, { method: 'POST', body: JSON.stringify({ invitation: caught!.invitation }) })).body)
      .toMatchObject({ refused: 'not-a-new-person', error: expect.stringMatching(/first version of the person or vendor entry it is for/u) });
  });

  it('a vendor accepts on the payee path with their own hand-over, and a super admin\'s invitation is opened but never accepted here', async () => {
    const vendor = await inviteHere(ACME, ADA, 'vendor', { ...VERA_ADDED, email: 'v2@vendors.co' }, ORIGIN, fromAda, NO_VENDOR_HELD);
    /* RED WHEN: a vendor cannot accept on the route an employee accepts on. */
    await expect(acceptAsPayeeHere(await openInvitationHere(vendor.link, sendAs(null)), danasCode(), sendAs('dana'))).resolves.toMatchObject({ fingerprint: expect.any(String) });
    expect(store.invitationById(vendor.id)).toMatchObject({ kind: 'vendor', subjectId: vendor.person, acceptedAt: expect.any(String) });
    /* A super admin's offer, as a device that made one would sign it; no seat makes one, so it is served here. */
    const token = newInvitationToken();
    const offer = { company: CO, companyName: 'Acme', label: LABEL, account: ADDRESS, inboxPublicKey: ACME_INBOX, expiresAt: Date.now() + 3_600_000,
      madeAt: '2026-06-20T15:00:00Z', for: { kind: 'super-admin' as const, name: 'Sue Committeeson' },
      inviter: { committeeKey: ADA.committeeKey, statement: ADA.statement, opening: ADA.opening } };
    const served: InvitationSend = async () => ({ status: 200, body: {
      kind: 'super-admin', offer: sealOffer(signOffer(offer, ADA.signingSecret), token), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } });
    const opened = await openInvitationHere(invitationLink(ORIGIN, token), served);
    /* RED WHEN: the invitee's device does not open a super admin's offer as one. */
    expect(opened.kind).toBe('super-admin');
    let sent = 0;
    const counting: InvitationSend = async () => { sent += 1; return { status: 201, body: { id: 'sgn_x' } }; };
    /* RED WHEN: a super admin's invitation is accepted as pay or as a seat, instead of joining under the committee's own rules. */
    await expect(acceptAsPayeeHere(opened, danasCode(), counting)).rejects.toThrow(/joins under the committee's own rules/u);
    await expect(acceptAsSignerHere(opened, SimulatedCommitments, {} as never, counting, 'sue', async () => { throw new Error('the wallet was asked'); }))
      .rejects.toThrow(/joins under the committee's own rules/u);
    expect(sent).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { randomBytes, toHex, type Hex } from './crypto.js';
import { newSeatInvitation, proveSeatKeys, refuseASeatKeyNotFromTheInvitee, SeatKeyNotFromTheInvitee } from './seat-invite-proof.js';

/*
 * A waiting signer's request carries a proof made with the invitation's secret. The proof covers the keys sent, the
 * sign-in the request is sealed for and the invitation it answers, so a proof made for one person or one invitation
 * seats nobody under another.
 */
const COMPANY = 'co_proved';
const companyKey = toHex(randomBytes(32)) as Hex;
const hex = (): Hex => toHex(randomBytes(32)) as Hex;
const keys = { signingPublicKey: hex(), wrappingPublicKey: hex(), leafCommitment: hex() };
const invitationId = hex();
const invitation = newSeatInvitation(companyKey, COMPANY, 'Dana', 'approver', invitationId);
const proof = proveSeatKeys(invitation, keys, { person: 'usr_dana', invitationId });
const requestOf = (o: { person?: unknown; invitationId?: unknown; invited?: unknown } = {}) => ({
  name: 'Dana', role: 'approver', ...keys, seatProof: proof,
  person: 'person' in o ? o.person : 'usr_dana',
  invited: 'invited' in o ? o.invited : { terms: { invitation: 'invitationId' in o ? o.invitationId : invitationId } },
});

describe('a seat proof holds only for the person and the invitation it was made for', () => {
  it('a request for the person and the invitation the proof names is believed', () => {
    expect(() => refuseASeatKeyNotFromTheInvitee(companyKey, COMPANY, requestOf())).not.toThrow();
    expect(() => refuseASeatKeyNotFromTheInvitee(companyKey, COMPANY, requestOf({ invitationId: invitationId.toUpperCase() }))).not.toThrow();
  });

  it('a seat proof made for another person is refused', () => {
    /* RED WHEN: a proof made for one sign-in seats a request sealed for another. */
    expect(() => refuseASeatKeyNotFromTheInvitee(companyKey, COMPANY, requestOf({ person: 'usr_mallory' }))).toThrow(SeatKeyNotFromTheInvitee);
  });

  it('a seat proof made under another invitation is refused', () => {
    /* RED WHEN: a proof made for one invitation seats a request carrying another invitation's terms. */
    expect(() => refuseASeatKeyNotFromTheInvitee(companyKey, COMPANY, requestOf({ invitationId: hex() }))).toThrow(SeatKeyNotFromTheInvitee);
  });

  it('the secret of one invitation makes no proof under another invitation with the same name and role', () => {
    const other = hex();
    const madeUnderOther = proveSeatKeys(invitation, keys, { person: 'usr_dana', invitationId: other });
    /* RED WHEN: whoever holds one invitation's secret proves keys under another invitation for the same name and role. */
    expect(() => refuseASeatKeyNotFromTheInvitee(companyKey, COMPANY, { ...requestOf({ invitationId: other }), seatProof: madeUnderOther }))
      .toThrow(SeatKeyNotFromTheInvitee);
  });

  it('a request naming no person or no invitation is refused, never believed on its keys alone', () => {
    /* RED WHEN: a request that leaves out who it is for, or the invitation behind it, is seated. */
    for (const missing of [{ person: undefined }, { person: '' }, { person: 7 }, { invited: undefined }, { invitationId: 'not-an-id' }]) {
      expect(() => refuseASeatKeyNotFromTheInvitee(companyKey, COMPANY, requestOf(missing)), JSON.stringify(missing)).toThrow(SeatKeyNotFromTheInvitee);
    }
    /* Even a proof made over an empty sign-in does not seat a request that names none. */
    const overNobody = proveSeatKeys(invitation, keys, { person: '', invitationId });
    expect(() => refuseASeatKeyNotFromTheInvitee(companyKey, COMPANY, { ...requestOf({ person: undefined }), seatProof: overNobody }))
      .toThrow(SeatKeyNotFromTheInvitee);
  });
});

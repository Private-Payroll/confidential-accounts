import { describe, expect, it } from 'vitest';
import { newSigningKeypair, toHex, type Hex } from './crypto.js';
import { invitationProposalSalt, seatInvitationRefusal, signSeatInvitation, type SeatInvitationTerms } from './invitation.js';
import { ALL_VAULTS, COMPANY_WIDE, scopeOfRole } from './seat-rights.js';

const ADA = newSigningKeypair();
const hex = (n: number): Hex => toHex(Uint8Array.from({ length: 32 }, () => n));
const VAULT = hex(9);

const byAddress = (role: string, scope: Hex, vaults?: readonly Hex[]): SeatInvitationTerms => ({
  company: 'co_1', invitation: hex(1), person: 'adr_1', name: 'Bo', role: role as SeatInvitationTerms['role'],
  ...(vaults === undefined ? {} : { vaults }), invite: { address: hex(2), salt: hex(3), scope },
});

describe('a signer is invited by address only at the rights of their role', () => {
  it('an approver offered every right is refused when the invitation is signed and wherever it is read', () => {
    /* RED WHEN: an approver invited at allVaults() is seated holding every right on the chain. */
    /* RED WHEN: the refusal does not say why, and what clears it. */
    expect(() => signSeatInvitation(byAddress('approver', ALL_VAULTS), ADA.secret))
      .toThrow(/not a seat invitation this device can sign, so the invitation was not made: .*invite the person again at the rights of their role/u);
    const forged = { ...signSeatInvitation(byAddress('approver', scopeOfRole('approver')), ADA.secret) };
    expect(seatInvitationRefusal({ ...forged, terms: { ...forged.terms, invite: { ...forged.terms.invite!, scope: ALL_VAULTS } } }))
      .toMatch(/invite the person again at the rights of their role/u);
  });

  it('each role signs at its own rights, on every vault or on the vaults named', () => {
    /* RED WHEN: a seat offered exactly its role's rights cannot be invited. */
    for (const role of ['admin', 'approver', 'initiator'] as const) {
      expect(seatInvitationRefusal(signSeatInvitation(byAddress(role, scopeOfRole(role)), ADA.secret))).toBeNull();
      expect(seatInvitationRefusal(signSeatInvitation(byAddress(role, scopeOfRole(role, [VAULT]), [VAULT]), ADA.secret))).toBeNull();
    }
  });

  it('rights naming vaults that do not hash to the scope, or naming the company-wide vault, are refused', () => {
    /* RED WHEN: the vaults an invitation names are not the ones its seat's rights commit to. */
    expect(() => signSeatInvitation(byAddress('approver', scopeOfRole('approver'), [VAULT]), ADA.secret)).toThrow();
    expect(() => signSeatInvitation(byAddress('approver', scopeOfRole('approver', [COMPANY_WIDE]), [COMPANY_WIDE]), ADA.secret)).toThrow();
  });

  it('a reader role is never invited to a seat, by address or by its leaf', () => {
    /* RED WHEN: a limited or accountant seat is invited to a leaf on the chain. */
    expect(() => signSeatInvitation(byAddress('limited', ALL_VAULTS), ADA.secret)).toThrow();
    const leafed: SeatInvitationTerms = { company: 'co_1', invitation: hex(1), person: 'bo', name: 'Bo', role: 'accountant', leaf: hex(4) };
    expect(() => signSeatInvitation(leafed, ADA.secret)).toThrow();
  });

  it('the vaults are part of what the approvers agree to', () => {
    /* RED WHEN: two invitations naming other vaults raise the same proposal. */
    const one = signSeatInvitation(byAddress('approver', scopeOfRole('approver', [VAULT]), [VAULT]), ADA.secret);
    const other = signSeatInvitation(byAddress('approver', scopeOfRole('approver', [hex(8)]), [hex(8)]), ADA.secret);
    expect(invitationProposalSalt(one)).not.toBe(invitationProposalSalt(other));
  });
});

import { randomBytes } from 'node:crypto';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import { signingPublicKeyOf, toHex, type Hex } from '../../../../src/core/crypto.js';
import {
  invitationIdOf, newInvitationToken, sealOffer, signOffer, signSeatInvitation, utcMomentOf, type InvitationOffer,
} from '../../../../src/core/invitation.js';
import { inboxPublicKey } from '../../../../src/core/sealed-records.js';

/*
 * REAL SEALED OFFERS FOR THE JOIN PAGE'S TESTS: signed by an inviting seat's filing key and sealed with the link's token,
 * so the page opens them with the device's own check. Only the service's answer to a read of the offer is stood in.
 */

export const LABEL = drawCompanyLabel();
export const ACCOUNT = 'c0'.repeat(32);
export const RECORD = 'acc_1';
export const COMPANY_NAME = 'Acme Studio';
export const PRIVATE_ADDRESS = 'mn_shield-addr_undeployed1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
export const PUBLIC_ADDRESS = 'mn_addr_undeployed1wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww';

const inviterWallet = identityFromSecret(new Uint8Array(32).fill(9));
const INVITER_SECRET = toHex(new Uint8Array(randomBytes(32))) as Hex;
const inviter = {
  committeeKey: committeeKeyFor(inviterWallet, LABEL) as never,
  statement: signDirectoryEntry(inviterWallet, LABEL, ACCOUNT as never, new Uint8Array(32).fill(3), signingPublicKeyOf(INVITER_SECRET), 'ab'.repeat(32)),
  opening: { publicKey: '01'.repeat(32), scope: '02'.repeat(32), blinding: '03'.repeat(32), salt: '04'.repeat(32), walletKey: { tag: 'schnorr', value: '05'.repeat(32) } },
};

export type Kind = 'employee' | 'vendor' | 'signer' | 'super-admin' | 'reissue';
export interface Options { readonly address?: string; readonly expiresInMs?: number; readonly seatByLink?: boolean }

export interface Invitation {
  readonly id: Hex;
  readonly token: Hex;
  readonly kind: 'employee' | 'vendor' | 'signer' | 'super-admin';
  readonly sealed: unknown;
  readonly expiresAt: string;
}

/** An invitation of `kind`, signed and sealed as the inviting seat's device makes one. */
export function anInvitation(kind: Kind, over: Options = {}): Invitation {
  const token = newInvitationToken();
  const id = invitationIdOf(token);
  const at = over.address === undefined ? {} : { address: over.address };
  const seatTerms = { company: RECORD, invitation: id, person: 'adr_00000000000000000000', name: 'Dee', role: 'approver' as const };
  const address = { address: '11'.repeat(32) as Hex, salt: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex };
  const forWhom = kind === 'employee'
    ? {
      kind, person: 'emp_0123456789abcdef0123', name: 'Priya Rao', title: 'Engineer', email: null, asset: 'night', baseAmount: 500000n,
      startDate: '2026-10-01', endDate: '2027-03-31', classification: 'full-time', ...at,
    }
    : kind === 'vendor'
      ? { kind, person: 'ven_0123456789abcdef0123', name: 'Northwind Supplies', email: null, startDate: '2026-10-01', ...at }
      : kind === 'super-admin'
        ? { kind, name: 'Root' }
        : kind === 'reissue'
          ? { kind, name: 'Dee', role: 'approver', invited: signSeatInvitation({ ...seatTerms, leaf: '66'.repeat(32) as Hex }, INVITER_SECRET) }
          : over.seatByLink === true
            ? { kind, name: 'Dee', role: 'approver', seat: { nonce: '9a'.repeat(32), secret: '9b'.repeat(32) }, invited: signSeatInvitation(seatTerms, INVITER_SECRET) }
            : {
              kind, name: 'Dee', role: 'approver', seat: { nonce: '9a'.repeat(32), secret: '9b'.repeat(32) },
              invited: signSeatInvitation({ ...seatTerms, invite: address, proposal: '77'.repeat(32) as Hex }, INVITER_SECRET),
              byAddress: { address: PRIVATE_ADDRESS, proposalSalt: '88'.repeat(32) },
            };
  const offer = {
    company: RECORD, companyName: COMPANY_NAME, label: LABEL, account: ACCOUNT as never, inboxPublicKey: inboxPublicKey('11'.repeat(32) as Hex, RECORD),
    expiresAt: Date.now() + (over.expiresInMs ?? 3_600_000), madeAt: utcMomentOf(Date.now()), inviter: inviter as never, for: forWhom,
  } as unknown as InvitationOffer;
  return {
    id, token, kind: kind === 'reissue' ? 'signer' : kind, sealed: sealOffer(signOffer(offer, INVITER_SECRET), token),
    expiresAt: new Date(offer.expiresAt).toISOString(),
  };
}

/** The service's answer to a read of the invitation's offer. */
export const offerAnswer = (i: Invitation): Response =>
  new Response(JSON.stringify({ kind: i.kind, offer: i.sealed, expiresAt: i.expiresAt }), { status: 200, headers: { 'content-type': 'application/json' } });

export const refusedAnswer = (status: number, refused: string): Response =>
  new Response(JSON.stringify({ refused, error: `the service said ${refused}` }), { status, headers: { 'content-type': 'application/json' } });

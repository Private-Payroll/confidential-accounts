/**
 * **INVITING SOMEBODY, AND ACCEPTING AN INVITATION, ON THE PERSON'S OWN
 * DEVICE.** Each step is one function a screen can call.
 *
 *   · **inviting** (`inviteHere`, one entry for the four kinds: an employee,
 *     a vendor, a signer or a super admin): this device draws the token, or
 *     takes the one its caller made for the link, seals
 *     the offer under the key only the link carries, signs it with this seat's
 *     filing key and the directory entry its wallet signed, and files what the
 *     service keeps: the kind, the lookup id, the hash of what accepts it, the
 *     sealed offer, and the epoch of the company key it was made under. The
 *     offer names the company's inbox as this device works it out from the key
 *     in force, when it was made and its expiry, all signed; nothing is made
 *     while the company's key is being changed. An employee's first person
 *     record, with the first line of their salary and classification histories,
 *     and a vendor's first vendor entry, with their payment terms, are sealed
 *     here and filed with it, naming this seat as their maker. A vendor added by
 *     address is active at once, paid at the typed address. The service is sent no token,
 *     no offer key and nothing it can open: no name, date, address or
 *     classification. A seat offered by an address the inviter typed is raised
 *     on the chain before the offer is filed (`fileSignerByAddress`), and the
 *     invitee's own wallet takes it; an employee added by address is held to
 *     that address in their record (`invitedAddress`). A press again under a
 *     token already used goes on only with the first press's kind and details
 *     (`firstAskRefusal`, `openTheFiledOffer`), and the record an employee's or
 *     a vendor's filing carries is entered then if it was not (`filedRecordEnteredHere`).
 *   · **opening** (`openInvitationHere`): the invitee's device asks for the
 *     invitation by its lookup id, opens the offer with the key in the link's
 *     fragment, and believes it only when the seat that invited signed it and
 *     its signed expiry has not passed on this device's clock.
 *   · **accepting** (`acceptAsPayeeHere` for an employee or a vendor,
 *     `acceptAsSignerHere`): what the
 *     invitee hands over is sealed here to the company's inbox key the offer
 *     names, and sent with the proof only the token gives. A super admin's
 *     invitation is opened but never accepted here. A signer accepts
 *     through the one seat path every way of joining uses
 *     (`acceptSeatOnThisDevice`), so the request that ends in a seat is the
 *     same whichever way they came. A person or vendor added by address
 *     claims from the wallet that holds the address (`claimIntentOf`), with no
 *     fingerprint read out.
 */
import { keyOf, openedWithAnyKey, sealingWith, type KeysHeld } from '../../../src/core/company-key.js';
import { canonical, randomBytes, signingPublicKeyOf, toHex, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { inboxPublicKey as inboxOf, openFromInbox, sealToInbox } from '../../../src/core/sealed-records.js';
import { sealPerson } from '../../../src/core/person-record.js';
import { openVendor, sealVendor, vendorTermsRefusal, type VendorRecord, type VendorTerms } from '../../../src/core/vendor-record.js';
import { assets as defaultAssets, whyTheMoneyCannotReach } from '../../../src/core/assets.js';
import { newSeatInvitation, proveSeatKeys, type SeatInvitation } from '../../../src/core/seat-invite-proof.js';
import {
  acceptanceHashOf, acceptanceProofOf, INVITATION_LIFETIME_MS, invitationIdOf, invitationLink, InvitationNotOpened, newInvitationToken, offerExpiredRefusal, openOffer,
  replacedBy, sealOffer, seatInvitationRefusal, signInvitationFiling, signOffer, signSeatInvitation, signWithdrawal, SUPER_ADMIN_INVITED_BY_THE_COMMITTEE,
  SUPER_ADMIN_JOINS_BY_THE_COMMITTEE, tokenOfLink,
  utcMomentOf, whyThisOfferCannotBeMade,
  type EmployeeClassification, type EmployeeOffer, type InvitationFiling, type InvitationKind, type InvitationOffer, type Inviter, type SignedOffer,
  type SignedSeatInvitation, type VendorOffer,
} from '../../../src/core/invitation.js';
import type { PendingSignerPayload, Role, RosterEmployee, SealedAccount, SealedProposal } from '../../../src/core/types.js';
import { seatInvitationIn, seatStillProposedFor } from '../../../src/core/proposal-filing.js';
import { mayInvite } from '../../../src/midnight/seat-directory.js';
import type { AssetId } from '../../../src/core/assets.js';
import {
  companyWirePaths, fromCompanyWire, signCompanyFiling, toCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord,
} from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import { FiledNotEntered, type RecordsEntered } from './record-entered-here.js';
import type { LeafScheme } from '../../../src/core/signer-leaf.js';
import type { SealedHandover } from '../../../src/core/invite-handover.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { readJoinCode, writeJoinCode, JOIN_CODE_REFUSAL, type JoinCode, type PayeeParts, type SignerParts } from 'midnight-identity/profile/join-code';
import { payeeCodeFingerprint, seatKeyFingerprint, tidyFingerprint } from 'midnight-identity/profile/fingerprint';
import { acceptSeatOnThisDevice, type AcceptedSeat, type SeatDoors } from './accept-seat.js';
import { walletKeyProvedBy, type SeatOpening, type WalletKey } from '../../../src/core/seat-opening.js';
import { checkShieldedAddress } from 'midnight-identity/wallet/address-shape';
import { typedAddressIsShielded } from 'midnight-identity/profile/address-claim';
import type { NetworkName } from '../../../src/midnight/network.js';
import type { VendorsHere } from './vendors-on-device.js';

/** How this device reaches the service: a path and a JSON body, an answer with its status. */
export type InvitationSend = (
  path: string, init: { readonly method: 'GET' | 'POST' | 'PUT'; readonly body?: string },
) => Promise<{ readonly status: number; readonly body: unknown }>;

/** The company an invitation is made for, as this device opened it. */
export interface InvitingCompany {
  readonly id: string;
  readonly name: string;
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
  /** The key epoch a bare key seals at; the company's keys seal at the epoch in force. */
  readonly keyEpoch: number;
  /** The company's keys as this device holds them (`companyKeyHere`); a bare key is the one key of a company never changed. */
  readonly viewingKey: KeysHeld;
}

/** This device's seat: the filing key it signs with, the directory entry its wallet signed for it, and its own seat's opening. */
export interface InvitingSeat extends Inviter {
  readonly signingSecret: Hex;
  /** The one filing call, bound to this company and this seat: a person record filed here is entered in the company's records. */
  readonly entered: RecordsEntered;
  /**
   * This seat as this device's own read of the company's directory holds it: its signer role, and whether a quorum
   * retired it. Only a seat not retired whose role may file a proposal invites a signer, re-issues an invitation or
   * withdraws somebody waiting (`mayInvite`), and a seat this device cannot say that of does none of them; every
   * member's device refuses what any other seat signs. A payee's invitation does not ask it.
   */
  readonly held?: { readonly role: Role | null; readonly retired: boolean };
}

/** An invitation made: the link to send the person, and the ids the service knows it by. */
interface MadeInvitation {
  readonly link: string;
  readonly id: Hex;
  /** An employee's or a vendor's: the id of the record it is for. */
  readonly person?: string;
}

/** Thrown when the service refused to keep what this device made; its words are in the message. */
export class InvitationRefused extends Error {
  constructor(readonly status: number, readonly refused: string | null, said: string) {
    super(said);
    this.name = 'InvitationRefused';
  }
}

const answered = (r: { status: number; body: unknown }, ok: number): Record<string, unknown> => {
  const b = (r.body ?? {}) as Record<string, unknown>;
  if (r.status !== ok) {
    throw new InvitationRefused(r.status, typeof b.refused === 'string' ? b.refused : null,
      typeof b.error === 'string' ? b.error : `the service answered ${r.status} and said nothing, so nothing is known to have been kept.`);
  }
  return b;
};

/** Thrown, before anything is signed or sent, by a seat that may not invite, re-issue or withdraw. */
export class SeatMayNotInvite extends Error {
  constructor(why: string) {
    super(`${why} Nothing was signed or sent.`);
    this.name = 'SeatMayNotInvite';
  }
}

/** Refuses unless this device's seat is one not retired whose role may file a proposal: the one rule every member's device holds it to. */
const refuseASeatThatMayNotInvite = (seat: Pick<InvitingSeat, 'held'>): void => {
  if (seat.held === undefined) {
    throw new SeatMayNotInvite('This device has not read your seat\'s role from the company\'s directory, so it invites and withdraws nobody. Reload the page.');
  }
  if (seat.held.retired) throw new SeatMayNotInvite('Your seat has been retired from this company, so it invites and withdraws nobody.');
  if (!mayInvite({ role: seat.held.role })) {
    throw new SeatMayNotInvite('Your role on this company may not file a proposal, so it invites and withdraws nobody. Ask a signer whose role may.');
  }
};

/** The company's key an invitation is made under: one sealing, refused while the company's key is being changed. */
type Sealing = { readonly key: Hex; readonly epoch: number };

/**
 * The offer an invitation carries. Its inbox is worked out here from the key in force, never copied from the service,
 * and it says when it was made and when it stops being answered, signed with the rest of the offer.
 */
const offered = (company: InvitingCompany, seat: InvitingSeat, forWhom: InvitationOffer['for'], sealing: Sealing): InvitationOffer => ({
  company: company.id, companyName: company.name, label: company.label, account: company.account,
  inboxPublicKey: inboxOf(sealing.key, company.id), expiresAt: Date.now() + INVITATION_LIFETIME_MS, madeAt: utcMomentOf(Date.now()), for: forWhom,
  /* The inviter's own seat's opening, so the invitee's wallet can tell the seat was made for its key; nothing of any other seat. */
  inviter: { committeeKey: seat.committeeKey, statement: seat.statement, opening: seat.opening },
});

/** Thrown before anything is signed or sent, when what was entered is not an invitation this device may make; its words say what to change. */
export class InvitationNotMade extends Error {
  constructor(why: string) {
    super(`this invitation was not made: ${why}. Nothing was signed or sent.`);
    this.name = 'InvitationNotMade';
  }
}

/**
 * The offer for one invitation, checked as the invitee's device will check it and as a new offer must be, signed
 * with this seat's filing key, sealed under the token's key and filed to the one invitation route. `record` is the
 * first company record filed with it, for the kinds that file one.
 */
async function filed(
  company: InvitingCompany, seat: InvitingSeat, kind: InvitationKind, forWhom: InvitationOffer['for'], sealing: Sealing,
  token: Hex, send: InvitationSend, person?: string, record?: ReturnType<typeof toCompanyWire>, signed?: SignedOffer,
): Promise<InvitationFiling> {
  const offer = signed?.offer ?? offered(company, seat, forWhom, sealing);
  const why = whyThisOfferCannotBeMade(offer);
  if (why !== null) throw new InvitationNotMade(why);
  const invitation = signInvitationFiling({
    company: company.id, kind, id: invitationIdOf(token), acceptanceHash: acceptanceHashOf(acceptanceProofOf(token)),
    offer: sealOffer(signed ?? signOffer(offer, seat.signingSecret), token), keyEpoch: sealing.epoch, ...(person === undefined ? {} : { person }),
  }, seat.signingSecret);
  answered(await send(`/api/accounts/${encodeURIComponent(company.id)}/invites`, {
    method: 'POST', body: JSON.stringify(record === undefined ? { invitation } : { person: record, invitation }),
  }), 201);
  return invitation;
}

/** Who an employee is, what they are paid and when they work, as the person inviting them enters it. */
interface EmployeeSpec {
  readonly name: string;
  readonly email: string | null;
  readonly title: string;
  readonly asset: AssetId;
  readonly baseAmount: bigint;
  /** A calendar date (2026-07-01). */
  readonly startDate: string;
  /** For a fixed-term employee, the calendar date they end. */
  readonly endDate?: string;
  readonly classification: EmployeeClassification;
  /** The address the inviter typed, when adding the person by their address. */
  readonly address?: string;
}

/**
 * Who a vendor is and from when, and for monthly payments that stop, until when; how they are paid, and on which
 * network their address is. No salary and no classification.
 */
interface VendorSpec {
  readonly name: string;
  readonly email: string | null;
  readonly startDate: string;
  readonly endDate?: string;
  readonly address?: string;
  readonly terms: VendorTerms;
  readonly network: NetworkName;
}

/** Who a signer's invitation is for: the name and role they are offered, and the sign-in of the person invited. */
interface SignerSpec {
  readonly name: string;
  readonly role: Role;
  /** The sign-in of the person invited, for an invitation answered by link; one made by address names nobody's yet. */
  readonly person: string;
  /** The shielded address typed, for a seat offered by address: the proposal is raised for it before anybody accepts. */
  readonly address?: string;
  /** The rights the seat carries, for a seat offered by address: every vault unless given. */
  readonly scope?: Hex;
}

/**
 * A seat offered by address, as the inviting device keeps it before anything is raised: the token, the link it
 * makes, and the offer this seat signed, which carries the address, the salts, the rights and the signed
 * invitation the invitee's wallet takes the seat with. Kept so that nothing the seating needs exists only at the
 * service.
 */
export interface KeptSeatInvitation {
  readonly company: string;
  readonly id: string;
  readonly token: Hex;
  readonly link: string;
  readonly offer: SignedOffer;
}

/**
 * What raising a seat offered by address needs from the inviting device: the network the address is on, the
 * account's commitments, why the address's wallet may not be invited here again (`held`: already seated, or invited
 * by a proposal still open other than `except`; null when it may), the proposal's identity as the raise will make
 * it, where this device keeps the invitation (`keep`, before the raise), and the raise itself
 * (`raiseSeatInvitationOnDevice`), which carries the address's coin key in the proposal.
 */
export interface SignerByAddressDoors {
  readonly keep: (kept: KeptSeatInvitation) => Promise<void>;
  readonly network: NetworkName;
  readonly commitments: { inviteAddressOf(coinPublicKey: Hex, salt: Hex): Hex; allVaults(): Hex };
  readonly held: (coinPublicKey: Hex, except?: string) => Promise<string | null>;
  readonly identity: (change: { readonly kind: 'add-signer'; readonly address: string; readonly scope: string }, salt: string) => Promise<{ readonly chainId: string }>;
  readonly raise: (input: {
    readonly invited: SignedSeatInvitation; readonly proposalSalt: string; readonly name: string; readonly inviter: Inviter; readonly coinPublicKey: Hex;
  }) => Promise<unknown>;
}

/**
 * How an invitation is made beyond what it offers: the token its link carries, when the page asking made it (so the
 * page rebuilds the link itself and nothing secret has to come back to it), and, for a seat offered by address, the
 * invitation this device kept before an earlier attempt raised it, taken up again so that no second proposal is
 * raised for one address, and only for the same name, role, rights and address it was kept with.
 */
export interface InviteOptions {
  readonly token?: Hex;
  readonly resume?: KeptSeatInvitation;
}

/** The token a new invitation is made with: the one given, which must be a whole token, or a fresh one. */
const tokenFor = (given: Hex | undefined): Hex => {
  if (given === undefined) return newInvitationToken();
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/u.test(given)) {
    throw new InvitationNotMade('the token given for its link is not sixty-four lower-case hex characters');
  }
  return given;
};

/**
 * What adding a vendor by address needs of this device: the company's vendors as it believes them (`readVendorsHere`),
 * so an address an active vendor entry already holds is not given a second entry, which would be paid as well.
 */
export interface VendorByAddressDoors {
  readonly vendors: () => Promise<Pick<VendorsHere, 'vendors' | 'notPayable'>>;
}

/** A seat offered by address whose proposal was raised and whose offer could not be filed: the link still reaches the person. */
export class InvitationRaisedNotFiled extends Error {
  constructor(readonly link: string, why: string) {
    super(`the proposal to seat this address was raised, and the invitation was not filed: ${why}. Give the person this link yourself: it is the only copy.`);
    this.name = 'InvitationRaisedNotFiled';
  }
}

/** Who a super admin's invitation is for: defined with the other kinds, though no seat makes one. */
interface SuperAdminSpec {
  readonly name: string;
  readonly address?: string;
}

/** What each kind of invitation is made from: `InviteSpecs['vendor']` is what a vendor's is made from. */
export interface InviteSpecs {
  readonly employee: EmployeeSpec;
  readonly vendor: VendorSpec;
  readonly signer: SignerSpec;
  readonly 'super-admin': SuperAdminSpec;
}

/** An employee's invitation and first person record, made here and filed together; the token stays on this device. */
async function filePayeeInvitation(
  company: InvitingCompany, seat: InvitingSeat, spec: EmployeeSpec, send: InvitationSend, given?: Hex,
): Promise<{ token: Hex; id: Hex; person: string; sealing: Sealing }> {
  refuseASeatThatMayNotInvite(seat);
  if (typeof spec.baseAmount !== 'bigint' || spec.baseAmount <= 0n) throw new InvitationNotMade('an employee is invited with a pay above nothing, in the token\'s smallest unit');
  const made = { madeBy: signingPublicKeyOf(seat.signingSecret), madeAt: utcMomentOf(Date.now()) };
  const person: RosterEmployee = {
    id: `emp_${toHex(randomBytes(10))}`, accountId: company.id, name: spec.name, email: spec.email, title: spec.title,
    asset: spec.asset, baseAmount: spec.baseAmount, startDate: spec.startDate, status: 'pending', wrappingPublicKey: null,
    handedOverBy: null, admittedBy: null, admittedAt: null, selfRaised: false, address: null,
    ...(spec.endDate === undefined ? {} : { endDate: spec.endDate }),
    pay: [{ amount: spec.baseAmount, from: spec.startDate, ...made }],
    classifications: [{ classification: spec.classification, from: spec.startDate, ...made }],
    ...(spec.address === undefined ? {} : { invitedAddress: spec.address }),
    ...made,
  };
  const sealing = sealingWith(company.viewingKey, company.keyEpoch);
  const offer: EmployeeOffer = {
    kind: 'employee', person: person.id, name: spec.name, title: spec.title, email: spec.email,
    asset: spec.asset, baseAmount: spec.baseAmount, startDate: spec.startDate, classification: spec.classification,
    ...(spec.endDate === undefined ? {} : { endDate: spec.endDate }), ...(spec.address === undefined ? {} : { address: spec.address }),
  };
  const token = tokenFor(given);
  const signed = signCompanyFiling(sealPerson(person, 1, sealing.epoch, sealing.key), seat.signingSecret);
  const invitation = await filed(company, seat, 'employee', offer, sealing, token, send, person.id, toCompanyWire(signed));
  await seat.entered.enter([companyRecordEntry(signed)]);
  return { token, id: invitation.id, person: person.id, sealing };
}

/*
 * A vendor's invitation and first vendor entry, made here and filed together: the vendor entry's id is drawn here
 * like an employee's, and the vendor's name, dates and address travel only inside the sealed offer and the sealed
 * entry. Their payment terms are in the entry and never in the offer. Added by address, they are active at once and
 * paid at the typed address, which must be one money can reach on this network in the token their terms name, and
 * one no active vendor entry of the company is already paid at (`doors.vendors`).
 */
async function fileVendorInvitation(
  company: InvitingCompany, seat: InvitingSeat, spec: VendorSpec, send: InvitationSend, doors?: VendorByAddressDoors, given?: Hex,
): Promise<{ token: Hex; id: Hex; person: string }> {
  refuseASeatThatMayNotInvite(seat);
  const sealing = sealingWith(company.viewingKey, company.keyEpoch);
  const { terms: _terms, network: _network, ...forTheOffer } = spec;
  const offer: VendorOffer = {
    kind: 'vendor', person: `ven_${toHex(randomBytes(10))}`, name: spec.name, email: spec.email, startDate: spec.startDate,
    ...(spec.endDate === undefined ? {} : { endDate: spec.endDate }), ...(spec.address === undefined ? {} : { address: spec.address }),
  };
  /* What the screen passed is the offer's, field for field, so a salary or a classification it carried is refused, not dropped. */
  const asOffered = { ...(forTheOffer as object), ...offer } as VendorOffer;
  const vendor = vendorAddedHere(company, spec, offer.person, { madeBy: signingPublicKeyOf(seat.signingSecret), madeAt: utcMomentOf(Date.now()) });
  if (vendor.address !== null) await refuseAnAddressAVendorHolds(vendor.address.bech32, doors);
  const token = tokenFor(given);
  const signed = signCompanyFiling(sealVendor(vendor, 1, sealing.epoch, sealing.key), seat.signingSecret);
  const invitation = await filed(company, seat, 'vendor', asOffered, sealing, token, send, offer.person, toCompanyWire(signed));
  await seat.entered.enter([companyRecordEntry(signed)]);
  return { token, id: invitation.id, person: offer.person };
}

/** The one reading of an address into where a payee is paid, for people and vendors alike. */
export { payeeAt } from '../../../src/core/payee-keys.js';
import { payeeAt } from '../../../src/core/payee-keys.js';

/** Refuses `address` when an active vendor entry this device believes is already paid there: one vendor gets one entry. */
const refuseAnAddressAVendorHolds = async (address: string, doors: VendorByAddressDoors | undefined): Promise<void> => {
  if (doors === undefined) {
    throw new InvitationNotMade('this page cannot read the company\'s vendors, so it cannot say no vendor is already paid at this address, and adds nobody by address: reload the page');
  }
  const read = await doors.vendors();
  const holder = [...read.vendors.map((v) => v.vendor), ...read.notPayable.map((n) => n.here.vendor)]
    .find((v) => v.status === 'active' && v.address !== null && v.address.bech32.toLowerCase() === address.toLowerCase());
  if (holder !== undefined) {
    throw new InvitationNotMade(`${holder.name} is already a vendor of this company paid at this address, and one vendor gets one entry, or they `
      + 'are paid twice. Change their entry, or mark it a leaver first');
  }
};

/** A vendor's first entry, or a refusal saying what to put right. Added by address, it pays the typed address at once. */
const vendorAddedHere = (company: InvitingCompany, spec: VendorSpec, id: string, made: { readonly madeBy: Hex; readonly madeAt: string }): VendorRecord => {
  let address: VendorRecord['address'] = null;
  if (spec.address !== undefined) {
    try {
      address = payeeAt(spec.address, spec.network);
    } catch (e) {
      throw new InvitationNotMade(`the address typed is not one money can be sent to on this network (${(e as Error).message})`);
    }
    if (spec.terms?.kind === 'monthly') {
      let unreachable: string | null;
      try { unreachable = whyTheMoneyCannotReach(defaultAssets.require(spec.terms.asset), address.kind); } catch (e) { unreachable = (e as Error).message; }
      if (unreachable !== null) throw new InvitationNotMade(`their monthly payments could not reach the address typed: ${unreachable}`);
    }
  }
  const vendor: VendorRecord = {
    id, accountId: company.id, name: spec.name, email: spec.email, network: spec.network, startDate: spec.startDate,
    ...(spec.endDate === undefined ? {} : { endDate: spec.endDate }), terms: spec.terms,
    status: address === null ? 'pending' : 'active', address, wrappingPublicKey: null,
    handedOverBy: null, admittedBy: null, admittedAt: null,
    ...(spec.address === undefined ? {} : { invitedAddress: spec.address }),
    ...made,
  };
  const why = vendorTermsRefusal(spec.terms);
  if (why !== null) throw new InvitationNotMade(`a vendor is added with how they are paid, and ${why}`);
  return vendor;
};

/**
 * A signer's invitation, made here and filed: the token and the seat's secret
 * stay on this device. Who the seat is for is signed here by this seat
 * (`signSeatInvitation`) and travels inside the sealed offer; for a seat added
 * from a code it also names the leaf the code carries (`leaf`).
 */
async function fileSignerInvitation(
  company: InvitingCompany, seat: InvitingSeat, signer: SignerSpec, send: InvitationSend, leaf?: Hex, given?: Hex,
): Promise<{ token: Hex; id: Hex; proved: SeatInvitation; invited: SignedSeatInvitation; sealing: Sealing }> {
  refuseASeatThatMayNotInvite(seat);
  const sealing = sealingWith(company.viewingKey, company.keyEpoch);
  const proved = newSeatInvitation(sealing.key, company.id, signer.name, signer.role);
  const token = tokenFor(given);
  const invited = signSeatInvitation({
    company: company.id, invitation: invitationIdOf(token), person: signer.person, name: signer.name, role: signer.role,
    ...(leaf === undefined ? {} : { leaf }),
  }, seat.signingSecret);
  const invitation = await filed(company, seat, 'signer', {
    kind: 'signer', name: signer.name, role: signer.role, seat: { nonce: proved.nonce, secret: proved.secret }, invited,
  }, sealing, token, send);
  return { token, id: invitation.id, proved, invited, sealing };
}

/**
 * **A SEAT OFFERED BY THE ADDRESS THE INVITER TYPED, RAISED BEFORE ANYBODY ACCEPTS.** A wallet already seated here,
 * or already invited by a proposal still open, is refused first (`doors.held`). The address's coin key is
 * committed to under a fresh salt; the proposal's identity is worked out first, under a salt chosen here, so the
 * signed invitation names the commitment, the seat's rights and the proposal; the proposal is raised with this seat's
 * approval, carrying the coin key sealed; and only then is the offer filed, carrying the address, the proposal's salt
 * and the signed invitation, so the invitee's wallet can take the seat itself. Before the raise, this device keeps the
 * token and the offer it signed (`doors.keep`); nothing is raised when it cannot. If the filing fails after the raise,
 * the link is handed back in the error: this device holds it, and nothing the seat needs exists only at the service.
 * Taken up again with the invitation kept (`resume`), it raises and files that same invitation, never a new one, and
 * only for the same ask (`resumeSignerByAddress`).
 */
async function fileSignerByAddress(
  company: InvitingCompany, seat: InvitingSeat, signer: SignerSpec & { readonly address: string }, origin: string, send: InvitationSend,
  doors: SignerByAddressDoors, opts: InviteOptions = {},
): Promise<MadeInvitation> {
  refuseASeatThatMayNotInvite(seat);
  let coinPublicKey: Hex;
  try {
    coinPublicKey = String(checkShieldedAddress(signer.address, doors.network as never).coinPublicKey).toLowerCase() as Hex;
  } catch (e) {
    throw new InvitationNotMade(`the address is not a private address on this network (${(e as Error).message})`);
  }
  if (opts.resume !== undefined) return resumeSignerByAddress(company, seat, signer, coinPublicKey, send, doors, opts);
  const held = await doors.held(coinPublicKey);
  if (held !== null) throw new InvitationNotMade(held);
  const addressSalt = toHex(randomBytes(32));
  const scope = (signer.scope ?? doors.commitments.allVaults()).toLowerCase() as Hex;
  const invite = { address: doors.commitments.inviteAddressOf(coinPublicKey, addressSalt).toLowerCase() as Hex, salt: addressSalt, scope };
  const proposalSalt = toHex(randomBytes(32));
  const { chainId } = await doors.identity({ kind: 'add-signer', address: invite.address, scope }, proposalSalt);
  const sealing = sealingWith(company.viewingKey, company.keyEpoch);
  const proved = newSeatInvitation(sealing.key, company.id, signer.name, signer.role);
  const token = tokenFor(opts.token);
  const invited = signSeatInvitation({
    company: company.id, invitation: invitationIdOf(token), person: `adr_${toHex(randomBytes(10))}`, name: signer.name, role: signer.role,
    invite, proposal: chainId.toLowerCase() as Hex,
  }, seat.signingSecret);
  const inviter: Inviter = { committeeKey: seat.committeeKey, statement: seat.statement, opening: seat.opening };
  const forWhom: InvitationOffer['for'] = {
    kind: 'signer', name: signer.name, role: signer.role, seat: { nonce: proved.nonce, secret: proved.secret }, invited,
    byAddress: { address: signer.address, proposalSalt },
  };
  const unsigned = offered(company, seat, forWhom, sealing);
  const why = whyThisOfferCannotBeMade(unsigned);
  if (why !== null) throw new InvitationNotMade(why);
  const offer = signOffer(unsigned, seat.signingSecret);
  const link = invitationLink(origin, token);
  await doors.keep({ company: company.id, id: invitationIdOf(token), token, link, offer });
  await doors.raise({ invited, proposalSalt, name: signer.name, inviter, coinPublicKey });
  try {
    const invitation = await filed(company, seat, 'signer', forWhom, sealing, token, send, undefined, undefined, offer);
    return { link, id: invitation.id };
  } catch (e) {
    throw new InvitationRaisedNotFiled(link, (e as Error).message);
  }
}

const KIND_SAID: Readonly<Record<string, string>> = {
  employee: 'an employee', vendor: 'a vendor', signer: 'a signer', 'super-admin': 'a super admin', reissue: 'a re-issued seat invitation',
};
const SAME_ASK = 'press again with the same details as the first time, or start a new invitation, which has a new link';
const lower = (x: unknown): unknown => (typeof x === 'string' ? x.toLowerCase() : x);

/**
 * **A PRESS AGAIN CARRIES THE FIRST PRESS'S ASK, OR IT IS NOT CARRIED ON.** `first` is what the first press under
 * this token offered: the seat offer kept in the saved keys, or the offer filed under the token's id, opened with it.
 * The press now asks `kind` with `spec`. They are the same ask only when the kind is the same and every field the
 * first offer carries is equal: for an employee their name, title, email, currency, pay, dates, classification and
 * address (an address on one side only is another way of inviting); for a vendor their name, email, dates and
 * address (their terms are in their entry, compared by `filedRecordEnteredHere`); for a signer the name and role, on the
 * offer and on the invitation it signs, the address it is offered at and its rights (`spec.scope`, or every vault,
 * `allVaults`). Returns null for the same ask, or why it is not, naming what resolves it; no value is repeated.
 */
export function firstAskRefusal<K extends InvitationKind>(
  first: InvitationOffer['for'], kind: K, spec: InviteSpecs[K], allVaults: Hex,
): string | null {
  if (first.kind !== kind) {
    return `the invitation already made under this link is for ${KIND_SAID[first.kind] ?? 'another kind'}, not ${KIND_SAID[kind] ?? 'this kind'}: ${SAME_ASK}`;
  }
  const s = spec as unknown as Record<string, unknown>;
  const f = first as unknown as Record<string, unknown>;
  let pairs: readonly (readonly [string, unknown, unknown])[];
  if (first.kind === 'employee') {
    pairs = [['name', f.name, s.name], ['title', f.title, s.title], ['email', f.email ?? null, s.email ?? null], ['currency', f.asset, s.asset],
      ['pay', f.baseAmount, s.baseAmount], ['start date', f.startDate, s.startDate], ['end date', f.endDate, s.endDate],
      ['classification', f.classification, s.classification], ['address', f.address, s.address]];
  } else if (first.kind === 'vendor') {
    pairs = [['name', f.name, s.name], ['email', f.email ?? null, s.email ?? null], ['start date', f.startDate, s.startDate],
      ['end date', f.endDate, s.endDate], ['address', f.address, s.address]];
  } else if (first.kind === 'signer') {
    const t = first.invited.terms;
    pairs = [['name', first.name, s.name], ['name', t.name, s.name], ['role', first.role, s.role], ['role', t.role, s.role],
      ['address', lower(first.byAddress?.address), lower(s.address)],
      ['rights', lower(t.invite?.scope), t.invite === undefined && s.address === undefined ? undefined : lower(s.scope ?? allVaults)]];
  } else {
    return `the invitation already made under this link is ${KIND_SAID[first.kind] ?? 'of another kind'}, not ${KIND_SAID[kind] ?? 'this kind'}: ${SAME_ASK}`;
  }
  const differ = [...new Set(pairs.filter(([, a, b]) => canonical(a) !== canonical(b)).map(([what]) => what))];
  if (differ.length === 0) return null;
  const said = differ.map((w) => (w === 'rights' ? 'other rights' : `another ${w}`));
  return `the invitation already made under this link was made with ${said.join(', ')}: ${SAME_ASK}`;
}

/**
 * **AN OFFER FILED UNDER THE TOKEN, TAKEN AS THIS PRESS'S INVITATION ONLY WHEN IT IS THE SAME ASK.** `sealed` is
 * what the service holds filed under the token's id. It must open with the token (which checks its signature), be
 * this company's (`company`), be the seat offer this device kept for the id when it kept one (`kept`), and be the
 * same ask (`firstAskRefusal`). Returns the opened offer, or why it is not this press's invitation, naming what
 * resolves it. An employee's or a vendor's record filed with it is checked and entered by `filedRecordEnteredHere`.
 */
export function openTheFiledOffer<K extends InvitationKind>(
  sealed: unknown, token: Hex, company: string, kind: K, spec: InviteSpecs[K], allVaults: Hex,
  o: { readonly kept?: KeptSeatInvitation } = {},
): { readonly refused: string } | { readonly filed: SignedOffer } {
  let signed: SignedOffer;
  try {
    signed = openOffer(sealed as Sealed, token);
  } catch (e) {
    return { refused: `the invitation filed under this link does not open with it (${(e as Error).message}), so it is not taken as this one: start a new invitation, which has a new link` };
  }
  if (signed.offer.company !== company) {
    return { refused: 'the invitation filed under this link is another company\'s, so it is not taken as this one: start a new invitation, which has a new link' };
  }
  if (o.kept !== undefined && signed.signature !== o.kept.offer.signature) {
    return { refused: 'the invitation filed under this link is not the one this wallet kept for it, so it is not taken as this one: start a new '
      + 'invitation, which has a new link, and withdraw the proposal raised for the kept one if it is still open' };
  }
  const differs = firstAskRefusal(signed.offer.for, kind, spec, allVaults);
  return differs === null ? { filed: signed } : { refused: differs };
}

/** What `filedRecordEnteredHere` reads: the company's service, and the newest version its records hold of each record named. */
interface FiledRecordReads {
  readonly send: InvitationSend;
  readonly newest: (records: readonly { readonly store: 'company'; readonly kind: string; readonly id: string }[]) => Promise<readonly number[]>;
}

/**
 * **THE RECORD FILED WITH AN EMPLOYEE'S OR A VENDOR'S INVITATION, ENTERED BEFORE A PRESS AGAIN IS TOLD DONE.** The
 * first press filed the invitation and the first version of the person's or vendor's record in one filing, and then
 * entered that record in the company's records; when the entry was not kept (`FiledNotEntered`), nothing else enters
 * it, and no other device believes the record. So the first version filed under the offer's record id is read from
 * the service and must be one this seat filed (its filing signature names this seat's key), and a vendor's must be on
 * the terms this press asks, which their offer does not carry; when the company's records do not yet hold it, it is
 * entered, signed by this seat (`seat.entered`), as the first press would have entered it. Returns null when the
 * record stands entered, or why the filed invitation is not this press's, naming what resolves it; throws
 * `FiledNotEntered` when what the records hold cannot be read or the entry cannot be kept, so the press is made again.
 */
export async function filedRecordEnteredHere<K extends 'employee' | 'vendor'>(
  company: Pick<InvitingCompany, 'id' | 'viewingKey'>, kind: K, filed: SignedOffer, spec: InviteSpecs[K],
  seat: Pick<InvitingSeat, 'signingSecret' | 'entered'>, reads: FiledRecordReads,
): Promise<string | null> {
  const recordKind = kind === 'employee' ? 'person' : 'vendor';
  const id = (filed.offer.for as EmployeeOffer | VendorOffer).person;
  const answer = await reads.send(companyWirePaths.versions(company.id, recordKind, id), { method: 'GET' });
  const listed = (answer.body as { versions?: unknown } | null)?.versions;
  if (answer.status !== 200 || !Array.isArray(listed)) {
    throw new FiledNotEntered(`the record filed with the invitation under this link could not be read (the service answered ${answer.status})`, {
      again: 'Press again to carry on with this same invitation.',
    });
  }
  let first: SealedCompanyRecord | undefined;
  try {
    first = listed.map((w) => fromCompanyWire(w, { company: company.id, kind: recordKind, id }).sealed).find((r) => r.version === 1);
  } catch {
    first = undefined;
  }
  const mine = signingPublicKeyOf(seat.signingSecret).toLowerCase();
  if (first === undefined || verifiedCompanyFiler(first)?.toLowerCase() !== mine) {
    return 'the record filed with the invitation under this link is not one this seat filed, so it is not entered or taken as this '
      + 'one: start a new invitation, which has a new link';
  }
  if (kind === 'vendor') {
    let terms: VendorTerms;
    try {
      terms = openVendor(first, keyOf(company.viewingKey, first.keyEpoch)).terms;
    } catch {
      return 'the vendor entry filed with the invitation under this link does not open with the company\'s key, so it cannot be said '
        + 'to be on these terms: start a new invitation, which has a new link';
    }
    if (canonical(terms) !== canonical((spec as unknown as VendorSpec).terms)) {
      return `the invitation already made under this link was made with other terms: ${SAME_ASK}`;
    }
  }
  let held: readonly number[];
  try {
    held = await reads.newest([{ store: 'company', kind: recordKind, id }]);
  } catch (e) {
    throw new FiledNotEntered(`what the company's records hold of it could not be read: ${(e as Error)?.message ?? String(e)}`, {
      cause: e, again: 'Press again to carry on with this same invitation.',
    });
  }
  if ((held[0] ?? 0) < 1) await seat.entered.enter([companyRecordEntry(first)]);
  return null;
}

/** What a press again is told when the invitation filed under its token is closed: it can never be filed again. */
export const INVITATION_UNDER_THIS_LINK_CLOSED = 'the invitation already filed under this link has been used, has expired or was withdrawn, '
  + 'so nothing is made or raised under it again: start a new invitation, which has a new link, and withdraw any proposal still open for it';

/**
 * **THE SEAT OFFERED BY ADDRESS THIS DEVICE KEPT, TAKEN UP AGAIN.** The kept invitation must be this company's, for
 * this token and for the address typed now, must be the same ask as this press, with the same name, role and rights
 * (`firstAskRefusal`), so what is raised is what the press showed, must name its proposal, and must not have expired:
 * nobody could open an expired offer, so a seat raised for it could never be taken; the address's wallet is checked again against
 * every other proposal (`doors.held`, except this one's). The same proposal is raised again under its own salt, which
 * finds the one already raised when there is one, and the same signed offer is filed, so one address never gets two
 * proposals from one attempt.
 */
async function resumeSignerByAddress(
  company: InvitingCompany, seat: InvitingSeat, signer: SignerSpec & { readonly address: string }, coinPublicKey: Hex,
  send: InvitationSend, doors: SignerByAddressDoors, opts: InviteOptions,
): Promise<MadeInvitation> {
  const kept = opts.resume!;
  const offer = kept.offer.offer;
  const forWhom = offer.for;
  if (kept.company !== company.id || offer.company !== company.id || kept.id !== invitationIdOf(kept.token)
    || (opts.token !== undefined && opts.token !== kept.token)) {
    throw new InvitationNotMade('the invitation kept on this device to take up again is not this one');
  }
  if (forWhom.kind !== 'signer' || forWhom.byAddress === undefined || forWhom.invited.terms.invite === undefined
    || forWhom.invited.terms.proposal === undefined || forWhom.byAddress.address.toLowerCase() !== signer.address.toLowerCase()) {
    throw new InvitationNotMade('the invitation kept on this device to take up again is not a seat offered at this address');
  }
  const differs = firstAskRefusal(forWhom, 'signer', signer, doors.commitments.allVaults());
  if (differs !== null) throw new InvitationNotMade(differs);
  if (offerExpiredRefusal(offer, Date.now()) !== null) {
    throw new InvitationNotMade('the invitation kept on this device has expired, so its proposal is not raised again: withdraw it if '
      + 'its proposal is still open, and invite the person again');
  }
  const held = await doors.held(coinPublicKey, forWhom.invited.terms.proposal);
  if (held !== null) throw new InvitationNotMade(held);
  await doors.raise({ invited: forWhom.invited, proposalSalt: forWhom.byAddress.proposalSalt, name: forWhom.name, inviter: offer.inviter, coinPublicKey });
  try {
    const sealing = sealingWith(company.viewingKey, company.keyEpoch);
    const invitation = await filed(company, seat, 'signer', forWhom, sealing, kept.token, send, undefined, undefined, kept.offer);
    return { link: kept.link, id: invitation.id };
  } catch (e) {
    throw new InvitationRaisedNotFiled(kept.link, (e as Error).message);
  }
}

/**
 * **ANYBODY INVITED FROM THIS DEVICE, ON THE ONE ENTRY FOR EVERY KIND**: an
 * employee (their first person record is sealed here and filed with the
 * invitation), a vendor, or a signer (with the secret their new keys will be
 * proved by inside the offer). Returns the link to send, the invitation's id
 * and, for an employee or a vendor, the id of the record it is for. The link
 * carries the token given (`opts.token`) when the caller made it, so the caller
 * can make the same link itself; a seat offered by address is taken up again
 * from the invitation kept before an earlier attempt (`opts.resume`), only for
 * the name, role, rights and address it was kept with. Refuses, before
 * anything is signed or sent: a seat whose role may not invite
 * (`SeatMayNotInvite`); a super admin, who is invited under the committee's
 * own rules and never by a seat; and, with `InvitationNotMade`, what the
 * invitee's device would refuse to open: a vendor with a salary or a
 * classification, a contractor as an employee, an end date before the start
 * date, a date that is not a calendar date.
 */
export async function inviteHere<K extends InvitationKind>(
  company: InvitingCompany, seat: InvitingSeat, kind: K, spec: InviteSpecs[K], origin: string, send: InvitationSend,
  byAddress?: K extends 'vendor' ? VendorByAddressDoors : SignerByAddressDoors, opts: InviteOptions = {},
): Promise<MadeInvitation> {
  if (opts.resume !== undefined && (kind !== 'signer' || (spec as SignerSpec).address === undefined)) {
    throw new InvitationNotMade('only a seat offered by address is taken up again from the invitation this device kept');
  }
  switch (kind) {
    case 'employee': {
      const made = await filePayeeInvitation(company, seat, spec as EmployeeSpec, send, opts.token);
      return { link: invitationLink(origin, made.token), id: made.id, person: made.person };
    }
    case 'vendor': {
      const made = await fileVendorInvitation(company, seat, spec as VendorSpec, send, byAddress as VendorByAddressDoors | undefined, opts.token);
      return { link: invitationLink(origin, made.token), id: made.id, person: made.person };
    }
    case 'signer': {
      const signer = spec as SignerSpec;
      if (signer.address !== undefined) {
        if (byAddress === undefined) throw new InvitationNotMade('this page cannot raise a seat offered by address: reload the page');
        return fileSignerByAddress(company, seat, signer as SignerSpec & { address: string }, origin, send, byAddress as SignerByAddressDoors, opts);
      }
      const made = await fileSignerInvitation(company, seat, signer, send, undefined, opts.token);
      return { link: invitationLink(origin, made.token), id: made.id };
    }
    case 'super-admin':
      throw new InvitationNotMade(SUPER_ADMIN_INVITED_BY_THE_COMMITTEE);
    default:
      throw new InvitationNotMade('it is none of the four kinds of invitation (an employee, a vendor, a signer or a super admin): choose one');
  }
}

/** An invitation this device opened: the token its link carried, the offer its inviter signed, and which kind it is. */
interface OpenedInvitation {
  readonly token: Hex;
  readonly signed: SignedOffer;
  readonly expiresAt: string;
  /** The kind the offer's own signed content says it is; a re-issued seat invitation is a signer's. */
  readonly kind: InvitationKind;
}

/** Refuses an offer past the expiry its inviter signed, on this device's clock, whatever the service says. */
const refuseAnExpiredOffer = (offer: InvitationOffer): void => {
  const why = offerExpiredRefusal(offer, Date.now());
  if (why !== null) throw new InvitationNotOpened(why);
};

/**
 * **AN INVITATION OPENED ON THE INVITEE'S DEVICE.** Believed only when the seat
 * that invited signed the offer, for the company's label and account it names.
 * Whether that seat is on that account, and its opening shows it was made for
 * the inviter's wallet key, is asked of the chain by the invitee's own wallet
 * before anything is signed for it.
 */
export async function openInvitationHere(link: string, send: InvitationSend): Promise<OpenedInvitation> {
  const token = tokenOfLink(link);
  if (token === null) throw new InvitationNotOpened('it is not a whole invitation link');
  const b = answered(await send(`/api/invites/${invitationIdOf(token)}/offer`, { method: 'GET' }), 200);
  const offer = b.offer as Sealed | undefined;
  if (offer === undefined || typeof b.expiresAt !== 'string') throw new InvitationNotOpened('the service sent no sealed offer');
  const signed = openOffer(offer, token);
  refuseAnExpiredOffer(signed.offer);
  /* A re-issue is kept by the service as a signer's invitation: it opens nothing on its own and names a seat already held. */
  const kind = signed.offer.for.kind === 'reissue' ? 'signer' : signed.offer.for.kind;
  if (kind !== b.kind) throw new InvitationNotOpened('it is not the kind of invitation the service says it is');
  return { token, signed, expiresAt: b.expiresAt, kind };
}

/**
 * **A PAYEE ACCEPTS, AN EMPLOYEE OR A VENDOR, HANDING OVER THEIR CODE.**
 * `code` is the one their own wallet signed for this company
 * (`askWalletForAJoinCode`), the same package a pasted code hands over; it is
 * sealed here to the inbox key the signed offer names and sent with the proof
 * only the token gives. Returns the fingerprint of the address they are paid
 * at, for them to read to whoever admits them. An employee added by a shielded
 * address accepts this way too, with a code for exactly that address; one added
 * by an unshielded address claims from their wallet instead (`claimIntentOf`).
 * Refuses a seat's offer, and a super admin's, which joins under the committee's
 * own rules.
 */
export async function acceptAsPayeeHere(opened: OpenedInvitation, code: JoinCode, send: InvitationSend): Promise<{ readonly fingerprint: string }> {
  const o = opened.signed.offer;
  if (o.for.kind === 'super-admin') throw new Error(SUPER_ADMIN_JOINS_BY_THE_COMMITTEE);
  if (o.for.kind !== 'employee' && o.for.kind !== 'vendor') throw new Error('that invitation offers a seat, not pay, so it is not accepted as a payee.');
  refuseAnExpiredOffer(o);
  if (code.parts.kind !== 'payee' || code.company !== o.label) {
    throw new Error('that code is not a payee\'s code for the company this invitation is from, so nothing was sent.');
  }
  const typed = o.for.kind === 'employee' ? (o.for as { address?: unknown }).address : undefined;
  if (typeof typed === 'string' && !typedAddressIsShielded(typed)) {
    throw new Error('this invitation was made by the public address you gave, so it is claimed from the wallet that holds that address, with no code to read out. Nothing was sent.');
  }
  if (typeof typed === 'string' && (code.parts as PayeeParts).address !== typed) {
    throw new Error('this invitation was made by the private address you gave, and the code names another address, so nothing was sent. Hand over a code for the address you gave.');
  }
  answered(await send(`/api/invites/${invitationIdOf(opened.token)}/accept-payee`, {
    method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(opened.token), handover: payeeHandoverOf(code, o.inboxPublicKey), kind: o.for.kind }),
  }), 201);
  return { fingerprint: payeeCodeFingerprint(code as JoinCode & { parts: PayeeParts }) };
}

/**
 * What a person or vendor added by an unshielded address asks their wallet to do (`claim-by-address`): the company,
 * its record, the invitation's token and the address that was typed. The wallet opens the inviter-signed offer itself
 * with the token and takes the inbox key, the record and the address from it; nothing here is trusted beyond naming
 * what to claim. Throws for an invitation not made by address, and for one made by a shielded address, which is
 * accepted with the wallet's code and the fingerprint read out (`acceptAsPayeeHere`).
 */
export function claimIntentOf(opened: OpenedInvitation): { readonly name: 'claim-by-address' } & Readonly<Record<string, string>> {
  const o = opened.signed.offer;
  refuseAnExpiredOffer(o);
  if (o.for.kind !== 'employee' && o.for.kind !== 'vendor') throw new Error('that invitation offers a seat, not pay, so it is not claimed as a payee.');
  const address = (o.for as { address?: unknown }).address;
  if (typeof address !== 'string') {
    throw new Error('this invitation was not made by an address, so it is accepted with your wallet\'s code and the fingerprint read out.');
  }
  if (typedAddressIsShielded(address)) {
    throw new Error('this invitation was made by a private address, so it is accepted with your wallet\'s code for that address and the fingerprint read out.');
  }
  return Object.freeze({
    name: 'claim-by-address' as const, company: o.label, account: String(o.account), record: o.company, token: opened.token, address,
  });
}

/** The company a signer's invitation was filed to, as the service holds it; null when it holds none. */
type FiledTo = { readonly id: string; readonly label: string | null; readonly account: string | null } | null;

/**
 * **WHY THIS DEVICE MAKES NO SEAT FOR AN OFFER**: the offer names another
 * company id, label or account than the company its seat request would be
 * filed to, so the leaf would be made for one company and the request sent to
 * another. Null when they are the same.
 */
const offerNotForTheCompanyRefusal = (o: SignedOffer['offer'], filedTo: FiledTo): string | null =>
  filedTo !== null && filedTo.id === o.company && filedTo.label === o.label
    && typeof filedTo.account === 'string' && filedTo.account.toLowerCase() === String(o.account).toLowerCase()
    ? null
    : 'this invitation names another company account or label than the company its seat request would be filed to, so no seat was made '
      + 'and nothing was sent. Ask the person who invited you for a new invitation.';

/** The company the service says this invitation was filed to, asked with the proof only the link gives. */
const filedToOf = async (opened: OpenedInvitation, send: InvitationSend): Promise<FiledTo> => {
  const b = answered(await send(`/api/invites/${invitationIdOf(opened.token)}/filed-to`, {
    method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(opened.token) }),
  }), 200);
  const c = b.company as Record<string, unknown> | null | undefined;
  return typeof c === 'object' && c !== null && typeof c.id === 'string'
    ? { id: c.id, label: typeof c.label === 'string' ? c.label : null, account: typeof c.account === 'string' ? c.account : null }
    : null;
};

/**
 * **A SIGNER ACCEPTS, THROUGH THE ONE SEAT PATH.** Their keys are made and kept
 * on this device (`doors.newKeys`, `doors.seal`), the leaf committing to the
 * wallet key their own wallet gives for the company the offer names
 * (`walletKey`, asked with the offer's label and account) - once the company
 * the seat request is filed to is the one the offer names
 * (`offerNotForTheCompanyRefusal`), and only for the person the invitation
 * names; the public halves, the leaf and its opening, the proof of their keys,
 * the name and role the offer gave them, and who the seat is for as the
 * inviting seat signed it are sealed here to the company's inbox key and filed
 * as the seat request.
 * Returns, with the seat, the fingerprint of the keys for the person to read
 * to whoever seats them. Refuses an offer of pay, and a super admin's, which
 * joins under the committee's own rules.
 */
export async function acceptAsSignerHere(
  opened: OpenedInvitation, commitments: LeafScheme, doors: Omit<SeatDoors, 'publish'>, send: InvitationSend,
  /** The sign-in accepting it: sealed into the request, and held to the member the company would make of it when it is seated. */
  person: string,
  /** The person's own wallet key for the company, asked of their wallet with the offer's label and account. */
  walletKey: (company: { readonly accountId: string; readonly label: CompanyLabel; readonly account: AccountAddress }) => Promise<WalletKey>,
): Promise<AcceptedSeat & { readonly fingerprint: string }> {
  const o = opened.signed.offer;
  if (o.for.kind === 'super-admin') throw new Error(SUPER_ADMIN_JOINS_BY_THE_COMMITTEE);
  if (o.for.kind !== 'signer') throw new Error('that invitation offers pay, not a seat, so it is not accepted as a signer.');
  refuseAnExpiredOffer(o);
  /* A seat goes to the person invited: a link opened under another sign-in makes no seat and sends nothing. */
  if (o.for.invited.terms.person !== person) {
    throw new Error('this invitation is for somebody else, so no seat was made and nothing was sent. Sign in as the person it '
      + 'was sent to, or ask whoever invited you for an invitation of your own.');
  }
  const notThisCompany = offerNotForTheCompanyRefusal(o, await filedToOf(opened, send));
  if (notThisCompany !== null) throw new Error(notThisCompany);
  const key = await walletKey({ accountId: o.company, label: o.label, account: o.account });
  const offer = o.for;
  let fingerprint = '';
  const seated = await acceptSeatOnThisDevice(o.company, commitments, {
    ...doors,
    /* The inviter's signed entry is kept with the material, for this person's first records-key ask. */
    /* And who the seat is for, kept until this person's own directory entry carries it. */
    seal: (seat) => doors.seal({ ...seat, invitedBy: o.inviter, invited: offer.invited }),
    publish: async (payload) => {
      /* Who the seat is for, as the seat that invited signed it, travels with the keys for every approving device to check. */
      const waiting: PendingSignerPayload = { name: offer.name, role: offer.role, ...payload, person, invited: offer.invited };
      fingerprint = seatRequestFingerprint(waiting);
      const b = answered(await send(`/api/invites/${invitationIdOf(opened.token)}/accept-signer`, {
        method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(opened.token), waiting: sealToInbox(waiting, o.inboxPublicKey) }),
      }), 201);
      if (typeof b.id !== 'string') throw new Error('the service did not say which seat request it filed, so this device cannot finish it.');
      return { id: b.id };
    },
  }, key, { accountId: o.company, nonce: offer.seat.nonce, secret: offer.seat.secret });
  return { ...seated, fingerprint };
}

/* ------------------------------------------------------------------ codes */

/** Thrown for a pasted code this device will not add anybody from; nothing was filed. */
export class CodeNotTaken extends Error {
  constructor(why: string) {
    super(`${why} Nothing was filed.`);
    this.name = 'CodeNotTaken';
  }
}

const codeFor = (text: string, company: InvitingCompany, kind: 'signer' | 'payee'): JoinCode => {
  const code = readJoinCode(text, company.label);
  if (typeof code === 'string') throw new CodeNotTaken(JOIN_CODE_REFUSAL[code]);
  if (code.parts.kind !== kind) {
    throw new CodeNotTaken(kind === 'signer' ? 'This is a code for being paid, not for a seat.' : 'This is a code for a seat, not for being paid.');
  }
  return code;
};

/**
 * **WHAT A PAYEE HANDS OVER, WHICHEVER WAY THEY JOIN**: their code, sealed to
 * the company's inbox key. Accepting a link hands it over from the payee's own
 * device; adding them from a pasted code hands over the same code from the
 * device that pasted it. An admitting device opens one package either way.
 */
export const payeeHandoverOf = (code: JoinCode, inboxPublicKey: Hex): SealedHandover => sealToInbox(code, inboxPublicKey);

/**
 * **A SIGNER'S CODE, MADE ON THEIR OWN DEVICE THROUGH THE ONE SEAT PATH.** The
 * keys are made and kept here (`doors`); their public halves and leaf go out
 * as a code their wallet signs (`sign`), with the leaf's opening beside it,
 * instead of as a seat request: the seat request is filed by whoever pastes
 * the code. Returns the code and the fingerprint the person reads to them.
 */
export async function makeSignerCodeHere(
  accountId: string, commitments: LeafScheme, doors: Omit<SeatDoors, 'publish' | 'promote'>,
  sign: (parts: SignerParts) => Promise<JoinCode>,
  /** The person's own wallet key for the company, as their wallet gave it: the key the seat's leaf commits to. */
  walletKey: WalletKey,
): Promise<{ readonly code: string; readonly fingerprint: string }> {
  let made: JoinCode | null = null;
  await acceptSeatOnThisDevice(accountId, commitments, {
    ...doors,
    publish: async (payload) => {
      const signed = await sign({ kind: 'signer', signingPublicKey: payload.signingPublicKey, wrappingPublicKey: payload.wrappingPublicKey, leafCommitment: payload.leafCommitment });
      /* The leaf's opening rides beside the signature: it proves itself against the leaf the wallet signed. */
      made = { ...signed, opening: payload.opening };
      return { id: null };
    },
    promote: async () => { throw new Error('a seat made for a code is bound to its seat once that seat is filed, not here.'); },
  }, walletKey);
  const code = made as JoinCode | null;
  if (code === null || code.parts.kind !== 'signer') throw new Error('the wallet made no code, so there is nothing to give.');
  return { code: writeJoinCode(code), fingerprint: seatKeyFingerprint(code.parts) };
}

/**
 * **A SIGNER ADDED FROM A CODE THEY GAVE.** This device checks the code's
 * signature and company, and that the opening beside it makes the code's leaf
 * for the wallet that signed the code (`walletKeyProvedBy`, with the leaf this
 * device's vault worker works out, `leaves`). It then makes a real invitation
 * for them through the same filing as a link (kept, listed with the company's
 * invitations, and spent by this seat request), signed for the sign-in the
 * code names and for the leaf it carries, and files the seat request a link's
 * acceptance files. Returns the seat request and the fingerprint to compare
 * with the one the person reads out.
 */
export async function addSignerFromCodeHere(
  company: InvitingCompany, seat: InvitingSeat, text: string, signer: { readonly name: string; readonly role: Role }, send: InvitationSend,
  /** The leaf each opening makes, worked out in this device's vault worker. */
  leaves: (openings: readonly SeatOpening[]) => Promise<readonly (string | null)[]>,
): Promise<{ readonly id: string; readonly fingerprint: string }> {
  refuseASeatThatMayNotInvite(seat);
  const code = codeFor(text, company, 'signer');
  const parts = code.parts as SignerParts;
  const keys = { signingPublicKey: parts.signingPublicKey, wrappingPublicKey: parts.wrappingPublicKey, leafCommitment: parts.leafCommitment };
  const opening = code.opening;
  const [leaf] = opening === undefined ? [null] : await leaves([opening]);
  const proved = walletKeyProvedBy(opening, parts.leafCommitment, () => leaf ?? null);
  if (opening === undefined || proved === null || proved.value.toLowerCase() !== code.committeeKey.value.toLowerCase()) {
    throw new CodeNotTaken('This code does not show that its seat is made for the wallet that signed it, so nobody can be added '
      + 'from it. Ask the person to make a new code.');
  }
  /* The invitation names the leaf the joiner's wallet signed, and the person it signed for. */
  const made = await fileSignerInvitation(company, seat, { ...signer, person: code.person }, send, parts.leafCommitment);
  /*
   * **THE PROOF HERE SAYS THIS DEVICE VOUCHED FOR EXACTLY THESE KEYS**, under
   * the invitation it has just made and holds the secret of: it does not say
   * the joiner made them. What ties the keys to the joiner is the code's
   * signature by their wallet, the opening that makes its leaf for that wallet,
   * and the fingerprint they read out, which the person adding them compares
   * with `fingerprint` below. The seat request is then the one a link's
   * acceptance files, and every seat has one invitation behind it.
   */
  const waiting: PendingSignerPayload = {
    name: signer.name, role: signer.role, ...keys, seatProof: proveSeatKeys(made.proved, keys), person: code.person,
    opening, invited: made.invited,
  };
  const b = answered(await send(`/api/invites/${made.id}/accept-signer`, {
    method: 'POST',
    body: JSON.stringify({ acceptance: acceptanceProofOf(made.token), waiting: sealToInbox(waiting, inboxOf(made.sealing.key, company.id)), for: code.person }),
  }), 201);
  if (typeof b.id !== 'string') throw new Error('the service did not say which seat request it filed.');
  return { id: b.id, fingerprint: seatKeyFingerprint(keys) };
}

/**
 * **AN EMPLOYEE ADDED FROM A CODE THEY GAVE.** Their first person record and a real
 * invitation are made and filed as for a link, and the invitation is accepted
 * here with their code as what they hand over. Admitting them is a separate
 * act. Returns the person and the fingerprint of the address they are paid at.
 */
export async function addPayeeFromCodeHere(
  company: InvitingCompany, seat: InvitingSeat, text: string, spec: EmployeeSpec, send: InvitationSend,
): Promise<{ readonly person: string; readonly fingerprint: string }> {
  const code = codeFor(text, company, 'payee');
  const made = await filePayeeInvitation(company, seat, spec, send);
  answered(await send(`/api/invites/${made.id}/accept-payee`, {
    method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(made.token), handover: payeeHandoverOf(code, inboxOf(made.sealing.key, company.id)), kind: 'employee' }),
  }), 201);
  return { person: made.person, fingerprint: payeeCodeFingerprint(code as JoinCode & { parts: PayeeParts }) };
}

/** Thrown when the fingerprint a joiner reads out is not the one of the keys about to be seated. */
export class FingerprintsDiffer extends Error {
  constructor() {
    super('The fingerprint the person read out is not the fingerprint of the keys about to be seated, so what reached this company is not what their device made. Do not seat them: ask them for a new code or a new link.');
    this.name = 'FingerprintsDiffer';
  }
}

/** The fingerprint of the keys a seat request would seat, as a device about to seat it works it out. */
export const seatRequestFingerprint = (waiting: Pick<PendingSignerPayload, 'signingPublicKey' | 'wrappingPublicKey' | 'leafCommitment'>): string =>
  seatKeyFingerprint(waiting);

/** Refuses unless the fingerprint the joiner read out, however typed, is the one of the keys about to be seated. */
export function refuseASeatWhoseFingerprintIsNotTheJoiners(
  waiting: Pick<PendingSignerPayload, 'signingPublicKey' | 'wrappingPublicKey' | 'leafCommitment'>, readOut: string,
): void {
  if (tidyFingerprint(readOut) !== seatRequestFingerprint(waiting)) throw new FingerprintsDiffer();
}

/* ------------------------------------------------------------------ an inviter who left */

/**
 * **THE SEAT HANDED TO A PERSON'S WALLET AS THEIR INVITER**: of the one this
 * device kept from the invitation it accepted (or a re-issue of it) and the
 * one the proposal that seated them carries, the first whose seat the account
 * holds now, as the person's own wallet read it (`onTheChain`); the kept one
 * when neither is. The wallet keeps the company's account only on a seat of it
 * (`whyTheInvitationDoesNotNameIt`), so an inviter who has left is passed over
 * for one who has not, and a person added from a code, who kept none, is
 * handed the seat that raised their proposal.
 */
export const inviterForTheWallet = (
  kept: Inviter | undefined, carried: Inviter | null, onTheChain: readonly string[],
): Inviter | undefined => {
  const held = (x: Inviter | null | undefined): x is Inviter =>
    x != null && typeof x.statement?.seat === 'string' && onTheChain.some((s) => s.toLowerCase() === x.statement.seat.toLowerCase());
  if (held(kept)) return kept;
  if (held(carried)) return carried;
  return kept ?? carried ?? undefined;
};

/** Who an invitation is re-issued for: their seat on the chain, and the company's proposals, which carry the one it replaces. */
interface Reissued {
  /** The seat the chain holds that the invitation is re-issued for. */
  readonly leaf: Hex;
  /** The company's proposals: the one that seated the leaf carries the invitation it replaces, read by that leaf. */
  readonly proposals: readonly (Pick<SealedProposal, 'accountId' | 'sealed'> & Partial<Pick<SealedProposal, 'keyEpoch'>>)[];
  /** Every seat the company's account holds now, as this person's own wallet read it. */
  readonly onTheChain: readonly string[];
}

/** The invitation the proposal seating `leaf` carried - one, read by the leaf - unless it is itself a re-issue. */
const replacedFor = (proposals: Reissued['proposals'], accountId: string, viewingKey: KeysHeld, leaf: string): SignedSeatInvitation | null => {
  const original = seatInvitationIn(proposals, accountId, viewingKey, leaf);
  return original === null || original.terms.replaces !== undefined ? null : original;
};

/**
 * **AN INVITATION RE-ISSUED FROM THIS DEVICE FOR A PERSON WHOSE INVITER LEFT.**
 * For somebody the chain already seats: the invitation their seat was proposed
 * under - the one the proposal that seated their leaf carries, read by that
 * leaf - is signed again by this seat, for the same person, name and role and
 * the same leaf, naming the invitation it replaces, under a new link, with
 * this seat as their inviter. Their
 * device keeps both in place of what it kept (`takeTheReissueHere`), so their
 * wallet keeps the company's account on a seat it holds, and their own entry
 * carries an invitation from a seat not retired. Refused before anything is
 * signed when this seat may not invite, when the invitation names no leaf or
 * another company, or when the chain does not hold that leaf now.
 */
export async function reissueInvitationHere(
  company: InvitingCompany, seat: InvitingSeat, reissued: Reissued, origin: string, send: InvitationSend,
): Promise<MadeInvitation> {
  refuseASeatThatMayNotInvite(seat);
  const original = replacedFor(reissued.proposals, company.id, company.viewingKey, reissued.leaf);
  const t = original?.terms;
  if (original === null || t === undefined || seatInvitationRefusal(original) !== null || t.company !== company.id || t.leaf?.toLowerCase() !== reissued.leaf.toLowerCase()) {
    throw new SeatMayNotInvite('The proposal that seated this person does not carry an invitation a signer made for them, so it cannot be sent again. Invite them again.');
  }
  const leaf = t.leaf;
  if (!reissued.onTheChain.some((x) => x.toLowerCase() === leaf.toLowerCase())) {
    throw new SeatMayNotInvite('The seat that invitation names is not one the company\'s account holds now, so it is not re-issued: '
      + 'somebody waiting for a seat is withdrawn and invited again instead.');
  }
  const sealing = sealingWith(company.viewingKey, company.keyEpoch);
  const token = newInvitationToken();
  /* Exactly the person, name, role and seat the signers approved, and the invitation it replaces, for every member's device to hold it to. */
  const invited = signSeatInvitation({
    company: company.id, invitation: invitationIdOf(token), person: t.person, name: t.name, role: t.role, leaf,
    replaces: { invitation: t.invitation, signedBy: original.signedBy, signature: original.signature },
  }, seat.signingSecret);
  const invitation = await filed(company, seat, 'signer', { kind: 'reissue', name: t.name, role: t.role, invited }, sealing, token, send);
  return { link: invitationLink(origin, token), id: invitation.id };
}

/**
 * **A RE-ISSUED INVITATION, TAKEN ON THE PERSON'S OWN DEVICE.** Taken only for
 * the person signed in and for this device's own seat: the seat that signed it
 * and the invitation are kept together (`keep`), in place of the inviter and
 * invitation this device kept, for their wallet's next records-key ask and
 * their own directory entry. Nothing is sent.
 */
export async function takeTheReissueHere(
  opened: OpenedInvitation, mine: { readonly accountId: string; readonly person: string; readonly seat: string; readonly viewingKey: KeysHeld },
  /** The company's proposals: the one that seated this device's seat carries the invitation the re-issue must replace. */
  proposals: Reissued['proposals'],
  keep: (reissued: { readonly inviter: Inviter; readonly invited: SignedSeatInvitation }) => Promise<void>,
): Promise<void> {
  const o = opened.signed.offer;
  if (o.for.kind !== 'reissue') throw new Error('that invitation does not re-issue an invitation for a seat, so nothing was kept.');
  const t = o.for.invited.terms;
  if (o.company !== mine.accountId || t.person !== mine.person) {
    throw new Error('that re-issued invitation is for somebody else, or another company, so nothing was kept. Sign in as the person it was sent to.');
  }
  if (t.leaf?.toLowerCase() !== mine.seat.toLowerCase()) {
    throw new Error('that re-issued invitation names another seat than the one this device holds for you, so nothing was kept.');
  }
  /* Only exactly the invitation your seat was proposed under, signed again: the same person, name, role and seat. */
  const original = replacedFor(proposals, mine.accountId, mine.viewingKey, mine.seat);
  const replaced = replacedBy(o.for.invited);
  if (original === null || replaced === null || canonical(replaced) !== canonical(original)) {
    throw new Error('that re-issued invitation is not the one your seat was proposed under, for the same name and role, so nothing was kept. '
      + 'Ask the signer who sent it to re-issue it again.');
  }
  await keep({ inviter: o.inviter, invited: o.for.invited });
}

/* ------------------------------------------------------------------ withdrawing somebody waiting */

/** What this device reads to withdraw a seat request: the company's inbox and proposals, and the chain's seats now. */
interface WaitingReads {
  readonly sealed: SealedAccount;
  readonly proposals: readonly SealedProposal[];
  /** Every seat the company's account holds now, as this person's own wallet read it. */
  readonly onTheChain: readonly string[];
  /** The ids of every proposal the company's account holds open now, approved or not, as this device's own read of the chain gives them. */
  readonly openOnTheChain: readonly string[];
}

/**
 * **SOMEBODY WAITING FOR A SEAT, WITHDRAWN FROM THIS DEVICE**, so the same
 * person can accept a new invitation. The request is opened here with any
 * key of the company this device holds, so one sealed before the key changed
 * is withdrawn too, and refused - before anything is signed - while the chain
 * holds its leaf, or holds a proposal to seat it open (as this device's own
 * read of the chain says, never the service), since either may still seat it:
 * that proposal is withdrawn first. The withdrawal names the request, the
 * invitation it answered and its leaf, signed by this seat's filing key; the
 * service lets the request go only while the chain holds this seat and not
 * that leaf.
 */
export async function withdrawWaitingSignerHere(
  company: Pick<InvitingCompany, 'id' | 'viewingKey'>, seat: Pick<InvitingSeat, 'signingSecret' | 'held' | 'statement'>, signerId: string,
  reads: WaitingReads, send: InvitationSend,
): Promise<void> {
  refuseASeatThatMayNotInvite(seat);
  if (!reads.onTheChain.some((x) => x.toLowerCase() === seat.statement.seat.toLowerCase())) {
    throw new SeatMayNotInvite('Your seat is not one the company\'s account holds now, so it withdraws nobody.');
  }
  const box = reads.sealed.pendingSigners.find((p) => p.id === signerId);
  if (box === undefined) throw new Error('That person is no longer waiting for a seat. Reload the page. Nothing was signed or sent.');
  /* Any key this device holds reads which invitation a request answers: withdrawing one believes nothing in it. */
  const waiting = openedWithAnyKey(company.viewingKey, (key) => openFromInbox<PendingSignerPayload>(box.sealed, company.id, key));
  const invitation = waiting.invited?.terms.invitation;
  if (invitation === undefined) {
    throw new Error('This seat request names no invitation, so it cannot be withdrawn by its invitation. Nothing was signed or sent.');
  }
  if (reads.onTheChain.some((x) => x.toLowerCase() === waiting.leafCommitment.toLowerCase())) {
    throw new Error('The chain already holds this person\'s seat, so they are not withdrawn: they are admitted, or removed by '
      + 'a removal. Nothing was signed or sent.');
  }
  if (seatStillProposedFor(reads.proposals, company.id, company.viewingKey, signerId, reads.openOnTheChain)) {
    throw new Error('A proposal to seat this person is still open, and could still seat them. Withdraw that proposal first. '
      + 'Nothing was signed or sent.');
  }
  /* The leaf travels with it, so the service lets nothing go once its own read of the chain shows that leaf seated. */
  const withdrawal = signWithdrawal({ company: company.id, signerId, invitation, leaf: waiting.leafCommitment }, seat.signingSecret);
  answered(await send(`/api/accounts/${encodeURIComponent(company.id)}/signers/${encodeURIComponent(signerId)}/withdraw`, {
    method: 'POST', body: JSON.stringify({ withdrawal }),
  }), 200);
}

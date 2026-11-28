/**
 * **INVITING SOMEBODY ON THE PERSON'S OWN DEVICE.** Each step is one
 * function a screen can call.
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
 *   Taking an invitation (opening it, accepting it, making a signer's code,
 *   and keeping a re-issued one) is on the invitee's device, in
 *   `invitation-taken-on-device.ts`. Re-issuing one for a person whose
 *   inviter left (`reissueInvitationHere`) is here, beside inviting.
 */
import { sealingWith, type KeysHeld } from '../../../src/core/company-key.js';
import { keysByPurpose } from './keys-by-purpose.js';
import { canonical, randomBytes, signingPublicKeyOf, toHex, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { inboxPublicKey as inboxOf } from '../../../src/core/sealed-records.js';
import { sealPerson } from '../../../src/core/person-record.js';
import {
  openVendor,
  sealVendor,
  vendorTermsRefusal,
  type VendorRecord,
  type VendorTerms
} from '../../../src/core/vendor-record.js';
import { assets as defaultAssets, whyTheMoneyCannotReach, type AssetId } from '../../../src/core/assets.js';
import { invitationSecret, newSeatInvitation, type SeatInvitation } from '../../../src/core/seat-invite-proof.js';
import {
  acceptanceHashOf,
  acceptanceProofOf,
  INVITATION_LIFETIME_MS,
  invitationIdOf,
  invitationLink,
  invitationProposalSalt,
  invitationThresholdRefusal,
  newInvitationToken,
  offerExpiredRefusal,
  openOffer,
  seatByAddressChangeOf,
  type ProposalIdentityOf,
  sealOffer,
  seatInvitationRefusal,
  signInvitationFiling,
  signOffer,
  signSeatInvitation,
  SUPER_ADMIN_INVITED_BY_THE_COMMITTEE,
  utcMomentOf,
  whyThisOfferCannotBeMade,
  type EmployeeClassification,
  type EmployeeOffer,
  type InvitationFiling,
  type InvitationKind,
  type InvitationOffer,
  type Inviter,
  type SignedOffer,
  type SeatInvitationAddress,
  type SignedSeatInvitation,
  type VendorOffer
} from '../../../src/core/invitation.js';
import type { Role, RosterEmployee, SealedProposal } from '../../../src/core/types.js';
import { seatInvitationIn } from '../../../src/core/proposal-filing.js';
import { mayInvite } from '../../../src/midnight/seat-directory.js';
import { isSignerRole } from '../../../src/core/roles.js';
import {
  NO_VAULT_COUNTED,
  scopeOfRole,
  seatScopeRefusal,
  vaultsOfferedRefusal,
  vaultsRefusal
} from '../../../src/core/seat-rights.js';
import type { SeatRights } from '../../../src/core/vault-approvers.js';
import {
  fromCompanyWire,
  toCompanyWire,
  verifiedCompanyFiler,
  type SealedCompanyRecord
} from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordEntry, signedWithItsEntry } from '../../../src/midnight/record-manifest.js';
import type { CompanyWrites, RecordWrite } from './records-source.js';
import { FiledNotEntered, type RecordsEntered } from './record-entered-here.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { checkShieldedAddress } from 'midnight-identity/wallet/address-shape';
import type { NetworkName } from '../../../src/midnight/network.js';
import type { VendorsHere } from './vendors-on-device.js';

/** How this device reaches the service: a path and a JSON body, an answer with its status. */
export type InvitationSend = (
  path: string,
  init: { readonly method: 'GET' | 'POST' | 'PUT'; readonly body?: string }
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
   * This seat as this device's own read of the company's directory holds it: its signer role, whether a quorum
   * retired it, and the rights it was seated with. Only a seat not retired whose role may file a proposal invites a
   * signer, re-issues an invitation or withdraws somebody waiting (`mayInvite`), offering only vaults within its own
   * (`vaultsOfferedRefusal`), and a seat this device cannot say that of does none of them; every member's device
   * refuses what any other seat signs. A payee's invitation does not ask it.
   */
  readonly held?: { readonly role: Role | null; readonly retired: boolean; readonly rights: SeatRights };
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
  constructor(
    readonly status: number,
    readonly refused: string | null,
    said: string
  ) {
    super(said);
    this.name = 'InvitationRefused';
  }
}

export const answered = (r: { status: number; body: unknown }, ok: number): Record<string, unknown> => {
  const b = (r.body ?? {}) as Record<string, unknown>;
  if (r.status !== ok) {
    throw new InvitationRefused(
      r.status,
      typeof b.refused === 'string' ? b.refused : null,
      typeof b.error === 'string'
        ? b.error
        : `the service answered ${r.status} and said nothing, so nothing is known to have been kept.`
    );
  }
  return b;
};

/**
 * One write of the company's, a refusal by the service thrown as `InvitationRefused` with its status, why it refused and
 * what it said, as an answer to a send of the invitation's own is (`answered`); anything else is thrown as it came.
 */
export const writtenOrRefused = async (writes: CompanyWrites, company: string, w: RecordWrite): Promise<unknown> => {
  try {
    return await writes(company, w);
  } catch (e) {
    const told = e as { readonly status?: unknown; readonly refused?: unknown; readonly error?: unknown } | null;
    if (told === null || typeof told !== 'object' || typeof told.status !== 'number') throw e;
    throw new InvitationRefused(
      told.status,
      typeof told.refused === 'string' ? told.refused : null,
      typeof told.error === 'string'
        ? told.error
        : `the service answered ${told.status} and said nothing, so nothing is known to have been kept.`
    );
  }
};

/** Thrown, before anything is signed or sent, by a seat that may not invite, re-issue or withdraw. */
export class SeatMayNotInvite extends Error {
  constructor(why: string) {
    super(`${why} Nothing was signed or sent.`);
    this.name = 'SeatMayNotInvite';
  }
}

/** Refused, with nothing signed, when this seat would offer vaults beyond its own (`vaultsOfferedRefusal`); `instead` says what else clears it. */
export const refuseVaultsBeyondTheSeat = (
  seat: Pick<InvitingSeat, 'held'>,
  vaults: readonly Hex[] | undefined,
  instead = ''
): void => {
  const why = vaultsOfferedRefusal(seat.held?.rights ?? NO_VAULT_COUNTED, vaults);
  if (why !== null) throw new SeatMayNotInvite(`This invitation was not made: ${why}${instead}.`);
};

/** Refuses unless this device's seat is one not retired whose role may file a proposal: the one rule every member's device holds it to. */
export const refuseASeatThatMayNotInvite = (seat: Pick<InvitingSeat, 'held'>): void => {
  if (seat.held === undefined) {
    throw new SeatMayNotInvite(
      "This device has not read your seat's role from the company's directory, so it invites and withdraws nobody. Reload the page."
    );
  }
  if (seat.held.retired)
    throw new SeatMayNotInvite('Your seat has been retired from this company, so it invites and withdraws nobody.');
  if (!mayInvite({ role: seat.held.role })) {
    throw new SeatMayNotInvite(
      'Your role on this company may not file a proposal, so it invites and withdraws nobody. Ask a signer whose role may.'
    );
  }
};

/** The company's key an invitation is made under: one sealing, refused while the company's key is being changed. */
type Sealing = { readonly key: Hex; readonly epoch: number };

/**
 * The offer an invitation carries. Its inbox is worked out here from the key in force, never copied from the service,
 * and it says when it was made and when it stops being answered, signed with the rest of the offer.
 */
const offered = (
  company: InvitingCompany,
  seat: InvitingSeat,
  forWhom: InvitationOffer['for'],
  sealing: Sealing
): InvitationOffer => ({
  company: company.id,
  companyName: company.name,
  label: company.label,
  account: company.account,
  inboxPublicKey: inboxOf(sealing.key, company.id),
  expiresAt: Date.now() + INVITATION_LIFETIME_MS,
  madeAt: utcMomentOf(Date.now()),
  for: forWhom,
  /* The inviter's own seat's opening, so the invitee's wallet can tell the seat was made for its key; nothing of any other seat. */
  inviter: { committeeKey: seat.committeeKey, statement: seat.statement, opening: seat.opening }
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
  company: InvitingCompany,
  seat: InvitingSeat,
  kind: InvitationKind,
  forWhom: InvitationOffer['for'],
  sealing: Sealing,
  token: Hex,
  writes: CompanyWrites,
  person?: string,
  record?: ReturnType<typeof toCompanyWire>,
  signed?: SignedOffer
): Promise<InvitationFiling> {
  const offer = signed?.offer ?? offered(company, seat, forWhom, sealing);
  const why = whyThisOfferCannotBeMade(offer);
  if (why !== null) throw new InvitationNotMade(why);
  const invitation = signInvitationFiling(
    {
      company: company.id,
      kind,
      id: invitationIdOf(token),
      acceptanceHash: acceptanceHashOf(acceptanceProofOf(token)),
      offer: sealOffer(signed ?? signOffer(offer, seat.signingSecret), token),
      keyEpoch: sealing.epoch,
      ...(person === undefined ? {} : { person })
    },
    seat.signingSecret
  );
  await writtenOrRefused(writes, company.id, {
    to: 'invitation',
    body: record === undefined ? { invitation } : { person: record, invitation }
  });
  return invitation;
}

/** Who an employee is, what they are paid and when they work, as the person inviting them enters it. */
export interface EmployeeSpec {
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
  /** The vaults the seat's rights name, at most four; every vault when left out. Its rights are its role's on them. */
  readonly vaults?: readonly Hex[];
  /**
   * For a seat offered by address: the approvals the account needs once the seat is taken, as digits. Left out, the
   * threshold in force is kept. The signed invitation names it and the proposal binds it.
   */
  readonly threshold?: string;
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
  readonly commitments: { inviteAddressOf(coinPublicKey: Hex, salt: Hex): Hex };
  readonly held: (coinPublicKey: Hex, except?: string) => Promise<string | null>;
  readonly identity: ProposalIdentityOf;
  readonly raise: (input: {
    readonly invited: SignedSeatInvitation;
    readonly proposalSalt: string;
    readonly name: string;
    readonly inviter: Inviter;
    readonly coinPublicKey: Hex;
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
  constructor(
    readonly link: string,
    why: string
  ) {
    super(
      `the proposal to seat this address was raised, and the invitation was not filed: ${why}. Give the person this link yourself: it is the only copy.`
    );
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
export async function filePayeeInvitation(
  company: InvitingCompany,
  seat: InvitingSeat,
  spec: EmployeeSpec,
  writes: CompanyWrites,
  given?: Hex
): Promise<{ token: Hex; id: Hex; person: string; sealing: Sealing }> {
  refuseASeatThatMayNotInvite(seat);
  if (typeof spec.baseAmount !== 'bigint' || spec.baseAmount <= 0n)
    throw new InvitationNotMade("an employee is invited with a pay above nothing, in the token's smallest unit");
  const made = { madeBy: signingPublicKeyOf(seat.signingSecret), madeAt: utcMomentOf(Date.now()) };
  const person: RosterEmployee = {
    id: `emp_${toHex(randomBytes(10))}`,
    accountId: company.id,
    name: spec.name,
    email: spec.email,
    title: spec.title,
    asset: spec.asset,
    baseAmount: spec.baseAmount,
    startDate: spec.startDate,
    status: 'pending',
    wrappingPublicKey: null,
    handedOverBy: null,
    admittedBy: null,
    admittedAt: null,
    selfRaised: false,
    address: null,
    ...(spec.endDate === undefined ? {} : { endDate: spec.endDate }),
    pay: [{ amount: spec.baseAmount, from: spec.startDate, ...made }],
    classifications: [{ classification: spec.classification, from: spec.startDate, ...made }],
    ...(spec.address === undefined ? {} : { invitedAddress: spec.address }),
    ...made
  };
  const sealing = sealingWith(company.viewingKey, company.keyEpoch);
  const offer: EmployeeOffer = {
    kind: 'employee',
    person: person.id,
    name: spec.name,
    title: spec.title,
    email: spec.email,
    asset: spec.asset,
    baseAmount: spec.baseAmount,
    startDate: spec.startDate,
    classification: spec.classification,
    ...(spec.endDate === undefined ? {} : { endDate: spec.endDate }),
    ...(spec.address === undefined ? {} : { address: spec.address })
  };
  const token = tokenFor(given);
  const signed = signedWithItsEntry(sealPerson(person, 1, sealing.epoch, sealing.key), seat.signingSecret);
  const invitation = await filed(
    company,
    seat,
    'employee',
    offer,
    sealing,
    token,
    writes,
    person.id,
    toCompanyWire(signed)
  );
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
  company: InvitingCompany,
  seat: InvitingSeat,
  spec: VendorSpec,
  writes: CompanyWrites,
  doors?: VendorByAddressDoors,
  given?: Hex
): Promise<{ token: Hex; id: Hex; person: string }> {
  refuseASeatThatMayNotInvite(seat);
  const sealing = sealingWith(company.viewingKey, company.keyEpoch);
  const { terms: _terms, network: _network, ...forTheOffer } = spec;
  const offer: VendorOffer = {
    kind: 'vendor',
    person: `ven_${toHex(randomBytes(10))}`,
    name: spec.name,
    email: spec.email,
    startDate: spec.startDate,
    ...(spec.endDate === undefined ? {} : { endDate: spec.endDate }),
    ...(spec.address === undefined ? {} : { address: spec.address })
  };
  /* What the screen passed is the offer's, field for field, so a salary or a classification it carried is refused, not dropped. */
  const asOffered = { ...(forTheOffer as object), ...offer } as VendorOffer;
  const vendor = vendorAddedHere(company, spec, offer.person, {
    madeBy: signingPublicKeyOf(seat.signingSecret),
    madeAt: utcMomentOf(Date.now())
  });
  if (vendor.address !== null) await refuseAnAddressAVendorHolds(vendor.address.bech32, doors);
  const token = tokenFor(given);
  const signed = signedWithItsEntry(sealVendor(vendor, 1, sealing.epoch, sealing.key), seat.signingSecret);
  const invitation = await filed(
    company,
    seat,
    'vendor',
    asOffered,
    sealing,
    token,
    writes,
    offer.person,
    toCompanyWire(signed)
  );
  await seat.entered.enter([companyRecordEntry(signed)]);
  return { token, id: invitation.id, person: offer.person };
}

/** The one reading of an address into where a payee is paid, for people and vendors alike. */
export { payeeAt } from '../../../src/core/payee-keys.js';
import { payeeAt } from '../../../src/core/payee-keys.js';

/** Refuses `address` when an active vendor entry this device believes is already paid there: one vendor gets one entry. */
const refuseAnAddressAVendorHolds = async (address: string, doors: VendorByAddressDoors | undefined): Promise<void> => {
  if (doors === undefined) {
    throw new InvitationNotMade(
      "this page cannot read the company's vendors, so it cannot say no vendor is already paid at this address, and adds nobody by address: reload the page"
    );
  }
  const read = await doors.vendors();
  const holder = [...read.vendors.map((v) => v.vendor), ...read.notPayable.map((n) => n.here.vendor)].find(
    (v) => v.status === 'active' && v.address !== null && v.address.bech32.toLowerCase() === address.toLowerCase()
  );
  if (holder !== undefined) {
    throw new InvitationNotMade(
      `${holder.name} is already a vendor of this company paid at this address, and one vendor gets one entry, or they ` +
        'are paid twice. Change their entry, or mark it a leaver first'
    );
  }
};

/** A vendor's first entry, or a refusal saying what to put right. Added by address, it pays the typed address at once. */
const vendorAddedHere = (
  company: InvitingCompany,
  spec: VendorSpec,
  id: string,
  made: { readonly madeBy: Hex; readonly madeAt: string }
): VendorRecord => {
  let address: VendorRecord['address'] = null;
  if (spec.address !== undefined) {
    try {
      address = payeeAt(spec.address, spec.network);
    } catch (e) {
      throw new InvitationNotMade(
        `the address typed is not one money can be sent to on this network (${(e as Error).message})`
      );
    }
    if (spec.terms?.kind === 'monthly') {
      let unreachable: string | null;
      try {
        unreachable = whyTheMoneyCannotReach(defaultAssets.require(spec.terms.asset), address.kind);
      } catch (e) {
        unreachable = (e as Error).message;
      }
      if (unreachable !== null)
        throw new InvitationNotMade(`their monthly payments could not reach the address typed: ${unreachable}`);
    }
  }
  const vendor: VendorRecord = {
    id,
    accountId: company.id,
    name: spec.name,
    email: spec.email,
    network: spec.network,
    startDate: spec.startDate,
    ...(spec.endDate === undefined ? {} : { endDate: spec.endDate }),
    terms: spec.terms,
    status: address === null ? 'pending' : 'active',
    address,
    wrappingPublicKey: null,
    handedOverBy: null,
    admittedBy: null,
    admittedAt: null,
    ...(spec.address === undefined ? {} : { invitedAddress: spec.address }),
    ...made
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
export async function fileSignerInvitation(
  company: InvitingCompany,
  seat: InvitingSeat,
  signer: SignerSpec,
  writes: CompanyWrites,
  leaf?: Hex,
  given?: Hex
): Promise<{ token: Hex; id: Hex; proved: SeatInvitation; invited: SignedSeatInvitation; sealing: Sealing }> {
  refuseASeatThatMayNotInvite(seat);
  refuseVaultsBeyondTheSeat(seat, signer.vaults);
  const sealing = sealingWith(company.viewingKey, company.keyEpoch);
  const token = tokenFor(given);
  const proved = newSeatInvitation(sealing.key, company.id, signer.name, signer.role, invitationIdOf(token));
  const invited = signSeatInvitation(
    {
      company: company.id,
      invitation: invitationIdOf(token),
      person: signer.person,
      name: signer.name,
      role: signer.role,
      ...(signer.vaults === undefined ? {} : { vaults: signer.vaults }),
      ...(leaf === undefined ? {} : { leaf })
    },
    seat.signingSecret
  );
  const invitation = await filed(
    company,
    seat,
    'signer',
    {
      kind: 'signer',
      name: signer.name,
      role: signer.role,
      seat: { nonce: proved.nonce, secret: proved.secret },
      invited
    },
    sealing,
    token,
    writes
  );
  return { token, id: invitation.id, proved, invited, sealing };
}

/**
 * **A SEAT OFFERED BY THE ADDRESS THE INVITER TYPED, RAISED BEFORE ANYBODY ACCEPTS.** A wallet already seated here,
 * or already invited by a proposal still open, is refused first (`doors.held`). The address's coin key is
 * committed to under a fresh salt; the proposal's identity is worked out first, under the salt the invitation's own
 * terms and this seat's filing key make (`invitationProposalSalt`), so the signed invitation names the commitment,
 * the seat's rights, the threshold it sets once taken (where one is asked) and the proposal, and that proposal
 * commits to the whole invitation; the proposal is raised with this seat's
 * approval, carrying the coin key sealed; and only then is the offer filed, carrying the address, the proposal's salt
 * and the signed invitation, so the invitee's wallet can take the seat itself. Before the raise, this device keeps the
 * token and the offer it signed (`doors.keep`); nothing is raised when it cannot. If the filing fails after the raise,
 * the link is handed back in the error: this device holds it, and nothing the seat needs exists only at the service.
 * Taken up again with the invitation kept (`resume`), it raises and files that same invitation, never a new one, and
 * only for the same ask (`resumeSignerByAddress`).
 */
/** The scope a seat offered at `signer.role` on `signer.vaults` commits to; refused for a role no signer holds. */
const rightsScopeOffered = (signer: Pick<SignerSpec, 'role' | 'vaults'>): Hex => {
  if (!isSignerRole(signer.role))
    throw new InvitationNotMade(seatScopeRefusal(signer.role, signer.vaults, '') ?? 'that role holds no seat');
  const why = vaultsRefusal(signer.vaults);
  if (why !== null) throw new InvitationNotMade(why);
  return scopeOfRole(signer.role, signer.vaults);
};

async function fileSignerByAddress(
  company: InvitingCompany,
  seat: InvitingSeat,
  signer: SignerSpec & { readonly address: string },
  origin: string,
  writes: CompanyWrites,
  doors: SignerByAddressDoors,
  opts: InviteOptions = {}
): Promise<MadeInvitation> {
  refuseASeatThatMayNotInvite(seat);
  let coinPublicKey: Hex;
  try {
    coinPublicKey = String(
      checkShieldedAddress(signer.address, doors.network as never).coinPublicKey
    ).toLowerCase() as Hex;
  } catch (e) {
    throw new InvitationNotMade(`the address is not a private address on this network (${(e as Error).message})`);
  }
  if (opts.resume !== undefined)
    return resumeSignerByAddress(company, seat, signer, coinPublicKey, writes, doors, opts);
  const held = await doors.held(coinPublicKey);
  if (held !== null) throw new InvitationNotMade(held);
  const addressSalt = toHex(randomBytes(32));
  const scope = rightsScopeOffered(signer);
  const threshold = signer.threshold;
  if (threshold !== undefined && invitationThresholdRefusal(threshold) !== null) {
    throw new InvitationNotMade(
      'the approvals needed once the seat is taken must be a whole number of at least one: leave it out to keep the number in force'
    );
  }
  const invite: SeatInvitationAddress = {
    address: doors.commitments.inviteAddressOf(coinPublicKey, addressSalt).toLowerCase() as Hex,
    salt: addressSalt,
    scope,
    ...(threshold === undefined ? {} : { threshold })
  };
  const token = tokenFor(opts.token);
  const terms = {
    company: company.id,
    invitation: invitationIdOf(token),
    person: `adr_${toHex(randomBytes(10))}`,
    name: signer.name,
    role: signer.role,
    ...(signer.vaults === undefined ? {} : { vaults: signer.vaults }),
    invite
  };
  const proposalSalt = invitationProposalSalt({ terms, signedBy: signingPublicKeyOf(seat.signingSecret) });
  const { chainId } = await doors.identity(seatByAddressChangeOf(invite), proposalSalt);
  const sealing = sealingWith(company.viewingKey, company.keyEpoch);
  const proved = newSeatInvitation(sealing.key, company.id, signer.name, signer.role, terms.invitation);
  const invited = signSeatInvitation({ ...terms, proposal: chainId.toLowerCase() as Hex }, seat.signingSecret);
  const inviter: Inviter = { committeeKey: seat.committeeKey, statement: seat.statement, opening: seat.opening };
  const forWhom: InvitationOffer['for'] = {
    kind: 'signer',
    name: signer.name,
    role: signer.role,
    seat: { nonce: proved.nonce, secret: proved.secret },
    invited,
    byAddress: { address: signer.address, proposalSalt }
  };
  const unsigned = offered(company, seat, forWhom, sealing);
  const why = whyThisOfferCannotBeMade(unsigned);
  if (why !== null) throw new InvitationNotMade(why);
  const offer = signOffer(unsigned, seat.signingSecret);
  const link = invitationLink(origin, token);
  await doors.keep({ company: company.id, id: invitationIdOf(token), token, link, offer });
  await doors.raise({ invited, proposalSalt, name: signer.name, inviter, coinPublicKey });
  try {
    const invitation = await filed(
      company,
      seat,
      'signer',
      forWhom,
      sealing,
      token,
      writes,
      undefined,
      undefined,
      offer
    );
    return { link, id: invitation.id };
  } catch (e) {
    throw new InvitationRaisedNotFiled(link, (e as Error).message);
  }
}

const KIND_SAID: Readonly<Record<string, string>> = {
  employee: 'an employee',
  vendor: 'a vendor',
  signer: 'a signer',
  'super-admin': 'a super admin',
  reissue: 'a re-issued seat invitation'
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
 * offer and on the invitation it signs, the address it is offered at, the vaults its rights name (`spec.vaults`, or every
 * vault) and the threshold it sets once taken (none on both sides keeps the one in force). Returns null for the same ask, or why it is not, naming what resolves it; no value is repeated.
 */
export function firstAskRefusal<K extends InvitationKind>(
  first: InvitationOffer['for'],
  kind: K,
  spec: InviteSpecs[K]
): string | null {
  if (first.kind !== kind) {
    return `the invitation already made under this link is for ${KIND_SAID[first.kind] ?? 'another kind'}, not ${KIND_SAID[kind] ?? 'this kind'}: ${SAME_ASK}`;
  }
  const s = spec as unknown as Record<string, unknown>;
  const f = first as unknown as Record<string, unknown>;
  let pairs: readonly (readonly [string, unknown, unknown])[];
  if (first.kind === 'employee') {
    pairs = [
      ['name', f.name, s.name],
      ['title', f.title, s.title],
      ['email', f.email ?? null, s.email ?? null],
      ['currency', f.asset, s.asset],
      ['pay', f.baseAmount, s.baseAmount],
      ['start date', f.startDate, s.startDate],
      ['end date', f.endDate, s.endDate],
      ['classification', f.classification, s.classification],
      ['address', f.address, s.address]
    ];
  } else if (first.kind === 'vendor') {
    pairs = [
      ['name', f.name, s.name],
      ['email', f.email ?? null, s.email ?? null],
      ['start date', f.startDate, s.startDate],
      ['end date', f.endDate, s.endDate],
      ['address', f.address, s.address]
    ];
  } else if (first.kind === 'signer') {
    const t = first.invited.terms;
    pairs = [
      ['name', first.name, s.name],
      ['name', t.name, s.name],
      ['role', first.role, s.role],
      ['role', t.role, s.role],
      ['address', lower(first.byAddress?.address), lower(s.address)],
      ['rights', t.vaults ?? null, (s.vaults as readonly Hex[] | undefined)?.map((v) => v.toLowerCase()) ?? null],
      ['threshold', t.invite?.threshold, s.threshold]
    ];
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
  sealed: unknown,
  token: Hex,
  company: string,
  kind: K,
  spec: InviteSpecs[K],
  o: { readonly kept?: KeptSeatInvitation } = {}
): { readonly refused: string } | { readonly filed: SignedOffer } {
  let signed: SignedOffer;
  try {
    signed = openOffer(sealed as Sealed, token);
  } catch (e) {
    return {
      refused: `the invitation filed under this link does not open with it (${(e as Error).message}), so it is not taken as this one: start a new invitation, which has a new link`
    };
  }
  if (signed.offer.company !== company) {
    return {
      refused:
        "the invitation filed under this link is another company's, so it is not taken as this one: start a new invitation, which has a new link"
    };
  }
  if (o.kept !== undefined && signed.signature !== o.kept.offer.signature) {
    return {
      refused:
        'the invitation filed under this link is not the one this wallet kept for it, so it is not taken as this one: start a new ' +
        'invitation, which has a new link, and withdraw the proposal raised for the kept one if it is still open'
    };
  }
  const differs = firstAskRefusal(signed.offer.for, kind, spec);
  return differs === null ? { filed: signed } : { refused: differs };
}

/** What `filedRecordEnteredHere` reads: every version filed of each company record asked, and the newest version its records hold of each record named. */
interface FiledRecordReads {
  readonly records: (
    asked: readonly { readonly kind: 'person' | 'vendor'; readonly id: string; readonly every: true }[]
  ) => Promise<readonly unknown[]>;
  readonly newest: (
    records: readonly { readonly store: 'company'; readonly kind: string; readonly id: string }[]
  ) => Promise<readonly number[]>;
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
  company: Pick<InvitingCompany, 'id' | 'viewingKey'>,
  kind: K,
  filed: SignedOffer,
  spec: InviteSpecs[K],
  seat: Pick<InvitingSeat, 'signingSecret' | 'entered'>,
  reads: FiledRecordReads
): Promise<string | null> {
  const recordKind = kind === 'employee' ? 'person' : 'vendor';
  const id = (filed.offer.for as EmployeeOffer | VendorOffer).person;
  const read = await reads.records([{ kind: recordKind, id, every: true }]).then(
    ([answer]) => ({
      listed: (answer as { versions?: unknown } | null)?.versions,
      why: 'the service holds no version of it'
    }),
    (e: unknown) => {
      const status = (e as { status?: unknown } | null)?.status;
      if (typeof status !== 'number') throw e;
      return { listed: undefined, why: `the service answered ${status}` };
    }
  );
  const listed = read.listed;
  if (!Array.isArray(listed)) {
    throw new FiledNotEntered(`the record filed with the invitation under this link could not be read (${read.why})`, {
      again: 'Press again to carry on with this same invitation.'
    });
  }
  let first: SealedCompanyRecord | undefined;
  try {
    first = listed
      .map((w) => fromCompanyWire(w, { company: company.id, kind: recordKind, id }).sealed)
      .find((r) => r.version === 1);
  } catch {
    first = undefined;
  }
  const mine = signingPublicKeyOf(seat.signingSecret).toLowerCase();
  if (first === undefined || verifiedCompanyFiler(first)?.toLowerCase() !== mine) {
    return (
      'the record filed with the invitation under this link is not one this seat filed, so it is not entered or taken as this ' +
      'one: start a new invitation, which has a new link'
    );
  }
  if (kind === 'vendor') {
    let terms: VendorTerms;
    try {
      terms = openVendor(first, keysByPurpose(company.viewingKey).at(first.keyEpoch)).terms;
    } catch {
      return (
        "the vendor entry filed with the invitation under this link does not open with the company's key, so it cannot be said " +
        'to be on these terms: start a new invitation, which has a new link'
      );
    }
    if (canonical(terms) !== canonical((spec as unknown as VendorSpec).terms)) {
      return `the invitation already made under this link was made with other terms: ${SAME_ASK}`;
    }
  }
  let held: readonly number[];
  try {
    held = await reads.newest([{ store: 'company', kind: recordKind, id }]);
  } catch (e) {
    throw new FiledNotEntered(
      `what the company's records hold of it could not be read: ${(e as Error)?.message ?? String(e)}`,
      {
        cause: e,
        again: 'Press again to carry on with this same invitation.'
      }
    );
  }
  if ((held[0] ?? 0) < 1) await seat.entered.enter([companyRecordEntry(first)]);
  return null;
}

/** What a press again is told when the invitation filed under its token is closed: it can never be filed again. */
export const INVITATION_UNDER_THIS_LINK_CLOSED =
  'the invitation already filed under this link has been used, has expired or was withdrawn, ' +
  'so nothing is made or raised under it again: start a new invitation, which has a new link, and withdraw any proposal still open for it';

/**
 * **THE SEAT OFFERED BY ADDRESS THIS DEVICE KEPT, TAKEN UP AGAIN.** The kept invitation must be this company's, for
 * this token and for the address typed now, must be the same ask as this press, with the same name, role and rights
 * (`firstAskRefusal`), so what is raised is what the press showed, must name its proposal, and must not have expired:
 * nobody could open an expired offer, so a seat raised for it could never be taken; the address's wallet is checked again against
 * every other proposal (`doors.held`, except this one's). The same proposal is raised again under its own salt, which
 * finds the one already raised when there is one, so one address never gets two proposals from one attempt. The offer
 * filed names the inbox key and the seat proof's secret of the company key in force now: when the kept one was made
 * from an older key, the offer is signed again with that key's inbox key and secret (the nonce, terms, proposal and
 * expiry unchanged), and kept in place of the old one before anything is raised or filed, so a seat request is never
 * sealed to a key a removed seat may hold, and is checked by the devices that hold the key in force.
 */
async function resumeSignerByAddress(
  company: InvitingCompany,
  seat: InvitingSeat,
  signer: SignerSpec & { readonly address: string },
  coinPublicKey: Hex,
  writes: CompanyWrites,
  doors: SignerByAddressDoors,
  opts: InviteOptions
): Promise<MadeInvitation> {
  const kept = opts.resume!;
  const offer = kept.offer.offer;
  const forWhom = offer.for;
  if (
    kept.company !== company.id ||
    offer.company !== company.id ||
    kept.id !== invitationIdOf(kept.token) ||
    (opts.token !== undefined && opts.token !== kept.token)
  ) {
    throw new InvitationNotMade('the invitation kept on this device to take up again is not this one');
  }
  if (
    forWhom.kind !== 'signer' ||
    forWhom.byAddress === undefined ||
    forWhom.invited.terms.invite === undefined ||
    forWhom.invited.terms.proposal === undefined ||
    forWhom.byAddress.address.toLowerCase() !== signer.address.toLowerCase()
  ) {
    throw new InvitationNotMade(
      'the invitation kept on this device to take up again is not a seat offered at this address'
    );
  }
  const differs = firstAskRefusal(forWhom, 'signer', signer);
  if (differs !== null) throw new InvitationNotMade(differs);
  if (offerExpiredRefusal(offer, Date.now()) !== null) {
    throw new InvitationNotMade(
      'the invitation kept on this device has expired, so its proposal is not raised again: withdraw it if ' +
        'its proposal is still open, and invite the person again'
    );
  }
  const held = await doors.held(coinPublicKey, forWhom.invited.terms.proposal);
  if (held !== null) throw new InvitationNotMade(held);
  const sealing = sealingWith(company.viewingKey, company.keyEpoch);
  const inbox = inboxOf(sealing.key, company.id);
  const secret = invitationSecret(
    sealing.key,
    company.id,
    forWhom.seat.nonce,
    forWhom.name,
    forWhom.role,
    invitationIdOf(kept.token)
  );
  let resumed = kept;
  if (offer.inboxPublicKey !== inbox || forWhom.seat.secret !== secret) {
    resumed = {
      ...kept,
      offer: signOffer(
        { ...offer, inboxPublicKey: inbox, for: { ...forWhom, seat: { nonce: forWhom.seat.nonce, secret } } },
        seat.signingSecret
      )
    };
    await doors.keep(resumed);
  }
  await doors.raise({
    invited: forWhom.invited,
    proposalSalt: forWhom.byAddress.proposalSalt,
    name: forWhom.name,
    inviter: offer.inviter,
    coinPublicKey
  });
  try {
    const invitation = await filed(
      company,
      seat,
      'signer',
      forWhom,
      sealing,
      kept.token,
      writes,
      undefined,
      undefined,
      resumed.offer
    );
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
  company: InvitingCompany,
  seat: InvitingSeat,
  kind: K,
  spec: InviteSpecs[K],
  origin: string,
  writes: CompanyWrites,
  byAddress?: K extends 'vendor' ? VendorByAddressDoors : SignerByAddressDoors,
  opts: InviteOptions = {}
): Promise<MadeInvitation> {
  if (opts.resume !== undefined && (kind !== 'signer' || (spec as SignerSpec).address === undefined)) {
    throw new InvitationNotMade(
      'only a seat offered by address is taken up again from the invitation this device kept'
    );
  }
  switch (kind) {
    case 'employee': {
      const made = await filePayeeInvitation(company, seat, spec as EmployeeSpec, writes, opts.token);
      return { link: invitationLink(origin, made.token), id: made.id, person: made.person };
    }
    case 'vendor': {
      const made = await fileVendorInvitation(
        company,
        seat,
        spec as VendorSpec,
        writes,
        byAddress as VendorByAddressDoors | undefined,
        opts.token
      );
      return { link: invitationLink(origin, made.token), id: made.id, person: made.person };
    }
    case 'signer': {
      const signer = spec as SignerSpec;
      if (signer.address !== undefined) {
        if (byAddress === undefined)
          throw new InvitationNotMade('this page cannot raise a seat offered by address: reload the page');
        return fileSignerByAddress(
          company,
          seat,
          signer as SignerSpec & { address: string },
          origin,
          writes,
          byAddress as SignerByAddressDoors,
          opts
        );
      }
      const made = await fileSignerInvitation(company, seat, signer, writes, undefined, opts.token);
      return { link: invitationLink(origin, made.token), id: made.id };
    }
    case 'super-admin':
      throw new InvitationNotMade(SUPER_ADMIN_INVITED_BY_THE_COMMITTEE);
    default:
      throw new InvitationNotMade(
        'it is none of the four kinds of invitation (an employee, a vendor, a signer or a super admin): choose one'
      );
  }
}

/** Who an invitation is re-issued for: their seat on the chain, and the company's proposals, which carry the one it replaces. */
export interface Reissued {
  /** The seat the chain holds that the invitation is re-issued for. */
  readonly leaf: Hex;
  /** The company's proposals: the one that seated the leaf carries the invitation it replaces, read by that leaf. */
  readonly proposals: readonly (Pick<SealedProposal, 'accountId' | 'sealed'> &
    Partial<Pick<SealedProposal, 'keyEpoch'>>)[];
  /** Every seat the company's account holds now, as this person's own wallet read it. */
  readonly onTheChain: readonly string[];
}

/** The invitation the proposal seating `leaf` carried - one, read by the leaf - unless it is itself a re-issue. */
export const replacedFor = (
  proposals: Reissued['proposals'],
  accountId: string,
  viewingKey: KeysHeld,
  leaf: string
): SignedSeatInvitation | null => {
  const original = seatInvitationIn(proposals, accountId, viewingKey, leaf);
  return original === null || original.terms.replaces !== undefined ? null : original;
};

/**
 * **AN INVITATION RE-ISSUED FROM THIS DEVICE FOR A PERSON WHOSE INVITER LEFT.**
 * For somebody the chain already seats: the invitation their seat was proposed
 * under - the one the proposal that seated their leaf carries, read by that
 * leaf - is signed again by this seat with every term it carries (the person,
 * name, role, vaults, leaf, address and proposal), naming the invitation it
 * replaces, under a new link, with this seat as their inviter. Their
 * device keeps both in place of what it kept (`takeTheReissueHere`), so their
 * wallet keeps the company's account on a seat it holds, and their own entry
 * carries an invitation from a seat not retired. Refused before anything is
 * signed when this seat may not invite or the chain does not hold it now, when
 * the invitation offers vaults beyond this seat's own, when it names no leaf or
 * another company, or when the chain does not hold that leaf now. The link's
 * token is `own.token` when the caller made it, so the caller can watch it.
 * Returns the link with the name the invitation itself carries, which is the
 * name to show beside the link, never the one a page asked under.
 */
export async function reissueInvitationHere(
  company: InvitingCompany,
  seat: InvitingSeat,
  reissued: Reissued,
  origin: string,
  writes: CompanyWrites,
  own: { readonly token?: Hex } = {}
): Promise<MadeInvitation & { readonly name: string }> {
  refuseASeatThatMayNotInvite(seat);
  if (!reissued.onTheChain.some((x) => x.toLowerCase() === seat.statement.seat.toLowerCase())) {
    throw new SeatMayNotInvite(
      "Your seat is not one the company's account holds now, so the person's wallet would not take you as " +
        'their inviter. Send it again from the device of a signer whose seat the account holds.'
    );
  }
  const original = replacedFor(reissued.proposals, company.id, company.viewingKey, reissued.leaf);
  const t = original?.terms;
  if (
    original === null ||
    t === undefined ||
    seatInvitationRefusal(original) !== null ||
    t.company !== company.id ||
    t.leaf?.toLowerCase() !== reissued.leaf.toLowerCase()
  ) {
    throw new SeatMayNotInvite(
      'The proposal that seated this person does not carry an invitation a signer made for them, so it cannot be sent again. Invite them again.'
    );
  }
  const leaf = t.leaf;
  if (!reissued.onTheChain.some((x) => x.toLowerCase() === leaf.toLowerCase())) {
    throw new SeatMayNotInvite(
      "The seat that invitation names is not one the company's account holds now, so it is not re-issued: " +
        'somebody waiting for a seat is withdrawn and invited again instead.'
    );
  }
  refuseVaultsBeyondTheSeat(seat, t.vaults);
  const sealing = sealingWith(company.viewingKey, company.keyEpoch);
  const token = own.token ?? newInvitationToken();
  /*
   * Every term the signers approved - the person, name, role, vaults, seat, address and proposal - and the invitation
   * it replaces, for every member's device to hold it to: only the invitation's id is new.
   */
  const { replaces: _none, ...approved } = t;
  const invited = signSeatInvitation(
    {
      ...approved,
      invitation: invitationIdOf(token),
      replaces: { invitation: t.invitation, signedBy: original.signedBy, signature: original.signature }
    },
    seat.signingSecret
  );
  const invitation = await filed(
    company,
    seat,
    'signer',
    { kind: 'reissue', name: t.name, role: t.role, invited },
    sealing,
    token,
    writes
  );
  return { link: invitationLink(origin, token), id: invitation.id, name: t.name };
}

/* Withdrawing somebody waiting for a seat is kept in its own file. */
export { withdrawWaitingSignerHere } from './waiting-signer-withdrawn.js';

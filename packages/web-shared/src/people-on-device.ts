/**
 * **A COMPANY'S PEOPLE, READ AND CHANGED ON A SEAT'S OWN DEVICE.** Each step is
 * one function a screen can call.
 *
 *   · **reading** (`readPeopleHere`): every person's newest record, opened
 *     here with the company's key, believed only when a seat this device
 *     believes filed it;
 *   · **a status** (`setStatusHere`): active only for somebody with somewhere
 *     to be paid, or a leaver;
 *   · **admitting** (`admitHere`): the decision that makes somebody payable.
 *     Every check the service used to make with the company's key is made here,
 *     on what the payee handed over, before anything is filed: it is their code,
 *     signed by their own wallet for this company; the fingerprint they read
 *     out is the one of the address in it; their invitation was not taken back
 *     and somebody is recorded as raising it; nobody else on the payroll is
 *     payable as the same person - the same wallet or the same email; a record
 *     with no email was raised and redeemed by one wallet; and the money can
 *     reach the address;
 *   · **making yourself payable** (`makeMyselfPayableHere`): the same checks,
 *     on the code your own wallet signed.
 *
 * What is filed is the next version of the person's record, sealed and signed
 * here. The service checks who filed it and what the route is for, and opens
 * nothing.
 */
import { randomBytes, toHex, type Hex } from '../../../src/core/crypto.js';
import { openFromInbox } from '../../../src/core/sealed-records.js';
import { openPerson, peopleOnTheWire, sealPerson, whyNotPayable } from '../../../src/core/person-record.js';
import { assets as defaultAssets, whyTheMoneyCannotReach, type AssetRegistry } from '../../../src/core/assets.js';
import type { Invite, RosterEmployee } from '../../../src/core/types.js';
import type { Payee } from '../../../src/midnight/payee-address.js';
import type { NetworkName } from '../../../src/midnight/network.js';
import {
  signCompanyFiling, toCompanyWire, verifiedCompanyFiler, type CompanyWireVersion,
} from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import { joinCodeSignedBy, type JoinCode, type PayeeParts } from 'midnight-identity/profile/join-code';
import { payeeCodeFingerprint, tidyFingerprint } from 'midnight-identity/profile/fingerprint';
import { checkShieldedAddress, checkUnshieldedAddress } from 'midnight-identity/wallet/address-shape';
import { judgeIn, seatNotBelievedHere, type DirectoryHere } from './vault-page-doors.js';
import { InvitationRefused, type InvitationSend, type InvitingCompany } from './invitation-on-device.js';

/** What a device acting on a company's people needs: the company opened, its seat, and how it reaches the service. */
export interface PeopleDevice {
  readonly company: InvitingCompany;
  /** This seat's filing key: every version filed here is signed with it. */
  readonly signingSecret: Hex;
  /** The id the person acting signed in with. */
  readonly signedInAs: string;
  readonly send: InvitationSend;
  /** The company's directory as this device believes it, read afresh for every step (`directoryHere`): who filed a version, and whose wallet a seat's is. */
  readonly directory: () => Promise<DirectoryHere>;
  readonly network: NetworkName;
  readonly registry?: AssetRegistry;
}

/** A person as this device read them: the whole entry, the version it is, and whether something waits to be admitted. */
export interface PersonHere {
  readonly person: RosterEmployee;
  readonly version: number;
  readonly handedOver: boolean;
}

/** Thrown when this device will not make a change; nothing was filed, and the message says what resolves it. */
export class PersonNotChanged extends Error {
  constructor(why: string) {
    super(`${why} Nothing was filed.`);
    this.name = 'PersonNotChanged';
  }
}

const answered = (r: { status: number; body: unknown }, ok: number): Record<string, unknown> => {
  const b = (r.body ?? {}) as Record<string, unknown>;
  if (r.status !== ok) {
    throw new InvitationRefused(r.status, typeof b.refused === 'string' ? b.refused : null,
      typeof b.error === 'string' ? b.error : `the service answered ${r.status} and said nothing, so nothing is known to have been filed.`);
  }
  return b;
};
const at = (d: PeopleDevice, path: string) => `/api/accounts/${encodeURIComponent(d.company.id)}${path}`;

/** The people as this device read them: those it believes and would pay, those no seat it believes filed, and those active with nothing their own wallet signed for where they are paid. */
export interface PeopleHere {
  readonly people: readonly PersonHere[];
  readonly notBelieved: readonly string[];
  /** Active people whose address or payslip key is not what their own code names (`whyNotPayable`): never read as payable, and made leavers to be added again. */
  readonly notPayable: readonly { readonly here: PersonHere; readonly why: string }[];
}

/**
 * **EVERY PERSON ON THE COMPANY'S PAYROLL, OPENED HERE.** A version no seat
 * this device believes filed is not opened: it is named in `notBelieved`, so a
 * screen never shows it as a person and never hides that it is there. An
 * active person whose address or payslip key is not their own code's is not
 * read as a person either, whoever filed them: they are named in `notPayable`,
 * with why.
 */
export async function readPeopleHere(d: PeopleDevice): Promise<PeopleHere> {
  const answer = answered(await d.send(at(d, '/people'), { method: 'GET' }), 200);
  const judge = judgeIn(await d.directory());
  const people: PersonHere[] = [];
  const notBelieved: string[] = [];
  const notPayable: { here: PersonHere; why: string }[] = [];
  for (const { rec, handedOver } of peopleOnTheWire(answer, d.company.id)) {
    if (judge(verifiedCompanyFiler(rec), 'person', companyRecordKey('person', rec.id), rec.version) !== null) { notBelieved.push(rec.id); continue; }
    const here: PersonHere = { person: openPerson(rec, d.company.viewingKey), version: rec.version, handedOver };
    const why = here.person.status === 'active' ? whyNotPayable(here.person, d.company.label) : null;
    if (why !== null) { notPayable.push({ here, why }); continue; }
    people.push(here);
  }
  return { people, notBelieved, notPayable };
}

/** The next version of `here`, sealed and signed on this device, as it crosses the wire. */
const nextVersion = (d: PeopleDevice, person: RosterEmployee, version: number): CompanyWireVersion =>
  toCompanyWire(signCompanyFiling(sealPerson(person, version, d.company.keyEpoch, d.company.viewingKey), d.signingSecret));

/**
 * **WHERE A PERSON STANDS**: active only for somebody with somewhere to be
 * paid - which is admitting's to give, not this - or a leaver, which is always
 * allowed, because withdrawing somebody is the way out of an invitation that
 * can never be admitted.
 */
export async function setStatusHere(d: PeopleDevice, here: PersonHere, status: 'active' | 'leaver'): Promise<RosterEmployee> {
  if (status === 'active' && !here.person.address) {
    throw new PersonNotChanged(`${here.person.name} has no address on file, so there is nowhere to pay them and nothing to make active. An address comes from their own wallet when they accept, and becomes payable when it is admitted.`);
  }
  const next: RosterEmployee = { ...here.person, status };
  answered(await d.send(`/api/people/${encodeURIComponent(here.person.id)}/status`, {
    method: 'POST', body: JSON.stringify({ person: nextVersion(d, next, here.version + 1) }),
  }), 201);
  return next;
}

/** The address a payee's code names, decoded as the platform decodes one, at this device's network. */
const payeeOfCode = (parts: PayeeParts, network: NetworkName): Payee => {
  const raw = parts.address.trim();
  try {
    if (raw.startsWith('mn_shield-addr')) {
      const c = checkShieldedAddress(raw, network);
      return { kind: 'shielded', bech32: c.bech32, network: c.network, coinPublicKey: c.coinPublicKey, encryptionPublicKey: c.encryptionPublicKey } as unknown as Payee;
    }
    const c = checkUnshieldedAddress(raw, network);
    return { kind: 'unshielded', bech32: c.bech32, network: c.network, userAddress: c.userAddress } as unknown as Payee;
  } catch (e) {
    throw new PersonNotChanged(`the address in this code is not one money can be sent to on this network: ${(e as Error).message}`);
  }
};

/** The checks a payee's code passes before it makes anybody payable, whichever way it arrived. */
const refuseACodeThatCannotBePaid = (
  d: PeopleDevice, person: RosterEmployee, code: JoinCode, read: PeopleHere,
): Payee => {
  /*
   * One payable record per person is checked against every person on the
   * payroll; a record no seat this device believes filed cannot be opened to
   * check, so nothing is made payable while one is there.
   */
  if (read.notBelieved.length > 0) {
    throw new PersonNotChanged(`the payroll holds ${read.notBelieved.length} record(s) no seat this device believes filed (${read.notBelieved.join(', ')}), so whether this person is already payable cannot be checked. A signer files those people again from their own device first.`);
  }
  if (read.notPayable.length > 0) {
    throw new PersonNotChanged(`the payroll holds ${read.notPayable.length} active record(s) whose address or payslip key is not what their own wallet signed (${read.notPayable.map((x) => x.here.person.id).join(', ')}), so whether this person is already payable cannot be checked. Mark those people leavers, and add them again.`);
  }
  const others = read.people;
  if (code.parts.kind !== 'payee' || !joinCodeSignedBy(code) || code.company !== d.company.label) {
    throw new PersonNotChanged('what was handed over is not a payee\'s code signed by their own wallet for this company. An invitation is accepted once: mark this person a leaver and invite them again.');
  }
  const wallet = code.committeeKey.value;
  const same = (a: string) => a.trim().toLowerCase();
  const clash = others.find((p) => p.person.id !== person.id && p.person.status === 'active'
    && ((p.person.handedOverBy !== null && p.person.handedOverBy === wallet)
      || (p.person.email !== null && person.email !== null && same(p.person.email) === same(person.email))));
  if (clash !== undefined) {
    throw new PersonNotChanged(`${person.email ?? 'the person whose wallet signed this'} is already payable on this company. One person gets one payable record, because two records is two salaries. To pay them at a different address, mark the existing record a leaver and add them again.`);
  }
  const address = payeeOfCode(code.parts, d.network);
  const unreachable = whyTheMoneyCannotReach((d.registry ?? defaultAssets).require(person.asset), address.kind);
  if (unreachable !== null) throw new PersonNotChanged(`not admitted. ${unreachable} An invitation is accepted once: mark this person a leaver and invite them again, to accept with an address that can be paid.`);
  return address;
};

/**
 * **ADMITTING A PERSON: THE DECISION THAT MAKES THEM PAYABLE, MADE HERE.**
 * `readOut` is the fingerprint the payee read off their own device; it must be
 * the fingerprint of the address in what they handed over.
 */
export async function admitHere(d: PeopleDevice, here: PersonHere, readOut: string): Promise<RosterEmployee> {
  const id = here.person.id;
  if (here.person.status === 'active') throw new PersonNotChanged(`${here.person.name} has already been admitted.`);
  const box = answered(await d.send(`/api/employees/${encodeURIComponent(id)}/handover`, { method: 'GET' }), 200).inbox as Invite['handover'];
  if (!box) throw new PersonNotChanged(`${here.person.name} has not handed anything over yet, so there is nothing to admit.`);
  let code: JoinCode;
  try { code = openFromInbox<JoinCode>(box, d.company.id, d.company.viewingKey); } catch {
    throw new PersonNotChanged('what was handed over does not open with this company\'s key, so it was sealed for somebody else. An invitation is accepted once: mark this person a leaver and invite them again.');
  }
  if (code?.parts?.kind !== 'payee' || tidyFingerprint(readOut) !== payeeCodeFingerprint(code as JoinCode & { parts: PayeeParts })) {
    throw new PersonNotChanged('the fingerprint this person read out is not the fingerprint of the code that arrived, so the address or payslip key is not the one their wallet showed them. An invitation is accepted once: mark this person a leaver and invite them again; if it does not match a second time, the page they accepted on is not ours.');
  }
  const invites = answered(await d.send(at(d, '/invites'), { method: 'GET' }), 200) as unknown as (Invite & { subjectId?: string })[];
  const invite = (Array.isArray(invites) ? invites : []).filter((i) => i.subjectId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (invite === undefined) throw new PersonNotChanged(`there is no invitation on record for ${here.person.name}, so there is no way to tell who set this address. Invite them again rather than admitting it.`);
  if (typeof invite.revokedAt === 'string') {
    throw new PersonNotChanged('this invitation was taken back before this was admitted, so admitting it would put somebody on the payroll whose hire was called off. Withdraw this person, and invite them again if the hire is back on.');
  }
  if (!invite.createdBy) {
    throw new PersonNotChanged('nothing records who raised this invitation, so nothing says the address was set by the payee rather than by whoever invited them. Mark this person a leaver, then invite them again.');
  }
  const raisedBy = await raisingWalletOf(d, invite.createdBy);
  if (here.person.email === null && raisedBy !== code.committeeKey.value) {
    throw new PersonNotChanged('this record is not addressed to an email address, so the only thing that can say whose it is, is that one wallet raised it and redeemed it, and two different wallets did.');
  }
  const address = refuseACodeThatCannotBePaid(d, here.person, code, await readPeopleHere(d));
  const admitted: RosterEmployee = {
    ...here.person, status: 'active', address, wrappingPublicKey: (code.parts as PayeeParts).payslipKey, payslipKeyFrom: code.company,
    handedOverBy: code.committeeKey.value, admittedBy: d.signedInAs, admittedAt: new Date().toISOString(),
    selfRaised: raisedBy === code.committeeKey.value, payeeCode: code,
  };
  answered(await d.send(`/api/employees/${encodeURIComponent(id)}/admit`, {
    method: 'POST', body: JSON.stringify({ person: nextVersion(d, admitted, here.version + 1) }),
  }), 201);
  return admitted;
}

/**
 * The committee key of the seat whose sign-in raised an invitation, from the
 * company's directory as this device believes it (`seatNotBelievedHere`, the
 * one rule for a seat): null when that person holds no seat it believes now.
 */
async function raisingWalletOf(d: PeopleDevice, person: string): Promise<string | null> {
  const here = await d.directory();
  const seat = here.dir.seats.find((x) => x.person === person && seatNotBelievedHere(here, x) === null);
  return seat === undefined ? null : seat.committeeKey.value.toLowerCase();
}

/** What a signer making themselves payable enters about their pay. */
interface MyPay {
  readonly name: string;
  readonly title: string;
  readonly asset: string;
  readonly baseAmount: bigint;
  readonly startDate: string;
}

/**
 * **A SIGNER MAKES THEMSELVES PAYABLE**, with the code their own wallet signed
 * for where they are paid: the checks admitting makes, then their first
 * person record, active, filed from here. Nobody else's sign-in is involved.
 */
export async function makeMyselfPayableHere(d: PeopleDevice, code: JoinCode, pay: MyPay): Promise<RosterEmployee> {
  if (typeof pay.baseAmount !== 'bigint' || pay.baseAmount <= 0n) throw new PersonNotChanged('pay is above nothing, in the token\'s smallest unit.');
  const raisedBy = await raisingWalletOf(d, d.signedInAs);
  if (raisedBy === null || raisedBy !== code.committeeKey.value) {
    throw new PersonNotChanged('this code is not signed by the wallet your seat on this company was entered with, so it is not yours to be paid by.');
  }
  const person: RosterEmployee = {
    id: `emp_${toHex(randomBytes(10))}`, accountId: d.company.id, name: pay.name, email: null, title: pay.title,
    asset: pay.asset, baseAmount: pay.baseAmount, startDate: pay.startDate, status: 'active', wrappingPublicKey: null,
    handedOverBy: null, admittedBy: null, admittedAt: null, selfRaised: true, address: null,
  };
  const address = refuseACodeThatCannotBePaid(d, person, code, await readPeopleHere(d));
  const payable: RosterEmployee = {
    ...person, address, wrappingPublicKey: (code.parts as PayeeParts).payslipKey, payslipKeyFrom: code.company,
    handedOverBy: code.committeeKey.value, admittedBy: d.signedInAs, admittedAt: new Date().toISOString(), payeeCode: code,
  };
  answered(await d.send(at(d, '/self-payee'), { method: 'POST', body: JSON.stringify({ person: nextVersion(d, payable, 1) }) }), 201);
  return payable;
}

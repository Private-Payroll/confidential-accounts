/**
 * A person added by the unshielded address the inviter typed is admitted by their own wallet's claim of that
 * address, signed with its key, with no fingerprint read out, and every device that reads them checks the claim
 * before it believes them payable. A person added by a shielded address carries no claim, since no device can check
 * a proof of one: they accept with their code for exactly that address, and are admitted on the fingerprint they
 * read out. Either way they are paid only at the address version 1 of their record was filed with.
 */
import { describe, it, expect } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { addressOfVerifyingKey } from 'midnight-identity/profile/disclosure';
import { CLAIMED_HANDOVER_SCHEMA, type AddressClaim, type AddressClaimFor } from 'midnight-identity/profile/address-claim';
import { signUnshieldedClaim } from 'midnight-identity/profile/address-claim-signed';
import { NIGHT, TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { acceptanceProofOf, invitationIdOf, tokenOfLink } from '../core/invitation.js';
import { sealToInbox } from '../core/sealed-records.js';
import { openPerson, sealPerson, whyNotPayable } from '../core/person-record.js';
import { theNetwork } from '../midnight/network.js';
import { payeeFor } from '../testing/payees.js';
import { payeeOf } from '../midnight/payee-address.js';
import { signCompanyFiling, toCompanyWire } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import { inviteHere, openInvitationHere, type InvitingCompany } from 'vaults-web-shared/invitation-on-device.js';
import { admitHere, readPeopleHere, setStatusHere, type PeopleDevice, type PersonHere } from 'vaults-web-shared/people-on-device.js';
import {
  aCompanyOfTwoSeats, acmeDirectory, ACME, ADA, fromAda, KEY, LABEL, newestPerson, ORIGIN, sendAs,
} from './a-company-of-two-seats.test-support.js';
/** The day a payee leaves when a test marks them a leaver: their first day, with no month raised yet to leave out. */
const LEFT = { leavingDate: '2026-10-01', pastDraft: async (): Promise<string[]> => [] };

aCompanyOfTwoSeats();

const NETWORK = theNetwork();
const device = (over: Partial<PeopleDevice> = {}): PeopleDevice => ({
  company: ACME as InvitingCompany, signingSecret: ADA.signingSecret, signedInAs: 'ada', send: fromAda,
  directory: acmeDirectory, network: NETWORK, entered: ADA.entered, ...over,
});
const walletOf = (n: number) => identityFromSecret(new Uint8Array(32).fill(n));
const unshieldedOf = (n: number): string => addressOfVerifyingKey(
  L.signatureVerifyingKey({ tag: 'schnorr', value: Buffer.from(walletOf(n).moneyAt(0).night).toString('hex') }).value, NETWORK as never);
const pay = (n: number, address: string, asset = NIGHT) => ({
  name: `Payee ${n}`, email: null, title: 'Engineer', asset, baseAmount: 500000n, classification: 'full-time' as const, startDate: '2026-10-01', address,
});
const PAYSLIP = 'cd'.repeat(32);
const hereOf = async (id: string): Promise<PersonHere> => (await readPeopleHere(device())).people.find((p) => p.person.id === id)!;

/** What a wallet hands over when it claims a record it was added to by address, as the wallet's claim action does. */
const claimWith = async (link: string, code: JoinCode, claim: unknown): Promise<void> => {
  const opened = await openInvitationHere(link, sendAs(null));
  const token = tokenOfLink(link)!;
  const handover = sealToInbox({ schema: CLAIMED_HANDOVER_SCHEMA, code, claim }, opened.signed.offer.inboxPublicKey);
  const r = await sendAs('usr_claim')(`/api/invites/${invitationIdOf(token)}/accept-payee`, {
    method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(token), handover, kind: 'employee' }),
  });
  expect(r.status).toBe(201);
};
const forOf = (person: string, address: string): AddressClaimFor => ({ company: LABEL, person, payslipKey: PAYSLIP, address, network: NETWORK });

/** Somebody added by an unshielded address, claimed by the wallet `n` with its own key. */
const addedAndClaimed = async (n: number, typed: string, claimer = n, over: { code?: (person: string) => JoinCode; claim?: (person: string) => AddressClaim } = {}) => {
  const made = await inviteHere(ACME, ADA, 'employee', pay(n, typed), ORIGIN, fromAda);
  const person = made.person!;
  const code = over.code?.(person) ?? signJoinCode(walletOf(claimer), LABEL, person, { kind: 'payee', address: typed, payslipKey: PAYSLIP });
  const claim = over.claim?.(person) ?? signUnshieldedClaim(walletOf(claimer), 0, forOf(person, typed));
  await claimWith(made.link, code, claim);
  return { person, link: made.link };
};

describe('A PERSON ADDED BY AN UNSHIELDED ADDRESS IS ADMITTED BY THEIR WALLET\'S CLAIM OF IT, WITH NO FINGERPRINT', () => {
  it('the address typed is held in the record every device opens, from its first version', async () => {
    const typed = unshieldedOf(61);
    const made = await inviteHere(ACME, ADA, 'employee', pay(61, typed), ORIGIN, fromAda);
    /* RED WHEN: the address the inviter typed is held only in the offer the invitee opens. */
    expect(openPerson((await newestPerson(made.person!))!, KEY).invitedAddress).toBe(typed);
  });

  it('a person whose own wallet signed for the typed unshielded address is admitted and payable on every device, with nothing read out', async () => {
    const typed = unshieldedOf(62);
    const { person } = await addedAndClaimed(62, typed);
    const admitted = await admitHere(device(), await hereOf(person), '');
    expect(admitted).toMatchObject({ status: 'active', invitedAddress: typed });
    expect(admitted.address!.bech32).toBe(typed);
    expect(admitted.addressClaim).toMatchObject({ kind: 'unshielded', address: typed });
    /* Another device reads them and believes them payable. */
    const read = await readPeopleHere(device());
    expect(read.notPayable.map((x) => x.here.person.id)).not.toContain(person);
    expect(read.people.some((p) => p.person.id === person && p.person.status === 'active')).toBe(true);
  });

  it('RED WHEN: a claim signed by another wallet for the typed address is admitted', async () => {
    const typed = unshieldedOf(63);
    const { person } = await addedAndClaimed(63, typed, 64, {
      claim: (p) => ({ ...signUnshieldedClaim(walletOf(64), 0, forOf(p, unshieldedOf(64))), address: typed }),
    });
    await expect(admitHere(device(), await hereOf(person), '')).rejects.toThrow(/claim of the address .* is refused: .*another address/u);
    expect((await newestPerson(person))!.facts!.status).toBe('pending');
  });

  it('RED WHEN: a wallet claiming with its own address instead of the typed one is admitted', async () => {
    const typed = unshieldedOf(65);
    const own = unshieldedOf(66);
    const { person } = await addedAndClaimed(65, typed, 66, {
      code: (p) => signJoinCode(walletOf(66), LABEL, p, { kind: 'payee', address: own, payslipKey: PAYSLIP }),
      claim: (p) => signUnshieldedClaim(walletOf(66), 0, forOf(p, own)),
    });
    await expect(admitHere(device(), await hereOf(person), '')).rejects.toThrow(/names another address or record than the one/u);
  });

  it('RED WHEN: a claim made for another person\'s record is admitted for this one', async () => {
    const typed = unshieldedOf(67);
    const { person } = await addedAndClaimed(67, typed, 67, {
      claim: () => signUnshieldedClaim(walletOf(67), 0, forOf('emp_ffffffffffffffffffff', typed)),
    });
    await expect(admitHere(device(), await hereOf(person), '')).rejects.toThrow(/is refused: .*signature/u);
  });

  it('RED WHEN: somebody added by address is admitted on a code handed over as on the link path, with a read-out fingerprint', async () => {
    const typed = unshieldedOf(68);
    const made = await inviteHere(ACME, ADA, 'employee', pay(68, typed), ORIGIN, fromAda);
    const { acceptAsPayeeHere, payeeHandoverOf } = await import('vaults-web-shared/invitation-on-device.js');
    const code = signJoinCode(walletOf(68), LABEL, made.person!, { kind: 'payee', address: typed, payslipKey: PAYSLIP });
    const opened = await openInvitationHere(made.link, sendAs(null));
    /* The page refuses to hand over a code with a fingerprint for an invitation made by address. */
    await expect(acceptAsPayeeHere(opened, code, sendAs('usr_68'))).rejects.toThrow(/public address you gave, so it is claimed from the wallet that holds that address/u);
    /* A page that hands one over anyway: the admitting device still refuses it. */
    const token = tokenOfLink(made.link)!;
    const r = await sendAs('usr_68')(`/api/invites/${invitationIdOf(token)}/accept-payee`, {
      method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(token), handover: payeeHandoverOf(code, opened.signed.offer.inboxPublicKey), kind: 'employee' }),
    });
    expect(r.status).toBe(201);
    const { payeeCodeFingerprint } = await import('midnight-identity/profile/fingerprint');
    await expect(admitHere(device(), await hereOf(made.person!), payeeCodeFingerprint(code as never))).rejects.toThrow(/added by address, and what was handed over is not their wallet's claim/u);
  });

  it('the page asks the wallet to claim exactly what the offer names, and nothing for an invitation not made by address', async () => {
    const { claimIntentOf } = await import('vaults-web-shared/invitation-on-device.js');
    const typed = unshieldedOf(69);
    const made = await inviteHere(ACME, ADA, 'employee', pay(69, typed), ORIGIN, fromAda);
    const opened = await openInvitationHere(made.link, sendAs(null));
    const token = tokenOfLink(made.link)!;
    /* RED WHEN: the page hands the wallet the inbox key or the record to claim, instead of the token it opens the offer with. */
    expect(claimIntentOf(opened)).toEqual({
      name: 'claim-by-address', company: LABEL, account: String(opened.signed.offer.account), record: opened.signed.offer.company,
      token, address: typed,
    });
    const byLink = await inviteHere(ACME, ADA, 'employee', { ...pay(70, typed), address: undefined } as never, ORIGIN, fromAda);
    await expect((async () => claimIntentOf(await openInvitationHere(byLink.link, sendAs(null))))()).rejects.toThrow(/not made by an address/u);
    /* RED WHEN: the page asks a wallet to claim a shielded address, which no device can check a claim of. */
    const byShielded = await inviteHere(ACME, ADA, 'employee', pay(79, payeeFor('79'.repeat(32), NETWORK).bech32, TEST_SETTLEMENT_ASSET), ORIGIN, fromAda);
    await expect((async () => claimIntentOf(await openInvitationHere(byShielded.link, sendAs(null))))()).rejects.toThrow(/made by a private address/u);
  });

  it('RED WHEN: a later version that names another address than the first is believed payable at it', async () => {
    const typed = unshieldedOf(73);
    const { person } = await addedAndClaimed(73, typed);
    const admitted = await admitHere(device(), await hereOf(person), '');
    /* A seat files a version that moves the typed address, the code and the claim to another wallet's. */
    const other = unshieldedOf(74);
    const code = signJoinCode(walletOf(74), LABEL, person, { kind: 'payee', address: other, payslipKey: PAYSLIP });
    const moved = {
      ...admitted, invitedAddress: other, payeeCode: code, handedOverBy: code.committeeKey.value,
      addressClaim: signUnshieldedClaim(walletOf(74), 0, forOf(person, other)),
      address: payeeOf(other, NETWORK),
    };
    expect(whyNotPayable(moved, LABEL)).toBeNull();
    const rec = signCompanyFiling(sealPerson(moved, 3, 0, KEY), ADA.signingSecret);
    expect((await fromAda(`/api/people/${person}/status`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(rec) }) })).status).toBe(201);
    await ADA.entered.enter([companyRecordEntry(rec)]);
    const read = await readPeopleHere(device());
    expect(read.notPayable.find((x) => x.here.person.id === person)?.why).toMatch(/does not name the address it was first filed with/u);
    /* Left a leaver, so the people after this one are not refused for sharing a payroll with a record nobody can pay. */
    await setStatusHere(device(), read.notPayable.find((x) => x.here.person.id === person)!.here, 'leaver', LEFT);
  });

  it('RED WHEN: a version whose claim of the typed address was not signed with that address\'s key is believed payable', async () => {
    const typed = unshieldedOf(89);
    const { person } = await addedAndClaimed(89, typed);
    const admitted = await admitHere(device(), await hereOf(person), '');
    /* A seat files a version whose claim names the typed address and was signed by another wallet. */
    const forged = { ...signUnshieldedClaim(walletOf(90), 0, forOf(person, unshieldedOf(90))), address: typed };
    const moved = { ...admitted, addressClaim: forged };
    expect(whyNotPayable(moved, LABEL)).toBeNull();
    const rec = signCompanyFiling(sealPerson(moved, 3, 0, KEY), ADA.signingSecret);
    expect((await fromAda(`/api/people/${person}/status`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(rec) }) })).status).toBe(201);
    await ADA.entered.enter([companyRecordEntry(rec)]);
    const read = await readPeopleHere(device());
    expect(read.notPayable.find((x) => x.here.person.id === person)?.why).toMatch(/their claim of the address they were added by is refused/u);
    await setStatusHere(device(), read.notPayable.find((x) => x.here.person.id === person)!.here, 'leaver', LEFT);
  });

  it('RED WHEN: a later version that leaves the typed address out, and pays another wallet\'s address, is believed payable', async () => {
    const typed = unshieldedOf(77);
    const { person } = await addedAndClaimed(77, typed);
    const admitted = await admitHere(device(), await hereOf(person), '');
    /* A seat files a version as if they had been invited by link: no typed address, no claim, another wallet's code. */
    const other = unshieldedOf(78);
    const code = signJoinCode(walletOf(78), LABEL, person, { kind: 'payee', address: other, payslipKey: PAYSLIP });
    const { invitedAddress: _typed, addressClaim: _claim, ...asIfByLink } = admitted;
    const moved = { ...asIfByLink, payeeCode: code, handedOverBy: code.committeeKey.value, address: payeeOf(other, NETWORK) };
    expect(whyNotPayable(moved, LABEL)).toBeNull();
    const rec = signCompanyFiling(sealPerson(moved, 3, 0, KEY), ADA.signingSecret);
    expect((await fromAda(`/api/people/${person}/status`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(rec) }) })).status).toBe(201);
    await ADA.entered.enter([companyRecordEntry(rec)]);
    const read = await readPeopleHere(device());
    expect(read.people.map((p) => p.person.id)).not.toContain(person);
    expect(read.notPayable.find((x) => x.here.person.id === person)?.why).toMatch(/does not name the address it was first filed with/u);
    /* Left a leaver, so the people after this one are not refused for sharing a payroll with a record nobody can pay. */
    await setStatusHere(device(), read.notPayable.find((x) => x.here.person.id === person)!.here, 'leaver', LEFT);
  });

  it('RED WHEN: a record added by address is believed payable with no claim in it, or a code for another address', () => {
    const typed = unshieldedOf(75);
    const code = signJoinCode(walletOf(75), LABEL, 'emp_00000000000000000075', { kind: 'payee', address: typed, payslipKey: PAYSLIP });
    const base = {
      id: 'emp_00000000000000000075', accountId: 'acc', name: 'x', email: null, title: 't', asset: TEST_SETTLEMENT_ASSET, baseAmount: 1n,
      startDate: '2026-10-01', status: 'active' as const, wrappingPublicKey: PAYSLIP as never, handedOverBy: code.committeeKey.value,
      admittedBy: 'ada', admittedAt: 'x', selfRaised: false, payeeCode: code, address: payeeOf(typed, NETWORK), invitedAddress: typed,
    };
    expect(whyNotPayable(base, LABEL)).toMatch(/no claim/u);
    expect(whyNotPayable({ ...base, invitedAddress: unshieldedOf(76) }, LABEL)).toMatch(/another address than the one they were added by/u);
  });
});

describe('A PERSON ADDED BY A SHIELDED ADDRESS IS ADMITTED ON THE FINGERPRINT THEY READ OUT, AND CARRIES NO CLAIM', () => {
  const shieldedOf = (n: number): string => payeeFor(n.toString(16).padStart(2, '0').repeat(32), NETWORK).bech32;
  const addedByShielded = async (n: number) => {
    const typed = shieldedOf(n);
    const made = await inviteHere(ACME, ADA, 'employee', pay(n, typed, TEST_SETTLEMENT_ASSET), ORIGIN, fromAda);
    return { typed, made, person: made.person! };
  };
  const accepted = async (n: number, typed: string, link: string, person: string) => {
    const { acceptAsPayeeHere } = await import('vaults-web-shared/invitation-on-device.js');
    const code = signJoinCode(walletOf(n), LABEL, person, { kind: 'payee', address: typed, payslipKey: PAYSLIP });
    const { fingerprint } = await acceptAsPayeeHere(await openInvitationHere(link, sendAs(null)), code, sendAs(`usr_${n}`));
    return { code, fingerprint };
  };

  it('a person added by a shielded address accepts with their code for it, is admitted on their fingerprint, and is payable with no claim', async () => {
    const { typed, made, person } = await addedByShielded(81);
    const { fingerprint } = await accepted(81, typed, made.link, person);
    const admitted = await admitHere(device(), await hereOf(person), fingerprint);
    expect(admitted).toMatchObject({ status: 'active', invitedAddress: typed });
    expect(admitted.address!.bech32).toBe(typed);
    expect(admitted.addressClaim).toBeUndefined();
    const read = await readPeopleHere(device());
    expect(read.people.some((p) => p.person.id === person && p.person.status === 'active')).toBe(true);
  });

  it('RED WHEN: a person added by a shielded address is admitted without the fingerprint read out', async () => {
    const { typed, made, person } = await addedByShielded(82);
    await accepted(82, typed, made.link, person);
    await expect(admitHere(device(), await hereOf(person), '')).rejects.toThrow(/fingerprint this person read out is not the fingerprint/u);
    expect((await newestPerson(person))!.facts!.status).toBe('pending');
  });

  it('RED WHEN: a person added by a shielded address is admitted on a claim of it, which no device can check', async () => {
    const { typed, made, person } = await addedByShielded(83);
    const code = signJoinCode(walletOf(83), LABEL, person, { kind: 'payee', address: typed, payslipKey: PAYSLIP });
    await claimWith(made.link, code, { kind: 'shielded', address: typed, deploy: 'AAAA', proof: 'AAAA' });
    const { payeeCodeFingerprint } = await import('midnight-identity/profile/fingerprint');
    await expect(admitHere(device(), await hereOf(person), payeeCodeFingerprint(code as never))).rejects.toThrow(/not admitted/u);
    expect((await newestPerson(person))!.facts!.status).toBe('pending');
  });

  it('RED WHEN: a person added by a shielded address hands over a code for another address and is admitted at it', async () => {
    const { typed, made, person } = await addedByShielded(84);
    const own = shieldedOf(85);
    const { acceptAsPayeeHere, payeeHandoverOf } = await import('vaults-web-shared/invitation-on-device.js');
    const code = signJoinCode(walletOf(84), LABEL, person, { kind: 'payee', address: own, payslipKey: PAYSLIP });
    const opened = await openInvitationHere(made.link, sendAs(null));
    await expect(acceptAsPayeeHere(opened, code, sendAs('usr_84'))).rejects.toThrow(/the code names another address/u);
    const token = tokenOfLink(made.link)!;
    expect((await sendAs('usr_84')(`/api/invites/${invitationIdOf(token)}/accept-payee`, {
      method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(token), handover: payeeHandoverOf(code, opened.signed.offer.inboxPublicKey), kind: 'employee' }),
    })).status).toBe(201);
    const { payeeCodeFingerprint } = await import('midnight-identity/profile/fingerprint');
    await expect(admitHere(device(), await hereOf(person), payeeCodeFingerprint(code as never))).rejects.toThrow(/another address or record than the private address/u);
    expect(typed).not.toBe(own);
  });

  it('RED WHEN: a record added by a shielded address that rests on a claim of it is believed payable', () => {
    const typed = shieldedOf(86);
    const code = signJoinCode(walletOf(86), LABEL, 'emp_00000000000000000086', { kind: 'payee', address: typed, payslipKey: PAYSLIP });
    const base = {
      id: 'emp_00000000000000000086', accountId: 'acc', name: 'x', email: null, title: 't', asset: TEST_SETTLEMENT_ASSET, baseAmount: 1n,
      startDate: '2026-10-01', status: 'active' as const, wrappingPublicKey: PAYSLIP as never, handedOverBy: code.committeeKey.value,
      admittedBy: 'ada', admittedAt: 'x', selfRaised: false, payeeCode: code, address: payeeOf(typed, NETWORK), invitedAddress: typed,
    };
    expect(whyNotPayable(base, LABEL)).toBeNull();
    expect(whyNotPayable({ ...base, addressClaim: { kind: 'shielded', address: typed, deploy: 'AAAA', proof: 'AAAA' } as never }, LABEL))
      .toMatch(/private address, which is admitted on the fingerprint/u);
  });

  it('RED WHEN: somebody added by an address is admitted on a version of their record that leaves the address out', async () => {
    const { typed, made, person } = await addedByShielded(87);
    /* Before anybody is admitted, a seat files a version of the waiting record with no typed address (the one route a
     * seat files a waiting person's next version through sets them a leaver; admitting them makes them active again). */
    const { invitedAddress: _typed, ...asIfByLink } = openPerson((await newestPerson(person))!, KEY);
    const rec = signCompanyFiling(sealPerson({ ...asIfByLink, status: 'leaver' }, 2, 0, KEY), ADA.signingSecret);
    expect((await fromAda(`/api/people/${person}/status`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(rec) }) })).status).toBe(201);
    await ADA.entered.enter([companyRecordEntry(rec)]);
    const other = shieldedOf(88);
    const { acceptAsPayeeHere } = await import('vaults-web-shared/invitation-on-device.js');
    const code = signJoinCode(walletOf(87), LABEL, person, { kind: 'payee', address: other, payslipKey: PAYSLIP });
    await expect(acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs('usr_87'))).rejects.toThrow(/another address/u);
    const { payeeHandoverOf } = await import('vaults-web-shared/invitation-on-device.js');
    const opened = await openInvitationHere(made.link, sendAs(null));
    const token = tokenOfLink(made.link)!;
    expect((await sendAs('usr_87')(`/api/invites/${invitationIdOf(token)}/accept-payee`, {
      method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(token), handover: payeeHandoverOf(code, opened.signed.offer.inboxPublicKey), kind: 'employee' }),
    })).status).toBe(201);
    const { payeeCodeFingerprint } = await import('midnight-identity/profile/fingerprint');
    const here = (await readPeopleHere(device())).people.find((p) => p.person.id === person)!;
    expect(here.person.invitedAddress).toBeUndefined();
    await expect(admitHere(device(), here, payeeCodeFingerprint(code as never))).rejects.toThrow(/does not name the address its first version was filed with/u);
    expect(typed).not.toBe(other);
  });
});

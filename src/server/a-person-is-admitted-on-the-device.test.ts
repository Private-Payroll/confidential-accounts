/**
 * **A PERSON IS ADMITTED, CHANGED AND MADE PAYABLE ON A SEAT'S OWN DEVICE.**
 * Every check the service used to make with the company's key - whose wallet
 * handed this over, whether they are already payable, whether the invitation
 * still stands, whether the money can reach the address - is made by the
 * admitting device on what it opened, before anything is filed. The service
 * files what a seat signed, for what the route is for, and opens nothing.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { addressFingerprint, payeeCodeFingerprint } from 'midnight-identity/profile/fingerprint';
import { canonical } from '../core/crypto.js';
import { TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { openEmployeeRow, sealPerson } from '../core/person-record.js';
import { theNetwork } from '../midnight/network.js';
import { payeeFor, unshieldedPayeeFor } from '../testing/payees.js';
import { signCompanyFiling, toCompanyWire, verifiedCompanyFiler } from '../midnight/sealed-record-wire.js';
import {
  addPayeeFromCodeHere, acceptAsPayeeHere, invitePayeeHere, openInvitationHere, type InvitingCompany,
} from 'vaults-web-shared/invitation-on-device.js';
import {
  admitHere, makeMyselfPayableHere, PersonNotChanged, readPeopleHere, setStatusHere, type PeopleDevice, type PeopleHere, type PersonHere,
} from 'vaults-web-shared/people-on-device.js';
import {
  aCompanyOfTwoSeats, acmeDirectory, ACME, ADA, BO, CO, fromAda, KEY, LABEL, OTHER_LABEL, ORIGIN, sendAs, store,
} from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats();

const NETWORK = theNetwork();
const adasDevice = (over: Partial<PeopleDevice> = {}): PeopleDevice => ({
  company: ACME as InvitingCompany, signingSecret: ADA.signingSecret, signedInAs: 'ada', send: fromAda,
  directory: acmeDirectory, network: NETWORK, ...over,
});
const pay = (n: number) => ({ name: `Payee ${n}`, email: `payee${n}@acme.co`, title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 500000n, startDate: '2026-10-01' });
const addressOf = (n: number) => payeeFor(n.toString(16).padStart(2, '0').repeat(32), NETWORK).bech32;
/** A payee's own wallet, numbered, signing their code for Acme. */
const codeOf = (wallet: number, address: string, label = LABEL): JoinCode =>
  signJoinCode(identityFromSecret(new Uint8Array(32).fill(wallet)), label, `usr_${wallet}`, { kind: 'payee', address, payslipKey: 'cd'.repeat(32) });
const hereOf = async (id: string): Promise<PersonHere> => (await readPeopleHere(adasDevice())).people.find((p) => p.person.id === id)!;
/** A payee invited by link and accepted with their code, waiting to be admitted. */
const waiting = async (n: number, code: JoinCode, spec: Omit<ReturnType<typeof pay>, 'email'> & { email: string | null } = pay(n)) => {
  const made = await invitePayeeHere(ACME, ADA, spec, ORIGIN, fromAda);
  const accepted = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs(`usr_${n}`));
  return { id: made.person!, fingerprint: accepted.fingerprint, invitation: made.id, link: made.link };
};

describe('THE PEOPLE ARE READ AS THEIR SIGNED RECORDS, WITH NO KEY IN ANY REQUEST', () => {
  it('EACH PERSON IS OPENED ON THE DEVICE, AND A VERSION NO BELIEVED SEAT FILED IS NAMED, NOT SHOWN', async () => {
    const w = await waiting(1, codeOf(41, addressOf(41)));
    const read = await readPeopleHere(adasDevice());
    const dana = read.people.find((p) => p.person.id === w.id)!;
    expect(dana).toMatchObject({ version: 1, handedOver: true, person: { name: 'Payee 1', status: 'pending' } });
    /* The service's older code writes a version no seat signed. */
    store.putEmployee({ ...store.getEmployee(w.id)!, status: 'leaver' });
    /* RED WHEN: a version no seat this device believes filed is opened as the person. */
    const again = await readPeopleHere(adasDevice());
    expect(again.people.some((p) => p.person.id === w.id)).toBe(false);
    expect(again.notBelieved).toContain(w.id);
    /*
     * RED WHEN: somebody is made payable while the payroll holds a record no
     * believed seat filed: that record may be the same person, already payable,
     * and it cannot be opened to check, so two salaries could follow.
     */
    const next = await waiting(30, codeOf(30, addressOf(30)));
    await expect(admitHere(adasDevice(), await hereOf(next.id), next.fingerprint)).rejects.toThrow(new RegExp(`1 record\\(s\\) no seat this device believes filed \\(${w.id}\\)`));
    expect(store.getEmployee(next.id)!.status).toBe('pending');
    /* Ada files the next version of that person from her own device, and the payroll is one she believes again. */
    const refiled = signCompanyFiling(sealPerson({ ...dana.person, status: 'leaver' }, 3, 0, KEY), ADA.signingSecret);
    expect((await fromAda(`/api/people/${w.id}/status`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(refiled) }) })).status).toBe(201);
    expect((await readPeopleHere(adasDevice())).notBelieved).toEqual([]);
    /* RED WHEN: the read is served to somebody who is not a member. */
    expect((await sendAs('eve')(`/api/accounts/${CO}/people`, { method: 'GET' })).status).toBe(404);
  });
});

describe('ADMITTING: THE DECISION THAT MAKES SOMEBODY PAYABLE, MADE ON THE ADMITTING DEVICE', () => {
  it('A PAYEE IS ADMITTED WITH THE ADDRESS AND PAYSLIP KEY THEIR WALLET SIGNED, AND WHAT WAITED IS EMPTIED', async () => {
    const address = addressOf(42);
    const w = await waiting(2, codeOf(42, address));
    const admitted = await admitHere(adasDevice(), await hereOf(w.id), w.fingerprint);
    expect(admitted).toMatchObject({ status: 'active', wrappingPublicKey: 'cd'.repeat(32), admittedBy: 'ada', payslipKeyFrom: LABEL });
    expect(admitted.address!.bech32).toBe(address);
    /* The service's older payroll code reads the same person, payable, from the one record. */
    const row = store.getEmployee(w.id)!;
    expect(row).toMatchObject({ status: 'active', wrappingPublicKey: 'cd'.repeat(32), inbox: null });
    expect(openEmployeeRow(row, KEY).address!.bech32).toBe(address);
    /* RED WHEN: the version admitted is not the one Ada's seat signed. */
    expect(verifiedCompanyFiler(store.newestPerson(w.id)!)).toBe(ADA.statement.signingKey);
    /* RED WHEN: the offer is kept after the person is admitted, a second standing copy of their pay. */
    expect(store.listInvites(CO).find((i) => i.subjectId === w.id)!.offer).toBeNull();
    /* RED WHEN: the admitted address or salary reaches the service in the clear. */
    expect(canonical(store.snapshot())).not.toContain(address);
  });

  it('REFUSES A FINGERPRINT THAT IS NOT THE ADDRESS\'S, AND FILES NOTHING', async () => {
    const w = await waiting(3, codeOf(43, addressOf(43)));
    /* RED WHEN: the admitting device files a person whose fingerprint the payee did not read out. */
    await expect(admitHere(adasDevice(), await hereOf(w.id), addressFingerprint(addressOf(99)))).rejects.toThrow(/not the fingerprint of the code that arrived/);
    /* RED WHEN: a code swapped on the way for another wallet's, naming the payee's own address but another payslip key, is admitted on the payee's read-out. */
    const swapped = await waiting(33, codeOf(70, addressOf(43)));
    const payeesOwn = payeeCodeFingerprint(codeOf(43, addressOf(43)) as never);
    await expect(admitHere(adasDevice(), await hereOf(swapped.id), payeesOwn)).rejects.toThrow(/not the fingerprint of the code that arrived/);
    expect(store.newestPerson(swapped.id)!.version).toBe(1);
    expect(store.newestPerson(w.id)!.version).toBe(1);
    /*
     * RED WHEN: a refusal tells the admin to have the payee accept again - an
     * invitation is accepted once, so that advice strands them - rather than
     * the way out there is: a leaver, and a new invitation.
     */
    await expect(admitHere(adasDevice(), await hereOf(w.id), addressFingerprint(addressOf(99)))).rejects.toThrow(/accepted once: mark this person a leaver and invite them again/);
    await expect(openInvitationHere(w.link, sendAs(null))).rejects.toMatchObject({ status: 410 });
  });

  it('REFUSES A SECOND PAYABLE RECORD FOR THE SAME WALLET, OR THE SAME EMAIL', async () => {
    const first = await waiting(4, codeOf(44, addressOf(44)));
    await admitHere(adasDevice(), await hereOf(first.id), first.fingerprint);
    /* The same wallet hands over again under another invitation. */
    const again = await waiting(5, codeOf(44, addressOf(45)));
    /* RED WHEN: one wallet is made payable twice: two records is two salaries. */
    await expect(admitHere(adasDevice(), await hereOf(again.id), again.fingerprint)).rejects.toThrow(/already payable/);
    /* Another wallet, the same email. */
    const sameEmail = await waiting(6, codeOf(46, addressOf(46)), { ...pay(6), email: 'PAYEE4@acme.co' });
    /* RED WHEN: one person, by email, is made payable twice. */
    await expect(admitHere(adasDevice(), await hereOf(sameEmail.id), sameEmail.fingerprint)).rejects.toThrow(/already payable/);
  });

  it('REFUSES A WITHDRAWN INVITATION, A CODE FOR ANOTHER COMPANY, AN UNREACHABLE ADDRESS, AND A SECOND ADMISSION', async () => {
    const withdrawn = await waiting(7, codeOf(47, addressOf(47)));
    const row = store.listInvites(CO).find((i) => i.subjectId === withdrawn.id)!;
    store.putInvite({ ...row, revokedAt: new Date().toISOString() });
    /* RED WHEN: a person whose invitation was taken back is admitted. */
    await expect(admitHere(adasDevice(), await hereOf(withdrawn.id), withdrawn.fingerprint)).rejects.toThrow(/taken back/);
    /* A code for another company, handed over by a page that did not check it. */
    const made = await invitePayeeHere(ACME, ADA, pay(8), ORIGIN, fromAda);
    const other = codeOf(48, addressOf(48), OTHER_LABEL);
    const opened = await openInvitationHere(made.link, sendAs(null));
    const { payeeHandoverOf } = await import('vaults-web-shared/invitation-on-device.js');
    const { acceptanceProofOf, tokenOfLink } = await import('../core/invitation.js');
    await sendAs('usr_48')(`/api/invites/${made.id}/accept-employee`, { method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(tokenOfLink(made.link)!), handover: payeeHandoverOf(other, opened.signed.offer.inboxPublicKey) }) });
    /* A code changed after the payee's wallet signed it. */
    const tamperedFor = await invitePayeeHere(ACME, ADA, pay(13), ORIGIN, fromAda);
    const signedCode = codeOf(53, addressOf(53));
    const tampered = { ...signedCode, parts: { ...signedCode.parts, payslipKey: '0f'.repeat(32) } } as JoinCode;
    await acceptAsPayeeHere(await openInvitationHere(tamperedFor.link, sendAs(null)), tampered, sendAs('usr_53'));
    /* RED WHEN: a code whose parts were changed after the wallet signed it makes somebody payable. */
    await expect(admitHere(adasDevice(), await hereOf(tamperedFor.person!), payeeCodeFingerprint(tampered as never))).rejects.toThrow(/not a payee's code signed by their own wallet/);
    /* RED WHEN: a code signed for another company makes somebody payable here. */
    await expect(admitHere(adasDevice(), await hereOf(made.person!), payeeCodeFingerprint(other as never))).rejects.toThrow(/not a payee's code signed by their own wallet for this company/);
    /* A public address for a token paid only privately. */
    const publicAddress = unshieldedPayeeFor('4a'.repeat(32), NETWORK).bech32;
    const unreachable = await waiting(9, codeOf(49, publicAddress));
    /* RED WHEN: an address the money cannot reach is admitted. */
    await expect(admitHere(adasDevice(), await hereOf(unreachable.id), unreachable.fingerprint)).rejects.toThrow(/^not admitted\./);
    expect(store.newestPerson(unreachable.id)!.facts!.status).toBe('pending');
  });

  it('REFUSES, EACH BY ITS OWN SENTENCE: NOTHING HANDED OVER, A HAND-OVER SEALED TO ANOTHER COMPANY, AND A PERSON ALREADY ADMITTED', async () => {
    const { payeeHandoverOf } = await import('vaults-web-shared/invitation-on-device.js');
    const { acceptanceProofOf, tokenOfLink } = await import('../core/invitation.js');
    const { inboxPublicKey } = await import('../core/sealed-records.js');
    const { newSymmetricKey } = await import('../core/crypto.js');
    /* RED WHEN: a person who handed nothing over is admitted. */
    const nothing = await invitePayeeHere(ACME, ADA, pay(20), ORIGIN, fromAda);
    await expect(admitHere(adasDevice(), await hereOf(nothing.person!), payeeCodeFingerprint(codeOf(60, addressOf(60)) as never))).rejects.toThrow(/has not handed anything over yet/);
    /* RED WHEN: a hand-over sealed to another company's inbox is opened as this one's. */
    const elsewhere = await invitePayeeHere(ACME, ADA, pay(21), ORIGIN, fromAda);
    const code = codeOf(61, addressOf(61));
    await sendAs('usr_61')(`/api/invites/${elsewhere.id}/accept-employee`, { method: 'POST', body: JSON.stringify({
      acceptance: acceptanceProofOf(tokenOfLink(elsewhere.link)!), handover: payeeHandoverOf(code, inboxPublicKey(newSymmetricKey(), CO)),
    }) });
    await expect(admitHere(adasDevice(), await hereOf(elsewhere.person!), payeeCodeFingerprint(code as never))).rejects.toThrow(/sealed for somebody else/);
    /* RED WHEN: a person already admitted is admitted again. */
    const done = await waiting(22, codeOf(62, addressOf(62)));
    await admitHere(adasDevice(), await hereOf(done.id), done.fingerprint);
    await expect(admitHere(adasDevice(), await hereOf(done.id), done.fingerprint)).rejects.toThrow(/has already been admitted/);
    /* RED WHEN: a refusal is thrown as anything a screen cannot tell from a fault: every refusal here is the one kind that says nothing was filed. */
    await expect(admitHere(adasDevice(), await hereOf(done.id), done.fingerprint)).rejects.toBeInstanceOf(PersonNotChanged);
    /* RED WHEN: the accept route takes a payslip key in the clear, or a body carrying more than an acceptance and a hand-over. */
    const clear = await invitePayeeHere(ACME, ADA, pay(23), ORIGIN, fromAda);
    const proof = acceptanceProofOf(tokenOfLink(clear.link)!);
    const sealedFor = payeeHandoverOf(codeOf(63, addressOf(63)), ACME.inboxPublicKey);
    const post = (body: unknown) => sendAs('usr_63')(`/api/invites/${clear.id}/accept-employee`, { method: 'POST', body: JSON.stringify(body) });
    expect((await post({ acceptance: proof, handover: sealedFor, wrappingPublicKey: 'cd'.repeat(32) })).body).toMatchObject({ refused: 'handover-in-the-clear' });
    expect((await post({ acceptance: proof, handover: sealedFor, note: 'hi' })).body).toMatchObject({ refused: 'not-an-acceptance' });
    expect(store.newestPerson(clear.person!)!.facts!.status).toBe('pending');
  });

  it('THE SERVICE FILES AN ADMISSION ONLY FROM A SEAT, ONLY AS ACTIVE, AND ONLY WHILE SOMETHING WAITS', async () => {
    const w = await waiting(10, codeOf(50, addressOf(50)));
    const here = await hereOf(w.id);
    const { sealPerson } = await import('../core/person-record.js');
    const { signCompanyFiling, toCompanyWire } = await import('../midnight/sealed-record-wire.js');
    const wire = (status: 'active' | 'pending', signer = ADA.signingSecret) =>
      toCompanyWire(signCompanyFiling(sealPerson({ ...here.person, status }, 2, 0, KEY), signer));
    const post = (who: string, body: unknown) => sendAs(who)(`/api/employees/${w.id}/admit`, { method: 'POST', body: JSON.stringify({ person: body }) });
    /* RED WHEN: an admission that does not make the person active is filed. */
    expect((await post('ada', wire('pending'))).body).toMatchObject({ refused: 'not-this-change' });
    /* RED WHEN: an approver's seat, whose role may not file a person, admits somebody. */
    expect((await post('bo', wire('active', BO.signingSecret))).body).toMatchObject({ refused: 'role-may-not-file' });
    /* RED WHEN: somebody who is not a member of the company reaches the person at all (the ownsPerson gate). */
    expect((await post('eve', wire('active'))).status).toBe(404);
    expect((await post('ada', wire('active'))).status).toBe(201);
    /* RED WHEN: a person is admitted again once nothing waits. */
    expect((await post('ada', toCompanyWire(signCompanyFiling(sealPerson({ ...here.person, status: 'active' }, 3, 0, KEY), ADA.signingSecret)))).body).toMatchObject({ refused: 'nothing-handed-over' });
    /*
     * RED WHEN: a person a seat filed as active with nothing their own wallet
     * signed for where they are paid is read as payable. The service files what
     * a believed seat signs; every reader refuses it, and names it.
     */
    const read: PeopleHere = await readPeopleHere(adasDevice());
    expect(read.people.some((p) => p.person.id === w.id)).toBe(false);
    const refused = read.notPayable.find((x) => x.here.person.id === w.id)!;
    expect(refused.why).toMatch(/carries no code their own wallet signed/);
    /* RED WHEN: somebody is admitted while an active record that is not payable may be the same person, already on the payroll. */
    const next = await waiting(31, codeOf(31, addressOf(31)));
    await expect(admitHere(adasDevice(), await hereOf(next.id), next.fingerprint)).rejects.toThrow(/1 active record\(s\) whose address or payslip key is not what their own wallet signed/);
    /* The way out: a leaver, from a seat's device. */
    await setStatusHere(adasDevice(), refused.here, 'leaver');
    expect((await readPeopleHere(adasDevice())).notPayable).toEqual([]);
  });

  it('A SEAT THAT FILES ANOTHER ADDRESS OR PAYSLIP KEY FOR AN ADMITTED PAYEE IS REFUSED BY EVERY READER, AND THE CODE IS CARRIED FORWARD', async () => {
    const w = await waiting(16, codeOf(56, addressOf(56)));
    await admitHere(adasDevice(), await hereOf(w.id), w.fingerprint);
    const here = await hereOf(w.id);
    /* RED WHEN: a status change drops the payee's code, so they stop being payable at the address they gave. */
    await setStatusHere(adasDevice(), here, 'leaver');
    const left = (await readPeopleHere(adasDevice())).people.find((p) => p.person.id === w.id)!;
    expect(left.person.payeeCode).toEqual(here.person.payeeCode);
    const back = await setStatusHere(adasDevice(), left, 'active');
    expect(back.payeeCode).toEqual(here.person.payeeCode);
    const now = (await readPeopleHere(adasDevice())).people.find((p) => p.person.id === w.id)!;
    expect(now.person.status).toBe('active');
    const { sealPerson } = await import('../core/person-record.js');
    const { signCompanyFiling, toCompanyWire } = await import('../midnight/sealed-record-wire.js');
    const { payeeFor: aPayee } = await import('../testing/payees.js');
    const theirs = aPayee('99'.repeat(32), NETWORK);
    for (const [what, swapped, why] of [
      ['another address', { ...now.person, address: theirs }, /address their record pays is not the one their code names/],
      ['another payslip key', { ...now.person, wrappingPublicKey: '0e'.repeat(32) }, /payslip key their record seals to is not the one/],
      ['no code', { ...now.person, payeeCode: null }, /carries no code/],
      ['another wallet\'s code', { ...now.person, payeeCode: codeOf(57, addressOf(56)) }, /not signed by the wallet that handed it over/],
    ] as const) {
      const version = (await readPeopleHere(adasDevice())).people.find((p) => p.person.id === w.id)?.version
        ?? (await readPeopleHere(adasDevice())).notPayable.find((x) => x.here.person.id === w.id)!.here.version;
      /* A seat files a status version with the payee's details changed inside the seal; the service checks only the status and the version. */
      const filed = await sendAs('ada')(`/api/people/${w.id}/status`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(signCompanyFiling(sealPerson(swapped as never, version + 1, 0, KEY), ADA.signingSecret)) }) });
      expect(filed.status, what).toBe(201);
      /* RED WHEN: a version whose address, payslip key or code is not the payee's own is read as payable. */
      const read = await readPeopleHere(adasDevice());
      expect(read.people.some((p) => p.person.id === w.id), what).toBe(false);
      expect(read.notPayable.find((x) => x.here.person.id === w.id)?.why, what).toMatch(why);
      /* Put back as it was, signed, for the next case. */
      await sendAs('ada')(`/api/people/${w.id}/status`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(signCompanyFiling(sealPerson(now.person, version + 2, 0, KEY), ADA.signingSecret)) }) });
    }
    await setStatusHere(adasDevice(), (await hereOf(w.id)), 'leaver');
  });
});

describe('A RECORD WITH NO EMAIL IS RAISED AND REDEEMED BY ONE WALLET', () => {
  it('ANOTHER WALLET REDEEMING IT IS REFUSED; THE RAISING SEAT\'S OWN WALLET IS ADMITTED, AS SELF-RAISED', async () => {
    const noEmail = { ...pay(14), email: null };
    const theirs = await waiting(14, codeOf(54, addressOf(54)), noEmail);
    /* RED WHEN: a record nothing addresses is redeemed by a wallet other than the one that raised it. */
    await expect(admitHere(adasDevice(), await hereOf(theirs.id), theirs.fingerprint)).rejects.toThrow(/one wallet raised it and redeemed it/);
    const adasOwn = signJoinCode(identityFromSecret(new Uint8Array(32).fill(ADA.n)), LABEL, 'ada', { kind: 'payee', address: addressOf(55), payslipKey: 'cd'.repeat(32) });
    const mine = await waiting(15, adasOwn, { ...pay(15), email: null });
    /*
     * RED WHEN: whose wallet raised the invitation is read off a directory entry
     * this device does not believe as a seat - here, one whose records key her
     * wallet has not attested - rather than by the one rule for a seat.
     */
    await expect(admitHere(adasDevice({ directory: () => acmeDirectory([BO]) }), await hereOf(mine.id), mine.fingerprint)).rejects.toThrow(/one wallet raised it and redeemed it/);
    const admitted = await admitHere(adasDevice(), await hereOf(mine.id), mine.fingerprint);
    /* RED WHEN: a record raised and redeemed by one wallet is not marked as raised by the person it pays. */
    expect(admitted.selfRaised).toBe(true);
    /* Ada leaves this record, so her wallet is not payable when she makes herself payable below. */
    await setStatusHere(adasDevice(), await hereOf(mine.id), 'leaver');
  });
});

describe('A STATUS, CHANGED ON A SEAT\'S DEVICE', () => {
  it('NOBODY WITH NO ADDRESS IS MADE ACTIVE; ANYBODY CAN BE MADE A LEAVER', async () => {
    const made = await invitePayeeHere(ACME, ADA, pay(11), ORIGIN, fromAda);
    const here = await hereOf(made.person!);
    /* RED WHEN: a person with nowhere to be paid is made active from the roster. */
    await expect(setStatusHere(adasDevice(), here, 'active')).rejects.toThrow(/no address on file/);
    await setStatusHere(adasDevice(), here, 'leaver');
    expect(store.getEmployee(made.person!)!.status).toBe('leaver');
    /* RED WHEN: the status route files a version that makes a person anything but active or a leaver. */
    const { sealPerson } = await import('../core/person-record.js');
    const { signCompanyFiling, toCompanyWire } = await import('../midnight/sealed-record-wire.js');
    const pendingAgain = toCompanyWire(signCompanyFiling(sealPerson({ ...here.person, status: 'pending' }, 3, 0, KEY), ADA.signingSecret));
    expect((await fromAda(`/api/people/${made.person}/status`, { method: 'POST', body: JSON.stringify({ person: pendingAgain }) })).body).toMatchObject({ refused: 'not-this-change' });
    /* RED WHEN: a member of another company changes this one's person (the ownsPerson gate). */
    expect((await sendAs('eve')(`/api/people/${made.person}/status`, { method: 'POST', body: JSON.stringify({ person: pendingAgain }) })).status).toBe(404);
  });
});

describe('A SIGNER MAKES THEMSELVES PAYABLE FROM THEIR OWN DEVICE', () => {
  it('WITH THE CODE THEIR OWN SEAT\'S WALLET SIGNED, AND NOT WITH ANYBODY ELSE\'S', async () => {
    const address = addressOf(61);
    const mine = signJoinCode(identityFromSecret(new Uint8Array(32).fill(ADA.n)), LABEL, 'ada', { kind: 'payee', address, payslipKey: 'ef'.repeat(32) });
    const self = { name: 'Ada', title: 'Founder', asset: TEST_SETTLEMENT_ASSET, baseAmount: 900000n, startDate: '2026-10-01' };
    /* RED WHEN: a signer is made payable at an address another wallet signed. */
    await expect(makeMyselfPayableHere(adasDevice(), codeOf(62, addressOf(62)), self)).rejects.toThrow(/not signed by the wallet your seat/);
    const payable = await makeMyselfPayableHere(adasDevice(), mine, self);
    expect(store.getEmployee(payable.id)).toMatchObject({ status: 'active', wrappingPublicKey: 'ef'.repeat(32) });
    expect(payable).toMatchObject({ selfRaised: true, handedOverBy: ADA.committeeKey.value });
    /* RED WHEN: the same signer is made payable twice. */
    await expect(makeMyselfPayableHere(adasDevice(), mine, self)).rejects.toThrow(/already payable/);
    /* RED WHEN: the self-payee route files anybody but a new, active person. */
    const { sealPerson } = await import('../core/person-record.js');
    const { signCompanyFiling, toCompanyWire } = await import('../midnight/sealed-record-wire.js');
    expect((await fromAda(`/api/accounts/${CO}/self-payee`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(signCompanyFiling(sealPerson({ ...payable, status: 'active' }, 2, 0, KEY), ADA.signingSecret)) }) })).body).toMatchObject({ refused: 'not-a-new-person' });
  });

  it('A PAYEE ADDED FROM A PASTED CODE IS ADMITTED THE SAME WAY, WITH THE FINGERPRINT THEY READ OUT', async () => {
    const code = codeOf(70, addressOf(70));
    const added = await addPayeeFromCodeHere(ACME, ADA, (await import('midnight-identity/profile/join-code')).writeJoinCode(code), pay(12), fromAda);
    const admitted = await admitHere(adasDevice(), await hereOf(added.person), added.fingerprint);
    expect(admitted.status).toBe('active');
  });
});

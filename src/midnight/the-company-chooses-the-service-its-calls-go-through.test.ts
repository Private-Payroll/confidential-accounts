/**
 * **THE COMPANY'S CHOICE OF SERVICE: OURS, ITS OWN AT AN ADDRESS, OR NONE, AND NO ONE SEAT MAKES IT.**
 *
 * Each version is sealed to the signers here and opened by one of them; which seat filed each version is given as
 * the device would have believed it.
 */
import { describe, it, expect } from 'vitest';
import { newSymmetricKey, newWrappingKeypair, unwrapKey, type Hex } from '../core/crypto.js';
import {
  COMPANY_SERVICE_RECORD, COMPANY_WRAP_ID, CompanyServiceRefused, OUR_SERVICE, openCompanyService, openedWithTheCompanyKey, sealCompanyService,
  serviceAddressRefusal, serviceAsked, serviceInForce, type CompanyService, type ServiceOpener, type ServiceVersion,
} from './company-service-record.js';

const ADA = newWrappingKeypair();
const BEA = newWrappingKeypair();
const signers = [{ id: 'ada', wrappingPublicKey: ADA.publicKey }, { id: 'bea', wrappingPublicKey: BEA.publicKey }];
const OWN: CompanyService = { service: 'own', at: 'https://relay.example.com' };
const NONE: CompanyService = { service: 'none' };
const v = (version: number, filer: string | null, choice: CompanyService): ServiceVersion => ({ version, filer, choice });
/** The seat named, opening its copy with the secret given, as the device that holds that secret would. */
const opener = (signerId: string, secret: string, keyAt: (epoch: number) => Hex = noKey): ServiceOpener =>
  ({ signerId, keyOf: (w) => unwrapKey(w, secret) as Hex, companyCopy: openedWithTheCompanyKey('acc_1', keyAt) });
/** A device holding no key of the company at any epoch. */
const noKey = (epoch: number): Hex => { throw new Error(`no key of the company at epoch ${epoch}`); };
/** The company's key at epoch 2, and a device holding it at that epoch alone. */
const KEY2 = newSymmetricKey();
const SEALING = { key: KEY2, epoch: 2 };
const atTwo = (epoch: number): Hex => (epoch === 2 ? KEY2 : noKey(epoch));

describe('A COMPANY\'S OWN SERVICE IS NAMED BY A SECURE SITE ADDRESS AND NOTHING MORE', () => {
  it('an https origin is taken', () => {
    /* RED WHEN: a company cannot name its own service by its secure address. */
    expect(serviceAddressRefusal('https://relay.example.com')).toBeNull();
    expect(serviceAddressRefusal('https://relay.example.com:8443')).toBeNull();
  });

  it('plain http, a path, a query, a sign-in, or something that is not an address is refused, saying why', () => {
    /* RED WHEN: a company's own service can be reached without a secure connection. */
    expect(serviceAddressRefusal('http://relay.example.com')).toMatch(/not a secure \(https\) address/u);
    /* RED WHEN: the address can carry a path, query or fragment beside the site. */
    expect(serviceAddressRefusal('https://relay.example.com/relay')).toMatch(/name the site alone, as https:\/\/relay\.example\.com/u);
    expect(serviceAddressRefusal('https://relay.example.com/?x=1')).toMatch(/site alone/u);
    expect(serviceAddressRefusal('https://relay.example.com#a')).toMatch(/site alone/u);
    /* RED WHEN: the address can carry a sign-in. */
    expect(serviceAddressRefusal('https://me:pw@relay.example.com')).toMatch(/carries a sign-in/u);
    expect(serviceAddressRefusal('relay.example.com')).toMatch(/not a web address/u);
    expect(serviceAddressRefusal('')).toMatch(/no address/u);
    expect(serviceAddressRefusal(`https://${'a'.repeat(250)}.com`)).toMatch(/longer than 255/u);
  });

  it('an address that is a number, or this device itself, is refused', () => {
    for (const at of ['https://127.0.0.1', 'https://10.0.0.1:8443', 'https://[::1]', 'https://localhost', 'https://relay.localhost', 'https://0x7f000001',
      'https://localhost.', 'https://relay.localhost.', 'https://127.0.0.1.']) {
      /* RED WHEN: a company's choice makes every seat's device post to its own machine or network by number, or as this device written with a closing dot. */
      expect(serviceAddressRefusal(at)).toMatch(/named by a number or as this device/u);
    }
  });

  it('a choice naming a refused address is not sealed', () => {
    /* RED WHEN: a version naming a plain http service can be filed. */
    expect(() => sealCompanyService({ company: 'acc_1', version: 1, sealing: SEALING, choice: { service: 'own', at: 'http://relay.example.com' }, signers }))
      .toThrow(/not a secure \(https\) address\. Nothing was filed/u);
  });
});

describe('ONE VERSION OF THE CHOICE OPENS ONLY AS ITSELF, AND ONLY FOR A SIGNER IT WAS SEALED TO', () => {
  it('each of ours, the company\'s own and none opens as what was sealed', () => {
    for (const choice of [OUR_SERVICE, OWN, NONE]) {
      const rec = sealCompanyService({ company: 'acc_1', version: 3, sealing: SEALING, choice, signers });
      /* RED WHEN: a sealed choice opens as another choice, or under another record. */
      expect(rec.kind).toBe(COMPANY_SERVICE_RECORD.kind);
      expect(rec.id).toBe(COMPANY_SERVICE_RECORD.id);
      expect(openCompanyService(rec, opener('bea', BEA.secret))).toEqual(choice);
    }
  });

  it('a version filed as another version, or opened by a seat it was not sealed to, is refused', () => {
    const rec = sealCompanyService({ company: 'acc_1', version: 2, sealing: SEALING, choice: OWN, signers });
    /* RED WHEN: a version replayed under another version number is believed. */
    expect(() => openCompanyService({ ...rec, version: 5 }, opener('ada', ADA.secret))).toThrow(CompanyServiceRefused);
    /* RED WHEN: a version replayed under another company is believed. */
    expect(() => openCompanyService({ ...rec, company: 'acc_2' }, opener('ada', ADA.secret))).toThrow(/another record or version/u);
    /* RED WHEN: a seat outside the wraps, holding no key of the company, opens a version. */
    expect(() => openCompanyService(rec, opener('cy', ADA.secret))).toThrow(/not sealed to this seat/u);
  });

  it('a version is opened with the key the seat\'s own copy gives, and the seat is handed its own copy alone', () => {
    const rec = sealCompanyService({ company: 'acc_1', version: 4, sealing: SEALING, choice: OWN, signers });
    const handed: unknown[] = [];
    expect(openCompanyService(rec, { ...opener('bea', BEA.secret, atTwo), keyOf: (w) => { handed.push(w); return unwrapKey(w, BEA.secret) as Hex; } })).toEqual(OWN);
    /* RED WHEN: the seat opening a version is handed another seat's copy of its key, or more than its own. */
    expect(handed).toEqual([rec.wrapped.find((w) => w.signerId === 'bea')!.wrapped]);
    /* RED WHEN: a key that is not the version's own is believed to open it. */
    expect(() => openCompanyService(rec, { ...opener('bea', BEA.secret), keyOf: () => newSymmetricKey() })).toThrow(/would not open with this seat's key/u);
  });
});

describe('EVERY SIGNER HOLDING THE COMPANY\'S KEY AT THE SEALING EPOCH OPENS A VERSION, HOWEVER LATE SEATED', () => {
  it('a version carries one more copy of its key, for the company\'s key at the epoch it was sealed under, beside each seat\'s', () => {
    const rec = sealCompanyService({ company: 'acc_1', version: 1, sealing: SEALING, choice: OWN, signers });
    /* RED WHEN: a version is not wrapped once to the company's key, or no longer to each seat named, or names another epoch. */
    expect(rec.wrapped.map((w) => w.signerId)).toEqual(['ada', 'bea', COMPANY_WRAP_ID]);
    expect(rec.keyEpoch).toBe(2);
  });

  it('a seat outside the wraps opens it with the company\'s key at the sealing epoch', () => {
    const rec = sealCompanyService({ company: 'acc_1', version: 1, sealing: SEALING, choice: NONE, signers });
    /* RED WHEN: a signer seated after a version was filed cannot open it with the company's key it holds. */
    expect(openCompanyService(rec, opener('cy', newWrappingKeypair().secret, atTwo))).toEqual(NONE);
  });

  it('a key that is not the company\'s at the sealing epoch, or another company\'s, does not open it', () => {
    const rec = sealCompanyService({ company: 'acc_1', version: 1, sealing: SEALING, choice: NONE, signers });
    const other = newSymmetricKey();
    /* RED WHEN: a key other than the company's at the sealing epoch opens a version. */
    expect(() => openCompanyService(rec, opener('cy', ADA.secret, () => other))).toThrow(/not sealed to this seat, and the company's key at epoch 2 does not open it here/u);
    /* RED WHEN: a device holding the company's key only at another epoch opens a version. */
    expect(() => openCompanyService(rec, opener('cy', ADA.secret, (e) => (e === 1 ? KEY2 : noKey(e))))).toThrow(/not sealed to this seat/u);
    /* RED WHEN: a version served as sealed at another epoch opens with that epoch's key. */
    expect(() => openCompanyService({ ...rec, keyEpoch: 1 }, opener('cy', ADA.secret, () => other))).toThrow(CompanyServiceRefused);
    /* RED WHEN: the company copy derived for one company opens another company's version. */
    expect(() => openCompanyService(rec, { ...opener('cy', ADA.secret), companyCopy: openedWithTheCompanyKey('acc_2', atTwo) })).toThrow(CompanyServiceRefused);
  });

  it('a version filed in the old form, wrapped to the seats alone, still opens for those seats and no other', () => {
    const sealed = sealCompanyService({ company: 'acc_1', version: 1, sealing: SEALING, choice: OWN, signers });
    const old = { ...sealed, wrapped: sealed.wrapped.filter((w) => w.signerId !== COMPANY_WRAP_ID) };
    /* RED WHEN: a version filed before the company copy existed no longer opens for the seats it was sealed to. */
    expect(openCompanyService(old, opener('ada', ADA.secret, atTwo))).toEqual(OWN);
    /* RED WHEN: a seat outside an old version's wraps opens it. */
    expect(() => openCompanyService(old, opener('cy', ADA.secret, atTwo))).toThrow(/not sealed to this seat/u);
  });

  it('no seat may stand under the id the company\'s copy is kept by, and a version carrying two such copies is refused', () => {
    /* RED WHEN: a seat named as the company's copy is sealed to, so its own copy could stand in for the company's. */
    expect(() => sealCompanyService({ company: 'acc_1', version: 1, sealing: SEALING, choice: OWN, signers: [...signers, { id: COMPANY_WRAP_ID, wrappingPublicKey: ADA.publicKey }] }))
      .toThrow(/kept for the company's key/u);
    const rec = sealCompanyService({ company: 'acc_1', version: 1, sealing: SEALING, choice: OWN, signers });
    /* RED WHEN: a seat opening as the company's copy is believed. */
    expect(() => openCompanyService(rec, opener(COMPANY_WRAP_ID, ADA.secret, atTwo))).toThrow(/kept for the company's key/u);
    const twice = { ...rec, wrapped: [...rec.wrapped, rec.wrapped[0]!].map((w, i) => (i === 0 ? { ...w, signerId: COMPANY_WRAP_ID } : w)) };
    /* RED WHEN: a version with more than one company copy is opened. */
    expect(() => openCompanyService(twice, opener('cy', ADA.secret, atTwo))).toThrow(/more than one copy for the company's key/u);
  });
});

describe('A CHOICE IS IN FORCE ONLY ONCE AS MANY SEATS AS A POLICY CHANGE NEEDS HAVE FILED IT', () => {
  it('ours, the company\'s own and none are each chosen from the record once two seats file them', () => {
    for (const choice of [OUR_SERVICE, OWN, NONE]) {
      /* RED WHEN: a choice two seats agreed on is not the one in force. */
      expect(serviceInForce([v(1, 'a1', choice), v(2, 'b2', choice)], 2)).toEqual({ choice });
    }
  });

  it('no record at all is our service, and says so', () => {
    /* RED WHEN: a company with no choice filed is sent anywhere but our service, or is not told why. */
    expect(serviceInForce([], 2)).toEqual({ choice: OUR_SERVICE, unchosen: expect.stringMatching(/has not chosen a service/u) });
  });

  it('one seat\'s choice is not applied, even filed twice, and what was agreed before stays in force', () => {
    /* RED WHEN: one seat alone moves every seat's calls to another service. */
    expect(serviceInForce([v(1, 'a1', OWN)], 2)).toEqual({ choice: OUR_SERVICE, unchosen: expect.stringMatching(/the 2 seats a change of policy needs/u) });
    expect(serviceInForce([v(1, 'a1', OWN), v(2, 'A1', OWN)], 2).choice).toEqual(OUR_SERVICE);
    /* RED WHEN: one seat asking for something else undoes what the company agreed. */
    expect(serviceInForce([v(1, 'a1', NONE), v(2, 'b2', NONE), v(3, 'a1', OWN)], 2).choice).toEqual(NONE);
  });

  it('a version no believed seat filed is not counted, and a choice asked in between starts the count again', () => {
    /* RED WHEN: a version this device does not believe a seat filed counts towards a change. */
    expect(serviceInForce([v(1, 'a1', OWN), v(2, null, OWN)], 2).choice).toEqual(OUR_SERVICE);
    /* RED WHEN: agreement is counted across a version that asked for something else. */
    expect(serviceInForce([v(1, 'a1', OWN), v(2, 'b2', NONE), v(3, 'c3', OWN)], 2).choice).toEqual(OUR_SERVICE);
    expect(serviceInForce([v(1, 'a1', OWN), v(2, 'b2', NONE), v(3, 'c3', OWN), v(4, 'b2', OWN)], 2).choice).toEqual(OWN);
  });
});

describe('WHAT THE NEWEST VERSIONS ASK, COUNTED AS THE CHOICE IN FORCE IS', () => {
  it('counts the different seats that filed the newest ask unchanged, one after another, against the bar', () => {
    /* RED WHEN: a filing act tells the page a count the choice in force does not make. */
    expect(serviceAsked([], 2)).toBeNull();
    expect(serviceAsked([v(1, null, OWN)], 2)).toBeNull();
    expect(serviceAsked([v(1, 'a1', OWN), v(2, 'A1', OWN)], 2)).toEqual({ choice: OWN, by: 1, needed: 2 });
    expect(serviceAsked([v(1, 'a1', OWN), v(2, 'b2', OWN), v(3, 'a1', NONE)], 2)).toEqual({ choice: NONE, by: 1, needed: 2 });
    expect(serviceAsked([v(3, 'a1', NONE), v(1, 'a1', OWN), v(2, 'b2', OWN), v(4, 'b2', NONE)], 0)).toEqual({ choice: NONE, by: 2, needed: 1 });
  });
});

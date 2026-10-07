/**
 * **ON A CHAIN THIS SERVICE MAKES NOTHING FOR A COMPANY.** Its founding
 * signer's device makes the seat and every secret the company starts with, and
 * sends only public halves, a leaf, and what those secrets seal. The service
 * checks that what it was sent fits together and fits the person and the label,
 * records it, and refuses anything that carries a secret.
 */
import { describe, expect, it } from 'vitest';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { MemoryStore } from '../core/store.js';
import { foundTheCompanyHere, type CompanyFounded } from '../core/company-founding.js';
import { newSigningKeypair, newWrappingKeypair, type Hex } from '../core/crypto.js';
import type { SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { signCompanyFiling, type CompanyRecordKind } from '../midnight/sealed-record-wire.js';
import { MemoryCompanyRecordStore } from './company-records-route.js';
import { aCompanyCreatedOnTheLedger, recordTheCompanyMadeOnTheDevice, secretCarried } from './account-creation.js';
import { newStateBlinding } from '../core/account.js';
import { newSeatKeys } from '../../packages/web-shared/src/accept-seat.js';

const LABEL = `co_${'3d'.repeat(32)}` as CompanyLabel;
const OTHER_LABEL = `co_${'4d'.repeat(32)}` as CompanyLabel;
const PERSON = 'usr_founder';
const KEY = { tag: 'schnorr' as const, value: '7a'.repeat(32) };
const LEAF = '4e'.repeat(32);

/** The founding seat's signing secret each company made here was signed with, for a test that signs another of its records. */
const SEAT_SECRET = new WeakMap<CompanyFounded, Hex>();
const madeHere = (over: { label?: CompanyLabel; userId?: string } = {}): CompanyFounded => {
  const signing = newSigningKeypair();
  const f = foundTheCompanyHere({
    name: 'Acme Ltd', signer: { name: 'Priya', role: 'admin' }, userId: over.userId ?? PERSON, label: over.label ?? LABEL,
    seat: { signingPublicKey: signing.publicKey, wrappingPublicKey: newWrappingKeypair().publicKey, leaf: LEAF },
    signingSecret: signing.secret,
  });
  SEAT_SECRET.set(f, signing.secret);
  return f;
};

const request = (founding: unknown, over: Record<string, unknown> = {}) => ({
  name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' }], threshold: 1, companyLabel: LABEL, foundingKey: KEY, founding,
  ...over,
});

function aService(opts: { noFiling?: true; wiring?: 'midnight' | 'simulated'; whileFiling?: (store: MemoryStore) => void } = {}) {
  const store = new MemoryStore();
  const filed: SealedCompanyRecord[] = [];
  const ledger = { wiring: opts.wiring ?? 'midnight', ...(opts.noFiling ? {} : { takesCompaniesFromTheirFoundingSigner: true }) };
  /* The service's own record store, which refuses a version filed twice; `filed` is what it took. */
  const kept = new MemoryCompanyRecordStore();
  const records = {
    get: (company: string, kind: CompanyRecordKind, id: string) => kept.get(company, kind, id),
    put: async (rec: SealedCompanyRecord) => { await kept.put(rec); filed.push(rec); opts.whileFiling?.(store); },
  };
  const send = (body: unknown, userId = PERSON) => recordTheCompanyMadeOnTheDevice({ store, ledger: ledger as never, records }, userId, body);
  return { store, filed, records, send };
}

/** A deep copy with one change, so a refusal is of exactly that change. */
const changed = (f: CompanyFounded, edit: (x: any) => void): unknown => {
  const copy = JSON.parse(JSON.stringify(f));
  edit(copy);
  return copy;
};

describe('A COMPANY ITS FOUNDING SIGNER\'S DEVICE MADE', () => {
  it('IS RECORDED AS SENT: THE COMPANY, ITS FIRST STATE, AND WHAT ITS ACCOUNT MUST BE DEPLOYED FROM, AND NOTHING IS MADE HERE', async () => {
    const s = aService();
    const f = madeHere();
    const answer = await s.send(request(f));
    expect(answer).toEqual({ status: 201, body: { account: { id: f.account.id }, state: 'made' } });
    /* RED WHEN: the record kept is not the one the device sealed, or does not say which ledger it is on. */
    expect(s.store.getAccount(f.account.id)).toEqual({ ...f.account, wiring: 'midnight' });
    /* RED WHEN: the account would be read against another seat, key or label than the device made and the wallet gave. */
    expect(s.store.getAccountOpening(f.account.id)).toEqual({ accountId: f.account.id, foundingKey: KEY, foundingLeaf: LEAF, companyLabel: LABEL });
    /* RED WHEN: the first state or roster kept is not the record the device sealed and its founding seat signed. */
    expect(s.filed).toEqual([f.state, f.roster]);
    /* RED WHEN: the signers are kept anywhere but the roster record: the account record carries none. */
    expect(f.account.sealedRoster).toBeUndefined();
    expect(s.store.getAccount(f.account.id)!.sealedRoster).toBeUndefined();
    /* RED WHEN: the answer carries anything secret, or anything this service made. */
    expect(secretCarried(answer)).toBeNull();
  });

  it('SENT AGAIN, IS THE SAME COMPANY: THE SAME ANSWER, NOTHING NEW RECORDED, AND A DIFFERENT ONE UNDER THE SAME ID IS REFUSED', async () => {
    const s = aService();
    const f = madeHere();
    await s.send(request(f));
    /* RED WHEN: a page that did not hear the first answer makes a second company, or is refused, by sending it again. */
    expect(await s.send(request(f))).toEqual({ status: 200, body: { account: { id: f.account.id }, state: 'made' } });
    expect(s.filed).toHaveLength(2);
    expect(s.store.listAccounts()).toHaveLength(1);
    /* RED WHEN: another company sent under an id already recorded is written over the first. */
    const other = (() => {
      const o = changed(madeHere(), (x) => { x.account.id = f.account.id; x.account.wrappedKeys[0].signerId = x.seat.signerId; }) as any;
      const signing = newSigningKeypair();
      const { filedBy: _was, ...unsigned } = o.state;
      const { filedBy: _wasToo, ...unsignedRoster } = o.roster;
      return {
        ...o, seat: { ...o.seat, signingPublicKey: signing.publicKey },
        state: signCompanyFiling({ ...unsigned, company: f.account.id }, signing.secret),
        roster: signCompanyFiling({ ...unsignedRoster, company: f.account.id }, signing.secret),
      };
    })();
    const refused = await s.send(request(other));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('company-taken');
    expect(s.store.getAccount(f.account.id)).toEqual({ ...f.account, wiring: 'midnight' });
  });

  it('SENT AGAIN WITH ANOTHER FIRST ROSTER, THE COMPANY RECORDED IS REFUSED, AND ITS ROSTER IS NOT WRITTEN OVER', async () => {
    const s = aService();
    const f = madeHere();
    await s.send(request(f));
    /* The same company, with a first roster of other bytes, still signed by the founding seat. */
    const { filedBy: _was, ...unsigned } = f.roster;
    const other = { ...f, roster: signCompanyFiling({ ...unsigned, sealed: { ...unsigned.sealed, iv: '00'.repeat(12) } }, SEAT_SECRET.get(f)!) };
    const answer = await s.send(request(other));
    /* RED WHEN: a creation sent again with a different first roster answers as the same company, or writes the roster over. */
    expect([answer.status, answer.body.code]).toEqual([409, 'company-taken']);
    expect(s.filed).toEqual([f.state, f.roster]);
  });

  it('A FIRST STATE ALREADY KEPT IS NOT FILED AGAIN, AND ANOTHER UNDER THE SAME ID IS REFUSED, RECORDING NOTHING', async () => {
    const s = aService();
    const f = madeHere();
    await s.records.put(f.state);
    /* RED WHEN: a creation carried again after its state was kept, and before its company was, files the state twice. */
    expect((await s.send(request(f))).status).toBe(201);
    expect(s.filed).toEqual([f.state, f.roster]);
    const t = aService();
    const other = madeHere();
    await t.records.put({ ...f.state, company: other.account.id });
    /* RED WHEN: a creation is recorded whose company has a different first state kept. */
    expect((await t.send(request(other))).body).toMatchObject({ code: 'company-taken' });
    expect(t.store.getAccount(other.account.id)).toBeNull();
  });

  it('THE SAME CREATION SENT TWICE AT ONCE FILES ITS FIRST STATE ONCE AND IS ONE COMPANY', async () => {
    const s = aService();
    const f = madeHere();
    const answers = await Promise.all([s.send(request(f)), s.send(request(f))]);
    /* RED WHEN: the second of two concurrent sends is refused, or fails on the store's refusal of a second version 1. */
    expect(answers.map((a) => a.status).sort()).toEqual([201, 201]);
    expect(s.filed).toEqual([f.state, f.roster]);
    expect(s.store.listAccounts().map((a) => a.id)).toEqual([f.account.id]);
  });

  it('EVERY SECRET THE DEVICE MAKES AT A FOUNDING IS ONE THE SERVICE REFUSES BY NAME', () => {
    const seat = newSeatKeys();
    const secretOfTheSeat = Object.keys(seat).filter((k) => !k.endsWith('PublicKey'));
    /* RED WHEN: the device makes a secret under a name the service's refusal does not know, so it would be carried as an unknown field and not refused as a secret. */
    for (const name of [...secretOfTheSeat, ...Object.keys(newStateBlinding()), 'viewingKey']) {
      expect(secretCarried({ founding: { [name]: 'aa' } }), name).toBe(name);
    }
    expect(secretOfTheSeat.length).toBeGreaterThan(0);
  });

  it('A REQUEST CARRYING ANY SECRET IS REFUSED BY NAME BEFORE ANYTHING IS READ OR RECORDED', async () => {
    const places: Array<(x: any, name: string) => void> = [
      (x, n) => { x[n] = 'aa'.repeat(32); },
      (x, n) => { x.founding[n] = 'aa'.repeat(32); },
      (x, n) => { x.founding.seat[n] = 'aa'.repeat(32); },
      (x, n) => { x.founding.state[n] = 'aa'.repeat(32); },
    ];
    for (const name of ['signingSecret', 'wrappingSecret', 'blinding', 'viewingKey', 'assetBlinding', 'payoutSeeds', 'payRecordKey', 'secrets', 'seed']) {
      for (const put of places) {
        const s = aService();
        const body = JSON.parse(JSON.stringify(request(madeHere())));
        put(body, name);
        const answer = await s.send(body);
        /* RED WHEN: a secret sent under that name, at that depth, is carried, ignored or recorded. */
        expect([answer.status, answer.body.code, answer.body.error], name).toEqual([400, 'a-secret-was-sent', expect.stringContaining(`"${name}"`)]);
        expect(s.store.listAccounts()).toEqual([]);
        expect(s.filed).toEqual([]);
      }
    }
  });

  it('A CREATION THAT CARRIES NOTHING THE DEVICE MADE IS REFUSED: ON A CHAIN THIS SERVICE MAKES NO SECRET', async () => {
    const s = aService();
    const { founding: _none, ...rest } = request(madeHere());
    const answer = await s.send(rest);
    /* RED WHEN: a creation with no company made on the device is taken, which is this service making its secrets. */
    expect([answer.status, answer.body.code]).toEqual([409, 'made-on-the-founding-signers-device']);
    expect(s.store.listAccounts()).toEqual([]);
  });

  it('A COMPANY IS CREATED WITH ITS FOUNDING SIGNER ONLY', async () => {
    for (const over of [{ signers: [{ name: 'Priya', role: 'admin' }, { name: 'Sam', role: 'approver' }] }, { threshold: 2 }]) {
      const s = aService();
      const answer = await s.send(request(madeHere(), over));
      /* RED WHEN: a second signer or a threshold above one is taken. */
      expect([answer.status, answer.body.code]).toEqual([400, 'founded-with-its-founding-signer-only']);
      expect(s.store.listAccounts()).toEqual([]);
    }
  });

  it('REFUSES A COMPANY THAT DOES NOT FIT ITSELF, THE PERSON OR THE LABEL, AND ANY PART NOT AS THE DEVICE MAKES IT', async () => {
    const cases: Array<[string, unknown, number, string]> = [
      ['held by somebody else', madeHere({ userId: 'usr_other' }), 422, 'the-company-does-not-fit'],
      ['another label', madeHere({ label: OTHER_LABEL }), 422, 'the-company-does-not-fit'],
      ['viewing key wrapped to another seat', changed(madeHere(), (x) => { x.account.wrappedKeys[0].signerId = 'sgn_AAAAAAAAAA'; }), 422, 'the-company-does-not-fit'],
      ['a seat of zeroes', changed(madeHere(), (x) => { x.seat.leaf = '00'.repeat(32); }), 422, 'the-company-does-not-fit'],
      ['a second wrapped key', changed(madeHere(), (x) => { x.account.wrappedKeys.push(x.account.wrappedKeys[0]); }), 400, 'not-a-company-made-on-the-device'],
      ['a pending signer', changed(madeHere(), (x) => { x.account.pendingSigners.push({ id: 'p' }); }), 400, 'not-a-company-made-on-the-device'],
      ['a later key epoch', changed(madeHere(), (x) => { x.state.keyEpoch = 1; }), 400, 'not-a-company-made-on-the-device'],
      ['a first state with no signature', changed(madeHere(), (x) => { delete x.state.filedBy; }), 400, 'not-a-company-made-on-the-device'],
      ['a first state its signature does not cover', changed(madeHere(), (x) => { x.state.sealed.body = `${x.state.sealed.body}00`; }), 422, 'the-company-does-not-fit'],
      ['a first state signed by another seat', (() => {
        const f = madeHere();
        const { filedBy: _was, ...unsigned } = f.state;
        return { ...f, state: signCompanyFiling(unsigned, newSigningKeypair().secret) };
      })(), 422, 'the-company-does-not-fit'],
      ['a first roster signed by a seat other than the founding signer\'s', (() => {
        const f = madeHere();
        const { filedBy: _was, ...unsigned } = f.roster;
        return { ...f, roster: signCompanyFiling(unsigned, newSigningKeypair().secret) };
      })(), 422, 'the-company-does-not-fit'],
      ['a first roster at a later version', (() => {
        const f = madeHere();
        const { filedBy: _was, ...unsigned } = f.roster;
        return { ...f, roster: { ...unsigned, version: 2, filedBy: f.roster.filedBy } };
      })(), 400, 'not-a-company-made-on-the-device'],
      ['a first roster filed for another company', (() => {
        const f = madeHere();
        const { filedBy: _was, ...unsigned } = f.roster;
        return { ...f, roster: { ...unsigned, company: 'acc_another', filedBy: f.roster.filedBy } };
      })(), 422, 'the-company-does-not-fit'],
      ['the signers carried on the account record as well', changed(madeHere(), (x) => { x.account.sealedRoster = x.account.sealedPolicy; }), 400, 'not-a-company-made-on-the-device'],
      ['a first state filed for another company', (() => {
        const f = madeHere();
        const { filedBy: _was, ...unsigned } = f.state;
        return { ...f, state: { ...unsigned, company: 'acc_another', filedBy: f.state.filedBy } };
      })(), 422, 'the-company-does-not-fit'],
      ['a record already given an address', changed(madeHere(), (x) => { x.account.contractAddress = 'aa'.repeat(32); }), 400, 'not-a-company-made-on-the-device'],
      ['two seats on the record', changed(madeHere(), (x) => { x.account.signerCount = 2; }), 400, 'not-a-company-made-on-the-device'],
      ['a field nobody named', changed(madeHere(), (x) => { x.seat.extra = 'aa'; }), 400, 'not-a-company-made-on-the-device'],
      ['an id this service would not make', changed(madeHere(), (x) => { x.account.id = 'acc_../../x'; }), 400, 'not-a-company-made-on-the-device'],
    ];
    for (const [why, founding, status, code] of cases) {
      const s = aService();
      const answer = await s.send(request(founding));
      /* RED WHEN: the named misfit is recorded. */
      expect([answer.status, answer.body.code], why).toEqual([status, code]);
      expect(s.store.listAccounts(), why).toEqual([]);
      expect(s.filed, why).toEqual([]);
    }
  });

  it('REFUSES A LABEL ANOTHER COMPANY HAS, AND A DEPLOYMENT THAT KEEPS NO FIRST STATE, RECORDING NOTHING', async () => {
    const s = aService();
    await s.send(request(madeHere()));
    const second = await s.send(request(madeHere()));
    /* RED WHEN: two companies are recorded with one label. */
    expect([second.status, second.body.code]).toEqual([409, 'company-label-taken']);
    expect(s.store.listAccounts()).toHaveLength(1);
    const none = aService({ noFiling: true });
    const f = madeHere();
    const answer = await none.send(request(f));
    /* RED WHEN: a company is recorded whose first state was kept nowhere. */
    expect(answer.status).toBe(503);
    expect(none.store.listAccounts()).toEqual([]);
    expect(none.store.getAccountOpening(f.account.id)).toBeNull();
  });
});

describe('THE ONE SEALING CODE', () => {
  it('THE DEVICE SEALS WITH THE FUNCTIONS THIS SERVICE SEALS WITH: ITS STATE OPENS AS THE SERVICE READS ONE', async () => {
    const { unwrapKey, unseal, parseCanonical } = await import('../core/crypto.js');
    const { openAccount, sealState, newStateBlinding } = await import('../core/account.js');
    const wk = newWrappingKeypair();
    const signing = newSigningKeypair();
    const f = foundTheCompanyHere({
      name: 'Acme Ltd', signer: { name: 'Priya', role: 'admin' }, userId: PERSON, label: LABEL,
      seat: { signingPublicKey: signing.publicKey, wrappingPublicKey: wk.publicKey, leaf: LEAF },
      signingSecret: signing.secret,
    });
    const viewingKey = unwrapKey(f.account.wrappedKeys[0]!, wk.secret) as Hex;
    /* RED WHEN: the record is sealed some other way than the one opener reads. */
    expect(openAccount(f.account, viewingKey, f.roster).name).toBe('Acme Ltd');
    /* RED WHEN: the record carries the signers beside the roster record, a second copy of them. */
    expect(() => openAccount(f.account, viewingKey, null)).toThrow(/could not be found/u);
    const opened = parseCanonical<any>(unseal(f.state.sealed, viewingKey));
    /* RED WHEN: the state is sealed in another shape than the service's own sealing makes, or with other parts. */
    const ours = parseCanonical<any>(unseal(sealState(opened.state, opened.blinding, viewingKey, 0).sealed, viewingKey));
    expect(opened).toEqual(ours);
    expect(Object.keys(newStateBlinding()).sort()).toEqual(Object.keys(opened.blinding).sort());
    expect(opened.blinding.payoutSeeds).toEqual([{ epoch: 0, seed: expect.stringMatching(/^[0-9a-f]{64}$/u) }]);
    expect(new Set([opened.blinding.assetBlinding, opened.blinding.payRecordKey, opened.blinding.payoutSeeds[0].seed]).size).toBe(3);
  });
});

describe('THE ONE WAY A COMPANY IS CREATED ON A CHAIN', () => {
  it('ON A CHAIN, ONLY AS THE DEVICE MADE IT: THE OLD CREATION IS REFUSED BY NAME, AND THE SIMULATED LEDGER KEEPS ITS OWN', async () => {
    const chain = aService();
    const old = { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' }], threshold: 1, companyLabel: LABEL };
    /* RED WHEN: on a chain, a creation that names no founding key reaches any creation at all, which would make the company's secrets here. */
    expect(await aCompanyCreatedOnTheLedger({ store: chain.store, ledger: { wiring: 'midnight' } as never, records: chain.records }, PERSON, old))
      .toMatchObject({ status: 409, body: { code: 'created-from-the-founding-signers-browser' } });
    expect(chain.store.listAccounts()).toEqual([]);
    /* RED WHEN: on a chain, a company the device made is not recorded as it was sent. */
    const f = madeHere();
    const sim = aService({ wiring: 'simulated' });
    const send = (s: ReturnType<typeof aService>, body: unknown) =>
      aCompanyCreatedOnTheLedger({ store: s.store, ledger: { wiring: s === sim ? 'simulated' : 'midnight', takesCompaniesFromTheirFoundingSigner: true } as never, records: s.records }, PERSON, body);
    expect(await send(chain, request(f))).toEqual({ status: 201, body: { account: { id: f.account.id }, state: 'made' } });
    expect(chain.filed).toHaveLength(2);
    /* RED WHEN: the simulated ledger, which development and the tests run on, is sent down the chain's path. */
    expect(await send(sim, old)).toBeNull();
    expect(sim.store.listAccounts()).toEqual([]);
  });

  it('AN ID WHOSE OPENING ANOTHER CREATION ALREADY RECORDED IS REFUSED, AND NOTHING OF THIS ONE IS KEPT', async () => {
    const s = aService();
    const f = madeHere();
    s.store.recordAccountOpening({ accountId: f.account.id, foundingKey: KEY, foundingLeaf: '5f'.repeat(32), companyLabel: LABEL });
    /* RED WHEN: a creation goes on to keep its state and its company under an id another creation has already opened. */
    expect((await s.send(request(f))).body).toMatchObject({ code: 'company-taken' });
    expect(s.filed).toEqual([]);
    expect(s.store.getAccount(f.account.id)).toBeNull();
  });

  it('TWO COMPANIES WITH ONE LABEL ARE NEVER BOTH RECORDED, EVEN WHEN THE OTHER IS RECORDED WHILE THIS ONE\'S STATE IS BEING KEPT', async () => {
    const f = madeHere();
    const s = aService({
      whileFiling: (store) => { store.putAccount({ ...madeHere().account, id: 'acc_the_other_one' } as never); },
    });
    /* RED WHEN: the label is asked about only before the state is kept, so a company recorded meanwhile with the same label is joined by a second. */
    expect((await s.send(request(f))).body).toMatchObject({ code: 'company-label-taken' });
    expect(s.store.getAccount(f.account.id)).toBeNull();
    expect(s.store.listAccounts().map((a) => a.id)).toEqual(['acc_the_other_one']);
  });
});


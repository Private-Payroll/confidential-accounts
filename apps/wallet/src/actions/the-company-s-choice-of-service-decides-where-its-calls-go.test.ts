/**
 * **WHERE AN ACT'S CALLS GO IS THE COMPANY'S CHOICE OF SERVICE, READ FROM ITS OWN RECORD, NEVER THE ACT'S, AND THE
 * WALLET FALLS BACK ON ITS OWN, SAYING SO IN ONE LINE.**
 *
 * The record's versions are sealed and signed here as two seats would file them; which filer the company's directory
 * believes is a stand-in judge. The company's own service is a stand-in that logs what it is handed; the fee
 * sponsorship is a stand-in that hands a call back with one DUST spend added.
 */
import { describe, it, expect, vi } from 'vitest';
import { newSigningKeypair, unwrapKey, type Hex } from '../../../../src/core/crypto.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import { COMPANY_WRAP_ID, OUR_SERVICE, openedWithTheCompanyKey, sealCompanyService, type CompanyService } from '../../../../src/midnight/company-service-record.js';
import { signCompanyFiling, toCompanyWire, type SealedCompanyRecord } from '../../../../src/midnight/sealed-record-wire.js';
import { recordKeyOf } from '../../../../src/midnight/record-manifest.js';
import { handedOver, notThroughOurService } from '../../../../packages/web-shared/src/hand-over.js';
import { apiOver, companyServiceHere, handOverFor, handOverMarked, serviceFromVersions, serviceOpenerFor, versionsNamedIn } from './company-reach.js';
import { StepRefused, type ActionDefinition, type ActionStep, type Held, type StepContext } from './definition.js';
import { RELAY_PATIENCE_MS, runAction } from './run.js';
import { readActEnded } from 'midnight-identity/profile/act-channel';
import type { ActEnded, ActingChannel } from 'midnight-identity/profile/channel';
import type { ActRequest } from 'midnight-identity/profile/request';

const COMPANY = 'acc_choice';
const ACCOUNT = 'ac'.repeat(32);
const LEAF = 'ae'.repeat(32) as Hex;
const RECORDS_SECRET = recordsKeypairFrom(new Uint8Array(32).fill(7)).secret as Hex;
/** The company's key at epoch 0 and at epoch 1; this device holds the first alone. */
const KEY0 = '0c'.repeat(32) as Hex;
const KEY1 = '1c'.repeat(32) as Hex;
const keyAt = (epoch: number): Hex => {
  if (epoch !== 0) throw new Error(`this device holds no key of the company at epoch ${epoch}, so nothing sealed under it opens here.`);
  return KEY0;
};
const me = {
  signerId: LEAF, keyOf: (w: Parameters<typeof unwrapKey>[0]) => unwrapKey(w, RECORDS_SECRET) as Hex, companyCopy: openedWithTheCompanyKey(COMPANY, keyAt),
};
/** A version as filed before the company's copy existed: wrapped to the seats named alone. */
const oldForm = (rec: SealedCompanyRecord): SealedCompanyRecord => ({ ...rec, wrapped: rec.wrapped.filter((w) => w.signerId !== COMPANY_WRAP_ID) });
const signers = [{ id: LEAF, wrappingPublicKey: recordsKeypairFrom(new Uint8Array(32).fill(7)).publicKey as Hex }];
const ADA = newSigningKeypair();
const BEA = newSigningKeypair();
const OWN: CompanyService = { service: 'own', at: 'https://relay.example.com' };
const NONE: CompanyService = { service: 'none' };

const filed = (version: number, by: { secret: string }, choice: CompanyService): SealedCompanyRecord =>
  signCompanyFiling(sealCompanyService({ company: COMPANY, version, sealing: { key: KEY0, epoch: 0 }, choice, signers }), by.secret as Hex);
const believing = (...seats: { publicKey: string }[]) => (filer: Hex | null) =>
  (filer !== null && seats.some((s) => s.publicKey === filer) ? null : 'not a seat this device believes');
type Judge = Parameters<typeof serviceFromVersions>[1]['judge'];
/** What the company's anchored records show of the record: every version they name, and whether any is withheld. */
const read = (
  served: SealedCompanyRecord[], judge: Judge = believing(ADA, BEA), needed = 2,
  o: { named?: readonly number[]; withheld?: string | null; seatedNow?: readonly { publicKey: string }[] } = {},
) => serviceFromVersions(served, {
  company: COMPANY, judge, needed, me,
  named: o.named ?? served.map((r) => r.version), withheld: o.withheld ?? null,
  seatedNow: (filer) => (o.seatedNow ?? [ADA, BEA]).some((x) => x.publicKey === filer),
});
const unread = (why: RegExp) => ({ unread: expect.stringMatching(why) });

const anAct = (fields: Record<string, string>, name = 'approve-proposal', shown: unknown[] = []) => ({
  intent: { name, fields }, held: { identity: {} as never, account: 0 }, signal: new AbortController().signal,
  show: (words: unknown) => { shown.push(words); },
}) as unknown as Pick<StepContext, 'intent' | 'held' | 'signal' | 'show'>;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const intentOf = (actions: readonly unknown[]) =>
  ({ actions, guaranteedUnshieldedOffer: undefined, fallibleUnshieldedOffer: undefined, dustActions: undefined });
/** This wallet's ledger, reading a call as the one call its words name, with one DUST spend when it says a fee was added. */
const ledger = async () => ({
  Transaction: {
    deserialize: (_s: 'signature', _p: 'proof', _b: 'pre-binding' | 'binding', raw: Uint8Array) => {
      const t = JSON.parse(Buffer.from(raw).toString()) as { circuit: string; to: string; fee?: true };
      const intents = new Map<number, unknown>([[1, intentOf([{ address: t.to, entryPoint: t.circuit, toString: () => `${t.to}:${t.circuit}` }])]]);
      if (t.fee === true) intents.set(2, { ...intentOf([]), dustActions: { spends: [1], registrations: [] } });
      return { guaranteedOffer: undefined, fallibleOffer: undefined, intents, imbalances: () => new Map(), identifiers: () => [`id:${t.to}:${t.circuit}`, ...(t.fee === true ? ['id:fee'] : [])] };
    },
  },
}) as never;
/* The person's wallet: no DUST of its own to pay with, and every call it sends logged. */
const aChain = (log: unknown[]) => ({
  ownWallet: () => ({
    ledger, keys: () => ({}) as never, signSegment: () => ({}) as never,
    facade: async () => ({
      dust: { state: { subscribe: (w: { next: (s: unknown) => void }) => { w.next({ progress: { isConnected: true, isStrictlyComplete: () => true } }); return { unsubscribe: () => {} }; } } },
      balanceUnboundTransaction: async () => { throw new Error('no fee is paid from this wallet'); },
      submitTransaction: async () => { log.push('sent to the chain'); },
      revert: async () => undefined,
    }) as never,
  }),
  fetch: (async (url: string, init: RequestInit) => { log.push({ url, init }); return new Response('{}', { status: 200 }); }) as typeof fetch,
});
/* Our fee sponsorship: hands the call back with one DUST spend added, logging that it was asked. */
const sponsorship = (log: unknown[]) => async (tx: string) => {
  log.push('sponsored');
  return { tx: b64({ ...JSON.parse(Buffer.from(tx, 'base64').toString()), fee: true }) };
};

describe('THE CHOICE IN FORCE IS READ FROM THE COMPANY\'S RECORD', () => {
  it('ours, the company\'s own and none are each the choice two believed seats filed', () => {
    for (const choice of [OUR_SERVICE, OWN, NONE]) {
      /* RED WHEN: a choice the company agreed on is not the one this wallet reads from its record. */
      expect(read([filed(1, ADA, choice), filed(2, BEA, choice)])).toEqual({ choice });
    }
  });

  it('one seat\'s choice is not applied without as many seats as a policy change needs', () => {
    /* RED WHEN: one seat's version alone sends every seat's calls to another service. */
    expect(read([filed(1, ADA, OWN)])).toMatchObject({ choice: OUR_SERVICE });
    /* RED WHEN: a version filed by a key the company's directory does not believe, and its records do not name, is counted. */
    expect(read([filed(1, BEA, OWN), filed(2, ADA, OWN)], believing(ADA), 2, { named: [2] })).toEqual({ choice: OUR_SERVICE, unchosen: expect.any(String) });
    /* RED WHEN: a version the company's records name and this device refuses is dropped from the count instead of leaving the choice unread. */
    expect(read([filed(1, BEA, OWN), filed(2, ADA, OWN)], believing(ADA))).toEqual(unread(/not a seat this device believes/u));
    /* RED WHEN: the number of seats needed is not the one the company's policy change needs. */
    expect(read([filed(1, ADA, OWN), filed(2, BEA, OWN)], believing(ADA, BEA), 3)).toMatchObject({ choice: OUR_SERVICE });
  });

  it('a version not believed is dropped unopened; a believed version that will not open leaves the choice unread', () => {
    const notMine = (by: { secret: string }) => signCompanyFiling(oldForm(sealCompanyService({ company: COMPANY, version: 2, sealing: { key: KEY0, epoch: 0 }, choice: OWN, signers: [{ id: 'someone', wrappingPublicKey: signers[0]!.wrappingPublicKey }] })), by.secret as Hex);
    const outsider = newSigningKeypair();
    /* RED WHEN: a version no believed seat filed, which this seat cannot open, stops the company's agreed choice. */
    expect(read([filed(1, ADA, NONE), notMine(outsider), filed(3, BEA, NONE)], believing(ADA, BEA), 2, { named: [1, 3] })).toEqual({ choice: NONE });
    /* RED WHEN: a believed version this seat cannot open is passed over, or read as our service. */
    expect(read([filed(1, ADA, OWN), notMine(BEA)])).toEqual(unread(/version 2 of the company's choice of service was not sealed to this seat/u));
  });

  it('a removed seat\'s filing is not counted; a choice it agreed is then unread, never ours or an older choice', () => {
    /* RED WHEN: a seat no longer seated still counts toward the company's choice by a filing it made while seated. */
    expect(read([filed(1, ADA, OWN), filed(2, BEA, OWN)], believing(ADA, BEA), 2, { seatedNow: [BEA] }))
      .toEqual(unread(/agreed by signers who are no longer seated.*A seated signer files the choice again/u));
    /* RED WHEN: a seat leaving brings back an older choice, or ours, without the seated signers filing it. */
    expect(read([filed(1, BEA, NONE), filed(2, ADA, OWN)], believing(ADA, BEA), 1, { seatedNow: [BEA] })).toEqual(unread(/no longer seated/u));
    expect(read([filed(1, ADA, OWN)], believing(ADA, BEA), 1, { seatedNow: [BEA] })).toEqual(unread(/no longer seated/u));
    /* RED WHEN: a removed seat's ask that never reached the bar stops a company that never agreed a choice. */
    expect(read([filed(1, ADA, OWN)], believing(ADA, BEA), 2, { seatedNow: [BEA] })).toEqual({ choice: OUR_SERVICE, unchosen: expect.any(String) });
    /* RED WHEN: the seated signers filing the agreed choice again does not bring it back into force. */
    expect(read([filed(1, ADA, OWN), filed(2, BEA, OWN), filed(3, BEA, OWN)], believing(ADA, BEA), 1, { seatedNow: [BEA] })).toEqual({ choice: OWN });
  });
});

describe('A SIGNER SEATED AFTER THE CHOICE WAS FILED, WITH NOBODY FILING IT AGAIN', () => {
  /* Two seats filed the choice before this one was seated, sealed to them and to the company's key at epoch 0. */
  const before = [{ id: 'f1'.repeat(32), wrappingPublicKey: recordsKeypairFrom(new Uint8Array(32).fill(9)).publicKey as Hex }];
  const sealedAt = (key: Hex, epoch: number, version: number, by: { secret: string }, choice: CompanyService): SealedCompanyRecord =>
    signCompanyFiling(sealCompanyService({ company: COMPANY, version, sealing: { key, epoch }, choice, signers: before }), by.secret as Hex);
  /* This seat's opener as its wallet builds it: its own copy opened with its records key, the company's with the keys it holds. */
  const late = serviceOpenerFor(COMPANY, LEAF, me.keyOf, { keyAt });
  const readLate = (served: SealedCompanyRecord[]) => serviceFromVersions(served, {
    company: COMPANY, judge: believing(ADA, BEA), needed: 2, me: late,
    named: served.map((r) => r.version), withheld: null, seatedNow: (filer) => [ADA, BEA].some((x) => x.publicKey === filer),
  });

  it('opens the choice the bar filed with the company\'s key, and its calls take the company\'s own service path', () => {
    const service = readLate([sealedAt(KEY0, 0, 1, ADA, OWN), sealedAt(KEY0, 0, 2, BEA, OWN)]);
    /* RED WHEN: a signer seated after the bar filed the choice reads it unread, or needs a seated signer to file it again. */
    expect(service).toEqual({ choice: OWN });
    /* RED WHEN: a signer seated after the choice does not send its calls through the company's own service. */
    expect(handOverFor(anAct({}), aChain([]), service)).toMatchObject({ path: 'company-service', at: 'https://relay.example.com' });
  });

  it('a version sealed at an epoch whose key this seat lacks reads unread, never ours, and the chain path stays open', async () => {
    const service = readLate([sealedAt(KEY0, 0, 1, ADA, OWN), sealedAt(KEY1, 1, 2, BEA, OWN)]);
    /* RED WHEN: a version this seat holds no key to open is read as a company that never chose, or as ours. */
    expect(service).toEqual(unread(/version 2 of the company's choice of service was not sealed to this seat, and the company's key at epoch 1 does not open it here/u));
    const log: unknown[] = [];
    const over = handOverFor(anAct({}), aChain(log), service, Date.now, sponsorship(log));
    /* RED WHEN: an unread choice sends a call through our service, or stops it, when the chain can take it. */
    expect(over.path).toBe('chain');
    expect(await handing(over)).toEqual({ relayed: false, refused: null, nothingWasSent: undefined });
    expect(log).toEqual(['sponsored', 'sent to the chain']);
  });
});

describe('A SIGNER SEATED AFTER A CHOICE FILED IN THE OLD FORM', () => {
  /* Two seats filed the choice before this one was seated, sealed to them alone; each version after it is sealed to all three. */
  const before = [{ id: 'f1'.repeat(32), wrappingPublicKey: recordsKeypairFrom(new Uint8Array(32).fill(9)).publicKey as Hex }];
  const all = [...signers, ...before];
  const sealedTo = (to: typeof signers, version: number, by: { secret: string }, choice: CompanyService): SealedCompanyRecord =>
    signCompanyFiling(oldForm(sealCompanyService({ company: COMPANY, version, sealing: { key: KEY0, epoch: 0 }, choice, signers: to })), by.secret as Hex);
  const agreedBefore = [sealedTo(before, 1, ADA, OWN), sealedTo(before, 2, BEA, OWN)];

  it('reads the choice unread, never ours, until enough seated signers have filed it again sealed to it too', () => {
    /* RED WHEN: a version sealed before this seat was seated is read as a company that never chose, or as ours. */
    expect(read(agreedBefore)).toEqual(unread(/version 2 of the company's choice of service was not sealed to this seat/u));
    /* RED WHEN: one seat filing the choice again is counted as agreed, below the bar. */
    expect(read([...agreedBefore, sealedTo(all, 3, ADA, OWN)])).toEqual(unread(/version 2 of the company's choice of service was not sealed to this seat/u));
  });

  it('reads the choice the versions after the last one it cannot open agree, once they reach the bar', () => {
    /* RED WHEN: a signer seated later never reads the company's choice, however many seated signers file it again. */
    expect(read([...agreedBefore, sealedTo(all, 3, ADA, OWN), sealedTo(all, 4, BEA, OWN)])).toEqual({ choice: OWN });
    /* RED WHEN: a version this seat cannot open after the agreement is passed over, so an older agreement is read past a newer ask. */
    expect(read([...agreedBefore, sealedTo(all, 3, ADA, OWN), sealedTo(all, 4, BEA, OWN), sealedTo(before, 5, ADA, NONE)]))
      .toEqual(unread(/version 5 of the company's choice of service was not sealed to this seat/u));
    /* RED WHEN: a version whose copy for this seat will not open stops this seat for good, or is passed over below the bar. */
    const broken = signCompanyFiling({ ...sealedTo(all, 3, ADA, OWN), sealed: sealedTo(all, 3, ADA, NONE).sealed }, ADA.secret as Hex);
    expect(read([...agreedBefore, broken, sealedTo(all, 4, BEA, OWN)]))
      .toEqual(unread(/version 3 of the company's choice of service would not open with this seat's key/u));
    expect(read([...agreedBefore, broken, sealedTo(all, 4, BEA, OWN), sealedTo(all, 5, ADA, OWN)])).toEqual({ choice: OWN });
  });
});

describe('A CHOICE THE SERVICE COULD HIDE IS NOT READ AS OURS: THE SERVICE PATH IS REFUSED', () => {
  it('a version the company\'s records name and the service withheld leaves the choice unread', () => {
    /* RED WHEN: the whole record withheld reads as a company that never chose. */
    expect(read([], believing(ADA, BEA), 2, { named: [1, 2], withheld: 'the company\'s records name version 2 of it and the service did not give it' }))
      .toEqual(unread(/did not give it/u));
    /* RED WHEN: a read the anchored records refuse for any reason (past a stop, not asked) is read as a company that never chose. */
    expect(read([], believing(ADA, BEA), 2, { named: [], withheld: 'the company\'s records stopped at a version this device cannot get past' }))
      .toEqual({ unread: 'the company\'s records stopped at a version this device cannot get past' });
    /* RED WHEN: a version withheld from the middle lets the versions around it agree. */
    expect(read([filed(1, ADA, OWN), filed(3, BEA, OWN)], believing(ADA, BEA), 2, { named: [1, 2, 3] }))
      .toEqual(unread(/records name version 2 of the company's choice of service, and the service did not give it/u));
    /* RED WHEN: the newest versions withheld leave an older agreement in force. */
    expect(read([filed(1, ADA, OWN), filed(2, BEA, OWN)], believing(ADA, BEA), 2, { named: [1, 2, 3, 4] })).toEqual(unread(/version 3/u));
  });

  it('the highest version served is judged as the newest, and one that is not leaves the choice unread', () => {
    const judge: Judge = (filer, _k, _key, _read, newest) => (newest ? 'a newer version of it is withheld' : believing(ADA, BEA)(filer));
    /* RED WHEN: the highest version served is not held to being the newest the company's records name. */
    expect(read([filed(1, ADA, OWN), filed(2, BEA, OWN)], judge)).toEqual(unread(/a newer version of it is withheld/u));
  });

  it('nothing named and nothing served is a company that never chose, which is our service', () => {
    /* RED WHEN: a company the anchored records prove never chose is sent anywhere but our service. */
    expect(read([], believing(), 2, { named: [] })).toEqual({ choice: OUR_SERVICE, unchosen: expect.stringMatching(/has not chosen a service/u) });
  });
});

describe('READING THE CHOICE THROUGH THE PAGE', () => {
  const KEY = recordKeyOf({ store: 'company', kind: 'policy', id: 'company-service' });
  /** The company's anchored records as a directory read holds them: the versions anchored, and those entered since. */
  const anchoredAs = (history: readonly number[], entered: readonly number[] = []) => async () => ({
    records: {
      asked: { records: new Set([KEY]), kinds: new Set() }, stopped: null,
      history: new Map(history.length === 0 ? [] : [[KEY, history.map((version) => ({ version, digest: 'd', filedBy: ADA.publicKey, batch: 1 }))]]),
      notYetAnchored: entered.map((version) => ({ store: 'company', kind: 'policy', id: 'company-service', version, digest: 'd', filedBy: { publicKey: ADA.publicKey } })),
    },
    holders: { approvals: 2, policyBar: null }, dir: { seats: [] }, another: new Set(),
  });
  const reach = (api: (path: string) => Promise<unknown>, directory: () => Promise<unknown> = async () => { throw new Error('the directory could not be read'); }) => ({
    accountId: COMPANY, api, label: 'l' as never, account: ACCOUNT as never, companyKeys: {} as never, roster: async () => ({}) as never,
    opener: me,
    judges: { directoryHereFor: () => directory } as never,
  });
  const notFound = async () => { throw Object.assign(new Error('not found'), { status: 404 }); };

  it('a company the anchored records show never chose is our service, and says it has not chosen', async () => {
    const asked: string[] = [];
    const none = await companyServiceHere(reach(async (path) => { asked.push(path); return notFound(); }, anchoredAs([])), anAct({}));
    /* RED WHEN: a company that never chose is sent anywhere but our service, or is not told why. */
    expect(none).toEqual({ choice: OUR_SERVICE, unchosen: expect.stringMatching(/has not chosen a service/u) });
    expect(asked).toEqual([`/api/accounts/${COMPANY}/records/policy/company-service/versions`]);
    expect(await companyServiceHere(reach(async () => ({ versions: [] }), anchoredAs([])), anAct({}))).toEqual(none);
  });

  it('nothing served while the anchored records name a version, anchored or entered, leaves the choice unread', async () => {
    /* RED WHEN: our service answering with nothing turns a company's choice back into our service. */
    expect(await companyServiceHere(reach(notFound, anchoredAs([1, 2])), anAct({}))).toEqual(unread(/did not give it/u));
    expect(await companyServiceHere(reach(async () => ({ versions: [] }), anchoredAs([], [1])), anAct({}))).toEqual(unread(/did not give it/u));
  });

  it('the versions named are those anchored and those entered since, of this record alone', async () => {
    const records = (await anchoredAs([1, 2], [3])()).records as never;
    /* RED WHEN: a version entered and not yet anchored can be withheld without the choice being left unread. */
    expect(versionsNamedIn(records)).toEqual([1, 2, 3]);
  });

  it('a read that fails, of the record or of the anchored records, leaves the choice unread, never ours', async () => {
    /* RED WHEN: a failed read of the record is read as our service. */
    expect(await companyServiceHere(reach(async () => { throw Object.assign(new Error('the service answered 500. Nothing was sent.'), { status: 500 }); }, anchoredAs([])), anAct({})))
      .toEqual({ unread: 'the service answered 500' });
    /* RED WHEN: a record read without the anchored records, which would show what was withheld, is read as our service. */
    expect(await companyServiceHere(reach(notFound), anAct({}))).toEqual({ unread: 'the directory could not be read' });
    expect(await companyServiceHere(reach(async () => ({ versions: [toCompanyWire(filed(1, ADA, OWN))] })), anAct({}))).toEqual({ unread: 'the directory could not be read' });
  });

  it('an act that may not ask the page for the record asks nothing, and is our service', async () => {
    const asked: string[] = [];
    const got = await companyServiceHere(reach(async (path) => { asked.push(path); return { versions: [] }; }), anAct({}, 'seat-invited'));
    /* RED WHEN: an act asks the page for a call its route list does not name, which stops the whole act. */
    expect(asked).toEqual([]);
    expect(got).toEqual({ choice: OUR_SERVICE, unchosen: expect.stringMatching(/does not read the company's choice/u) });
  });
});

const APPROVE = { kind: 'account-call', contract: ACCOUNT, circuit: 'approve' } as const;

/** What handing one call over does: whether our service relayed it, and what refused it. */
const handing = async (over: ReturnType<typeof handOverFor>, viaService: () => Promise<void> = async () => undefined) => {
  let relayed = false;
  const e = await handedOver(over, {
    tx: b64({ circuit: 'approve', to: ACCOUNT }), call: APPROVE,
    viaService: async () => { relayed = true; await viaService(); }, after: async () => undefined,
  }).then(() => null, (x: unknown) => x as Error & { nothingWasSent?: unknown });
  return { relayed, refused: e === null ? null : e.message, nothingWasSent: e?.nothingWasSent };
};

describe('WHERE EACH CALL GOES UNDER EACH CHOICE', () => {
  it('the way is the company\'s setting, never what the act names, and is never asked', () => {
    for (const fields of [{}, { path: 'service' }, { path: 'chain' }] as Record<string, string>[]) {
      /* RED WHEN: a page naming a way in the act sends a company's calls anywhere but where the company chose. */
      expect(handOverFor(anAct(fields), aChain([]), { choice: OUR_SERVICE }).path).toBe('service');
      expect(handOverFor(anAct(fields), aChain([]), { choice: OWN }).path).toBe('company-service');
      expect(handOverFor(anAct(fields), aChain([]), { choice: NONE }).path).toBe('chain');
      expect(handOverFor(anAct(fields), aChain([]), { unread: 'the directory could not be read' }).path).toBe('chain');
    }
  });

  it('unread: the call goes straight to the chain, its fee sponsored, and the window says the choice could not be read, in one line', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    const service = { unread: 'the company\'s records name version 2 of it and the service did not give it' };
    /* RED WHEN: a choice that could not be read stops the call, or sends it through our service. */
    const got = await handing(handOverFor(anAct({}, 'approve-proposal', shown), aChain(log), service, Date.now, sponsorship(log)));
    expect(got).toEqual({ relayed: false, refused: null, nothingWasSent: undefined });
    expect(log).toEqual(['sponsored', 'sent to the chain']);
    /* RED WHEN: the window says our service was tried when it was the choice that could not be read, or says more than one line. */
    expect(shown).toEqual([{ key: 'act.fell-back.unread' }]);
  });

  it('none: the call goes straight to the chain, its fee sponsored, and nothing is said: it is the company\'s choice', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    /* RED WHEN: a company that chose no service has a call relayed by one, or refused. */
    const got = await handing(handOverFor(anAct({}, 'approve-proposal', shown), aChain(log), { choice: NONE }, Date.now, sponsorship(log)));
    expect(got).toEqual({ relayed: false, refused: null, nothingWasSent: undefined });
    expect(log).toEqual(['sponsored', 'sent to the chain']);
    expect(shown).toEqual([]);
  });

  it('ours: the call goes through ours, which pays and submits, and nothing else is asked', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    /* RED WHEN: a company that chose ours has its calls sent anywhere else, or sponsored a second time. */
    expect(await handing(handOverFor(anAct({}, 'approve-proposal', shown), aChain(log), { choice: OUR_SERVICE }, Date.now, sponsorship(log))))
      .toEqual({ relayed: true, refused: null, nothingWasSent: undefined });
    expect(log).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('ours, unable to take the call: it goes straight to the chain instead, and the window says so in one line', async () => {
    for (const cannot of [
      Object.assign(new Error('this deployment does not send transactions'), { status: 503, nothingWasSent: true }),
      Object.assign(new Error('the fee payer did not pay this fee'), { status: 422, code: 'fee-not-paid', nothingWasSent: true }),
    ]) {
      const log: unknown[] = [];
      const shown: unknown[] = [];
      const over = handOverFor(anAct({}, 'approve-proposal', shown), aChain(log), { choice: OUR_SERVICE }, Date.now, sponsorship(log));
      const got = await handing(over, async () => { throw cannot; });
      /* RED WHEN: our service being unable to take a call stops it, when the chain can take it. */
      expect(got, cannot.message).toEqual({ relayed: true, refused: null, nothingWasSent: undefined });
      expect(log, cannot.message).toEqual(['sponsored', 'sent to the chain']);
      expect(shown, cannot.message).toEqual([{ key: 'act.fell-back.chain' }]);
      /* RED WHEN: our service is told it kept the call's record when the call went another way. */
      expect(notThroughOurService(over)).toBe(true);
    }
  });

  it('each falls back on its own: our service and the sponsorship both unable, the person\'s wallet sends and pays, said in one line', async () => {
    const log: unknown[] = [];
    const shown: unknown[] = [];
    const paying = {
      ...aChain(log),
      ownWallet: () => ({
        ...aChain(log).ownWallet(),
        facade: async () => ({
          ...(await aChain(log).ownWallet().facade() as object),
          balanceUnboundTransaction: async (call: unknown) => {
            log.push('own DUST');
            return { baseTransaction: call, balancingTransaction: { guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[2, { ...intentOf([]), dustActions: { spends: [1], registrations: [] } }]]) } };
          },
          signRecipe: async (r: unknown) => r, finalizeRecipe: async (r: unknown) => r,
        }) as never,
      }),
    };
    const down = async () => { log.push('sponsorship down'); throw Object.assign(new Error('the fee payer did not pay this fee'), { status: 422, code: 'fee-not-paid', nothingWasSent: true }); };
    const over = handOverFor(anAct({}, 'approve-proposal', shown), paying, { choice: OUR_SERVICE }, Date.now, down);
    const got = await handing(over, async () => { throw Object.assign(new Error('this deployment does not send transactions'), { status: 503, nothingWasSent: true }); });
    /* RED WHEN: two services down stop a call the person's wallet can send and pay for, or the window says it in more than one line. */
    expect(got).toEqual({ relayed: true, refused: null, nothingWasSent: undefined });
    expect(log).toEqual(['sponsorship down', 'own DUST', 'sent to the chain']);
    expect(shown.at(-1)).toEqual({ key: 'act.fell-back.chain-own-dust' });
  });

  it('ours, refusing the call or perhaps having sent it: nothing is sent another way', async () => {
    for (const answer of [
      Object.assign(new Error('this proposal was already approved. Nothing was sent.'), { status: 409, nothingWasSent: true }),
      Object.assign(new Error('the network refused this transaction'), { status: 422, code: 'network-refused', nothingWasSent: true }),
      Object.assign(new Error('the node did not answer'), { status: 502, nothingWasSent: false }),
      Object.assign(new Error('the service answered 503'), { status: 503 }),
    ]) {
      const log: unknown[] = [];
      const shown: unknown[] = [];
      const got = await handing(handOverFor(anAct({}, 'approve-proposal', shown), aChain(log), { choice: OUR_SERVICE }, Date.now, sponsorship(log)), async () => { throw answer; });
      /* RED WHEN: a call our service refused, or may have sent, is sent again straight to the chain. */
      expect(got.refused, answer.message).toBe(answer.message);
      expect(log, answer.message).toEqual([]);
      expect(shown, answer.message).toEqual([]);
    }
  });

  it('its own: the call with only its fee added goes to the address the company chose, and nothing else is handed to it', async () => {
    const log: Array<{ url: string; init: RequestInit } | string> = [];
    const over = handOverFor(anAct({}), aChain(log), { choice: OWN }, Date.now, sponsorship(log));
    /* RED WHEN: the window cannot say where the call goes. */
    expect(over).toMatchObject({ path: 'company-service', at: 'https://relay.example.com' });
    let viaOurs = false;
    let kept = false;
    await handedOver(over, {
      tx: b64({ circuit: 'approve', to: ACCOUNT }), call: APPROVE,
      viaService: async () => { viaOurs = true; }, before: async () => { kept = true; }, after: async () => undefined,
    });
    /* RED WHEN: a call for the company's own service is relayed by ours, or our record of it is not kept first. */
    expect(viaOurs).toBe(false);
    expect(kept).toBe(true);
    /* RED WHEN: the company's own service is handed anything but the call with its fee paid, or anything that signs the person in. */
    expect(log[0]).toBe('sponsored');
    const handedTo = log.slice(1) as Array<{ url: string; init: RequestInit }>;
    expect(handedTo).toHaveLength(1);
    expect(handedTo[0]!.url).toBe('https://relay.example.com/relay');
    expect(JSON.parse(String(handedTo[0]!.init.body))).toEqual({ transaction: b64({ circuit: 'approve', to: ACCOUNT, fee: true }) });
    expect(handedTo[0]!.init.credentials).toBe('omit');
    expect(handedTo[0]!.init.referrerPolicy).toBe('no-referrer');
    /* RED WHEN: a redirect from that address re-sends the call to wherever it names. */
    expect(handedTo[0]!.init.redirect).toBe('error');
  });

  it('its own: a call handed over whose record then cannot be read is said as sent, never as not sent', async () => {
    const over = handOverFor(anAct({}), aChain([]), { choice: OWN }, Date.now, sponsorship([]));
    const e = await handedOver(over, {
      tx: b64({ circuit: 'approve', to: ACCOUNT }), call: APPROVE,
      viaService: async () => undefined, after: async () => { throw new Error('the service answered 503. Nothing was sent.'); },
    }).then(() => null, (x: unknown) => x as Error & { nothingWasSent?: unknown });
    /* RED WHEN: a call the company's own service was handed is said as not sent, so it is sent again. */
    expect(e?.nothingWasSent).toBe(false);
    expect(e?.message).toMatch(/^the call was handed to the company's own service, and the service that keeps the company's records could not say where it stands \(the service answered 503\)\. Do not send it again/u);
  });

  it('its own: a call that is not the step\'s is refused before anything is paid or reaches that address', async () => {
    const log: unknown[] = [];
    const over = handOverFor(anAct({}), aChain(log), { choice: OWN }, Date.now, sponsorship(log));
    const handed = { over: false };
    const e = await handOverMarked(over, handed).toChain!(b64({ circuit: 'cancel', to: ACCOUNT }), APPROVE)
      .then(() => null, (x: unknown) => x as { nothingWasSent?: unknown });
    /* RED WHEN: another call than the step's rides along to the company's own service, or is paid for. */
    expect(e?.nothingWasSent).toBe(true);
    expect(log).toEqual([]);
    expect(handed.over).toBe(false);
  });

  it('its own: an address that is not a secure site address is refused before anything is paid, and nothing is sent', async () => {
    const log: unknown[] = [];
    const got = await handing(handOverFor(anAct({}), aChain(log), { choice: { service: 'own', at: 'http://relay.example.com' } }, Date.now, sponsorship(log)));
    /* RED WHEN: a call is handed to a plain http address, or its fee is paid first. */
    expect(got.refused).toMatch(/not a secure \(https\) address\. Nothing was sent/u);
    expect(got.nothingWasSent).toBe(true);
    expect(log).toEqual([]);
  });
});

describe('AN ACT THAT STOPS AFTER THE WALLET SENT A CALL ITSELF SAYS IT MAY BE ON THE CHAIN', () => {
  const NONCE = 'n-straight';
  const request: ActRequest = {
    schema: 'midnight-identity/disclosure-request/v1', kind: 'act',
    requester: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
    purpose: 'A test.', nonce: NONCE, expiresAt: Date.now() + 20 * 60_000, hearsProgress: true,
    intent: { name: 'approve-proposal' as never, fields: {} },
  } as ActRequest;
  const held = { identity: {}, secret: new Uint8Array(32), account: 0 } as unknown as Held;
  /* The page: it is handed nothing to send in these acts, since every call goes straight to the chain from the wallet. */
  const aPage = () => {
    const ended: ActEnded[] = [];
    const relayed: string[] = [];
    const channel = {
      step: () => true,
      relay: async (_at: unknown, tx: string) => { relayed.push(tx); return 'relayed'; },
      call: async () => 'refused', keep: async () => 'refused',
      answer: (a: unknown) => { ended.push(a as ActEnded); return true; },
    } as unknown as ActingChannel;
    return { channel, ended, relayed };
  };
  const act = (steps: readonly ActionStep[]): ActionDefinition => ({ headline: 'ask.act.headline', shown: async () => [], checks: [], check: async () => null, steps: () => steps });
  /* A step that sends one call under a company that chose no service; its record is then filed or fails to be. */
  const sendsStraight = (log: unknown[], filed: () => Promise<void>): ActionStep => ({
    title: { key: 'x' },
    run: async (c: StepContext) => {
      const over = handOverFor(c, aChain(log), { choice: NONE }, Date.now, sponsorship(log));
      try {
        await handedOver(over, { tx: b64({ circuit: 'approve', to: ACCOUNT }), call: APPROVE, viaService: async () => undefined, after: filed });
      } catch {
        throw new StepRefused({ key: 'act.approve-proposal.why.may-be-sent' }, 'sent-straight-not-recorded');
      }
    },
  });

  it('a call sent straight to the chain and then not recorded ends with it counted as perhaps sent, which the page reads', async () => {
    const log: unknown[] = [];
    const { channel, ended, relayed } = aPage();
    await runAction({
      definition: act([sendsStraight(log, async () => { throw new Error('the record could not be filed'); })]),
      request, channel, held, stop: new AbortController().signal,
    });
    expect(log).toEqual(['sponsored', 'sent to the chain']);
    expect(relayed).toEqual([]);
    /* RED WHEN: a call the wallet sent itself is counted nowhere, so the end says nothing left the wallet and the person raises it again. */
    expect(ended).toEqual([expect.objectContaining({ ended: 'stopped', why: 'check-failed', relayed: 0, unconfirmed: 1, refused: 'act.approve-proposal.why.may-be-sent' })]);
    expect(readActEnded(ended[0], { nonce: NONCE, intent: 'approve-proposal' })).toMatchObject({ unconfirmed: 1 });
  });

  it('a call sent straight to the chain and recorded ends the act done, with nothing left unconfirmed, which the page reads', async () => {
    const log: unknown[] = [];
    const { channel, ended } = aPage();
    await runAction({ definition: act([sendsStraight(log, async () => undefined)]), request, channel, held, stop: new AbortController().signal });
    /* RED WHEN: an act that ran to its end after a call the wallet sent itself ends with it unconfirmed, which the page refuses to read. */
    expect(ended).toEqual([expect.objectContaining({ ended: 'done', relayed: 0, unconfirmed: 0 })]);
    expect(readActEnded(ended[0], { nonce: NONCE, intent: 'approve-proposal' })).not.toBeNull();
  });

  it('after a call the wallet sent itself, the window asks for no Confirm, and the act stops there', async () => {
    const log: unknown[] = [];
    const asked: unknown[] = [];
    const { channel, ended } = aPage();
    const confirmsAfter: ActionStep = {
      title: { key: 'y' },
      run: async (c: StepContext) => { await c.confirm([{ key: 'ask.act.headline' }]); log.push('confirmed'); },
    };
    await runAction({
      definition: act([sendsStraight(log, async () => undefined), confirmsAfter]), request, channel, held, stop: new AbortController().signal,
      confirm: async (lines) => { asked.push(lines); return true; },
    });
    /* RED WHEN: the person is asked to confirm what to send after this wallet already sent a call, so what they approve is not what went. */
    expect(asked).toEqual([]);
    expect(log).toEqual(['sponsored', 'sent to the chain']);
    expect(ended).toEqual([expect.objectContaining({ ended: 'stopped', why: 'step-failed', step: 2, unconfirmed: 1 })]);
  });
});

describe('A CALL OUR SERVICE DID NOT ANSWER IN TIME, WHICH THE CHAIN THEN SHOWS, IS NO LONGER UNCONFIRMED', () => {
  const NONCE = 'n-late';
  const request = {
    schema: 'midnight-identity/disclosure-request/v1', kind: 'act',
    requester: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
    purpose: 'A test.', nonce: NONCE, expiresAt: Date.now() + 20 * 60_000, hearsProgress: true,
    intent: { name: 'approve-proposal' as never, fields: {} },
  } as ActRequest;
  const held = { identity: {}, secret: new Uint8Array(32), account: 0 } as unknown as Held;
  /* The page: it passes the call on and never answers, so the wallet's patience runs out. */
  const aSilentPage = () => {
    const ended: ActEnded[] = [];
    const channel = {
      step: () => true, relay: async () => 'relayed', keep: async () => 'refused',
      call: () => new Promise(() => {}),
      answer: (a: unknown) => { ended.push(a as ActEnded); return true; },
    } as unknown as ActingChannel;
    return { channel, ended };
  };
  /* The person's wallet, which finds the call on the chain when it reads for it. */
  const onTheChain = (log: unknown[], there: boolean) => ({ ...aChain(log), ownWallet: () => ({ ...aChain(log).ownWallet(), landed: async () => there }) });
  const carriedWhen = (there: boolean): ActionStep => ({
    title: { key: 'x' },
    run: async (c: StepContext) => {
      const log: unknown[] = [];
      const over = handOverFor(c, onTheChain(log, there), { choice: OUR_SERVICE }, Date.now, sponsorship(log));
      await handedOver(over, {
        tx: b64({ circuit: 'approve', to: ACCOUNT }), call: APPROVE, after: async () => undefined,
        viaService: async () => { await apiOver(c)('/api/proposals/prp_late/carry', { method: 'POST', body: '{}' }); },
      });
    },
  });
  const carried = carriedWhen(true);
  const refusesAfter: ActionStep = { title: { key: 'y' }, run: async () => { throw new StepRefused({ key: 'act.approve-proposal.why.may-be-sent' }, 'later'); } };
  const act = (steps: readonly ActionStep[]): ActionDefinition => ({ headline: 'ask.act.headline', shown: async () => [], checks: [], check: async () => null, steps: () => steps });
  const ran = async (steps: readonly ActionStep[]) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { channel, ended } = aSilentPage();
      const done = runAction({ definition: act(steps), request, channel, held, stop: new AbortController().signal });
      await vi.advanceTimersByTimeAsync(RELAY_PATIENCE_MS + 1);
      await done;
      return ended;
    } finally {
      vi.useRealTimers();
    }
  };

  it('an act that went around a call our service did not answer, and found it on the chain, ends done with nothing unconfirmed, which the page reads', async () => {
    const ended = await ran([carried]);
    /* RED WHEN: a finished act ends with a call counted unconfirmed, which the page will not read, so it says the wallet went quiet. */
    expect(ended).toEqual([expect.objectContaining({ ended: 'done', unconfirmed: 0 })]);
    expect(readActEnded(ended[0], { nonce: NONCE, intent: 'approve-proposal' })).not.toBeNull();
  });

  it('an act that went around a call our service did not answer, not yet on the chain, by sending it itself, ends done with nothing unconfirmed', async () => {
    const ended = await ran([carriedWhen(false)]);
    /* RED WHEN: a finished act ends with the call it sent itself still counted unconfirmed, which the page will not read. */
    expect(ended).toEqual([expect.objectContaining({ ended: 'done', unconfirmed: 0 })]);
    expect(readActEnded(ended[0], { nonce: NONCE, intent: 'approve-proposal' })).not.toBeNull();
  });

  it('an act that stops after that call was found on the chain does not count it as still unconfirmed', async () => {
    const ended = await ran([carried, refusesAfter]);
    /* RED WHEN: a call the chain shows is still said as one that may still be sent, though the chain read is the evidence it went. */
    expect(ended).toEqual([expect.objectContaining({ ended: 'stopped', why: 'check-failed', step: 2, unconfirmed: 0 })]);
  });
});

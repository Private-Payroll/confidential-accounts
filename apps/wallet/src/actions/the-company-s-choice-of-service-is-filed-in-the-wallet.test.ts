import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { newSigningKeypair, unwrapKey, type Hex } from '../../../../src/core/crypto.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import {
  COMPANY_WRAP_ID, OUR_SERVICE, openCompanyService, openedWithTheCompanyKey, sealCompanyService, type CompanyService,
} from '../../../../src/midnight/company-service-record.js';
import { CompanyKeyBeingChanged } from '../../../../packages/web-shared/src/company-key-here.js';
import { companyRecordEntry } from '../../../../src/midnight/record-manifest.js';
import {
  fromCompanyWire, signCompanyFiling, toCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord,
} from '../../../../src/midnight/sealed-record-wire.js';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **THE COMPANY'S CHOICE OF SERVICE IS FILED FROM THE WALLET, ONE WINDOW, ONE PASSKEY, AND READ BACK AS EVERY ACT READS
 * IT.** The filing step and the read are the real ones (`chooseCompanyServiceAction`, `companyServiceHere`), over a
 * service that keeps what is filed and entered, and a directory stood in for here; the filings it holds are believed when
 * a seat it names signed them and an entry names their bytes, since judging a filing against the company's anchored
 * records is pinned where the judge is. The upkeep's own steps are pinned with the upkeep, and are not run here.
 */

/*
 * The stand-in judge believes a version signed by a seat of the directory whose entry in the company's records names
 * its bytes. Its refusals are given by their code, as the real judge's words are read by `filingRefusalCodeOf`.
 */
vi.mock('../../../../packages/web-shared/src/vault-page-doors.js', async (real) => {
  const actual = await real<typeof import('../../../../packages/web-shared/src/vault-page-doors.js')>();
  type Here = { dir: { seats: { signingKey: string }[] }; records: { notYetAnchored: { version: number; digest?: string }[] } };
  return {
    ...actual,
    judgeIn: (here: Here) => Object.assign(
      (filer: string | null, _kind: string, _key: string, read: { version: number; digest: string }) => {
        if (filer === null || !here.dir.seats.some((x) => x.signingKey === filer.toLowerCase())) return 'no seat of the directory filed it';
        const entry = here.records.notYetAnchored.find((e) => e.version === read.version);
        if (entry === undefined) return 'code:not-entered';
        return entry.digest === read.digest ? null : 'code:not-the-anchored-bytes';
      },
      { withheld: () => null },
    ),
    filingRefusalCodeOf: (why: string) => (why.startsWith('code:') ? why.slice(5) : actual.filingRefusalCodeOf(why)),
  };
});

const { chooseCompanyServiceAction, CHOOSE_SERVICE_STATE } = await import('./choose-company-service.js');
const { companyServiceHere } = await import('./company-reach.js');

const COMPANY = 'acc_choice';
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const OWN: CompanyService = { service: 'own', at: 'https://relay.example.com' };
const NONE: CompanyService = { service: 'none' };
/** The company's key at epoch 0, which every seat holds; `heldAt` stands in for a device holding no key at the epoch named. */
const COMPANY_KEY = '0c'.repeat(32) as Hex;
const keyAt = (epoch: number): Hex => {
  if (epoch !== 0) throw new Error(`this device holds no key of the company at epoch ${epoch}, so nothing sealed under it opens here.`);
  return COMPANY_KEY;
};
const noKey = (epoch: number): Hex => { throw new Error(`this device holds no key of the company at epoch ${epoch}, so nothing sealed under it opens here.`); };

/** One seat: its leaf, signing keys, and the company key its own wallet derives, whose records key it is wrapped to. */
const seatOf = (n: number, role: string | null = null, heldAt: (epoch: number) => Hex = keyAt) => {
  const signing = newSigningKeypair();
  const companyKey = String(n).padStart(2, '0').repeat(32);
  const records = recordsKeypairFrom(new Uint8Array(Buffer.from(companyKey, 'hex')));
  return {
    leaf: `a${n}`.repeat(32), signing, companyKey, role,
    entry: { seat: `a${n}`.repeat(32), person: `usr_${n}`, signingKey: signing.publicKey.toLowerCase(), wrappingKey: records.publicKey as string, role, retired: null as null | Record<string, number> },
    opener: {
      signerId: `a${n}`.repeat(32), keyOf: (w: Parameters<typeof unwrapKey>[0]) => unwrapKey(w, records.secret) as Hex,
      companyCopy: openedWithTheCompanyKey(COMPANY, heldAt),
    },
  };
};
type Seat = ReturnType<typeof seatOf>;

/** The company's service: every version filed, as the wire carries it, and the versions entered in its records. */
const aService = () => ({
  filed: [] as SealedCompanyRecord[], entered: [] as number[], digests: new Map<number, string>(), puts: 0,
  /* How many entries the service fails to keep, from the next; and the versions it serves as other bytes. */
  failEntries: 0, altered: new Map<number, SealedCompanyRecord>(),
});
type Service = ReturnType<typeof aService>;

/** The company as this device reads it: the seats in its directory, those the chain holds, and the bar a policy change needs. */
interface Company {
  readonly directory: Seat['entry'][]; readonly onChain: string[]; readonly bar: number;
  /** Why this device seals nothing new now, as the company's keys say while a removal waits for the key to change. */
  readonly notSealing?: string;
}

const reachOf = (me: Seat, s: Service, co: Company) => {
  const here = {
    dir: { seats: co.directory },
    holders: { seats: co.onChain, approvals: co.bar, policyBar: null },
    another: new Set<string>(),
    records: { history: new Map(), notYetAnchored: [] as unknown[] },
  };
  const entries = () => s.entered.map((version) => ({ store: 'company', kind: 'policy', id: 'company-service', version, digest: s.digests.get(version) }));
  return {
    accountId: COMPANY, label: LABEL, account: ACCOUNT, leaf: me.leaf, companyKey: me.companyKey, opener: me.opener,
    seat: { signerId: me.leaf, signingSecret: me.signing.secret, wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: 'cc'.repeat(32) },
    companyKeys: {
      epoch: 0, keyAt,
      sealing: () => {
        if (co.notSealing !== undefined) throw new CompanyKeyBeingChanged(co.notSealing);
        return { key: COMPANY_KEY, epoch: 0 };
      },
    },
    roster: async () => ({}), stepTo: () => {},
    api: async (path: string, init?: RequestInit) => {
      if (path === `/api/accounts/${COMPANY}/records/policy/company-service/versions`) {
        return { versions: s.filed.map((r) => toCompanyWire(s.altered.get(r.version) ?? r)) };
      }
      if (path === `/api/accounts/${COMPANY}/manifest/entries` && init?.method === 'POST') {
        if (s.failEntries > 0) { s.failEntries -= 1; throw Object.assign(new Error('the service answered 503'), { status: 503 }); }
        for (const e of (JSON.parse(String(init.body)) as { entries: { version: number; digest: string }[] }).entries) {
          s.entered.push(e.version);
          s.digests.set(e.version, e.digest);
        }
        return {};
      }
      throw Object.assign(new Error(`not served here: ${path}`), { status: 500 });
    },
    send: async (path: string, init: { method: string; body?: string }) => {
      const at = path.match(/^\/api\/accounts\/acc_choice\/records\/policy\/company-service\/(\d+)$/u);
      if (at === null || init.method !== 'PUT') return { status: 404, body: {} };
      s.puts += 1;
      const wire = JSON.parse(String(init.body));
      const rec = fromCompanyWire(wire, { company: COMPANY, kind: 'policy', id: 'company-service' }).sealed;
      if (rec.version !== s.filed.length + 1) return { status: 409, body: { refused: 'version-already-filed' } };
      s.filed.push(rec);
      return { status: 201, body: { filed: true, version: rec.version, digest: wire.digest } };
    },
    judges: {
      directoryHereFor: () => async () => ({ ...here, records: { ...here.records, notYetAnchored: entries() } }),
      filingJudgeFor: () => async () => () => null,
    },
  };
};

const intent = (fields: Record<string, string>): ActIntent =>
  ({ name: 'choose-company-service', fields: { record: COMPANY, company: LABEL, account: ACCOUNT, ...fields } }) as ActIntent;
const fieldsOf = (c: CompanyService): Record<string, string> => (c.service === 'own' ? { service: 'own', at: c.at } : { service: c.service });

const ctxOf = (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity: {}, account: 0 }, at: { step: 1, steps: 4 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a choice of service relays nothing'); },
    call: async () => ({ status: 404, body: {} }),
    tell: (x: Record<string, unknown>) => { told.push(x); },
    keyring: null,
  } as unknown as StepContext;
  return { ctx, told };
};
const actionFor = (me: Seat, s: Service, co: Company) => chooseCompanyServiceAction({
  chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {},
  reachFor: async () => reachOf(me, s, co) as never,
});

/** The act run as `me`, all but the upkeep's steps: what it told the page. */
const filedBy = async (me: Seat, s: Service, co: Company, c: CompanyService) => {
  const i = intent(fieldsOf(c));
  const def = actionFor(me, s, co);
  expect(await def.check(i, {} as never)).toBeNull();
  const { ctx, told } = ctxOf(i);
  for (const step of def.steps(i)) if (!step.title.key.startsWith('act.upkeep.')) await step.run(ctx);
  return told[told.length - 1];
};
const refusedWhenFiledBy = async (me: Seat, s: Service, co: Company, c: CompanyService) => {
  const i = intent(fieldsOf(c));
  const { ctx } = ctxOf(i);
  try {
    for (const step of actionFor(me, s, co).steps(i)) if (!step.title.key.startsWith('act.upkeep.')) await step.run(ctx);
  } catch (e) {
    if (e instanceof StepRefused) return e.words;
    throw e;
  }
  throw new Error('the act filed');
};
/** The choice as `me` reads it, through the read every act makes. */
const readBy = (me: Seat, s: Service, co: Company) => companyServiceHere(reachOf(me, s, co) as never, { intent: intent({ service: 'ours' }) });

const twoSeats = () => {
  const ada = seatOf(1);
  const bea = seatOf(2);
  return { ada, bea, co: { directory: [ada.entry, bea.entry], onChain: [ada.leaf, bea.leaf], bar: 2 } as Company };
};

describe('EACH CHOICE IS FILED IN THE WALLET AND READ BACK IN FORCE AT THE BAR', () => {
  it('lists every route it asks for, and the read of the choice is one of them', () => {
    const shape = intentShapeOf('choose-company-service')!;
    /* RED WHEN: the act's own list leaves out the read of the record or the filing, so it would be stopped while running. */
    expect(routeOf(shape, 'GET', `/api/accounts/${COMPANY}/records/policy/company-service/versions`)).not.toBeNull();
    expect(routeOf(shape, 'PUT', `/api/accounts/${COMPANY}/records/policy/company-service/3`)).not.toBeNull();
    expect(routeOf(shape, 'POST', `/api/accounts/${COMPANY}/manifest/entries`)).not.toBeNull();
  });

  for (const choice of [OUR_SERVICE, OWN, NONE]) {
    it(`${choice.service}: one signer's filing waits for the bar; a second signer's, unchanged, brings it into force`, async () => {
      const { ada, bea, co } = twoSeats();
      const s = aService();
      /* RED WHEN: one seat's filing is told to the page as in force, or not counted as that seat's. */
      expect(await filedBy(ada, s, co, choice)).toEqual({ state: CHOOSE_SERVICE_STATE.waiting, filed: 1, needed: 2 });
      /* RED WHEN: a choice below the bar is read as in force by any seat. */
      expect(await readBy(bea, s, co)).toEqual({ choice: OUR_SERVICE, unchosen: expect.stringMatching(/filed by the 2 seats a change of policy needs/u) });
      /* RED WHEN: the second seat's filing of the same choice does not bring it into force. */
      expect(await filedBy(bea, s, co, choice)).toEqual({ state: CHOOSE_SERVICE_STATE.inForce, filed: 2, needed: 2 });
      for (const reader of [ada, bea]) expect(await readBy(reader, s, co)).toEqual({ choice });
      /* RED WHEN: a version is filed unsigned, signed by another seat, not entered, or numbered out of turn. */
      expect(s.filed.map((r) => [r.version, verifiedCompanyFiler(r)])).toEqual([[1, ada.signing.publicKey], [2, bea.signing.publicKey]]);
      expect(s.entered).toEqual([1, 2]);
    });
  }

  it('a different choice starts the count again and leaves the choice in force where it was', async () => {
    const { ada, bea, co } = twoSeats();
    const s = aService();
    await filedBy(ada, s, co, OWN);
    await filedBy(bea, s, co, OWN);
    /* RED WHEN: a different choice filed by one seat is counted with the seats that filed the one before. */
    expect(await filedBy(ada, s, co, NONE)).toEqual({ state: CHOOSE_SERVICE_STATE.waiting, filed: 1, needed: 2 });
    /* RED WHEN: one seat's new ask moves the company's calls off the choice in force. */
    expect(await readBy(bea, s, co)).toEqual({ choice: OWN });
    expect(await filedBy(bea, s, co, NONE)).toEqual({ state: CHOOSE_SERVICE_STATE.inForce, filed: 2, needed: 2 });
    expect(await readBy(ada, s, co)).toEqual({ choice: NONE });
  });

  it('the same seat filing the same choice twice counts once', async () => {
    const { ada, bea, co } = twoSeats();
    const s = aService();
    await filedBy(ada, s, co, OWN);
    /* RED WHEN: one seat filing twice reaches a bar of two by itself. */
    expect(await filedBy(ada, s, co, OWN)).toEqual({ state: CHOOSE_SERVICE_STATE.waiting, filed: 1, needed: 2 });
    expect(await readBy(bea, s, co)).toMatchObject({ choice: OUR_SERVICE });
  });
});

describe('A BAD ADDRESS IS REFUSED BEFORE ANYTHING IS FILED', () => {
  const bad = [
    ['http://relay.example.com', /not a secure \(https\) address/u],
    ['https://203.0.113.9', /named by a number or as this device/u],
    ['https://[2001:db8::1]', /named by a number or as this device/u],
    ['https://localhost', /named by a number or as this device/u],
    ['https://relay.localhost', /named by a number or as this device/u],
    ['https://localhost.', /named by a number or as this device/u],
    ['https://relay.localhost.', /named by a number or as this device/u],
    ['https://user:pass@relay.example.com', /carries a sign-in/u],
    ['https://relay.example.com/relay', /more than a site's address: name the site alone, as https:\/\/relay\.example\.com/u],
    ['https://relay.example.com/?to=elsewhere', /more than a site's address/u],
    ['relay.example.com', /is not a web address/u],
    ['', /no address was named/u],
  ] as const;

  it('each address a reader refuses is refused by the check, with words that say how to name it', async () => {
    const { ada, co } = twoSeats();
    for (const [at, says] of bad) {
      const s = aService();
      /* RED WHEN: an address every reader refuses gets past the check, or its refusal does not say how to name the service. */
      const got = await actionFor(ada, s, co).check(intent({ service: 'own', at }), {} as never);
      expect(got, at).toMatchObject({ key: 'act.choose-company-service.why.not-an-address', values: { says: expect.stringMatching(says) } });
      expect(WORDS[got!.key]).toMatch(/Name the company's own service by its secure site address alone/u);
      /* RED WHEN: the filing step files an address the check would refuse, should it be reached another way. */
      expect(await refusedWhenFiledBy(ada, s, co, { service: 'own', at } as CompanyService)).toMatchObject({ key: 'act.choose-company-service.why.not-an-address' });
      expect(s.puts).toBe(0);
    }
  });

  it('a choice the company cannot make, or an address with any other choice, is refused', async () => {
    const { ada, co } = twoSeats();
    const def = actionFor(ada, aService(), co);
    /* RED WHEN: a choice outside the three, or an address given to ours or none, is filed or shown as the choice. */
    expect(await def.check(intent({ service: 'elsewhere' }), {} as never)).toEqual({ key: 'act.choose-company-service.why.not-a-choice' });
    expect(await def.check(intent({ service: 'ours', at: 'https://relay.example.com' }), {} as never)).toEqual({ key: 'act.choose-company-service.why.address-without-own' });
    expect(await def.shown(intent({ service: 'elsewhere' }))).toContainEqual({ key: 'act.choose-company-service.shown.not-a-choice', values: { service: 'elsewhere' }, from: 'page' });
  });

  it('the window shows the choice in plain words before the passkey', async () => {
    const { ada, co } = twoSeats();
    const def = actionFor(ada, aService(), co);
    /* RED WHEN: the window does not show which service, and for the company's own, at which address. */
    expect((await def.shown(intent(fieldsOf(OWN))))[0]).toEqual({ key: 'act.choose-company-service.shown.own', values: { at: 'https://relay.example.com' }, from: 'page' });
    expect((await def.shown(intent({ service: 'none' })))[0]).toEqual({ key: 'act.choose-company-service.shown.none', from: 'page' });
    expect((await def.shown(intent({ service: 'ours' })))[0]).toEqual({ key: 'act.choose-company-service.shown.ours', from: 'page' });
    for (const line of await def.shown(intent(fieldsOf(OWN)))) expect(WORDS[line.key], line.key).toBeTypeOf('string');
  });
});

describe('THE CHOICE IS SEALED TO THE SIGNERS SEATED NOW, AND ONLY THEY CAN READ IT', () => {
  it('a retired seat and a seat the chain no longer holds are not sealed to, and cannot read it', async () => {
    const { ada, bea } = twoSeats();
    const gone = seatOf(3);
    const off = seatOf(4);
    const co: Company = {
      directory: [ada.entry, bea.entry, { ...gone.entry, retired: { 'company:policy:company-service': 0 } }, off.entry],
      onChain: [ada.leaf, bea.leaf, gone.leaf], bar: 2,
    };
    const s = aService();
    await filedBy(ada, s, co, OWN);
    /* RED WHEN: a version is sealed to a seat that is no longer seated, or leaves out one that is, or the company's key. */
    expect(s.filed[0]!.wrapped.map((w) => w.signerId).sort()).toEqual([ada.leaf, bea.leaf, COMPANY_WRAP_ID].sort());
    /* RED WHEN: a seat outside the wraps holding no key of the company at the sealing epoch can open the company's choice. */
    const keyless = { ...off, opener: { ...off.opener, companyCopy: openedWithTheCompanyKey(COMPANY, noKey) } };
    expect(await readBy(keyless, s, { ...co, onChain: [...co.onChain, off.leaf] })).toEqual({ unread: expect.stringMatching(/version 1 of the company's choice of service was not sealed to this seat/u) });
  });

  it('a seat its role keeps from filing policy, or this device does not believe seated, files nothing', async () => {
    const ada = seatOf(1, 'approver');
    const bea = seatOf(2);
    const s = aService();
    /* RED WHEN: a seat whose filing no reader believes files a version, leaving every seat's choice unread. */
    expect(await refusedWhenFiledBy(ada, s, { directory: [ada.entry, bea.entry], onChain: [ada.leaf, bea.leaf], bar: 2 }, OWN))
      .toEqual({ key: 'act.choose-company-service.why.role-may-not-file' });
    const cyd = seatOf(3);
    expect(await refusedWhenFiledBy(cyd, s, { directory: [bea.entry, cyd.entry], onChain: [bea.leaf], bar: 1 }, OWN))
      .toEqual({ key: 'act.choose-company-service.why.seat-not-believed' });
    expect(s.puts).toBe(0);
  });

  it('a record this seat cannot read whole is not filed over', async () => {
    const { ada, bea, co } = twoSeats();
    const s = aService();
    await filedBy(ada, s, co, OWN);
    s.entered.push(2);
    /* RED WHEN: a seat files over versions it cannot see, so its count is made against a record it never read. */
    expect(await refusedWhenFiledBy(bea, s, co, OWN)).toEqual({
      key: 'act.choose-company-service.why.unread', values: { says: expect.stringMatching(/name version 2 .* did not give it/u) },
    });
    expect(s.puts).toBe(1);
  });

  it('another seat filing the same version first refuses this one, unfiled, saying to try again', async () => {
    const { ada, bea, co } = twoSeats();
    const s = aService();
    const reach = reachOf(ada, s, co);
    const def = chooseCompanyServiceAction({
      chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {},
      reachFor: async () => ({
        ...reach,
        send: async (path: string, init: { method: string; body?: string }) => {
          await filedBy(bea, s, co, NONE);
          return reach.send(path, init);
        },
      }) as never,
    });
    const i = intent(fieldsOf(OWN));
    const { ctx } = ctxOf(i);
    let words: unknown = null;
    try {
      for (const step of def.steps(i)) if (!step.title.key.startsWith('act.upkeep.')) await step.run(ctx);
    } catch (e) { words = (e as StepRefused).words; }
    /* RED WHEN: two seats filing at once is not said as such, or this seat's version overwrites the other's. */
    expect(words).toEqual({ key: 'act.choose-company-service.why.filed-meanwhile' });
    expect(s.filed).toHaveLength(1);
  });
});

describe('A SIGNER SEATED AFTER THE CHOICE WAS FILED READS IT WITH THE COMPANY\'S KEY, WITH NOBODY FILING IT AGAIN', () => {
  it('reads the choice in force from the versions as they were filed', async () => {
    const { ada, bea, co } = twoSeats();
    const s = aService();
    await filedBy(ada, s, co, OWN);
    await filedBy(bea, s, co, OWN);
    const cyd = seatOf(3);
    const now: Company = { directory: [...co.directory, cyd.entry], onChain: [...co.onChain, cyd.leaf], bar: 2 };
    /* RED WHEN: a signer seated after the choice needs a seated signer to file it again before it reads the company's choice. */
    expect(await readBy(cyd, s, now)).toEqual({ choice: OWN });
    expect(s.filed).toHaveLength(2);
    /* RED WHEN: a signer seated later, filing the same choice, is not counted after the versions it could not have been sealed to. */
    expect(await filedBy(cyd, s, now, OWN)).toEqual({ state: CHOOSE_SERVICE_STATE.inForce, filed: 3, needed: 2 });
  });

  it('a seat whose device holds no key of the company at the sealing epoch reads it unread, never ours', async () => {
    const { ada, bea, co } = twoSeats();
    const s = aService();
    await filedBy(ada, s, co, OWN);
    await filedBy(bea, s, co, OWN);
    const cyd = seatOf(3, null, noKey);
    const now: Company = { directory: [...co.directory, cyd.entry], onChain: [...co.onChain, cyd.leaf], bar: 2 };
    /* RED WHEN: a version this seat cannot open is read as a company that never chose, or as ours. */
    expect(await readBy(cyd, s, now)).toEqual({ unread: expect.stringMatching(/not sealed to this seat, and the company's key at epoch 0 does not open it here/u) });
  });
});

describe('EACH FILING IS WRAPPED ONCE TO THE COMPANY\'S KEY AT THE EPOCH IT IS SEALED UNDER', () => {
  it('a filing carries the company\'s copy at the sealing epoch, which that key alone opens', async () => {
    const { ada, co } = twoSeats();
    const s = aService();
    await filedBy(ada, s, co, NONE);
    const rec = s.filed[0]!;
    /* RED WHEN: a filing is sealed at another epoch than the company's keys seal under now, or carries no company copy. */
    expect(rec.keyEpoch).toBe(0);
    expect(rec.wrapped.filter((w) => w.signerId === COMPANY_WRAP_ID)).toHaveLength(1);
    const outsider = { signerId: 'f0'.repeat(32), keyOf: () => { throw new Error('no copy of its own'); } };
    expect(openCompanyService(rec, { ...outsider, companyCopy: openedWithTheCompanyKey(COMPANY, keyAt) })).toEqual(NONE);
    /* RED WHEN: the company's copy opens with another key than the company's at the sealing epoch. */
    expect(() => openCompanyService(rec, { ...outsider, companyCopy: openedWithTheCompanyKey(COMPANY, () => '0d'.repeat(32) as Hex) })).toThrow(/does not open it here/u);
  });

  it('while the company\'s key is being changed nothing is filed, and the words say why and what resolves it', async () => {
    const { ada, co } = twoSeats();
    const s = aService();
    const paused: Company = { ...co, notSealing: 'a signer\'s removal is carried out and the company\'s key has not been changed since' };
    /* RED WHEN: a choice is filed under a key a removed signer still holds, or the refusal does not say what resolves it. */
    expect(await refusedWhenFiledBy(ada, s, paused, OWN)).toEqual({ key: 'act.choose-company-service.why.key-being-changed', values: { says: expect.stringMatching(/removal is carried out/u) } });
    expect(WORDS['act.choose-company-service.why.key-being-changed']).toMatch(/Nothing was filed/u);
    expect(s.puts).toBe(0);
    expect(s.entered).toEqual([]);
  });
});

describe('A FILING NO ENTRY NAMES, OR ONE FILED PAST, IS RESOLVED BY FILING; A VERSION SERVED AS OTHER BYTES IS NEVER DROPPED', () => {
  it('a filing whose entry was not kept stops every seat, until its filer chooses the same again, which enters it', async () => {
    const { ada, bea, co } = twoSeats();
    const s = aService();
    s.failEntries = 1;
    /* RED WHEN: a filing whose entry was not kept is told as filed, or its words do not say that choosing again resolves it. */
    expect(await refusedWhenFiledBy(ada, s, co, OWN)).toEqual({ key: 'act.choose-company-service.why.not-entered', values: { says: expect.stringMatching(/503/u) } });
    expect(WORDS['act.choose-company-service.why.not-entered']).toMatch(/Choose the same again: this wallet enters the version you filed/u);
    expect(await readBy(bea, s, co)).toEqual({ unread: expect.stringMatching(/not-entered/u) });
    /* RED WHEN: choosing the same again is refused, so the version every seat stops at can never be resolved. */
    expect(await filedBy(ada, s, co, OWN)).toEqual({ state: CHOOSE_SERVICE_STATE.waiting, filed: 1, needed: 2 });
    /* RED WHEN: choosing again files another version instead of entering the one every seat stops at. */
    expect(s.filed).toHaveLength(1);
    expect(s.entered).toEqual([1]);
    expect(await filedBy(bea, s, co, OWN)).toEqual({ state: CHOOSE_SERVICE_STATE.inForce, filed: 2, needed: 2 });
    expect(await readBy(ada, s, co)).toEqual({ choice: OWN });
  });

  it('another seat files past a newest version no entry names, which is then never counted', async () => {
    const { ada, bea, co } = twoSeats();
    const s = aService();
    s.failEntries = 1;
    await refusedWhenFiledBy(ada, s, co, OWN);
    /* RED WHEN: a version no entry names, filed by any seat, stops every other seat from filing for good. */
    expect(await filedBy(bea, s, co, NONE)).toEqual({ state: CHOOSE_SERVICE_STATE.waiting, filed: 1, needed: 2 });
    expect(s.filed.map((r) => r.version)).toEqual([1, 2]);
    /* RED WHEN: the version no entry names is counted once a later one is filed. */
    expect(await filedBy(ada, s, co, NONE)).toEqual({ state: CHOOSE_SERVICE_STATE.inForce, filed: 2, needed: 2 });
    expect(await readBy(bea, s, co)).toEqual({ choice: NONE });
  });

  it('an earlier version the records name, served as other bytes, leaves the choice unread and is not filed over', async () => {
    const { ada, bea, co } = twoSeats();
    const s = aService();
    await filedBy(ada, s, co, OWN);
    await filedBy(bea, s, co, OWN);
    s.altered.set(1, { ...s.filed[0]!, keyEpoch: 1 });
    /* RED WHEN: a service changing an earlier version drops it from the count, so the company's calls go back through ours. */
    for (const reader of [ada, bea]) expect(await readBy(reader, s, co)).toEqual({ unread: 'no seat of the directory filed it' });
    /* RED WHEN: the act counts its own filing against a record the service has changed. */
    expect(await refusedWhenFiledBy(bea, s, co, NONE)).toMatchObject({ key: 'act.choose-company-service.why.unread' });
    expect(s.filed).toHaveLength(2);
  });

  it('a choice agreed by a seat that has left is unread, and a seated signer filing it again brings it back', async () => {
    const ada = seatOf(1);
    const bea = seatOf(2);
    const cyd = seatOf(3);
    const co: Company = { directory: [ada.entry, bea.entry, cyd.entry], onChain: [ada.leaf, bea.leaf, cyd.leaf], bar: 2 };
    const s = aService();
    await filedBy(ada, s, co, OWN);
    await filedBy(bea, s, co, OWN);
    const gone: Company = { ...co, onChain: [ada.leaf, cyd.leaf] };
    /* RED WHEN: a seat that agreed the choice leaving sends the company's calls back through ours. */
    expect(await readBy(ada, s, gone)).toEqual({ unread: expect.stringMatching(/agreed by signers who are no longer seated/u) });
    /* RED WHEN: the seated signers cannot file the choice again past it. */
    expect(await filedBy(cyd, s, gone, OWN)).toEqual({ state: CHOOSE_SERVICE_STATE.inForce, filed: 2, needed: 2 });
    expect(await readBy(ada, s, gone)).toEqual({ choice: OWN });
  });

  it('a version one seat seals to itself alone does not stop the others: they file past it', async () => {
    const ada = seatOf(1);
    const bea = seatOf(2);
    const cyd = seatOf(3);
    const co: Company = { directory: [ada.entry, bea.entry, cyd.entry], onChain: [ada.leaf, bea.leaf, cyd.leaf], bar: 2 };
    const s = aService();
    const sealedAlone = sealCompanyService({
      company: COMPANY, version: 1, sealing: { key: COMPANY_KEY, epoch: 0 }, choice: OWN, signers: [{ id: ada.leaf, wrappingPublicKey: ada.entry.wrappingKey as Hex }],
    });
    const alone = signCompanyFiling({ ...sealedAlone, wrapped: sealedAlone.wrapped.filter((w) => w.signerId !== COMPANY_WRAP_ID) }, ada.signing.secret as Hex);
    s.filed.push(alone);
    s.entered.push(1);
    s.digests.set(1, companyRecordEntry(alone).digest);
    expect(await readBy(bea, s, co)).toEqual({ unread: expect.stringMatching(/not sealed to this seat/u) });
    /* RED WHEN: one seat's version sealed to itself alone leaves every other seat unable to file. */
    expect(await filedBy(bea, s, co, NONE)).toEqual({ state: CHOOSE_SERVICE_STATE.waiting, filed: 1, needed: 2 });
    expect(await filedBy(cyd, s, co, NONE)).toEqual({ state: CHOOSE_SERVICE_STATE.inForce, filed: 2, needed: 2 });
    for (const reader of [bea, cyd]) expect(await readBy(reader, s, co)).toEqual({ choice: NONE });
  });
});

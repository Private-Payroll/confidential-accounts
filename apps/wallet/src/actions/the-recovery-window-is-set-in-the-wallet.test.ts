import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { newSigningKeypair, unwrapKey, type Hex } from '../../../../src/core/crypto.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import { fromCompanyWire, signCompanyFiling, toCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord } from '../../../../src/midnight/sealed-record-wire.js';
import { RECOVERY_WINDOW_RANGE, sealRecoveryWindow } from '../../../../src/midnight/recovery-window-record.js';
import { companyRecordEntry } from '../../../../src/midnight/record-manifest.js';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **THE RECOVERY WINDOW IS SET IN THE WALLET: AN ADMIN OR THE FOUNDING SEAT STARTS A CHANGE, ANY SEAT SIGNS IT, AND IT
 * COMES INTO FORCE AT THE SEAT BAR.** The filing step and the read are the real ones (`setRecoveryWindowAction`,
 * `recoveryWindowHere`), over a service that keeps what is filed and entered, and a directory stood in for here, as the
 * company's choice of service is pinned. The upkeep's own steps are pinned with the upkeep, and are not run here.
 */
/* Who is leaving the company is not this file's subject, and this company's stand-in reads no proposals: no seat here is leaving. */
vi.mock('./leaving-read-in-the-wallet.js', async (real) => ({
  ...(await real<typeof import('./leaving-read-in-the-wallet.js')>()),
  stopsFor: () => async () => null,
}));
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

const { setRecoveryWindowAction, WINDOW_STATE } = await import('./set-recovery-window.js');
const { keepRecoveryWindowHere, recoveryWindowHere } = await import('../../../../packages/web-shared/src/recovery-window-here.js');
const { CompanyKeyBeingChanged } = await import('../../../../packages/web-shared/src/company-key-here.js');
const { treeKeptInMemory } = await import('../../../../packages/web-shared/src/tree-kept-here.js');

const COMPANY = 'acc_window';
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const COMPANY_KEY = '0c'.repeat(32) as Hex;
const keyAt = (): Hex => COMPANY_KEY;
const HOUR = 3600;

const seatOf = (n: number, role: string | null) => {
  const signing = newSigningKeypair();
  const records = recordsKeypairFrom(new Uint8Array(Buffer.from(String(n).padStart(2, '0').repeat(32), 'hex')));
  return {
    leaf: `a${n}`.repeat(32), signing,
    entry: { seat: `a${n}`.repeat(32), person: `usr_${n}`, signingKey: signing.publicKey.toLowerCase(), wrappingKey: records.publicKey as string, role, retired: null },
    opener: { signerId: `a${n}`.repeat(32), keyOf: (w: Parameters<typeof unwrapKey>[0]) => unwrapKey(w, records.secret) as Hex, companyCopy: () => { throw new Error('no company copy here'); } },
  };
};
type Seat = ReturnType<typeof seatOf>;
const aService = () => ({
  filed: [] as SealedCompanyRecord[], entered: [] as number[], digests: new Map<number, string>(), versionsFail: false,
  /* The versions the company's records anchor, as the directory read gives them. */
  anchored: new Map<string, { version: number; batch: number; digest?: string; dirVersion: number }[]>(),
});
type Service = ReturnType<typeof aService>;
interface Company { readonly directory: Seat['entry'][]; readonly onChain: string[]; readonly bar: number }

const reachOf = (me: Seat, s: Service, co: Company) => {
  const here = {
    dir: { seats: co.directory }, holders: { seats: co.onChain, approvals: co.bar, policyBar: null, seatBar: co.bar }, another: new Set<string>(),
    records: {
      history: s.anchored, notYetAnchored: [] as unknown[], reached: { seq: 4, head: 'ab'.repeat(32), root: 'cd'.repeat(32), dirVersion: 1 },
      held: () => ({ seats: co.onChain, seatBar: co.bar }),
    },
    at: () => ({ dir: { seats: co.directory } }),
  };
  const entries = () => s.entered.map((version) => ({ store: 'company', kind: 'policy', id: 'recovery-window', version, digest: s.digests.get(version) }));
  return {
    accountId: COMPANY, label: LABEL, account: ACCOUNT, leaf: me.leaf, opener: me.opener,
    seat: { signerId: me.leaf, signingSecret: me.signing.secret, wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: 'cc'.repeat(32) },
    companyKeys: { epoch: 0, keyAt, sealing: () => ({ key: COMPANY_KEY, epoch: 0 }) },
    roster: async () => ({}), stepTo: () => {},
    api: async (path: string, init?: RequestInit) => {
      if (path === `/api/accounts/${COMPANY}/records/policy/recovery-window/versions`) {
        if (s.versionsFail) throw Object.assign(new Error('the service answered 503'), { status: 503 });
        return { versions: s.filed.map((r) => toCompanyWire(r)) };
      }
      if (path === `/api/accounts/${COMPANY}/manifest/entries` && init?.method === 'POST') {
        for (const e of (JSON.parse(String(init.body)) as { entries: { version: number; digest: string }[] }).entries) {
          s.entered.push(e.version);
          s.digests.set(e.version, e.digest);
        }
        return {};
      }
      throw Object.assign(new Error(`not served here: ${path}`), { status: 500 });
    },
    send: async (path: string, init: { method: string; body?: string }) => {
      if (path.match(/^\/api\/accounts\/acc_window\/records\/policy\/recovery-window\/(\d+)$/u) === null || init.method !== 'PUT') return { status: 404, body: {} };
      const wire = JSON.parse(String(init.body));
      const rec = fromCompanyWire(wire, { company: COMPANY, kind: 'policy', id: 'recovery-window' }).sealed;
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

const intent = (seconds: number): ActIntent =>
  ({ name: 'set-recovery-window', fields: { record: COMPANY, company: LABEL, account: ACCOUNT, seconds: String(seconds) } }) as ActIntent;
const ctxOf = (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity: {}, account: 0 }, at: { step: 1, steps: 4 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('setting the window relays nothing'); },
    call: async () => ({ status: 404, body: {} }),
    tell: (x: Record<string, unknown>) => { told.push(x); },
    keyring: null,
  } as unknown as StepContext;
  return { ctx, told };
};
const actionFor = (me: Seat, s: Service, co: Company) => setRecoveryWindowAction({
  chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, reachFor: async () => reachOf(me, s, co) as never,
});
const setBy = async (me: Seat, s: Service, co: Company, seconds: number) => {
  const i = intent(seconds);
  const { ctx, told } = ctxOf(i);
  try {
    for (const step of actionFor(me, s, co).steps(i)) if (!step.title.key.startsWith('act.upkeep.')) await step.run(ctx);
  } catch (e) {
    if (e instanceof StepRefused) return e.words;
    throw e;
  }
  return told[told.length - 1];
};
const readBy = (me: Seat, s: Service, co: Company) => recoveryWindowHere(reachOf(me, s, co) as never);

const company = () => {
  const ada = seatOf(1, 'admin');
  const bea = seatOf(2, 'approver');
  const cal = seatOf(3, 'approver');
  return { ada, bea, cal, co: { directory: [ada.entry, bea.entry, cal.entry], onChain: [ada.leaf, bea.leaf, cal.leaf], bar: 2 } as Company };
};

describe('THE RECOVERY WINDOW IS SET IN THE WALLET', () => {
  it('lists every route it asks for, and has a word for every key it says', () => {
    const shape = intentShapeOf('set-recovery-window')!;
    /* RED WHEN: the act's own list leaves out the read of the window or its filing, so it would be stopped while running. */
    expect(routeOf(shape, 'GET', `/api/accounts/${COMPANY}/records/policy/recovery-window/versions`)).not.toBeNull();
    expect(routeOf(shape, 'PUT', `/api/accounts/${COMPANY}/records/policy/recovery-window/3`)).not.toBeNull();
    expect(routeOf(shape, 'POST', `/api/accounts/${COMPANY}/manifest/entries`)).not.toBeNull();
    for (const key of ['headline', 'shown.length', 'shown.bar', 'shown.devices', 'check.range', 'why.role-may-not-start', 'why.outside-the-range', 'why.unread']) {
      expect(WORDS[`act.set-recovery-window.${key}`], key).toBeTypeOf('string');
    }
  });

  it('an admin starts a change, one signature short of the bar waits, and an approver\'s signature brings it into force', async () => {
    const { ada, bea, cal, co } = company();
    const s = aService();
    /* RED WHEN: one signature, short of the seat bar, is told or read as in force. */
    expect(await setBy(ada, s, co, 2 * HOUR)).toEqual({ state: WINDOW_STATE.waiting, signed: 1, needed: 2 });
    expect(await readBy(cal, s, co)).toMatchObject({ inForce: null, waiting: { seconds: 2 * HOUR, signed: 1, needed: 2 } });
    /* RED WHEN: a seat whose role does not file policy cannot add its signature to the change. */
    expect(await setBy(bea, s, co, 2 * HOUR)).toEqual({ state: WINDOW_STATE.inForce, signed: 2, needed: 2 });
    expect(await readBy(cal, s, co)).toMatchObject({ inForce: { seconds: 2 * HOUR, sequence: 1 }, waiting: null });
    expect(s.filed.map((r) => [r.version, verifiedCompanyFiler(r)])).toEqual([[1, ada.signing.publicKey], [2, bea.signing.publicKey]]);
  });

  it('a seat whose role does not file policy starts no change, and a length past the range is refused before anything is read', async () => {
    const { ada, bea, co } = company();
    const s = aService();
    /* RED WHEN: an approver starts a change of the window. */
    expect(await setBy(bea, s, co, HOUR)).toEqual({ key: 'act.set-recovery-window.why.role-may-not-start' });
    expect(s.filed).toEqual([]);
    /* RED WHEN: a window past the top of the range is filed. */
    expect(await actionFor(ada, s, co).check(intent(RECOVERY_WINDOW_RANGE.longest + 1), {} as never)).toMatchObject({ key: 'act.set-recovery-window.why.outside-the-range' });
    expect(await actionFor(ada, s, co).check(intent(RECOVERY_WINDOW_RANGE.longest), {} as never)).toBeNull();
  });

  /* RED WHEN: a failed read of the directory or of the service is said with the final full stop and trailing space its own words ended with, so the page's sentence reads with two stops, or the words are changed in any other way. */
  it('says why a read failed in the failure\'s own words, without the full stop that ended them', async () => {
    const { ada, co } = company();
    const s = aService();
    const failing = (message: string) => ({ ...reachOf(ada, s, co), judges: { directoryHereFor: () => async () => { throw new Error(message); } } });
    expect(await recoveryWindowHere(failing('the directory could not be read.  ') as never)).toEqual({ unread: 'the directory could not be read' });
    expect(await recoveryWindowHere(failing('the directory could not be read. Try later.') as never)).toEqual({ unread: 'the directory could not be read. Try later' });
    expect(await recoveryWindowHere(failing('the directory could not be read') as never)).toEqual({ unread: 'the directory could not be read' });
  });

  /* RED WHEN: the refusal for a company key being changed carries the whole message, its closing sentences included, or none of the reason. */
  it('refuses to seal while the company key is being changed, saying only why', async () => {
    const { ada, co } = company();
    const s = aService();
    const paused = { ...reachOf(ada, s, co), companyKeys: { epoch: 0, keyAt, sealing: (): never => { throw new CompanyKeyBeingChanged('a removal is carried out first'); } } };
    const i = intent(HOUR);
    const { ctx } = ctxOf(i);
    const act = setRecoveryWindowAction({ chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, reachFor: async () => paused as never });
    let refused: unknown = null;
    try {
      for (const step of act.steps(i)) if (!step.title.key.startsWith('act.upkeep.')) await step.run(ctx);
    } catch (e) {
      if (e instanceof StepRefused) refused = e.words;
      else throw e;
    }
    expect(refused).toEqual({ key: 'act.set-recovery-window.why.key-being-changed', values: { says: 'a removal is carried out first' } });
  });

  it('a version sealed under a key this device lacks is unread here; one the service withholds is a failed read, never a window', async () => {
    const { ada, bea, co } = company();
    const s = aService();
    await setBy(ada, s, co, HOUR);
    const noKey = { ...reachOf(bea, s, co), companyKeys: { epoch: 0, keyAt: (): Hex => { throw new Error('no key at epoch 0'); }, sealing: () => ({ key: COMPANY_KEY, epoch: 0 }) } };
    const stranger = { ...seatOf(9, 'admin'), entry: bea.entry };
    /* RED WHEN: a version this device holds no key for is skipped, so the window reads as none and a recovery holds a length the company did not choose. */
    expect(await recoveryWindowHere({ ...noKey, opener: stranger.opener } as never)).toMatchObject({ unread: expect.stringMatching(/version 1 of the recovery window was sealed under the company's key at epoch 0, which this device does not hold/u), noKey: true });
    await setBy(bea, s, co, HOUR);
    s.filed.length = 1;
    /* RED WHEN: a version the company's records name is withheld by the service, and the window reads as none, or as a version with no key. */
    const withheld = await readBy(bea, s, co);
    expect(withheld).toMatchObject({ unread: expect.stringMatching(/name version 2 of the recovery window and the service did not give it/u) });
    expect('noKey' in withheld).toBe(false);
  });

  it('one seat\'s version sealed wrong for every device does not switch the window off: it is passed over and the window in force kept', async () => {
    const { ada, bea, cal, co } = company();
    const s = aService();
    await setBy(ada, s, co, 2 * HOUR);
    await setBy(bea, s, co, 2 * HOUR);
    const bad = sealRecoveryWindow({
      company: COMPANY, version: 3, sealing: { key: '0d'.repeat(32) as Hex, epoch: 0 }, change: { sequence: 2, seconds: HOUR, signatures: [] },
      seats: [{ id: 'nobody', wrappingPublicKey: recordsKeypairFrom(new Uint8Array(32).fill(9)).publicKey }],
    });
    const wire = toCompanyWire(signCompanyFiling(bad, cal.signing.secret));
    const filedBad = fromCompanyWire(wire, { company: COMPANY, kind: 'policy', id: 'recovery-window' }).sealed;
    s.filed.push(filedBad);
    s.entered.push(3);
    s.digests.set(3, companyRecordEntry(filedBad).digest);
    /* RED WHEN: one version no device can open makes every device read the window as unread and refuse every recovery. */
    expect(await readBy(ada, s, co)).toMatchObject({ inForce: { seconds: 2 * HOUR, version: 2 }, highest: 3 });
  });

  it('the window a recovery holds is folded only from versions the records anchor up to the head read; a failed read keeps none in force where none is named', async () => {
    const { ada, bea, co } = company();
    const s = aService();
    await setBy(ada, s, co, 2 * HOUR);
    await setBy(bea, s, co, 2 * HOUR);
    /* RED WHEN: a version entered and not yet anchored is held by a recovery from the head read. */
    expect(await recoveryWindowHere(reachOf(ada, s, co) as never, { anchoredOnly: true })).toMatchObject({ inForce: null, at: { seq: 4 }, named: [] });
    s.anchored.set('company:policy:recovery-window', [1, 2].map((version) => ({ version, batch: version + 2, digest: s.digests.get(version), dirVersion: 1 })));
    expect(await recoveryWindowHere(reachOf(ada, s, co) as never, { anchoredOnly: true })).toMatchObject({ inForce: { seconds: 2 * HOUR }, named: [3, 4] });
    const kept = treeKeptInMemory();
    const empty = aService();
    empty.versionsFail = true;
    await keepRecoveryWindowHere(COMPANY, () => recoveryWindowHere(reachOf(ada, empty, co) as never, { anchoredOnly: true }), kept);
    /* RED WHEN: a service that does not answer, where the records name no window, is kept as unread. */
    expect(await kept.windows.read(COMPANY)).toEqual({ head: 'ab'.repeat(32), seq: 4, seconds: null });
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { bech32m } from '@scure/base';
import { addressFor } from 'midnight-identity';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import {
  invitationIdOf, newInvitationToken, sealOffer, signOffer, signSeatInvitation, type InvitationOffer, type SignedOffer,
} from '../../../../src/core/invitation.js';
import { fromHex, signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import type { Role, RosterEmployee } from '../../../../src/core/types.js';
import { sealPerson } from '../../../../src/core/person-record.js';
import { sealVendor, type VendorRecord } from '../../../../src/core/vendor-record.js';
import { signCompanyFiling, toCompanyWire } from '../../../../src/midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../../../../src/midnight/record-manifest.js';
import { FiledNotEntered } from '../../../../packages/web-shared/src/record-entered-here.js';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../../../../src/testing/assets.js';
import { metadataOf, type Keyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import { withSeatInvitationKept } from '../../../../packages/web-shared/src/kept-seat-invitations.js';
import type { KeptSeatInvitation } from '../../../../packages/web-shared/src/invitation-on-device.js';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **SOMEBODY IS INVITED FROM THE WALLET, IN ONE WINDOW, WITH THE WALLET'S OWN SEAT.** What the action asks of the
 * invitation's shared code (`inviteHere`, stood in for here and followed end to end against the service and the chain
 * in a-signer-invited-by-address-is-seated-by-their-own-wallet.test.ts) is pinned: the page's token for the link, the
 * person's details as the page gave them, the wallet's own doors for a vendor and a signer by address, the invitation
 * kept in the saved keys before anything is raised and taken up again rather than made anew, a press again under a
 * token already used carried on only with the first press's kind and details, kept or filed, the record a first press
 * filed and did not enter entered before a press again is told done, and the words of every stop.
 */

const t = vi.hoisted(() => ({
  calls: [] as string[],
  invite: null as null | ((...a: any[]) => Promise<unknown>),
  /* What the company's service answers for a record's versions, and the newest version its records hold. */
  records: null as null | ((kind: string, id: string) => { status: number; body: unknown }),
  entered: 1,
  entries: [] as unknown[],
  enterFails: false,
  /* How the chain holds the proposal every kept seat offer names: open, cleared, closed or never raised (the default). */
  held: 'never' as string,
}));
vi.mock('../../../../packages/web-shared/src/invitation-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/invitation-on-device.js')>()),
  inviteHere: (...a: any[]) => { t.calls.push(`invite ${a[2]}`); return t.invite!(...a); },
}));
vi.mock('./upkeep.js', async (real) => {
  const actual = await real<typeof import('./upkeep.js')>();
  return {
    ...actual,
    upkeepSteps: (company: { reach: (c: unknown) => Promise<unknown>; renew: () => void }) => ({
      first: { title: { key: 'act.upkeep.step.first' }, run: async (c: unknown) => { t.calls.push('upkeep-first'); await company.reach(c); company.renew(); } },
      last: { title: { key: 'act.upkeep.step.last' }, run: async (c: unknown) => { t.calls.push('upkeep-last'); await company.reach(c); } },
    }),
  };
});

const { inviteAction, INVITE_STATE } = await import('./invite.js');
const { InvitationRaisedNotFiled } = await import('../../../../packages/web-shared/src/invitation-on-device.js');

const NET = 'undeployed' as const;
const secret = newSecret();
const identity = identityFromSecret(secret);
const OWN_ADDRESS = addressFor(identity.moneyAt(0).zswap, NET).bech32;
const DEES_ADDRESS = addressFor(identityFromSecret(new Uint8Array(32).fill(4)).moneyAt(0).zswap, NET).bech32;
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const ALL = MidnightCommitments.allVaults().toLowerCase();
const NOW_MS = 1_800_000_000_000;
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const SOURCE = readFileSync(new URL('./invite.ts', import.meta.url), 'utf8');
const OPENING = { publicKey: '05'.repeat(32), scope: ALL, blinding: '03'.repeat(32), salt: '06'.repeat(32), walletKey: { tag: 'schnorr', value: '07'.repeat(32) } };
const seatWith = (scope: string) => ({ signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope, opening: OPENING });

const TOKEN = newInvitationToken();
const BASE = { record: 'acc_1', company: LABEL, account: ACCOUNT, token: TOKEN };
const EMPLOYEE = {
  ...BASE, kind: 'employee', personName: 'Ada Lovelace', email: 'ada@example.com', title: 'Engineer', asset: TEST_TOKEN, amount: '5000',
  startDate: '2026-11-01', classification: 'full-time',
};
const VENDOR = { ...BASE, kind: 'vendor', personName: 'Acme Printing', startDate: '2026-11-01', terms: 'one-off', address: DEES_ADDRESS };
const SIGNER = { ...BASE, kind: 'signer', personName: 'Dee', role: 'approver', address: DEES_ADDRESS };
const intent = (fields: Record<string, string | undefined>): ActIntent => ({
  name: 'invite', fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, string>,
}) as ActIntent;

/*
 * The offers a first press made, signed by this wallet's own seat as the wallet signs them: a seat offered by address
 * as it is kept in the saved keys, and an employee's and a vendor's as the service holds them filed, sealed to the token.
 */
const SIGNING = '01'.repeat(32) as Hex;
const INVITER = {
  committeeKey: committeeKeyFor(identity, LABEL) as { tag: string; value: string },
  statement: signDirectoryEntry(identity, LABEL, ACCOUNT as never, fromHex('11'.repeat(32)), signingPublicKeyOf(SIGNING).toLowerCase(), 'aa'.repeat(32)),
  opening: OPENING,
};
const offerOf = (forWhom: InvitationOffer['for'], o: { company?: string; expiresAt?: number } = {}): SignedOffer => signOffer({
  company: o.company ?? 'acc_1', companyName: 'Acme', label: LABEL, account: ACCOUNT, inboxPublicKey: '12'.repeat(32),
  expiresAt: o.expiresAt ?? NOW_MS + 60_000, madeAt: '2026-10-29T04:00:00Z', for: forWhom, inviter: INVITER,
} as unknown as InvitationOffer, SIGNING);
const seatFor = (o: { name?: string; role?: Role; scope?: string; address?: string } = {}): InvitationOffer['for'] => {
  const name = o.name ?? 'Dee';
  const role = o.role ?? 'approver';
  const invited = signSeatInvitation({
    company: 'acc_1', invitation: invitationIdOf(TOKEN), person: 'adr_00000000000000000000', name, role,
    invite: { address: '0a'.repeat(32) as Hex, salt: '0b'.repeat(32) as Hex, scope: (o.scope ?? ALL) as Hex }, proposal: '0c'.repeat(32) as Hex,
  }, SIGNING);
  return { kind: 'signer', name, role, seat: { nonce: '0d'.repeat(32) as Hex, secret: '0e'.repeat(32) as Hex }, invited,
    byAddress: { address: o.address ?? DEES_ADDRESS, proposalSalt: '0f'.repeat(32) as Hex } };
};
const EMPLOYEE_OFFERED = {
  kind: 'employee', person: 'emp_00000000000000000000', name: 'Ada Lovelace', title: 'Engineer', email: 'ada@example.com', asset: TEST_TOKEN,
  baseAmount: 5000n, startDate: '2026-11-01', classification: 'full-time',
} as unknown as InvitationOffer['for'];
const VENDOR_OFFERED = {
  kind: 'vendor', person: 'ven_00000000000000000000', name: 'Acme Printing', email: null, startDate: '2026-11-01', address: DEES_ADDRESS,
} as unknown as InvitationOffer['for'];
const KEPT_OFFER = offerOf(seatFor());
const KEPT = (id = invitationIdOf(TOKEN), signature?: string, expiresAt = NOW_MS + 60_000): KeptSeatInvitation => ({
  company: 'acc_1', id, token: TOKEN, link: `https://app.example/join/${id}#${TOKEN}`,
  offer: expiresAt === NOW_MS + 60_000 && signature === undefined ? KEPT_OFFER
    : { offer: { ...KEPT_OFFER.offer, expiresAt }, signature: (signature ?? KEPT_OFFER.signature) as Hex },
});
/** The first version of the employee's and the vendor's record a first press filed with the invitation, signed by `secret`. */
const MADE = { madeBy: signingPublicKeyOf(SIGNING), madeAt: '2026-10-29T04:00:00Z' };
const PERSON_V1 = (secret: Hex = SIGNING) => signCompanyFiling(sealPerson({
  id: 'emp_00000000000000000000', accountId: 'acc_1', name: 'Ada Lovelace', email: 'ada@example.com', title: 'Engineer', asset: TEST_TOKEN,
  baseAmount: 5000n, startDate: '2026-11-01', status: 'pending', wrappingPublicKey: null, handedOverBy: null, admittedBy: null, admittedAt: null,
  selfRaised: false, address: null, pay: [{ amount: 5000n, from: '2026-11-01', ...MADE }],
  classifications: [{ classification: 'full-time', from: '2026-11-01', ...MADE }], ...MADE,
} as unknown as RosterEmployee, 1, 0, '11'.repeat(32) as Hex), secret);
const VENDOR_V1 = (secret: Hex = SIGNING) => signCompanyFiling(sealVendor({
  id: 'ven_00000000000000000000', accountId: 'acc_1', name: 'Acme Printing', email: null, network: NET, startDate: '2026-11-01',
  terms: { kind: 'one-off' }, status: 'pending', address: null, wrappingPublicKey: null, handedOverBy: null, admittedBy: null, admittedAt: null,
  invitedAddress: DEES_ADDRESS, ...MADE,
} as unknown as VendorRecord, 1, 0, '11'.repeat(32) as Hex), secret);
const versionsOf = (...filed: ReturnType<typeof PERSON_V1>[]) => ({ status: 200, body: { versions: filed.map((f) => toCompanyWire(f)) } });
const RECORDS = (kind: string) => versionsOf(kind === 'person' ? PERSON_V1() : VENDOR_V1());

/** What the service answers for the offer filed under the token: the first press's offer, sealed to `token`. */
const filedAs = (forWhom: InvitationOffer['for'], o: { company?: string; token?: Hex; signed?: SignedOffer } = {}) => ({
  status: 200, body: { kind: forWhom.kind, offer: sealOffer(o.signed ?? offerOf(forWhom, o), o.token ?? TOKEN), expiresAt: '2027-01-15T08:00:00.000Z' },
});

const ctxWith = (i: ActIntent, o: { keyring?: Keyring | null; offer?: { status: number; body?: unknown }; offerAt?: Record<string, { status: number }> } = {}) => {
  const calls: string[] = [];
  const told: Array<Record<string, unknown>> = [];
  let held: Keyring = o.keyring ?? { accounts: {} };
  const kept: Keyring[] = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret, account: 0 }, at: { step: 3, steps: 4 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('an invitation is sent through its calls, never a bare relay'); },
    call: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      const record = /\/records\/(person|vendor)\/([^/]+)\/versions$/u.exec(path);
      if (record !== null && t.records !== null) return t.records(record[1]!, record[2]!);
      const only = o.offerAt?.[path.split('/')[3] ?? ''];
      if (only !== undefined && path.endsWith('/offer')) return { status: only.status, body: {} };
      return path.endsWith('/offer') && o.offer !== undefined ? { status: o.offer.status, body: o.offer.body ?? {} } : { status: 404, body: {} };
    },
    tell: (x: Record<string, unknown>) => { told.push(x); if (x['state'] !== undefined) t.calls.push(`told ${String(x['state'])}`); },
    keyring: o.keyring === null ? null : {
      open: () => ({ read: () => held }),
      keep: async (change: (k: Keyring) => Keyring) => { held = change(held); kept.push(held); t.calls.push('kept'); },
    },
  } as unknown as StepContext;
  return { ctx, calls, told, kept, held: () => held };
};

const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const reachOf = (scope = ALL) => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: seatWith(scope), leaf: 'aa'.repeat(32), companyKey: '11'.repeat(32),
  stepTo: () => {},
  api: async (path: string, init?: RequestInit) => {
    t.calls.push(`api ${init?.method ?? 'GET'} ${path}`);
    if (path.endsWith('/manifest/newest')) return { versions: [t.entered] };
    if (path.endsWith('/manifest/entries')) {
      if (t.enterFails) throw new Error('the service is down');
      t.entries.push(...(JSON.parse(String(init?.body)) as { entries: unknown[] }).entries);
      return {};
    }
    return [];
  },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({ seats: ['aa'.repeat(32)], committee: [], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }),
  judges: {
    directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null, records: { history: new Map() } }),
    filingJudgeFor: () => async () => null, leavesFor: () => async () => [],
    rosterReadsFor: () => ({ filings: async () => [], holders: async () => ({ seats: [] }), anchored: async () => ({}), leaves: async () => [], invitedSeats: async () => ({}) }),
  },
  sealed: {}, companyKeys: KEYS,
  roster: async () => ({ id: 'acc_1', name: 'Acme', signers: [] }),
  builder: { roundsOnChain: async (q: { chainIds: string[] }) => Object.fromEntries(q.chainIds.map((c) => [c, { held: t.held, approvals: 0 }])), companyWide: async () => 'cc'.repeat(32) },
  chain: {
    indexer: { indexerUri: 'https://indexer.wallet.example', indexerWsUri: 'wss://indexer.wallet.example' },
    callState: async () => ({ blockHash: 'b'.repeat(64), accountState: 'AS', parameters: 'PP' }),
  },
});

const action = (scope = ALL) => inviteAction({
  chain: () => ({}) as never, builder: () => ({}) as never, now: () => NOW_MS, pause: async () => {},
  commitments: async () => MidnightCommitments as never, reachFor: async () => reachOf(scope) as never,
  assets: registryWithTestPrivateForms(), network: NET, waitMs: 3, everyMs: 1,
});

/** Runs every step of the action, as the wallet's runner does, until one refuses. */
const run = async (i: ActIntent, ctx: StepContext, scope = ALL): Promise<void> => {
  for (const step of action(scope).steps(i)) await step.run(ctx);
};
const refusedWith = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return (e as StepRefused).words.key;
};

beforeEach(() => {
  t.calls.length = 0;
  t.invite = async () => ({ link: 'https://app.example/join/x#y', id: 'x' });
  t.records = RECORDS;
  t.entered = 1;
  t.entries.length = 0;
  t.enterFails = false;
  t.held = 'never';
});

describe('SOMEBODY IS INVITED FROM THE WALLET, WITH ITS OWN SEAT', () => {
  it('an employee is invited with the page\'s token for the link and the details the page gave, between the upkeep\'s two steps', async () => {
    const { ctx, told } = ctxWith(intent(EMPLOYEE));
    let asked: any[] = [];
    t.invite = async (...a: any[]) => { asked = a; return { link: 'l', id: 'i' }; };
    await run(intent(EMPLOYEE), ctx);
    /* RED WHEN: the invitation is made with a token of the wallet's own, so the page's link does not open it. */
    expect(asked[7]).toEqual({ token: TOKEN });
    /* RED WHEN: the link is made for another page than the one that asked. */
    expect(asked[4]).toBe('https://app.example');
    /* RED WHEN: the employee's pay or details are not the ones the page gave and the window showed. */
    expect(asked[3]).toEqual({
      name: 'Ada Lovelace', email: 'ada@example.com', title: 'Engineer', asset: TEST_TOKEN, baseAmount: 5000n, startDate: '2026-11-01',
      classification: 'full-time',
    });
    /* RED WHEN: the invitation is made by another seat than the one this wallet holds, or before the upkeep's first step. */
    expect(asked[1].signingSecret).toBe('01'.repeat(32));
    expect(asked[1].opening).toEqual(OPENING);
    expect(t.calls.filter((c) => !c.startsWith('api'))).toEqual(['upkeep-first', 'invite employee', 'told filed', 'upkeep-last']);
    expect(told.at(-1)).toEqual({ state: INVITE_STATE.filed });
  });

  it('a vendor invited at an address is checked against the company\'s vendors as this wallet reads them', async () => {
    let asked: any[] = [];
    t.invite = async (...a: any[]) => { asked = a; return { link: 'l', id: 'i' }; };
    await run(intent(VENDOR), ctxWith(intent(VENDOR)).ctx);
    /* RED WHEN: a vendor by address is invited with no read of the vendors, so one address could be paid twice. */
    expect(typeof asked[6]?.vendors).toBe('function');
    expect(asked[3]).toMatchObject({ name: 'Acme Printing', terms: { kind: 'one-off' }, network: NET, address: DEES_ADDRESS });
  });

  it('a signer by address is kept in the saved keys before anything is raised, with the wallet\'s own doors', async () => {
    const { ctx, held } = ctxWith(intent(SIGNER));
    let asked: any[] = [];
    t.invite = async (...a: any[]) => {
      asked = a;
      await a[6].keep(KEPT());
      t.calls.push('raised');
      return { link: 'l', id: 'i' };
    };
    await run(intent(SIGNER), ctx);
    /* RED WHEN: the proposal is raised before the invitation is kept, so a raise can exist with no copy of its offer. */
    expect(t.calls.filter((c) => ['kept', 'told kept', 'raised'].includes(c))).toEqual(['kept', 'told kept', 'raised']);
    expect(held().seatInvitationsKept?.[invitationIdOf(TOKEN)]).toEqual(KEPT());
    /* RED WHEN: the raise has no door to refuse a wallet already seated or invited here. */
    expect(typeof asked[6].held).toBe('function');
    expect(asked[3]).toMatchObject({ name: 'Dee', role: 'approver', address: DEES_ADDRESS });
    expect(asked[7]).toEqual({ token: TOKEN });
  });

  it('a signer kept by an earlier attempt is taken up again, not invited anew', async () => {
    const { ctx } = ctxWith(intent(SIGNER), { keyring: { accounts: {}, seatInvitationsKept: { [invitationIdOf(TOKEN)]: KEPT() } } });
    let asked: any[] = [];
    t.invite = async (...a: any[]) => { asked = a; return { link: 'l', id: 'i' }; };
    await run(intent(SIGNER), ctx);
    /* RED WHEN: a step taken up again makes a new invitation, and a second proposal, for one address. */
    expect(asked[7]).toEqual({ token: TOKEN, resume: KEPT() });
  });

  it('an invitation already filed for this token is not made a second time', async () => {
    const { ctx, told } = ctxWith(intent(EMPLOYEE), { offer: filedAs(EMPLOYEE_OFFERED) });
    await run(intent(EMPLOYEE), ctx);
    /* RED WHEN: pressing again after the invitation was filed files a second person record. */
    expect(t.calls.some((c) => c.startsWith('invite'))).toBe(false);
    expect(told.at(-1)).toEqual({ state: INVITE_STATE.alreadyFiled });
  });

  it('RED WHEN: a signer is invited with no saved keys to keep the invitation in before the raise', async () => {
    const { ctx } = ctxWith(intent(SIGNER), { keyring: null });
    expect(await refusedWith(run(intent(SIGNER), ctx))).toBe('act.invite.why.no-saved-keys');
    expect(t.calls.some((c) => c.startsWith('invite'))).toBe(false);
  });

  it('RED WHEN: a signer is offered rights wider than the inviting seat\'s own', async () => {
    const narrow = '04'.repeat(32);
    expect(await refusedWith(run(intent({ ...SIGNER }), ctxWith(intent(SIGNER)).ctx, narrow))).toBe('act.invite.why.wider-scope');
    expect(await refusedWith(run(intent({ ...SIGNER, scope: '09'.repeat(32) }), ctxWith(intent(SIGNER)).ctx, narrow))).toBe('act.invite.why.wider-scope');
    expect(t.calls.some((c) => c.startsWith('invite'))).toBe(false);
    /* Its own rights it may offer, and a seat of every vault may offer any. */
    await run(intent({ ...SIGNER, scope: narrow }), ctxWith(intent(SIGNER)).ctx, narrow);
    await run(intent({ ...SIGNER, scope: '09'.repeat(32) }), ctxWith(intent(SIGNER)).ctx);
    expect(t.calls.filter((c) => c === 'invite signer')).toHaveLength(2);
  });

  it('RED WHEN: a signer is invited at an address this wallet holds itself, and one wallet would hold two seats', async () => {
    const own = intent({ ...SIGNER, address: OWN_ADDRESS });
    expect(await refusedWith(run(own, ctxWith(own).ctx))).toBe('act.invite.why.own-address');
    /* RED WHEN: the wallet's own coin key, written with another encryption key, passes as somebody else's address. */
    const decoded = bech32m.decodeToBytes(OWN_ADDRESS);
    const sameCoinKey = bech32m.encode(decoded.prefix, bech32m.toWords(Uint8Array.from([...decoded.bytes.slice(0, 32), ...new Uint8Array(32).fill(9)])), false);
    expect(sameCoinKey).not.toBe(OWN_ADDRESS);
    const disguised = intent({ ...SIGNER, address: sameCoinKey });
    expect(await refusedWith(run(disguised, ctxWith(disguised).ctx))).toBe('act.invite.why.own-address');
    expect(t.calls.some((c) => c.startsWith('invite'))).toBe(false);
  });

  it('RED WHEN: a signer is invited with no address, or a super admin by a seat', async () => {
    const a = action();
    expect(await a.check(intent({ ...SIGNER, address: undefined }), { identity, secret })).toEqual({ key: 'act.invite.why.signer-by-address' });
    expect(await a.check(intent({ ...SIGNER, kind: 'super-admin' }), { identity, secret })).toEqual({ key: 'act.invite.why.super-admin' });
    expect(await a.check(intent({ ...EMPLOYEE, token: 'zz' }), { identity, secret })).toEqual({ key: 'act.invite.why.not-a-token' });
    expect(await a.check(intent(EMPLOYEE), { identity, secret })).toBeNull();
  });

  it('a signer invited with a new threshold is shown it, and one that is not a whole number of at least one is refused before anything is signed', async () => {
    const a = action();
    /* RED WHEN: the window does not show the threshold the seat sets once taken, or shows one where none was asked. */
    expect((await a.shown(intent({ ...SIGNER, threshold: '2' }))).find((l) => l.key === 'act.invite.shown.threshold')).toMatchObject({ values: { threshold: '2' }, from: 'page' });
    expect((await a.shown(intent(SIGNER))).map((l) => l.key)).not.toContain('act.invite.shown.threshold');
    expect((await a.shown(intent({ ...SIGNER, threshold: '0' }))).map((l) => l.key)).not.toContain('act.invite.shown.threshold');
    /* RED WHEN: a threshold no account could set is let through to be signed into the invitation. */
    for (const bad of ['-1', '1.5', 'x', '01', '18446744073709551616']) {
      expect(await a.check(intent({ ...SIGNER, threshold: bad }), { identity, secret }), bad).toEqual({ key: 'act.invite.why.not-a-threshold' });
    }
    /* "0", like none, keeps the threshold in force. */
    expect(await a.check(intent({ ...SIGNER, threshold: '0' }), { identity, secret })).toBeNull();
    expect(await a.check(intent({ ...SIGNER, threshold: '2' }), { identity, secret })).toBeNull();
  });

  it('a seat offered by address raised and not filed says so, so the page gives the link it made by hand', async () => {
    const { ctx, told } = ctxWith(intent(SIGNER));
    t.invite = async () => { throw new InvitationRaisedNotFiled('l', 'the service is down'); };
    /* RED WHEN: a raise whose filing failed is said as if nothing was raised. */
    expect(await refusedWith(run(intent(SIGNER), ctx))).toBe('act.invite.why.raised-not-filed');
    expect(told.at(-1)).toEqual({ state: INVITE_STATE.raisedNotFiled });
  });

  it('the wallet refuses an employee or a vendor the page asked for without a name, a known asset, pay above zero, a classification, a start date or terms', async () => {
    const a = action();
    const refusal = async (fields: Record<string, string | undefined>): Promise<unknown> => a.check(intent(fields), { identity, secret });
    const VENDOR_MONTHLY = { ...VENDOR, terms: 'monthly', termsAsset: TEST_TOKEN, termsAmount: '10' };
    expect(await refusal(VENDOR_MONTHLY)).toBeNull();
    const table: Array<[string, Record<string, string | undefined>, string]> = [
      /* RED WHEN: a person is invited with no name, so an offer is filed for nobody and the page shows a blank. */
      ['employee, no name', { ...EMPLOYEE, personName: '' }, 'no-name'],
      ['employee, a blank name', { ...EMPLOYEE, personName: '   ' }, 'no-name'],
      ['vendor, no name', { ...VENDOR, personName: undefined }, 'no-name'],
      /* RED WHEN: an employee is invited at pay in an asset that is no asset, or one the wallet's registry does not hold. */
      ['employee, no asset', { ...EMPLOYEE, asset: undefined }, 'not-an-asset'],
      ['employee, an asset that is not a hash', { ...EMPLOYEE, asset: 'zz' }, 'not-an-asset'],
      ['employee, an asset the registry does not hold', { ...EMPLOYEE, asset: 'ee'.repeat(32) }, 'not-an-asset'],
      /* RED WHEN: a vendor is invited on monthly terms in an asset the registry does not hold. */
      ['vendor, monthly terms with no asset', { ...VENDOR_MONTHLY, termsAsset: undefined }, 'not-an-asset'],
      ['vendor, monthly terms in an asset the registry does not hold', { ...VENDOR_MONTHLY, termsAsset: 'ee'.repeat(32) }, 'not-an-asset'],
      /* RED WHEN: an employee or a vendor is invited at pay of zero or less, which the person is then promised. */
      ['employee, no pay', { ...EMPLOYEE, amount: undefined }, 'no-pay'],
      ['employee, pay of zero', { ...EMPLOYEE, amount: '0' }, 'no-pay'],
      ['employee, pay below zero', { ...EMPLOYEE, amount: '-5' }, 'no-pay'],
      ['vendor, no monthly amount', { ...VENDOR_MONTHLY, termsAmount: undefined }, 'no-pay'],
      ['vendor, a monthly amount of zero', { ...VENDOR_MONTHLY, termsAmount: '0' }, 'no-pay'],
      ['vendor, a monthly amount below zero', { ...VENDOR_MONTHLY, termsAmount: '-1' }, 'no-pay'],
      /* RED WHEN: an employee is invited with no classification, or one that is none of the wallet's. */
      ['employee, no classification', { ...EMPLOYEE, classification: undefined }, 'no-classification'],
      ['employee, a classification that is none of them', { ...EMPLOYEE, classification: 'volunteer' }, 'no-classification'],
      /* RED WHEN: an employee or a vendor is invited with no start date, so the pay has no day to begin from. */
      ['employee, no start date', { ...EMPLOYEE, startDate: undefined }, 'no-start'],
      ['employee, an empty start date', { ...EMPLOYEE, startDate: '' }, 'no-start'],
      ['vendor, one-off, no start date', { ...VENDOR, startDate: undefined }, 'no-start'],
      ['vendor, monthly, no start date', { ...VENDOR_MONTHLY, startDate: undefined }, 'no-start'],
      /* RED WHEN: a vendor is invited with no terms, or terms that are neither one-off nor monthly, and is treated as one-off. */
      ['vendor, no terms', { ...VENDOR, terms: undefined }, 'no-terms'],
      ['vendor, terms that are neither one-off nor monthly', { ...VENDOR, terms: 'weekly' }, 'no-terms'],
    ];
    for (const [what, fields, key] of table) expect(await refusal(fields), what).toEqual({ key: `act.invite.why.${key}` });
    expect(t.calls.some((c) => c.startsWith('invite'))).toBe(false);
  });

  it('every route the invite action called itself is one its intent lists', async () => {
    const shape = intentShapeOf('invite')!;
    const called: string[] = [];
    for (const i of [EMPLOYEE, VENDOR, SIGNER]) {
      t.calls.length = 0;
      const { ctx, calls } = ctxWith(intent(i));
      await run(intent(i), ctx);
      called.push(...calls, ...t.calls.filter((c) => c.startsWith('api ')).map((c) => c.slice(4)));
    }
    expect(called.length).toBeGreaterThan(0);
    /* RED WHEN: the action calls a route its intent does not list, which the wallet itself refuses only when it runs. */
    for (const c of called) {
      const [m, p] = c.split(' ');
      expect(routeOf(shape, m!, p!), c).not.toBeNull();
    }
  });

  it('every route the invitation uses is one the invite intent lists, and every stop and line has its words', async () => {
    const shape = intentShapeOf('invite')!;
    /* RED WHEN: the wallet asks for a route the action's list does not name, which the wallet itself refuses. */
    for (const [m, p] of [['GET', `/api/invites/${'ab'.repeat(32)}/offer`], ['POST', '/api/accounts/acc_1/invites'], ['POST', '/api/accounts/acc_1/proposals'],
      ['POST', '/api/proposals/prp_abcdefghijkl/standing'], ['GET', '/api/accounts/acc_1/runs'], ['POST', '/api/accounts/acc_1/manifest/entries']] as const) {
      expect(routeOf(shape, m, p), `${m} ${p}`).not.toBeNull();
    }
    const keys = new Set<string>(['act.invite.headline', ...action().checks.filter((c) => c.key.startsWith('act.invite')).map((c) => c.key)]);
    for (const i of [EMPLOYEE, VENDOR, SIGNER, { ...SIGNER, scope: '09'.repeat(32) }, { ...SIGNER, threshold: '2' }, { ...VENDOR, terms: 'monthly', termsAsset: TEST_TOKEN, termsAmount: '10' }]) {
      for (const line of await action().shown(intent(i))) if (line.key.startsWith('act.invite')) keys.add(line.key);
    }
    for (const m of SOURCE.matchAll(/why\('([a-z-]+)'/gu)) keys.add(`act.invite.why.${m[1]}`);
    for (const m of SOURCE.matchAll(/key: 'act\.invite\.([a-z.-]+)'/gu)) keys.add(`act.invite.${m[1]}`);
    for (const k of ['not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened']) keys.add(`act.invite.why.${k}`);
    /* RED WHEN: a stop or a line of the window has no words, and the person is shown a key. */
    expect([...keys].filter((k) => WORDS[k] === undefined)).toEqual([]);
  });
});

describe('A SEAT OFFERED BY ADDRESS IS KEPT IN THE SAVED KEYS, AND NEVER SHOWN TO THE PAGE', () => {
  it('RED WHEN: another invitation kept under the same id is written over, or an expired one is kept for ever', () => {
    const first = withSeatInvitationKept({ accounts: {} }, KEPT(), NOW_MS);
    expect(withSeatInvitationKept(first, KEPT(), NOW_MS).seatInvitationsKept).toEqual(first.seatInvitationsKept);
    expect(() => withSeatInvitationKept(first, KEPT(undefined, 'bb'.repeat(64)), NOW_MS)).toThrow(/not written over/u);
    const other = KEPT('cd'.repeat(32));
    const later = withSeatInvitationKept(first, other, NOW_MS + 120_000);
    expect(Object.keys(later.seatInvitationsKept!)).toEqual(['cd'.repeat(32)]);
    /* RED WHEN: the same invitation signed again for the key in force now does not replace the one kept, or any other signature does. */
    const again = { ...KEPT(), offer: signOffer({ ...KEPT_OFFER.offer, inboxPublicKey: '13'.repeat(32) }, SIGNING) };
    expect(withSeatInvitationKept(first, again, NOW_MS).seatInvitationsKept).toEqual({ [again.id]: again });
    expect(() => withSeatInvitationKept(first, { ...again, offer: signOffer({ ...again.offer.offer, expiresAt: NOW_MS + 90_000 }, SIGNING) }, NOW_MS)).toThrow(/not written over/u);
    expect(() => withSeatInvitationKept(first, { ...again, offer: signOffer({ ...again.offer.offer, for: seatFor({ name: 'Eve' }) }, SIGNING) }, NOW_MS)).toThrow(/not written over/u);
  });

  it('RED WHEN: what the page is shown of the saved keys carries a kept invitation, with the secret its seat is proved by', () => {
    const k = withSeatInvitationKept({ accounts: {} }, KEPT(), NOW_MS);
    expect(JSON.stringify(metadataOf(k))).not.toContain(TOKEN);
  });
});

describe('A PRESS AGAIN WITH THE SAME TOKEN CARRIES THE FIRST PRESS\'S ASK, OR IS REFUSED BEFORE ANYTHING IS RAISED, FILED OR SIGNED', () => {
  const OTHER_ADDRESS = addressFor(identityFromSecret(new Uint8Array(32).fill(5)).moneyAt(0).zswap, NET).bech32;
  const keptHere = (): Keyring => ({ accounts: {}, seatInvitationsKept: { [invitationIdOf(TOKEN)]: KEPT() } });
  const refused = async (p: Promise<unknown>): Promise<StepRefused> => {
    const e = await p.then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(StepRefused);
    return e as StepRefused;
  };
  /** Nothing of the invitation was made: no invitation, no keep, no told outcome but the refusal's. */
  const nothingMade = (): void => {
    expect(t.calls.filter((c) => c.startsWith('invite') || c === 'kept' || c.startsWith('told'))).toEqual([]);
  };

  it('a signer pressed again under a kept seat offer\'s token goes on only with the name, role, rights and address it was kept with', async () => {
    for (const other of [{ role: 'admin' }, { personName: 'Dee Two' }, { scope: '09'.repeat(32) }, { address: OTHER_ADDRESS }]) {
      t.calls.length = 0;
      const i = intent({ ...SIGNER, ...other });
      const e = await refused(run(i, ctxWith(i, { keyring: keptHere() }).ctx));
      /* RED WHEN: a press again raises the kept seat while the window showed another role, rights, name or address. */
      expect(e.words.key).toBe('act.invite.why.not-made');
      expect(String(e.words.values?.['says'])).toMatch(/press again with the same details as the first time, or start a new invitation/u);
      nothingMade();
    }
    t.calls.length = 0;
    let asked: any[] = [];
    t.invite = async (...a: any[]) => { asked = a; return { link: 'l', id: 'i' }; };
    await run(intent(SIGNER), ctxWith(intent(SIGNER), { keyring: keptHere() }).ctx);
    expect(asked[7]).toEqual({ token: TOKEN, resume: KEPT() });
  });

  it('a signer pressed again from a page that lost its token goes on with the invitation this wallet kept for the same company and address', async () => {
    const fresh = newInvitationToken();
    const i = intent({ ...SIGNER, token: fresh });
    let asked: any[] = [];
    t.invite = async (...a: any[]) => { asked = a; return { link: 'l', id: 'i' }; };
    const first = ctxWith(i, { keyring: keptHere() });
    await run(i, first.ctx);
    /* RED WHEN: a page that lost its token starts a new invitation, which the address's open proposal then refuses. */
    expect(asked[7]).toEqual({ token: TOKEN, resume: KEPT() });
    /* RED WHEN: the page is not told the token the invitation goes on under, and gives the person a link built from its own. */
    expect(first.told).toContainEqual({ token: TOKEN });
    /* The page's own token needs no telling. */
    const own = ctxWith(intent(SIGNER), { keyring: keptHere() });
    await run(intent(SIGNER), own.ctx);
    expect(own.told.some((x) => 'token' in x)).toBe(false);
    /* RED WHEN: an invitation kept for another company, for another address or past its expiry is taken up for this press. */
    const idOf = 'cd'.repeat(32);
    for (const other of [{ ...KEPT(idOf), company: 'acc_2' }, KEPT(idOf, undefined, NOW_MS - 1), { ...KEPT(idOf), offer: offerOf(seatFor({ address: OTHER_ADDRESS })) }]) {
      asked = [];
      const keyring: Keyring = { accounts: {}, seatInvitationsKept: { [idOf]: other } };
      await run(i, ctxWith(i, { keyring }).ctx);
      expect(asked[7]).toEqual({ token: fresh });
    }
    /* RED WHEN: a press that differs from the kept invitation in name, role or rights is taken up as the kept one. */
    t.calls.length = 0;
    const differs = intent({ ...SIGNER, token: fresh, role: 'admin' });
    const e = await refused(run(differs, ctxWith(differs, { keyring: keptHere() }).ctx));
    expect(String(e.words.values?.['says'])).toMatch(/press again with the same details as the first time/u);
    nothingMade();
  });

  it('RED WHEN: a kept invitation whose link was used or withdrawn, or whose proposal is closed, is taken up again for a page that lost its token', async () => {
    const fresh = newInvitationToken();
    const i = intent({ ...SIGNER, token: fresh });
    let asked: any[] = [];
    t.invite = async (...a: any[]) => { asked = a; return { link: 'l', id: 'i' }; };
    /* The service answers that the kept link is closed: it is passed over and let go of, and a new invitation is made. */
    const used = ctxWith(i, { keyring: keptHere(), offerAt: { [invitationIdOf(TOKEN)]: { status: 410 } } });
    await run(i, used.ctx);
    expect(asked[7]).toEqual({ token: fresh });
    expect(used.held().seatInvitationsKept ?? {}).toEqual({});
    /* The chain holds its proposal closed (withdrawn or carried out): the same. */
    t.held = 'closed';
    asked = [];
    const closed = ctxWith(i, { keyring: keptHere() });
    await run(i, closed.ctx);
    expect(asked[7]).toEqual({ token: fresh });
    expect(closed.held().seatInvitationsKept ?? {}).toEqual({});
    /* RED WHEN: one closed and one open of two kept for an address are told as two live ones, so the person is refused. */
    t.held = 'never';
    asked = [];
    const second = 'cd'.repeat(32);
    const two = ctxWith(i, { keyring: { accounts: {}, seatInvitationsKept: { [invitationIdOf(TOKEN)]: KEPT(), [second]: KEPT(second) } }, offerAt: { [second]: { status: 410 } } });
    await run(i, two.ctx);
    expect(asked[7]).toEqual({ token: TOKEN, resume: KEPT() });
    expect(Object.keys(two.held().seatInvitationsKept ?? {})).toEqual([invitationIdOf(TOKEN)]);
    /* RED WHEN: a read of the service that fails is taken for a closed invitation. */
    t.calls.length = 0;
    const unread = await refused(run(i, ctxWith(i, { keyring: keptHere(), offerAt: { [invitationIdOf(TOKEN)]: { status: 503 } } }).ctx));
    expect(unread.words.key).toBe('act.invite.why.offer-not-read');
    nothingMade();
  });

  it('RED WHEN: two live invitations kept for one company and address are told apart by the page\'s token alone, or one is taken for the other', async () => {
    const fresh = newInvitationToken();
    const i = intent({ ...SIGNER, token: fresh });
    const keyring: Keyring = { accounts: {}, seatInvitationsKept: { [invitationIdOf(TOKEN)]: KEPT(), ['cd'.repeat(32)]: KEPT('cd'.repeat(32)) } };
    t.calls.length = 0;
    const e = await refused(run(i, ctxWith(i, { keyring }).ctx));
    expect(e.words.key).toBe('act.invite.why.not-made');
    expect(String(e.words.values?.['says'])).toMatch(/more than one invitation kept on this device for this address.*withdraw/u);
    nothingMade();
    /* The page's own token still names its own. */
    let asked: any[] = [];
    t.invite = async (...a: any[]) => { asked = a; return { link: 'l', id: 'i' }; };
    await run(intent(SIGNER), ctxWith(intent(SIGNER), { keyring }).ctx);
    expect(asked[7]).toEqual({ token: TOKEN, resume: KEPT() });
  });

  it('an employee or a vendor asked under the token of a seat offer kept and raised is refused, and nothing is filed under its id', async () => {
    for (const i of [intent(EMPLOYEE), intent(VENDOR)]) {
      t.calls.length = 0;
      const e = await refused(run(i, ctxWith(i, { keyring: keptHere() }).ctx));
      /* RED WHEN: a payee's offer is filed under the id of a seat offer already raised, which can then never be filed. */
      expect(e.words.key).toBe('act.invite.why.not-made');
      expect(String(e.words.values?.['says'])).toMatch(/a signer, not an employee|a signer, not a vendor/u);
      nothingMade();
    }
  });

  it('a press again whose invitation is already filed is told done only when the filed offer is of the same kind and details', async () => {
    const done = async (i: ActIntent, offer: { status: number; body?: unknown }, keyring?: Keyring): Promise<void> => {
      t.calls.length = 0;
      const { ctx, told } = ctxWith(i, { offer, ...(keyring === undefined ? {} : { keyring }) });
      await run(i, ctx);
      expect(told.at(-1)).toEqual({ state: INVITE_STATE.alreadyFiled });
      expect(t.calls.some((c) => c.startsWith('invite'))).toBe(false);
    };
    const notDone = async (i: ActIntent, offer: { status: number; body?: unknown }, keyring?: Keyring): Promise<string> => {
      t.calls.length = 0;
      const e = await refused(run(i, ctxWith(i, { offer, ...(keyring === undefined ? {} : { keyring }) }).ctx));
      expect(e.words.key).toBe('act.invite.why.not-made');
      nothingMade();
      return String(e.words.values?.['says']);
    };
    await done(intent(EMPLOYEE), filedAs(EMPLOYEE_OFFERED));
    /* RED WHEN: a press again with an edited ask is told done with the first ask's invitation. */
    expect(await notDone(intent({ ...EMPLOYEE, amount: '6000' }), filedAs(EMPLOYEE_OFFERED))).toMatch(/another pay/u);
    expect(await notDone(intent({ ...EMPLOYEE, title: 'Director' }), filedAs(EMPLOYEE_OFFERED))).toMatch(/another title/u);
    /* RED WHEN: an invitation made by link is told done for a press that asks by address, or the other way round. */
    expect(await notDone(intent({ ...EMPLOYEE, address: DEES_ADDRESS }), filedAs(EMPLOYEE_OFFERED))).toMatch(/another address/u);
    /* RED WHEN: a signer's press is told done with an employee's invitation filed under the same id. */
    expect(await notDone(intent(SIGNER), filedAs(EMPLOYEE_OFFERED))).toMatch(/an employee, not a signer/u);
    await done(intent(VENDOR), filedAs(VENDOR_OFFERED));
    /* RED WHEN: a vendor pressed again on other terms is told done with the entry the first press filed. */
    expect(await notDone(intent({ ...VENDOR, terms: 'monthly', termsAsset: TEST_TOKEN, termsAmount: '10' }), filedAs(VENDOR_OFFERED))).toMatch(/other terms/u);
    /* A seat kept and then filed is done; one filed under its id that is not the offer kept is not. */
    await done(intent(SIGNER), filedAs(seatFor(), { signed: KEPT_OFFER }), keptHere());
    /* RED WHEN: an offer filed under a kept seat's id that is not the kept offer is told done as that seat's invitation. */
    const another = offerOf(seatFor(), { expiresAt: NOW_MS + 90_000 });
    expect(another.signature).not.toBe(KEPT_OFFER.signature);
    expect(await notDone(intent(SIGNER), filedAs(seatFor(), { signed: another }), keptHere())).toMatch(/not the one this wallet kept/u);
  });

  it('RED WHEN: an offer filed under the token that the token does not open, or that is another company\'s, is taken as this press\'s invitation', async () => {
    for (const offer of [filedAs(EMPLOYEE_OFFERED, { token: newInvitationToken() }), filedAs(EMPLOYEE_OFFERED, { company: 'acc_2' })]) {
      t.calls.length = 0;
      const e = await refused(run(intent(EMPLOYEE), ctxWith(intent(EMPLOYEE), { offer }).ctx));
      expect(e.words.key).toBe('act.invite.why.not-made');
      expect(String(e.words.values?.['says'])).toMatch(/start a new invitation/u);
      nothingMade();
    }
  });

  it('RED WHEN: a press again after its invitation was used, expired or withdrawn raises or files anything, for an id that can never be filed again', async () => {
    for (const i of [intent(SIGNER), intent(EMPLOYEE)]) {
      t.calls.length = 0;
      const e = await refused(run(i, ctxWith(i, { offer: { status: 410, body: { refused: 'used' } } }).ctx));
      expect(e.words.key).toBe('act.invite.why.not-made');
      expect(String(e.words.values?.['says'])).toMatch(/used, has expired or was withdrawn.*start a new invitation/u);
      nothingMade();
    }
  });

  it('RED WHEN: a press again that cannot read whether its invitation is filed makes one anyway, or tells the page to start a new one', async () => {
    for (const status of [429, 503]) {
      t.calls.length = 0;
      const e = await refused(run(intent(EMPLOYEE), ctxWith(intent(EMPLOYEE), { offer: { status } }).ctx));
      expect(e.words).toEqual({ key: 'act.invite.why.offer-not-read', values: { status } });
      nothingMade();
    }
    expect(WORDS['act.invite.why.offer-not-read']).toMatch(/press again/iu);
  });
});

describe('A PRESS AGAIN WHOSE FIRST PRESS FILED THE INVITATION AND ITS RECORD ENTERS THE RECORD BEFORE IT IS TOLD DONE', () => {
  const refused = async (p: Promise<unknown>): Promise<StepRefused> => {
    const e = await p.then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(StepRefused);
    return e as StepRefused;
  };

  it('a press again whose first press filed an employee\'s or a vendor\'s record and did not enter it enters it, signed by this seat, before it is told done', async () => {
    for (const [i, offered, filed, kind] of [[intent(EMPLOYEE), EMPLOYEE_OFFERED, PERSON_V1(), 'person'], [intent(VENDOR), VENDOR_OFFERED, VENDOR_V1(), 'vendor']] as const) {
      t.calls.length = 0;
      t.entries.length = 0;
      t.entered = 0;
      t.records = () => versionsOf(filed);
      const { ctx, told } = ctxWith(i, { offer: filedAs(offered) });
      await run(i, ctx);
      /* RED WHEN: the inviter is told done while the record filed with the invitation is in no company record, so no other device believes the person. */
      expect(t.entries).toHaveLength(1);
      expect(t.entries[0]).toMatchObject({ ...companyRecordEntry(filed), filedBy: { publicKey: signingPublicKeyOf(SIGNING) } });
      expect(t.entries[0]).toMatchObject({ store: 'company', kind, version: 1 });
      expect(told.at(-1)).toEqual({ state: INVITE_STATE.alreadyFiled });
      expect(t.calls.some((c) => c.startsWith('invite'))).toBe(false);
    }
    /* A record the company's records already hold is not entered again. */
    t.entries.length = 0;
    t.entered = 1;
    t.records = RECORDS;
    await run(intent(EMPLOYEE), ctxWith(intent(EMPLOYEE), { offer: filedAs(EMPLOYEE_OFFERED) }).ctx);
    expect(t.entries).toEqual([]);
  });

  it('RED WHEN: a record filed under the invitation that this seat did not file, or none at all, is entered by this seat or told done', async () => {
    for (const records of [() => versionsOf(PERSON_V1('31'.repeat(32) as Hex)), () => versionsOf()]) {
      t.records = records;
      t.entered = 0;
      t.entries.length = 0;
      t.calls.length = 0;
      const e = await refused(run(intent(EMPLOYEE), ctxWith(intent(EMPLOYEE), { offer: filedAs(EMPLOYEE_OFFERED) }).ctx));
      expect(e.words.key).toBe('act.invite.why.not-made');
      expect(String(e.words.values?.['says'])).toMatch(/not one this seat filed.*start a new invitation/u);
      expect(t.entries).toEqual([]);
      expect(t.calls.filter((c) => c.startsWith('told') || c.startsWith('invite'))).toEqual([]);
    }
  });

  it('RED WHEN: a record filed and not entered is said as an invitation not made, or a press again that cannot enter it is told done', async () => {
    t.invite = async () => { throw new FiledNotEntered('the service is down'); };
    const fresh = await refused(run(intent(EMPLOYEE), ctxWith(intent(EMPLOYEE)).ctx));
    expect(fresh.words).toEqual({ key: 'act.invite.why.filed-not-entered', values: { says: 'the service is down' } });
    t.entered = 0;
    t.enterFails = true;
    t.calls.length = 0;
    const again = await refused(run(intent(EMPLOYEE), ctxWith(intent(EMPLOYEE), { offer: filedAs(EMPLOYEE_OFFERED) }).ctx));
    expect(again.words.key).toBe('act.invite.why.filed-not-entered');
    expect(t.calls.filter((c) => c.startsWith('told'))).toEqual([]);
    for (const status of [503]) {
      t.records = () => ({ status, body: {} });
      const unread = await refused(run(intent(VENDOR), ctxWith(intent(VENDOR), { offer: filedAs(VENDOR_OFFERED) }).ctx));
      expect(unread.words.key).toBe('act.invite.why.filed-not-entered');
    }
    /* The words send the inviter to the same invitation again, never to a new one. */
    expect(WORDS['act.invite.why.filed-not-entered']).toMatch(/press again to carry on with this same one/u);
  });
});

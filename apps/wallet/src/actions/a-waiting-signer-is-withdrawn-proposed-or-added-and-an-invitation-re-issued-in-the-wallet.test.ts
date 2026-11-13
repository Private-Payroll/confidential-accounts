import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActIntent } from 'midnight-identity/profile/request';
import { inboxPublicKey, sealToInbox } from '../../../../src/core/sealed-records.js';
import type { Hex } from '../../../../src/core/crypto.js';
import { StepRefused, type Held, type StepContext } from './definition.js';

/*
 * **A PERSON WAITING FOR A SEAT IS WITHDRAWN OR PROPOSED, A SIGNER IS ADDED FROM THEIR CODE, AND AN INVITATION IS SENT
 * AGAIN AND KEPT, EACH FROM ONE WALLET WINDOW.** What each action hands the shared code (stood in for here, and followed
 * against the service and the chain in a-waiting-signer-is-withdrawn-and-an-invitation-re-issued.test.ts) is pinned:
 * the wallet's own reads of the chain and the company, this wallet's seat, what only the window shows, and the words of
 * every stop.
 */

const t = vi.hoisted(() => ({
  calls: [] as string[],
  withdrawalReads: null as null | ((...a: any[]) => Promise<unknown>),
  withdraw: null as null | ((...a: any[]) => Promise<unknown>),
  reissue: null as null | ((...a: any[]) => Promise<unknown>),
  take: null as null | ((...a: any[]) => Promise<unknown>),
  addByCode: null as null | ((...a: any[]) => Promise<unknown>),
  raise: null as null | ((...a: any[]) => Promise<unknown>),
  watched: [] as string[],
  offer: null as unknown,
}));
vi.mock('../../../../packages/web-shared/src/waiting-signer-withdrawn.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/waiting-signer-withdrawn.js')>()),
  withdrawalReadsHere: (...a: any[]) => { t.calls.push('withdrawal-reads'); return t.withdrawalReads!(...a); },
  withdrawWaitingSignerHere: (...a: any[]) => { t.calls.push('withdraw'); return t.withdraw!(...a); },
}));
vi.mock('../../../../packages/web-shared/src/invitation-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/invitation-on-device.js')>()),
  reissueInvitationHere: (...a: any[]) => { t.calls.push('reissue'); return t.reissue!(...a); },
  takeTheReissueHere: (...a: any[]) => { t.calls.push('take'); return t.take!(...a); },
}));
vi.mock('../../../../packages/web-shared/src/invitation-by-code.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/invitation-by-code.js')>()),
  addSignerFromCodeHere: (...a: any[]) => { t.calls.push('add-by-code'); return t.addByCode!(...a); },
}));
vi.mock('../../../../packages/web-shared/src/signer-by-link.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/signer-by-link.js')>()),
  seatSignerOnDevice: (...a: any[]) => { t.calls.push('raise'); return t.raise!(...a); },
}));
vi.mock('../../../../src/core/invitation.js', async (real) => ({
  ...(await real<typeof import('../../../../src/core/invitation.js')>()),
  openOffer: () => t.offer,
}));
vi.mock('../keyring/nothing-secret-crosses.js', async (real) => ({
  ...(await real<typeof import('../keyring/nothing-secret-crosses.js')>()),
  watchFor: (secret: string) => { t.watched.push(String(secret)); },
}));
/* This wallet's seat, as it invites: its role read from the directory, and the inviter record the person's wallet checks. */
const SEAT = Object.freeze({
  signingSecret: '01'.repeat(32), held: { role: 'admin', retired: false, rights: { every: true } },
  committeeKey: { tag: 'schnorr', value: 'c1'.repeat(32) }, statement: { seat: 'aa'.repeat(32) }, opening: { publicKey: 'o1'.repeat(32) },
});
vi.mock('./invite.js', async (real) => ({
  ...(await real<typeof import('./invite.js')>()),
  invitingSeatOf: async () => { t.calls.push('seat'); return SEAT; },
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

const { withdrawWaitingSignerAction, WITHDRAW_STATE } = await import('./withdraw-waiting-signer.js');
const { reissueInvitationAction, REISSUE_STATE } = await import('./reissue-invitation.js');
const { takeReissueAction, TAKE_REISSUE_STATE } = await import('./take-reissue.js');
const { addSignerByCodeAction, ADD_BY_CODE_STATE } = await import('./add-signer-by-code.js');
const { raiseWaitingSignerAction } = await import('./raise-waiting-signer.js');
const { SeatMayNotInvite, InvitationRefused } = await import('../../../../packages/web-shared/src/invitation-on-device.js');
const { CodeNotTaken } = await import('../../../../packages/web-shared/src/invitation-by-code.js');
const { InvitationNotBound } = await import('../../../../packages/web-shared/src/governed-call-on-device.js');
const { kindKeyOf } = await import('../../../../src/midnight/records-held.js');
const { invitationIdOf } = await import('../../../../src/core/invitation.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const HELD: Held = { identity, secret };
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const KEY = '11'.repeat(32) as Hex;
const LEAF = 'aa'.repeat(32);
const THEIR_LEAF = 'bb'.repeat(32);
const SCOPE = 'dd'.repeat(32);
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const BASE = { record: 'acc_1', company: LABEL, account: ACCOUNT };
const intent = (name: string, fields: Record<string, string>): ActIntent => ({ name, fields }) as ActIntent;
/* The company's anchored records name no proposal, so the proposals the service lists are read whole. */
const HERE = {
  records: { history: new Map(), notYetAnchored: [], asked: { records: new Set(), kinds: new Set([kindKeyOf({ store: 'proposal', kind: 'proposal' })]) } },
  dir: { seats: [] }, holders: { seats: [LEAF, THEIR_LEAF] },
};
const PROPOSALS = [{ id: 'prp_one', accountId: 'acc_1' }];
/** A request waiting for a seat, sealed to the company as the person's device sealed it. */
const waitingFor = (opening: unknown) => ({ id: 'sgn_wes', sealed: sealToInbox({ name: 'Wes', opening }, inboxPublicKey(KEY, 'acc_1')) });
let pending: unknown[] = [];
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, leaf: LEAF, companyKey: KEY, companyKeys: KEY, stepTo: () => {},
  seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '0e'.repeat(32) },
  api: async (path: string) => { t.calls.push(`GET ${path}`); return path === '/api/accounts/acc_1/proposals' ? PROPOSALS : []; },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({ seats: [LEAF], committee: [], threshold: 1, approvals: 1, seatBar: 1 }),
  judges: {
    directoryHereFor: () => async () => HERE, filingJudgeFor: () => async () => null, leavesFor: () => async () => [],
    rosterReadsFor: () => ({ filings: async () => [], holders: async () => ({ seats: [] }), anchored: async () => ({}), leaves: async () => [], invitedSeats: async () => ({}) }),
  },
  sealed: { id: 'acc_1', pendingSigners: pending },
  roster: async () => ({ id: 'acc_1', name: 'Acme', signers: [] }),
  builder: {
    roundsOnChain: async () => ({}),
    accountPresence: async () => ({ blockTime: 1_000 }),
  },
  chain: { indexer: {} },
});
let kept: Record<string, unknown> = {};
const ctxOf = (i: ActIntent, person: string | null = 'usr_a') => {
  const told: Array<Record<string, unknown>> = [];
  const shown: Array<{ key: string; values?: Record<string, unknown> }> = [];
  const called: string[] = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person,
    held: { identity, secret, account: 0 }, at: { step: 3, steps: 4 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('these actions send through their calls, never a bare relay'); },
    call: async (method: string, path: string) => { called.push(`${method} ${path}`); return { status: 200, body: { offer: {} } }; },
    tell: (x: Record<string, unknown>) => { told.push(x); },
    show: (w: { key: string; values?: Record<string, unknown> }) => { shown.push(w); },
    keyring: { open: () => ({ read: () => kept }), keep: async (f: (k: unknown) => unknown) => { kept = f(kept) as Record<string, unknown>; } },
  } as unknown as StepContext;
  return { ctx, told, shown, called };
};
const REACH = { chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, commitments: async () => ({ inviteAddressOf: () => 'ee'.repeat(32) as Hex }), reachFor: async () => reachOf() as never };
const run = async (a: { steps: (i: ActIntent) => readonly { run: (c: StepContext) => Promise<void> }[] }, i: ActIntent, ctx: StepContext): Promise<void> => {
  for (const step of a.steps(i)) await step.run(ctx);
};
const refusedWith = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return (e as StepRefused).words.key;
};

beforeEach(() => {
  t.calls.length = 0;
  t.watched.length = 0;
  pending = [];
  kept = {};
});

describe('A PERSON WAITING FOR A SEAT IS WITHDRAWN FROM THE WALLET', () => {
  const WITHDRAW = intent('withdraw-waiting-signer', { ...BASE, signer: 'sgn_wes', personName: 'Wes' });
  const READS = { sealed: {}, proposals: PROPOSALS, onTheChain: [LEAF], openOnTheChain: [] };

  it('judges the withdrawal on the proposals the wallet reads open on the chain itself, then withdraws with its seat', async () => {
    let readWith: any[] = [];
    let withdrawnWith: any[] = [];
    t.withdrawalReads = async (...a) => { readWith = a; return READS; };
    t.withdraw = async (...a) => { withdrawnWith = a; };
    const { ctx, told } = ctxOf(WITHDRAW);
    await run(withdrawWaitingSignerAction(REACH), WITHDRAW, ctx);
    /* RED WHEN: the withdrawal is judged on proposals the chain holds open as the service says, not as this wallet reads the chain. */
    expect(typeof readWith[0].roundsOnChain).toBe('function');
    expect(typeof readWith[0].chainTime).toBe('function');
    expect(await readWith[0].chainTime()).toBe(1_000);
    expect(readWith.slice(2)).toEqual(['acc_1', KEY, 'sgn_wes']);
    /* RED WHEN: what the wallet read is not what the withdrawal is judged on, or another seat than this wallet's signs it. */
    expect(withdrawnWith[1]).toBe(SEAT);
    expect(withdrawnWith.slice(2, 4)).toEqual(['sgn_wes', READS]);
    /* RED WHEN: the request is withdrawn without being held to the name the person was shown, so a page can show one person and withdraw another. */
    expect(withdrawnWith[5]).toBe('Wes');
    expect(t.calls.filter((c) => !c.startsWith('GET'))).toEqual(['upkeep-first', 'seat', 'withdrawal-reads', 'withdraw', 'upkeep-last']);
    expect(told).toEqual([{ state: WITHDRAW_STATE.withdrawn }]);
  });

  it('a chain it cannot read, a seat that may not withdraw, or a service that refuses withdraws nobody, each said in its own words', async () => {
    t.withdrawalReads = async () => { throw new Error('the indexer did not answer'); };
    t.withdraw = async () => { throw new Error('never reached'); };
    /* RED WHEN: a chain not read lets the withdrawal go ahead as if no proposal could still seat them. */
    expect(await refusedWith(run(withdrawWaitingSignerAction(REACH), WITHDRAW, ctxOf(WITHDRAW).ctx))).toBe('act.withdraw-waiting-signer.why.chain-unread');
    expect(t.calls).not.toContain('withdraw');
    t.withdrawalReads = async () => READS;
    t.withdraw = async () => { throw new SeatMayNotInvite('Your role on this company may not file a proposal.'); };
    expect(await refusedWith(run(withdrawWaitingSignerAction(REACH), WITHDRAW, ctxOf(WITHDRAW).ctx))).toBe('act.withdraw-waiting-signer.why.may-not');
    t.withdraw = async () => { throw new InvitationRefused(409, 'seated-on-the-chain', 'that person has already taken their seat'); };
    expect(await refusedWith(run(withdrawWaitingSignerAction(REACH), WITHDRAW, ctxOf(WITHDRAW).ctx))).toBe('act.withdraw-waiting-signer.why.refused');
    expect(await withdrawWaitingSignerAction(REACH).check(intent('withdraw-waiting-signer', { ...BASE, personName: 'Wes' }), HELD)).toEqual({ key: 'act.withdraw-waiting-signer.why.not-a-signer' });
  });
});

describe('A SIGNER\'S INVITATION IS SENT AGAIN FROM THE WALLET, AND KEPT IN THE WALLET OF THE PERSON IT IS FOR', () => {
  const REISSUE = intent('reissue-invitation', { ...BASE, leaf: THEIR_LEAF, personName: 'Lee' });

  it('the link is made and watched in the wallet, shown in its window only, and never told to the page', async () => {
    let with_: any[] = [];
    t.reissue = async (...a) => { with_ = a; return { link: `https://app.example/join/x#${a[5].token}`, id: 'inv_1' }; };
    const { ctx, told, shown } = ctxOf(REISSUE);
    await run(reissueInvitationAction(REACH), REISSUE, ctx);
    const token = with_[5].token as string;
    /* RED WHEN: the token is made anywhere but in this wallet, or crosses to the page unwatched. */
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    expect(t.watched).toContain(token);
    /* RED WHEN: the invitation is sent again for another seat, or judged on seats the company's records were not read against. */
    expect(with_[2].leaf).toBe(THEIR_LEAF);
    expect(with_[2].onTheChain).toEqual([LEAF, THEIR_LEAF]);
    expect(with_[2].proposals).toEqual(PROPOSALS);
    expect(with_[1]).toBe(SEAT);
    /* RED WHEN: the page is told the link, which opens the person's invitation. */
    expect(JSON.stringify(told)).not.toContain(token);
    expect(told).toEqual([{ state: REISSUE_STATE.reissued }]);
    expect(shown.map((s) => s.key)).toEqual(['act.reissue-invitation.over.link']);
    expect(String(shown[0]!.values!['link'])).toContain(token);
  });

  it('names the person the link is for as the invitation it signs again names them, not as the page does', async () => {
    t.reissue = async () => ({ link: 'https://app.example/join/x#00', id: 'inv_1', name: 'Ann' });
    const { ctx, shown } = ctxOf(REISSUE);
    await run(reissueInvitationAction(REACH), REISSUE, ctx);
    /* RED WHEN: the window says to send the link to the person the page named, when the invitation it opens is another person's. */
    expect(shown[0]!.values!['name']).toBe('Ann');
  });

  it('a re-issue the shared code refuses is said in its words, and a seat that is not named is refused before anything is read', async () => {
    t.reissue = async () => { throw new SeatMayNotInvite('Your seat is not one the company\'s account holds now.'); };
    expect(await refusedWith(run(reissueInvitationAction(REACH), REISSUE, ctxOf(REISSUE).ctx))).toBe('act.reissue-invitation.why.not-made');
    expect(await reissueInvitationAction(REACH).check(intent('reissue-invitation', { ...BASE, leaf: 'not a seat', personName: 'Lee' }), HELD)).toEqual({ key: 'act.reissue-invitation.why.not-a-seat' });
  });

  const TAKE = intent('take-reissue', { ...BASE, token: 'ab'.repeat(32) });
  const offerFor = (over: Record<string, unknown> = {}) => ({
    offer: { company: 'acc_1', label: LABEL, account: ACCOUNT, expiresAt: Date.now() + 60_000, for: { kind: 'reissue' }, ...over },
  });
  const INVITER = { committeeKey: { tag: 'schnorr', value: 'c2'.repeat(32) }, statement: { seat: LEAF }, opening: {} };
  const INVITED = { terms: { leaf: LEAF }, signedBy: 'c3'.repeat(32), signature: '00'.repeat(64) };

  it('is kept for the person signed in and the seat these saved keys hold, as who invited them, in the seat and in an entry still owed', async () => {
    t.offer = offerFor();
    let mine: any = null;
    let chain: unknown = null;
    t.take = async (_o, m, _p, c, keep) => { mine = m; chain = c; await keep({ inviter: INVITER, invited: INVITED }); };
    kept = { accounts: { acc_1: { signingSecret: '01'.repeat(32), invitedBy: { statement: { seat: 'ff'.repeat(32) } } } }, directoryEntriesOwed: { acc_1: { person: 'usr_a' } } };
    const { ctx, told, called } = ctxOf(TAKE);
    await run(takeReissueAction(REACH), TAKE, ctx);
    /* RED WHEN: a re-issue is taken for whoever the page names, or for a seat these saved keys do not hold. */
    expect(mine).toEqual({ accountId: 'acc_1', person: 'usr_a', seat: LEAF, companyKeys: KEY });
    /* RED WHEN: the re-issue's inviter is judged against seats other than the ones this wallet read the chain to hold. */
    expect(chain).toEqual([LEAF, THEIR_LEAF]);
    /* RED WHEN: the wallet keeps the old inviter, so it still keeps no account on a seat the company holds. */
    expect((kept as any).accounts.acc_1.invitedBy).toEqual(INVITER);
    expect((kept as any).accounts.acc_1.invited).toEqual(INVITED);
    /* RED WHEN: an entry still owed is filed later under the invitation of the inviter who left. */
    expect((kept as any).directoryEntriesOwed.acc_1.invited).toEqual(INVITED);
    /* RED WHEN: taking a re-issue sends anything; it only reads the offer under its own link. */
    expect(called).toEqual([`GET /api/invites/${invitationIdOf('ab'.repeat(32) as Hex)}/offer`]);
    expect(told).toEqual([{ state: TAKE_REISSUE_STATE.kept }]);
  });

  it('an offer for another company, one that re-issues nothing, or nobody signed in keeps nothing', async () => {
    t.take = async () => { throw new Error('never reached'); };
    t.offer = offerFor({ company: 'acc_2' });
    /* RED WHEN: a re-issue for another company is kept against this one. */
    expect(await refusedWith(run(takeReissueAction(REACH), TAKE, ctxOf(TAKE).ctx))).toBe('act.take-reissue.why.another-company');
    t.offer = offerFor({ for: { kind: 'signer' } });
    expect(await refusedWith(run(takeReissueAction(REACH), TAKE, ctxOf(TAKE).ctx))).toBe('act.take-reissue.why.not-a-reissue');
    t.offer = offerFor();
    /* RED WHEN: a re-issue is kept with nobody signed in to hold it to. */
    expect(await refusedWith(run(takeReissueAction(REACH), TAKE, ctxOf(TAKE, null).ctx))).toBe('act.take-reissue.why.no-person');
    expect(t.calls).not.toContain('take');
  });
});

describe('A SIGNER IS ADDED FROM THEIR CODE, AND A PERSON WAITING IS PROPOSED, FROM THE WALLET', () => {
  const CODE = intent('add-signer-by-code', { ...BASE, code: '  mnjoin1.abc  ', personName: 'Gil', role: 'admin' });

  it('files the request from the code with this wallet\'s seat, and shows the fingerprint to compare in its window only', async () => {
    let with_: any[] = [];
    t.addByCode = async (...a) => { with_ = a; return { id: 'sgn_gil', fingerprint: 'FP-1234' }; };
    const { ctx, told, shown } = ctxOf(CODE);
    await run(addSignerByCodeAction({ ...REACH, leafOf: async () => 'CC'.repeat(32) }), CODE, ctx);
    expect(with_[1]).toBe(SEAT);
    expect(with_.slice(2, 4)).toEqual(['mnjoin1.abc', { name: 'Gil', role: 'admin' }]);
    /* RED WHEN: the leaf a code's opening makes is not read through this wallet's own reader of the account. */
    expect(await with_[5]([{}])).toEqual(['cc'.repeat(32)]);
    /* RED WHEN: the fingerprint to compare is told to the page instead of shown in the wallet's own window. */
    expect(told).toEqual([{ state: ADD_BY_CODE_STATE.filed, signer: 'sgn_gil' }]);
    expect(shown).toEqual([{ key: 'act.add-signer-by-code.over.fingerprint', values: { name: 'Gil', fingerprint: 'FP-1234' } }]);
  });

  it('a code the shared code refuses, or a role no signer holds, adds nobody, each said in its words', async () => {
    t.addByCode = async () => { throw new CodeNotTaken('This code does not carry an address its wallet signed for the seat.'); };
    expect(await refusedWith(run(addSignerByCodeAction(REACH), CODE, ctxOf(CODE).ctx))).toBe('act.add-signer-by-code.why.not-taken');
    expect(await addSignerByCodeAction(REACH).check(intent('add-signer-by-code', { ...BASE, code: 'mnjoin1.abc', personName: 'Gil', role: 'owner' }), HELD)).toEqual({ key: 'act.add-signer-by-code.why.no-role' });
  });

  const RAISE = intent('raise-waiting-signer', { ...BASE, signer: 'sgn_wes', personName: 'Wes', readOut: ' FP-1234 ' });

  it('raises the seat at the rights the person\'s own seat was made with, naming this wallet\'s seat as who invited them', async () => {
    pending.push(waitingFor({ scope: SCOPE.toUpperCase() }));
    let input: any = null;
    t.raise = async (_doors, i) => { input = i; return { state: 'waiting-for-approvals', round: null }; };
    const { ctx, told } = ctxOf(RAISE);
    await run(raiseWaitingSignerAction(REACH), RAISE, ctx);
    /* RED WHEN: the seat is raised at rights the page chose, rather than the ones the person's own seat was made with. */
    expect(input.invite).toEqual({ scope: SCOPE });
    /* RED WHEN: the proposal names no inviter, so a person added from a code has nobody their wallet can keep the account on. */
    expect(input.inviter).toEqual({ committeeKey: SEAT.committeeKey, statement: SEAT.statement, opening: SEAT.opening });
    expect([input.signerId, input.readOut, input.companyKeys]).toEqual(['sgn_wes', 'FP-1234', KEY]);
    expect(told).toEqual([{ state: 'waiting-for-approvals' }]);
  });

  it('a request no longer waiting, or one carrying no address its wallet signed, raises nothing, with words to withdraw it', async () => {
    t.raise = async () => { throw new InvitationNotBound('This person\'s seat request does not carry an address their own wallet signed.'); };
    /* RED WHEN: a person no longer waiting is raised anyway. */
    expect(await refusedWith(run(raiseWaitingSignerAction(REACH), RAISE, ctxOf(RAISE).ctx))).toBe('act.raise-waiting-signer.why.not-waiting');
    pending.push(waitingFor({ scope: SCOPE }));
    expect(await refusedWith(run(raiseWaitingSignerAction(REACH), RAISE, ctxOf(RAISE).ctx))).toBe('act.raise-waiting-signer.why.not-raised');
    expect(WORDS['act.raise-waiting-signer.why.not-raised']).toMatch(/withdraw it/u);
  });
});

describe('EVERY WORD THESE ACTIONS SAY IS IN THE WALLET\'S OWN WORDS', () => {
  it('names every headline, line, check, step and refusal each action can give', () => {
    const files = ['withdraw-waiting-signer', 'reissue-invitation', 'take-reissue', 'add-signer-by-code', 'raise-waiting-signer'];
    const seatWords = ['not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened'];
    for (const f of files) {
      const code = readFileSync(new URL(`./${f}.ts`, import.meta.url), 'utf8');
      const keys = [...code.matchAll(/'(act\.[a-z-]+\.[a-z-]+\.[a-z-]+|act\.[a-z-]+\.headline)'/gu)].map((m) => m[1]!);
      const whys = [...code.matchAll(/why\('([a-z-]+)'/gu)].map((m) => `act.${f}.why.${m[1]}`);
      /* RED WHEN: an action can stop or show a line the wallet has no words for. */
      for (const k of [...keys, ...whys, ...seatWords.map((w) => `act.${f}.why.${w}`)]) expect(WORDS[k], k).toBeTypeOf('string');
    }
  });
});

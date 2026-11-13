import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, sendsIn, type ActIntent } from 'midnight-identity/profile/request';
import { signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **A PROPOSAL IS WITHDRAWN FROM THE WALLET, ONE WINDOW, ONE PASSKEY.** The action runs whole: the shared code that
 * withdraws (`withdrawOnDevice`) is the real one, over a service and a chain stood in for here; only the opening of the
 * proposal from the company's sealed records is stood in for, by the record each case names (its kind, its identity, who
 * filed it), since what is opened from real records is pinned in packages/web-shared/src/the-device-proves-what-it-opened.test.ts.
 * What is pinned: a change to the company is withdrawn by the seat that raised it and refused to any other before any
 * build; a run by any seat before its time to be paid begins; a removal while every removal is otherwise refused; the
 * kinds the wallet never withdraws are refused with words that say why; the outcome is the chain's.
 */

const t = vi.hoisted(() => ({
  opened: null as null | Record<string, unknown>,
  chain: {} as Record<string, Record<string, unknown>>,
  served: {} as Record<string, unknown>,
  log: [] as string[],
  asked: [] as Array<string | undefined>,
  /* The time of the newest block at the indexer this wallet names, in milliseconds, or what its read throws. */
  tip: 0 as number | Error,
  /* What building the withdrawal throws, if anything. */
  buildFails: null as Error | null,
  /* What the service's cancel throws once it has been handed the proven call, if anything. */
  cancelFails: null as Error | null,
}));
vi.mock('../../../../packages/web-shared/src/round-opened-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/round-opened-here.js')>()),
  openTheRoundHere: async (_s: unknown, _a: string, id: string, _k: unknown, _r: boolean, _rec: unknown, _l: unknown, forAWithdrawal?: boolean) => {
    t.log.push(`open ${id}${forAWithdrawal === true ? ' for a withdrawal' : ''}`);
    return t.opened;
  },
}));

const withdrawModule = await import('./withdraw-proposal.js');
const { withdrawProposalAction } = withdrawModule;
const { KINDS_IN_THE_WALLET, NEVER_WITHDRAWN, neverWithdrawn } = await import('../../../../packages/web-shared/src/proposal-kinds-in-the-wallet.js');

const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const CHAIN_ID = 'dd'.repeat(32);
const SECRET = '01'.repeat(32);
const OWN = signingPublicKeyOf(SECRET as Hex).toLowerCase();
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
const BASE = { record: 'acc_1', company: LABEL, account: ACCOUNT, proposal: 'prp_1' };
const intent = (kind: string): ActIntent => ({ name: 'withdraw-proposal', fields: { ...BASE, kind } }) as ActIntent;
const NOW_MS = 1_900_000_000_000;
/* The leaf the company's directory shows retired, if any. */
let retired: string | null = null;

const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT,
  seat: { signerId: 's1', signingSecret: SECRET, wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: 'cc'.repeat(32) },
  leaf: 'a1'.repeat(32), companyKey: '11'.repeat(32), stepTo: () => {},
  api: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    t.log.push(`${method} ${path}${init?.body === undefined ? '' : ` ${init.body}`}`);
    if (path === '/api/proposals/prp_1/standing') return { id: 'prp_1', chainId: CHAIN_ID, status: 'open', ...t.served };
    if (path === '/api/proposals/prp_1/cancel') {
      /* The chain takes a proven withdrawal and no longer holds the proposal; one with no call changes only the records. */
      if ((JSON.parse(String(init?.body)) as { tx?: string }).tx !== undefined && t.cancelFails !== null) throw t.cancelFails;
      if ((JSON.parse(String(init?.body)) as { tx?: string }).tx !== undefined) t.chain[CHAIN_ID] = { held: 'closed', approvals: 0, raisedAt: 1, closedBy: ['cancel'] };
      return { id: 'prp_1', chainId: CHAIN_ID, status: 'cancelled' };
    }
    return [];
  },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({ seats: [], committee: [], approvals: 1, seatBar: 1, policyBar: null, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }),
  judges: {
    directoryHereFor: () => async () => ({ dir: { seats: retired === null ? [] : [{ seat: retired, retired: { at: 1 } }] }, records: { history: new Map() } }),
    filingJudgeFor: () => async () => null,
    leavesFor: () => async () => [],
  },
  sealed: {}, companyKeys: KEYS,
  roster: async () => ({ id: 'acc_1', name: 'Acme', notBelieved: [], signers: [] }),
  builder: {
    roundsOnChain: async ({ chainIds, seat }: { chainIds: string[]; seat?: string }) => {
      t.asked.push(seat);
      return Object.fromEntries(chainIds.map((id) => [id, t.chain[id] ?? { held: 'never', approvals: 0 }]));
    },
    accountPresence: async (input: { account: string; transactions: string[] }) => {
      t.log.push(`chain time for ${input.account}`);
      if (t.tip instanceof Error) throw t.tip;
      return { held: true, blockHeight: 9, blockTime: t.tip, ttl: null };
    },
    governedCall: async (input: { order: { circuit: string; proposal: string } }) => {
      t.log.push(`build ${input.order.circuit} ${input.order.proposal}`);
      if (t.buildFails !== null) throw t.buildFails;
      return { tx: 'TX' };
    },
  },
  chain: { indexer: {}, callState: async () => ({ blockHash: 'b', accountState: 'AS', parameters: 'PP' }) },
});
const ctxOf = (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, account: 0 }, at: { step: 2, steps: 2 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a withdrawal is sent through its calls, never a bare relay'); },
    call: async () => ({ status: 404, body: {} }),
    tell: (x: Record<string, unknown>) => { told.push(x); },
    keyring: { open: () => ({ read: () => ({ accounts: {} }) }), keep: async () => {} },
  } as unknown as StepContext;
  return { ctx, told };
};
const reach = () => ({
  chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, now: () => NOW_MS, secrets: () => ({}) as never,
  reachFor: async () => reachOf() as never,
});
const withdrawn = async (kind: string) => {
  const i = intent(kind);
  const def = withdrawProposalAction(reach());
  expect(await def.check(i, {} as never)).toBeNull();
  const { ctx, told } = ctxOf(i);
  for (const step of def.steps(i)) await step.run(ctx);
  return told;
};
const refusedWith = async (kind: string): Promise<StepRefused['words']> => {
  const i = intent(kind);
  const def = withdrawProposalAction(reach());
  const e = await (async () => { for (const step of def.steps(i)) await step.run(ctxOf(i).ctx); })().then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return (e as StepRefused).words;
};
const refusalOf = async (kind: string): Promise<string> => (await refusedWith(kind)).key;
const sent = () => t.log.filter((l) => l.startsWith('build') || l.startsWith('POST /api/proposals/prp_1/cancel'));
const opened = (kind: string, over: Record<string, unknown> = {}) => ({ chainId: CHAIN_ID, digest: '', vault: '', salt: '', summary: '', kind, ...over });
const held = (over: Record<string, unknown> = {}) => ({ held: 'open', approvals: 1, raisedAt: 1, ...over });

beforeEach(() => {
  t.opened = null;
  t.chain = {};
  t.served = { raisedAt: '2030-01-01T00:00:00.000Z', txRef: 'tx_1' };
  t.log.length = 0;
  t.asked.length = 0;
  t.tip = NOW_MS;
  t.buildFails = null;
  t.cancelFails = null;
  retired = null;
});

describe('A PROPOSAL IS WITHDRAWN FROM THE WALLET, AS THE CHAIN WOULD TAKE IT', () => {
  it('a change to the company is withdrawn by the seat that raised it, and a run by any seat before its time begins', async () => {
    t.opened = opened('set-threshold');
    t.chain[CHAIN_ID] = held({ raisedHere: true });
    /* RED WHEN: the raiser of a change to the company cannot withdraw it from the wallet, or the outcome is not the chain's. */
    expect(await withdrawn('threshold')).toEqual([{ state: 'withdrawn', proposal: 'prp_1' }]);
    expect(t.log).toContain('open prp_1 for a withdrawal');
    expect(sent()).toEqual([`build cancel ${CHAIN_ID}`, 'POST /api/proposals/prp_1/cancel {"tx":"TX","filer":"' + OWN + '"}']);
    /* RED WHEN: who raised it is read from the chain without this wallet's seat, so it is never said. */
    expect(t.asked.every((s) => s === SECRET)).toBe(true);

    t.log.length = 0;
    t.opened = opened('payroll');
    t.chain[CHAIN_ID] = held({ raisedHere: false, opensAt: NOW_MS / 1000 + 600 });
    /* RED WHEN: a run raised by another seat cannot be withdrawn before its window opens, as the chain allows. */
    expect(await withdrawn('payroll')).toEqual([{ state: 'withdrawn', proposal: 'prp_1' }]);
    expect(sent()).toHaveLength(2);
  });

  it('a vault\'s retire is withdrawn by the seat that raised it, so a retire nobody will approve does not stand open', async () => {
    t.opened = opened('retire-vault');
    t.chain[CHAIN_ID] = held({ raisedHere: true });
    /* RED WHEN: a retire cannot be withdrawn from the wallet, or is withdrawn under another kind than its record names. */
    expect(await withdrawn('retire-vault')).toEqual([{ state: 'withdrawn', proposal: 'prp_1' }]);
    expect(sent()).toEqual([`build cancel ${CHAIN_ID}`, 'POST /api/proposals/prp_1/cancel {"tx":"TX","filer":"' + OWN + '"}']);
  });

  it('a removal raised elsewhere can be withdrawn through the registered withdrawal', async () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost', origin: 'http://localhost' } });
    const { ACTIONS, actionFor } = await import('./registry.js').finally(() => vi.unstubAllGlobals());
    /* RED WHEN: the wallet registers no withdrawal, so a removal raised elsewhere stands stuck until its window passes. */
    expect(actionFor('withdraw-proposal')).toBe(ACTIONS['withdraw-proposal']);
    t.opened = opened('remove-signer');
    t.chain[CHAIN_ID] = held({ raisedHere: true });
    expect(await withdrawn('removal')).toEqual([{ state: 'withdrawn', proposal: 'prp_1' }]);
  });

  it('a seat that did not raise a change to the company is refused before any build, as is a run whose time has begun', async () => {
    t.opened = opened('set-vault-threshold');
    t.chain[CHAIN_ID] = held({ raisedHere: false });
    /* RED WHEN: a signer who did not raise a change builds a withdrawal the chain refuses. */
    expect(await refusalOf('vault-threshold')).toBe('act.withdraw-proposal.why.not-raised-here');
    t.opened = opened('payroll');
    t.chain[CHAIN_ID] = held({ raisedHere: true, opensAt: NOW_MS / 1000, needed: 2 });
    /* RED WHEN: a run whose window has opened is built into a withdrawal the chain refuses. */
    expect(await refusalOf('payroll')).toBe('act.withdraw-proposal.why.started');
    expect(sent()).toEqual([]);
  });

  it('a run\'s time to be paid is judged by the chain\'s newest block, and a run whose chain time is not read is refused with words', async () => {
    t.opened = opened('payroll');
    /* This wallet's clock says the run's time began ten minutes ago; the chain's newest block is an hour behind it. */
    t.chain[CHAIN_ID] = held({ raisedHere: true, opensAt: NOW_MS / 1000 - 600 });
    t.tip = NOW_MS - 3_600_000;
    /* RED WHEN: a run the chain still lets anyone withdraw is refused because this wallet's clock is ahead of the chain. */
    expect(await withdrawn('payroll')).toEqual([{ state: 'withdrawn', proposal: 'prp_1' }]);
    expect(t.log).toContain(`chain time for ${ACCOUNT}`);
    t.log.length = 0;
    /* This wallet's clock says the run's time begins in ten minutes; the chain's newest block is an hour ahead of it. */
    t.chain[CHAIN_ID] = held({ raisedHere: true, opensAt: NOW_MS / 1000 + 600, needed: 2 });
    t.tip = NOW_MS + 3_600_000;
    /* RED WHEN: a run whose time the chain has begun is built into a withdrawal the chain refuses, on this wallet's clock. */
    expect(await refusalOf('payroll')).toBe('act.withdraw-proposal.why.started');
    t.tip = new Error('the indexer answered 502.');
    /* RED WHEN: a run is withdrawn on this wallet's clock when the chain's time could not be read. */
    expect(await refusalOf('payroll')).toBe('act.withdraw-proposal.why.chain-time-not-read');
    expect(sent()).toEqual([]);
    expect(WORDS['act.withdraw-proposal.why.chain-time-not-read']).toMatch(/Nothing was signed or sent\.$/u);
  });

  it('a run whose time has begun is refused with words that say whether it can still be paid, and how it is stopped', async () => {
    t.opened = opened('payroll');
    t.chain[CHAIN_ID] = held({ raisedHere: true, opensAt: NOW_MS / 1000, approvals: 2, needed: 2 });
    /* RED WHEN: a run with every approval it was raised needing is told to be left unapproved, and is paid while the signer waits. */
    expect(await refusalOf('payroll')).toBe('act.withdraw-proposal.why.started-may-be-paid');
    expect(WORDS['act.withdraw-proposal.why.started-may-be-paid']).toMatch(/hold it/u);
    expect(WORDS['act.withdraw-proposal.why.started-may-be-paid']).not.toMatch(/leave it unapproved/iu);
    t.chain[CHAIN_ID] = { held: 'cleared', approvals: 2, raisedAt: 1, needed: 2, opensAt: NOW_MS / 1000 };
    /* RED WHEN: a run charged to its period is told it can still be stopped by not approving it, or by a hold. */
    expect(await refusalOf('payroll')).toBe('act.withdraw-proposal.why.started-charged');
    expect(WORDS['act.withdraw-proposal.why.started-charged']).not.toMatch(/unapproved|can still hold/iu);
    expect(sent()).toEqual([]);
  });

  it('a run the chain would still take a withdrawal of, refused by the build on this wallet\'s clock, is told as that clock being ahead', async () => {
    t.opened = opened('payroll');
    t.chain[CHAIN_ID] = held({ raisedHere: true, opensAt: NOW_MS / 1000 + 600 });
    t.buildFails = new Error('this withdrawal could not be built on this device: that run has already started; it can no longer be cancelled. Nothing was proved or sent.');
    /* RED WHEN: a run the chain would still take a withdrawal of is told as started by the build's own clock. */
    expect(await refusalOf('payroll')).toBe('act.withdraw-proposal.why.clock-ahead');
    expect(t.log.filter((l) => l.startsWith('POST /api/proposals/prp_1/cancel'))).toEqual([]);
    expect(WORDS['act.withdraw-proposal.why.clock-ahead']).toMatch(/clock/u);
  });

  it('a one-off the chain holds is refused with its words; one only written down by this seat is withdrawn with no call', async () => {
    t.opened = opened('transfer', { filedBy: OWN, raiseBy: String(NOW_MS / 1000) });
    t.chain[CHAIN_ID] = held({ raisedHere: true, opensAt: NOW_MS / 1000 + 600 });
    /* RED WHEN: a one-off the chain holds is offered a withdrawal the chain cannot take. */
    expect(await refusalOf('one-off')).toBe('act.withdraw-proposal.why.one-off-held');
    expect(sent()).toEqual([]);
    delete t.chain[CHAIN_ID];
    t.served = {};
    t.opened = opened('transfer', { filedBy: OWN, raiseBy: String(NOW_MS / 1000 + 3_600) });
    /* RED WHEN: a one-off the chain does not show is marked withdrawn while a raise of it may still land, or the words do not say until when. */
    expect(await refusedWith('one-off')).toEqual({
      key: 'act.withdraw-proposal.why.may-still-land', values: { until: new Date(NOW_MS + 3_600_000).toISOString() },
    });
    expect(sent()).toEqual([]);
    t.opened = opened('transfer', { filedBy: OWN, raiseBy: String(NOW_MS / 1000) });
    /* RED WHEN: a one-off the chain does not hold cannot be marked withdrawn, is withdrawn by a proven call, or is told withdrawn on the service's word. */
    expect(await withdrawn('one-off')).toEqual([{ state: 'records-withdrawn-not-on-chain', proposal: 'prp_1' }]);
    expect(sent()).toEqual([`POST /api/proposals/prp_1/cancel {"filer":"${OWN}"}`]);
  });

  it('a withdrawal that failed after the proven call was handed over says it may have been sent, and one that failed before says it was not', async () => {
    t.opened = opened('set-threshold');
    t.chain[CHAIN_ID] = held({ raisedHere: true });
    t.cancelFails = new Error('the connection dropped.');
    /* RED WHEN: a withdrawal that failed after the proven call was handed over is told as not withdrawn, so the signer sends it again. */
    expect(await refusedWith('threshold')).toEqual({ key: 'act.withdraw-proposal.why.may-be-sent', values: { says: 'the connection dropped' } });
    t.cancelFails = null;
    t.buildFails = new Error('the device could not build it.');
    /* RED WHEN: a withdrawal that failed before anything was handed over is told as possibly sent, so the signer waits on nothing. */
    expect(await refusedWith('threshold')).toEqual({ key: 'act.withdraw-proposal.why.not-withdrawn', values: { says: 'the device could not build it' } });
    expect(t.log.filter((l) => l.startsWith('POST /api/proposals/prp_1/cancel'))).toHaveLength(1);
  });

  it('a removal whose leaving seat is already written down as retired is refused with its words', async () => {
    t.opened = opened('remove-signer', { removes: 'a4'.repeat(32) });
    t.chain[CHAIN_ID] = held({ raisedHere: true });
    retired = 'a4'.repeat(32);
    /* RED WHEN: the wallet withdraws a removal whose retirement is filed, so the directory and the chain disagree for good. */
    expect(await refusalOf('removal')).toBe('act.withdraw-proposal.why.retirement-filed');
    expect(sent()).toEqual([]);
  });

  it('a proposal of another kind than the one shown, or of a vault\'s set-up whatever it is shown as, is refused', async () => {
    t.chain[CHAIN_ID] = held({ raisedHere: true });
    t.opened = opened('set-threshold');
    /* RED WHEN: the wallet withdraws a proposal of another kind than the one the person was shown. */
    expect(await refusalOf('vault-threshold')).toBe('act.withdraw-proposal.why.not-as-shown');
    t.opened = opened('adopt-vault');
    /* RED WHEN: a vault's adoption shown as another kind is withdrawn, and can then be raised again only into approvals it cannot count. */
    expect(await refusalOf('threshold')).toBe('act.withdraw-proposal.why.never-adopt-vault');
    expect(sent()).toEqual([]);
  });
});

describe('THE COMPANY\'S PAY-RECORD KEY IS WITHDRAWN ONLY ONCE A REMOVAL HAS OUTRUN IT', () => {
  it('a pay key the chain can still carry out is refused with its words and nothing sent; one a removal outran is withdrawn by its raiser', async () => {
    t.opened = opened('pay-key');
    t.chain[CHAIN_ID] = held({ raisedHere: true });
    /* RED WHEN: a pay key the chain can still carry out is withdrawn, so its approvals are spent and it can never be carried out. */
    expect(await refusalOf('pay-key')).toBe('act.withdraw-proposal.why.never-pay-key');
    expect(sent()).toEqual([]);
    expect(WORDS['act.withdraw-proposal.why.never-pay-key']).toMatch(/Nothing was signed or sent\.$/u);
    /* RED WHEN: the words promise that raising it again will pass, where a signer who approved it before cannot approve it again. */
    expect(WORDS['act.withdraw-proposal.why.never-pay-key']).toMatch(/a signer who approved it before cannot approve it again, so the new raise may never reach the approvals it needs/u);
    expect(WORDS['act.withdraw-proposal.why.never-pay-key']).not.toMatch(/afresh/u);
    t.chain[CHAIN_ID] = held({ raisedHere: true, outrun: true });
    /* RED WHEN: a pay key a removal outran cannot be withdrawn, so the company can never raise it again and finish. */
    expect(await withdrawn('pay-key')).toEqual([{ state: 'withdrawn', proposal: 'prp_1' }]);
    expect(sent()).toEqual([`build cancel ${CHAIN_ID}`, 'POST /api/proposals/prp_1/cancel {"tx":"TX","filer":"' + OWN + '"}']);
  });
});

describe('THE KINDS THE WALLET NEVER WITHDRAWS, AND WHAT THE ACTION ASKS THE PAGE FOR', () => {
  it.each([
    ['adopt-vault', 'never-adopt-vault'], ['vault-secret', 'never-vault-secret'], ['recovery', 'never-recovery'],
  ])('%s is refused before anything is opened, with words that say why', async (kind, key) => {
    const def = withdrawProposalAction(reach());
    /* RED WHEN: a kind the wallet never withdraws reaches a step, or is refused with no words of its own. */
    expect((await def.check(intent(kind), {} as never))?.key).toBe(`act.withdraw-proposal.why.${key}`);
    expect(def.steps(intent(kind))).toEqual([]);
    expect(WORDS[`act.withdraw-proposal.why.${key}`]).toMatch(/Nothing was signed or sent\.$/u);
  });

  it('the wallet refuses or sends a withdrawal by the one list of kinds the page offers Withdraw from', async () => {
    /* RED WHEN: the wallet keeps a list of kinds of its own beside the one the page reads. */
    expect('WITHDRAWN_KINDS' in withdrawModule).toBe(false);
    const def = withdrawProposalAction(reach());
    for (const [named, k] of Object.entries(KINDS_IN_THE_WALLET)) {
      const refused = await def.check(intent(named), {} as never);
      /* RED WHEN: the wallet refuses a kind the list says it withdraws, or lets through a kind it never withdraws. */
      expect(refused === null, named).toBe(!neverWithdrawn(k));
      /* RED WHEN: the page offers Withdraw on a kind the wallet refuses before it opens anything. */
      if (k.sealedAs !== undefined && neverWithdrawn(k)) expect(NEVER_WITHDRAWN.has(k.sealedAs), named).toBe(true);
    }
  });

  it('the withdrawal route is marked as sending only with a proven call, and every word the action uses is written', async () => {
    const route = routeOf(intentShapeOf('withdraw-proposal')!, 'POST', '/api/proposals/prp_1/cancel');
    /* RED WHEN: a withdrawal carrying a proven call is not counted as a send, or one with none is. */
    expect(route).toMatchObject({ sends: true, sendsWith: 'tx' });
    expect([sendsIn(route!, '{"tx":"TX","filer":"f"}'), sendsIn(route!, '{"filer":"f"}')]).toEqual([true, false]);
    const def = withdrawProposalAction(reach());
    const keys = [
      def.headline, ...(await def.shown(intent('threshold'))).map((l) => l.key), ...def.checks.map((c) => c.key),
      ...def.steps(intent('threshold')).map((s) => s.title.key),
      ...Object.values(KINDS_IN_THE_WALLET).flatMap((k) => (k.never === undefined ? [] : [`act.withdraw-proposal.why.${k.never}`])),
      ...['not-a-proposal', 'not-as-shown', 'one-off-held', 'never-pay-key', 'closed', 'started', 'sent-not-yet-seen', 'filed-by-another', 'not-raised-here',
        'raiser-not-read', 'chain-time-not-read', 'started-may-be-paid', 'started-charged', 'clock-ahead', 'may-still-land', 'retirement-filed', 'not-withdrawn', 'may-be-sent', 'not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain',
        'roster-not-opened'].map((k) => `act.withdraw-proposal.why.${k}`),
    ];
    for (const k of keys) expect(WORDS[k], k).toBeTypeOf('string');
  });
});

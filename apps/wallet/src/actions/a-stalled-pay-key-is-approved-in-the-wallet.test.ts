import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';
import { withCompanyKey } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import * as accountModule from '../../../../contracts/managed/contract/index.js';
import { newSigningKeypair, newWrappingKeypair, type Hex } from '../../../../src/core/crypto.js';
import { ADOPT_VAULT, newProposalId, PAY_KEY, PAY_KEY_SUMMARY, sealGovernanceProposal, signProposalFiling } from '../../../../src/core/proposal-filing.js';
import { payKeyRoundOf, type PayKeyPure } from '../../../../src/midnight/pay-key-round.js';
import { openSealedPayKey } from '../../../../src/midnight/pay-key-commitment.js';

/*
 * **A PAY-RECORD KEY THE FOUNDING SEAT CANNOT COMMIT ALONE IS APPROVED AND CARRIED OUT BY A SECOND SIGNER IN THE
 * WALLET.** The founding signer raised it beside its record when it finished the company; the company's bar is two, so
 * it stalled at one approval. A second signer approves it through the one approval and, once the chain counts two,
 * carries it out by sealing its own copy of the key. The shared reads that believe the record's filer, open the
 * company's signed first state and find a leaver's filing are stood in for here (they are followed in
 * governed-call-on-device.test.ts and run-rebuilt-here's tests); the record itself is sealed and opened for real, and the
 * proposal is made again with the account's own compiled functions.
 */

const t = vi.hoisted(() => ({
  state: { payKey: '' as string },
  leaver: null as Error | null,
  believed: null as Error | null,
}));
vi.mock('../../../../packages/web-shared/src/run-rebuilt-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/run-rebuilt-here.js')>()),
  signedStateHere: async () => ({ seeds: [], payKey: t.state.payKey, assetBlinding: 'ab'.repeat(32) }),
}));
vi.mock('../../../../packages/web-shared/src/round-opened-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/round-opened-here.js')>()),
  believedFilerHere: async () => { if (t.believed !== null) throw t.believed; return 'aa'.repeat(32); },
}));
vi.mock('../../../../packages/web-shared/src/governed-call-on-device.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/governed-call-on-device.js')>()),
  refuseARunALeaverRaisedHere: async () => { if (t.leaver !== null) throw t.leaver; },
}));
vi.mock('./upkeep.js', async (real) => {
  const actual = await real<typeof import('./upkeep.js')>();
  return {
    ...actual,
    upkeepSteps: (company: { reach: (c: unknown) => Promise<unknown>; renew: () => void }) => ({
      first: { title: { key: 'act.upkeep.step.first' }, run: async (c: unknown) => { await company.reach(c); company.renew(); } },
      last: { title: { key: 'act.upkeep.step.last' }, run: async (c: unknown) => { await company.reach(c); } },
    }),
  };
});

const { approveProposalAction } = await import('./approve-proposal.js');

const P = (accountModule as unknown as { pureCircuits: PayKeyPure }).pureCircuits;
const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const WIDE = 'cc'.repeat(32);
const COMPANY_KEY = '11'.repeat(32);
const KEY = '9a'.repeat(32) as Hex;
const ROUND = payKeyRoundOf(P, KEY);
const NO_VAULT = Buffer.from(P.noVault()).toString('hex');
const FOUNDER = newSigningKeypair();
const WRAPPING = newWrappingKeypair();
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const KEYS = { epoch: 0, key: COMPANY_KEY, newest: 0, keyAt: () => COMPANY_KEY, sealing: () => ({ key: COMPANY_KEY, epoch: 0 }) };
const intent = (proposal: string): ActIntent => ({
  name: 'approve-proposal', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT, proposal, kind: 'pay-key' },
}) as ActIntent;

/* The record of a proposal as the founding seat's device writes it down: sealed under the company's key, signed by that seat. */
const recordOf = (o: { kind?: string; key?: Hex } = {}) => {
  const round = payKeyRoundOf(P, o.key ?? KEY);
  const filing = signProposalFiling('acc_1', {
    id: newProposalId(), digest: round.payload as Hex, chainId: round.proposal as Hex, keyEpoch: 0, createdAt: new Date().toISOString(),
    sealed: sealGovernanceProposal(withCompanyKey({
      accountId: 'acc_1', kind: (o.kind ?? PAY_KEY) as typeof PAY_KEY, summary: PAY_KEY_SUMMARY, noVault: NO_VAULT as Hex,
      body: o.kind === ADOPT_VAULT ? { vault: 'ab'.repeat(32) as Hex } : { commitment: round.commitment as Hex },
      change: { asset: '00'.repeat(32), amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: round.salt as Hex }, proposedBy: 's1',
    }, COMPANY_KEY as Hex)),
  }, FOUNDER.secret as Hex);
  return { ...filing, accountId: 'acc_1', status: 'open', approvalCount: 0 };
};

let proposals: ReturnType<typeof recordOf>[];
let chain: Record<string, { held: string; approvals: number; needed: number; approvedHere?: boolean }>;
let called: string[];
let built: Array<{ order: any; opened: any; material: any }>;
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT,
  seat: { signerId: 's2', signingSecret: '01'.repeat(32), wrappingSecret: WRAPPING.secret, blinding: '03'.repeat(32), scope: WIDE },
  leaf: 'a2'.repeat(32), companyKey: COMPANY_KEY, stepTo: () => {},
  api: async (path: string, init?: RequestInit) => {
    const said = `${init?.method ?? 'GET'} ${path}`;
    called.push(said);
    if (said === 'GET /api/accounts/acc_1/proposals') return proposals;
    if (said === 'POST /api/accounts/acc_1/creation/pay-key') {
      /* The chain as the sent call leaves it: an approval counted as this seat's, or the proposal closed by the seal. */
      const { call } = JSON.parse(String(init!.body)) as { call: string };
      const c = chain[ROUND.proposal]!;
      chain[ROUND.proposal] = call === 'approve' ? { ...c, approvals: c.approvals + 1, approvedHere: true } : { ...c, held: 'closed' };
      return { txRef: 'r' };
    }
    throw new Error(`this test answers no ${said}`);
  },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({ seats: ['a1'.repeat(32), 'a2'.repeat(32)], committee: [], approvals: 2, seatBar: 2, policyBar: null, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }),
  judges: { directoryHereFor: () => async () => ({ dir: { seats: [] }, records: { history: new Map() } }), leavesFor: () => async () => [], rosterReadsFor: () => ({}) },
  sealed: {}, companyKeys: KEYS,
  roster: async () => ({ id: 'acc_1', name: 'Acme', notBelieved: [], signers: [] }),
  builder: {
    roundsOnChain: async ({ chainIds }: { chainIds: string[] }) => Object.fromEntries(chainIds.map((id) => [id, chain[id] ?? { held: 'never', approvals: 0 }])),
    governedCall: async (input: { order: any; opened: any; material: any }) => {
      built.push(input);
      return { tx: `VFgt${String(input.order.circuit).slice(0, 4)}` };
    },
  },
  chain: { indexer: {}, callState: async () => ({ blockHash: '00'.repeat(32), accountState: 'U1RBVEU=', parameters: 'UEFSQU1T' }) },
});
const ctxOf = (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_b',
    held: { identity, account: 0 }, at: { step: 3, steps: 5 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('the pay-record key is approved through its calls, never a bare relay'); },
    call: async () => ({ status: 404, body: {} }),
    tell: (x: Record<string, unknown>) => { told.push(x); },
    keyring: { open: () => ({ read: () => ({ accounts: {} }) }), keep: async () => {} },
  } as unknown as StepContext;
  return { ctx, told };
};
const reach = () => ({
  chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, now: () => 0, secrets: () => ({}) as never,
  commitments: async () => ({}) as never, reachFor: async () => reachOf() as never, payKeyPure: async () => P, everyMs: 1, waitMs: 3,
});
const run = async (i: ActIntent, ctx: StepContext): Promise<void> => {
  for (const step of approveProposalAction(reach() as never).steps(i)) await step.run(ctx);
};
const refusalOf = async (p: Promise<unknown>): Promise<{ key: string; says: string }> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return { key: (e as StepRefused).words.key, says: String((e as StepRefused).words.values?.['says'] ?? '') };
};
const sentHere = () => called.filter((c) => c.startsWith('POST'));

beforeEach(() => {
  t.state.payKey = KEY;
  t.leaver = null;
  t.believed = null;
  proposals = [recordOf()];
  chain = { [ROUND.proposal]: { held: 'open', approvals: 1, needed: 2, approvedHere: false } };
  called = [];
  built = [];
});

describe('A STALLED PAY-RECORD KEY IS APPROVED AND COMMITTED BY A SECOND SIGNER IN THE WALLET', () => {
  it('a second signer approves it through the one approval, and a step of its own commits the key once the chain counts two', async () => {
    const i = intent(proposals[0]!.id);
    const { ctx, told } = ctxOf(i);
    await run(i, ctx);
    /* RED WHEN: the approval and the seal are not each built with this seat's own material and sent to the creation's route, in that order. */
    expect(built.map((b) => b.order.circuit)).toEqual(['approve', 'sealPayKey']);
    for (const b of built) expect(b.material.signingSecret).toBe('01'.repeat(32));
    expect(sentHere()).toEqual(['POST /api/accounts/acc_1/creation/pay-key', 'POST /api/accounts/acc_1/creation/pay-key']);
    /* RED WHEN: the proposal approved or committed is not the one the wallet made from the key the company's signed first state holds. */
    for (const b of built) {
      expect(b.opened).toMatchObject({ chainId: ROUND.proposal, digest: ROUND.payload, salt: ROUND.salt, vault: NO_VAULT, governance: { kind: 'pay-key', commitment: ROUND.commitment } });
    }
    expect(built[0]!.order).toEqual({ circuit: 'approve', proposal: ROUND.proposal, of: { governance: { kind: 'pay-key', commitment: ROUND.commitment }, proposalSalt: ROUND.salt } });
    /* RED WHEN: the copy sealed is not the key the approvers saw, sealed to this seat's own wrapping key. */
    expect(built[1]!.order).toMatchObject({ circuit: 'sealPayKey', commitment: ROUND.commitment, proposal: ROUND.proposal, proposalSalt: ROUND.salt });
    expect(openSealedPayKey(built[1]!.order.wrap, WRAPPING.secret as Hex, ROUND.commitment)).toBe(KEY);
    /* RED WHEN: the page is told the key was committed without the approvals and the bar the chain showed. */
    expect(told).toContainEqual({ state: 'carried-out', approvals: 2, needed: 2 });
  });

  it('approving files no record and raises nothing: it reads the company\'s proposals and sends its own two calls, nothing more', async () => {
    const i = intent(proposals[0]!.id);
    await run(i, ctxOf(i).ctx);
    /* RED WHEN: approving the pay-record key writes down a record, a version of one, or a raise. */
    expect(called.filter((c) => !c.startsWith('GET /api/accounts/acc_1/proposals'))).toEqual([
      'POST /api/accounts/acc_1/creation/pay-key', 'POST /api/accounts/acc_1/creation/pay-key',
    ]);
    expect(built.some((b) => b.order.circuit === 'propose')).toBe(false);
  });

  it('a seat whose approval the chain already counts sends no second one, and the key waits for the others', async () => {
    chain[ROUND.proposal] = { held: 'open', approvals: 1, needed: 2, approvedHere: true };
    const i = intent(proposals[0]!.id);
    const { ctx, told } = ctxOf(i);
    await run(i, ctx);
    /* RED WHEN: an approval is built or sent for a seat the chain already counts, or the key is committed short of its bar. */
    expect(built).toEqual([]);
    expect(sentHere()).toEqual([]);
    expect(told).toContainEqual({ state: 'waiting-for-approvals', approvals: 1, needed: 2 });
  });

  it('a record that commits another key than the company\'s signed first state holds is refused before anything is built', async () => {
    proposals = [recordOf({ key: '7b'.repeat(32) as Hex })];
    const i = intent(proposals[0]!.id);
    const refused = await refusalOf(run(i, ctxOf(i).ctx));
    /* RED WHEN: the wallet approves a pay-record key on the record's word, not on the key the company was founded with. */
    expect(refused.key).toBe('act.approve-pay-key.why.not-as-held');
    expect(built).toEqual([]);
    expect(sentHere()).toEqual([]);
  });

  it('a record of another kind under that name, or none, is refused before anything is built', async () => {
    for (const held of [[recordOf({ kind: ADOPT_VAULT })], []]) {
      proposals = held;
      const i = intent(held[0]?.id ?? 'prp_NotThereAtAll');
      /* RED WHEN: something other than the pay-record key's proposal is approved as it. */
      expect((await refusalOf(run(i, ctxOf(i).ctx))).key).toBe('act.approve-pay-key.why.not-a-pay-key');
    }
    expect(built).toEqual([]);
  });

  it('a record this wallet does not believe, or one a signer on their way out filed, is refused before anything is built', async () => {
    t.believed = new Error('This device does not believe the company\'s record of this proposal.');
    const i = intent(proposals[0]!.id);
    /* RED WHEN: a record nobody this device believes wrote down is approved. */
    expect(await refusalOf(run(i, ctxOf(i).ctx))).toMatchObject({ key: 'act.approve-pay-key.why.not-approved', says: expect.stringMatching(/does not believe/u) });
    t.believed = null;
    t.leaver = new Error('a signer whose removal is raised filed it.');
    /* RED WHEN: a proposal a leaver filed is approved or carried out. */
    expect(await refusalOf(run(i, ctxOf(i).ctx))).toMatchObject({ key: 'act.approve-pay-key.why.not-approved', says: expect.stringMatching(/removal is raised/u) });
    expect(built).toEqual([]);
  });

  it('a proposal the chain has closed or never raised is not approved, and nothing is sent', async () => {
    const i = intent(proposals[0]!.id);
    chain[ROUND.proposal] = { held: 'closed', approvals: 2, needed: 2 };
    /* RED WHEN: an approval is counted toward a proposal the chain no longer holds open. */
    expect((await refusalOf(run(i, ctxOf(i).ctx))).key).toBe('act.approve-pay-key.why.carried-out');
    delete chain[ROUND.proposal];
    expect((await refusalOf(run(i, ctxOf(i).ctx))).key).toBe('act.approve-pay-key.why.not-raised');
    expect(built).toEqual([]);
  });

  it('every word the kind can say is in the wallet\'s language file', () => {
    const keys = ['shown.proposal', 'shown.checks', 'shown.approve', 'step.carry', ...['not-a-pay-key', 'not-as-held', 'not-raised', 'not-approved',
      'not-carried', 'may-be-sent', 'withdrawn', 'carried-out', 'already-counted', 'outrun'].map((k) => `why.${k}`)];
    /* RED WHEN: the window would show a key in place of words. */
    expect(keys.filter((k) => typeof WORDS[`act.approve-pay-key.${k}`] !== 'string')).toEqual([]);
  });
});

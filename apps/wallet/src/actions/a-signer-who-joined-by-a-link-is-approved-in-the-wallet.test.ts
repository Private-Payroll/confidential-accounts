import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActIntent } from 'midnight-identity/profile/request';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import { StepRefused, type Held, type StepContext, type Words } from './definition.js';

/*
 * **A SIGNER WHO JOINED BY A LINK IS APPROVED IN THE WALLET, ON THE FINGERPRINT THE PERSON CONFIRMED.** A proposal the
 * page names by the leaf of the person waiting is opened in the first step, before anything is sent, and the window
 * asks the person to confirm the fingerprint of the keys it seats against the one the person waiting reads out; that
 * same fingerprint is what the approval is held to, and the shared code holds the proposal to the address the person's
 * own wallet signed. What the act asks of the shared code (`seatByLeafToConfirmHere` and
 * `approveSeatByLeafOnDevice`, followed end to end against the service and the chain in
 * a-signer-who-joined-by-a-link-is-approved-from-a-second-seat.test.ts) is pinned here.
 */

const t = vi.hoisted(() => ({
  calls: [] as string[],
  read: null as null | ((...a: unknown[]) => Promise<unknown>),
  asked: [] as unknown[],
}));
vi.mock('../../../../packages/web-shared/src/signer-by-link.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/signer-by-link.js')>()),
  seatByLeafToConfirmHere: async (...a: unknown[]) => { t.calls.push('read'); return t.read!(...a); },
  approveSeatByLeafOnDevice: async (...a: unknown[]) => { t.calls.push('approve'); t.asked = a; return { state: 'waiting-for-the-invitee', round: null }; },
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

const { approveProposalAction } = await import('./approve-proposal.js');
const { InvitationNotBound } = await import('../../../../packages/web-shared/src/governed-call-on-device.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const HELD: Held = { identity, secret };
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const LEAF = 'ee'.repeat(32);
const CHAIN_ID = 'dd'.repeat(32);
const FINGERPRINT = 'k7q2-m9x4-p3w8';
/** The rights the filed invitation names: not every vault, so the window must show them as named. */
const ONE_VAULT = '09'.repeat(32);
const BY_LEAF = { record: 'acc_1', company: LABEL, account: ACCOUNT, proposal: 'prp_abcdefghijkl', kind: 'add-signer', personName: 'Dee', role: 'approver', leaf: LEAF };
const intent = (fields: Record<string, string>): ActIntent => ({ name: 'approve-proposal', fields }) as ActIntent;
const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };
/** What the shared code reads of the proposal named: by default the one the window shows, for Dee's leaf, as an approver. */
const filedAs = (terms: Record<string, unknown> = {}) => async () => ({
  proposal: {
    chainId: CHAIN_ID, signerId: 'sgn_dee', proposalSalt: '0a'.repeat(32),
    invited: { terms: { name: 'Dee', role: 'approver', leaf: LEAF, invite: { address: 'ad'.repeat(32), salt: '5a'.repeat(32), scope: ONE_VAULT }, ...terms } },
  },
  fingerprint: FINGERPRINT,
});
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '33'.repeat(32) },
  leaf: 'aa'.repeat(32), companyKey: '11'.repeat(32), stepTo: () => {},
  api: async () => [], send: async () => ({ status: 404, body: {} }),
  holders: async () => ({ seats: ['aa'.repeat(32)], committee: [], threshold: 1, approvals: 1, seatBar: 2, policyBar: null, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }),
  judges: {
    directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null, records: { history: new Map() } }),
    filingJudgeFor: () => async () => null, leavesFor: () => async () => [],
    rosterReadsFor: () => ({ filings: async () => [], holders: async () => ({ seats: [] }), anchored: async () => ({}), leaves: async () => [], invitedSeats: async () => ({}) }),
  },
  sealed: {}, companyKeys: KEYS,
  roster: async () => ({ id: 'acc_1', name: 'Acme', signers: [], notBelieved: [] }),
  builder: { roundsOnChain: async ({ chainIds }: { chainIds: string[] }) => Object.fromEntries(chainIds.map((id) => [id, {
    held: 'open', approvals: t.calls.includes('approve') ? 2 : 1, needed: 2, raisedAt: 1 }])), companyWide: async () => 'cc'.repeat(32), runsOutrun: async () => ({}) },
  chain: { indexer: {}, callState: async () => ({ blockHash: 'b'.repeat(64), accountState: 'AS', parameters: 'PP' }) },
});
const reach = () => ({
  chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, now: () => 0, secrets: () => ({}) as never,
  commitments: async () => MidnightCommitments as never, reachFor: async () => reachOf() as never,
  afterCarried: async (): Promise<never> => { throw new Error('no removal is carried out here'); },
});
const ctxOf = (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const confirmed: Array<readonly Words[]> = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret, account: 0 }, at: { step: 1, steps: 4 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('an approval is sent through its calls, never a bare relay'); },
    call: async () => ({ status: 404, body: {} }), tell: (x: Record<string, unknown>) => { told.push(x); },
    confirm: async (lines: readonly Words[]) => { t.calls.push('confirm'); confirmed.push(lines); },
    keyring: { open: () => ({ read: () => ({ accounts: {} }) }), keep: async () => {} },
  } as unknown as StepContext;
  return { ctx, told, confirmed };
};
const run = async (i: ActIntent, ctx: StepContext): Promise<void> => {
  for (const step of approveProposalAction(reach()).steps(i)) await step.run(ctx);
};
const refusedWith = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return (e as StepRefused).words.key;
};

beforeEach(() => {
  t.calls.length = 0;
  t.asked = [];
  t.read = filedAs();
});

describe('A SIGNER WHO JOINED BY A LINK IS APPROVED IN THE WALLET, ON THE FINGERPRINT THE PERSON CONFIRMED', () => {
  it('the fingerprint of the keys the proposal seats is confirmed before anything is sent, and the approval is held to it', async () => {
    const { ctx, confirmed, told } = ctxOf(intent(BY_LEAF));
    await run(intent(BY_LEAF), ctx);
    /* RED WHEN: anything is sent before the person has confirmed the fingerprint of the keys the proposal seats. */
    expect(t.calls).toEqual(['read', 'confirm', 'upkeep-first', 'approve', 'upkeep-last']);
    /* RED WHEN: the window does not ask the person to compare the fingerprint of the keys it seats, for the person named. */
    expect(confirmed).toEqual([[
      /* RED WHEN: the person approves a seat without seeing the rights it carries, as the proposal itself names them. */
      { key: 'act.approve-proposal.shown.scope', values: { scope: ONE_VAULT } },
      { key: 'act.approve-proposal.confirm.fingerprint', values: { name: 'Dee', fingerprint: FINGERPRINT } },
    ]]);
    /* RED WHEN: the approval is held to another fingerprint than the one confirmed, another proposal, or keys other than the wallet's own. */
    expect(t.asked[1]).toMatchObject({ proposal: BY_LEAF.proposal, readOut: FINGERPRINT });
    /* RED WHEN: the approval is not handed the account's own function to work the signed address out again from its coin key. */
    const made = (t.asked[1] as { inviteAddressOf?: (c: string, salt: string) => string }).inviteAddressOf;
    expect(made?.('aa'.repeat(32), 'bb'.repeat(32))).toBe(MidnightCommitments.inviteAddressOf('aa'.repeat(32), 'bb'.repeat(32)));
    expect(Object.values(t.asked[1] as object)).toContain(KEYS);
    expect(told).toContainEqual({ state: 'waiting-for-the-invitee', approvals: 2, needed: 2 });
  });

  it.each([
    ['another person', { name: 'Mallory' }],
    ['another role', { role: 'admin' }],
    ['another leaf', { leaf: 'ab'.repeat(32) }],
  ])('a proposal that seats %s than the window shows is refused before the person is asked to confirm it', async (_what, terms) => {
    t.read = filedAs(terms);
    const { ctx, confirmed } = ctxOf(intent(BY_LEAF));
    /* RED WHEN: the person confirms a fingerprint for a proposal that seats somebody, or at a role, other than the window showed. */
    expect(await refusedWith(run(intent(BY_LEAF), ctx))).toBe('act.approve-proposal.why.not-approved');
    expect(confirmed).toEqual([]);
    expect(t.calls).not.toContain('approve');
  });

  it('a proposal the shared code will not open as one to seat a leaf is refused with its words, and nothing is approved', async () => {
    t.read = async () => { throw new InvitationNotBound('The company holds no proposal to seat a person who joined by a link or a code under that name.'); };
    const { ctx } = ctxOf(intent(BY_LEAF));
    const e = await run(intent(BY_LEAF), ctx).then(() => null, (x: unknown) => x);
    /* RED WHEN: a proposal that does not open as one to seat a leaf stops the window without words that say why. */
    expect(e).toBeInstanceOf(StepRefused);
    expect((e as StepRefused).words).toMatchObject({ key: 'act.approve-proposal.why.not-approved', values: { says: expect.stringMatching(/no proposal to seat a person/u) } });
    expect(t.calls).toEqual(['read']);
  });

  it('a proposal naming an address the person\'s own wallet did not sign is refused with the shared code\'s words, before the person confirms', async () => {
    t.read = async () => { throw new InvitationNotBound('The address this proposal would seat is not the one the person waiting signed with their own wallet.'); };
    const { ctx, confirmed } = ctxOf(intent(BY_LEAF));
    const e = await run(intent(BY_LEAF), ctx).then(() => null, (x: unknown) => x);
    /* RED WHEN: a proposal that would seat whoever holds another address reaches the person's Confirm, or stops without saying why. */
    expect((e as StepRefused).words).toMatchObject({ key: 'act.approve-proposal.why.not-approved', values: { says: expect.stringMatching(/signed with their own wallet/u) } });
    expect(confirmed).toEqual([]);
    expect(t.calls).toEqual(['read']);
  });

  it('a seat whose proposal names every vault is confirmed as one on every vault, whatever the page says', async () => {
    t.read = filedAs({ invite: { address: 'ad'.repeat(32), salt: '5a'.repeat(32), scope: MidnightCommitments.allVaults() } });
    const { ctx, confirmed } = ctxOf(intent({ ...BY_LEAF, scope: ONE_VAULT }));
    await run(intent({ ...BY_LEAF, scope: ONE_VAULT }), ctx);
    /* RED WHEN: the rights the person confirms are read from the page and not from the proposal's own invitation. */
    expect(confirmed[0]![0]).toEqual({ key: 'act.approve-proposal.shown.every-vault' });
  });

  it('a seat named by its leaf needs no address, and a seat added by address still needs its address, rights and coin key', async () => {
    const a = approveProposalAction(reach());
    /* RED WHEN: the page cannot ask for a seat named by its leaf, or can ask for a seat by address without what it commits to. */
    expect(await a.check(intent(BY_LEAF), HELD)).toBeNull();
    const { leaf: _leaf, ...noLeaf } = BY_LEAF;
    expect((await a.check(intent({ ...noLeaf, address: 'aa'.repeat(32), scope: '33'.repeat(32) }), HELD))?.key).toBe('act.approve-proposal.why.not-a-proposal');
  });

  it('the window shows who and the role, and says nothing of an address, a coin key or checks a seat named by its leaf does not make; every line has words', async () => {
    const a = approveProposalAction(reach());
    const keys = (await a.shown(intent(BY_LEAF))).map((l) => l.key);
    /* RED WHEN: the window for a seat named by its leaf shows lines about an address or a coin key it never checks. */
    expect(keys.filter((k) => /address|coin-key|shown\.checks|scope|threshold/u.test(k))).toEqual([]);
    expect(keys).toEqual(expect.arrayContaining(['act.approve-proposal.shown.name', 'act.approve-proposal.shown.role.approver', 'act.approve-proposal.shown.approve']));
    /* RED WHEN: a line or the fingerprint the person confirms has no words, and the person is shown a key. */
    expect([...keys, 'act.approve-proposal.confirm.fingerprint', 'act.approve-proposal.step.seat-and-confirm'].filter((k) => WORDS[k] === undefined)).toEqual([]);
    expect(a.steps(intent(BY_LEAF))[0]!.title.key).toBe('act.approve-proposal.step.seat-and-confirm');
  });
});

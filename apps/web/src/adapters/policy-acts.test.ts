// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Asset, AssetRegistry } from '../../../../src/core/assets.js';
import { ACT_REFUSAL } from './refusals.js';
import policyWords from '../locales/pages/policies/en.json';

/*
 * THE POLICIES PAGE'S ASKS OF THE WALLET AND ITS READ OF THE COMPANY'S SPENDING POLICIES: what is read and with what, what is
 * sent for a new policy, an edited policy and a bar, what the page refuses before it asks, and what the wallet's stops come to.
 * The keyring, the wallet and the shared policy reader are stood in for; the page's own choices are the product's.
 */
const VAULT = 'ab'.repeat(32);
const ACCOUNT = 'c0'.repeat(32);
const kr = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null, acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown,
  named: { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) } as unknown, calls: 0,
  seat: null as unknown, seatAsked: [] as unknown[][], reach: null as Record<string, unknown> | null,
  held: new Map<string, unknown>(), holders: null as unknown, holdersAsked: [] as Record<string, unknown>[], holdersFail: null as Error | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => kr.named,
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => { kr.calls += 1; kr.acts.push(intent); return kr.ended; },
  holdersFromTheWallet: async (_origin: string, ask: Record<string, unknown>) => {
    kr.holdersAsked.push(ask);
    if (kr.holdersFail !== null) throw kr.holdersFail;
    return { holders: kr.holders, roles: [{ key: 'aa', value: null }], indexer: null };
  },
}));
vi.mock('./vault-private-money.js', async (real) => ({
  ...(await real<typeof import('./vault-private-money.js')>()),
  seatAndRecordsHere: async (...asked: unknown[]) => { kr.seatAsked.push(asked); return kr.seat; },
}));
vi.mock('vaults-web-shared/spending-policies-reach.js', () => ({
  spendingPoliciesFor: (reach: Record<string, unknown>) => { kr.reach = reach; return { stoodIn: true }; },
}));
vi.mock('vaults-web-shared/spending-policy-here.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/spending-policy-here.js')>()),
  spendingPolicyHere: async (_doors: unknown, input: { vault: string; asset: string }) => {
    const found = kr.held.get(input.asset);
    if (found instanceof Error) throw found;
    return found ?? { state: 'none' };
  },
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./policy-acts.js');
}

const asset = (code: string, symbol: string): Asset => ({ code, symbol, name: symbol, decimals: 6, ledger: { shielded: code, unshielded: null }, enabled: true, sortOrder: 1 });
const A1 = asset('a1'.repeat(32), 'AAA');
const A2 = asset('a2'.repeat(32), 'BBB');
const A3 = asset('a3'.repeat(32), 'CCC');
const REGISTRY: AssetRegistry = {
  all: () => [A1, A2, A3], enabled: () => [A1, A2, A3], find: (c) => [A1, A2, A3].find((a) => a.code === c) ?? null,
  require: (c) => { const a = [A1, A2, A3].find((x) => x.code === c); if (a === undefined) throw new Error('no asset'); return a; },
};
const HERE = {
  company: 'label-1', account: ACCOUNT, companyKey: 'dd'.repeat(32), leaf: 'ee'.repeat(32), viewingKey: { epochs: {} },
  builder: { spendingPolicyKeys: async () => ({}) }, directory: async () => ({}), records: () => ({}),
};
const TERMS = { bands: [{ ceiling: 100n, approvals: 1n }, { ceiling: 1000n, approvals: 2n }, { ceiling: 5000n, approvals: 3n }, { ceiling: 99999n, approvals: 4n }], periodLimit: 20_000n, periodStart: 5n, periodLength: 604_800n };
const HOLDERS = { approvals: 2, vaultThresholds: [], policyBar: 3, seatBar: 3, seats: ['s1', 's2', 's3', 's4'] };
const stopped = (refused?: string) => ({ of: 'stopped', step: 3, steps: 4, relayed: 0, unconfirmed: 0, why: refused === undefined ? 'relay-refused' : 'check-failed', ...(refused === undefined ? {} : { refused }) });
const NEW_POLICY = {
  vault: VAULT, token: A1.code, limit: '0.02', periodLength: 604_800n,
  bands: [{ ceiling: '0.0001', approvals: 1 }, { ceiling: '0.001', approvals: 2 }, { ceiling: '0.005', approvals: 3 }, { ceiling: '0.099999', approvals: 4 }],
};
const EDITED = { periodStart: 5n };

describe('reading the company\'s spending policies', () => {
  /* RED WHEN: a read of the policies opens a wallet window to release the company key itself, or reads on with no key released and shows a vault as having no policy. */
  it('refuses with no keys here before the company key is released, and never asks the wallet to release it', async () => {
    const m = await load();
    kr.seat = ACT_REFUSAL.noKeysHere; kr.seatAsked = [];
    expect(await m.readPolicies('u1', 'acc_Company00001', [VAULT], REGISTRY)).toEqual({ of: m.POLICIES_READ.refused, why: ACT_REFUSAL.noKeysHere });
    expect(kr.seatAsked).toEqual([['u1', 'acc_Company00001']]);
  });

  /* RED WHEN: the page reads a policy with a file door (so a read could file a record), or with another seat, key or company than the wallet released for this signer. */
  it('reads each vault and currency through the shared reader with this seat and key, and no file door', async () => {
    const m = await load();
    kr.seat = HERE; kr.holdersAsked = [];
    kr.held = new Map<string, unknown>([
      [A1.code, { state: 'set', policy: { terms: TERMS, blinding: new Uint8Array(32) }, version: 3 }],
      [A2.code, { state: 'not-for-this-currency' }],
      [A3.code, new Error('not opened here')],
    ]);
    const read = await m.readPolicies('u1', 'acc_Company00001', [VAULT], REGISTRY);
    if (read.of !== m.POLICIES_READ.read) throw new Error('the policies were not read');
    expect(read.held.map((h) => [h.vault, h.token, h.of])).toEqual([[VAULT, A1.code, 'set'], [VAULT, A2.code, 'not-for-this-currency'], [VAULT, A3.code, 'unread']]);
    const set = read.held[0]!;
    if (set.of !== m.POLICY_HELD.set) throw new Error('the first policy was not read as set');
    /* RED WHEN: a band's ceiling or the limit is shown in another currency's decimals, or a band's approvals are not the ones the policy holds. */
    expect(set.terms.bands.map((b) => [b.ceilingText, b.approvals])).toEqual([['0.000100', 1], ['0.001000', 2], ['0.005000', 3], ['0.099999', 4]]);
    expect([set.terms.limitText, set.terms.periodStart, set.terms.periodLength, set.terms.version]).toEqual(['0.020000', 5n, 604_800n, 3]);
    const reach = kr.reach!;
    expect([reach['accountId'], reach['leaf'], reach['companyKey']]).toEqual(['acc_Company00001', HERE.leaf, HERE.companyKey]);
    expect(Object.keys(reach)).not.toContain('file');
    /* RED WHEN: the entries of the chain a policy read asks about are asked of anything but the person's own wallet, for this company. */
    expect(await (reach['roles'] as (r: string[]) => Promise<unknown>)(['aa'])).toEqual({ roles: [{ key: 'aa', value: null }] });
    expect(kr.holdersAsked).toEqual([{ company: 'label-1', account: ACCOUNT, roles: ['aa'] }]);
  });

  /* RED WHEN: a wallet that cannot be asked who holds the company is shown as holders that were read, or the seated count is taken from anything but the seats the account holds now. */
  it('gives what the account holds as what a change is costed from, with the seats it has now counted', async () => {
    const m = await load();
    kr.holders = HOLDERS; kr.holdersFail = null;
    expect(await m.readHolders('u1', 'acc_Company00001')).toEqual({ of: 'read', value: { approvals: 2, vaultThresholds: [], policyBar: 3, seatBar: 3, seated: 4 } });
    kr.holdersFail = new Error('closed');
    expect(await m.readHolders('u1', 'acc_Company00001')).toEqual({ of: 'unreadable' });
    kr.holdersFail = null;
  });
});

describe('what the wallet\'s refusals come to on the page', () => {
  const CODES: readonly (readonly [string, string, boolean])[] = [
    ['act.set-spending-policy.why.not-a-company', 'seat', false], ['act.set-policy-bar.why.no-saved-keys', 'seat', false], ['act.set-policy-bar.why.roster-not-opened', 'seat', false],
    ['act.set-spending-policy.why.may-not-set', 'may-not-set', false],
    ['act.set-spending-policy.why.may-not-set-after-filing', 'may-not-set-after-filing', false],
    ['act.set-spending-policy.why.may-not-set-after-sending', 'may-not-set-after-sending', true],
    ['act.set-spending-policy.why.seat-not-in-directory', 'seat-not-in-directory', false], ['act.set-spending-policy.why.seat-not-believed', 'seat-not-believed', false],
    ['act.set-spending-policy.why.not-adopted', 'not-adopted', false], ['act.set-spending-policy.why.not-a-policy', 'not-a-policy', false],
    ['act.set-spending-policy.why.not-a-known-currency', 'not-a-currency', false], ['act.set-policy-bar.why.not-a-bar', 'not-a-bar', false],
    ['act.set-policy-bar.why.too-many', 'too-many', false], ['act.set-policy-bar.why.refused', 'refused', false], ['act.set-spending-policy.why.not-raised', 'not-raised', false],
    ['act.set-spending-policy.why.may-be-sent', 'may-be-sent', true], ['act.set-spending-policy.why.raised-not-read', 'raised-not-read', true],
    ['act.approve-policy.why.not-approved', 'not-approved', false], ['act.approve-policy.why.not-carried', 'not-carried', true], ['act.approve-policy.why.withdrawn', 'withdrawn', false],
    ['act.approve-policy.why.carried-out', 'carried-out', false], ['act.approve-policy.why.already-counted', 'already-counted', false], ['act.approve-policy.why.outrun', 'outrun', false],
    ['act.approve-policy.why.not-as-shown', 'not-as-shown', false],
  ];

  /* RED WHEN: a refusal of the set acts or their carry is told as another reason, or a stop that may have gone part of the way is told as one that sent nothing. */
  it('maps each code the wallet\'s acts can stop with to its own reason, and says which may have gone part of the way', async () => {
    const m = await load();
    kr.named = { companyLabel: 'label-1', contractAddress: ACCOUNT };
    for (const [code, why, partial] of CODES) {
      kr.ended = stopped(code);
      expect(await m.raisePolicyBar('u1', 'acc_Company00001', 3, { policyBar: 2, seated: 4 }), code).toEqual({ of: 'stopped', why, partial, handedOver: false });
    }
    kr.ended = stopped(undefined);
    expect(await m.raisePolicyBar('u1', 'acc_Company00001', 3, { policyBar: 2, seated: 4 })).toMatchObject({ why: 'stopped' });
    kr.ended = stopped('act.set-policy-bar.why.something-new');
    expect(await m.raisePolicyBar('u1', 'acc_Company00001', 3, { policyBar: 2, seated: 4 })).toMatchObject({ why: 'other' });
    /* RED WHEN: a code of another act is taken for one of the policy acts' reasons. */
    kr.ended = stopped('act.invite.why.may-not-set');
    expect(await m.raisePolicyBar('u1', 'acc_Company00001', 3, { policyBar: 2, seated: 4 })).toMatchObject({ why: 'other' });
    kr.ended = { of: 'stopped', step: 3, steps: 4, relayed: 1, unconfirmed: 0, why: 'went-quiet' };
    expect(await m.raisePolicyBar('u1', 'acc_Company00001', 3, { policyBar: 2, seated: 4 })).toMatchObject({ handedOver: true });
  });

  /* RED WHEN: a reason the page can show has no words of its own, or the refusal of a seat that may not set policies says anything but that the wallet will not, or names a role. */
  it('has words for every reason, and says the wallet will not rather than who may', async () => {
    const m = await load();
    const words: Record<string, string> = policyWords;
    const keys = Object.values(m.POLICY_WHY).map((code) => `policies.why.${code}`);
    for (const key of keys) expect(typeof words[key], key).toBe('string');
    expect(Object.keys(words).filter((k) => k.startsWith('policies.why.')).sort()).toEqual(keys.sort());
    const says = words['policies.why.may-not-set']!;
    expect(says).toMatch(/^Your wallet will not set a spending policy from your seat/u);
    for (const text of Object.values(words)) expect(text).not.toMatch(/\bonly\b[^.]*\b(admin|owner|founder)/iu);
  });
});

describe('a change of the approvals a policy change needs', () => {
  /* RED WHEN: a bar above the signers seated now, a bar that is not whole, or one already in force reaches the wallet, or the problem says another number than the seated count. */
  it('refuses on the page a bar above the seated count, a number that is not whole, or the same bar, and asks the wallet nothing', async () => {
    const m = await load();
    kr.calls = 0;
    expect(await m.raisePolicyBar('u1', 'acc_Company00001', 5, { policyBar: 3, seated: 4 })).toEqual({ of: 'problem', problem: 'too-high', most: 4 });
    expect(await m.raisePolicyBar('u1', 'acc_Company00001', 0, { policyBar: 3, seated: 4 })).toEqual({ of: 'problem', problem: 'not-whole' });
    expect(await m.raisePolicyBar('u1', 'acc_Company00001', 3, { policyBar: 3, seated: 4 })).toEqual({ of: 'problem', problem: 'same' });
    expect(await m.raisePolicyBar('u1', 'acc_Company00001', 2, { policyBar: 3, seated: null })).toEqual({ of: 'problem', problem: 'unread' });
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: a bar at the seated count is refused, or the wallet is asked for another bar, company or record than the one chosen. */
  it('asks the wallet for the bar chosen when it is at most the seated count, and gives back where the proposal got to', async () => {
    const m = await load();
    kr.acts = [];
    kr.ended = { of: 'done', steps: 5, relayed: 2, outcome: { state: 'waiting-for-approvals', proposal: 'prop_0001', approvals: 1, needed: 3 } };
    expect(await m.raisePolicyBar('u1', 'acc_Company00001', 4, { policyBar: null, seated: 4 })).toEqual({
      of: 'done', state: 'waiting-for-approvals', proposal: 'prop_0001', approvals: 1, needed: 3,
    });
    expect(kr.acts).toEqual([{ name: 'set-policy-bar', record: 'acc_Company00001', company: 'label-1', account: ACCOUNT, bar: '4' }]);
  });
});

describe('raising a spending policy', () => {
  /* RED WHEN: a new policy's first period does not start when it is raised, or an edited policy's start moves, so its periods change boundaries. */
  it('starts a new policy now and keeps the start of a policy it edits', async () => {
    const m = await load();
    const now = () => 1_700_000_000_999;
    kr.acts = [];
    kr.ended = { of: 'done', steps: 5, relayed: 2, outcome: { state: 'ready-to-carry', proposal: 'prop_0002' } };
    await m.raisePolicy('u1', 'acc_Company00001', { ...NEW_POLICY, current: null }, undefined, now, REGISTRY);
    await m.raisePolicy('u1', 'acc_Company00001', { ...NEW_POLICY, current: EDITED }, undefined, now, REGISTRY);
    expect(kr.acts.map((a) => a['periodStart'])).toEqual(['1700000000', '5']);
  });

  /* RED WHEN: the wallet is asked for another vault, currency, limit, length or bands than the ones filled in, or the bands are not written as four ceiling and approvals pairs in the order given. */
  it('asks the wallet for exactly the policy filled in, as four ceiling and approvals pairs', async () => {
    const m = await load();
    kr.acts = [];
    kr.ended = { of: 'done', steps: 5, relayed: 2, outcome: { state: 'waiting-for-approvals', proposal: 'prop_0003', approvals: 1, needed: 2 } };
    expect(await m.raisePolicy('u1', 'acc_Company00001', { ...NEW_POLICY, current: null }, undefined, () => 1_700_000_000_000, REGISTRY)).toMatchObject({ of: 'done', proposal: 'prop_0003' });
    expect(kr.acts).toEqual([{
      name: 'set-spending-policy', record: 'acc_Company00001', company: 'label-1', account: ACCOUNT, vault: VAULT, token: A1.code,
      periodLimit: '20000', periodStart: '1700000000', periodLength: '604800', bands: '100:1,1000:2,5000:3,99999:4',
    }]);
  });

  /* RED WHEN: a policy of three or five bands, an approvals count that is not whole or is zero, an amount that is not a plain decimal of the currency or has more places than it, a negative limit, an unknown currency or a period of no length reaches the wallet. */
  it('refuses on the page a policy that is not four bands of whole approvals with a period of some length, and asks the wallet nothing', async () => {
    const m = await load();
    kr.calls = 0;
    const bad = [
      { ...NEW_POLICY, bands: NEW_POLICY.bands.slice(1) }, { ...NEW_POLICY, bands: [...NEW_POLICY.bands, NEW_POLICY.bands[0]!] },
      { ...NEW_POLICY, bands: NEW_POLICY.bands.map((b, i) => (i === 1 ? { ...b, approvals: 0 } : b)) },
      { ...NEW_POLICY, bands: NEW_POLICY.bands.map((b, i) => (i === 1 ? { ...b, approvals: 1.5 } : b)) },
      { ...NEW_POLICY, bands: NEW_POLICY.bands.map((b, i) => (i === 2 ? { ...b, ceiling: 'a lot' } : b)) },
      { ...NEW_POLICY, bands: NEW_POLICY.bands.map((b, i) => (i === 2 ? { ...b, ceiling: '0.0000001' } : b)) },
      { ...NEW_POLICY, limit: '-5' }, { ...NEW_POLICY, periodLength: 0n }, { ...NEW_POLICY, token: 'f0'.repeat(32) },
    ];
    for (const p of bad) {
      expect(await m.raisePolicy('u1', 'acc_Company00001', { ...p, current: null }, undefined, undefined, REGISTRY), JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? 'big' : v)))
        .toEqual({ of: 'problem', problem: 'not-a-policy' });
    }
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: another person's session, or a company that cannot be named, still reaches the wallet. */
  it('asks the wallet nothing for another person or a company it cannot name', async () => {
    const m = await load();
    kr.calls = 0;
    kr.user = { id: 'u2' };
    expect(await m.raisePolicy('u1', 'acc_Company00001', { ...NEW_POLICY, current: null }, undefined, undefined, REGISTRY)).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    kr.user = { id: 'u1' };
    kr.named = { companyLabel: 'label-1' };
    expect(await m.raisePolicy('u1', 'acc_Company00001', { ...NEW_POLICY, current: null }, undefined, undefined, REGISTRY)).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(kr.calls).toBe(0);
  });
});

describe('a count of approvals the wallet holds as a number', () => {
  /* RED WHEN: a count that is negative or too large for a number is handed on as a number, rounded or negative, instead of refused. */
  it('refuses a count below nothing or beyond a safe number, and gives back the rest', async () => {
    const { countOf } = await import('vaults-web-shared/proposal-in-the-wallet.js');
    expect(countOf(0n)).toBe(0);
    expect(countOf(4n)).toBe(4);
    expect(() => countOf(-1n)).toThrow(RangeError);
    expect(() => countOf(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
  });
});

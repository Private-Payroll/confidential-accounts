import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { addressFor } from 'midnight-identity';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { NETWORK } from 'midnight-identity/network';
import { checkShieldedAddress } from 'midnight-identity/wallet/address-shape';
import type { ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **A SIGNER'S ROLE IS CHANGED IN THE WALLET: THE SEAT REMOVED, THEN THE PERSON INVITED BY ADDRESS AT THE NEW ROLE.** What
 * is pinned: which of the two acts runs is read from the chain and the company's directory, and that act runs as the
 * page would ask for it alone (the removal and the invitation are stood in for here; each has its own tests); what the
 * change cannot be is refused before either runs; and the person confirms the change, with what the removal does on
 * the chain, before anything is raised.
 */
const t = vi.hoisted(() => ({ ran: [] as Array<{ act: string; fields: Record<string, string> }> }));
vi.mock('./remove-signer.js', async (real) => ({
  ...(await real<typeof import('./remove-signer.js')>()),
  removeSignerAction: () => ({ check: async () => null, steps: (i: ActIntent) => [
    { title: { key: 'act.remove-signer.step.raise' }, run: async () => { t.ran.push({ act: 'remove-signer', fields: { ...i.fields } }); } },
    { title: { key: 'act.remove-signer.step.carry' }, notNeeded: () => true, run: async () => {} },
  ] }),
}));
vi.mock('./invite.js', async (real) => ({
  ...(await real<typeof import('./invite.js')>()),
  inviteAction: () => ({ check: async () => null, steps: (i: ActIntent) => [
    { title: { key: 'act.invite.step.invite' }, run: async () => { t.ran.push({ act: 'invite', fields: { ...i.fields } }); } },
  ] }),
}));
const { changeRoleAction } = await import('./change-role.js');

const REMOVAL_DOES = ['retirement', 'other-changes', 'open-runs', 'checks', 'vault-secrets'].map((k) => `act.remove-signer.shown.${k}`);
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const LEAF = 'a4'.repeat(32);
const OTHER = 'a1'.repeat(32);
const TOKEN = '7e'.repeat(32);
const addressOf = (n: number): string => addressFor(identityFromSecret(new Uint8Array(32).fill(n)).moneyAt(0).zswap, NETWORK as never).bech32;
const DEES = addressOf(4);
const coinOf = (address: string): string => String(checkShieldedAddress(address, NETWORK as never).coinPublicKey).toLowerCase();

/* The company as this wallet reads it: the seats the chain holds, the directory's entry for the seat, and the coin key the roster records for it. */
let company: { held: string[]; role: string | null; retired: unknown; coin: string | undefined; approvals?: number };
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, companyKeys: {}, roster: async () => ({
    id: 'acc_1', name: 'Acme', notBelieved: [],
    signers: [{ id: 's4', name: 'Dee', status: 'active', leafCommitment: LEAF, ...(company.coin === undefined ? {} : { coinPublicKey: company.coin }) }],
  }),
  holders: async () => ({ seats: company.held, committee: [], approvals: company.approvals ?? 1, seatBar: 1, policyBar: null, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }),
  judges: { directoryHereFor: () => async () => ({ dir: { seats: [{ seat: OTHER, role: 'admin', retired: null }, { seat: LEAF, role: company.role, retired: company.retired }] } }) },
});
const reach = () => ({ chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, now: () => 0, commitments: async () => ({}) as never, reachFor: async () => reachOf() as never, afterCarried: async () => ({}) as never });
const intentOf = (role: string, address = DEES, token = TOKEN): ActIntent =>
  ({ name: 'change-role', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT, leaf: LEAF, role, address, personName: 'Dee', token } }) as unknown as ActIntent;
/* The saved keys of the wallet pressing: what press 1 keeps, press 2 reads. */
let saved: Record<string, unknown> = { accounts: {} };
const runOf = async (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const confirmed: Array<readonly { key: string }[]> = [];
  const ctx = {
    intent: i, held: { identity: identityFromSecret(newSecret()), account: 0 }, signal: new AbortController().signal,
    tell: (x: Record<string, unknown>) => { told.push(x); },
    confirm: async (lines: readonly { key: string }[]) => { confirmed.push(lines); },
    keyring: { open: () => ({ read: () => saved }), keep: async (f: (k: any) => any) => { saved = f(saved); } },
  } as unknown as StepContext;
  const action = changeRoleAction(reach() as never);
  expect(await action.check(i, ctx.held)).toBeNull();
  for (const step of action.steps(i)) await step.run(ctx);
  return { told, confirmed: confirmed.flat().map((l) => l.key) };
};
const refusalOf = async (p: Promise<unknown>): Promise<{ key: string; says: string }> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(StepRefused);
  return { key: (e as StepRefused).words.key, says: String((e as StepRefused).words.values?.['says'] ?? '') };
};

beforeEach(() => {
  t.ran.length = 0;
  saved = { accounts: {} };
  company = { held: [OTHER, LEAF], role: 'admin', retired: null, coin: coinOf(DEES) };
});

describe('A SIGNER\'S ROLE IS CHANGED BY THE SEAT\'S REMOVAL, THEN AN INVITATION BY ADDRESS AT THE NEW ROLE', () => {
  it('while the chain holds the seat, a demotion raises the seat\'s removal, keeping the approvals in force, once the person confirms it with what the removal does on the chain', async () => {
    const { told, confirmed } = await runOf(intentOf('approver'));
    /* RED WHEN: a role change raises anything but the seat's removal while the chain holds the seat. */
    expect(t.ran).toEqual([{ act: 'remove-signer', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT, leaf: LEAF, threshold: '0' } }]);
    expect(told).toContainEqual({ stage: 'remove' });
    /* RED WHEN: the person is not shown, before the removal is raised, all it does: the retirement, other changes and open runs, the checks, and every vault's secret change that holds deposits. */
    expect(confirmed).toEqual(['act.change-role.confirm.remove', ...REMOVAL_DOES]);
    /* The kept change, which the second press is held to. */
    expect(Object.keys((saved as { roleChangesKept?: object }).roleChangesKept ?? {})).toHaveLength(1);
  });

  it('once the chain no longer holds the seat, a demotion invites the person by the address given at the new role', async () => {
    await runOf(intentOf('approver'));
    t.ran.length = 0;
    company = { ...company, held: [OTHER], retired: {} };
    const { told, confirmed } = await runOf(intentOf('approver'));
    /* RED WHEN: the second step removes the seat again, or invites at another role, address or name than asked. */
    expect(t.ran).toEqual([{ act: 'invite', fields: {
      record: 'acc_1', company: LABEL, account: ACCOUNT, token: TOKEN, kind: 'signer', role: 'approver', address: DEES, personName: 'Dee',
    } }]);
    expect(told).toContainEqual({ stage: 'invite' });
    expect(confirmed).toEqual(['act.change-role.confirm.invite']);
    /* RED WHEN: once the invitation is filed, what the first press kept stays in the saved keys for good. */
    expect((saved as { roleChangesKept?: object }).roleChangesKept).toEqual({});
  });

  it('an approver promoted to admin is removed at the first press and invited as an admin at the second', async () => {
    company = { ...company, role: 'approver' };
    await runOf(intentOf('admin'));
    company = { ...company, held: [OTHER], retired: {} };
    await runOf(intentOf('admin'));
    /* RED WHEN: the second press refuses a promotion to admin as the role the removed seat already held, leaving the person with no seat. */
    expect(t.ran.map((x) => [x.act, x.fields['role'] ?? x.fields['leaf']])).toEqual([['remove-signer', LEAF], ['invite', 'admin']]);
  });

  it('the second press invites only the address and role the first press confirmed, from the wallet that pressed it', async () => {
    await runOf(intentOf('approver'));
    t.ran.length = 0;
    company = { ...company, held: [OTHER], retired: {} };
    /* RED WHEN: a page sends another person's address, or another role, at the second press and it is invited. */
    expect((await refusalOf(runOf(intentOf('approver', addressOf(9))))).key).toBe('act.change-role.why.not-as-started');
    expect((await refusalOf(runOf(intentOf('initiator')))).key).toBe('act.change-role.why.not-as-started');
    /* RED WHEN: a press under another invitation link raises a second invitation beside one the first link may already have filed. */
    const another = await refusalOf(runOf(intentOf('approver', DEES, '9b'.repeat(32))));
    expect(another.key).toBe('act.change-role.why.another-link');
    expect(WORDS['act.change-role.why.another-link']).toMatch(/Press again with the link you used when you raised the removal/u);
    /* RED WHEN: a wallet that confirmed no removal for the seat invites on the page's word alone. */
    saved = { accounts: {} };
    expect((await refusalOf(runOf(intentOf('approver')))).key).toBe('act.change-role.why.not-started-here');
    expect(t.ran).toEqual([]);
  });

  it('REFUSES a removal that would leave fewer signers than the approvals in force, saying to remove the signer with fewer approvals first, then invite', async () => {
    company = { ...company, approvals: 2 };
    const refused = await refusalOf(runOf(intentOf('approver')));
    /* RED WHEN: the refusal tells the person to choose fewer approvals here, which this act cannot do. */
    expect(refused.key).toBe('act.change-role.why.fewer-approvals-first');
    expect(WORDS['act.change-role.why.fewer-approvals-first']).toMatch(/Remove a signer, choosing fewer approvals there, then invite them at the new role with Invite/u);
    expect(t.ran).toEqual([]);
  });

  it('a seat whose address the company\'s list of signers does not record is removed only after the person is told the address is not tied to it', async () => {
    company = { ...company, coin: undefined };
    const { confirmed } = await runOf(intentOf('initiator'));
    /* RED WHEN: an address the company's records cannot tie to the seat is taken without saying so. */
    expect(confirmed).toContain('act.change-role.confirm.address-untied');
    expect(t.ran.map((x) => x.act)).toEqual(['remove-signer']);
  });

  it('REFUSES, BEFORE ANYTHING RUNS: another wallet\'s address, a reader role, the role the seat holds, and a seat whose removal is under way', async () => {
    /* RED WHEN: another person's address is invited in place of the one removed. */
    expect(await refusalOf(runOf(intentOf('approver', addressOf(9))))).toMatchObject({ key: 'act.change-role.why.refused', says: expect.stringMatching(/Give the address of the wallet that holds the seat/u) });
    /* RED WHEN: a signer's seat is changed into a reader's, which holds no seat on the chain. */
    expect(await refusalOf(runOf(intentOf('accountant')))).toMatchObject({ says: expect.stringMatching(/^Limited and accountant people .*remove them first with Remove\. Giving read access is not on a screen yet\.$/u) });
    /* RED WHEN: a seat is removed to be invited again at the role it already holds. */
    expect(await refusalOf(runOf(intentOf('admin')))).toMatchObject({ says: expect.stringMatching(/already holds the role admin/u) });
    /* RED WHEN: a second removal is raised, or the person invited, while the seat's removal waits to be carried out. */
    company = { ...company, retired: {} };
    expect((await refusalOf(runOf(intentOf('approver')))).key).toBe('act.change-role.why.removal-under-way');
    expect(t.ran).toEqual([]);
  });

  it('every step of the removal and of the invitation is a step of this act, run by the runner, and only the act decided on runs', async () => {
    const steps = changeRoleAction(reach() as never).steps(intentOf('approver'));
    /* RED WHEN: the act decided on runs inside one step of this act, out of reach of the runner's stop, deadline and step count. */
    expect(steps.map((x) => x.title.key)).toEqual([
      'act.change-role.step.decide', 'act.remove-signer.step.raise', 'act.remove-signer.step.carry', 'act.invite.step.invite', 'act.change-role.step.done',
    ]);
    /* RED WHEN: a step of the act not decided on is listed as done, or one of the act decided on loses its own "not needed". */
    expect(steps.map((x) => x.notNeeded?.({ stage: 'remove' }) ?? false)).toEqual([false, false, true, true, true]);
    expect(steps.map((x) => x.notNeeded?.({ stage: 'invite' }) ?? false)).toEqual([false, true, true, false, false]);
    /* RED WHEN: the change's screen does not say, before the passkey, that the first step changes every vault's secret and holds deposits. */
    const shown = (await changeRoleAction(reach() as never).shown(intentOf('approver'))).map((l) => l.key);
    for (const k of REMOVAL_DOES) expect(shown).toContain(k);
    expect(WORDS['act.change-role.shown.two-acts']).toMatch(/deposits made from this product into a vault wait until its new secret is set/u);
  });

  it('every word the act says is in the wallet\'s language file', () => {
    const source = readFileSync(new URL('./change-role.ts', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/'(act\.(?:change-role|remove-signer)\.[a-z.-]+)'/gu)].map((m) => m[1]!);
    const whys = [...source.matchAll(/why\('([a-z-]+)'/gu)].map((m) => `act.change-role.why.${m[1]!}`);
    const reach = ['not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened'].map((w) => `act.change-role.why.${w}`);
    /* RED WHEN: the wallet says a word its language file does not hold. */
    for (const k of [...keys, ...whys, ...reach]) expect(WORDS[k], k).toBeTypeOf('string');
  });
});

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { assets } from '../../../../src/core/assets.js';
import { invitationIdOf, invitationLink } from '../../../../src/core/invitation.js';
import { READ } from './reads.js';
import { ACT_REFUSAL } from './refusals.js';

/*
 * THE INVITE PANEL'S ADAPTER: the ask made from what was typed, what the wallet's stops come to, the press again that carries
 * on the same invitation, and the sentence about the approvals adding a signer needs.
 */
const kr = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null, acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown,
  named: { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) } as unknown, calls: 0,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => kr.named,
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => {
    kr.calls += 1;
    kr.acts.push(intent);
    return kr.ended;
  },
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./invite.js');
}
const NAMED = { record: 'acc_Company00001', company: 'label-1', account: 'c0'.repeat(32) };
const ASSET = assets.enabled()[0]!;
const PRIVATE = 'mn_shield-addr_stagenet1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyq4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kkcvfvr0u';

describe('the ask made from the form', () => {
  /* RED WHEN: an employee's pay is not the whole number of smallest units, or a field the person left empty is sent. */
  it('makes an employee, a monthly vendor, a one-off vendor and a signer', async () => {
    const m = await load();
    const base = { ...m.emptyDraft(m.INVITE_KIND.employee), name: ' Ada ', startDate: '2026-11-01', amount: '12.5' };
    const e = m.askOf(base, NAMED);
    expect(e).toMatchObject({ of: 'ask', ask: { kind: 'employee', name: 'Ada', startDate: '2026-11-01', classification: 'full-time', title: '', asset: ASSET.code, units: 125n * 10n ** BigInt(ASSET.decimals - 1) } });
    expect((e as { ask: Record<string, unknown> }).ask).not.toHaveProperty('email');
    expect((e as { ask: Record<string, unknown> }).ask).not.toHaveProperty('address');
    const v1 = m.askOf({ ...m.emptyDraft(m.INVITE_KIND.vendor), name: 'Acme', startDate: '2026-11-01' }, NAMED);
    expect(v1).toMatchObject({ of: 'ask', ask: { kind: 'vendor', terms: { kind: 'one-off' } } });
    const v2 = m.askOf({ ...m.emptyDraft(m.INVITE_KIND.vendor), name: 'Acme', startDate: '2026-11-01', terms: 'monthly', termsAmount: '3' }, NAMED);
    expect(v2).toMatchObject({ of: 'ask', ask: { terms: { kind: 'monthly', asset: ASSET.code, units: 3n * 10n ** BigInt(ASSET.decimals) } } });
    expect(m.askOf({ ...m.emptyDraft(m.INVITE_KIND.signer), name: 'Sam', address: ' ' + PRIVATE + ' ' }, NAMED)).toMatchObject({ of: 'ask', ask: { kind: 'signer', role: 'approver', address: PRIVATE } });
    expect(m.askOf({ ...m.emptyDraft(m.INVITE_KIND.signer), name: 'Sam', address: 'hello' }, NAMED)).toMatchObject({ of: 'problem', problem: 'bad-address', field: 'address' });
  });

  /* RED WHEN: a super admin yields an ask, or a limited or accountant signer does. */
  it('refuses a super admin and the roles shown for later, and sends nothing for them', async () => {
    const m = await load();
    expect(m.askOf({ ...m.emptyDraft(m.INVITE_KIND.superAdmin), name: 'Root' }, NAMED)).toEqual({ of: 'problem', problem: 'super-admin', field: 'kind' });
    for (const role of m.SIGNER_ROLES_LATER) {
      expect(m.askOf({ ...m.emptyDraft(m.INVITE_KIND.signer), name: 'Sam', role, address: PRIVATE }, NAMED), role).toEqual({ of: 'problem', problem: 'role-later', field: 'role' });
    }
    kr.calls = 0;
    expect(await m.sendInvite('u1', 'acc_Company00001', { ...m.emptyDraft(m.INVITE_KIND.superAdmin), name: 'Root' })).toEqual({ of: 'problem', problem: 'super-admin', field: 'kind' });
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: a date, an amount or a name is let through that the wallet would refuse, or the first problem is not named by its field. */
  it.each([
    [{ name: ' ' }, 'no-name', 'name'], [{ startDate: '' }, 'no-start', 'startDate'], [{ startDate: '2026-02-30' }, 'bad-start', 'startDate'],
    [{ endDate: '2026-10-01' }, 'end-before-start', 'endDate'], [{ endDate: 'soon' }, 'bad-end', 'endDate'], [{ email: 'ada' }, 'bad-email', 'email'],
    [{ amount: '' }, 'no-amount', 'amount'], [{ amount: '1,5' }, 'bad-amount', 'amount'], [{ amount: '0' }, 'zero-amount', 'amount'],
    [{ amount: '1.' + '1'.repeat(40) }, 'too-many-decimals', 'amount'], [{ amount: '9'.repeat(40) }, 'bad-amount', 'amount'],
    [{ asset: 'ff'.repeat(32) }, 'no-asset', 'asset'], [{ way: 'address' as const, address: '' }, 'no-address', 'address'],
    [{ way: 'address' as const, address: 'hello' }, 'bad-address', 'address'],
  ])('finds %j wrong', async (patch, problem, field) => {
    const m = await load();
    const draft = { ...m.emptyDraft(m.INVITE_KIND.employee), name: 'Ada', startDate: '2026-11-01', endDate: '', amount: '10', ...patch };
    expect(m.askOf(draft, NAMED)).toEqual({ of: 'problem', problem, field });
  });

  /* RED WHEN: a trailing zero past the currency's decimals is refused, or the units are not scaled by the currency's decimals. */
  it('reads an amount in the currency\'s own decimals', async () => {
    const m = await load();
    expect(m.unitsOf('7', { decimals: 6 })).toEqual({ of: 'units', units: 7_000_000n });
    expect(m.unitsOf('0.5000000', { decimals: 6 })).toEqual({ of: 'units', units: 500_000n });
    expect(m.unitsOf('0.0000001', { decimals: 6 })).toEqual({ of: 'problem', problem: 'too-many-decimals' });
  });
});

describe('sending an invitation', () => {
  const draft = (m: Awaited<ReturnType<typeof load>>) => ({ ...m.emptyDraft(m.INVITE_KIND.employee), name: 'Ada', startDate: '2026-11-01', amount: '10' });

  /* RED WHEN: a filed invitation does not come back with the link made from the token the wallet was given. */
  it('gives back the link and the token of a filed invitation', async () => {
    const m = await load();
    kr.acts.length = 0; kr.ended = { of: 'done', steps: 1, relayed: 0, outcome: { state: 'filed' } };
    const sent = await m.sendInvite('u1', 'acc_Company00001', draft(m));
    const token = kr.acts[0]!['token']!;
    expect(sent).toEqual({ of: 'done', token, already: false, link: invitationLink(window.location.origin, token as never) });
    expect(invitationIdOf(token as never)).toHaveLength(64);
  });

  /* RED WHEN: the same invitation filed before is told as a new one. */
  it('tells an invitation filed before', async () => {
    const m = await load();
    kr.ended = { of: 'done', steps: 1, relayed: 0, outcome: { state: 'already-filed' } };
    expect(await m.sendInvite('u1', 'acc_Company00001', draft(m))).toMatchObject({ of: 'done', already: true });
  });

  /* RED WHEN: a refusal that follows transactions the wallet handed the page (sent, or not confirmed as sent) is told as one that sent nothing, or a refusal that handed over none is told as one that did. */
  it('says a stop handed transactions over when any were sent or left unconfirmed, whatever its reason, and none when none were', async () => {
    const m = await load();
    for (const [relayed, unconfirmed, handedOver] of [[0, 0, false], [1, 0, true], [0, 1, true], [2, 1, true]] as const) {
      kr.ended = { of: 'stopped', step: 3, steps: 4, relayed, unconfirmed, why: 'check-failed', refused: 'act.invite.why.offer-not-read' };
      expect(await m.sendInvite('u1', 'acc_Company00001', draft(m)), `${relayed}/${unconfirmed}`).toMatchObject({ of: 'stopped', why: 'offer-not-read', handedOver });
    }
  });

  /* RED WHEN: after a stop that may have made part of the invitation the next press makes a new token, or after one that made nothing it holds the old one. */
  it('keeps the token after a raise not filed, a part-way stop, a filed invitation not yet entered, an offer not read and a wallet stop, and after a refusal it does not know, and not after one that made nothing', async () => {
    const m = await load();
    const stop = (refused?: string) => { kr.ended = { of: 'stopped', step: 3, steps: 4, relayed: 0, unconfirmed: 0, why: refused === undefined ? 'relay-refused' : 'check-failed', ...(refused === undefined ? {} : { refused }) }; };
    for (const [refused, keeps, why] of [
      ['act.invite.why.raised-not-filed', true, 'raised-not-filed'], ['act.invite.why.may-be-sent', true, 'may-be-sent'], [undefined, true, 'stopped'],
      ['act.invite.why.not-made', false, 'not-made'], ['act.invite.why.own-address', false, 'own-address'], ['act.invite.why.nobody-knows', true, 'other'],
      ['act.invite.why.filed-not-entered', true, 'filed-not-entered'], ['act.invite.why.offer-not-read', true, 'offer-not-read'],
    ] as const) {
      stop(refused);
      const sent = await m.sendInvite('u1', 'acc_Company00001', draft(m));
      expect(sent, why).toMatchObject({ of: 'stopped', why, keeps });
    }
    stop('act.invite.why.raised-not-filed');
    const raised = await m.sendInvite('u1', 'acc_Company00001', draft(m)) as { link: string | null; token: string };
    expect(raised.link).toBe(invitationLink(window.location.origin, raised.token as never));
    stop('act.invite.why.may-be-sent');
    expect(((await m.sendInvite('u1', 'acc_Company00001', draft(m))) as { link: string | null }).link).toBeNull();
    for (const key of ['act.invite.why.filed-not-entered', 'act.invite.why.offer-not-read']) {
      stop(key);
      expect(((await m.sendInvite('u1', 'acc_Company00001', draft(m))) as { link: string | null }).link, key).toBeNull();
    }
  });

  /* RED WHEN: a press again does not carry the token it was given into the wallet's intent, or a token that is not whole reaches the wallet. */
  it('passes the kept token on a press again, and refuses a token that is not whole before the wallet is asked', async () => {
    const m = await load();
    const kept = 'cd'.repeat(32);
    kr.acts.length = 0; kr.calls = 0; kr.ended = { of: 'done', steps: 1, relayed: 0 };
    const sent = await m.sendInvite('u1', 'acc_Company00001', draft(m), kept);
    expect(kr.acts[0]!['token']).toBe(kept);
    expect(sent).toMatchObject({ of: 'done', token: kept });
    kr.calls = 0;
    expect(await m.sendInvite('u1', 'acc_Company00001', draft(m), 'CD'.repeat(32))).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(await m.sendInvite('u1', 'acc_Company00001', draft(m), 'cd')).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: a person who is not signed in, or a company that cannot be read, reaches the wallet. */
  it('asks the wallet for nothing when nobody is signed in or the company cannot be read', async () => {
    const m = await load();
    kr.calls = 0;
    kr.user = null;
    expect(await m.sendInvite('u1', 'acc_Company00001', draft(m))).toEqual({ of: 'refused', why: ACT_REFUSAL.notSignedIn });
    kr.user = { id: 'u1' }; kr.named = {};
    expect(await m.sendInvite('u1', 'acc_Company00001', draft(m))).toEqual({ of: 'refused', why: ACT_REFUSAL.didNotFinish });
    kr.named = { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) };
    expect(kr.calls).toBe(0);
  });

  /* RED WHEN: the wallet's key is read as another reason than the one it names. */
  it('reads the wallet\'s refusal key', async () => {
    const m = await load();
    expect(m.whyOf('act.invite.why.wider-scope')).toBe('wider-scope');
    expect(m.whyOf('act.invite.why.stopped')).toBe('other');
    expect(m.whyOf('act.deposit.why.wider-scope')).toBe('other');
    expect(m.whyOf(undefined)).toBe('stopped');
  });
});

describe('the approvals adding a signer needs', () => {
  const read = (count: number, raised: boolean, vaults: string[]) => ({ of: READ.read, value: { count, raisedAboveTheAccount: raised, vaultsAtThatNumber: vaults } }) as never;

  /* RED WHEN: the sentence is said for a number that could not be read, or says the account's number when a vault raised it. */
  it('says the account\'s number, the raised one with its vaults, and nothing when the number is not read', async () => {
    const m = await load();
    expect(m.approvalsSentence(read(2, false, []))).toEqual({ code: 'account', values: { count: 2, vaults: 0 } });
    expect(m.approvalsSentence(read(3, true, ['aa', 'bb']))).toEqual({ code: 'raised', values: { count: 3, vaults: 2 } });
    expect(m.approvalsSentence(read(3, true, []))).toEqual({ code: 'raisedUnnamed', values: { count: 3, vaults: 0 } });
    expect(m.approvalsSentence({ of: READ.unreadable })).toBeNull();
    expect(m.approvalsSentence(undefined)).toBeNull();
  });

  /* RED WHEN: the helper reads the old count of approvals (approvalsNeeded) instead of the signers' one. */
  it('reads approvalsForSigners and never approvalsNeeded', async () => {
    const code = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'invite.ts'), 'utf8');
    expect(code).not.toMatch(/approvalsNeeded/u);
    expect(code).toMatch(/SignersApprovals/u);
  });
});

describe('which address is private', () => {
  /* RED WHEN: a public address, a mistyped one or nothing is taken for a private address, or a private one with spaces round it is not (the sent words would then say the holder alone can take up a link nothing guards). */
  it('says a private address is private, and a public one, a bad one and an empty one are not', async () => {
    const m = await load();
    expect(m.addressIsPrivate(` ${PRIVATE} `)).toBe(true);
    expect(m.addressIsPrivate('mn_addr_stagenet1egv3hww6lmsahjy3gldaqn778hcpwvhhw8udud6k859906yynmmq8wsdsd')).toBe(false);
    expect(m.addressIsPrivate(PRIVATE.slice(0, -3))).toBe(false);
    expect(m.addressIsPrivate('')).toBe(false);
  });
});


import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { invitationIdOf, invitationLink } from '../../../src/core/invitation.js';

const keyring = vi.hoisted(() => ({ intents: [] as Record<string, string>[], outcome: undefined as Record<string, string | number> | undefined }));
vi.mock('./keyring.js', () => ({
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => {
    keyring.intents.push(intent);
    return { of: 'done', steps: 1, relayed: 0, ...(keyring.outcome === undefined ? {} : { outcome: keyring.outcome }) };
  },
}));

const { inviteInTheWallet } = await import('./invite-in-the-wallet.js');

const US = 'https://payroll.example';
const at = { record: 'acc_Company00001', company: 'label' as CompanyLabel, account: 'c0'.repeat(32) as AccountAddress };
const ask = { ...at, kind: 'signer' as const, name: 'Ada', role: 'approver', address: 'mn_addr_test1qq' };
const employee = {
  ...at, kind: 'employee' as const, name: 'Bo', title: 'Engineer', asset: '02'.repeat(32), units: 5n, startDate: '2026-11-01', classification: 'full-time',
};
const VIEW = {} as never;
const GIVEN = 'ab'.repeat(32);

beforeEach(() => { keyring.intents.length = 0; keyring.outcome = undefined; });

describe('inviting an employee or a vendor from the page with a token of its own', () => {
  /* RED WHEN: a token handed in does not reach the wallet's intent unchanged, or the link and id are not made from it. */
  it('uses the token given, in the intent, the link and the id', async () => {
    const made = await inviteInTheWallet(employee, 'https://wallet.example', { origin: US, token: GIVEN }, VIEW);
    expect(keyring.intents).toHaveLength(1);
    expect(keyring.intents[0]!['token']).toBe(GIVEN);
    expect(made.link).toBe(invitationLink(US, GIVEN));
    expect(made.id).toBe(invitationIdOf(GIVEN));
  });

  /* RED WHEN: a token that is not sixty-four lower-case hex characters is passed to the wallet, or refused after the wallet was asked. */
  it.each(['', 'AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), `${'ab'.repeat(31)}zz`, ` ${GIVEN}`, `${GIVEN}\n`])('refuses the token %j before the wallet is asked', async (token) => {
    await expect(inviteInTheWallet(employee, 'https://wallet.example', { origin: US, token }, VIEW)).rejects.toThrow();
    expect(keyring.intents).toEqual([]);
  });

  /* RED WHEN: without a token no fresh one is made, or two invitations share a token. */
  it('makes a fresh token each time when none is given', async () => {
    const one = await inviteInTheWallet(employee, 'https://wallet.example', { origin: US }, VIEW);
    const two = await inviteInTheWallet(employee, 'https://wallet.example', { origin: US }, VIEW);
    const [a, b] = keyring.intents.map((i) => i['token']!);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(b).toMatch(/^[0-9a-f]{64}$/u);
    expect(a).not.toBe(b);
    expect(one.link).toBe(invitationLink(US, a!));
    expect(two.id).toBe(invitationIdOf(b!));
  });
});

describe('inviting a signer from the page, which never holds the invitation\'s token', () => {
  /* RED WHEN: the page sends a signer's wallet a token, or makes a link or id for a signer's invitation, so the page holds what opens its offer. */
  it('sends no token and gets no link or id back, whatever the wallet tells', async () => {
    keyring.outcome = { state: 'filed', token: 'cd'.repeat(32) };
    const made = await inviteInTheWallet(ask, 'https://wallet.example', { origin: US }, VIEW);
    expect('token' in keyring.intents[0]!).toBe(false);
    expect(made.link).toBeNull();
    expect(made.id).toBeNull();
  });

  /* RED WHEN: a token handed in for a signer reaches the wallet. */
  it('refuses a token handed in for a signer before the wallet is asked', async () => {
    await expect(inviteInTheWallet(ask, 'https://wallet.example', { origin: US, token: GIVEN }, VIEW)).rejects.toThrow();
    expect(keyring.intents).toEqual([]);
  });

  /* RED WHEN: the approvals needed once the seat is taken do not reach the wallet's intent as digits, or one is sent when none is asked. */
  it('hands the wallet a signer\'s new threshold as digits, and none when none is asked', async () => {
    await inviteInTheWallet({ ...ask, threshold: 2 }, 'https://wallet.example', { origin: US }, VIEW);
    await inviteInTheWallet(ask, 'https://wallet.example', { origin: US }, VIEW);
    expect(keyring.intents[0]!['threshold']).toBe('2');
    expect('threshold' in keyring.intents[1]!).toBe(false);
  });
});

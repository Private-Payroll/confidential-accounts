import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { invitationIdOf, invitationLink } from '../../../src/core/invitation.js';

const keyring = vi.hoisted(() => ({ intents: [] as Record<string, string>[] }));
vi.mock('./keyring.js', () => ({
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => {
    keyring.intents.push(intent);
    return { of: 'done', steps: 1, relayed: 0 };
  },
}));

const { inviteInTheWallet } = await import('./invite-in-the-wallet.js');

const US = 'https://payroll.example';
const ask = {
  record: 'acc_Company00001', company: 'label' as CompanyLabel, account: 'c0'.repeat(32) as AccountAddress,
  kind: 'signer' as const, name: 'Ada', role: 'approver', address: 'mn_addr_test1qq',
};
const VIEW = {} as never;
const GIVEN = 'ab'.repeat(32);

beforeEach(() => { keyring.intents.length = 0; });

describe('inviting from the page with a token of its own', () => {
  /* RED WHEN: a token handed in does not reach the wallet's intent unchanged, or the link and id are not made from it. */
  it('uses the token given, in the intent, the link and the id', async () => {
    const made = await inviteInTheWallet(ask, 'https://wallet.example', { origin: US, token: GIVEN }, VIEW);
    expect(keyring.intents).toHaveLength(1);
    expect(keyring.intents[0]!['token']).toBe(GIVEN);
    expect(made.link).toBe(invitationLink(US, GIVEN as never));
    expect(made.id).toBe(invitationIdOf(GIVEN as never));
  });

  /* RED WHEN: a token that is not sixty-four lower-case hex characters is passed to the wallet, or refused after the wallet was asked. */
  it.each(['', 'AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), `${'ab'.repeat(31)}zz`, ` ${GIVEN}`, `${GIVEN}\n`])('refuses the token %j before the wallet is asked', async (token) => {
    await expect(inviteInTheWallet(ask, 'https://wallet.example', { origin: US, token }, VIEW)).rejects.toThrow();
    expect(keyring.intents).toEqual([]);
  });

  /* RED WHEN: without a token no fresh one is made, or two invitations share a token. */
  it('makes a fresh token each time when none is given', async () => {
    const one = await inviteInTheWallet(ask, 'https://wallet.example', { origin: US }, VIEW);
    const two = await inviteInTheWallet(ask, 'https://wallet.example', { origin: US }, VIEW);
    const [a, b] = keyring.intents.map((i) => i['token']!);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(b).toMatch(/^[0-9a-f]{64}$/u);
    expect(a).not.toBe(b);
    expect(one.link).toBe(invitationLink(US, a as never));
    expect(two.id).toBe(invitationIdOf(b as never));
  });
});

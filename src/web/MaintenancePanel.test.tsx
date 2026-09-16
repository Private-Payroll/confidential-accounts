// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Account } from '../core/types.js';
import { MaintenancePanel, seatWords, whyNotHandOver, type AuthorityScreen } from './MaintenancePanel.js';

/*
 * The settings screen's list of who can change a company's rules, rendered
 * against a service answer, with nothing but the page's own call standing in.
 */
const k = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
const account = {
  id: 'acc_1', name: 'Northwind',
  signers: [
    { id: 's1', userId: 'ada', name: 'Ada Lovelace', status: 'active' },
    { id: 's2', userId: 'bo', name: 'Bo Diddley', status: 'active' },
  ],
} as unknown as Account;

const answer = (over: Partial<AuthorityScreen> = {}): AuthorityScreen => ({
  company: { address: 'c0'.repeat(32), threshold: 2, signerCount: 2 },
  committee: { committee: [k(1), k(2)], threshold: 2 },
  why: null,
  everySignerNeeded: 'Every one of this company\'s 2 signers is needed for every change to its rules.',
  contracts: [
    {
      contract: 'account', address: 'c0'.repeat(32), read: 'read', threshold: 1, changes: '0', shape: 'one-key',
      heldByTheCompany: false, seatsOutsideTheCommittee: 1,
      seats: [{ key: k(9), holder: null, thisService: true, onTheCompanysCommittee: false, you: false }],
      why: '1 seat(s) on this account are held by a key that is not on the company\'s committee now.',
    },
    {
      contract: 'vault', address: 'ab'.repeat(32), read: 'read', threshold: 2, changes: '1', shape: 'committee',
      heldByTheCompany: true, seatsOutsideTheCommittee: 0,
      seats: [
        { key: k(1), holder: 'ada', onTheCompanysCommittee: true, you: true },
        { key: k(2), holder: 'bo', onTheCompanysCommittee: true, you: false },
      ],
      why: 'the company\'s committee holds this vault.',
    },
  ],
  handover: { possible: true, why: null, permanent: 'Once handed over, a signer who leaves keeps their seat.' },
  change: { possible: false, why: 'Changing who holds these rules needs the signers who hold them now to sign the change in their own wallets.' },
  ...over,
});

const shown = async (a: AuthorityScreen, calls: string[] = [], wallet = k(1)) => {
  const api = async (path: string, opts?: RequestInit) => {
    calls.push(`${opts?.method ?? 'GET'} ${path}`);
    if (path.endsWith('/handover')) bodies.push(String(opts?.body));
    return path.endsWith('/handover') ? { txRef: 'tx-1' } : a;
  };
  render(<MaintenancePanel account={account} api={api} walletKey={async () => wallet} />);
  await act(async () => { await Promise.resolve(); });
  return calls;
};

const bodies: string[] = [];
afterEach(() => { cleanup(); bodies.length = 0; });

describe('WHO CAN CHANGE THIS COMPANY\'S RULES, ON THE SETTINGS SCREEN', () => {
  it('SHOWS EVERY CONTRACT\'S SEATS BY NAME, AND A SEAT NOBODY ON THE COMPANY GAVE, MARKED', async () => {
    /* RED WHEN: `seatWords` drops the outside marker or the holder's name, or a contract row is not rendered. */
    await shown(answer());
    const account_ = document.querySelector('[data-contract="account"]')!;
    expect(account_.getAttribute('data-held')).toBe('false');
    expect(account_.textContent).toMatch(/this service's temporary key/);
    expect(account_.textContent).toMatch(/held by a key that is not on the company's committee/);
    const vault = document.querySelector('[data-contract="vault"]')!;
    expect(vault.textContent).toMatch(/Ada Lovelace \(you\)/);
    expect(vault.textContent).toMatch(/Bo Diddley/);
    expect(vault.textContent).toMatch(/2 of 2 must sign; changed 1 time(?!s)/);
    expect(document.querySelectorAll('[data-seat-outside="true"]')).toHaveLength(1);
    expect(screen.getByText(/2 keys, one per/).textContent).toMatch(/2 of them must sign any change/);
  });

  it('SAYS, BEFORE ANYTHING ELSE, WHEN LOSING ONE SIGNER STRANDS THE MONEY', async () => {
    /* RED WHEN: the panel stops rendering `everySignerNeeded`. */
    await shown(answer());
    expect(document.querySelector('[data-every-signer-needed]')!.textContent).toMatch(/Every one of this company's 2 signers/);
    cleanup();
    await shown(answer({ everySignerNeeded: null }));
    expect(document.querySelector('[data-every-signer-needed]')).toBeNull();
  });

  it('OFFERS THE ACCOUNT\'S HANDOVER ONLY WHEN THE SERVICE SAYS IT CAN, AND NEVER OFFERS A CHANGE THE WALLET CANNOT SIGN', async () => {
    /* RED WHEN: the handover button ignores `handover.possible`, the press posts anywhere else, or the change
     * button is enabled. */
    const calls = await shown(answer());
    expect(document.querySelector('[data-handover-permanent]')!.textContent).toMatch(/keeps their seat/);
    fireEvent.click(document.querySelector('[data-hand-over-account]')!);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(calls).toContain('POST /api/accounts/acc_1/authority/handover');
    /* RED WHEN: the press sends anything but the committee it checked - the service then installs its own. */
    expect(JSON.parse(bodies[0]!)).toEqual({ committee: answer().committee });
    expect(screen.getByText(/Sent \(tx-1\)/)).toBeTruthy();
    expect((document.querySelector('[data-change-authority]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-change-why]')!.textContent).toMatch(/sign the change in their own wallets/);
    cleanup();
    await shown(answer({ handover: { possible: false, why: 'this deployment keeps no temporary key for company accounts.' } }));
    expect(document.querySelector('[data-hand-over-account]')).toBeNull();
    expect(screen.getByText(/keeps no temporary key/)).toBeTruthy();
  });

  it('THE ACCOUNT IS NOT HANDED TO A COMMITTEE THAT DOES NOT CARRY THIS PERSON\'S OWN WALLET KEY', async () => {
    /* RED WHEN: the press skips `whyNotHandOver`, or it stops comparing with the wallet's key - the POST is then
     * made to a committee the service chose. */
    const calls = await shown(answer(), [], k(5));
    fireEvent.click(document.querySelector('[data-hand-over-account]')!);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls).not.toContain('POST /api/accounts/acc_1/authority/handover');
    expect(document.querySelector('.err:not([data-every-signer-needed])')!.textContent).toMatch(/does not carry the key your wallet gives/);
    const a = answer();
    expect(whyNotHandOver(a, k(1), 2)).toBeNull();
    /* The service names another key as this person's: refused even though the wallet's key is on the committee. */
    const swapped = answer();
    swapped.contracts[1]!.seats[0] = { ...swapped.contracts[1]!.seats[0]!, key: k(2) };
    expect(whyNotHandOver(swapped, k(1), 2)).toMatch(/shows a key as yours that is not the one your wallet gives/);
    /* RED WHEN: a seat carrying this person's key under another name is not refused. */
    const renamed = answer();
    renamed.contracts[1]!.seats[0] = { ...renamed.contracts[1]!.seats[0]!, you: false };
    expect(whyNotHandOver(renamed, k(1), 2)).toMatch(/on a seat it says is not yours/);
    /* RED WHEN: the committee's size is not compared with the company's own roster. */
    expect(whyNotHandOver({ ...a, committee: { committee: [k(1)], threshold: 1 } }, k(1), 2)).toMatch(/has 1 key\(s\) and this company has 2 signer/);
    expect(whyNotHandOver({ ...a, committee: null, why: 'no committee yet.' }, k(1), 2)).toBe('no committee yet.');
  });

  it('names a holder who has no signer row plainly rather than inventing one', () => {
    /* RED WHEN: `seatWords` falls back to the raw user id. */
    expect(seatWords({ key: k(3), holder: 'zed', onTheCompanysCommittee: true, you: false }, account.signers))
      .toBe('a signer of this company');
    expect(seatWords({ key: k(3), holder: null, onTheCompanysCommittee: false, you: false }, account.signers))
      .toBe('a key nobody now on this company gave - not on the company\'s committee');
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Account } from '../core/types.js';
import { MaintenancePanel, seatWords, whyNotHandOver, type AuthorityScreen } from './MaintenancePanel.js';
import { newSigningKeypair, type Hex } from '../core/crypto.js';
import { signVaultKeys } from '../core/vault-keys.js';

/*
 * The settings screen's list of who can change a company's rules, rendered
 * against a service answer, with nothing but the page's own call standing in.
 * The roster is a real one: each signer's vault keys signed with their own
 * roster signing key, as a device gives them.
 */
const k = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
const ADA = newSigningKeypair();
const BO = newSigningKeypair();
const entry = (id: string, userId: string, name: string, pair: { publicKey: Hex; secret: Hex }, key: number, signedBy = pair) => ({
  id, userId, name, status: 'active', signingPublicKey: pair.publicKey,
  vaultKeys: signVaultKeys('acc_1', id, { committeeKey: k(key), recordsKey: k(key + 0x10).value as Hex }, signedBy.secret),
});
const account = {
  id: 'acc_1', name: 'Northwind',
  signers: [entry('s1', 'ada', 'Ada Lovelace', ADA, 1), entry('s2', 'bo', 'Bo Diddley', BO, 2)],
} as unknown as Account;
const ME = { signerId: 's1' };

const answer = (over: Partial<AuthorityScreen> = {}): AuthorityScreen => ({
  company: { address: 'c0'.repeat(32), threshold: 2, signerCount: 2 },
  committee: { committee: [k(1), k(2)], threshold: 2 },
  why: null,
  everySignerNeeded: 'Every one of this company\'s 2 signers is needed for every change to its rules.',
  contracts: [
    {
      contract: 'account', address: 'c0'.repeat(32), read: 'read', threshold: 1, changes: '0', shape: 'one-key',
      heldByTheCompany: false, seatsOutsideTheCommittee: 1,
      seats: [{ key: k(9), holder: null, thisService: true, onTheCompanysCommittee: false }],
      why: '1 seat(s) on this account are held by a key that is not on the company\'s committee now.',
    },
    {
      contract: 'vault', address: 'ab'.repeat(32), read: 'read', threshold: 2, changes: '1', shape: 'committee',
      heldByTheCompany: true, seatsOutsideTheCommittee: 0,
      seats: [
        { key: k(1), holder: null, onTheCompanysCommittee: true },
        { key: k(2), holder: null, onTheCompanysCommittee: true },
      ],
      why: 'the company\'s committee holds this vault.',
    },
  ],
  handover: { possible: true, why: null, permanent: 'Once handed over, a signer who leaves keeps their seat.' },
  change: { possible: false, why: 'Changing who holds these rules needs the signers who hold them now to sign the change in their own wallets.' },
  ...over,
});

const shown = async (a: AuthorityScreen, calls: string[] = [], wallet = k(1), roster: Account = account) => {
  const api = async (path: string, opts?: RequestInit) => {
    calls.push(`${opts?.method ?? 'GET'} ${path}`);
    if (path.endsWith('/handover')) bodies.push(String(opts?.body));
    return path.endsWith('/handover') ? { txRef: 'tx-1' } : a;
  };
  render(<MaintenancePanel account={account} me={ME} api={api} walletKey={async () => wallet} roster={async () => roster} />);
  await act(async () => { await Promise.resolve(); });
  return calls;
};

const bodies: string[] = [];
afterEach(() => { cleanup(); bodies.length = 0; });

describe('WHO CAN CHANGE THIS COMPANY\'S RULES, ON THE SETTINGS SCREEN', () => {
  it('SHOWS EVERY CONTRACT\'S SEATS BY THE NAME THE ROSTER GIVES THEM, AND A SEAT NOBODY ON THE COMPANY GAVE, MARKED', async () => {
    /* RED WHEN: `seatWords` drops the outside marker or the holder's name, names a holder from anything but the
     * roster, or a contract row is not rendered. */
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
    expect(document.querySelector('.err:not([data-every-signer-needed])')!.textContent).toMatch(/roster does not carry the key your wallet gives/);
    const a = answer();
    expect(whyNotHandOver(a, k(1), account, ME)).toBeNull();
    /* RED WHEN: the committee's size is not compared with the company's own roster. */
    expect(whyNotHandOver({ ...a, committee: { committee: [k(1)], threshold: 1 } }, k(1), account, ME))
      .toMatch(/has 1 key\(s\) and the company's own roster names 2/);
    expect(whyNotHandOver({ ...a, committee: null, why: 'no committee yet.' }, k(1), account, ME)).toBe('no committee yet.');
  });

  it('A COMMITTEE CARRYING A KEY THE ROSTER DOES NOT NAME - ONE THE SERVICE CHOSE - IS NOT HANDED THE ACCOUNT', async () => {
    const substituted = answer({ committee: { committee: [k(1), k(7)], threshold: 2 } });
    /* RED WHEN: the device takes the service's committee on its size and its own key alone - it then hands the
     * account to a key the service chose in the other signer's place. */
    expect(whyNotHandOver(substituted, k(1), account, ME)).toMatch(/1 key\(s\) the company's own roster does not name/);
    const calls = await shown(substituted);
    fireEvent.click(document.querySelector('[data-hand-over-account]')!);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls).not.toContain('POST /api/accounts/acc_1/authority/handover');
    expect(document.querySelector('.err:not([data-every-signer-needed])')!.textContent).toMatch(/roster does not name/);
    /* RED WHEN: one key named twice passes as two signers. */
    expect(whyNotHandOver(answer({ committee: { committee: [k(1), k(1)], threshold: 2 } }), k(1), account, ME))
      .toMatch(/names one key twice/);
  });

  it('NOBODY CAN PUT A KEY IN ANOTHER SIGNER\'S NAME: a roster entry whose keys another signer signed names nothing', () => {
    /* Bo's entry carries a key signed with Ada's roster key - what whoever wrote it first would put there. */
    const forged = { ...account, signers: [account.signers[0], entry('s2', 'bo', 'Bo Diddley', BO, 7, ADA)] } as unknown as Account;
    const a = answer({ committee: { committee: [k(1), k(7)], threshold: 2 } });
    /* RED WHEN: the signature over an entry's keys is not checked against that entry's own signing key. */
    expect(whyNotHandOver(a, k(1), forged, ME)).toMatch(/1 of this company's 2 signers has not set up vault keys that the company's own roster says are theirs/);
    expect(seatWords({ key: k(7), onTheCompanysCommittee: true }, forged, ME)).toBe('a key nobody now on this company gave');
  });

  it('THIS PERSON\'S OWN ROSTER ENTRY MUST CARRY THE KEY THEIR WALLET GIVES', () => {
    /* RED WHEN: the wallet's key is accepted on the committee although the roster names it as somebody else's. */
    expect(whyNotHandOver(answer(), k(2), account, ME)).toMatch(/roster does not carry the key your wallet gives/);
  });

  it('names a seat the roster names nobody for plainly, and takes no holder from the service', () => {
    /* RED WHEN: `seatWords` names a holder the service reports rather than the roster. */
    expect(seatWords({ key: k(3), holder: 'bo', onTheCompanysCommittee: true }, account, ME))
      .toBe('a key nobody now on this company gave');
    expect(seatWords({ key: k(3), holder: null, onTheCompanysCommittee: false }, account, ME))
      .toBe('a key nobody now on this company gave - not on the company\'s committee');
    expect(seatWords({ key: k(2), onTheCompanysCommittee: true }, account, ME)).toBe('Bo Diddley');
    expect(seatWords({ key: k(1), onTheCompanysCommittee: true }, account, ME)).toBe('Ada Lovelace (you)');
  });
});

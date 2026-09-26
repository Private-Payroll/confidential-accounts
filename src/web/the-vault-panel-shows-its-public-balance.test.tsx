// @vitest-environment jsdom
/**
 * **THE VAULT'S SCREEN SHOWS EVERY PUBLIC TOKEN THE VAULT HOLDS, AND SAYS SO
 * WHEN IT CANNOT READ THEM.**
 *
 * The company's service reads the balance off the vault's state and sends it
 * with the vault's view. §1 is the page's reading of what was sent: a list of
 * tokens and whole amounts is a reading, an empty list is a vault holding no
 * public money, and anything else is unreadable, never nothing. §2 is the
 * screen: the balance is read when asked and shown line by line.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Account } from '../core/types.js';
import type { Hex } from '../core/crypto.js';
import { assets, formatAmount, ledgerTokenOf } from '../core/assets.js';
import { PUBLIC_BALANCE_UNREAD, publicHoldingsFromView, readPublicHoldings, sayPublicHoldings } from './device-vault-holdings.js';

const VAULT = '99'.repeat(32) as Hex;
const NIGHT = ledgerTokenOf('NIGHT', 'unshielded').toLowerCase().replace(/^0x/u, '');
const UNLISTED = 'cd'.repeat(32);

const page = vi.hoisted(() => ({
  chain: (async () => ({})) as (vault: string) => Promise<unknown>, asked: [] as string[], state: 'held-by-committee',
}));
vi.mock('./keyring.js', () => ({
  api: async (path: string) => {
    if (path.endsWith('/vaults')) {
      return { rows: [{ vault: '99'.repeat(32), deployedAt: '2026-09-01T00:00:00Z', state: page.state, why: null }] };
    }
    if (path.endsWith('/vault-keys')) return { committee: null, why: 'not every signer has given keys' };
    if (path.endsWith('/authority')) return { everySignerNeeded: null };
    return {};
  },
  currentUser: () => null,
}));
vi.mock('./Auth.js', () => ({ WALLET_ORIGIN: '' }));
vi.mock('./vault-worker-client.js', () => ({ startVaultBuilder: async () => ({}) }));
vi.mock('../core/account.js', async (original) => ({
  ...(await original<typeof import('../core/account.js')>()),
  openAccount: () => ({}),
}));
vi.mock('../core/vault-keys.js', async (original) => ({
  ...(await original<typeof import('../core/vault-keys.js')>()),
  rosterVaultKeys: () => [],
}));
vi.mock('./vault-page-doors.js', async (original) => ({
  ...(await original<typeof import('./vault-page-doors.js')>()),
  vaultServiceFor: () => ({ chain: (vault: string) => { page.asked.push(vault); return page.chain(vault); } }),
}));

const { VaultPanel } = await import('./VaultPanel.js');

const account = { id: 'acc_1', name: 'Northwind', signers: [], policy: { threshold: 1 } } as unknown as Account;
const me = { signerId: 'sgn_1', signingSecret: '11'.repeat(32) as Hex, wrappingSecret: '22'.repeat(32) as Hex };
const night = assets.require('NIGHT');

afterEach(() => { cleanup(); page.asked.length = 0; page.state = 'held-by-committee'; });

describe('§1 what the service sent, read on the page', () => {
  it('is every token and its whole amount', () => {
    const answer = publicHoldingsFromView({ onChain: true, publicBalances: [{ token: NIGHT, amount: '12500000' }, { token: UNLISTED, amount: '7' }] });
    /* RED WHEN an amount is read through a float, or a token dropped. */
    expect(answer).toEqual({ of: 'held', holdings: [{ token: NIGHT, amount: 12_500_000n }, { token: UNLISTED, amount: 7n }] });
  });

  it('an empty list is a vault holding no public money', () => {
    /* RED WHEN an empty list is shown as unreadable. */
    expect(sayPublicHoldings(publicHoldingsFromView({ onChain: true, publicBalances: [] })))
      .toEqual(['This vault holds no money publicly. Money put in privately is not counted here.']);
  });

  it.each([
    ['no list and the service\'s reason', { onChain: true, publicBalancesWhy: 'the state carries no balance' }, /the state carries no balance/u],
    ['no list and no reason', { onChain: true }, /did not say what this vault holds in public money/u],
    ['a vault the chain does not show', { onChain: false, publicBalances: [] }, /not on the chain yet/u],
    ['an amount that is not a whole number', { onChain: true, publicBalances: [{ token: NIGHT, amount: '1.5' }] }, /cannot read/u],
    ['an amount sent as a number', { onChain: true, publicBalances: [{ token: NIGHT, amount: 15 }] }, /cannot read/u],
    ['a token that is not a colour', { onChain: true, publicBalances: [{ token: 'NIGHT', amount: '1' }] }, /cannot read/u],
  ])('is UNREADABLE, never nothing, for %s', (_why, view, reason) => {
    const answer = publicHoldingsFromView(view);
    /* RED WHEN anything but a readable list is shown as a balance, or as zero. */
    expect(answer.of).toBe('unreadable');
    expect(sayPublicHoldings(answer)).toEqual([PUBLIC_BALANCE_UNREAD]);
    /* RED WHEN the reason is lost from the answer, where a log or a support question reads it. */
    expect(answer.of === 'unreadable' && answer.why).toMatch(reason);
  });

  it('a service that could not be asked is unreadable', async () => {
    /* RED WHEN a failed ask is shown as an empty vault. */
    expect(await readPublicHoldings(async () => { throw new Error('the service did not answer'); }))
      .toEqual({ of: 'unreadable', why: 'this page could not reach the company\'s service: the service did not answer' });
  });

  it('names a listed token in its asset and still counts one no asset names', () => {
    const lines = sayPublicHoldings({ of: 'held', holdings: [{ token: NIGHT, amount: 12_500_000n }, { token: UNLISTED, amount: 7n }] });
    /* RED WHEN the asset's decimals are ignored, or an unlisted token is left off the screen. */
    expect(lines).toEqual([
      `${formatAmount(12_500_000n, night)} NIGHT, held publicly`,
      '7 units of a currency this service does not recognise, held publicly',
      'Anyone can look up money held publicly.',
    ]);
  });

  it('the line for a balance it could not read never reads as an amount or as none', () => {
    /* RED WHEN the unread line is reworded into a zero or an empty vault. */
    expect(PUBLIC_BALANCE_UNREAD).toBe('What this vault holds publicly could not be read, so no amount is shown. That does not mean it holds nothing.');
  });
});

describe('§2 the vault\'s screen', () => {
  const shown = () => [...document.querySelectorAll('[data-public-balance-line]')].map((e) => e.textContent);
  const open = async () => {
    const view = render(<VaultPanel account={account} me={me} viewingKey={'aa'.repeat(32) as Hex} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return view;
  };
  const press = async () => {
    await act(async () => {
      fireEvent.click(document.querySelector('[data-read-public-balance]')!);
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  it('shows each public token the vault holds, read when asked', async () => {
    page.chain = async () => ({ onChain: true, publicBalances: [{ token: NIGHT, amount: '12500000' }, { token: UNLISTED, amount: '7' }] });
    await open();
    /* RED WHEN the balance is read before anybody asks, or shown before it was read. */
    expect(page.asked).toEqual([]);
    expect(shown()).toEqual([]);
    await press();
    /* RED WHEN the screen drops the button's answer, or shows one token only. */
    expect(page.asked).toEqual([VAULT]);
    expect(shown()).toEqual([
      `${formatAmount(12_500_000n, night)} NIGHT, held publicly`,
      '7 units of a currency this service does not recognise, held publicly',
      'Anyone can look up money held publicly.',
      expect.stringMatching(/^Read at .+\. Press again after money moves\.$/u),
    ]);
  });

  it('takes the figure off the screen once money may have moved', async () => {
    page.chain = async () => ({ onChain: true, publicBalances: [{ token: NIGHT, amount: '1' }] });
    await open();
    await press();
    expect(shown().length).toBeGreaterThan(0);
    /* A press that can move money: it fails here, having no wallet, and the figure still goes. */
    await act(async () => {
      fireEvent.click(document.querySelector('[data-check-last-deposit]')!);
      await new Promise((r) => setTimeout(r, 0));
    });
    /* RED WHEN a figure read before a deposit stays on the screen after it. */
    expect(shown()).toEqual([]);
  });

  it('is not offered for a vault the chain does not show or could not be asked about', async () => {
    for (const state of ['not-on-chain-yet', 'unknown']) {
      page.state = state;
      await open();
      /* RED WHEN the button is offered where there is no vault on the chain to read. */
      expect(document.querySelector('[data-read-public-balance]'), state).toBeNull();
      cleanup();
    }
  });

  it('is not pressed twice while it is reading', async () => {
    let answer: (v: unknown) => void = () => {};
    page.chain = () => new Promise((r) => { answer = r; });
    await open();
    await act(async () => { fireEvent.click(document.querySelector('[data-read-public-balance]')!); });
    const button = document.querySelector('[data-read-public-balance]') as HTMLButtonElement;
    /* RED WHEN the button stays live during a read, so two reads race to the screen. */
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Reading…');
    await act(async () => { answer({ onChain: true, publicBalances: [] }); await new Promise((r) => setTimeout(r, 0)); });
    expect((document.querySelector('[data-read-public-balance]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('says so when it cannot read it, and shows no amount', async () => {
    page.chain = async () => ({ onChain: true, publicBalancesWhy: 'the state carries no balance this client can read' });
    await open();
    await press();
    /* RED WHEN an unreadable balance is shown as zero, as an empty vault, or not at all. */
    expect(shown()).toEqual([PUBLIC_BALANCE_UNREAD, expect.stringMatching(/^Read at /u)]);
  });

  it('says so when the service cannot be asked', async () => {
    page.chain = async () => { throw new Error('the service did not answer'); };
    await open();
    await press();
    /* RED WHEN a failed read throws past the screen and leaves it saying nothing. */
    expect(shown()).toEqual([PUBLIC_BALANCE_UNREAD, expect.stringMatching(/^Read at /u)]);
  });
});

import { describe, it, expect } from 'vitest';
import { parseAsk } from 'midnight-identity/profile/request';
import type { BalanceRequest } from 'midnight-identity/profile/request';
import { balancedAnswerFor } from 'midnight-identity/profile/balance';
import { READY_PING } from 'midnight-identity/profile/channel';
import { askWalletToPay, balanceAsk, WalletDidNotPay } from './wallet-balance.js';
import type { Openable, WalletWindow } from './wallet-sign-in.js';

/* The page's side of a balance ask: what it sends, and what it believes. */
const WALLET = 'https://wallet.example';
const US = 'https://payroll.example';
const CO = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';

const walletAnswering = (answer: (ask: unknown) => unknown): { view: Openable; asked: unknown[] } => {
  const asked: unknown[] = [];
  const listeners: ((e: MessageEvent) => void)[] = [];
  const wallet: WalletWindow = {
    closed: false,
    postMessage: (message: unknown) => {
      asked.push(message);
      queueMicrotask(() => listeners.forEach((l) => l({ origin: WALLET, source: wallet, data: answer(message) } as unknown as MessageEvent)));
    },
    close: () => {},
    focus: () => {},
  } as unknown as WalletWindow;
  const view = {
    open: () => { queueMicrotask(() => listeners.forEach((l) => l({ origin: WALLET, source: wallet, data: { schema: READY_PING } } as unknown as MessageEvent))); return wallet; },
    addEventListener: (_t: string, l: (e: MessageEvent) => void) => { listeners.push(l); },
    removeEventListener: () => {},
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
    clearTimeout: (t: unknown) => clearTimeout(t as never),
  } as unknown as Openable;
  return { view, asked };
};
const input = { company: CO, vault: VAULT, transaction: 'AAECAw==', atOrigin: US, name: 'Us', rdns: 'example.us', nonce: 'n1', now: () => 1_000 };

describe('ASKING THE PERSON\'S WALLET TO PAY', () => {
  it('sends a balance ask with no amount in it, which the wallet\'s own parser accepts', () => {
    const wire = balanceAsk({ ...input, purpose: 'p', expiresAt: 2_000 });
    expect(Object.keys(wire).sort()).toEqual(['company', 'expiresAt', 'kind', 'nonce', 'purpose', 'requester', 'schema', 'transaction', 'vault']);
    const parsed = parseAsk(wire, US, 1_000) as BalanceRequest;
    expect(parsed.kind).toBe('balance');
    expect(parsed.transaction).toBe('AAECAw==');
  });

  it('believes an answer to its own question, and nothing else', async () => {
    const good = walletAnswering((ask) => balancedAnswerFor(parseAsk(ask, US, 1_000) as BalanceRequest, 'Zg==', [{ token: 'ab'.repeat(32), amount: '5', kind: 'shielded' }], 1_000));
    await expect(askWalletToPay(good.view, WALLET, input)).resolves.toEqual({
      transaction: 'Zg==', leaves: [{ token: 'ab'.repeat(32), amount: '5', kind: 'shielded' }],
    });
    const other = walletAnswering((ask) => ({ ...balancedAnswerFor(parseAsk(ask, US, 1_000) as BalanceRequest, 'Zg==', [], 1_000), vault: CO }));
    await expect(askWalletToPay(other.view, WALLET, input)).rejects.toBeInstanceOf(WalletDidNotPay);
  });
});

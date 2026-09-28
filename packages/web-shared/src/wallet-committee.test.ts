import { describe, it, expect } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { parseAsk, type CommitteeRequest } from 'midnight-identity/profile/request';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { committeeSignaturesFor } from 'midnight-identity/profile/committee-sign';
import { READY_PING } from 'midnight-identity/profile/channel';
import { askWalletToSignCommittee, committeeAsk, WalletDidNotSign } from './wallet-committee.js';
import type { Openable, WalletWindow } from './wallet-sign-in.js';

/* The page's side of a committee change: what it sends, and what it believes of the answer. */
const WALLET = 'https://wallet.example';
const US = 'https://payroll.example';
const CO = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
const identity = identityFromWords(TEST_MNEMONIC);
const mine = committeeKeyFor(identity, CO);
const other = { tag: 'schnorr', value: 'ee'.repeat(32) };

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
const to = { committee: [mine, other].sort((a, b) => (a.value < b.value ? -1 : 1)), threshold: 2 };
const contracts = [{ contract: 'vault' as const, address: VAULT, counter: '2', now: { committee: [mine], threshold: 1 } }];
const input = { company: CO, to, contracts, atOrigin: US, name: 'Us', rdns: 'example.us', nonce: 'n1', now: () => 1_000 };
/** The wallet's own parser and signer, answering the ask as it arrives. */
const honestly = (ask: unknown) => committeeSignaturesFor(L as never, identity, parseAsk(ask, US, 1_000) as CommitteeRequest, 1_000);

describe('ASKING THE PERSON\'S WALLET TO SIGN A COMMITTEE CHANGE', () => {
  it('sends an ask with no bytes to sign in it, which the wallet\'s own parser accepts', () => {
    const wire = committeeAsk({ ...input, purpose: 'p', expiresAt: 2_000 });
    expect(Object.keys(wire).sort()).toEqual(['company', 'contracts', 'expiresAt', 'kind', 'nonce', 'purpose', 'requester', 'schema', 'to']);
    expect((parseAsk(wire, US, 1_000) as CommitteeRequest).kind).toBe('committee');
  });

  it('BELIEVES AN ANSWER TO ITS OWN QUESTION, AND NOTHING ELSE', async () => {
    const good = walletAnswering(honestly);
    const read = await askWalletToSignCommittee(good.view, WALLET, input);
    expect(read.signer).toEqual({ tag: 'schnorr', value: mine.value });
    expect(read.signatures.map((s) => [s.address, s.counter, s.seat])).toEqual([[VAULT, '2', 0]]);
    /* RED WHEN: an answer signing another committee, another company, another nonce or another counter is taken. */
    for (const bend of [
      (a: any) => ({ ...a, to: { ...a.to, threshold: 1 } }),
      (a: any) => ({ ...a, company: VAULT }),
      (a: any) => ({ ...a, nonce: 'n2' }),
      (a: any) => ({ ...a, signatures: a.signatures.map((s: any) => ({ ...s, counter: '3' })) }),
    ]) {
      const bent = walletAnswering((ask) => bend(JSON.parse(JSON.stringify(honestly(ask)))));
      await expect(askWalletToSignCommittee(bent.view, WALLET, input)).rejects.toBeInstanceOf(WalletDidNotSign);
    }
  });
});

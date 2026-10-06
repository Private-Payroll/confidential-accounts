import { describe, it, expect } from 'vitest';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { parseAsk, type JoinCodeRequest } from 'midnight-identity/profile/request';
import { joinCodeAnswerFor, signJoinCode } from 'midnight-identity/profile/join-code';
import { READY_PING } from 'midnight-identity/profile/channel';
import { askWalletForAJoinCode, WalletDidNotMakeTheCode } from './wallet-join-code.js';
import type { Openable, WalletWindow } from './wallet-sign-in.js';

/* The page's side of a join-code ask: what it sends, and what it believes of the answer. */
const WALLET = 'https://wallet.example';
const US = 'https://payroll.example';
const CO = `co_${'e6'.repeat(32)}` as CompanyLabel;
const identity = identityFromWords(TEST_MNEMONIC);
const PARTS = { kind: 'signer', signingPublicKey: '11'.repeat(32), wrappingPublicKey: '22'.repeat(32), leafCommitment: '33'.repeat(32) } as const;

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
const input = { company: CO, person: 'usr_ada', parts: PARTS, name: 'Us', rdns: 'example.us', now: () => 1_000 };

describe('ASKING THE PERSON\'S WALLET FOR A JOIN CODE', () => {
  it('SENDS AN ASK THE WALLET\'S OWN PARSER ACCEPTS, AND BELIEVES THE CODE IT SIGNED FOR EXACTLY WHAT WAS ASKED', async () => {
    const honest = walletAnswering((ask) => joinCodeAnswerFor(identity, parseAsk(ask, US, 1_000) as JoinCodeRequest, [], null));
    const code = await askWalletForAJoinCode(honest.view, WALLET, input);
    expect(code).toMatchObject({ company: CO, person: 'usr_ada', parts: PARTS });
  });

  it('REFUSES A CODE FOR OTHER KEYS, ANOTHER SIGN-IN, OR ONE NOBODY SIGNED', async () => {
    const answers = [
      signJoinCode(identity, CO, 'usr_ada', { ...PARTS, signingPublicKey: '44'.repeat(32) }),
      signJoinCode(identity, CO, 'usr_mallory', PARTS),
      { ...signJoinCode(identity, CO, 'usr_ada', PARTS), signature: '00'.repeat(64) },
    ];
    /* RED WHEN: the page believes a code its wallet signed for something other than what it asked. */
    for (const a of answers) await expect(askWalletForAJoinCode(walletAnswering(() => a).view, WALLET, input)).rejects.toBeInstanceOf(WalletDidNotMakeTheCode);
  });
});

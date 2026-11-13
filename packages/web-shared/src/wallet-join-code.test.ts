import { describe, it, expect } from 'vitest';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
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
const ACCOUNT = 'ab'.repeat(32) as AccountAddress;
const input = { company: CO, account: ACCOUNT, person: 'usr_ada', parts: PARTS, name: 'Us', rdns: 'example.us', now: () => 1_000 };

describe('ASKING THE PERSON\'S WALLET FOR A JOIN CODE', () => {
  it('SENDS AN ASK THE WALLET\'S OWN PARSER ACCEPTS, AND BELIEVES THE CODE IT SIGNED FOR EXACTLY WHAT WAS ASKED', async () => {
    /* A wallet signing exactly what it was asked, as its own parser read it; the wallet's own window makes no seat's code. */
    const honest = walletAnswering((ask) => {
      const read = parseAsk(ask, US, 1_000) as JoinCodeRequest;
      return signJoinCode(identity, read.company, read.person, read.parts as typeof PARTS);
    });
    const code = await askWalletForAJoinCode(honest.view, WALLET, input);
    expect(code).toMatchObject({ company: CO, person: 'usr_ada', parts: PARTS });
    /* RED WHEN: the ask leaves out the company's account, so the wallet's code screen has no fingerprint to show. */
    expect((parseAsk(honest.asked[0], US, 1_000) as JoinCodeRequest).account).toBe(ACCOUNT);
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

  it('ASKS FOR A READER\'S CODE WITH NO KEY, AND BELIEVES ONLY A READER\'S CODE BACK FOR THAT PERSON AND COMPANY', async () => {
    const OWN = '55'.repeat(32);
    const reader = { ...input, parts: { kind: 'reader' } as const };
    const honest = walletAnswering((ask) => joinCodeAnswerFor(identity, parseAsk(ask, US, 1_000) as JoinCodeRequest, [], null, OWN));
    expect(await askWalletForAJoinCode(honest.view, WALLET, reader)).toMatchObject({ person: 'usr_ada', parts: { kind: 'reader', readerKey: OWN } });
    /* RED WHEN: the page's ask names a key, which the wallet refuses, so no reader could ever be given a code. */
    expect((parseAsk(honest.asked[0], US, 1_000) as JoinCodeRequest).parts).toEqual({ kind: 'reader' });
    /* RED WHEN: a reader's ask believes a signer's or payee's code back, or one for another sign-in. */
    for (const a of [signJoinCode(identity, CO, 'usr_ada', PARTS), signJoinCode(identity, CO, 'usr_mallory', { kind: 'reader', readerKey: OWN })]) {
      await expect(askWalletForAJoinCode(walletAnswering(() => a).view, WALLET, reader)).rejects.toBeInstanceOf(WalletDidNotMakeTheCode);
    }
  });
});


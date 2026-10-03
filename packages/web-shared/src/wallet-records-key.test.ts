import { describe, it, expect } from 'vitest';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { parseAsk, type RecordsKeyRequest } from 'midnight-identity/profile/request';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { recordsKeyAnswerFor, recordsKeySignedBy } from 'midnight-identity/profile/records-key';
import { READY_PING } from 'midnight-identity/profile/channel';
import { askWalletToSignRecordsKey } from './wallet-records-key.js';
import type { Openable, WalletWindow } from './wallet-sign-in.js';

/* The page's side of a records-key ask: what it sends, and what it believes of the answer. */
const WALLET = 'https://wallet.example';
const US = 'https://payroll.example';
const CO = 'co_1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071' as CompanyLabel;
const ACCOUNT = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e' as VaultAddress;
const SEAT = '5a'.repeat(32);
const identity = identityFromWords(TEST_MNEMONIC);
const mine = committeeKeyFor(identity, CO) as { tag: string; value: string };
/* Who holds the account and the vault, as the wallet reads them off the chain. */
const SEATS = { committee: [mine], threshold: 1, seats: [SEAT] };
const HELD = { vault: VAULT as string, account: ACCOUNT as string, committee: [mine], threshold: 1 };

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
/** The wallet's own parser and answer, as it would answer the ask that arrives. */
const honestly = (ask: unknown) => recordsKeyAnswerFor(identity, parseAsk(ask, US, 1_000) as RecordsKeyRequest, SEATS, 1_000, HELD);
const input = { company: CO, account: ACCOUNT, seat: SEAT.toUpperCase(), atOrigin: US, name: 'Us', rdns: 'example.us', nonce: 'n1', now: () => 1_000 };

describe('ASKING THE PERSON\'S WALLET TO SIGN THEIR RECORDS KEY, AND TO SAY WHO HOLDS THE COMPANY AND ITS VAULT', () => {
  it('sends an ask the wallet\'s own parser accepts, naming the vault only when one is asked about', async () => {
    const plain = walletAnswering(honestly);
    const read = await askWalletToSignRecordsKey(plain.view, WALLET, input);
    const sent = plain.asked[0] as Record<string, unknown>;
    /* RED WHEN: the seat travels in another spelling than the one the wallet signs, or a vault is named when none was asked about. */
    expect(sent['seat']).toBe(SEAT);
    expect('vault' in sent).toBe(false);
    expect(recordsKeySignedBy(CO, read.committeeKey, read.statement)).toBe(true);
    expect(read.vault).toBeNull();

    const withVault = walletAnswering(honestly);
    const both = await askWalletToSignRecordsKey(withVault.view, WALLET, { ...input, vault: VAULT.toUpperCase() as VaultAddress });
    /* RED WHEN: the vault asked about is not on the wire, or what the wallet read of it does not come back. */
    expect((withVault.asked[0] as Record<string, unknown>)['vault']).toBe(VAULT);
    expect((parseAsk(withVault.asked[0], US, 1_000) as RecordsKeyRequest).vault).toBe(VAULT);
    expect(both.vault).toEqual(HELD);
    expect(both.seats).toEqual(SEATS);
  });

  it('BELIEVES AN ANSWER TO ITS OWN QUESTION, AND NOTHING ELSE', async () => {
    /* RED WHEN: an answer about another vault, about none, for another seat, to another nonce or from another page is taken. */
    for (const [why, bend, code] of [
      ['another vault', (a: any) => ({ ...a, vault: { ...a.vault, vault: 'ee'.repeat(32) } }), 'not-an-answer'],
      ['no vault', (a: any) => ({ ...a, vault: undefined }), 'not-an-answer'],
      ['another seat', (a: any) => ({ ...a, statement: { ...a.statement, seat: '6b'.repeat(32) } }), 'not-signed'],
      ['another nonce', (a: any) => ({ ...a, nonce: 'n2' }), 'nonce-mismatch'],
      ['another page', (a: any) => ({ ...a, origin: 'https://elsewhere.example' }), 'origin-mismatch'],
    ] as const) {
      const bent = walletAnswering((ask) => bend(JSON.parse(JSON.stringify(honestly(ask)))));
      const e = await askWalletToSignRecordsKey(bent.view, WALLET, { ...input, vault: VAULT }).catch((x: Error) => x);
      expect((e as Error).name, why).toBe('WalletDidNotSignRecordsKey');
      /* Each refused by its own check. */
      expect((e as { code?: string }).code, why).toBe(code);
    }
  });
});

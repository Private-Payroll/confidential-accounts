import { describe, it, expect } from 'vitest';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { parseAsk, type HoldersRequest, type RecordsKeyRequest } from 'midnight-identity/profile/request';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { holdersAnswerFor, recordsKeyAnswerFor, recordsKeySignedBy } from 'midnight-identity/profile/records-key';
import { READY_PING } from 'midnight-identity/profile/channel';
import { askWalletForAddressesAndBalances, askWalletToSignRecordsKey, askWalletWhoHolds } from './wallet-records-key.js';
import { addressesAndBalancesAnswerFor, type AddressesAndBalancesShown } from 'midnight-identity/profile/addresses-and-balances';
import type { AddressesAndBalancesRequest } from 'midnight-identity/profile/request';
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
/* As a wallet that kept this account for the company answers. */
const honestly = (ask: unknown) => recordsKeyAnswerFor(identity, parseAsk(ask, US, 1_000) as RecordsKeyRequest, SEATS, 1_000, HELD, ACCOUNT);
const input = { company: CO, account: ACCOUNT, seat: SEAT.toUpperCase(), atOrigin: US, name: 'Us', rdns: 'example.us', nonce: 'n1', now: () => 1_000 };

describe('ASKING THE PERSON\'S WALLET TO SIGN THEIR RECORDS KEY, AND TO SAY WHO HOLDS THE COMPANY AND ITS VAULT', () => {
  it('sends an ask the wallet\'s own parser accepts, naming the vault only when one is asked about', async () => {
    const plain = walletAnswering(honestly);
    const read = await askWalletToSignRecordsKey(plain.view, WALLET, input);
    const sent = plain.asked[0] as Record<string, unknown>;
    /* RED WHEN: the seat travels in another spelling than the one the wallet signs, or a vault is named when none was asked about. */
    expect(sent['seat']).toBe(SEAT);
    expect('vault' in sent).toBe(false);
    expect(recordsKeySignedBy(CO, ACCOUNT, read.committeeKey, read.statement)).toBe(true);
    expect(read.vault).toBeNull();

    const withVault = walletAnswering(honestly);
    const both = await askWalletToSignRecordsKey(withVault.view, WALLET, { ...input, vault: VAULT.toUpperCase() as VaultAddress });
    /* RED WHEN: the vault asked about is not on the wire, or what the wallet read of it does not come back. */
    expect((withVault.asked[0] as Record<string, unknown>)['vault']).toBe(VAULT);
    expect((parseAsk(withVault.asked[0], US, 1_000) as RecordsKeyRequest).vault).toBe(VAULT);
    expect(both.vault).toEqual(HELD);
    expect(both.seats).toEqual(SEATS);
  });

  it('HANDS THE WALLET THE INVITATION IT IS GIVEN, WHOLE, SO A WALLET THAT KEPT NO ACCOUNT CAN KEEP THE ONE IT NAMES', async () => {
    const invitedBy = { committeeKey: { tag: 'schnorr' as const, value: '1d'.repeat(32) }, statement: { account: ACCOUNT as string, signingKey: '2b'.repeat(32), wrappingKey: '3c'.repeat(32), seat: '7c'.repeat(32), signature: '4d'.repeat(64) } };
    const w = walletAnswering(honestly);
    await askWalletToSignRecordsKey(w.view, WALLET, { ...input, invitedBy });
    /* RED WHEN: the invitation is dropped or changed on the way, and the wallet cannot tell which account the inviter named. */
    expect((parseAsk(w.asked[0], US, 1_000) as RecordsKeyRequest).invitedBy).toEqual(invitedBy);
    const plain = walletAnswering(honestly);
    await askWalletToSignRecordsKey(plain.view, WALLET, input);
    expect('invitedBy' in (plain.asked[0] as object)).toBe(false);
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

describe('ASKING THE PERSON\'S WALLET WHERE IT RECEIVES AND WHAT IT HOLDS', () => {
  const SHOWN: AddressesAndBalancesShown = {
    addresses: { private: `mn_shield-addr_test1${'q'.repeat(60)}`, public: `mn_addr_test1${'p'.repeat(60)}` },
    balances: [{ token: '00'.repeat(32), amount: '5', visibility: 'private' }, { token: '00'.repeat(32), amount: '9', visibility: 'public' }],
    read: { private: 900, public: 950 },
  };
  const showing = (ask: unknown) => addressesAndBalancesAnswerFor(parseAsk(ask, US, 1_000) as AddressesAndBalancesRequest, SHOWN, 1_000);
  const asked = { atOrigin: US, name: 'Us', rdns: 'example.us', nonce: 'n9', now: () => 1_000 };

  it('sends an ask the wallet\'s own parser takes, carrying nothing that chooses the wallet, and hands back what the wallet showed', async () => {
    const w = walletAnswering(showing);
    const got = await askWalletForAddressesAndBalances(w.view, WALLET, asked);
    /* RED WHEN: the ask names anything beyond what every ask carries, or the page reads back other than what was shown. */
    expect(Object.keys(w.asked[0] as object).sort()).toEqual(['expiresAt', 'kind', 'nonce', 'purpose', 'requester', 'schema']);
    expect((parseAsk(w.asked[0], US, 1_000) as AddressesAndBalancesRequest).kind).toBe('addresses-and-balances');
    expect(got).toEqual({ shown: SHOWN, at: 1_000 });
  });

  it('BELIEVES ONLY AN ANSWER TO ITS OWN QUESTION, SHOWN TO THIS PAGE', async () => {
    for (const [why, bend, code] of [
      ['another nonce', (a: any) => ({ ...a, nonce: 'n2' }), 'nonce-mismatch'],
      ['another page', (a: any) => ({ ...a, origin: 'https://elsewhere.example' }), 'origin-mismatch'],
      ['a figure for a side not read', (a: any) => ({ ...a, read: { private: null, public: 950 } }), 'not-an-answer'],
    ] as const) {
      const bent = walletAnswering((ask) => bend(JSON.parse(JSON.stringify(showing(ask)))));
      const e = await askWalletForAddressesAndBalances(bent.view, WALLET, asked).catch((x: Error) => x);
      /* RED WHEN: the named answer is believed. */
      expect((e as Error).name, why).toBe('WalletDidNotShowAddressesAndBalances');
      expect((e as { code?: string }).code, why).toBe(code);
    }
  });
});

describe('ASKING THE PERSON\'S WALLET WHAT THE COMPANY\'S ACCOUNT HOLDS UNDER SOME OF ITS ROLES', () => {
  const HOLDERS = { ...SEATS, approvals: 1, adoptedVaults: [], founding: SEAT, foundingCommittee: [mine] };
  const asked = ['d4'.repeat(32), 'a1'.repeat(32)];
  const held = (key: string) => (key === asked[0] ? 'ee'.repeat(32) : null);
  const answering = (withRoles: boolean) => (ask: unknown) => {
    const request = parseAsk(ask, US, 1_000) as HoldersRequest;
    return holdersAnswerFor(request, HOLDERS, 1_000, undefined, undefined,
      withRoles ? (request.roles ?? []).map((key) => ({ key, value: held(key) })) : undefined);
  };
  const whoHolds = { company: CO, account: ACCOUNT, atOrigin: US, name: 'Us', rdns: 'example.us', nonce: 'n2', now: () => 1_000 };

  it('sends the entries asked in an ask the wallet\'s own parser takes, and hands back what the wallet read under each, in the order asked', async () => {
    const w = walletAnswering(answering(true));
    const read = await askWalletWhoHolds(w.view, WALLET, { ...whoHolds, roles: asked });
    /* RED WHEN: the entries are not on the wire, or the wallet's parser does not take them as asked. */
    expect((w.asked[0] as Record<string, unknown>)['roles']).toEqual(asked);
    expect((parseAsk(w.asked[0], US, 1_000) as HoldersRequest).roles).toEqual(asked);
    /* RED WHEN: what the wallet read under each entry does not come back, or comes back in another order. */
    expect(read.roles).toEqual([{ key: asked[0], value: 'ee'.repeat(32) }, { key: asked[1], value: null }]);
    const plain = walletAnswering(answering(false));
    const none = await askWalletWhoHolds(plain.view, WALLET, whoHolds);
    /* RED WHEN: an ask that names no entries carries the field, or its answer is read as holding some. */
    expect('roles' in (plain.asked[0] as Record<string, unknown>)).toBe(false);
    expect(none.roles).toBeUndefined();
  });

  it('BELIEVES NO ANSWER THAT LEAVES OUT THE ENTRIES IT ASKED ABOUT', async () => {
    /* A wallet that reads the account and says nothing of the entries asked: what a page must never take as "nothing held". */
    const w = walletAnswering((ask) => holdersAnswerFor({ ...(parseAsk(ask, US, 1_000) as HoldersRequest), roles: undefined } as HoldersRequest, HOLDERS, 1_000));
    /* RED WHEN: an answer silent about the entries asked is taken, so a vault's policy marker reads as absent. */
    await expect(askWalletWhoHolds(w.view, WALLET, { ...whoHolds, roles: asked })).rejects.toThrow(/does not say what the account holds under each of the entries asked about/u);
  });
});

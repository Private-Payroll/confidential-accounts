// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '../testing/render.js';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity/keys/derivation';
import { parseAsk } from 'midnight-identity/profile/request';
import type { RecordsKeyRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { recordsKeySignedBy, type RecordsKeyAnswer } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { LabelReader } from './company-on-chain.js';
import { ApproveRecordsKey, type VaultReader } from './approve-records-key.js';
import { Approve } from './approve.js';
import { secretFromWords } from 'midnight-identity/keys/derivation';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { watchedStore } from '../testing/settled-store.js';
import { watchedOpener } from '../testing/settled-channel.js';

/*
 * The screen a person sees when a company's page asks this wallet to sign their
 * records key for their seat: what is signed, the seat and whether the account
 * holds it now, one press, and an answer only after the press, carrying who
 * holds the account as this wallet read it.
 */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const ORIGIN = 'https://payroll-a.example';
const CO = 'co_1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071' as CompanyLabel;
const OTHER = 'co_54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e' as CompanyLabel;
const ACCOUNT = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
const SEAT = '5a'.repeat(32);
const mine = committeeKeyFor(identity, CO) as { tag: string; value: string };
const SEATS = { committee: [mine], threshold: 1, seats: ['6b'.repeat(32), SEAT] };
/* The chain, as this wallet reads it: the account carries the label, and its seats in the same read. */
const chain = (over: Partial<typeof SEATS> = {}, label: CompanyLabel = CO): LabelReader => async (account) =>
  (account === ACCOUNT ? { of: 'carries', label, seats: { ...SEATS, ...over } } : { of: 'no-account' });

const ask = (over: Record<string, unknown> = {}) => parseAsk({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'records-key',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' }, purpose: 'To check your records key.',
  nonce: 'r1', expiresAt: NOW + 600_000, company: CO, account: ACCOUNT, seat: SEAT, ...over,
}, ORIGIN, NOW) as RecordsKeyRequest;
const channelFor = (answers: unknown[]): Channel => ({
  answer: (a) => { answers.push(a); }, refuse: (r) => { answers.push({ refused: r }); }, stop: () => {},
} as Channel);
const consented = { ok: true } as never;
const settle = async () => { await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); }); };
const VAULT = '9a'.repeat(32);
/* The vault, as this wallet reads it: held by the person's committee key, pinned to the account the page names. */
const HOLDERS = { vault: VAULT, account: ACCOUNT as string, committee: [mine], threshold: 1 };
const vaultChain = (over: Partial<typeof HOLDERS> = {}): VaultReader => async (v) =>
  (v === VAULT ? { of: 'read', holders: { ...HOLDERS, ...over } } : { of: 'no-vault' });
const draw = async (answers: unknown[], readLabel: LabelReader, consent = consented, vault?: { readVault: VaultReader }, pinned: AccountAddress | null = null) => {
  const r = render(
    <ApproveRecordsKey request={vault === undefined ? ask() : ask({ vault: VAULT })} identity={identity} channel={channelFor(answers)} consent={consent}
      whoIsAsking={<p>asker</p>} onDecline={() => answers.push('declined')} now={() => NOW} readLabel={readLabel} pinned={pinned}
      {...(vault === undefined ? {} : { readVault: vault.readVault })} />);
  await settle();
  return r;
};
const button = (c: HTMLElement) => c.querySelector('[data-sign-records-key]') as HTMLButtonElement;

afterEach(() => { cleanup(); });

describe('THE SCREEN FOR SIGNING A RECORDS KEY FOR A SEAT', () => {
  it('SAYS WHAT IT SIGNS AND WHICH SEAT, AND ANSWERS ONLY AFTER THE PRESS WITH THE STATEMENT AND WHO HOLDS THE ACCOUNT', async () => {
    const answers: unknown[] = [];
    const { container } = await draw(answers, chain());
    /* RED WHEN: the screen does not say what it signs, or which seat, before the press. */
    expect(container.querySelector('[data-records-key-signs]')?.textContent).toMatch(/your records key belongs to this company, for the seat you hold/);
    expect(container.querySelector('[data-records-key-seat]')?.textContent).toBe(SEAT);
    expect(container.querySelector('[data-seat-held]')).not.toBeNull();
    const shown = container.querySelector('[data-records-key]')?.textContent;
    expect(answers).toEqual([]);
    expect(button(container).disabled).toBe(false);
    await act(async () => { fireEvent.click(button(container)); });
    expect(answers).toHaveLength(1);
    const answer = answers[0] as RecordsKeyAnswer;
    /* RED WHEN: the answer is not signed for this seat by this person's committee key, or drops who holds the account. */
    expect(answer.statement.seat).toBe(SEAT);
    /* RED WHEN: the records key signed is not the one the screen showed before the press. */
    expect(answer.statement.recordsKey).toBe(shown);
    expect(recordsKeySignedBy(CO, ACCOUNT, mine, answer.statement)).toBe(true);
    expect(answer.seats).toEqual(SEATS);
    expect(container.querySelector('[data-signed]')).not.toBeNull();
  });

  it('NOTHING IS SIGNED FOR AN ACCOUNT OTHER THAN THE ONE THIS WALLET PINNED FOR THE COMPANY WHEN IT CREATED IT', async () => {
    const answers: unknown[] = [];
    const { container } = await draw(answers, chain(), consented, undefined, 'a8'.repeat(32) as AccountAddress);
    await act(async () => { fireEvent.click(button(container)); });
    /* RED WHEN: a page naming another account carrying the label is answered with a statement for it. */
    expect(answers).toEqual([]);
    expect(container.querySelector('[data-records-key-refused]')?.textContent).toMatch(/kept as its account when you created it/);
  });

  it('A SEAT THE ACCOUNT DOES NOT HOLD NOW IS NOT SIGNED: the button stays held and nothing is answered', async () => {
    const answers: unknown[] = [];
    const { container } = await draw(answers, chain({ seats: ['6b'.repeat(32)] }));
    /* RED WHEN: the wallet offers to sign a seat somebody has left. */
    expect(container.querySelector('[data-seat-not-held]')).not.toBeNull();
    expect(button(container).disabled).toBe(true);
    fireEvent.click(button(container));
    expect(answers).toEqual([]);
  });

  it('A LABEL THE ACCOUNT DOES NOT CARRY IS NOT SIGNED FOR: the button stays held and nothing is answered', async () => {
    const answers: unknown[] = [];
    const { container } = await draw(answers, chain({}, OTHER));
    /* RED WHEN: the wallet signs for a company the account it read does not carry. */
    expect(button(container).disabled).toBe(true);
    fireEvent.click(button(container));
    expect(answers).toEqual([]);
  });

  it('WITHOUT CONSENT NOTHING IS SIGNED: the button stays held and nothing is answered', async () => {
    const answers: unknown[] = [];
    const { container } = await draw(answers, chain(), { ok: false, says: 'not consented' } as never);
    /* RED WHEN: the wallet signs on a page the person has not consented to answering. */
    expect(button(container).disabled).toBe(true);
    fireEvent.click(button(container));
    expect(answers).toEqual([]);
  });

  it('SEATS THE WALLET COULD NOT READ ARE SAID AS THAT, NOT AS STILL CHECKING, AND NOTHING IS SIGNED', async () => {
    const answers: unknown[] = [];
    const { container } = await draw(answers, async () => ({ of: 'unreadable', why: 'the indexer did not answer.' }) as never);
    /* RED WHEN: a read that failed is shown as one still under way, or the wallet offers to sign without seats. */
    expect(container.querySelector('[data-seat-checking]')).toBeNull();
    expect(container.querySelector('[data-seat-unread]')).not.toBeNull();
    expect(button(container).disabled).toBe(true);
    fireEvent.click(button(container));
    expect(answers).toEqual([]);
  });

  it('WITH A VAULT NAMED, THE ANSWER CARRIES WHO HOLDS THAT VAULT AS THIS WALLET READ IT, AND NOTHING IS SIGNED UNTIL IT IS READ', async () => {
    const answers: unknown[] = [];
    const { container } = await draw(answers, chain(), consented, { readVault: vaultChain() });
    expect(container.querySelector('[data-vault-read]')).not.toBeNull();
    await act(async () => { fireEvent.click(button(container)); });
    /* RED WHEN: the answer drops the vault, or carries anything but what this wallet read off it. */
    expect((answers[0] as RecordsKeyAnswer).vault).toEqual(HOLDERS);
    /* RED WHEN: a vault this wallet could not read is signed for anyway. */
    const unread: unknown[] = [];
    cleanup();
    const failed = await draw(unread, chain(), consented, { readVault: async () => ({ of: 'unreadable', why: 'offline' }) });
    expect(failed.container.querySelector('[data-vault-unread]')).not.toBeNull();
    expect(button(failed.container).disabled).toBe(true);
    fireEvent.click(button(failed.container));
    expect(unread).toEqual([]);
  });

  it('A VAULT PINNED TO ANOTHER COMPANY\'S ACCOUNT IS NOT SIGNED FOR, and the screen says why', async () => {
    const answers: unknown[] = [];
    const { container } = await draw(answers, chain(), consented, { readVault: vaultChain({ account: 'ad'.repeat(32) }) });
    /* RED WHEN: the wallet signs while the vault it read belongs to another company account. */
    expect(container.querySelector('[data-vault-other-account]')).not.toBeNull();
    expect(button(container).disabled).toBe(true);
    fireEvent.click(button(container));
    expect(answers).toEqual([]);
  });

  it('declining answers that it was declined, and nothing else', async () => {
    const answers: unknown[] = [];
    const { container } = await draw(answers, chain());
    fireEvent.click(container.querySelector('[data-decline]')!);
    expect(answers).toEqual(['declined']);
  });

  it('the wallet shows a records-key ask on this screen and on no other', async () => {
    /* RED WHEN: the wallet's approval screen does not route this kind of ask to its own screen. */
    const opener = watchedOpener();
    const handlers: ((event: MessageEvent) => void)[] = [];
    const view: ChannelWindow = {
      opener: opener as ChannelWindow['opener'],
      addEventListener: (_t, h) => { handlers.push(h); },
      removeEventListener: () => {},
    };
    const { container } = render(
      <Approve identity={identity} secret={secretFromWords(TEST_MNEMONIC)} port={watchedStore()} view={view} now={() => NOW} readLabel={chain()} />);
    const wire = {
      schema: 'midnight-identity/disclosure-request/v1', kind: 'records-key',
      requester: { name: 'Payroll A', rdns: 'example.payroll-a' }, purpose: 'To check your records key.',
      nonce: 'r1', expiresAt: NOW + 600_000, company: CO, account: ACCOUNT, seat: SEAT,
    };
    await act(async () => { for (const h of handlers) h({ source: opener, origin: ORIGIN, data: wire } as unknown as MessageEvent); });
    await settle();
    expect(container.querySelector('[data-sign-records-key]')).not.toBeNull();
    expect(container.querySelector('[data-records-key-seat]')?.textContent).toBe(SEAT);
  });
});

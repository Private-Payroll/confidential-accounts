// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '../testing/render.js';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromSecret, identityFromWords } from 'midnight-identity/keys/derivation';
import { parseAsk } from 'midnight-identity/profile/request';
import type { RecordsKeyRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import {
  INVITATION_REFUSAL, recordsKeySignedBy, seatBlinding, signDirectoryEntry, type RecordsKeyAnswer, type SeatOpening,
} from 'midnight-identity/profile/records-key';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { pinnedAccountOf } from 'midnight-identity/profile/model';
import { load } from 'midnight-identity/profile/store';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { LabelReader } from './company-on-chain.js';
import { ApproveRecordsKey, liveLeafReader, type VaultReader } from './approve-records-key.js';
import { Approve } from './approve.js';
import { secretFromWords } from 'midnight-identity/keys/derivation';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { watchedStore } from '../testing/settled-store.js';
import { THE_ANSWER, watchedOpener } from '../testing/settled-channel.js';

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
/* A seat made for `key` as a seating device makes one; its leaf is the account's own `signerLeaf`, run as this wallet runs it. */
const seatMadeFor = async (key: { tag: 'schnorr'; value: string }, salt: string): Promise<{ seat: string; opening: SeatOpening }> => {
  const opening: SeatOpening = { publicKey: '2c'.repeat(32), scope: '3d'.repeat(32), blinding: seatBlinding(key, salt), walletKey: key, salt };
  return { seat: await liveLeafReader(opening), opening };
};
/* The signer who invited this person: their wallet key, and their seat on the account. */
const inviter = identityFromSecret(new Uint8Array(32).fill(9));
const inviterKey = committeeKeyFor(inviter, CO) as { tag: 'schnorr'; value: string };
const { seat: INVITER_SEAT, opening: inviterOpening } = await seatMadeFor(inviterKey, '7c'.repeat(32));
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
/* A wallet that kept this account for the company - as its creator, or from its invitation - unless a test says otherwise. */
const draw = async (answers: unknown[], readLabel: LabelReader, consent = consented, vault?: { readVault: VaultReader }, pinned: AccountAddress | null = ACCOUNT) => {
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

  it('NOTHING IS SIGNED FOR AN ACCOUNT OTHER THAN THE ONE THIS WALLET KEPT FOR THE COMPANY', async () => {
    const answers: unknown[] = [];
    const { container } = await draw(answers, chain(), consented, undefined, 'a8'.repeat(32) as AccountAddress);
    await act(async () => { fireEvent.click(button(container)); });
    /* RED WHEN: a page naming another account carrying the label is answered with a statement for it. */
    expect(answers).toEqual([]);
    expect(container.querySelector('[data-records-key-refused]')?.textContent).toMatch(/other than the one this wallet kept as its account/);
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

  describe('A JOINING SIGNER\'S WALLET KEEPS THE ACCOUNT ITS SIGNED INVITATION NAMES, AND NO OTHER', () => {
    /* The signer who invited this person, as the signed invitation carries them, and as the chain holds them. */
    const invitedBy = {
      committeeKey: inviterKey, opening: inviterOpening,
      statement: signDirectoryEntry(inviter, CO, ACCOUNT, new Uint8Array(32).fill(6), '2b'.repeat(32), INVITER_SEAT),
    };
    /* The inviter is no super admin: the committee holds only this person's key. */
    const joined = chain({ committee: [mine], seats: ['6b'.repeat(32), SEAT, INVITER_SEAT] });
    const drawUnpinned = async (answers: unknown[], request: RecordsKeyRequest, onPin: (a: AccountAddress, at: number) => Promise<void>) => {
      const r = render(
        <ApproveRecordsKey request={request} identity={identity} channel={channelFor(answers)} consent={consented}
          whoIsAsking={<p>asker</p>} onDecline={() => answers.push('declined')} now={() => NOW} readLabel={joined} pinned={null} onPin={onPin} />);
      await settle();
      return r;
    };

    const sign = (c: HTMLElement) => c.querySelector('[data-sign-records-key]') as HTMLButtonElement;
    const confirmButton = (c: HTMLElement) => c.querySelector('[data-confirm-fingerprint]') as HTMLButtonElement | null;

    it('with no account kept and no invitation handed over, nothing can be kept or signed, and the screen says what to do', async () => {
      const answers: unknown[] = []; const pinned: string[] = [];
      const { container } = await drawUnpinned(answers, ask(), async (a) => { pinned.push(a); });
      /* RED WHEN: a wallet that kept no account offers to keep, or signs for, whichever account the service named. */
      expect(container.querySelector('[data-invitation-does-not-name-it]')?.textContent).toBe(INVITATION_REFUSAL['no-invitation']);
      expect(confirmButton(container)).toBeNull();
      expect(sign(container).disabled).toBe(true);
      fireEvent.click(sign(container));
      await settle();
      expect(answers).toEqual([]);
      expect(pinned).toEqual([]);
    });

    it('an invitation whose seat was not made for the key that signed it is refused, though that key is on the committee', async () => {
      const mal = identityFromSecret(new Uint8Array(32).fill(12));
      const malKey = committeeKeyFor(mal, CO) as { tag: 'schnorr'; value: string };
      const byMal = { committeeKey: malKey, opening: inviterOpening, statement: signDirectoryEntry(mal, CO, ACCOUNT, new Uint8Array(32).fill(13), '2b'.repeat(32), INVITER_SEAT) };
      const answers: unknown[] = []; const pinned: string[] = [];
      const r = render(
        <ApproveRecordsKey request={ask({ invitedBy: byMal })} identity={identity} channel={channelFor(answers)} consent={consented}
          whoIsAsking={<p>asker</p>} onDecline={() => {}} now={() => NOW} pinned={null} onPin={async (a) => { pinned.push(a); }}
          readLabel={chain({ committee: [mine, malKey], seats: ['6b'.repeat(32), SEAT, INVITER_SEAT] })} />);
      await vi.waitFor(() => expect(r.container.querySelector('[data-invitation-does-not-name-it]')).not.toBeNull());
      /* RED WHEN: a key on the committee but not in the inviter's seat's leaf is accepted, and the account offered to keep. */
      expect(r.container.querySelector('[data-invitation-does-not-name-it]')?.textContent).toBe(INVITATION_REFUSAL['not-the-inviters-seat']);
      expect(confirmButton(r.container)).toBeNull();
      expect(pinned).toEqual([]);
    });

    it('while the inviter\'s seat is being worked out, nothing can be kept; a seat that cannot be worked out is refused', async () => {
      let answer: (leaf: string) => void = () => {};
      const r = render(
        <ApproveRecordsKey request={ask({ invitedBy })} identity={identity} channel={channelFor([])} consent={consented}
          whoIsAsking={<p>asker</p>} onDecline={() => {}} now={() => NOW} readLabel={joined} pinned={null} onPin={async () => {}}
          readLeaf={() => new Promise<string>((resolve) => { answer = resolve; })} />);
      await settle();
      /* RED WHEN: the account can be kept before the inviter's opening is checked against its seat. */
      expect(r.container.querySelector('[data-inviter-checking]')).not.toBeNull();
      expect(confirmButton(r.container)).toBeNull();
      await act(async () => { answer(INVITER_SEAT); });
      await settle();
      expect(confirmButton(r.container)).not.toBeNull();
      cleanup();
      const failed = render(
        <ApproveRecordsKey request={ask({ invitedBy })} identity={identity} channel={channelFor([])} consent={consented}
          whoIsAsking={<p>asker</p>} onDecline={() => {}} now={() => NOW} readLabel={joined} pinned={null} onPin={async () => {}}
          readLeaf={async () => { throw new Error('the contract did not load'); }} />);
      await settle();
      /* RED WHEN: an opening whose leaf could not be worked out is believed. */
      expect(failed.container.querySelector('[data-invitation-does-not-name-it]')?.textContent).toBe(INVITATION_REFUSAL['not-the-inviters-seat']);
    });

    it('an invitation that names another account, or is not signed by its inviter, says what is wrong and what to do, and offers nothing to keep', async () => {
      const answers: unknown[] = []; const pinned: string[] = [];
      const other = { ...invitedBy, statement: signDirectoryEntry(inviter, CO, 'a8'.repeat(32) as AccountAddress, new Uint8Array(32).fill(6), '2b'.repeat(32), INVITER_SEAT) };
      const { container } = await drawUnpinned(answers, ask({ invitedBy: other }), async (a) => { pinned.push(a); });
      /* RED WHEN: the person is shown the wallet's internal words, or told to reopen an invitation that cannot be repaired that way. */
      expect(container.querySelector('[data-invitation-does-not-name-it]')?.textContent).toBe(INVITATION_REFUSAL['other-account']);
      expect(confirmButton(container)).toBeNull();
      expect(sign(container).disabled).toBe(true);
      expect(pinned).toEqual([]);
    });

    it('A SECOND ACCOUNT CARRYING THE LABEL, WITH A VALID INVITATION, IS KEPT ONLY IF THE JOINER CONFIRMS ITS FINGERPRINT, AND ONLY BY THAT PRESS', async () => {
      /* A service deployed its own account carrying the company's label, seated the joiner and itself, and signed an
       * invitation for it with its own committee key: every check on what the page hands over passes. */
      const SECOND = 'ad'.repeat(32) as AccountAddress;
      const service = identityFromSecret(new Uint8Array(32).fill(11));
      const serviceKey = committeeKeyFor(service, CO) as { tag: 'schnorr'; value: string };
      const { seat: SERVICE_SEAT, opening: serviceOpening } = await seatMadeFor(serviceKey, '7d'.repeat(32));
      const forged = { committeeKey: serviceKey, opening: serviceOpening, statement: signDirectoryEntry(service, CO, SECOND, new Uint8Array(32).fill(6), '2b'.repeat(32), SERVICE_SEAT) };
      const secondChain: LabelReader = async (account) => (account === SECOND
        ? { of: 'carries', label: CO, seats: { committee: [mine, serviceKey], threshold: 1, seats: [SEAT, SERVICE_SEAT] } }
        : { of: 'no-account' });
      const answers: unknown[] = []; const pinned: string[] = []; const declined: string[] = [];
      const { container } = render(
        <ApproveRecordsKey request={ask({ account: SECOND, invitedBy: forged })} identity={identity} channel={channelFor(answers)} consent={consented}
          whoIsAsking={<p>asker</p>} onDecline={() => declined.push('declined')} now={() => NOW} readLabel={secondChain} pinned={null}
          onPin={async (a) => { pinned.push(a); }} />);
      await settle();
      /* The joiner is shown the fingerprint of the account the page names, read off the chain, and asked to compare it. */
      expect(container.textContent).toContain(companyFingerprint(CO, SECOND));
      expect(container.querySelector('[data-compare-fingerprint]')?.textContent).toMatch(/the one the person who invited you gave you themselves/);
      /* One source: the sentence under the fingerprint names the same person, and never the company. RED WHEN they differ. */
      const under = container.querySelector('[data-compare-with]')?.textContent ?? '';
      expect(under).toMatch(/against the fingerprint the person who invited you gave you themselves, by a call, a message or in person, and not through this page\./);
      expect(under).not.toMatch(/ask the company/i);
      /* RED WHEN: anything is signed, or anything kept, before the joiner has confirmed the fingerprint. */
      expect(sign(container).disabled).toBe(true);
      fireEvent.click(sign(container));
      await settle();
      expect(answers).toEqual([]);
      expect(pinned).toEqual([]);
      /* The fingerprint differs from the inviter's: the joiner says so, and nothing is kept. */
      fireEvent.click(container.querySelector('[data-fingerprint-differs]')!);
      expect(declined).toEqual(['declined']);
      expect(pinned).toEqual([]);
      /* RED WHEN: the confirming press is not the one way the account is kept, or keeps another account. */
      await act(async () => { fireEvent.click(confirmButton(container)!); });
      expect(pinned).toEqual([SECOND]);
    });

    it('a keep that fails is said, and nothing is kept or signed', async () => {
      const answers: unknown[] = [];
      const { container } = await drawUnpinned(answers, ask({ invitedBy }), async () => { throw new Error('quota exceeded in the store'); });
      await act(async () => { fireEvent.click(confirmButton(container)!); });
      await settle();
      /* RED WHEN: a failed keep is silent, shows the store's own words, or lets the press sign anyway. */
      expect(container.querySelector('[data-keep-failed]')?.textContent).toMatch(/could not keep the company.s account, so nothing has been kept or signed/);
      expect(container.textContent).not.toContain('quota exceeded');
      expect(sign(container).disabled).toBe(true);
      expect(answers).toEqual([]);
    });

    it('through the approval screen, the confirming press keeps the account in the wallet\'s own record, and only then can it sign', async () => {
      const opener = watchedOpener();
      const handlers: ((event: MessageEvent) => void)[] = [];
      const view: ChannelWindow = {
        opener: opener as ChannelWindow['opener'],
        addEventListener: (_t, h) => { handlers.push(h); },
        removeEventListener: () => {},
      };
      const port = watchedStore();
      const { container } = render(
        <Approve identity={identity} secret={secretFromWords(TEST_MNEMONIC)} port={port} view={view} now={() => NOW} readLabel={joined} />);
      const wire = {
        schema: 'midnight-identity/disclosure-request/v1', kind: 'records-key',
        requester: { name: 'Payroll A', rdns: 'example.payroll-a' }, purpose: 'To check your records key.',
        nonce: 'r9', expiresAt: NOW + 600_000, company: CO, account: ACCOUNT, seat: SEAT, invitedBy,
      };
      await act(async () => { for (const h of handlers) h({ source: opener, origin: ORIGIN, data: wire } as unknown as MessageEvent); });
      await settle();
      expect(sign(container).disabled).toBe(true);
      await act(async () => { fireEvent.click(confirmButton(container)!); });
      await vi.waitFor(async () => {
        const opened = await load(port, identity);
        /* RED WHEN: the approval screen keeps nothing on the confirmation, or keeps another account. */
        expect(opened.of === 'profile' ? pinnedAccountOf(opened.profile, CO) : null).toBe(ACCOUNT);
      });
      await vi.waitFor(() => expect(sign(container).disabled).toBe(false));
      await act(async () => { fireEvent.click(sign(container)); });
      const answered = await opener.posted(THE_ANSWER);
      /* RED WHEN: once kept, the records key is still not signed for the account the joiner confirmed. */
      expect((answered.message as RecordsKeyAnswer).statement.seat).toBe(SEAT);
    });
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

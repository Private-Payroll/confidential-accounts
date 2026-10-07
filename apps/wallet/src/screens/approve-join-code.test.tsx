// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '../testing/render.js';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity/keys/derivation';
import { parseAsk, type JoinCodeRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import { joinCodeSignedBy, type JoinCode, type PayeeParts } from 'midnight-identity/profile/join-code';
import { payslipKeyOfThisWallet } from './join-code-payslip-key.js';
import { payeeCodeFingerprint, seatKeyFingerprint } from 'midnight-identity/profile/fingerprint';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { secretFromWords } from 'midnight-identity/keys/derivation';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { NETWORK } from 'midnight-identity/network';
import { payslipKeypairFrom } from '../../../../src/core/payslip-key-derive.js';
import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import type { UnlockRequest } from 'midnight-identity/profile/request';
import { receivingAddressesOf } from '../accounts/derived.js';
import { watchedStore } from '../testing/settled-store.js';
import { watchedOpener } from '../testing/settled-channel.js';
import { Approve } from './approve.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { LabelReader } from './company-on-chain.js';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { ApproveJoinCode } from './approve-join-code.js';

/*
 * The screen a person sees when a page asks this wallet to make a code for
 * joining a company: the company, their sign-in, the fingerprint they read
 * out, one press, and a signed code only after it.
 */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const ORIGIN = 'https://payroll-a.example';
const CO = `co_${'d5'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
/* The chain, as this wallet reads it: the account carries the company's label. */
const carries: LabelReader = async (account) => (account === ACCOUNT ? { of: 'carries', label: CO } : { of: 'no-account' });
const SIGNER = { kind: 'signer', signingPublicKey: '11'.repeat(32), wrappingPublicKey: '22'.repeat(32), leafCommitment: '33'.repeat(32) } as const;
const ADDRESS = `mn_shield-addr_test1${'r'.repeat(60)}`;
const ask = (parts: unknown = SIGNER) => parseAsk({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'join-code',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' }, purpose: 'To join.',
  nonce: 'j1', expiresAt: NOW + 600_000, company: CO, account: ACCOUNT, person: 'usr_cleo', parts,
}, ORIGIN, NOW) as JoinCodeRequest;
const channelFor = (answers: unknown[]): Channel => ({
  answer: (a) => { answers.push(a); }, refuse: (r) => { answers.push({ refused: r }); }, stop: () => {},
} as Channel);
/** The payslip key this wallet gives for the company, by the one derivation the wallet hands in. */
const OWN_PAYSLIP_KEY = payslipKeyOfThisWallet(identity, ask());
const draw = (answers: unknown[], request: JoinCodeRequest, receives: string[] = [], consent = { ok: true } as never, ownPayslipKey: string | null = OWN_PAYSLIP_KEY, readLabel: LabelReader = carries) => render(
  <ApproveJoinCode request={request} identity={identity} channel={channelFor(answers)} consent={consent}
    whoIsAsking={<p>asker</p>} onDecline={() => answers.push('declined')} receives={receives} ownPayslipKey={ownPayslipKey}
    fingerprintClass="text-xl" now={() => NOW} readLabel={readLabel} />);
const payeeParts = (payslipKey = OWN_PAYSLIP_KEY, address = ADDRESS): PayeeParts => ({ kind: 'payee', address, payslipKey });
const payeeFingerprint = (parts: PayeeParts) => payeeCodeFingerprint({ committeeKey: committeeKeyFor(identity, CO), parts });
const settle = async () => { await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); }); };
const button = (c: HTMLElement) => c.querySelector('[data-make-join-code]') as HTMLButtonElement;

afterEach(() => { cleanup(); });

describe('THE PAYSLIP KEY THIS WALLET GIVES FOR A COMPANY', () => {
  /* RED WHEN: the key the wallet checks a payee's code against is not the payslip key its released company key gives, or does not follow the company. */
  it('is the payslip key of the key this wallet releases for the company, and another company\'s is another', () => {
    const released = unlockKeyFor(identity, { ...ask(), kind: 'unlock' } as unknown as UnlockRequest);
    expect(OWN_PAYSLIP_KEY).toBe(payslipKeypairFrom(released).publicKey.toLowerCase());
    const other = parseAsk({
      schema: 'midnight-identity/disclosure-request/v1', kind: 'join-code', requester: { name: 'Payroll A', rdns: 'example.payroll-a' }, purpose: 'To join.',
      nonce: 'j2', expiresAt: NOW + 600_000, company: `co_${'d6'.repeat(32)}`, account: ACCOUNT, person: 'usr_cleo', parts: SIGNER,
    }, ORIGIN, NOW) as JoinCodeRequest;
    expect(payslipKeyOfThisWallet(identity, other)).not.toBe(OWN_PAYSLIP_KEY);
  });
});

describe('THE SCREEN FOR MAKING A JOIN CODE', () => {
  it('SHOWS THE COMPANY, THE SIGN-IN AND THE FINGERPRINT, AND ANSWERS ONLY AFTER THE PRESS WITH A CODE IT SIGNED', async () => {
    const answers: unknown[] = [];
    const { container } = draw(answers, ask());
    /* The account the page names is read off the chain before anything can be signed. */
    await settle();
    expect(container.querySelector('[data-join-code-company]')?.textContent).toBe(CO);
    expect(container.querySelector('[data-join-code-person]')?.textContent).toBe('usr_cleo');
    /* RED WHEN: the fingerprint shown is not the one of the keys the code carries. */
    expect(container.querySelector('[data-join-code-fingerprint]')?.textContent).toBe(seatKeyFingerprint(SIGNER));
    /* RED WHEN: the wallet answers before the person presses. */
    expect(answers).toEqual([]);
    await act(async () => { fireEvent.click(button(container)); });
    expect(answers).toHaveLength(1);
    const code = answers[0] as JoinCode;
    expect(joinCodeSignedBy(code)).toBe(true);
    expect(code).toMatchObject({ company: CO, person: 'usr_cleo', parts: SIGNER });
    /* RED WHEN: the fingerprint is not shown on its own after the press, to be read out and copied. */
    expect(container.querySelector('[data-signed]')).not.toBeNull();
    expect(container.querySelector('[data-join-code-fingerprint]')?.textContent).toBe(seatKeyFingerprint(SIGNER));
  });

  it('WILL NOT SIGN AN ADDRESS THIS WALLET DOES NOT RECEIVE AT, OR A PAYSLIP KEY IT DOES NOT GIVE, AS THE PERSON\'S', async () => {
    const answers: unknown[] = [];
    for (const [what, request, receives] of [
      ['somebody else\'s address', ask(payeeParts()), []],
      ['somebody else\'s payslip key', ask(payeeParts('aa'.repeat(32))), [ADDRESS]],
    ] as const) {
      const { container } = draw(answers, request, [...receives]);
      /* RED WHEN: a page can have this wallet sign somebody else's address, or seal their payslips to somebody else's key. */
      expect(container.querySelector('[data-join-code-not-yours]'), what).not.toBeNull();
      expect(button(container).disabled, what).toBe(true);
      await act(async () => { fireEvent.click(button(container)); });
      expect(answers, what).toEqual([]);
      cleanup();
    }
    const mine = draw(answers, ask(payeeParts()), [ADDRESS]);
    await settle();
    /* RED WHEN: a payee's fingerprint is not the one over the wallet, the address and the payslip key the code carries. */
    expect(mine.container.querySelector('[data-join-code-fingerprint]')?.textContent).toBe(payeeFingerprint(payeeParts()));
    await act(async () => { fireEvent.click(button(mine.container)); });
    expect((answers[0] as JoinCode).parts).toEqual(payeeParts());
  });

  it('A REFUSAL AT THE PRESS IS SAID, AND DECLINING ANSWERS ONLY THAT IT WAS DECLINED', async () => {
    const answers: unknown[] = [];
    /* An ask whose asker this wallet cannot tell is refused at the press, where the button does not stand in front of it. */
    const refusing = { ...ask(), requester: { ...ask().requester, origin: 'not an origin' } } as JoinCodeRequest;
    const again = draw(answers, refusing, []);
    await settle();
    await act(async () => { fireEvent.click(button(again.container)); });
    /* RED WHEN: a press the wallet refuses answers anyway, or says nothing. */
    expect(answers).toEqual([]);
    expect(again.container.querySelector('[data-join-code-refused]')?.textContent).toMatch(/could not tell who asked/);
    cleanup();
    const declining = draw(answers, ask());
    fireEvent.click(declining.container.querySelector('[data-decline]')!);
    expect(answers).toEqual(['declined']);
  });

  it('THE WALLET ROUTES A JOIN-CODE ASK TO THIS SCREEN, WITH ITS OWN ADDRESSES AND ITS OWN PAYSLIP KEY', async () => {
    /* RED WHEN: the approval screen hands this screen no addresses, or no payslip key, or a decline that answers nothing. */
    const opener = watchedOpener();
    const handlers: ((event: MessageEvent) => void)[] = [];
    const view: ChannelWindow = {
      opener: opener as ChannelWindow['opener'],
      addEventListener: (_t, h) => { handlers.push(h); },
      removeEventListener: () => {},
    };
    const { container } = render(
      <Approve identity={identity} secret={secretFromWords(TEST_MNEMONIC)} port={watchedStore()} view={view} now={() => NOW} readLabel={carries} />);
    const parts = payeeParts(OWN_PAYSLIP_KEY, receivingAddressesOf(identity, NETWORK)[0]!);
    const wire = {
      schema: 'midnight-identity/disclosure-request/v1', kind: 'join-code',
      requester: { name: 'Payroll A', rdns: 'example.payroll-a' }, purpose: 'To join.',
      nonce: 'j1', expiresAt: NOW + 600_000, company: CO, account: ACCOUNT, person: 'usr_cleo', parts,
    };
    await act(async () => { for (const h of handlers) h({ source: opener, origin: ORIGIN, data: wire } as unknown as MessageEvent); });
    await settle();
    expect(container.querySelector('[data-join-code-not-yours]')).toBeNull();
    expect(button(container).disabled).toBe(false);
    expect(container.querySelector('[data-join-code-fingerprint]')?.textContent).toBe(payeeFingerprint(parts));
    const before = opener.sent.length;
    fireEvent.click(container.querySelector('[data-decline]')!);
    await settle();
    expect(opener.sent.length).toBe(before + 1);
  });

  it('SHOWS THE COMPANY\'S FINGERPRINT FROM THE ACCOUNT AS READ OFF THE CHAIN, AND SIGNS NOTHING UNTIL THE ACCOUNT CARRIES THE LABEL', async () => {
    const answers: unknown[] = [];
    const { container } = draw(answers, ask());
    await settle();
    /* RED WHEN: the code screen shows no company fingerprint, or one not worked out from the account the page names. */
    expect(container.textContent).toContain(companyFingerprint(CO, ACCOUNT));
    expect(button(container).disabled).toBe(false);
    cleanup();
    const elsewhere: unknown[] = [];
    const other = draw(elsewhere, ask(), [], { ok: true } as never, OWN_PAYSLIP_KEY, async () => ({ of: 'carries', label: `co_${'d6'.repeat(32)}` as CompanyLabel }));
    await settle();
    /* RED WHEN: a code is signed while the account the page names carries another company's label. */
    expect(button(other.container).disabled).toBe(true);
    await act(async () => { fireEvent.click(button(other.container)); });
    expect(elsewhere).toEqual([]);
  });

  it('WITHOUT CONSENT FROM THE FRAME, NOTHING IS SIGNED', async () => {
    const answers: unknown[] = [];
    const { container } = draw(answers, ask(), [], { ok: false } as never);
    expect(button(container).disabled).toBe(true);
    await act(async () => { fireEvent.click(button(container)); });
    expect(answers).toEqual([]);
  });
});

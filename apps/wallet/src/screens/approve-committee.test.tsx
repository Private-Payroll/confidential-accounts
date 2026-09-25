// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import * as L from '@midnightntwrk/ledger-v9';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, newWords, secretFromWords } from 'midnight-identity/keys/derivation';
import { parseAsk } from 'midnight-identity/profile/request';
import type { CommitteeRequest } from 'midnight-identity/profile/request';
import type { Channel, ChannelWindow } from 'midnight-identity/profile/channel';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import type { CommitteeSignatures, CommitteeSigningLedger } from 'midnight-identity/profile/committee-sign';
import { watchedStore } from '../testing/settled-store.js';
import { settled, watchedOpener } from '../testing/settled-channel.js';
import { ApproveCommittee } from './approve-committee.js';
import { Approve } from './approve.js';

/*
 * The screen a person sees when a company's page asks this wallet to sign a
 * change to who holds the company's rules: the new committee, who joins, who
 * leaves and the thresholds, worked out by the wallet; one press; and an answer
 * only after the press.
 */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const SECRET = secretFromWords(TEST_MNEMONIC);
const ORIGIN = 'https://payroll-a.example';
const CO = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
const mine = committeeKeyFor(identity, CO);
const leaving = committeeKeyFor(identityFromWords(newWords().join(' ')), CO);
const joining = committeeKeyFor(identityFromWords(newWords().join(' ')), CO);
const sorted = (...ks: { value: string }[]) => ks.map((k) => ({ tag: 'schnorr', value: k.value })).sort((a, b) => (a.value < b.value ? -1 : 1));
const short = (v: string) => `${v.slice(0, 12)}…${v.slice(-8)}`;

const wire = (over: Record<string, unknown> = {}) => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'committee',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'Bring your company to its signers as they are now.',
  nonce: 'c1',
  expiresAt: NOW + 600_000,
  company: CO,
  to: { committee: sorted(mine, joining), threshold: 1 },
  contracts: [{ contract: 'vault', address: VAULT, counter: '3', now: { committee: sorted(mine, leaving), threshold: 2 } }],
  ...over,
});
const ask = (over: Record<string, unknown> = {}) => parseAsk(wire(over), ORIGIN, NOW) as CommitteeRequest;
const channelFor = (answers: unknown[]): Channel => ({
  answer: (a) => { answers.push(a); },
  refuse: (r) => { answers.push({ refused: r }); },
  stop: () => {},
} as Channel);
const consented = { ok: true } as never;
const ledger = async () => L as unknown as CommitteeSigningLedger;
const renderWith = (request: CommitteeRequest, answers: unknown[], consent = consented, declined: string[] = []) => render(
  <ApproveCommittee
    request={request} identity={identity} channel={channelFor(answers)} consent={consent}
    whoIsAsking={<p>asker</p>} onDecline={() => declined.push('declined')} ledger={ledger} now={() => NOW} />);

afterEach(() => { cleanup(); });

describe('THE SCREEN FOR SIGNING A CHANGE TO WHO HOLDS A COMPANY\'S RULES', () => {
  it('SHOWS THE NEW COMMITTEE AND THRESHOLD, WHO JOINS AND WHO LEAVES, BEFORE ANYTHING IS SIGNED', async () => {
    const answers: unknown[] = [];
    const { container } = renderWith(ask(), answers);
    await screen.findByText('Sign this change');
    /* RED WHEN: the screen does not say how many must sign after the change. */
    expect(container.querySelector('[data-new-threshold]')!.textContent).toBe(
      '2 keys, and 1 of them must sign any change to the company\'s rules.');
    expect(container.querySelector('[data-threshold-change]')!.textContent).toBe('Threshold: 2 before, 1 after.');
    /* RED WHEN: who joins or who leaves is not shown, or the two are swapped. */
    expect(container.querySelector('[data-joins]')!.textContent).toContain(short(joining.value));
    expect(container.querySelector('[data-leaves]')!.textContent).toContain(short(leaving.value));
    expect(container.querySelector('[data-joins]')!.textContent).not.toContain(short(leaving.value));
    expect(container.querySelector('[data-new-committee]')!.textContent).toContain(`${short(mine.value)} (your key)`);
    expect(container.querySelector('[data-contract="vault"]')!.textContent).toBe(VAULT);
    expect(answers).toEqual([]);
  });

  it('THE PRESS SIGNS THAT CHANGE AND HANDS BACK SIGNATURES, AND ONLY THE PRESS', async () => {
    const answers: unknown[] = [];
    const request = ask();
    renderWith(request, answers);
    const button = await screen.findByText('Sign this change');
    await settled(5);
    expect(answers).toEqual([]);
    fireEvent.click(button);
    expect(answers).toHaveLength(1);
    const answer = answers[0] as CommitteeSignatures;
    expect(answer.schema).toBe('midnight-identity/committee-signatures/v1');
    const exact = new L.MaintenanceUpdate(VAULT, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(
      request.to.committee.map((k) => ({ ...k })) as never, 1, 4n))], 3n);
    /* RED WHEN: what the press signs is anything but the change the screen showed. */
    expect(L.verifySignature(mine as never, exact.dataToSign, answer.signatures[0]!.signature as never)).toBe(true);
    expect(await screen.findByText(/You signed a change to who holds this company's rules/)).toBeTruthy();
  });

  it('SHOWS EVERY CONTRACT IT WILL SIGN FOR, THE COMPANY ACCOUNT INCLUDED, AND EVERY KEY OF THE NEW COMMITTEE', async () => {
    const answers: unknown[] = [];
    const contracts = [
      { contract: 'account', address: CO, counter: '1', now: { committee: sorted(mine), threshold: 1 } },
      { contract: 'vault', address: VAULT, counter: '3', now: { committee: sorted(mine, leaving), threshold: 2 } },
    ];
    const { container } = renderWith(ask({ contracts }), answers);
    await screen.findByText('Sign this change');
    /* RED WHEN: a contract the press signs for is left off the screen. */
    expect(container.querySelector('[data-contract="account"]')!.textContent).toBe(CO);
    expect(container.querySelector('[data-contract="vault"]')!.textContent).toBe(VAULT);
    expect([...container.querySelectorAll('[data-threshold-change]')].map((e) => e.textContent))
      .toEqual(['Threshold: 1 before, 1 after.', 'Threshold: 2 before, 1 after.']);
    /* RED WHEN: any key of the committee to be installed is left out of its list. */
    const listed = container.querySelector('[data-new-committee]')!.textContent!;
    for (const k of [mine, joining]) expect(listed).toContain(short(k.value));
    fireEvent.click(screen.getByText('Sign this change'));
    expect((answers[0] as CommitteeSignatures).signatures.map((x) => x.address)).toEqual([CO, VAULT]);
  });

  it('SAYS SO WHEN THIS PERSON\'S OWN KEY LEAVES', async () => {
    const { container } = renderWith(ask({ to: { committee: sorted(joining), threshold: 1 } }), []);
    await screen.findByText('Sign this change');
    expect(container.querySelector('[data-you-leave]')).not.toBeNull();
  });

  it('REFUSES A CONTRACT THIS PERSON HOLDS NO SEAT ON, AND THE BUTTON STAYS SHUT', async () => {
    const answers: unknown[] = [];
    const contracts = [{ contract: 'vault', address: VAULT, counter: '3', now: { committee: sorted(leaving), threshold: 1 } }];
    const { container } = renderWith(ask({ contracts }), answers);
    await screen.findByText('This wallet will not sign this');
    expect(container.querySelector('[data-committee-refused]')!.textContent).toMatch(/not on the committee that holds vault/);
    expect((screen.getByText('Sign this change') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Sign this change'));
    expect(answers).toEqual([]);
  });

  it('a press the framing refuses does nothing, and declining is its own button', async () => {
    const answers: unknown[] = []; const declined: string[] = [];
    renderWith(ask(), answers, { ok: false, says: 'too small' } as never, declined);
    await screen.findByText('Sign this change');
    await settled(5);
    expect((screen.getByText('Sign this change') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Do not sign'));
    expect(declined).toEqual(['declined']);
    expect(answers).toEqual([]);
  });
});

describe('THE APPROVAL SURFACE ROUTES A COMMITTEE CHANGE TO THIS SCREEN', () => {
  let port: ReturnType<typeof watchedStore>;
  beforeEach(() => { port = watchedStore(); });

  it('and nothing is signed until the person presses', async () => {
    const opener = watchedOpener();
    const handlers: ((event: MessageEvent) => void)[] = [];
    const view: ChannelWindow = {
      opener: opener as ChannelWindow['opener'],
      addEventListener: (_t, h) => { handlers.push(h); },
      removeEventListener: () => {},
    };
    render(<Approve identity={identity} secret={SECRET} port={port} view={view} now={() => NOW} />);
    for (const h of handlers) h({ source: opener, origin: ORIGIN, data: wire() } as unknown as MessageEvent);
    /* RED WHEN: a committee ask is routed anywhere but its own screen. */
    expect(await screen.findByText(`Change who holds a company's rules, for ${ORIGIN}`)).toBeTruthy();
    await settled(20);
    expect(opener.sent.filter((m) => (m.message as { schema?: string }).schema === 'midnight-identity/committee-signatures/v1')).toEqual([]);
  });
});

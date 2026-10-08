// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '../testing/render.js';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { parseAsk, type HoldersRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import type { HoldersAnswer } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { AnswerHolders, type HoldersReader } from './answer-holders.js';
import { INDEXER_HTTP_URL, INDEXER_WS_URL } from '../config.js';

/*
 * The wallet answering who holds a company's account: with no press, from its
 * own read of the chain, public facts only, and nothing when the read failed
 * or the page's framing was refused.
 */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const ORIGIN = 'https://payroll-a.example';
const CO = 'co_1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071' as CompanyLabel;
const ACCOUNT = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
const VAULT = '9a'.repeat(32);
const HOLDERS = {
  committee: [{ tag: 'schnorr', value: '11'.repeat(32) }], threshold: 1, seats: ['5a'.repeat(32)], approvals: 1, adoptedVaults: [VAULT], founding: '5a'.repeat(32), foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }],
};
const ask = (over: Record<string, unknown> = {}) => parseAsk({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'holders',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' }, purpose: 'Who holds the company.',
  nonce: 'h1', expiresAt: NOW + 60_000, company: CO, account: ACCOUNT, ...over,
}, ORIGIN, NOW) as HoldersRequest;
/* As the channel promises: the first answer or refusal is sent and says true; anything after it sends nothing and says false. */
const channelFor = (answers: unknown[]): Channel => {
  let done = false;
  const once = (x: unknown) => { if (done) return false; done = true; answers.push(x); return true; };
  return { answer: (a: unknown) => once(a), refuse: (r: unknown) => once({ refused: r }), stop: () => {} } as unknown as Channel;
};
/*
 * **EVERY CHECK WAITS FOR WHAT IT CHECKS.** A check that something was sent
 * waits until it was. A check that nothing was sent waits until a twin of the
 * same screen, rendered beside it with consent and the same read, has
 * answered: the twin's read and answer run through the same path, so by then
 * the screen under test has had every chance to send.
 */
const answeredBeside = async (request: HoldersRequest, readHolders: HoldersReader) => {
  const twin: unknown[] = [];
  render(<AnswerHolders request={request} channel={channelFor(twin)} consent={{ ok: true }} now={() => NOW} readHolders={readHolders} />);
  await waitFor(() => expect(twin).toHaveLength(1));
};
const reads: string[] = [];
const holders: HoldersReader = async (account, label) => { reads.push(`${account}:${label}`); return { of: 'read', holders: HOLDERS }; };

afterEach(() => { cleanup(); reads.length = 0; });

describe('THE WALLET SAYS WHO HOLDS A COMPANY, WITH NO PRESS', () => {
  it('ANSWERS AS SOON AS IT HAS READ THE ACCOUNT, WITH ONLY WHAT IT READ', async () => {
    const answers: unknown[] = [];
    const r = render(<AnswerHolders request={ask()} channel={channelFor(answers)} consent={{ ok: true }} now={() => NOW} readHolders={holders} />);
    /* RED WHEN: the answer waits for a press, or is not sent at all. */
    await waitFor(() => expect(answers).toHaveLength(1));
    const answer = answers[0] as HoldersAnswer;
    /* RED WHEN: the answer carries anything but what this wallet read. */
    expect(answer.holders).toEqual(HOLDERS);
    expect(Object.keys(answer).sort()).toEqual(['account', 'at', 'company', 'holders', 'indexer', 'nonce', 'origin', 'schema']);
    /* RED WHEN: the indexer handed back is not the one this wallet reads the chain through, which the page then reads its vaults at. */
    expect(answer.indexer).toEqual({ indexerUri: INDEXER_HTTP_URL, indexerWsUri: INDEXER_WS_URL });
    expect(reads).toEqual([`${ACCOUNT}:${CO}`]);
    expect(r.container.querySelector('button')).toBeNull();
  });

  it('NOTHING IS ANSWERED WHEN THE FRAMING IS REFUSED, AND A READ THAT FAILED IS REFUSED, NOT ANSWERED', async () => {
    const refusedFraming: unknown[] = [];
    const refusing: HoldersReader = async (account, label) => { reads.push(`refused:${account}:${label}`); return { of: 'read', holders: HOLDERS }; };
    render(<AnswerHolders request={ask()} channel={channelFor(refusedFraming)} consent={{ ok: false, says: 'not visible' }} now={() => NOW} readHolders={refusing} />);
    await answeredBeside(ask(), holders);
    /* RED WHEN: the origin checks every other ask keeps are skipped because this one needs no press. */
    expect(refusedFraming).toEqual([]);
    expect(reads.filter((r) => r.startsWith('refused:'))).toEqual([]);
    cleanup();
    const failed: unknown[] = [];
    render(<AnswerHolders request={ask()} channel={channelFor(failed)} consent={{ ok: true }} now={() => NOW}
      readHolders={async () => ({ of: 'unreadable', why: 'offline' })} />);
    /* RED WHEN: a read that failed is answered as who holds the company. */
    await waitFor(() => expect(failed).toEqual([{ refused: 'unreadable' }]));
    /* RED WHEN: the person is not told the account could not be read, but only that nothing was handed back. */
    expect(document.querySelector('[data-holders-refused]')?.textContent).toMatch(/could not read the company’s account from the network/);
  });

  it('A PAGE IS ANSWERED ONCE, HOWEVER OFTEN ITS FRAMING IS CHECKED AGAIN, AND THE SCREEN SAYS WHAT WAS SENT', async () => {
    const sent: unknown[] = [];
    const channel = channelFor(sent);
    const request = ask();
    let n = 0;
    const failsOnce: HoldersReader = async () => { n += 1; return n === 1 ? { of: 'unreadable', why: 'offline' } : { of: 'read', holders: HOLDERS }; };
    const r = render(<AnswerHolders request={request} channel={channel} consent={{ ok: true }} now={() => NOW} readHolders={failsOnce} />);
    await waitFor(() => expect(sent).toHaveLength(1));
    /* A resize or a tab switch hands the screen a fresh consent object. */
    r.rerender(<AnswerHolders request={request} channel={channel} consent={{ ok: true }} now={() => NOW} readHolders={failsOnce} />);
    await answeredBeside(request, holders);
    /* RED WHEN: the screen reads and answers again on every consent check, and then claims an answer the page never got. */
    expect(n).toBe(1);
    expect(sent).toEqual([{ refused: 'unreadable' }]);
    expect(r.container.querySelector('[data-holders="sent"]')).toBeNull();
    expect(r.container.querySelector('[data-holders-refused]')?.textContent).toMatch(/could not read the company’s account/);
  });

  it('A PAGE THE CHANNEL HAS ALREADY ANSWERED IS NOT TOLD IT WAS ANSWERED AGAIN', async () => {
    const sent: unknown[] = [];
    const channel = channelFor(sent);
    channel.refuse('declined' as never);
    render(<AnswerHolders request={ask()} channel={channel} consent={{ ok: true }} now={() => NOW} readHolders={holders} />);
    /* RED WHEN: the screen says the page was told who holds the company when the channel sent nothing. */
    await waitFor(() => expect(document.querySelector('[data-holders-refused]')?.textContent).toMatch(/already been answered/));
    expect(document.querySelector('[data-holders="sent"]')).toBeNull();
  });

  it('WHILE THE PAGE IS NOT YET ONE THIS WALLET ANSWERS, NOTHING IS SENT AND NO ALERT IS RAISED', async () => {
    const sent: unknown[] = [];
    const r = render(<AnswerHolders request={ask()} channel={channelFor(sent)} consent={{ ok: false, says: 'this wallet has only just appeared.' }} now={() => NOW} readHolders={holders} />);
    await answeredBeside(ask(), holders);
    /* RED WHEN: a wait for the framing to settle is shown as a refusal, or anything is sent before it settles. */
    expect(sent).toEqual([]);
    expect(r.container.querySelector('[role="alert"]')).toBeNull();
    expect(r.container.querySelector('[data-holders-waiting]')?.textContent).toBe('This wallet has only just appeared.');
  });

  it('A PAGE ABOUT TO APPROVE A RUN IS TOLD WHICH OF ITS PAYMENTS THE ACCOUNT RECORDS, FROM THE SAME READ, AND NOTHING WHEN THE READ SAYS NOTHING', async () => {
    const asked = ['a1'.repeat(32), 'b2'.repeat(32)];
    const seen: Array<readonly string[] | undefined> = [];
    const withPayments: HoldersReader = async (_a, _l, movements) => {
      seen.push(movements);
      return { of: 'read', holders: HOLDERS, payments: { payKeyCommitment: 'cc'.repeat(32), held: [asked[1]!] } };
    };
    const answers: unknown[] = [];
    render(<AnswerHolders request={ask({ movements: asked })} channel={channelFor(answers)} consent={{ ok: true }} now={() => NOW} readHolders={withPayments} />);
    await waitFor(() => expect(answers).toHaveLength(1));
    /* RED WHEN: the payments the page asked about are not handed to the read, or not answered from it. */
    expect(seen).toEqual([asked]);
    expect((answers[0] as HoldersAnswer).payments).toEqual({ payKeyCommitment: 'cc'.repeat(32), held: [asked[1]] });
    cleanup();
    const refused: unknown[] = [];
    render(<AnswerHolders request={ask({ movements: asked })} channel={channelFor(refused)} consent={{ ok: true }} now={() => NOW} readHolders={holders} />);
    /* RED WHEN: a page that asked which payments are recorded is answered with none read, which it would take as nobody paid. */
    await waitFor(() => expect(refused).toEqual([{ refused: 'unreadable' }]));
  });
});

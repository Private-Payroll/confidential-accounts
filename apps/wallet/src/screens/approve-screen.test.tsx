// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, secretFromWords } from 'midnight-identity/keys/derivation';
import { EMAIL, GIVEN_NAME, REGISTRY } from 'midnight-identity/profile/attributes';
import { emptyProfile, grantTo, selfAssert } from 'midnight-identity/profile/model';
import { load, save } from 'midnight-identity/profile/store';
/* Second cause — `approve.tsx` writes its history entry with
 * `void save(...)`, which is correct and is not awaited, so a test that reads
 * the store after a press needs a way to wait for the write itself. */
import { afterWrites, watchedStore } from '../testing/settled-store.js';
import type { WatchedPort } from '../testing/settled-store.js';
/* REOPENED — the answer is AWAITED rather than polled for. The two
 * waits that went red at 5,014ms were both waiting for a real signature, which
 * is the one step in this file that loses a race for a core. */
import { afterTheAnswer, settled, watchedOpener } from '../testing/settled-channel.js';
import { verify } from 'midnight-identity/profile/disclosure';
import type { DisclosureResponse } from 'midnight-identity/profile/disclosure';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { Approve } from './approve.js';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const SECRET = secretFromWords(TEST_MNEMONIC);
const ORIGIN = 'https://payroll-a.example';

let port: WatchedPort;
beforeEach(() => { port = watchedStore(); });
afterEach(() => { cleanup(); });

const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'To pay you, we need to know who you are.',
  wants: [
    { attribute: GIVEN_NAME, required: true },
    { attribute: EMAIL, required: false, reason: 'For your payslip.' },
  ],
  nonce: 'n1',
  expiresAt: NOW + 600_000,
  ...over,
});

const open = (data: unknown = wire(), origin = ORIGIN) => {
  const opener = watchedOpener();
  const { sent } = opener;
  const handlers: ((event: MessageEvent) => void)[] = [];
  const view: ChannelWindow = {
    opener: opener as ChannelWindow['opener'],
    addEventListener: (_t, h) => { handlers.push(h); },
    removeEventListener: () => { /* torn down by cleanup */ },
  };
  render(
    <Approve identity={identity} secret={SECRET} port={port} view={view} now={() => NOW} />);
  const deliver = (payload: unknown): void => {
    for (const h of handlers) {
      h({ source: opener, origin, data: payload } as unknown as MessageEvent);
    }
  };
  deliver(data);
  /** The answer has crossed and the screen has caught up with it. */
  const answered = () => afterTheAnswer(opener);
  return { sent, deliver, answered };
};

const someone = async (): Promise<string[]> => {
  let profile = selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', 'legal', NOW);
  profile = selfAssert(profile, REGISTRY, EMAIL, 'sarah@work.example', 'work', NOW);
  await save(port, identity, profile);
  return profile.held.map((h) => h.id);
};

const responseFrom = (sent: { message: unknown }[]): DisclosureResponse =>
  sent[sent.length - 1]!.message as DisclosureResponse;

/** The button is the observed origin's words, not the asker's. */
const sendTo = (origin = ORIGIN): string => `Send these to ${origin}`;

/**
 * **THE OPTION ROW, ONCE THE PROFILE HAS REACHED THE SCREEN.**
 *
 * This was `waitFor(() => { … if (!found) throw new Error('waiting') })` at
 * every call site — a poll with a deadline, for a profile that arrives on a
 * promise already resolved by an in-memory store. `settled` turns the loop a
 * fixed number of times instead, so there is no number here for a loaded
 * machine to defeat, and a screen that really stopped rendering the row fails
 * everywhere rather than intermittently.
 */
const optionFor = async (attribute: string): Promise<HTMLInputElement> => {
  await settled();
  const found = document.querySelector<HTMLInputElement>(
    `[data-row="${attribute}"] [data-option] input`);
  if (!found) {
    throw new Error(
      `the screen never showed an option row for ${attribute}. That is the defect, not a `
      + 'wait that needed longer.');
  }
  return found;
};

/** The same, for anything else on the screen that arrives with the profile. */
const onScreen = async (selector: string): Promise<Element> => {
  await settled();
  const found = document.querySelector(selector);
  if (!found) throw new Error(`the screen never showed ${selector}`);
  return found;
};

describe('§5.3 — the person is told where the page ACTUALLY came from', () => {
  it('the name and the origin are labelled as different kinds of thing', async () => {
    await someone();
    open();
    await settled();
    screen.getByText('Who is asking');
    expect(document.querySelector('[data-requester-name]')?.textContent).toBe('Payroll A');
    expect(document.querySelector('[data-requester-origin]')?.textContent).toBe(ORIGIN);
    /* A name may help you find something. It may never stand in for an
     * identity on the surface that approves. */
    expect(document.body.textContent).toContain('Your browser told this wallet that');
  });

  it('THE BUTTON AND THE WARNING ARE THE OBSERVED ORIGIN, AND THE NAME IS NOT IN THEM',
    async () => {
      /*
       * **THIS IS THE TEST THAT CLOSES IT FOR DISCLOSURE.** The change did
       * this to the unlock screen; this kind was still writing the button a
       * person presses, and the sentence about what they cannot take back, in
       * the one field on the whole ask that the ASKER chose.
       */
      await someone();
      open();
      await settled();
      screen.getByText('Who is asking');
      const button = document.querySelector('[data-approve]')?.textContent ?? '';
      expect(button).toContain(ORIGIN);
      expect(button).not.toContain('Payroll A');
      const kept = document.body.textContent ?? '';
      expect(kept).toContain(`${ORIGIN} will keep their own copy`);
      expect(kept).not.toContain('Payroll A will keep their own copy');
      /* The name is still shown, in the card, labelled as a claim. */
      expect(document.querySelector('[data-requester-name]')?.textContent).toBe('Payroll A');
    });

  it('A PAGE CALLING ITSELF SOMEBODY ELSE IS DESCRIBED BY WHERE IT CAME FROM', async () => {
    const OTHER = 'https://payroll-b.example';
    await someone();
    open(wire(), OTHER);
    await settled();
    screen.getByText('Who is asking');
    expect(screen.getByText(sendTo(OTHER))).toBeTruthy();
    expect(document.querySelector('[data-requester-origin]')?.textContent).toBe(OTHER);
    expect(document.querySelector('[data-requester-name]')?.textContent).toBe('Payroll A');
  });

  it('the requester\'s own words are rendered as TEXT and never as markup', async () => {
    await someone();
    open(wire({
      requester: { name: '<img src=x onerror="alert(1)">', rdns: 'a' },
      purpose: '<script>alert(2)</script>',
    }));
    await settled();
    screen.getByText('Who is asking');
    expect(document.querySelector('[data-requester-name] img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('[data-requester-name]')?.textContent)
      .toBe('<img src=x onerror="alert(1)">');
  });

  it('a request that names its own origin never reaches the approval rows at all',
    async () => {
      await someone();
      open(wire({ requester: { name: 'A', rdns: 'a', origin: 'https://elsewhere.example' } }));
      await settled();
      screen.getByText('This request was refused before you saw it');
      expect(document.querySelector('[data-approve]')).toBeNull();
    });
});

describe('§6 — no silent disclosure, and a remembered grant only pre-ticks', () => {
  it('a remembered grant PRE-TICKS the boxes and still shows the screen', async () => {
    const ids = await someone();
    const opened = await load(port, identity);
    if (opened.of !== 'profile') throw new Error('unreachable');
    await save(port, identity, grantTo(
      opened.profile,
      { origin: ORIGIN, name: 'Payroll A', rdns: 'example.payroll-a' },
      0, ids, NOW));

    const { sent } = open();
    expect((await optionFor(GIVEN_NAME)).checked).toBe(true);
    /* AND NOTHING WAS SENT. The only thing in `sent` is the ready ping. */
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toMatchObject({ schema: 'midnight-identity/wallet-ready/v1' });
    expect(document.querySelector('[data-approve]')).not.toBeNull();
  });

  it('nothing is answered until a person presses something', async () => {
    await someone();
    const { sent } = open();
    await settled();
    screen.getByText('Who is asking');
    expect(sent.filter((s) => (s.message as { payload?: unknown }).payload)).toHaveLength(0);
  });
});

describe('approving, per value', () => {
  it('what is chosen is signed, sent to the observed origin, and VERIFIES there', async () => {
    await someone();
    const { sent, answered } = open();
    const option = await optionFor(GIVEN_NAME);
    fireEvent.click(option);
    fireEvent.click(screen.getByText(sendTo()));

    await answered();
    const answer = sent[sent.length - 1]!;
    expect(answer.target).toBe(ORIGIN);
    const response = responseFrom(sent);
    expect(verify(response, {
      atOrigin: ORIGIN,
      expectingNonce: 'n1',
      payingAddress: response.payload.address,
      networkId: 'stagenet',
      now: NOW,
    })).toEqual({ ok: true });
  });

  it('DECLINING AN OPTIONAL ONE IS A NORMAL OUTCOME and the response says which', async () => {
    await someone();
    const { sent, answered } = open();
    const option = await optionFor(GIVEN_NAME);
    fireEvent.click(option);
    fireEvent.click(screen.getByText(sendTo()));
    await answered();
    const response = responseFrom(sent);
    expect(response.payload.disclosed.map((s) => s.about)).toEqual([GIVEN_NAME]);
    expect(response.payload.declined).toEqual([EMAIL]);
  });

  it('a required one can still be declined, and the screen says so before the button',
    async () => {
      await someone();
      const { sent, answered } = open();
      await settled();
      screen.getByText('Who is asking');
      expect(document.querySelector('[data-missing-required]')?.textContent)
        .toContain('First name');
      fireEvent.click(screen.getByText(sendTo()));
      await answered();
      const response = responseFrom(sent);
      expect(response.payload.disclosed).toHaveLength(0);
      expect(response.payload.declined).toEqual([GIVEN_NAME, EMAIL]);
    });

  it('SAYS ONCE, BEFORE, that what is sent is sent — and again after, without a leash',
    async () => {
      await someone();
      const { answered } = open();
      await settled();
      screen.getByText('Who is asking');
      expect(screen.getAllByText('What is sent, is sent')).toHaveLength(1);
      fireEvent.click(screen.getByText(sendTo()));
      await answered();
      expect(screen.getByText('Sent')).toBeTruthy();
      expect(document.body.textContent).toContain('Nothing can take back what has gone');
      const controls = [...document.querySelectorAll('button, a')];
      for (const control of controls) {
        expect((control.textContent ?? '').toLowerCase()).not.toContain('revoke');
      }
    });

  it('sending nothing tells them so, and sends no payload at all', async () => {
    await someone();
    const { sent } = open();
    await settled();
    screen.getByText('Who is asking');
    fireEvent.click(screen.getByText('Send nothing'));
    const answer = sent[sent.length - 1]!;
    expect(answer.message).toEqual({
      schema: 'midnight-identity/disclosure-refused/v1', reason: 'declined',
    });
    expect(answer.target).toBe(ORIGIN);
  });

  it('the disclosure is written into the history as CONTENT, and the grant remembers it',
    async () => {
      await someone();
      const { answered } = open();
      const option = await optionFor(GIVEN_NAME);
      fireEvent.click(option);
      /* Declared BEFORE the press and awaited after it. The history
       * entry is written with `void save(...)`, which is correct and is not
       * awaited, so `afterWrites` is what waits for the write itself rather
       * than polling the store for what the write said. */
      const written = afterWrites(port);
      fireEvent.click(screen.getByText(sendTo()));
      await answered();
      await written();
      const opened = await load(port, identity);
      if (opened.of !== 'profile') throw new Error('the profile could not be opened');
      expect(opened.profile.grants[0]!.disclosures[0]!.sent[0]!.says)
        .toEqual({ of: 'value', value: 'Sarah' });
      expect(opened.profile.grants[0]!.recipient.origin).toBe(ORIGIN);
    });
});

describe('what the screen says once it is done', () => {
  it('THE SENTENCE AFTERWARDS IS THE OBSERVED ORIGIN TOO, AND THE NAME IS NOT IN IT',
    async () => {
      /*
       * **THE RULE REACHES PAST THE PRESS**, and this half was unpinned: nothing in this file looked at `[data-details-sent]`, so the
       * sentence could be rebuilt from `requester.name` with every test green.
       *
       * *"On 23 Aug you sent details to Payroll A"* is the wallet's own account
       * of what a person did, written in the one field the asker chose — and
       * unlike the button, it is what they would read coming back to check.
       */
      await someone();
      const { sent, answered } = open();
      await settled();
      screen.getByText('Who is asking');
      const written = afterWrites(port);
      fireEvent.click(screen.getByText(sendTo()));
      /* `findByText('Sent')` is a poll with a deadline, and what it
       * was really waiting for was the signature. The answer is awaited
       * instead; by the time it has crossed, the word is on the screen. */
      await answered();
      expect(screen.getByText('Sent')).toBeTruthy();
      await written();

      const said = document.querySelector('[data-details-sent]')?.textContent ?? '';
      expect(said).toContain(ORIGIN);
      expect(said).not.toContain('Payroll A');
      /* And the paragraph under it, which says what they keep. */
      const keeps = document.body.textContent ?? '';
      expect(keeps).toContain(`${ORIGIN} keeps their own copy`);
      expect(keeps).not.toContain('Payroll A keeps their own copy');
      expect(sent.length).toBeGreaterThan(1);
    });
});

describe('the subwallet the disclosure is about', () => {
  it('the address on screen is the one the signature derives back to', async () => {
    await someone();
    const { sent, answered } = open();
    const shown = (await onScreen('[data-address]')).textContent ?? '';
    fireEvent.click(screen.getByText(sendTo()));
    await answered();
    const response = responseFrom(sent);
    expect(response.payload.address).toBe(shown);
    expect(verify(response, {
      atOrigin: ORIGIN,
      expectingNonce: 'n1',
      payingAddress: shown,
      networkId: 'stagenet',
      now: NOW,
    })).toEqual({ ok: true });
  });

  it('AND THE SAME DISCLOSURE IS REFUSED AT A SECOND RECIPIENT', async () => {
    await someone();
    const { sent, answered } = open();
    await settled();
    screen.getByText('Who is asking');
    fireEvent.click(screen.getByText(sendTo()));
    await answered();
    const response = responseFrom(sent);
    expect(verify(response, {
      atOrigin: 'https://payroll-b.example',
      expectingNonce: 'n1',
      payingAddress: response.payload.address,
      networkId: 'stagenet',
      now: NOW,
    })).toMatchObject({ ok: false, code: 'origin-mismatch' });
  });
});

/* ------------------------------------------------------------------------ */

/**
 * **THE WINDOW IS OPEN BEFORE THE ASK EXISTS, AND IT SAYS SO.**
 *
 * The requester now opens this window **inside the click**, before it has asked
 * its own server for a nonce, because a browser only grants that permission for
 * the length of a press. So this wallet is routinely on screen for a moment
 * with the ask still in flight — and *Nothing is asking* would be a wallet
 * telling somebody the press they just made did nothing.
 *
 * **`window.opener` is what tells the two apart, and the browser fills it in.**
 * It is the same property `channel.ts` already refuses messages on, read the
 * other way: a page cannot set it on a window it did not open, so it cannot
 * make this wallet claim to be waiting for it.
 */
describe('a window that was opened FOR an ask, before the ask arrives', () => {
  const renderWith = (opener: ChannelWindow['opener']): void => {
    const view: ChannelWindow = {
      opener,
      addEventListener: () => { /* nothing is delivered: that is the state */ },
      removeEventListener: () => { /* torn down by cleanup */ },
    };
    render(
      <Approve identity={identity} secret={SECRET} port={port} view={view} now={() => NOW} />);
  };

  it('WATCHED FAILING: IT SAYS IT IS WAITING FOR THE REQUEST, not that nothing is asking',
    async () => {
      await someone();
      const opener = watchedOpener();
      renderWith(opener as unknown as ChannelWindow['opener']);
      await settled();

      expect(document.querySelector('[data-waiting-for-ask]')).not.toBeNull();
      expect(document.body.textContent).not.toContain('Nothing is asking');
      /* **AND IT NAMES NOBODY.** At this moment this wallet does not know who
       * is asking: the origin is observed on the first message and not before,
       * so a screen naming the requester here would be naming a guess. */
      expect(document.body.textContent).not.toContain(ORIGIN);
      expect(document.body.textContent).not.toContain('Payroll A');
      /* Nothing has gone back but the ready ping. */
      expect(opener.sent).toHaveLength(1);
      expect(opener.sent[0]!.message)
        .toMatchObject({ schema: 'midnight-identity/wallet-ready/v1' });
    });

  it('and a window nobody opened still says nothing is asking', async () => {
    /* Somebody who reached `#/approve` by typing it. There is no press behind
     * this one and no ask on its way, so telling them to wait would be a lie. */
    await someone();
    renderWith(null);
    await settled();

    expect(screen.getByText('Nothing is asking')).toBeTruthy();
    expect(document.querySelector('[data-waiting-for-ask]')).toBeNull();
  });
});

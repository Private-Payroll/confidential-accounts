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
import { afterWrites, watchedStore } from './settled-store.js';
import type { WatchedPort } from './settled-store.js';
/* REOPENED — the answer is AWAITED rather than polled for. Both waits
 * that went red at 5,014ms were waiting for a real signature. */
import { afterTheAnswer, settled, watchedOpener } from './settled-channel.js';
import type { WatchedOpener } from './settled-channel.js';
import { verify } from 'midnight-identity/profile/disclosure';
import type { DisclosureResponse } from 'midnight-identity/profile/disclosure';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { Approve } from './screens/approve.js';

/**
 * **THE SCREEN SAYS A DIFFERENT SENTENCE.**
 *
 * An approval screen listing nothing is not an approval screen. A sign-in asks
 * ONE question — do you want this site to know it is you — and names the site
 * and the wallet that answers. **It is the same surface and every rule on it is
 * the same one**, which is what the first two describes below check: the origin
 * is the browser's, and no code path answers without a press.
 *
 * `approve-screen.test.tsx` is UNCHANGED by this change and still drives the
 * disclosure through the same component.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const SECRET = secretFromWords(TEST_MNEMONIC);
const ORIGIN = 'https://payroll-a.example';

/**
 * **THE SCREEN AFTER THE PRESS.**
 *
 * It used to be `findByText('Signed in')`. The heading is no longer a bare
 * outcome — it names the act and the site — and it is built from two nodes, so
 * there is no single text node to find. The attribute is the stable handle.
 *
 * **AND IT USED TO POLL FOR IT.** That poll is the one that failed at 5,014ms
 * on a real machine, inside the full 64-file run, one tick past a budget
 * had just been raised — because what it was really waiting for was a Schnorr
 * signature that had not been given a core. So it awaits the ANSWER, which the
 * screen posts before it renders anything, and then reads the heading. There is
 * no interval and no budget left in it: a busier machine makes this slower and
 * cannot make it fail.
 */
let asking: WatchedOpener | null = null;

const afterTheSigning = async (): Promise<Element> => {
  if (!asking) throw new Error('nothing has been opened, so nothing can have been signed');
  await afterTheAnswer(asking);
  const found = document.querySelector('[data-signed-in-heading]');
  if (!found) {
    throw new Error(
      'the answer crossed and the signed-in heading is not on the screen. This is the '
      + 'defect, not a wait that needed longer.');
  }
  return found;
};

let port: WatchedPort;
beforeEach(() => { port = watchedStore(); });
afterEach(() => { cleanup(); });

/** A sign-in on the wire — no `wants`, which is the whole shape of the kind. */
const signIn = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'sign-in',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'We need to know it is you before we show you your payslips.',
  nonce: 'n1',
  expiresAt: NOW + 600_000,
  ...over,
});

const open = (data: unknown = signIn(), origin = ORIGIN) => {
  const opener = watchedOpener();
  asking = opener;
  const { sent } = opener;
  const handlers: ((event: MessageEvent) => void)[] = [];
  const view: ChannelWindow = {
    opener: opener as ChannelWindow['opener'],
    addEventListener: (_t, h) => { handlers.push(h); },
    removeEventListener: () => { /* torn down by cleanup */ },
  };
  render(
    <Approve identity={identity} secret={SECRET} port={port} view={view} now={() => NOW} />);
  for (const h of handlers) {
    h({ source: opener, origin, data } as unknown as MessageEvent);
  }
  /** The answer has crossed and the screen has caught up with it. */
  const answered = () => afterTheAnswer(opener);
  return { sent, answered };
};

const someone = async (): Promise<string[]> => {
  let profile = selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', 'legal', NOW);
  profile = selfAssert(profile, REGISTRY, EMAIL, 'sarah@work.example', 'work', NOW);
  await save(port, identity, profile);
  return profile.held.map((h) => h.id);
};

const responseFrom = (sent: { message: unknown }[]): DisclosureResponse =>
  sent[sent.length - 1]!.message as DisclosureResponse;

/** The button is written in the OBSERVED origin's words, so the label
 * follows it rather than being typed at each call site. */
const signInTo = (origin = ORIGIN): string => `Sign in to ${origin}`;

describe('a sign-in asks one question and lists nothing', () => {
  it('the question names the site, and there is not a single attribute row', async () => {
    await someone();
    open();
    await settled();
    screen.getByText('Who is asking');
    /* The question is written in what the BROWSER observed. It used to
     * read *"Do you want Payroll A to know it is you?"*, in the asker's words. */
    expect(document.querySelector('[data-sign-in-question]')?.textContent)
      .toBe(`Do you want ${ORIGIN} to know it is you?`);
    expect(document.querySelectorAll('[data-row]')).toHaveLength(0);
    expect(document.querySelector('[data-missing-required]')).toBeNull();
    expect(screen.getByText(signInTo())).toBeTruthy();
  });

  it('THE QUESTION AND THE BUTTON ARE THE OBSERVED ORIGIN, AND THE NAME IS NOT IN THEM',
    async () => {
      /*
       * **THIS IS THE TEST THAT CLOSES IT FOR SIGN-IN.** The change did
       * this to the unlock screen and left the other two kinds writing
       * themselves in `request.requester.name` — the one field on the whole ask
       * the ASKER chose. **A person who skims reads the question and the button
       * and nothing else**, so those two are exactly where a claim must not be.
       */
      await someone();
      open();
      await settled();
      screen.getByText('Who is asking');
      const question = document.querySelector('[data-sign-in-question]')?.textContent ?? '';
      expect(question).toContain(ORIGIN);
      expect(question).not.toContain('Payroll A');
      const button = document.querySelector('[data-approve]')?.textContent ?? '';
      expect(button).toContain(ORIGIN);
      expect(button).not.toContain('Payroll A');
      /* The name is still shown — it is what a person recognises — as a claim. */
      expect(document.querySelector('[data-requester-name]')?.textContent).toBe('Payroll A');
    });

  it('A PAGE CALLING ITSELF SOMEBODY ELSE IS ASKED ABOUT BY WHERE IT CAME FROM',
    async () => {
      /* The abused case, one kind further along: served from B, calling itself
       * Payroll A. The wallet's own voice says B. */
      const OTHER = 'https://payroll-b.example';
      await someone();
      open(signIn(), OTHER);
      await settled();
      screen.getByText('Who is asking');
      expect(document.querySelector('[data-sign-in-question]')?.textContent)
        .toBe(`Do you want ${OTHER} to know it is you?`);
      expect(screen.getByText(signInTo(OTHER))).toBeTruthy();
      expect(document.querySelector('[data-requester-origin]')?.textContent).toBe(OTHER);
      expect(document.querySelector('[data-requester-name]')?.textContent).toBe('Payroll A');
    });

  it('the origin is still the browser\'s, shown beside the name they chose', async () => {
    await someone();
    open();
    await settled();
    screen.getByText('Who is asking');
    expect(document.querySelector('[data-requester-name]')?.textContent).toBe('Payroll A');
    expect(document.querySelector('[data-requester-origin]')?.textContent).toBe(ORIGIN);
    expect(document.body.textContent).toContain('Your browser told this wallet that');
  });

  it('and it names the wallet that will answer, with its address on screen', async () => {
    await someone();
    open();
    await settled();
    screen.getByText('Who is asking');
    expect(document.querySelector('[data-address]')?.textContent ?? '').not.toBe('');
    expect(document.body.textContent).toContain('Which wallet answers');
  });

  it('a sign-in that carries attributes never reaches the button at all', async () => {
    await someone();
    open(signIn({ wants: [{ attribute: GIVEN_NAME, required: true }] }));
    await settled();
    screen.getByText('This request was refused before you saw it');
    expect(document.querySelector('[data-approve]')).toBeNull();
  });

  it('AND THE REFUSAL NAMES NO KIND, because a refused ask has no parsed kind', () => {
    /*
     * Found in an earlier walk: the refused screen said *Share your details* over
     * a refused SIGN-IN, because that heading was written when there was one
     * kind of ask. A heading that names one of two things it did not read is a
     * screen asserting something nobody checked.
     */
    open(signIn({ wants: [] }));
    return settled().then(() => {
      const heading = document.querySelector('h1');
      if (!heading) throw new Error('the refused screen showed no heading at all');
      expect(heading.textContent).toBe('Nothing has been shared');
    });
  });

  it('an unknown kind never reaches the button either', async () => {
    await someone();
    open(signIn({ kind: 'approve' }));
    await settled();
    screen.getByText('This request was refused before you saw it');
    expect(document.querySelector('[data-approve]')).toBeNull();
  });
});

describe('§6 — NO SILENT SIGN-IN, EVER', () => {
  it('NOTHING IS ANSWERED UNTIL A PERSON PRESSES SOMETHING', async () => {
    await someone();
    const { sent } = open();
    await settled();
    screen.getByText('Who is asking');
    /* The only thing that has crossed is the ready ping. */
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toMatchObject({ schema: 'midnight-identity/wallet-ready/v1' });
  });

  it('AND A REMEMBERED GRANT DOES NOT SKIP THE PRESS — it pre-ticks nothing', async () => {
    /* A site that could sign a person in without a press is a site that can act
     * as them, which is a strictly larger power than reading one attribute. */
    const ids = await someone();
    const opened = await load(port, identity);
    if (opened.of !== 'profile') throw new Error('unreachable');
    await save(port, identity, grantTo(
      opened.profile,
      { origin: ORIGIN, name: 'Payroll A', rdns: 'example.payroll-a' },
      0, ids, NOW));

    const { sent } = open();
    await settled();
    screen.getByText('Who is asking');
    expect(sent).toHaveLength(1);
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(document.querySelector('[data-approve]')).not.toBeNull();
  });

  it('declining says only that it was declined, at the observed origin', async () => {
    await someone();
    const { sent } = open();
    await settled();
    screen.getByText('Who is asking');
    fireEvent.click(screen.getByText('Do not sign in'));
    const answer = sent[sent.length - 1]!;
    expect(answer.message).toEqual({
      schema: 'midnight-identity/disclosure-refused/v1', reason: 'declined',
    });
    expect(answer.target).toBe(ORIGIN);
  });
});

describe('what crosses back, and what it is bound to', () => {
  const pressIt = async () => {
    const { sent, answered } = open();
    await settled();
    screen.getByText('Who is asking');
    fireEvent.click(screen.getByText(signInTo()));
    await answered();
    return sent;
  };

  it('THE ANSWER IS A SIGNATURE OVER NOTHING DISCLOSED, AND IT VERIFIES', async () => {
    await someone();
    const sent = await pressIt();
    expect(sent[sent.length - 1]!.target).toBe(ORIGIN);
    const response = responseFrom(sent);
    expect(response.payload.disclosed).toEqual([]);
    expect(response.payload.declined).toEqual([]);
    expect(verify(response, {
      atOrigin: ORIGIN,
      expectingNonce: 'n1',
      payingAddress: response.payload.address,
      networkId: 'stagenet',
      now: NOW,
    })).toEqual({ ok: true });
  });

  it('AND THE SAME SIGN-IN IS REFUSED AT A SECOND SITE', async () => {
    await someone();
    const sent = await pressIt();
    const response = responseFrom(sent);
    expect(verify(response, {
      atOrigin: 'https://payroll-b.example',
      expectingNonce: 'n1',
      payingAddress: response.payload.address,
      networkId: 'stagenet',
      now: NOW,
    })).toMatchObject({ ok: false, code: 'origin-mismatch' });
  });

  it('the address it is signed by is the one the screen showed', async () => {
    await someone();
    const { sent, answered } = open();
    await settled();
    const address = document.querySelector('[data-address]');
    if (!address) throw new Error('the screen never showed the address it would sign as');
    const shown = address.textContent ?? '';
    fireEvent.click(screen.getByText(signInTo()));
    await answered();
    expect(responseFrom(sent).payload.address).toBe(shown);
  });
});

describe('what the wallet writes down about it', () => {
  it('THE HISTORY RECORDS IT AS A SIGN-IN, not as a disclosure that sent nothing',
    async () => {
      await someone();
      const { sent } = open();
      await settled();
      screen.getByText('Who is asking');
      /* Declared BEFORE the press and awaited after it. `approve.tsx`
       * writes its history entry with `void save(...)`, correctly and without
       * awaiting it, so this waits for the WRITE rather than polling the store
       * for what the write said. */
      const written = afterWrites(port);
      fireEvent.click(screen.getByText(signInTo()));
      await afterTheSigning();
      await written();
      const opened = await load(port, identity);
      if (opened.of !== 'profile') throw new Error('the profile could not be opened');
      const entry = opened.profile.grants[0]!.disclosures[0]!;
      expect(entry.kind).toBe('sign-in');
      expect(entry.sent).toEqual([]);
      expect(entry.declined).toEqual([]);
      expect(entry.signed).not.toBeNull();
      expect(opened.profile.grants[0]!.recipient.origin).toBe(ORIGIN);
      expect(sent.length).toBeGreaterThan(1);
    });

  it('THE SENTENCE AFTERWARDS IS THE OBSERVED ORIGIN TOO, AND THE NAME IS NOT IN IT',
    async () => {
      /*
       * **THE RULE REACHES PAST THE PRESS.** This half was unpinned:
       * the sentence had been rebuilt from the observed origin and **nothing
       * looked at `[data-signed-in]` at all**, so putting `requester.name` back
       * into it left all seventeen tests in this file green.
       *
       * It matters as much as the button. *"On 23 Aug you signed in to Payroll
       * A"* is the wallet telling a person, in its own voice and after the
       * fact, that they did business with whoever the page said it was — and it
       * is the sentence they would be reading if they had come back to check.
       */
      await someone();
      const { sent } = open();
      await settled();
      screen.getByText('Who is asking');
      const written = afterWrites(port);
      fireEvent.click(screen.getByText(signInTo()));
      await afterTheSigning();
      await written();

      const said = document.querySelector('[data-signed-in]')?.textContent ?? '';
      expect(said).toContain(ORIGIN);
      expect(said).not.toContain('Payroll A');
      /* And the paragraph under it, which says what they keep. */
      const keeps = document.body.textContent ?? '';
      expect(keeps).toContain(`${ORIGIN} now holds a signed statement`);
      expect(keeps).not.toContain('Payroll A now holds a signed statement');
      expect(sent.length).toBeGreaterThan(1);
    });

  it('A SIGN-IN DOES NOT ERASE WHAT THE PERSON ALREADY AGREED THAT SITE MAY SEE',
    async () => {
      /* `grantTo` REPLACES a grant's value list, so a sign-in that called it
       * with the empty list it has would wipe the remembered values — and the
       * next disclosure screen would pre-tick nothing, with no way to tell that
       * from never having agreed. */
      const ids = await someone();
      const opened = await load(port, identity);
      if (opened.of !== 'profile') throw new Error('unreachable');
      await save(port, identity, grantTo(
        opened.profile,
        { origin: ORIGIN, name: 'Payroll A', rdns: 'example.payroll-a' },
        0, ids, NOW));

      open();
      await settled();
      screen.getByText('Who is asking');
      const written = afterWrites(port);
      fireEvent.click(screen.getByText(signInTo()));
      await afterTheSigning();
      await written();
      const after = await load(port, identity);
      if (after.of !== 'profile') throw new Error('the profile could not be opened');
      const grant = after.profile.grants.find((g) => g.subwallet === 0);
      if (!grant) throw new Error('the sign-in left no grant for this subwallet');
      expect([...grant.values].sort()).toEqual([...ids].sort());
    });

  it('and it says so afterwards without offering a leash it does not hold', async () => {
    await someone();
    open();
    await settled();
    screen.getByText('Who is asking');
    fireEvent.click(screen.getByText(signInTo()));
    await afterTheSigning();
    expect(document.body.textContent).toContain('Nothing can take back what has gone');
    for (const control of [...document.querySelectorAll('button, a')]) {
      const words = (control.textContent ?? '').toLowerCase();
      for (const forbidden of ['revoke', 'unshare', 'withdraw', 'take back', 'recall']) {
        expect(words).not.toContain(forbidden);
      }
    }
  });
});

/* ------------------------------------------------------------------------ */

/**
 * **THE WALLET SAID "SIGNED IN" WHILE THE OTHER SIDE WAS REFUSING.**
 *
 * On the first walk-through of the two applications the person approved, this
 * screen said *Signed in*, and the payroll tab refused the answer it had just
 * been handed. **Both facts were true.** The wallet signed and posted; whether
 * anybody accepted is on the far side of a channel to a different origin, and
 * this wallet never hears it.
 *
 * **The screen a person trusts most was the one furthest from the fact.** So
 * the heading is now the act and the site it was done for, and the outcome it
 * cannot observe is not claimed.
 */
describe('what this wallet says it DID, and never what it achieved', () => {
  it('THE HEADING NAMES THE ACT AND THE SITE, AND IS NOT A BARE "SIGNED IN"',
    async () => {
      await someone();
      open();
      await settled();
      screen.getByText('Who is asking');
      fireEvent.click(screen.getByText(signInTo()));

      const heading = await afterTheSigning();
      expect(heading.tagName).toBe('H1');
      expect(heading.textContent).toBe(`You signed in to ${ORIGIN}`);

      /* The defect itself, pinned: a heading that announces an outcome on
       * somebody else's behalf. Nothing on this screen may read as one. */
      for (const h of [...document.querySelectorAll('h1')]) {
        expect(h.textContent?.trim()).not.toBe('Signed in');
      }
    });

  it('AND IT NAMES THE ORIGIN THE BROWSER OBSERVED, not the name the asker chose',
    async () => {
      /* The rule reaching the heading too. `Payroll A` is what the ask
       * calls itself and it is the one field the asker fills in. */
      await someone();
      open();
      await settled();
      screen.getByText('Who is asking');
      fireEvent.click(screen.getByText(signInTo()));

      const heading = await afterTheSigning();
      expect(heading.textContent).toContain(ORIGIN);
      expect(heading.textContent).not.toContain('Payroll A');
    });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, secretFromWords } from 'midnight-identity/keys/derivation';
import { EMAIL, GIVEN_NAME, REGISTRY } from 'midnight-identity/profile/attributes';
import { emptyProfile, grantTo, originsFor, releasesOf, selfAssert } from 'midnight-identity/profile/model';
import { load, save } from 'midnight-identity/profile/store';
/* Second cause — the store counts its own writes so a test can wait for
 * the one `approve.tsx` deliberately does not await. `all()` is here for the
 * assertion that nothing secret reached the raw store. */
import { afterWrites, watchedStore } from '../testing/settled-store.js';
import type { WatchedPort } from '../testing/settled-store.js';
/* REOPENED. **The answer is AWAITED rather than polled for**, and
 * what the screen computes in an effect is reached by turning the loop a fixed
 * number of times. Neither has a deadline left for a busier machine to defeat;
 * `settled-channel.ts` says why raising one was a delay and not a fix. */
import { afterTheAnswer, settled, watchedOpener } from '../testing/settled-channel.js';
import type { Posted, WatchedOpener } from '../testing/settled-channel.js';
import { parseAsk } from 'midnight-identity/profile/request';
import type { KeyringRequest, UnlockRequest } from 'midnight-identity/profile/request';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { keyringKeyFor, readRelease, releaseFor, unlockKeyFor } from 'midnight-identity/profile/unlock';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import type { KeyringRelease, UnlockRelease } from 'midnight-identity/profile/unlock';
import { fromBase64Url, toBase64Url } from 'midnight-identity/passkey/bytes';
import { unshieldedAddressFor } from '../chain/unshielded.js';
import { rememberSignIn, walletSignedInTo } from '../lib/signed-in-here.js';
import { Approve } from './approve.js';

/**
 * **THE SCREEN THAT GIVES SOMETHING AWAY RATHER THAN SAYING SOMETHING.**
 *
 * A sign-in and a disclosure both end in a statement about the past. This ends
 * in a CAPABILITY: the site can read, from now on, and nobody can watch it or
 * take it back.
 *
 * **THIS FILE HAS A SECOND JOB.** The key now belongs to a COMPANY rather
 * than to a host, and the company is the one value in the whole protocol that
 * the asker chooses. What the design owes in return is that a person can SEE
 * the mismatch — so the observed origin and the company are shown together, and
 * **a name the site chose for itself is never the largest thing on the screen.**
 * `payroll-b.example` was found calling itself *Payroll A* under a
 * wallet headline reading *"Let Payroll A open your records"*.
 *
 * `sign-in-screen.test.tsx` and `approve-screen.test.tsx` are UNCHANGED by this
 * change and still drive the other two kinds through the same component.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const SECRET = secretFromWords(TEST_MNEMONIC);
const ORIGIN = 'https://payroll-a.example';
const OTHER = 'https://payroll-b.example';
const CO_A = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
const CO_B = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';

let port: WatchedPort;
beforeEach(() => { port = watchedStore(); });
afterEach(() => { cleanup(); });

/** An unlock on the wire — no `wants`, no `origin`, one `company`. */
const unlock = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'unlock',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'So we can show you your payslips.',
  company: CO_A,
  nonce: 'n1',
  expiresAt: NOW + 600_000,
  ...over,
});

/** What `open` hands back: the messages, and a way to AWAIT the next one. */
interface Opened {
  readonly sent: Posted[];
  /** Resolves when the answer has crossed AND the screen has caught up. */
  answered(): Promise<Posted>;
}

const open = (data: unknown = unlock(), origin = ORIGIN): Opened => {
  /* **THE OPENER IS WHAT RESOLVES THE WAIT.** `postMessage` is the moment the
   * answer crosses, so it is the moment the promise settles — there is no
   * interval here and nothing to lose a race to. `settled-channel.ts`. */
  const opener: WatchedOpener = watchedOpener();
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
  return { sent, answered: () => afterTheAnswer(opener) };
};

const someone = async (): Promise<string[]> => {
  let profile = selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', 'legal', NOW);
  profile = selfAssert(profile, REGISTRY, EMAIL, 'sarah@work.example', 'work', NOW);
  await save(port, identity, profile);
  return profile.held.map((h) => h.id);
};

/** What the key for a COMPANY actually is. Pinned INDEPENDENTLY — against
 * `@scure/bip32` rather than against this module — in `profile/unlock.test.ts`. */
const keyFor = (company: string, origin = ORIGIN): string => PolyfillBuffer
  .from(unlockKeyFor(
    identity, parseAsk(unlock({ company }), origin, NOW) as UnlockRequest))
  .toString('hex');

const hex = (bytes: Uint8Array): string => PolyfillBuffer.from(bytes).toString('hex');

const releaseFrom = (sent: { message: unknown }[]): UnlockRelease =>
  sent[sent.length - 1]!.message as UnlockRelease;

/**
 * **THIS FILE NO LONGER NAMES A BUDGET, BECAUSE IT NO LONGER WAITS.** The flake,
 * closed here. An earlier version gave every wait below eight seconds and another raised the
 * central default to five, and **both were delays rather than fixes**: a
 * number can always be defeated by a busier machine, and the failures that
 * proved it landed one tick past whatever the number was — 1,015ms under a
 * one-second budget, 5,014ms under five seconds, with **different test names
 * each run.**
 *
 * What is left in its place is two things, neither of which can time out:
 * `answered()` is resolved by the `postMessage` that carries the answer, and
 * `settle()` turns the event loop a fixed number of times. A loaded machine
 * makes both SLOWER and cannot make either FAIL, and a screen that genuinely
 * stops rendering what a test expects now fails on every machine rather than
 * on one in ten — which is the difference between a defect and a habit.
 *
 * The suite's own `testTimeout` is untouched, so an answer that never arrives
 * is still a failing test rather than a run that hangs.
 */

/** The button is written in the OBSERVED origin's words, so the label follows it. */
const giveTo = (origin = ORIGIN): string => `Give ${origin} the key`;

/**
 * **LET EVERYTHING PENDING RUN, AND THEN ASK**, and it exists because a
 * mutation survived without it.
 *
 * `findByText` resolves the moment the screen renders, which happens as soon as
 * the REQUEST arrives — before the sealed profile has finished loading. So a
 * silent answer that fires when the profile lands is a silent answer this file
 * would have missed: a mutation was watched surviving
 * against the first version of the two tests below, and dying against this one.
 *
 * **A pin nobody has watched fail is a claim**, and one watched failing only
 * because the timing happened to suit it is worse.
 */
const settle = (): Promise<void> => settled(20);

/**
 * **WHAT THE SCREEN SAYS, ONCE EVERYTHING PENDING HAS HAD ITS TURN.**
 * It replaces thirty-three `findByText` calls.
 *
 * `findByText` is a poll with a deadline. Everything it was used for in this
 * file is markup that is already in hand a microtask later — the ask arrives
 * synchronously, the sealed profile is a promise an in-memory store has
 * already resolved — so **what a test was waiting for was never work that
 * might take a while. It was the loop coming round.** `settle` turns the loop
 * a fixed number of times and then this asks, once.
 *
 * `getByText` is deliberate: it throws with the text it could not find and the
 * markup it looked in, so a screen that genuinely stopped saying something
 * fails with a readable reason on every machine, instead of *"Unable to find
 * an element"* after eight seconds on one machine in ten.
 */
const saying = async (text: string): Promise<HTMLElement> => {
  await settle();
  return screen.getByText(text);
};

/**
 * **WAIT FOR THE RECORD TO REACH THE STORE, NOT FOR THE SCREEN TO SAY IT DID.**
 *
 * The screen's done state is set synchronously; the write behind it is a
 * promise (`approve.tsx`, `void save(...)`). A test that renders a SECOND time
 * and expects the first release to be remembered is racing that promise — and
 * it lost, once, in a full run rather than alone
 * (an earlier run showed it; this one is
 * the later). **The behaviour is correct and the test was
 * wrong**, so the test waits for the artefact instead of for the sentence.
 *
 * **THIS WAITS FOR A RELEASE, WHICH IS WHY IT COULD NOT BE COPIED.** It is
 * the right wait for this screen and there is no version of it for a screen
 * with no release to look for, so the two other screens had no pattern to take
 * and one test here simply did without. `afterWrites` in `settled-store.ts` is
 * the content-free form; this stays because checking the artefact AS WELL says
 * something the count cannot, namely that what landed was a release.
 *
 * **IT NO LONGER POLLS FOR THE RELEASE, IT AWAITS THE WRITE AND THEN
 * LOOKS.** The poll it used to be re-read the whole sealed profile every
 * fifty milliseconds against a deadline, and the deadline is the thing this
 * is about. `written()` returns when a NEW write has arrived and stopped, so
 * by the time the profile is opened below there is nothing left in flight —
 * **and a release that never landed is now a named failure rather than a
 * timeout wearing a race's clothes.**
 */
const remembered = async (pressed: { written: () => Promise<void> }): Promise<void> => {
  await pressed.written();
  const opened = await load(port, identity);
  if (opened.of !== 'profile') {
    throw new Error('the sealed profile did not open after the key was given.');
  }
  if (releasesOf(opened.profile).length === 0) {
    throw new Error(
      'the write landed and it carried no release. That is the defect, not a wait that '
      + 'needed longer.');
  }
};

/**
 * **PRESS THE BUTTON ONLY ONCE THE SCREEN CAN ANSWER IT.**
 *
 * `release()` returns early while the sealed profile is still loading
 * (`approve.tsx`: `if (… || profile === null || channel === null) return;`), and
 * the screen renders as soon as the REQUEST arrives, which is earlier than that.
 * So a click fired the instant `Who is asking` appears can land on a button that
 * does nothing, and nothing re-fires it.
 *
 * It cost a full run to find (8,018ms
 * waiting for a message that was never going to come, on a loaded machine). It
 * is the same shape as an earlier FINDING facing the other way: that one was a
 * mutation firing too EARLY to be caught, this is a press landing too early to
 * be answered. `settle()` is the same instrument for both.
 *
 * **THE BEHAVIOUR BEHIND IT IS REPORTED, NOT FIXED** — the button is not
 * disabled while the profile loads, so a person can press it and see nothing
 * happen. It fails closed, so it is a defect of feedback and not of safety.
 */
const press = async (channel: Opened, origin = ORIGIN) => {
  await saying('Who is asking');
  await settle();
  /*
   * **THE WRITE COUNT IS TAKEN BEFORE THE CLICK, WHICH IS THE ONLY MOMENT IT
   * CAN BE.** Second cause. `approve.tsx` writes its history entry with
   * `void save(...)` — not awaited, and correctly so, because a key that has
   * gone cannot be un-given and the write must never gate the answer. So the
   * screen says *"They have the key"* before the record lands, and a test that
   * reads the store on the next line is racing a promise it cannot see.
   * `written()` is how any test here waits for it; `settled-store.ts` says why
   * it waits for the WRITE rather than for what the write said.
   */
  const written = afterWrites(port);
  fireEvent.click(screen.getByText(giveTo(origin)));
  /*
   * **THE ANSWER IS AWAITED, NOT POLLED FOR**, and this is the wait
   * that lost the race on a real machine at 5,014ms in its old shape,
   * `waitFor(() => { if (sent.length < 2) throw })`. What it is waiting for is
   * a real Schnorr key release — **the one genuinely CPU-hungry step in this
   * file, and so the one step that loses a race for a core** when sixty other
   * files are running. `answered()` is resolved by the `postMessage` that
   * carries it, so a busier machine makes this slower and cannot make it fail.
   */
  await channel.answered();
  return Object.assign(channel.sent, { written });
};

/**
 * **HOW BIG A THING IS, IN THE ONLY UNITS THIS DESIGN SYSTEM HAS.** There is a
 * claim rendered larger than the fact that checks it, so the test that closes
 * it has to be able to compare two sizes rather than assert that both exist.
 *
 * Tailwind's scale is a fixed ladder of tokens; the screen names its two rungs
 * (`FACT_TEXT`, `CLAIM_TEXT`) rather than typing them at each call site. A
 * heading has no token and is the largest thing there is.
 */
const SCALE = ['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl'];
const sizeOf = (selector: string): number => {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`nothing matched ${selector}`);
  if (element.tagName === 'H1') return SCALE.length;
  const token = [...element.classList].find((c) => SCALE.includes(c));
  if (token === undefined) {
    throw new Error(`${selector} carries no size token, so its size cannot be checked`);
  }
  return SCALE.indexOf(token);
};

describe('§4 — THE SCREEN IS WRITTEN IN WHAT WAS OBSERVED, NOT IN WHAT WAS CLAIMED', () => {
  it('THE HEADLINE IS THE OBSERVED ORIGIN, AND THE NAME IS NOT IN IT', async () => {
    /*
     * **THIS IS THE TEST THAT CLOSES IT FOR THIS SCREEN.** The
     * headline used to be built from `request.requester.name` — the one field
     * on the whole ask the ASKER chose — which is how a page served from
     * `payroll-b.example` came to sit under *"Let Payroll A open your records"*.
     */
    await someone();
    open();
    await saying('Who is asking');
    const headline = document.querySelector('[data-headline]')?.textContent ?? '';
    expect(headline).toContain(ORIGIN);
    expect(headline).not.toContain('Payroll A');
    /* And the button a person actually presses, which the rule names too. */
    expect(screen.getByText(giveTo())).toBeTruthy();
    expect(document.querySelector('[data-approve]')?.textContent).not.toContain('Payroll A');
  });

  it('A PAGE CALLING ITSELF SOMEBODY ELSE IS DESCRIBED BY WHERE IT CAME FROM', async () => {
    /* The abused case from `w2-unlock-dark-second-site.png`, made into a test:
     * served from B, calling itself Payroll A. The wallet's own voice says B. */
    await someone();
    open(unlock({ requester: { name: 'Payroll A', rdns: 'example.payroll-a' } }), OTHER);
    await saying('Who is asking');
    expect(document.querySelector('[data-headline]')?.textContent).toContain(OTHER);
    expect(document.querySelector('[data-headline]')?.textContent).not.toContain('Payroll A');
    expect(document.querySelector('[data-observed-origin]')?.textContent).toBe(OTHER);
    /* The name is still shown — it is what a person recognises — as a claim. */
    expect(document.querySelector('[data-requester-name]')?.textContent).toBe('Payroll A');
  });

  it('NEITHER FACT IS SMALLER THAN THE NAME THE SITE CHOSE FOR ITSELF', async () => {
    await someone();
    open();
    await saying('Who is asking');
    const claim = sizeOf('[data-requester-name]');
    expect(sizeOf('[data-observed-origin]')).toBeGreaterThanOrEqual(claim);
    expect(sizeOf('[data-company]')).toBeGreaterThanOrEqual(claim);
    /* And the largest thing on the page is a fact rather than a claim. */
    expect(sizeOf('[data-headline]')).toBeGreaterThan(claim);
  });

  it('THE COMPANY IS SHOWN WHOLE, and beside the origin rather than instead of it',
    async () => {
      /* A selector narrower than the thing it selects can be ground, and an
       * address SHOWN narrower than it is, is the same mistake at the person. */
      await someone();
      open();
      await saying('Who is asking');
      expect(document.querySelector('[data-company]')?.textContent).toBe(CO_A);
      expect(document.querySelector('[data-observed-origin]')?.textContent).toBe(ORIGIN);
      expect(document.body.textContent)
        .toContain('This wallet cannot check that those two belong together');
    });

  it('THE COMPANY IS ALSO SHOWN AS SOMETHING A PERSON COULD READ DOWN A PHONE',
    async () => {
      /*
       * **THE FINDING.** The screen told somebody *"if you do not recognise the
       * company, do not give the key"* and then showed them
       * `dbe119a3…65c8`. **The one instruction on the page a person must follow
       * was the one no person can.** The fingerprint is the same address in a
       * form that can be put in an invitation, read down a phone, and compared.
       */
      await someone();
      open();
      await saying('Who is asking');
      const shown = document.querySelector('[data-company-fingerprint]')?.textContent ?? '';
      expect(shown).toBe(companyFingerprint(CO_A));
      expect(shown).toBe('P5DN-KZ3N-G1RX-1QDF-WZZB');
      /* The full address is still on the screen: the fingerprint stands for it
       * and does not replace the fact. */
      expect(document.querySelector('[data-company]')?.textContent).toBe(CO_A);
      /* **AND IT IS BIGGER THAN THE THING IT STANDS FOR**, because it is what a
       * person is actually being asked to compare. */
      expect(sizeOf('[data-company-fingerprint]'))
        .toBeGreaterThan(sizeOf('[data-company]'));
      expect(document.body.textContent).toContain('Compare all of it, not the ends');
    });

  it('A DIFFERENT COMPANY SHOWS A DIFFERENT FINGERPRINT, AND ONE THAT IS NOT NEARBY',
    async () => {
      /* The reason it is worth showing: it must not be true that two companies
       * a person could confuse render two fingerprints a person could confuse. */
      await someone();
      open(unlock({ company: CO_B }));
      await saying('Who is asking');
      const shown = document.querySelector('[data-company-fingerprint]')?.textContent ?? '';
      expect(shown).toBe(companyFingerprint(CO_B));
      expect(shown).not.toBe(companyFingerprint(CO_A));
    });

  it('THE FINGERPRINT IS ON THE WARNING AND IN THE SENTENCE AFTERWARDS TOO',
    async () => {
      /* The finding names all three places the raw address was shown. The sentence
       * afterwards is the one that wrapped sixty-four characters through the
       * middle of itself. */
      await someone();
      const first = open();
      const pressed = await press(first);
      await saying('They have the key');
      await remembered(pressed);
      /* THE SENTENCE AFTERWARDS: the fingerprint is IN the sentence and the
       * sixty-four characters are on a line of their own beneath it. */
      expect(document.querySelector('[data-given-fingerprint]')?.textContent)
        .toBe(companyFingerprint(CO_A));
      const sentence = document.querySelector('.lede')?.textContent ?? '';
      expect(sentence).toContain(companyFingerprint(CO_A));
      expect(sentence).not.toContain(CO_A);
      cleanup();

      /* THE WARNING. */
      open(unlock({ nonce: 'n2' }), OTHER);
      await saying('Who is asking');
      expect(document.querySelector('[data-warning-fingerprint]')?.textContent)
        .toBe(companyFingerprint(CO_A));
    });

  it('THE FINGERPRINT IS NEVER AN INPUT TO THE KEY, WHATEVER THE SCREEN SHOWS',
    async () => {
      /*
       * **A HUNDRED-BIT SELECTOR FOR A TWO-HUNDRED-AND-FIFTY-SIX-BIT THING IS
       * THE REJECTED DESIGN IN A NEW HAT**, and it would read perfectly.
       * The key that crosses is still the pure function of the seed and the
       * WHOLE address, checked here against the same value pinned elsewhere.
       */
      await someone();
      const channel = open();
      const { sent } = channel;
      await press(channel);
      await saying('They have the key');
      const release = releaseFrom(sent);
      expect(hex(fromBase64Url(release.key))).toBe(keyFor(CO_A));
      /* And the fingerprint is on no wire: it is a rendering, and the other
       * side computes its own from the address it already has. */
      expect(JSON.stringify(release)).not.toContain(companyFingerprint(CO_A));
      expect(release.company).toBe(CO_A);
    });

  it('an unlock naming no company never reaches the button', async () => {
    await someone();
    const { company, ...withoutCompany } = unlock();
    expect(company).toBe(CO_A);
    open(withoutCompany);
    await saying('This request was refused before you saw it');
    expect(document.querySelector('[data-approve]')).toBeNull();
  });
});

describe('§2 — THE SCREEN SAYS WHAT THEY WILL BE ABLE TO DO, NOT THAT A KEY MOVES', () => {
  it('asks one question about reading, and lists no attributes at all', async () => {
    await someone();
    open();
    await saying('Who is asking');
    expect(document.querySelector('[data-unlock-question]')?.textContent)
      .toContain(`Do you want ${ORIGIN} to be able to open the records this company keeps`);
    expect(document.querySelectorAll('[data-row]')).toHaveLength(0);
    expect(screen.getByText(giveTo())).toBeTruthy();
  });

  it('says the three things a person needs: what it is, how long, and that it stays given',
    async () => {
      await someone();
      open();
      await saying('Who is asking');
      const words = document.body.textContent ?? '';
      /* WHAT: the ability to read, not a fact about them. */
      expect(words).toContain('This is not a fact about you. It is the ability to read.');
      /* FOR HOW LONG: the honest answer rather than "until you say stop". */
      expect(words).toContain('nothing stops them keeping their own copy');
      /* AND IT DOES NOT COME BACK. §6 binds hardest here. */
      expect(words).toContain('nothing can take back a key');
      /* NEVER THE MECHANISM: not "release a key". */
      for (const jargon of ['release', 'derive', 'hkdf', 'seed', 'secret key']) {
        expect(words.toLowerCase(), jargon).not.toContain(jargon);
      }
    });

  it('THE ORIGIN IS SHOWN AS THE BROWSER’S, beside the name they chose for themselves',
    async () => {
      await someone();
      open();
      await saying('Who is asking');
      expect(document.querySelector('[data-requester-name]')?.textContent).toBe('Payroll A');
      expect(document.querySelector('[data-requester-origin]')?.textContent).toBe(ORIGIN);
      expect(document.body.textContent).toContain('Your browser told this wallet that');
    });

  it('OFFERS NO WALLET PICKER, and says the key belongs to the company', async () => {
    /*
     * The key is a function of the ACCOUNT and the company. A picker here would
     * imply a per-slot separation the mechanism does not provide — and
     * a per-slot key could only be found again if the slot were REMEMBERED,
     * which is that shape. **This adds the other half of the same sentence:**
     * it is not per-host either, which is what makes a copy worth taking.
     */
    await someone();
    open();
    await saying('Who is asking');
    expect(document.querySelector('#approve-subwallet')).toBeNull();
    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect(document.querySelector('[data-address]')).toBeNull();
    const said = document.querySelector('[data-not-per-wallet]')?.textContent ?? '';
    expect(said).toContain('the same key again if you ever have to rebuild this wallet');
    expect(said).toContain('somewhere that is not this website');
  });

  it('an unlock that also carries attributes never reaches the button', async () => {
    await someone();
    open(unlock({ wants: [{ attribute: GIVEN_NAME, required: true }] }));
    await saying('This request was refused before you saw it');
    expect(document.querySelector('[data-approve]')).toBeNull();
  });
});

describe('§3 — THE WALLET REMEMBERS WHICH HOST ASKED FOR WHICH COMPANY, AND WARNS', () => {
  it('SAYS NOTHING THE FIRST TIME A COMPANY IS SEEN', async () => {
    await someone();
    open();
    await saying('Who is asking');
    expect(document.querySelector('[data-seen-elsewhere]')).toBeNull();
    expect(document.querySelector('[data-approve]')).not.toBeNull();
  });

  it('AND SAYS SO, BEFORE THE BUTTON, WHEN THE SAME COMPANY ARRIVES FROM A NEW HOST',
    async () => {
      await someone();
      /* Given once, at A. */
      const first = open();
      const pressed = await press(first);
      await saying('They have the key');
      await remembered(pressed);
      cleanup();

      /* Asked again, for the same company, from B. */
      open(unlock({ nonce: 'n2' }), OTHER);
      await saying('Who is asking');
      /*
       * **AND THEN LET THE PROFILE ARRIVE.** `findByText` resolves when the
       * REQUEST does, which is earlier than the sealed profile — and the
       * warning is computed from the profile, so without this the query below
       * can read a screen that has not been told anything yet. **It was watched
       * failing at 61ms** in one run of this file while five others were green,
       * which is the second-cause shape again: fast, not a timeout, and nothing
       * to do with the wait budget. No assertion here changed.
       */
      await settle();
      const warning = document.querySelector('[data-seen-elsewhere]')?.textContent ?? '';
      expect(warning).toContain(ORIGIN);
      expect(warning).toContain(OTHER);
      /* **IT WARNS AND NEVER REFUSES.** A company legitimately moves host —
       * that is the point of the whole round. The person decides. */
      expect(screen.getByText(giveTo(OTHER))).toBeTruthy();
      /* And the warning stands above the button a person is about to press. */
      const order = document.body.textContent ?? '';
      expect(order.indexOf('given this company’s key to a different page'))
        .toBeLessThan(order.indexOf(giveTo(OTHER)));
    });

  it('A KNOWN COMPANY FROM A NEW HOST IS WARNED AND NEVER REFUSED — SAID DIRECTLY',
    async () => {
      /*
       * **§4. THE RULE WAS PINNED ONLY BY ACCIDENT AND THAT IS THE FINDING.**
       * Nothing asserted the button was still PRESSABLE. The rule survived
       * because the test above this one drives a second host all the way
       * through and hangs when the button is disabled — **failing after 8,094ms
       * of waiting.**
       *
       * **A REGRESSION CAUGHT BY A TIMEOUT LOOKS EXACTLY LIKE A FLAKE**, which is
       * the one disguise a real failure must never be allowed to wear: a person
       * who has learned that a slow red means "run it again" would run it
       * again, and the second run would be red for a reason nobody could name.
       *
       * So this asserts it in one place, immediately, and fails in
       * milliseconds: the warning is there, the button is there, it is not
       * disabled, and the screen is not the refusal screen.
       */
      await someone();
      const first = open();
      const pressed = await press(first);
      await saying('They have the key');
      await remembered(pressed);
      cleanup();

      open(unlock({ nonce: 'n2' }), OTHER);
      await saying('Who is asking');
      await settle();

      /* WARNED. */
      expect(document.querySelector('[data-seen-elsewhere]')).not.toBeNull();
      /* AND NOT REFUSED — every way this screen has of refusing. */
      const button = document.querySelector('[data-approve]');
      expect(button).not.toBeNull();
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(button!.getAttribute('aria-disabled')).toBeNull();
      expect(button!.textContent).toBe(giveTo(OTHER));
      expect(screen.queryByText('This request was refused before you saw it')).toBeNull();
      expect(document.querySelector('[data-decline]')).not.toBeNull();
    });

  it('a DIFFERENT company from the same host is ordinary and says nothing', async () => {
    await someone();
    const first = open();
    const pressed = await press(first);
    await saying('They have the key');
    await remembered(pressed);
    cleanup();

    open(unlock({ company: CO_B, nonce: 'n2' }));
    await saying('Who is asking');
    expect(document.querySelector('[data-seen-elsewhere]')).toBeNull();
  });

  it('THE REMEMBERED LIST IS NEVER AN INPUT: the second host gets the SAME key',
    async () => {
      /*
       * **RULE 5, AT THE SCREEN, AND IT IS THE CHANGE'S QUIETEST DANGER.** If a
       * remembered pair ever reached the derivation, a recovered wallet — or a
       * second device, or one whose history was cleared — would stop opening a
       * company's records with nothing broken and nothing to fix. The defect by a
       * different door.
       *
       * So: give the key once at A, ask again from B, and compare the bytes
       * against the pure function computed with no history at all.
       */
      await someone();
      const first = open();
      const pressed = await press(first);
      const atA = releaseFrom(first.sent);
      await saying('They have the key');
      await remembered(pressed);
      cleanup();

      const second = open(unlock({ nonce: 'n2' }), OTHER);
      await press(second, OTHER);
      const atB = releaseFrom(second.sent);

      expect(hex(fromBase64Url(atB.key))).toBe(hex(fromBase64Url(atA.key)));
      expect(hex(fromBase64Url(atB.key))).toBe(keyFor(CO_A));
      expect(atB.origin).toBe(OTHER);
      expect(atB.company).toBe(CO_A);
    });
});

describe('§1 — NO SILENT UNLOCK, EVER', () => {
  it('NOTHING IS ANSWERED UNTIL A PERSON PRESSES SOMETHING', async () => {
    await someone();
    const { sent } = open();
    await saying('Who is asking');
    /* EVERY PENDING PROMISE IS GIVEN ITS TURN FIRST — see `settle`. */
    await settle();
    expect(screen.getByText(giveTo())).toBeTruthy();
    /* The only thing that has crossed is the ready ping. */
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toMatchObject({ schema: 'midnight-identity/wallet-ready/v1' });
  });

  it('AND A REMEMBERED GRANT DOES NOT SKIP THE PRESS — there is nothing to pre-tick',
    async () => {
      /* A site that could obtain a key without a person present is a site that
       * can read a company whenever it likes. */
      const ids = await someone();
      const opened = await load(port, identity);
      if (opened.of !== 'profile') throw new Error('unreachable');
      await save(port, identity, grantTo(
        opened.profile,
        { origin: ORIGIN, name: 'Payroll A', rdns: 'example.payroll-a' },
        0, ids, NOW));

      const { sent } = open();
      await saying('Who is asking');
      await settle();
      expect(sent).toHaveLength(1);
      expect(document.querySelectorAll('input')).toHaveLength(0);
      expect(document.querySelector('[data-approve]')).not.toBeNull();
    });

  it('declining says only that it was declined, at the observed origin', async () => {
    await someone();
    const { sent } = open();
    await saying('Who is asking');
    fireEvent.click(screen.getByText('Do not give a key'));
    const answer = sent[sent.length - 1]!;
    expect(answer.message).toEqual({
      schema: 'midnight-identity/disclosure-refused/v1', reason: 'declined',
    });
    expect(answer.target).toBe(ORIGIN);
    expect(JSON.stringify(answer.message)).not.toContain(keyFor(CO_A));
  });
});

describe('WHAT CROSSES BACK, AND WHICH KEY IT IS', () => {
  it('the key for the NAMED company, to the observed origin, and nowhere else',
    async () => {
      await someone();
      const sent = await press(open());
      const answer = sent[sent.length - 1]!;
      expect(answer.target).toBe(ORIGIN);
      const read = readRelease(answer.message, {
        atOrigin: ORIGIN, expectingNonce: 'n1', forCompany: CO_A,
      });
      expect(read.ok).toBe(true);
      expect(read.ok && hex(read.key)).toBe(keyFor(CO_A));
    });

  it('A REQUEST CALLING ITSELF SOMEBODY ELSE STILL GETS THE KEY FOR WHAT IT NAMED',
    async () => {
      /* The body says Payroll B in the one field it is allowed to have; the
       * event came from A; the key is the one for the COMPANY it asked about,
       * and the answer goes to where the browser said the page came from. */
      await someone();
      const channel = open(
        unlock({ requester: { name: 'Payroll A', rdns: 'example.payroll-b' } }), ORIGIN);
      const { sent } = channel;
      await press(channel);
      const released = releaseFrom(sent);
      expect(hex(fromBase64Url(released.key))).toBe(keyFor(CO_A));
      expect(hex(fromBase64Url(released.key))).not.toBe(keyFor(CO_B));
      expect(released.origin).toBe(ORIGIN);
      expect(released.company).toBe(CO_A);
    });

  it('and a second company from the same page gets a different key', async () => {
    await someone();
    const channel = open(unlock({ company: CO_B }));
    const { sent } = channel;
    await press(channel);
    expect(hex(fromBase64Url(releaseFrom(sent).key))).toBe(keyFor(CO_B));
    expect(hex(fromBase64Url(releaseFrom(sent).key))).not.toBe(keyFor(CO_A));
  });
});

describe('§3 — WHAT IS RECORDED, AND WHAT MUST NOT BE', () => {
  it('records that a key was given, to which origin, for which company, and when',
    async () => {
      await someone();
      const pressed = await press(open());
      await saying('They have the key');
      /*
       * **THE WRITE IS AWAITED AND THEN THE RECORD IS READ ONCE.**
       * This used to re-open the whole sealed profile every fifty milliseconds
       * against a deadline, with the assertions INSIDE the poll — so a record
       * that was written wrong was retried until the budget ran out and then
       * reported as *"waiting"*, which names neither the field that was wrong
       * nor the value it held. `written()` returns when the write has arrived
       * and stopped; everything below is then an ordinary assertion that says
       * what it found.
       */
      await pressed.written();
      const opened = await load(port, identity);
      if (opened.of !== 'profile') throw new Error('the sealed profile did not open');
      const releases = releasesOf(opened.profile);
      expect(releases).toHaveLength(1);
      expect(releases[0]!.recipient.origin).toBe(ORIGIN);
      expect(releases[0]!.company).toBe(CO_A);
      expect(releases[0]!.at).toBe(NOW);
      expect(releases[0]!.nonce).toBe('n1');
      expect(originsFor(opened.profile, CO_A)).toEqual([ORIGIN]);
    });

  it('AND IT IS NOT WRITTEN AS A DISCLOSURE THAT SENT NOTHING', async () => {
    /* The finding, one kind further along: a release is a different event and
     * must not wear a disclosure's words. It also touches no grant. */
    const ids = await someone();
    const opened = await load(port, identity);
    if (opened.of !== 'profile') throw new Error('unreachable');
    await save(port, identity, grantTo(
      opened.profile,
      { origin: ORIGIN, name: 'Payroll A', rdns: 'example.payroll-a' },
      0, ids, NOW));

    const pressed = await press(open());
    await saying('They have the key');
    await pressed.written();
    const after = await load(port, identity);
    if (after.of !== 'profile') throw new Error('the sealed profile did not open');
    /* The release landed — the positive control for everything below, which is
     * all absences and would pass against a store nothing ever reached. */
    expect(releasesOf(after.profile)).toHaveLength(1);
    const grant = after.profile.grants.find((g) => g.subwallet === 0);
    expect(grant?.disclosures ?? []).toEqual([]);
    /* And the grant it already had is exactly as it was. */
    expect([...(grant?.values ?? [])].sort()).toEqual([...ids].sort());
  });

  it('THE KEY IS ON NO SCREEN, IN NO RECORD, IN NO STORE AND IN NO URL', async () => {
    /*
     * THE RULE: *the key itself is never recorded. Anywhere. Not in the
     * history, not in a log, not in a URL, not in `localStorage`, not in a
     * screenshot. The walker photographs this screen — make sure there is
     * nothing on it to photograph.*
     *
     * Eight characters of a base64url key would be enough to be a leak, so the
     * search is for a prefix as well as for the whole string.
     */
    await someone();
    const channel = open();
    const { sent } = channel;
    const before = document.body.outerHTML;
    const pressed = await press(channel);
    await saying('They have the key');
    const key = releaseFrom(sent).key;
    const raw = hex(fromBase64Url(key));

    for (const [where, text] of [
      ['the screen before the press', before],
      ['the screen after the press', document.body.outerHTML],
      ['the window location', window.location.href],
      ['the raw store', port.all()],
    ] as const) {
      expect(text.includes(key), `the key is in ${where}`).toBe(false);
      expect(text.includes(key.slice(0, 8)), `part of the key is in ${where}`).toBe(false);
      expect(text.includes(raw), `the key’s bytes are in ${where}`).toBe(false);
    }

    /*
     * **WAIT FOR THE WRITE THAT IS DELIBERATELY NOT AWAITED.** Found by §1:
     * under load this test failed at **106ms** on
     * `expect(stored.includes(CO_A)).toBe(true)` — the POSITIVE control — while
     * every key-absence assertion in it passed. Not a timeout; the `void
     * save(...)` race the file's own `remembered` helper already exists for.
     * **The behaviour is correct and the reading was early**, so the test waits
     * for the write. Not one assertion below is different.
     *
     * It waits with `written()` rather than with `remembered()` because what it
     * reads the store for is an ABSENCE — no key, anywhere — and there is no
     * artefact to wait for the appearance of. `settled-store.ts` is that wait.
     */
    await pressed.written();
    const opened = await load(port, identity);
    if (opened.of !== 'profile') throw new Error('unreachable');
    const stored = JSON.stringify(opened.profile);
    expect(stored.includes(key)).toBe(false);
    expect(stored.includes(key.slice(0, 8))).toBe(false);
    expect(stored.includes(raw)).toBe(false);
    /* The company address IS on the screen and IS in the record, on purpose:
     * it is a public identifier, and it is what the warning is computed from. */
    expect(document.body.outerHTML.includes(CO_A)).toBe(true);
    expect(stored.includes(CO_A)).toBe(true);
  });

  it('and it says so afterwards without offering a leash it does not hold', async () => {
    await someone();
    await press(open());
    await saying('They have the key');
    const said = document.querySelector('[data-key-given]')?.textContent ?? '';
    /* The sentence afterwards is written in what was observed too. */
    expect(said).toContain(ORIGIN);
    expect(said).toContain(CO_A);
    expect(said).not.toContain('Payroll A');
    expect(document.body.textContent).toContain('Nothing takes back a key that has gone');
    for (const control of [...document.querySelectorAll('button, a')]) {
      const words = (control.textContent ?? '').toLowerCase();
      for (const forbidden of ['revoke', 'unshare', 'withdraw', 'take back', 'recall']) {
        expect(words).not.toContain(forbidden);
      }
    }
  });
});

describe('THE KEYS SAVED FOR YOU AT A SITE - given only by the wallet that signed in there', () => {
  /*
   * A person's saved keys at a site are sealed under one key this wallet makes
   * for that person there. Those saved keys are how they approve payments for
   * every company they belong to on that site, so the screen says so, names the
   * page by where the browser saw it come from, and gives the key only when this
   * is the wallet the page signed in with.
   */
  const PERSON = 'usr_AbCdEf123456';
  /* Well shaped, and not the address of any account this wallet has. */
  const NOT_HELD = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
  /* Subwallet 1 lives at account 2. */
  const SLOT_ACCOUNT = 2;
  const mine = (): string => unshieldedAddressFor(identity, SLOT_ACCOUNT);

  /** A keyring ask on the wire: a person, and optionally the signed-in address and a company. */
  const keyring = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    schema: 'midnight-identity/disclosure-request/v1',
    kind: 'keyring',
    requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
    purpose: 'So the keys saved for you here can be opened.',
    person: PERSON,
    nonce: 'k1',
    expiresAt: NOW + 600_000,
    ...over,
  });

  const keyringKeyOf = (ask: Record<string, unknown>, origin = ORIGIN): string =>
    toBase64Url(keyringKeyFor(identity, parseAsk(ask, origin, NOW) as KeyringRequest));

  const giveButton = (): HTMLButtonElement => {
    const button = document.querySelector('[data-approve][data-keyring]');
    if (button === null) throw new Error('the keyring screen has no Give button');
    return button as HTMLButtonElement;
  };

  /**
   * Calls the Give button's own click handler, even while the button is
   * disabled - a disabled button is the screen's refusal, and this checks the
   * refusal that stands behind it.
   */
  const invokeHandlerAnyway = (element: Element): void => {
    const name = Object.keys(element).find((k) => k.startsWith('__reactProps$'));
    if (name === undefined) throw new Error('the button carries no rendered props to call');
    const props = (element as unknown as Record<string, { onClick?: () => void }>)[name]!;
    if (typeof props.onClick !== 'function') throw new Error('the button has no click handler');
    act(() => { props.onClick!(); });
  };

  const everythingInLocalStorage = (): string => {
    const all: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const name = localStorage.key(i);
      if (name !== null) all.push(name, localStorage.getItem(name) ?? '');
    }
    return all.join('\n');
  };

  it('names the page the browser saw, the address it says you signed in with, which of your wallets that is, and what the keys can do',
    async () => {
      await someone();
      const address = mine();
      /* Served from B and calling itself Payroll A: the wallet's own words say B. */
      open(keyring({ signedInAs: address }), OTHER);
      await saying('Who is asking');
      await settle();

      const headline = document.querySelector('h1[data-headline]')?.textContent ?? '';
      expect(headline).toBe(`Let ${OTHER} use the keys saved under the account name it gives`);
      /* Nothing on the screen places the keys at the page that is asking. */
      expect(document.body.textContent).not.toContain('saved for you there');
      expect(headline).not.toContain('Payroll A');
      expect(document.querySelector('[data-observed-origin]')?.textContent).toBe(OTHER);

      expect(document.querySelector('[data-signed-in-as]')?.textContent).toBe(address);
      /* The account name the key is made from is shown, and said to be unchecked. */
      expect(document.querySelector('[data-keyring-person]')?.textContent).toBe(PERSON);
      expect(document.querySelector('[data-keyring-person-unchecked]')?.textContent ?? '')
        .toContain('cannot check that it is yours');
      expect(document.querySelector('[data-signed-in-holder]')?.textContent)
        .toBe('That is Subwallet 1, in this wallet.');
      expect(document.querySelector('[data-signed-in-unknown]')).toBeNull();
      expect(document.querySelector('[data-not-signed-in-here]')).toBeNull();

      const power = document.querySelector('[data-keyring-power]')?.textContent ?? '';
      expect(power).toContain('approve payments for');
      expect(power).toContain('every company you belong to on that site');
      expect(document.body.textContent).not.toContain('It is the ability to read');

      expect(giveButton().textContent).toBe(giveTo(OTHER));
      expect(giveButton().disabled).toBe(false);
    });

  it('GIVE: one answer crosses, to the page the browser saw, carrying the key for this person and no company key - and nothing about it is stored',
    async () => {
      await someone();
      const address = mine();
      const ask = keyring({ signedInAs: address });
      const channel = open(ask);
      await press(channel);
      await settle();

      /* The ready ping, then exactly one answer. */
      const answers = channel.sent.slice(1);
      expect(answers).toHaveLength(1);
      expect(answers[0]!.target).toBe(ORIGIN);
      const release = answers[0]!.message as KeyringRelease;
      expect(release.schema).toBe('midnight-identity/keyring-release/v1');
      expect(release.origin).toBe(ORIGIN);
      expect(release.key).toBe(keyringKeyOf(ask));
      expect(release.companyKey).toBeNull();
      expect(release.signedInAs).toBe(address);
      expect(document.querySelector('[data-keyring-given]')).not.toBeNull();
      /* And afterwards nothing places the keys at the page that asked, either. */
      expect(document.body.textContent).not.toContain('saved for you there');

      const raw = hex(fromBase64Url(release.key));
      for (const [where, text] of [
        ['localStorage', everythingInLocalStorage()],
        ['the wallet store', port.all()],
        ['the screen', document.body.outerHTML],
      ] as const) {
        expect(text.includes(release.key), `the key is in ${where}`).toBe(false);
        expect(text.includes(raw), `the key's bytes are in ${where}`).toBe(false);
      }
    });

  it('NOT THIS WALLET\'S ADDRESS: the danger is shown, Give is disabled, and no key leaves even when its handler runs',
    async () => {
      await someone();
      const channel = open(keyring({ signedInAs: NOT_HELD }));
      await saying('Who is asking');
      await settle();

      const danger = document.querySelector('[data-not-signed-in-here]')?.textContent ?? '';
      expect(danger).toContain(ORIGIN);
      expect(danger).toContain('no account in this wallet has');
      expect(document.querySelector('[data-signed-in-holder]')).toBeNull();
      expect(giveButton().disabled).toBe(true);

      fireEvent.click(giveButton());
      invokeHandlerAnyway(giveButton());
      await settle();

      /* Only the ready ping has crossed, and no message carries a key. */
      expect(channel.sent).toHaveLength(1);
      expect(channel.sent.some((m) => (m.message as { key?: unknown } | null)?.key !== undefined))
        .toBe(false);
      const problem = document.querySelector('[data-keyring-problem]')?.textContent ?? '';
      expect(problem).toContain('none of this wallet\'s accounts has');
      expect(problem).toContain('Nothing has been given.');
    });

  it('NO ADDRESS NAMED: the screen says the page does not say, and Give is offered and answers with no address',
    async () => {
      await someone();
      const ask = keyring();
      const channel = open(ask);
      await saying('Who is asking');
      await settle();

      expect(document.querySelector('[data-signed-in-unknown]')).not.toBeNull();
      expect(document.querySelector('[data-signed-in-as]')).toBeNull();
      expect(document.querySelector('[data-not-this-wallet]')).toBeNull();
      expect(giveButton().disabled).toBe(false);

      await press(channel);
      const release = channel.sent[1]!.message as KeyringRelease;
      expect(release.signedInAs).toBeNull();
      expect(release.key).toBe(keyringKeyOf(ask));
    });

  it('NO ADDRESS NAMED, AND ANOTHER WALLET HERE ANSWERED THAT PAGE\'S SIGN-IN: the reason is shown and Give is disabled',
    async () => {
      await someone();
      rememberSignIn(port, ORIGIN, 'another-wallet-held-here');
      const channel = open(keyring());
      await saying('Who is asking');
      await settle();

      expect(document.querySelector('[data-not-this-wallet]')?.textContent)
        .toContain('answered by another of the wallets held here');
      expect(giveButton().disabled).toBe(true);
      fireEvent.click(giveButton());
      /* And the release itself refuses, behind the disabled button. */
      invokeHandlerAnyway(giveButton());
      await settle();
      expect(channel.sent).toHaveLength(1);
      expect(document.querySelector('[data-keyring-problem]')?.textContent ?? '')
        .toContain('No key has been given.');
    });

  it('WITH A COMPANY: the company is shown, the answer carries the same company key an ordinary unlock gives, and the wallet remembers where it went',
    async () => {
      await someone();
      const channel = open(keyring({ signedInAs: mine(), company: CO_A }));
      await saying('Who is asking');
      await settle();
      expect(document.querySelector('[data-company-fingerprint]')?.textContent)
        .toBe(companyFingerprint(CO_A));
      expect(document.querySelector('[data-company]')?.textContent).toBe(CO_A);

      const pressed = await press(channel);
      const release = channel.sent[1]!.message as KeyringRelease;
      expect(release.company).toBe(CO_A);
      const ordinary = releaseFor(
        identity, parseAsk(unlock({ company: CO_A, nonce: 'k1' }), ORIGIN, NOW) as UnlockRequest, NOW);
      expect(release.companyKey).toBe(ordinary.key);
      expect(release.companyKey).not.toBe(release.key);

      await remembered(pressed);
      const opened = await load(port, identity);
      if (opened.of !== 'profile') throw new Error('the sealed profile did not open');
      const releases = releasesOf(opened.profile);
      expect(releases).toHaveLength(1);
      expect(releases[0]!.company).toBe(CO_A);
      expect(releases[0]!.recipient.origin).toBe(ORIGIN);
      expect(releases[0]!.nonce).toBe('k1');
      expect(originsFor(opened.profile, CO_A)).toEqual([ORIGIN]);
    });

  it('a keyring answer is never written down as a disclosure or a sign-in', async () => {
    const ids = await someone();
    expect(ids.length).toBeGreaterThan(0);

    /* With a company, where something IS written - the positive control. */
    const pressed = await press(open(keyring({ signedInAs: mine(), company: CO_A })));
    await remembered(pressed);
    const opened = await load(port, identity);
    if (opened.of !== 'profile') throw new Error('the sealed profile did not open');
    expect(releasesOf(opened.profile)).toHaveLength(1);
    expect(opened.profile.grants).toEqual([]);
    expect(opened.profile.grants.flatMap((g) => g.disclosures)).toEqual([]);
    expect(walletSignedInTo(port, ORIGIN)).toBeNull();
    cleanup();

    /* With no company, nothing at all is written. */
    const channel = open(keyring({ nonce: 'k2' }));
    await saying('Who is asking');
    await settle();
    const writesBefore = port.writes();
    await press(channel);
    await settle();
    expect(port.writes()).toBe(writesBefore);
    const after = await load(port, identity);
    if (after.of !== 'profile') throw new Error('the sealed profile did not open');
    expect(after.profile.grants).toEqual([]);
    expect(releasesOf(after.profile)).toHaveLength(1);
    expect(walletSignedInTo(port, ORIGIN)).toBeNull();
  });
});

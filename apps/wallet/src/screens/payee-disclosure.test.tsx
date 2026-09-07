// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, secretFromWords } from 'midnight-identity/keys/derivation';
import { GIVEN_NAME, RECEIVING_ADDRESS, REGISTRY } from 'midnight-identity/profile/attributes';
import { check } from 'midnight-identity/profile/definition';
import { emptyProfile, selfAssert } from 'midnight-identity/profile/model';
import { load, save } from 'midnight-identity/profile/store';
import { afterWrites, watchedStore } from '../testing/settled-store.js';
import type { WatchedPort } from '../testing/settled-store.js';
/* REOPENED. **The answer is AWAITED rather than polled for**, and
 * the address this screen settles on is reached by turning the loop a fixed
 * number of times rather than by watching for it against a deadline.
 * `settled-channel.ts` says why raising a budget was a delay and not a fix. */
import { afterTheAnswer, settled, watchedOpener } from '../testing/settled-channel.js';
import type { Posted, WatchedOpener } from '../testing/settled-channel.js';
import type { DisclosureResponse } from 'midnight-identity/profile/disclosure';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { Approve } from './approve.js';
import { ownedAddressFor } from '../accounts/owned-address.js';
import { unshieldedAddressFor } from '../chain/unshielded.js';
import { DERIVED_ATTRIBUTES, producerFor } from '../accounts/derived.js';
import { NETWORK } from 'midnight-identity/network';
import { addressFingerprint } from 'midnight-identity/profile/fingerprint';

/**
 * **THE WALLET CAN SAY WHERE TO PAY YOU.**
 *
 * A founder who signs in with their wallet could not be paid, and an invitation
 * could not be accepted, for one reason: **nothing in this protocol handed over
 * a receiving address.** This file is the wallet half of closing that, and it
 * is written as the four things the design says must be true
 * whichever shape is taken.
 *
 * **WHAT IS BEING PROTECTED IS MONEY AND NOT PRIVACY**, which is why three of
 * the four assertions below are about WHICH address is sent rather than about
 * who is told. An address that is wrong by one slot is a salary arriving
 * somewhere its owner is not looking, irreversibly, with nothing anywhere
 * objecting.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const SECRET = secretFromWords(TEST_MNEMONIC);
const A = 'https://payroll-a.example';
const B = 'https://payroll-b.example';

/** The first slot `slot-choice.ts` offers, and the second. Named, so a reader
 * does not have to know that "subwallet 1" is account 2. */
const FIRST_OFFERED = 2;
const SECOND_OFFERED = 3;

const shieldedOf = (account: number): string =>
  ownedAddressFor(identity, account, {}, NETWORK).address.bech32;

let port: WatchedPort;
beforeEach(() => { port = watchedStore(); });
afterEach(() => { cleanup(); });

const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'To pay you, we need to know where to pay you.',
  wants: [
    { attribute: GIVEN_NAME, required: true },
    { attribute: RECEIVING_ADDRESS, required: true, reason: 'This is where your salary goes.' },
  ],
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

const open = (origin = A, data: unknown = wire()): Opened => {
  /* **THE OPENER IS WHAT RESOLVES THE WAIT.** `postMessage` is the moment the
   * signed answer crosses, so it is the moment the promise settles — there is
   * no interval here and nothing to lose a race to. `settled-channel.ts`. */
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

const someone = async (): Promise<void> => {
  await save(port, identity,
    selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', 'legal', NOW));
};

const responseFrom = (sent: { message: unknown }[]): DisclosureResponse =>
  sent[sent.length - 1]!.message as DisclosureResponse;

/**
 * **A FIXED NUMBER OF TURNS OF THE LOOP, WHICH IS NOT A WAIT.**
 *
 * Everything this file used to poll for is markup that is already in hand a
 * microtask later: the ask arrives synchronously, the sealed profile is a
 * promise an in-memory store has already resolved, and the offered slot is
 * chosen by an EFFECT that runs once both are here. **None of it is work that
 * might take a while — it is the loop coming round**, and a `waitFor` there is
 * a poll with a deadline for a busier machine to defeat.
 *
 * Twenty turns rather than eight because the address row settles through a
 * chain of effects: the ask, then the profile, then `chooseSlot`, then the
 * derived value. A loaded machine changes how LONG this takes and never
 * WHETHER it passes.
 */
const settle = (): Promise<void> => settled(20);

/**
 * **WHAT THE SCREEN SAYS, ONCE EVERYTHING PENDING HAS HAD ITS TURN.** It
 * replaces twelve `findByText` calls, and `getByText` is deliberate: it throws
 * naming the text it could not find, so a screen that genuinely stopped saying
 * something fails readably on every machine instead of *"Unable to find an
 * element"* after a budget on one machine in ten.
 */
const saying = async (text: string): Promise<HTMLElement> => {
  await settle();
  return screen.getByText(text);
};

/**
 * **THE SETTLED TEXT OF SOMETHING THE SCREEN WORKS OUT, OR `null`.**
 *
 * The address, the confirmation code and the shared-wallet warning are all
 * computed after an effect, and the file's own note on `[data-confirmation-code]`
 * explains what waiting only for the ELEMENT cost: it read a real code for a
 * real wallet, just not the one this screen settles on. **Reading the value
 * after the loop has been turned is stronger than watching for it against a
 * deadline** — it asserts the screen has settled on the right thing, rather
 * than that it passed through it at some point inside eight seconds.
 */
const settledText = async (selector: string): Promise<string | null> => {
  await settle();
  const found = document.querySelector(selector);
  return found === null ? null : (found.textContent ?? '');
};

/** Pick the one held first name, so the required row is answered. */
const pickTheName = async (): Promise<void> => {
  await settle();
  const option = document.querySelector(
    `[data-row="${GIVEN_NAME}"] input[type="radio"]`) as HTMLElement | null;
  if (option === null) {
    throw new Error(
      `the screen never showed an option row for ${GIVEN_NAME}. That is the defect, not a `
      + 'wait that needed longer.');
  }
  fireEvent.click(option);
};

const press = async (channel: Opened, origin = A): Promise<DisclosureResponse> => {
  /* Second cause — the history entry is written with `void save(...)`,
   * which is correct and is not awaited. A test that renders a SECOND screen
   * against the same store has to wait for the first one's write, or the grant
   * that decides which wallet the next company is offered is not there yet. */
  const written = afterWrites(port);
  fireEvent.click(screen.getByText(`Send these to ${origin}`));
  /*
   * **THE ANSWER IS AWAITED, NOT POLLED FOR.** What this waits for is a
   * real Schnorr signature over the payload — **the one genuinely CPU-hungry
   * step in this file, and so the one step that loses a race for a core** when
   * sixty other files are running. `answered()` is resolved by the
   * `postMessage` that carries it: a busier machine makes it slower and cannot
   * make it fail.
   */
  await channel.answered();
  await written();
  return responseFrom(channel.sent);
};

const addressIn = (response: DisclosureResponse): string | undefined => {
  const sentValue = response.payload.disclosed.find((s) => s.about === RECEIVING_ADDRESS);
  return sentValue?.says.of === 'value' ? sentValue.says.value : undefined;
};

describe('§1 — a receiving address is asked for by name and worked out here', () => {
  it('THE ADDRESS SENT IS THE CHOSEN WALLET\'S OWN, AND NOTHING HOLDS IT', async () => {
    await someone();
    const channel = open();
    await saying('Who is asking');

    /* Shown WHOLE, because it is where money arrives and a shortened address is
     * one nobody can check. **And it is the address the screen SETTLED on**:
     * asserted after the loop has been turned rather than watched for against
     * a deadline, so a screen that settles on a different slot fails here
     * naming the address it showed. */
    expect(await settledText('[data-derived-value]')).toBe(shieldedOf(FIRST_OFFERED));

    await pickTheName();
    const response = await press(channel);

    expect(addressIn(response)).toBe(shieldedOf(FIRST_OFFERED));
    /* **NOBODY SAID IT. THIS WALLET WORKED IT OUT.** `by: 'self'` here would
     * tell the recipient the person typed something nothing they could type
     * would change. */
    expect(response.payload.disclosed.find((s) => s.about === RECEIVING_ADDRESS)!.asserted)
      .toEqual({ by: 'wallet' });

    /* **AND IT IS NOT IN `held`.** A computed fact stored as a held one is a
     * copy that goes stale the moment a different wallet is chosen. */
    const opened = await load(port, identity);
    if (opened.of !== 'profile') throw new Error('the profile did not open');
    expect(opened.profile.held.some((h) => h.about === RECEIVING_ADDRESS)).toBe(false);
    /* A grant names HELD values, so the derived row is in the history and not
     * in the grant — `grantTo` would refuse an id nothing holds. */
    expect(opened.profile.grants[0]!.values.some((v) => v === RECEIVING_ADDRESS)).toBe(false);
    expect(opened.profile.grants[0]!.disclosures[0]!.sent.map((s) => s.about))
      .toContain(RECEIVING_ADDRESS);
  });

  it('CHOOSING A DIFFERENT WALLET CHANGES THE ADDRESS THAT IS SENT', async () => {
    /*
     * **THE SIGNATURE AND THE ADDRESS MUST NAME ONE SLOT.** The payload is
     * signed by the chosen subwallet's own key and the address disclosed is
     * that same subwallet's — which is the whole of what makes the address
     * evidence rather than a claim, because nothing downstream can check the
     * pairing (`profile/disclosure.ts`: *round tripping proves the encoding,
     * never the pairing*). If the value came from a fixed wallet while the
     * signature came from the chosen one, payroll would pay an address the
     * person never picked and every screenshot would look right.
     */
    await someone();
    const channel = open();
    await saying('Who is asking');
    expect(await settledText('[data-derived-value]')).toBe(shieldedOf(FIRST_OFFERED));

    fireEvent.change(document.getElementById('approve-subwallet')!,
      { target: { value: String(SECOND_OFFERED) } });
    expect(await settledText('[data-derived-value]')).toBe(shieldedOf(SECOND_OFFERED));

    await pickTheName();
    const response = await press(channel);
    expect(addressIn(response)).toBe(shieldedOf(SECOND_OFFERED));
    expect(addressIn(response)).not.toBe(shieldedOf(FIRST_OFFERED));
    /* The signature names the same slot: the payload's own address field is
     * that subwallet's unshielded one, and it is what `verify` recomputes. */
    expect(response.payload.address).toBe(unshieldedAddressFor(identity, SECOND_OFFERED));
  });

  it('THE CODE SHOWN IS THE CODE OF THE ADDRESS BEING SENT, AND IT MOVES WITH THE WALLET',
    async () => {
      /*
       * **WHAT THE PERSON CARRIES BACK.**
       *
       * The address is sealed on this device and the company never sees it, so
       * the only thing that lets the receiving end check what arrived is this
       * code. **It is worth nothing unless it is a code OF THE VALUE ACTUALLY
       * SENT** — a code computed from a fixed wallet while a different one is
       * disclosed would match nothing on the far side, and a code computed from
       * something other than the address would match everything.
       *
       * So this asserts the pairing from both ends: the code on screen is the
       * fingerprint of the address in the response, and changing the wallet
       * changes both together.
       */
      await someone();
      const channel = open();
      await saying('Who is asking');
      /*
       * **WAIT FOR THE VALUE, NOT FOR THE ELEMENT.** The first version waited
       * only for the element to exist, and it went red ONCE — in a run of four
       * files together, never when this file was run alone. **One failure is
       * the whole of what was observed**; the diagnosis below is read off the
       * code rather than reproduced, and it is written down for the next
       * person who sees it rather than claimed as settled.
       *
       * The offered wallet is chosen by an EFFECT (`chooseSlot`), which runs
       * once the ask and the profile are both here. The row renders before
       * that with whichever slot was used last, so a test that waits only for
       * the element to EXIST is racing the effect: it reads a real code for a
       * real wallet, which is simply not the one this screen settles on.
       *
       * Watching for the settled value is the same discipline the test above
       * uses for the address, and it is why that one does not flake.
       */
      expect(await settledText('[data-confirmation-code]'))
        .toBe(addressFingerprint(shieldedOf(FIRST_OFFERED)));

      const picker = document.getElementById('approve-subwallet');
      if (picker === null) throw new Error('the wallet picker is not on this screen');
      fireEvent.change(picker, { target: { value: String(SECOND_OFFERED) } });
      expect(await settledText('[data-confirmation-code]'))
        .toBe(addressFingerprint(shieldedOf(SECOND_OFFERED)));
      /* Not the first wallet's code any more — the two must never be the same
       * string, which is `fingerprint.test.ts`'s own subject from this end. */
      expect(document.querySelector('[data-confirmation-code]')!.textContent)
        .not.toBe(addressFingerprint(shieldedOf(FIRST_OFFERED)));

      await pickTheName();
      const response = await press(channel);
      expect(document.querySelector('[data-confirmation-code]')).toBeNull();
      expect(addressFingerprint(addressIn(response)!))
        .toBe(addressFingerprint(shieldedOf(SECOND_OFFERED)));
    });

  it('AND THERE IS NO CODE FOR AN ADDRESS THAT IS NOT BEING SENT', async () => {
    /* Declining the row is a normal answer here as it is anywhere else on this
     * screen, and a code for a value nobody is sending is a code somebody would
     * paste into a page that is about to receive a different one. */
    await someone();
    open();
    await saying('Who is asking');
    expect(await settledText('[data-confirmation-code]'))
      .toBe(addressFingerprint(shieldedOf(FIRST_OFFERED)));
    fireEvent.click(document.querySelector(
      `[data-row="${RECEIVING_ADDRESS}"] [data-option="none"] input`)!);
    /* **AND THEN IT IS GONE.** An absence asserted after the loop has been
     * turned is stronger than one polled for: a code that is still on screen
     * when everything pending has run is a code a person could paste. */
    expect(await settledText('[data-confirmation-code]')).toBeNull();
  });

  it('TWO SITES ARE NOT SILENTLY GIVEN ONE ADDRESS', async () => {
    /*
     * The rule, and it is a DEFAULT rather than a refusal: a person may
     * deliberately give two employers one address, and the test below that one
     * says what happens then. What must never happen is two employers being
     * given one address by a screen nobody touched.
     */
    await someone();
    const first = open(A);
    await saying('Who is asking');
    await pickTheName();
    const one = await press(first, A);
    cleanup();

    const second = open(B, wire());
    await saying('Who is asking');
    await pickTheName();
    const two = await press(second, B);

    expect(addressIn(one)).toBeTruthy();
    expect(addressIn(two)).toBeTruthy();
    expect(addressIn(two)).not.toBe(addressIn(one));
  });

  it('AND A COMPANY THAT ALREADY HAS ONE KEEPS IT', async () => {
    /* The other half of the same rule. A second address next month means half a
     * salary history sitting where the company no longer pays. */
    await someone();
    const first = open(A);
    await saying('Who is asking');
    await pickTheName();
    const one = await press(first, A);
    cleanup();

    const again = open(A, wire({ nonce: 'n2' }));
    await saying('Who is asking');
    await pickTheName();
    const two = await press(again, A);
    expect(addressIn(two)).toBe(addressIn(one));
  });

  it('AND SHARING ONE DELIBERATELY IS SAID ONCE, NOT REFUSED', async () => {
    await someone();
    const first = open(A);
    await saying('Who is asking');
    await pickTheName();
    await press(first, A);
    cleanup();

    const second = open(B, wire());
    await saying('Who is asking');
    /* The fresh slot has to be the one on screen BEFORE the used one is picked,
     * or "choosing" it is a change event that never fires. */
    await settle();
    expect((document.getElementById('approve-subwallet') as HTMLSelectElement).value)
      .toBe(String(SECOND_OFFERED));
    /* Nothing is said until the used slot is actually chosen — an inconsistent
     * warning teaches people that silence means it is fine, and a warning shown
     * about a slot nobody picked is exactly that. */
    expect(document.querySelector('[data-wallet-shared]')).toBeNull();

    fireEvent.change(document.getElementById('approve-subwallet')!,
      { target: { value: String(FIRST_OFFERED) } });
    expect(await settledText('[data-wallet-shared]') ?? '').toContain(A);
    expect(document.body.textContent).toContain('comparing notes');

    /* AND IT STILL GOES THROUGH. Linkability is the person's to spend. */
    await pickTheName();
    const response = await press(second, B);
    expect(addressIn(response)).toBe(shieldedOf(FIRST_OFFERED));
  });

  it('NOTHING IS RELEASED WITHOUT A PRESS', async () => {
    await someone();
    const { sent } = open();
    await saying('Who is asking');
    expect(await settledText('[data-derived-value]')).toBe(shieldedOf(FIRST_OFFERED));
    /* The ready ping and nothing else. The address is on the screen and has not
     * left it. */
    expect(sent).toHaveLength(1);
    expect((sent[0]!.message as { schema: string }).schema)
      .toBe('midnight-identity/wallet-ready/v1');

    /* And declining sends the refusal rather than the address. */
    fireEvent.click(screen.getByText('Send nothing'));
    expect(sent[sent.length - 1]!.message).toEqual({
      schema: 'midnight-identity/disclosure-refused/v1', reason: 'declined',
    });
    expect(JSON.stringify(sent)).not.toContain(shieldedOf(FIRST_OFFERED));
  });

  it('AND DECLINING JUST THIS ONE IS A NORMAL ANSWER', async () => {
    await someone();
    const channel = open();
    await saying('Who is asking');
    await settle();
    const no = document.querySelector(
      `[data-row="${RECEIVING_ADDRESS}"] [data-option="none"] input`) as HTMLElement | null;
    if (no === null) {
      throw new Error(
        `the screen never showed a way to decline ${RECEIVING_ADDRESS}. That is the defect, `
        + 'not a wait that needed longer.');
    }
    fireEvent.click(no);
    await pickTheName();
    const response = await press(channel);
    expect(addressIn(response)).toBeUndefined();
    expect(response.payload.declined).toContain(RECEIVING_ADDRESS);
  });
});

describe('§1 — a derived attribute is derived, and checked against its own rule', () => {
  it('AN UNSHIELDED ADDRESS IS NOT A RECEIVING ADDRESS, AND THE RULE SAYS SO', () => {
    /*
     * The substitution that would cost money and look right in every
     * screenshot: both come out of `owned-address.ts`, both are addresses of
     * the same subwallet, and only one of them can be paid. `payeeAddress()`
     * refuses the other by name, on the far side of a network hop, hours later.
     * This is the same refusal, before anything leaves.
     */
    const definition = REGISTRY.definitionOf(RECEIVING_ADDRESS)!;
    expect(check(definition, unshieldedAddressFor(identity, FIRST_OFFERED)).ok).toBe(false);
    expect(check(definition, shieldedOf(FIRST_OFFERED))).toEqual({
      ok: true, value: shieldedOf(FIRST_OFFERED),
    });
  });

  it('EVERY DERIVED DEFINITION HAS A PRODUCER, AND NOTHING ELSE DOES', () => {
    /* The other half of `derived.ts`'s promise: the registry and the producers
     * cannot drift, so a definition added without one is a red test rather than
     * a row on a screen saying the wallet cannot work it out. */
    for (const definition of REGISTRY.all) {
      expect(producerFor(definition.name) !== null).toBe(definition.source === 'derived');
    }
    expect(DERIVED_ATTRIBUTES).toEqual([RECEIVING_ADDRESS]);
  });

  it('AND NOBODY CAN TYPE ONE OR HAVE ONE ISSUED', () => {
    const profile = emptyProfile(NOW);
    expect(() => selfAssert(profile, REGISTRY, RECEIVING_ADDRESS, shieldedOf(2), '', NOW))
      .toThrow(/works it out from your own keys/u);
  });
});

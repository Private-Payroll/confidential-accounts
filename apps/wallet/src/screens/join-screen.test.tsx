// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { x25519 } from '@noble/curves/ed25519.js';
import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { identityFromWords, secretFromWords } from 'midnight-identity/keys/derivation';
import { GIVEN_NAME, RECEIVING_ADDRESS, REGISTRY } from 'midnight-identity/profile/attributes';
import { emptyProfile, selfAssert } from 'midnight-identity/profile/model';
import { save } from 'midnight-identity/profile/store';
import { afterWrites, watchedStore } from '../testing/settled-store.js';
import type { WatchedPort } from '../testing/settled-store.js';
import { afterTheAnswer, settled, watchedOpener } from '../testing/settled-channel.js';
import type { Posted, WatchedOpener } from '../testing/settled-channel.js';
import { verify } from 'midnight-identity/profile/disclosure';
import type { DisclosureResponse } from 'midnight-identity/profile/disclosure';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { ownedAddressFor } from '../accounts/owned-address.js';
import { NETWORK } from 'midnight-identity/network';
import { Approve } from './approve.js';

/**
 * **AN INVITATION IS APPROVED ON THE WALLET'S OWN SURFACE, AND WHAT LEAVES IS
 * SEALED.**
 *
 * Three properties, and they are three different arguments.
 *
 * **1. IT IS THE SAME SURFACE.** A join renders in the frame a disclosure
 * already had -- the same origin card, the same wallet picker, the same rows,
 * approved item by item -- and what it discloses is SHOWN, the address
 * included. If this file had to reach for a second component to find any of
 * that, the change had forked the screen.
 *
 * **2. NOTHING THE ASKING PARTY SUPPLIES IS DRAWN AS MARKUP.** This is the
 * refusal the change is built around: a company that could style, order or word
 * what the person sees would be drawing the screen that approves it. The
 * asking party chooses five values -- `requester.name`, `requester.rdns`,
 * `purpose`, and each want's `attribute` and `reason` -- and every one arrives
 * as a text node. **Two of them are mutation-proved**
 * (mutations 08 and 09): render either as
 * markup and the assertions below go red.
 *
 * **3. THE ADDRESS NEVER CROSSES IN THE CLEAR.** §5, decided 22 Aug. The
 * acceptance is sealed to the key the ask carried, on this device, and the
 * envelope is opened here by an implementation of the READER written from its
 * description rather than from `profile/inbox.ts` -- so a wrong encoding is a
 * red test and not a matching pair of wrong implementations.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const SECRET = secretFromWords(TEST_MNEMONIC);
const ORIGIN = 'https://payroll-a.example';
/** The first slot `slot-choice.ts` offers a company nobody has met before. */
const FIRST_OFFERED = 2;

const inbox = x25519.keygen();
const INBOX_KEY = bytesToHex(inbox.publicKey);

/**
 * **WHAT AN ATTACKING INVITER WOULD PUT IN EVERY FIELD IT OWNS.**
 *
 * Two shapes on purpose. `MARKUP` would become an ELEMENT if it were ever
 * parsed as HTML, so the assertion can be *there is no such element anywhere on
 * this page* rather than a guess about escaping. `document.title` is read
 * afterwards because the `<img onerror>` form is what actually runs in a
 * browser and is worth having in the fixture even though jsdom will not fetch.
 */
const MARKUP = '<b data-injected="yes">not the wallet\'s own words</b>';
const MARKUP_TOO = '<img data-injected-too="yes" src="x" onerror="document.title=\'owned\'">';

const shieldedOf = (account: number): string =>
  ownedAddressFor(identity, account, {}, NETWORK).address.bech32;

let port: WatchedPort;
beforeEach(() => { port = watchedStore(); });
afterEach(() => { cleanup(); });

/** An invitation on the wire: `wants` like a disclosure, and one inbox key. */
const invitation = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'join',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'Accept your invitation so we can pay you.',
  wants: [
    { attribute: GIVEN_NAME, required: false, reason: 'For your payslip.' },
    {
      attribute: RECEIVING_ADDRESS,
      required: true,
      reason: 'This is where your salary goes.',
    },
  ],
  inboxPublicKey: INBOX_KEY,
  nonce: 'n1',
  expiresAt: NOW + 600_000,
  ...over,
});

interface Opened {
  readonly sent: Posted[];
  answered(): Promise<Posted>;
}

const open = (data: unknown = invitation(), origin = ORIGIN): Opened => {
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

/** The same fixed number of turns `payee-disclosure.test.tsx` settles for, and
 * for the same reason: the address row lands through a chain of effects, none
 * of which is work that might take a while. */
const settle = (): Promise<void> => settled(20);

const someone = async (): Promise<void> => {
  await save(port, identity,
    selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', 'legal', NOW));
};

/**
 * THE READER, REIMPLEMENTED FROM ITS DESCRIPTION. `profile/join.test.ts`
 * carries the same function and the same argument for why it is duplicated
 * rather than imported: **a helper that called `inbox.ts` would agree with a
 * wrong `inbox.ts`.**
 */
const unsealAsTheOtherSideDoes = (envelope: unknown): string => {
  const e = envelope as { ephemeral: string; iv: string; body: string };
  const shared = x25519.getSharedSecret(inbox.secretKey, hexToBytes(e.ephemeral));
  return new TextDecoder().decode(
    gcm(sha256(shared), hexToBytes(e.iv)).decrypt(hexToBytes(e.body)));
};

const press = async (channel: Opened): Promise<Posted> => {
  await settle();
  const button = document.querySelector('[data-approve][data-join]') as HTMLElement | null;
  if (button === null) {
    throw new Error(
      'the invitation screen has no accept button. That is the defect, not a wait that '
      + 'needed longer.');
  }
  /* Second cause -- the history entry is written with `void save(...)`,
   * which is correct and is not awaited. */
  const written = afterWrites(port);
  fireEvent.click(button);
  const answer = await channel.answered();
  await written();
  return answer;
};

describe('AN INVITATION RENDERS ON THE SURFACE THE DISCLOSURE ALREADY HAD', () => {
  it('the same origin card, the same picker, and the rows it asked for', async () => {
    open();
    await settle();
    /* The origin is the BROWSER'S and the name is a CLAIM, labelled as such --
     * The rule, and the same one element both kinds render. */
    expect(document.querySelector('[data-requester-origin]')?.textContent).toBe(ORIGIN);
    expect(document.querySelector('[data-requester-name]')?.textContent).toBe('Payroll A');
    expect(document.querySelector('#approve-subwallet')).not.toBeNull();
    expect(document.querySelector(`[data-row="${GIVEN_NAME}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-row="${RECEIVING_ADDRESS}"]`)).not.toBeNull();
  });

  it('WHAT IT DISCLOSES IS SHOWN ITEM BY ITEM, AND THE ADDRESS IS SHOWN WHOLE', async () => {
    open();
    await settle();
    const shown = document.querySelector(
      `[data-row="${RECEIVING_ADDRESS}"] [data-derived-value]`)?.textContent;
    /* Whole, not abbreviated: this is where money will arrive and a shortened
     * address is one a person cannot check. */
    expect(shown).toBe(shieldedOf(FIRST_OFFERED));
    /* Each row separately approvable, including the one that matters. */
    expect(document.querySelector(
      `[data-row="${RECEIVING_ADDRESS}"] [data-option="none"]`)).not.toBeNull();
  });

  it('THE KEY IT WILL BE SEALED TO IS ON THE SCREEN, WHOLE AND UNCHECKED', async () => {
    open();
    await settle();
    expect(document.querySelector('[data-inbox-key]')?.textContent).toBe(INBOX_KEY);
    /* The unchecked half is SAID, in the way it is said for `company`. */
    expect(screen.getByText(/cannot check that this key belongs to the company/u))
      .not.toBeNull();
  });

  it('a disclosure on the same component shows no inbox key and no join button', async () => {
    /* **THE FRAME IS SHARED AND THE JOIN-ONLY PARTS ARE NOT LEAKING INTO IT.**
     * One surface serving two kinds is only correct if the difference is still
     * a difference. */
    open({
      schema: 'midnight-identity/disclosure-request/v1',
      requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
      purpose: 'To pay you.',
      wants: [{ attribute: GIVEN_NAME, required: true }],
      nonce: 'n1',
      expiresAt: NOW + 600_000,
    });
    await settle();
    expect(document.querySelector('[data-inbox-key]')).toBeNull();
    expect(document.querySelector('[data-join-heading]')).toBeNull();
    expect(document.querySelector('[data-approve][data-join]')).toBeNull();
    expect(document.querySelector('[data-approve]')).not.toBeNull();
  });
});

describe('NOTHING THE ASKING PARTY SUPPLIES REACHES THE SCREEN AS MARKUP', () => {
  it('THE PURPOSE IS A TEXT NODE, AND MARKUP IN IT DRAWS NOTHING', async () => {
    open(invitation({ purpose: MARKUP }));
    await settle();
    /* **THE ELEMENT DOES NOT EXIST ANYWHERE ON THE PAGE.** Not "is escaped" --
     * an assertion about escaping is an assertion about a mechanism, and this
     * is an assertion about the outcome. */
    expect(document.querySelector('[data-injected]')).toBeNull();
    /* And it is still SHOWN, as the words they chose. A screen that silently
     * dropped a hostile purpose would be a screen lying about what was asked. */
    expect(document.querySelector('[data-purpose]')?.textContent)
      .toBe(`Why they say they want it: ${MARKUP}`);
  });

  it('THE NAME THEY CALL THEMSELVES IS A TEXT NODE TOO', async () => {
    open(invitation({ requester: { name: MARKUP_TOO, rdns: 'example.payroll-a' } }));
    await settle();
    expect(document.querySelector('[data-injected-too]')).toBeNull();
    expect(document.querySelector('[data-requester-name]')?.textContent).toBe(MARKUP_TOO);
    /* The `onerror` form, in case it ever became an element that a browser
     * would run. jsdom does not fetch, so this is belt and braces on top of
     * the assertion above rather than the assertion itself. */
    expect(document.title).not.toBe('owned');
  });

  it('a want\'s reason and a want\'s own name are text too', async () => {
    open(invitation({
      wants: [
        { attribute: GIVEN_NAME, required: false, reason: MARKUP },
        { attribute: `unknown-${MARKUP_TOO}`, required: false },
        /* **THE FIXTURE CARRIES THE ADDRESS BECAUSE A JOIN WITHOUT ONE IS NOW
         * REFUSED AT THE PARSER**, and a fixture that never reaches the screen
         * would make this file's markup assertions vacuously true. */
        { attribute: RECEIVING_ADDRESS, required: true },
      ],
    }));
    await settle();
    expect(document.querySelector('[data-injected]')).toBeNull();
    expect(document.querySelector('[data-injected-too]')).toBeNull();
    /* An attribute this vocabulary does not know is SHOWN as unknown, raw name
     * and all -- dropping it would be a screen lying about what was asked.
     *
     * Read off the `[data-unknown]` row rather than by building a selector
     * from the attribute: the name is the ASKER'S string, and a selector built
     * from it is a selector the asker writes. jsdom threw
     * `SyntaxError: Invalid selector` on the first draft of this line, which is
     * the same class of fault one level down and is worth leaving noted. */
    const unknown = document.querySelector('[data-unknown]');
    expect(unknown).not.toBeNull();
    expect(unknown?.getAttribute('data-row')).toBe(`unknown-${MARKUP_TOO}`);
    expect(unknown?.textContent).toContain(MARKUP_TOO);
  });
});

describe('THE COMPANY MUST ASK FOR THE ADDRESS; THE PERSON MAY STILL DECLINE IT', () => {
  /*
   * **THE TWO HALVES OF ONE DECISION, TESTED TOGETHER BECAUSE THEY WERE CHOSEN
   * TOGETHER.** `profile/request.ts` refuses an invitation that never asks
   * where to pay; this surface still lets the person say no to the row it did
   * ask for. Neither is inherited: a wallet that enforced both would have its
   * first coerced answer, and a wallet that enforced neither would approve an
   * acceptance that means nothing.
   */
  it('AN INVITATION THAT NEVER ASKED FOR THE ADDRESS NEVER REACHES THIS SCREEN', async () => {
    open(invitation({ wants: [{ attribute: GIVEN_NAME, required: true }] }));
    await settle();
    /* The refusal state, not the approval surface. Nothing was shown and there
     * is nothing to press. */
    expect(document.querySelector('[data-approve]')).toBeNull();
    expect(document.querySelector('[data-inbox-key]')).toBeNull();
    expect(screen.getByText(/This request was refused before you saw it/u)).not.toBeNull();
  });

  it('DECLINING THE ADDRESS IS ALLOWED, AND WHAT IT MEANS IS SAID', async () => {
    await someone();
    open();
    await settle();
    const no = document.querySelector(
      `[data-row="${RECEIVING_ADDRESS}"] [data-option="none"] input`) as HTMLElement | null;
    if (no === null) {
      throw new Error(
        'the address row offers no way to decline. That is the defect — every row on this '
        + 'surface is refusable.');
    }
    fireEvent.click(no);
    await settle();

    /* **THE CONSEQUENCE, IN ITS OWN WORDS, NOT THE ORDINARY MUTED LINE.** The
     * generic sentence — *you can send anyway, and they are told what you
     * declined* — is true of a first name and badly wrong here. */
    const warned = document.querySelector('[data-join-no-address]');
    expect(warned).not.toBeNull();
    expect(warned?.textContent).toContain('cannot pay you');
    /* And the press is still there: this is a warning, not a gate. */
    expect(document.querySelector('[data-approve][data-join]')).not.toBeNull();
  });

  it('and accepting after declining it sends an acceptance that names no address',
    async () => {
      await someone();
      const channel = open();
      await settle();
      fireEvent.click(document.querySelector(
        `[data-row="${RECEIVING_ADDRESS}"] [data-option="none"] input`) as HTMLElement);
      const answer = await press(channel);
      const inside = JSON.parse(
        unsealAsTheOtherSideDoes(answer.message)) as DisclosureResponse;
      /* Honest and useless to the receiver, which is exactly what the screen
       * warned. The row is DECLINED rather than absent — a person who says no
       * is told to have said no. */
      expect(inside.payload.disclosed.find((s) => s.about === RECEIVING_ADDRESS))
        .toBeUndefined();
      expect(inside.payload.declined).toContain(RECEIVING_ADDRESS);
    });
});

describe('THE ACCEPTANCE IS SEALED, AND THE ADDRESS NEVER CROSSES IN THE CLEAR', () => {
  it('WHAT CROSSES IS AN ENVELOPE — no payload, no address, no signature', async () => {
    await someone();
    const channel = open();
    const answer = await press(channel);
    const message = answer.message as Record<string, unknown>;

    expect(message['schema']).toBe('midnight-identity/join-acceptance/v1');
    /* **THE MONEY ASSERTION.** The address is not in the message, in any
     * field, at any depth. Serialising the whole thing and searching it is
     * deliberately cruder than reading a field: a future round that added a
     * convenience copy of the address beside the envelope would pass a
     * field-by-field check and fail this one. */
    expect(JSON.stringify(message)).not.toContain(shieldedOf(FIRST_OFFERED));
    expect(message['payload']).toBeUndefined();
    expect(message['signature']).toBeUndefined();
    expect(message['tag']).toBe('');
  });

  it('AND THE READER GETS BACK THE SIGNED DISCLOSURE IT ALREADY KNOWS HOW TO VERIFY',
    async () => {
      await someone();
      const channel = open();
      const answer = await press(channel);
      const inside = JSON.parse(
        unsealAsTheOtherSideDoes(answer.message)) as DisclosureResponse;

      /* **THE SENTENCE, ONE LAYER OUT.** The plaintext is the same
       * `DisclosureResponse` a disclosure answers with, so the far side runs
       * the verifier it already has. This change adds an envelope and nothing
       * new to verify. */
      expect(verify(inside, {
        atOrigin: ORIGIN,
        expectingNonce: 'n1',
        payingAddress: inside.payload.address,
        networkId: 'stagenet',
        now: NOW,
      })).toEqual({ ok: true });
      expect(inside.payload.address).toBe(
        ownedAddressFor(identity, FIRST_OFFERED, {}, NETWORK).unshieldedBech32);
      const sent = inside.payload.disclosed.find((s) => s.about === RECEIVING_ADDRESS);
      expect(sent?.says).toEqual({ of: 'value', value: shieldedOf(FIRST_OFFERED) });
      /* Nobody typed it. This wallet worked it out. */
      expect(sent?.asserted).toEqual({ by: 'wallet' });
    });

  it('THE ENVELOPE OPENS WITH THE INBOX KEY AND WITH NOTHING ELSE', async () => {
    await someone();
    const channel = open();
    const answer = await press(channel);
    const other = x25519.keygen();
    const e = answer.message as { ephemeral: string; iv: string; body: string };
    expect(() => {
      const shared = x25519.getSharedSecret(other.secretKey, hexToBytes(e.ephemeral));
      gcm(sha256(shared), hexToBytes(e.iv)).decrypt(hexToBytes(e.body));
    }).toThrow();
  });

  it('the screen afterwards names what it did, and the key it sealed to', async () => {
    await someone();
    const channel = open();
    await press(channel);
    await settle();
    /* What this wallet DID, not what anybody else achieved. */
    expect(document.querySelector('[data-accepted-heading]')?.textContent)
      .toContain(ORIGIN);
    expect(document.querySelector('[data-sealed-to]')?.textContent).toBe(INBOX_KEY);
  });
});

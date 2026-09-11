// @vitest-environment jsdom
/**
 * **EVERY WALLET IN THIS BROWSER CAN ANSWER, WHICHEVER OF THEM SAVED FIRST.**
 *
 * A browser used to keep ONE record of saved details, sealed by whichever
 * wallet saved first. Every other wallet held here then read a record that
 * would not open with its key, and the approval screen stopped on it before
 * any kind of ask: no button for a sign-in, none for an unlock. Nothing
 * removed the record, so once the wallet that sealed it was gone, no wallet
 * here could answer again.
 *
 * Each wallet now keeps its own record, and the one record a browser kept
 * before is left where it is for the wallet that sealed it. These render the
 * approval and profile screens for a second wallet, press the button, and read
 * both what was sent and what was left in the store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { IDBFactory } from 'fake-indexeddb';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { GIVEN_NAME, REGISTRY } from 'midnight-identity/profile/attributes';
import { emptyProfile, selfAssert } from 'midnight-identity/profile/model';
import { load, putSealed, recordNameFor, save, sealedFor, sealedIn } from 'midnight-identity/profile/store';
import { profileKey, seal } from 'midnight-identity/profile/seal';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { afterWrites, watchedStore } from '../testing/settled-store.js';
import type { WatchedPort } from '../testing/settled-store.js';
import { afterTheAnswer, settled, watchedOpener } from '../testing/settled-channel.js';
import { saveSecret } from '../accounts/storage.js';
import { forgetOpenWallet, openWallet } from '../accounts/wallets-held.js';
import { rememberSignIn, walletSignedInTo, whyNotThisWallet } from '../lib/signed-in-here.js';
import { OTHER_DETAILS_HERE } from '../lib/unopenable-details.js';
import { ProfileScreen } from './profile.js';
import { Approve } from './approve.js';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const ORIGIN = 'https://payroll-a.example';
const COMPANY = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';

let port: WatchedPort;
beforeEach(() => {
  cleanup();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
  port = watchedStore();
});
afterEach(() => cleanup());

const founder = () => selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Founder', 'legal', NOW);

/** Two wallets held here, and the FIRST has saved its details. Returns both. */
async function twoWallets() {
  const first = newSecret();
  const second = newSecret();
  const firstId = await saveSecret(first);
  const secondId = await saveSecret(second);
  return {
    first: { id: firstId, secret: first, identity: identityFromSecret(first) },
    second: { id: secondId, secret: second, identity: identityFromSecret(second) },
  };
}

const ask = (kind: 'sign-in' | 'unlock') => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind,
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'We need to know it is you.',
  nonce: `n-${kind}`,
  expiresAt: NOW + 600_000,
  ...(kind === 'unlock' ? { company: COMPANY } : {}),
});

type Wallet = Awaited<ReturnType<typeof twoWallets>>['first'];

/** Opens the approval screen for `wallet`, as the open wallet, with `kind` asked. */
async function asked(wallet: Wallet, kind: 'sign-in' | 'unlock') {
  cleanup();
  openWallet(wallet.id);
  const opener = watchedOpener();
  const handlers: ((event: MessageEvent) => void)[] = [];
  const view: ChannelWindow = {
    opener: opener as ChannelWindow['opener'],
    addEventListener: (_t, h) => { handlers.push(h); },
    removeEventListener: () => { /* torn down by cleanup */ },
  };
  render(<Approve identity={wallet.identity} secret={wallet.secret} port={port} view={view} now={() => NOW} />);
  for (const h of handlers) {
    h({ source: opener, origin: ORIGIN, data: ask(kind) } as unknown as MessageEvent);
  }
  await settled(20);
  expect(document.querySelector('[data-unopenable-why]'), 'the screen stopped on the stored details').toBeNull();
  const label = kind === 'sign-in' ? `Sign in to ${ORIGIN}` : `Give ${ORIGIN} the key`;
  return { opener, button: screen.getByText(label).closest('button') as HTMLButtonElement };
}

/** Opens the approval screen for `wallet`, presses the button, and returns what crossed. */
async function answer(wallet: Wallet, kind: 'sign-in' | 'unlock') {
  const { opener, button } = await asked(wallet, kind);
  const written = afterWrites(port);
  fireEvent.click(button);
  await afterTheAnswer(opener);
  await written();
  return opener.sent;
}

describe('a wallet that did not save the details already kept in this browser', () => {
  it('ANSWERS A SIGN-IN, records it under its own name, and leaves the first wallet\'s record byte for byte', async () => {
    const { first, second } = await twoWallets();
    await save(port, first.identity, founder());
    const firstsRecord = JSON.stringify(await sealedFor(port, first.identity));

    const sent = await answer(second, 'sign-in');
    expect(sent.length, 'an answer crossed').toBeGreaterThan(0);

    expect(JSON.stringify(await sealedFor(port, first.identity))).toBe(firstsRecord);
    const firsts = await load(port, first.identity);
    expect(firsts.of === 'profile' && firsts.profile.held.map((h) => h.says))
      .toEqual([{ of: 'value', value: 'Founder' }]);
    const seconds = await load(port, second.identity);
    expect(seconds.of === 'profile' && seconds.profile.grants.flatMap((g) => g.disclosures).length,
      'the sign-in was written down').toBe(1);
  });

  it('ANSWERS AN UNLOCK, which is what opens a company', async () => {
    const { first, second } = await twoWallets();
    await save(port, first.identity, founder());
    const sent = await answer(second, 'unlock');
    expect(sent.length).toBeGreaterThan(0);
    const seconds = await load(port, second.identity);
    expect(seconds.of === 'profile' && (seconds.profile.releases ?? []).length, 'the release was written down').toBe(1);
  });

  it('ON ITS PROFILE: shows its own details, with a form, and no warning', async () => {
    const { first, second } = await twoWallets();
    await save(port, first.identity, founder());
    render(<ProfileScreen identity={second.identity} port={port} />);
    await screen.findByText('My profile');
    await settled(20);
    expect(document.querySelector('[data-unopenable-why]')).toBeNull();
    expect(document.querySelector('[data-add]')).not.toBeNull();
    expect(document.querySelector('[data-other-details-here]')).toBeNull();
  });
});

describe('a browser as it was before each wallet kept its own record', () => {
  const sealedAtTheOldName = async (by: ReturnType<typeof identityFromSecret>) => {
    putSealed(port, await seal(await profileKey(by), founder()));
    return JSON.stringify(sealedIn(port));
  };

  it('WITH THE WALLET THAT SEALED THE ONE RECORD GONE: every wallet here still answers, and that record is not touched', async () => {
    const { first, second } = await twoWallets();
    const before = await sealedAtTheOldName(identityFromSecret(newSecret()));
    await answer(first, 'sign-in');
    await answer(first, 'unlock');
    await answer(second, 'sign-in');
    await answer(second, 'unlock');
    expect(JSON.stringify(sealedIn(port))).toBe(before);
  });

  it('the wallet that sealed it keeps it where it is', async () => {
    const { first } = await twoWallets();
    const before = await sealedAtTheOldName(first.identity);
    await answer(first, 'sign-in');
    expect(JSON.stringify(sealedIn(port))).not.toBe(before);
    expect(port.getItem(await recordNameFor(first.identity))).toBeNull();
    const state = await load(port, first.identity);
    expect(state.of === 'profile' && state.profile.held.length).toBe(1);
  });

  it('ON THE PROFILE of a wallet that cannot open it: says so beside its own details, and changes nothing', async () => {
    const { second } = await twoWallets();
    const before = await sealedAtTheOldName(identityFromSecret(newSecret()));
    render(<ProfileScreen identity={second.identity} port={port} />);
    await settled(20);
    expect(document.querySelector('[data-other-details-here]')?.textContent).toBe(OTHER_DETAILS_HERE);
    expect(document.querySelector('[data-unopenable-why]')).toBeNull();
    expect(document.querySelector('[data-add]')).not.toBeNull();
    expect(JSON.stringify(sealedIn(port))).toBe(before);
  });
});

describe('a wallet whose OWN record will not open', () => {
  it('still gets the warning, and no form, and nothing is written', async () => {
    const { first } = await twoWallets();
    await save(port, first.identity, founder());
    const own = await recordNameFor(first.identity);
    const blob = JSON.parse(port.getItem(own)!);
    port.setItem(own, JSON.stringify({ ...blob, sealed: `${blob.sealed.slice(0, -4)}AAAA` }));
    const before = port.getItem(own);
    render(<ProfileScreen identity={first.identity} port={port} />);
    await screen.findByText('There are details here that this account cannot open');
    expect(document.querySelector('[data-unopenable-why]')?.textContent).toContain('changed since');
    expect(document.querySelector('[data-add]')).toBeNull();
    expect(port.getItem(own)).toBe(before);
  });
});

describe('a company\'s key is given only by the wallet that signed in to the page asking', () => {
  /*
   * Each wallet gives a different key for the same company. With every wallet
   * here able to answer, the one the person picks at a passkey prompt could be
   * the wrong one - and for a person with nothing saved yet, that key seals
   * their first company's only keys where the wallet they signed in with can
   * never open them.
   */
  it('ANOTHER WALLET HERE IS NOT OFFERED THE KEY: the button is disabled with the reason, and a press sends nothing', async () => {
    const { first, second } = await twoWallets();
    await answer(first, 'sign-in');

    const { opener, button } = await asked(second, 'unlock');
    expect(button.disabled).toBe(true);
    expect(document.querySelector('[data-not-this-wallet]')?.textContent)
      .toContain(`The last sign-in to ${ORIGIN} from this browser was answered by another of the wallets held here`);
    expect(document.querySelector('[data-not-this-wallet]')?.textContent, 'no advice to sign out over unsaved work')
      .toContain('signing out of it first drops anything it has not finished saving');
    const before = opener.sent.length;
    fireEvent.click(button);
    await settled(20);
    expect(opener.sent.length, 'nothing crossed').toBe(before);
    expect(opener.sent.some((m) => (m.message as { key?: unknown })?.key !== undefined)).toBe(false);
    expect(await load(port, second.identity)).toEqual({ of: 'none' });
  });

  it('the wallet that signed in is offered it, and signing in with the other moves it', async () => {
    const { first, second } = await twoWallets();
    await answer(first, 'sign-in');
    expect((await answer(first, 'unlock')).length).toBeGreaterThan(0);

    await answer(second, 'sign-in');
    const { button } = await asked(first, 'unlock');
    expect(button.disabled, 'the first wallet is no longer the one signed in').toBe(true);
    expect((await answer(second, 'unlock')).length).toBeGreaterThan(0);
  });

  it('IT IS THE WALLET THAT COUNTS, NOT THE SLOT: another wallet sitting in the slot of the one that answered is refused', async () => {
    const { first } = await twoWallets();
    await answer(first, 'sign-in');
    const newcomer = newSecret();
    const inTheSameSlot = { id: first.id, secret: newcomer, identity: identityFromSecret(newcomer) };
    const { button } = await asked(inTheSameSlot, 'unlock');
    expect(button.disabled).toBe(true);
  });

  it('the record names a wallet by fingerprint and nothing else, and one it cannot read refuses nothing', () => {
    rememberSignIn(port, ORIGIN, 'slot-a');
    expect(walletSignedInTo(port, ORIGIN)).toBe('slot-a');
    expect(whyNotThisWallet(port, ORIGIN, 'slot-a')).toBeNull();
    expect(whyNotThisWallet(port, ORIGIN, 'slot-b')).toMatch(/another of the wallets held here/);
    expect(whyNotThisWallet(port, 'https://elsewhere.example', 'slot-b'), 'another page is not refused').toBeNull();
    expect(port.all()).toBe(JSON.stringify({ wallet: 'slot-a' }));
    const unreadable = { getItem: () => 'not json', setItem: () => {}, removeItem: () => {} };
    expect(whyNotThisWallet(unreadable, ORIGIN, 'slot-b')).toBeNull();
    /* And the page is not named in the clear, in the record's name or its value. */
    const touched: string[] = [];
    const watching = {
      getItem: (k: string) => { touched.push(k); return null; },
      setItem: (k: string, v: string) => { touched.push(k, v); },
      removeItem: () => {},
    };
    rememberSignIn(watching, ORIGIN, 'slot-a');
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.join('\n')).not.toContain('payroll-a');
  });

  it('A SIGN-IN WHOSE NOTE CANNOT BE WRITTEN is still answered and written down, and says what it could not note', async () => {
    const { first } = await twoWallets();
    const plain = port;
    port = {
      ...plain,
      getItem: (k) => plain.getItem(k),
      removeItem: (k) => plain.removeItem(k),
      setItem: (k, v) => {
        if (k.startsWith('midnight-identity:signed-in:')) throw new Error('the storage is full');
        plain.setItem(k, v);
      },
    };
    const sent = await answer(first, 'sign-in');
    expect(sent.length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('could not note that it answered this sign-in');
    const firsts = await load(port, first.identity);
    expect(firsts.of === 'profile' && firsts.profile.grants.flatMap((g) => g.disclosures).length).toBe(1);
  });
});

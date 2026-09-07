// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { addressFor, identityFromWords, newSecret, secretFromWords } from 'midnight-identity';
import type { Identity, Secret } from 'midnight-identity';
import { NETWORK } from '../config.js';
import { unshieldedKeystoreFor } from '../chain/unshielded.js';
import { dustAddressFor } from '../chain/dust.js';
import { saveLastUsedWallet } from '../accounts/storage.js';
import { SendContext } from '../chain/send-context.js';
import type { SendWiring } from '../chain/send-context.js';
import type { SendDoors, SendFacts, SendPlan, SendState } from '../chain/send.js';
import { Send } from './send.js';

/*
 * THE SEND SCREEN, SENTENCE BY SENTENCE — the sending rules are
 * interface rules, so they are pinned at the interface: what each state
 * SAYS, what the confirmation SHOWS, what is present before a send and —
 * just as deliberately — ABSENT after one. The engine behind the screen is
 * a fake here, exactly as the balance card's tests fake its engines: the
 * real engine has its own suite (`send.test.ts`) where it drives a real
 * facade over a real simulated chain.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const ours: Identity = identityFromWords(TEST_MNEMONIC);
const shieldedRecipient = addressFor(ours.moneyAt(2).zswap, NETWORK).bech32;
const unshieldedRecipient = unshieldedKeystoreFor(ours, 2).getBech32Address().asString();

interface FakeWiring {
  readonly wiring: SendWiring;
  readonly plans: SendPlan[];
  readonly stops: number[];
  readonly confirms: number[];
  readonly cancels: number[];
  readonly detaches: number[];
  readonly termsFetches: number[];
  emit(state: SendState): void;
}

/**
 * By default the fake wiring has NO live half, so the screen opens straight
 * into the rehearsal mode the earlier tests were written against — those tests are
 * deliberately untouched (the seam's promise). Tests of the LIVE surface
 * pass `live: true` and, optionally, their own terms door.
 */
function fakeWiring(options: {
  live?: boolean;
  fetchTerms?: () => Promise<{ hash: string; url: string }>;
} = {}): FakeWiring {
  const plans: SendPlan[] = [];
  const stops: number[] = [];
  const confirms: number[] = [];
  const cancels: number[] = [];
  const detaches: number[] = [];
  const termsFetches: number[] = [];
  let onState: ((s: SendState) => void) | null = null;
  const doorsFor = (): SendDoors & { stop: () => Promise<void> } => ({
    facade: () => Promise.reject(new Error('the fake engine never opens doors')),
    keys: () => { throw new Error('the fake engine never derives keys'); },
    signSegment: () => { throw new Error('the fake engine never signs'); },
    ownUnshieldedHex: 'unused',
    stop: async () => { stops.push(stops.length + 1); },
  });
  return {
    plans,
    stops,
    confirms,
    cancels,
    detaches,
    termsFetches,
    emit: (state) => { act(() => { onState?.(state); }); },
    wiring: {
      live: options.live
        ? {
          doorsFor,
          fetchTerms: () => {
            termsFetches.push(termsFetches.length + 1);
            return options.fetchTerms
              ? options.fetchTerms()
              : new Promise(() => { /* never answers unless a test says so */ });
          },
        }
        : null,
      rehearsalDoorsFor: doorsFor,
      start: (_doors, plan, tell) => {
        plans.push(plan);
        onState = tell;
        return {
          confirm: () => confirms.push(confirms.length + 1),
          cancel: () => cancels.push(cancels.length + 1),
          detach: () => detaches.push(detaches.length + 1),
        };
      },
    },
  };
}

const renderSend = (wiring: SendWiring, secret: Secret = newSecret()):
ReturnType<typeof render> => render(
  <SendContext.Provider value={wiring}>
    <Send identity={identityFromWords(TEST_MNEMONIC)} secret={secret} />
  </SendContext.Provider>,
);

const typeRecipient = (value: string): void => {
  fireEvent.change(screen.getByLabelText(/The recipient/u), { target: { value } });
};
const typeAmount = (value: string): void => {
  fireEvent.change(screen.getByLabelText(/The amount/u), { target: { value } });
};
const checkButton = (): HTMLButtonElement =>
  screen.getByText('Check this payment') as HTMLButtonElement;

const facts: SendFacts = {
  kind: 'unshielded',
  recipientBech32: unshieldedRecipient,
  stars: 250_000_000n,
  readBack: 'transaction',
  feeSpecks: 1_092_548_630_122_142n,
  nightBefore: 5_000_000_000n,
  nightAfter: 4_750_000_000n,
  dustBefore: 400_000_000_000_000_000n,
  dustAfter: 398_907_451_369_877_858n,
};

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the form says the KIND back in words, and refuses by name — §4', () => {
  it('an unshielded address is named unshielded; a shielded one, shielded', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeRecipient(unshieldedRecipient);
    expect(screen.getByText(/an UNSHIELDED address/u)).toBeTruthy();
    typeRecipient(shieldedRecipient);
    expect(screen.getByText(/a SHIELDED address/u)).toBeTruthy();
  });

  it('a DUST address is refused on the form, with the reason', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeRecipient(dustAddressFor(ours, 2));
    expect(screen.getByRole('alert').textContent).toMatch(/DUST.*cannot be paid/su);
    typeAmount('1');
    expect(checkButton().disabled).toBe(true);
  });

  it('the exact STARs ride beside the typed amount BEFORE anything is agreed', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeAmount('5');
    expect(screen.getByText(/Exactly 5,000,000 STARs/u)).toBeTruthy();
    typeAmount('0.000001');
    expect(screen.getByText(/Exactly 1 STARs/u)).toBeTruthy();
  });

  it('a seventh decimal is refused on the form, never rounded', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeAmount('1.0000001');
    expect(screen.getByRole('alert').textContent).toMatch(/Nothing was rounded/u);
  });

  it('nothing starts until both the recipient and the amount stand', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    expect(checkButton().disabled).toBe(true);
    typeRecipient(unshieldedRecipient);
    expect(checkButton().disabled).toBe(true);
    typeAmount('250');
    expect(checkButton().disabled).toBe(false);
    expect(fake.plans).toHaveLength(0);
  });

  it('the engine receives STARs, not NIGHT — the millionfold pin at the screen', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeRecipient(unshieldedRecipient);
    typeAmount('5');
    fireEvent.click(checkButton());
    expect(fake.plans).toHaveLength(1);
    expect(fake.plans[0]?.stars).toBe(5_000_000n);
    expect(fake.plans[0]?.recipient.kind).toBe('unshielded');
  });
});

describe('the screen is never still while working', () => {
  it('each stage names itself, shows the clock, and the clock moves', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeRecipient(unshieldedRecipient);
    typeAmount('250');
    fireEvent.click(checkButton());
    fake.emit({ name: 'working', stage: 'proving', forMs: 0 });
    expect(screen.getByText('Proving…')).toBeTruthy();
    expect(screen.getByText(/can take minutes/u)).toBeTruthy();
    expect(screen.getByText('0s')).toBeTruthy();
    fake.emit({ name: 'working', stage: 'proving', forMs: 65_000 });
    expect(screen.getByText('1m 05s')).toBeTruthy();
    fake.emit({ name: 'working', stage: 'submitting', forMs: 2_000 });
    expect(screen.getByText('Submitting…')).toBeTruthy();
  });
});

describe('the confirmation shows what WILL happen, read back — §4', () => {
  const toConfirm = (): FakeWiring => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeRecipient(unshieldedRecipient);
    typeAmount('250');
    fireEvent.click(checkButton());
    fake.emit({ name: 'confirm', facts });
    return fake;
  };

  it('recipient with both ends, amount with exact STARs, fee in DUST, balances after', () => {
    toConfirm();
    /* Both ends of the address — the standing habit. */
    const shortForm = screen.getByText((text) => text.includes('…')
      && text.startsWith(unshieldedRecipient.slice(0, unshieldedRecipient.lastIndexOf('1') + 1)));
    expect(shortForm.textContent?.endsWith(unshieldedRecipient.slice(-8))).toBe(true);
    /* The amount, exact, and WHERE it was read from. */
    expect(screen.getByText(/^250/u)).toBeTruthy();
    expect(screen.getByText(/Exactly 250,000,000 STARs/u)).toBeTruthy();
    expect(screen.getByText(/Read back out of the built transaction/u)).toBeTruthy();
    /* The fee, in DUST's own unit with the exact SPECKs beside it (§7.17). */
    expect(screen.getByText((text) => text.includes('1.092548630122142 tDUST'))).toBeTruthy();
    expect(screen.getByText(/exactly 1,092,548,630,122,142 SPECKs/u)).toBeTruthy();
    /* What the balance becomes — before → after, both tokens. */
    expect(screen.getAllByText(/4,750/u).length).toBeGreaterThan(0);
    /* The full address is one reveal away. */
    expect(screen.getByText(unshieldedRecipient)).toBeTruthy();
  });

  it('says ONCE, before, that sending cannot be undone', () => {
    toConfirm();
    expect(screen.getByText(/cannot be undone/u)).toBeTruthy();
  });

  it('a shielded amount says it is the builder\'s input, not a read-back', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeRecipient(shieldedRecipient);
    typeAmount('40');
    fireEvent.click(checkButton());
    fake.emit({
      name: 'confirm',
      facts: {
        ...facts,
        kind: 'shielded',
        recipientBech32: shieldedRecipient,
        stars: 40_000_000n,
        readBack: 'builder-input',
        nightBefore: 100_000_000n,
        nightAfter: 60_000_000n,
      },
    });
    expect(screen.getByText(/cannot be read back off the transaction/u)).toBeTruthy();
    expect(screen.getByText(/the privacy working/u)).toBeTruthy();
  });

  it('"Send it" confirms and "Don\'t send" cancels — through the send controller', () => {
    const fake = toConfirm();
    fireEvent.click(screen.getByText('Send it'));
    expect(fake.confirms).toHaveLength(1);
    fake.emit({ name: 'confirm', facts });
    fireEvent.click(screen.getByText('Don’t send'));
    expect(fake.cancels).toHaveLength(1);
  });
});

describe('the endings say exactly what is known — and no more', () => {
  const start = (): FakeWiring => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeRecipient(unshieldedRecipient);
    typeAmount('250');
    fireEvent.click(checkButton());
    return fake;
  };

  it('sent: the identifier, the figures — and NO irreversibility lecture afterwards', () => {
    const fake = start();
    fake.emit({ name: 'sent', txId: '00ab'.repeat(17), facts });
    expect(screen.getByText(/Sent\./u)).toBeTruthy();
    expect(screen.getByText('00ab'.repeat(17))).toBeTruthy();
    expect(screen.getByText(/Copy the transaction identifier/u)).toBeTruthy();
    /* §4: the warning belongs BEFORE a send, and afterwards it is only
     * cruelty — pinned by absence. */
    expect(screen.queryByText(/cannot be undone/u)).toBeNull();
  });

  it('cancelled: nothing moved, coins released', () => {
    const fake = start();
    fake.emit({ name: 'cancelled' });
    expect(screen.getByText(/Nothing was sent\./u)).toBeTruthy();
    expect(screen.getByText(/coins it had set aside are released/u)).toBeTruthy();
  });

  it('refused: the engine\'s words verbatim, and a way to start again', () => {
    const fake = start();
    fake.emit({ name: 'refused', message: 'the fee cannot be paid: no DUST. Nothing was sent and no money moved.' });
    expect(screen.getByRole('alert').textContent)
      .toBe('the fee cannot be paid: no DUST. Nothing was sent and no money moved.');
    fireEvent.click(screen.getByText('Start again'));
    expect(screen.getByLabelText(/The recipient/u)).toBeTruthy();
  });

  it('THE MIDDLE: unknown says unknown, hands over identifiers, never claims either way', () => {
    const fake = start();
    fake.emit({
      name: 'unknown',
      identifiers: ['id-one', 'id-two'],
      facts,
      stillWaiting: true,
      message: 'the network has not answered in 45 seconds. Do not send again on the assumption it failed.',
    });
    expect(screen.getByText(/Whether this sent is not known\./u)).toBeTruthy();
    expect(screen.getByText('id-one')).toBeTruthy();
    expect(screen.getByText('id-two')).toBeTruthy();
    /* The middle is WATCHED — the screen says the wallet is watching
     * and that the question is carried on the home screen; the copy button
     * is a courtesy, never the remedy. */
    expect(screen.getByText(/Still confirming/u)).toBeTruthy();
    expect(screen.getByText(/watching the chain/u)).toBeTruthy();
    expect(screen.getByText(/carried on the home\s*screen/u)).toBeTruthy();
    expect(screen.queryByText(/Sent\./u)).toBeNull();
    expect(screen.queryByText(/refused/iu)).toBeNull();
  });

  it('a RESOLVED middle says failed in the engine\'s words, with the identifiers', () => {
    const fake = start();
    fake.emit({
      name: 'failed',
      identifiers: ['id-one'],
      facts,
      message: 'this payment did not go through: the transaction\'s own deadline has '
        + 'passed and it never appeared on the chain as far as this wallet could see, '
        + 'so it can no longer be included and this payment is over. Whether it went '
        + 'through BEFORE the deadline and was simply never visible from here is NOT '
        + 'known — the only thing that said no was a silence. Check this payment on a '
        + 'block explorer before sending it again.',
    });
    expect(screen.getByText(/This payment did not go through\./u)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/can no longer be included/u);
    /* The screen must not be showing anybody "nothing moved". */
    expect(screen.getByRole('alert').textContent).not.toMatch(/[Nn]othing moved/u);
    expect(screen.getByText('id-one')).toBeTruthy();
    /* Terminal: the form comes back through Start again. */
    fireEvent.click(screen.getByText('Start again'));
    expect(screen.getByLabelText(/The recipient/u)).toBeTruthy();
  });
});

describe('the rehearsal is said out loud, and the paying wallet is named', () => {
  it('the banner says pretend chain and no real money, and scenarios lock in flight', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    expect(screen.getByText(/A rehearsal, not a real send/u)).toBeTruthy();
    expect(screen.getByText(/pretend chain/u)).toBeTruthy();
    expect(screen.getByText(/no real money can move/iu)).toBeTruthy();
    /* THE SAME THING IN A NEW PLACE. The restyle moved the picker off
     * `app.css` and onto the kit, so its handle is `data-scenarios` rather
     * than the `send-scenarios` class. The assertion is unchanged: the
     * FIELDSET is enabled before a send and disabled once one is in flight. */
    const fieldset = document.querySelector('fieldset[data-scenarios]') as HTMLFieldSetElement;
    expect(fieldset.disabled).toBe(false);
    typeRecipient(unshieldedRecipient);
    typeAmount('1');
    fireEvent.click(checkButton());
    fake.emit({ name: 'working', stage: 'starting', forMs: 0 });
    expect(fieldset.disabled).toBe(true);
  });

  it('pays from the LAST-USED wallet, the one home has open — never account 0 by habit', () => {
    const fake = fakeWiring();
    const secret = secretFromWords(TEST_MNEMONIC);
    saveLastUsedWallet(secret, 3);
    renderSend(fake.wiring, secret);
    expect(screen.getAllByText(/Subwallet 2/u).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Main wallet/u)).toBeNull();
  });

  it('leaving the screen stops the rehearsal behind the doors', () => {
    const fake = fakeWiring();
    const view = renderSend(fake.wiring);
    typeRecipient(unshieldedRecipient);
    typeAmount('1');
    fireEvent.click(checkButton());
    view.unmount();
    expect(fake.stops.length).toBeGreaterThan(0);
    expect(fake.detaches.length).toBeGreaterThan(0);
  });
});

describe('the live surface — real by default, rehearsal one quiet click away', () => {
  it('live mode is the default, says it is real, and names every host', () => {
    const fake = fakeWiring({ live: true });
    renderSend(fake.wiring);
    expect(screen.getByText(/This is real\./u)).toBeTruthy();
    /* The hosts, named before anything is pressed. The key
     * material is OURS — vendored, pinned, served from this wallet's own
     * origin — so the Foundation's bucket is no longer a host a
     * send can dial and must NOT be named as one. */
    expect(screen.getByText(/own origin/u)).toBeTruthy();
    expect(screen.getByText(/pinned fingerprints/u)).toBeTruthy();
    expect(screen.queryByText(/midnight-s3-fileshare/u)).toBeNull();
    expect(screen.getByText(/stagenet node/u)).toBeTruthy();
    expect(screen.queryByText(/A rehearsal, not a real send/u)).toBeNull();
    expect(document.querySelector('fieldset[data-scenarios]')).toBeNull();
  });

  it('the toggle goes to the pretend chain and back, and hides while a send runs', () => {
    const fake = fakeWiring({ live: true });
    renderSend(fake.wiring);
    fireEvent.click(screen.getByText('Practise on a pretend chain first'));
    expect(screen.getByText(/A rehearsal, not a real send/u)).toBeTruthy();
    fireEvent.click(screen.getByText('Back to real sending'));
    expect(screen.getByText(/This is real\./u)).toBeTruthy();
    typeRecipient(unshieldedRecipient);
    typeAmount('1');
    fireEvent.click(checkButton());
    fake.emit({ name: 'working', stage: 'starting', forMs: 0 });
    expect(screen.queryByText('Practise on a pretend chain first')).toBeNull();
  });

  it('without a live wiring the screen opens straight into the rehearsal', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    expect(screen.getByText(/A rehearsal, not a real send/u)).toBeTruthy();
    expect(screen.queryByText(/This is real\./u)).toBeNull();
    expect(fake.termsFetches).toHaveLength(0);
  });
});

describe('the network\'s terms — shown once, recorded, blocking nothing', () => {
  it('first live visit fetches, shows the url and the hash, and records', async () => {
    const fake = fakeWiring({
      live: true,
      fetchTerms: () => Promise.resolve({ hash: 'ab12'.repeat(16), url: 'https://terms.example/t' }),
    });
    renderSend(fake.wiring);
    expect(fake.termsFetches).toHaveLength(1);
    expect(await screen.findByText('ab12'.repeat(16))).toBeTruthy();
    expect(screen.getByText('https://terms.example/t')).toBeTruthy();
    expect(screen.getByText(/not a gate of this wallet/u)).toBeTruthy();
    /* Recorded: the card is a network fact, keyed by the network. */
    const raw = localStorage.getItem('midnight-identity:terms:stagenet');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).hash).toBe('ab12'.repeat(16));
  });

  it('a second visit shows no terms card at all', async () => {
    localStorage.setItem('midnight-identity:terms:stagenet',
      JSON.stringify({ hash: 'seen', url: 'https://terms.example/t', seenAt: 1 }));
    const fake = fakeWiring({ live: true });
    renderSend(fake.wiring);
    expect(screen.queryByText(/network’s terms/u)).toBeNull();
    expect(fake.termsFetches).toHaveLength(0);
  });

  it('a failed fetch blocks nothing and says so quietly', async () => {
    const fake = fakeWiring({
      live: true,
      fetchTerms: () => Promise.reject(new Error('the indexer is away')),
    });
    renderSend(fake.wiring);
    expect(await screen.findByText(/could not be fetched right now/u)).toBeTruthy();
    expect(screen.getByText(/Sending is not blocked/u)).toBeTruthy();
    /* The form still stands and still starts. */
    typeRecipient(unshieldedRecipient);
    typeAmount('1');
    expect(checkButton().disabled).toBe(false);
    fireEvent.click(checkButton());
    expect(fake.plans).toHaveLength(1);
  });

  it('the rehearsal never fetches terms — its promise is that nothing dials', () => {
    const fake = fakeWiring({ live: true });
    renderSend(fake.wiring);
    /* One fetch on the live screen (never answered here)… */
    expect(fake.termsFetches).toHaveLength(1);
    fireEvent.click(screen.getByText('Practise on a pretend chain first'));
    /* …and none for switching to the pretend chain. */
    expect(fake.termsFetches).toHaveLength(1);
    expect(screen.queryByText(/network’s terms/u)).toBeNull();
  });
});

/*
 * ===========================================================================
 * STAY ON THIS SCREEN, AWAKE
 * ===========================================================================
 *
 * A proof runs in a worker; the worker dies with the page;
 * on a phone, backgrounding the browser suspends JavaScript. **The record covers a
 * SUBMITTED transaction surviving a dead tab. It does not cover an IN-PROGRESS
 * PROOF**, which has no record anywhere until there is something to record.
 * Four things follow and each is pinned below: honest progress with one named
 * duration, a wake-lock whose refusal is a STATE, the truth for the tab that
 * dies anyway, and the warning said BEFORE somebody is trapped.
 */

/** A wake lock that answers, and a record of what was asked of it. */
function grantingWakeLock(): {
  readonly requests: string[]; readonly releases: number[]; readonly install: () => void;
} {
  const requests: string[] = [];
  const releases: number[] = [];
  return {
    requests,
    releases,
    install: () => {
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request: (kind: string) => {
            requests.push(kind);
            return Promise.resolve({
              release: () => { releases.push(releases.length + 1); return Promise.resolve(); },
            });
          },
        },
      });
    },
  };
}

/** A browser that HAS the API and says no — the state, not the error. */
const refusingWakeLock = (): void => {
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: { request: () => Promise.reject(new Error('NotAllowedError')) },
  });
};

const noWakeLockAtAll = (): void => {
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
};

/** Let the wake-lock promise settle inside `act`, so React has re-rendered
 * before anything is asserted about what the screen says. */
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve(); }); };

describe('§1 — the waiting behaviour: stay on this screen, awake', () => {
  const started = (): FakeWiring => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeRecipient(unshieldedRecipient);
    typeAmount('250');
    fireEvent.click(checkButton());
    return fake;
  };

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'wakeLock');
    vi.restoreAllMocks();
  });

  /**
   * HONEST PROGRESS, AND NO PERCENTAGE. THE RULE: *"the stage, the
   * clock, and how long this usually takes — not a bar that pretends to know a
   * percentage."* Nothing on this screen can know one: the prover does not
   * report progress.
   */
  it('says how long this usually takes, whose measurement it is, and shows no bar', async () => {
    noWakeLockAtAll();
    const fake = started();
    fake.emit({ name: 'working', stage: 'proving', forMs: 3_000 });
    await settle();
    expect(screen.getByText(/On a laptop this usually finishes in around/u)).toBeTruthy();
    expect(screen.getByText(/A phone has never been measured/u)).toBeTruthy();
    expect(screen.getByText(/no percentage to show you/u)).toBeTruthy();
    /* Not a bar, not a meter, not a spinner claiming a fraction. */
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(document.querySelector('progress')).toBeNull();
  });

  /**
   * ONE NAMED CONSTANT, AND THE TEST IS THAT THE TWO PLACES AGREE. *"When the
   * number lands it is one edit."* Two hardcoded numbers would drift, and the
   * cheapest way to find that out is to make the screen say the same duration
   * before the send and during it.
   */
  it('the duration before the send and the duration during it are the same number', async () => {
    const fake = fakeWiring({ live: true });
    renderSend(fake.wiring);
    const before = screen.getByText(/Pick a moment when you can leave this open/u).textContent ?? '';
    const stated = /(\d+m \d\ds|\d+s)/u.exec(before)?.[1];
    expect(stated).toBeTruthy();

    typeRecipient(unshieldedRecipient);
    typeAmount('250');
    fireEvent.click(checkButton());
    fake.emit({ name: 'working', stage: 'proving', forMs: 1_000 });
    await settle();
    expect(screen.getByText(/On a laptop this usually finishes in around/u).textContent)
      .toContain(stated as string);
  });

  /**
   * TOLD BEFORE THEY START, NOT AFTER THEY ARE TRAPPED. Both doors: the live
   * banner, which is on screen before anything is typed, and the confirmation,
   * which is the last thing read before the button.
   */
  it('the live screen says you have to stay on it, before anything is typed', () => {
    const fake = fakeWiring({ live: true });
    renderSend(fake.wiring);
    expect(screen.getByText(/You have to stay on this screen while it works/u)).toBeTruthy();
    expect(screen.getByText(/Pick a moment when you can leave this open/u)).toBeTruthy();
  });

  it('the confirmation says it again, before the button — and it is not the undo sentence', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeRecipient(unshieldedRecipient);
    typeAmount('250');
    fireEvent.click(checkButton());
    fake.emit({ name: 'confirm', facts });
    const wait = screen.getByText(/this screen has to stay open the whole time/u);
    const undo = screen.getByText(/cannot be undone/u);
    /* Two different sentences: the irreversibility line is §4's and says
     * nothing about time; the waiting line is the new one and says nothing about
     * refunds. Collapsing them would lose one of the two. */
    expect(wait).not.toBe(undo);
    expect(undo.textContent).not.toMatch(/stay open/u);
    expect(wait.textContent).not.toMatch(/cannot be undone/u);
    /* Both BEFORE the button, in document order. */
    const send = screen.getByText('Send it');
    expect(wait.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(undo.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * THE TAB THAT DIES ANYWAY GETS THE TRUTH, AND TODAY IT IS THAT IT DID NOT
   * HAPPEN. *"Do not imply it might still land — the entire value of the record's
   * pending record is that it distinguishes submitted from never started, and
   * this state is firmly the second."* Pinned by what it says AND by what it
   * refuses to say.
   */
  it('while proving, says nothing was sent, nothing is pending, and nothing may still land', async () => {
    noWakeLockAtAll();
    const fake = started();
    fake.emit({ name: 'working', stage: 'proving', forMs: 5_000 });
    await settle();
    const truth = screen.getByText(/Nothing has been sent yet/u);
    expect(truth.textContent).toMatch(/no money moves/u);
    expect(truth.textContent).toMatch(/nothing is left pending/u);
    expect(truth.textContent).toMatch(/nothing to come back to/u);
    /* And never the sentence that would make a dead tab sound survivable. */
    expect(truth.textContent).not.toMatch(/still (land|arrive|go through)/u);
    expect(screen.queryByText(/carried on the home screen/u)).toBeNull();
  });

  it('and says none of that once the send is over — the warning is not left standing', async () => {
    noWakeLockAtAll();
    const fake = started();
    fake.emit({ name: 'working', stage: 'proving', forMs: 5_000 });
    await settle();
    expect(screen.getByText(/Stay on this screen\./u)).toBeTruthy();
    fake.emit({ name: 'sent', txId: 'ff00'.repeat(17), facts });
    await settle();
    expect(screen.queryByText(/Stay on this screen\./u)).toBeNull();
    expect(screen.queryByText(/keeping the screen awake/u)).toBeNull();
  });

  /* ------------------------------------------------------- the wake lock */

  it('asks for the screen wake lock when proving starts, and not before', async () => {
    const lock = grantingWakeLock();
    lock.install();
    const fake = started();
    fake.emit({ name: 'working', stage: 'balancing', forMs: 1_000 });
    await settle();
    expect(lock.requests).toHaveLength(0);
    fake.emit({ name: 'working', stage: 'proving', forMs: 0 });
    await settle();
    expect(lock.requests).toEqual(['screen']);
    expect(screen.getByText(/keeping the screen awake/u)).toBeTruthy();
  });

  it('releases it when proving ends', async () => {
    const lock = grantingWakeLock();
    lock.install();
    const fake = started();
    fake.emit({ name: 'working', stage: 'proving', forMs: 0 });
    await settle();
    expect(lock.releases).toHaveLength(0);
    fake.emit({ name: 'working', stage: 'submitting', forMs: 0 });
    await settle();
    expect(lock.releases).toHaveLength(1);
  });

  /** *"including on failure and on unmount."* */
  it('releases it when the send FAILS, and when the screen goes away under it', async () => {
    const failing = grantingWakeLock();
    failing.install();
    const one = started();
    one.emit({ name: 'working', stage: 'proving', forMs: 0 });
    await settle();
    one.emit({
      name: 'failed', identifiers: ['id-one'], facts, message: 'it did not go through.',
    });
    await settle();
    expect(failing.releases).toHaveLength(1);

    cleanup();
    const leaving = grantingWakeLock();
    leaving.install();
    const fake = fakeWiring();
    const view = renderSend(fake.wiring);
    typeRecipient(unshieldedRecipient);
    typeAmount('250');
    fireEvent.click(checkButton());
    fake.emit({ name: 'working', stage: 'proving', forMs: 0 });
    await settle();
    view.unmount();
    await settle();
    expect(leaving.releases).toHaveLength(1);
  });

  /**
   * THE REFUSAL PATH, WHICH IS THE ONE THE DESIGN ASKS FOR BY NAME:
   * *"the wake-lock's REFUSAL path exercised, not just its happy one."* A
   * browser that says no still proves and still sends; the screen says the
   * true thing instead of pretending it has been handled.
   */
  it('A REFUSED lock is a sentence, not an error — and the send still completes', async () => {
    refusingWakeLock();
    const fake = started();
    fake.emit({ name: 'working', stage: 'proving', forMs: 0 });
    await settle();
    expect(screen.getByText(/will not keep the screen awake/u)).toBeTruthy();
    expect(screen.getByText(/keep it awake yourself/u)).toBeTruthy();
    expect(screen.queryByText(/is keeping the screen awake/u)).toBeNull();
    /* The refusal never reaches the engine: the clock is still moving and the
     * send still ends the way it would have. */
    fake.emit({ name: 'working', stage: 'proving', forMs: 61_000 });
    await settle();
    expect(screen.getByText('1m 01s')).toBeTruthy();
    fake.emit({ name: 'sent', txId: 'ab99'.repeat(17), facts });
    await settle();
    expect(screen.getByText(/Sent\./u)).toBeTruthy();
    expect(screen.getByText('ab99'.repeat(17))).toBeTruthy();
  });

  /** A browser with no wake lock at all says the SAME sentence — a person can
   * do nothing different about the two, so they are not two sentences. */
  it('a browser with no wake lock at all says the same thing', async () => {
    noWakeLockAtAll();
    const fake = started();
    fake.emit({ name: 'working', stage: 'proving', forMs: 0 });
    await settle();
    expect(screen.getByText(/will not keep the screen awake/u)).toBeTruthy();
    fake.emit({ name: 'sent', txId: 'cd11'.repeat(17), facts });
    await settle();
    expect(screen.getByText(/Sent\./u)).toBeTruthy();
  });
});

/*
 * ===========================================================================
 * THE STEP ORDER IS A SECURITY PROPERTY, NOT A LAYOUT
 * ===========================================================================
 *
 * THE RULE: *"the ordering defects live in the sequence. Places
 * are data, flows are not — a flow's steps may not be reordered to read
 * better."* Nothing pinned that on this screen, so a restyle could have
 * reordered the confirmation's facts or let the form stand beside the work and
 * every one of the 774 tests would have stayed green. These are the tests that
 * would have gone red.
 */
describe('the order of things, pinned', () => {
  const positionsOf = (...texts: readonly (string | RegExp)[]): number[] => texts.map((text) => {
    const found = screen.getByText(text as RegExp);
    return [...document.querySelectorAll('*')].indexOf(found);
  });

  const toConfirm = (kind: 'unshielded' | 'shielded' = 'unshielded'): FakeWiring => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeRecipient(kind === 'shielded' ? shieldedRecipient : unshieldedRecipient);
    typeAmount('250');
    fireEvent.click(checkButton());
    fake.emit({ name: 'confirm', facts });
    return fake;
  };

  /**
   * THE FOUR FACTS, IN THE ORDER SOMEBODY CHECKS THEM IN: who is being paid,
   * how much, what it costs, and what is left. Reordering them to look better
   * is the thing the design forbids by name.
   */
  it('the confirmation reads To, then Amount, then the fee, then what is left', () => {
    toConfirm();
    const [to, amount, fee, after] = positionsOf(
      /^To$/u, /^Amount$/u, /^The fee, in DUST$/u, /afterwards$/u);
    expect(to).toBeLessThan(amount as number);
    expect(amount as number).toBeLessThan(fee as number);
    expect(fee as number).toBeLessThan(after as number);
  });

  /** And the two things said BEFORE the button are before the button, in the
   * document as well as on the screen — which is what makes it true of a
   * keyboard and a screen reader too. */
  it('everything a person is told comes before the control they are told about', () => {
    toConfirm();
    const [after, undo, wait] = positionsOf(
      /afterwards$/u, /cannot be undone/u, /this screen has to stay open the whole time/u);
    const send = [...document.querySelectorAll('*')].indexOf(screen.getByText('Send it'));
    expect(after as number).toBeLessThan(undo as number);
    expect(undo as number).toBeLessThan(wait as number);
    expect(wait as number).toBeLessThan(send);
  });

  /**
   * THE FORM IS GONE WHILE A SEND CAN STILL CHANGE THE WORLD. Not styling: a
   * form standing beside a running send is a second door onto the engine while
   * the first one is still open, and *one surface approves anything that moves
   * money* is the rule the whole architecture hangs off.
   */
  it('the form is not on screen while anything is in flight', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeRecipient(unshieldedRecipient);
    typeAmount('250');
    fireEvent.click(checkButton());
    expect(screen.queryByLabelText(/The recipient/u)).not.toBeNull();

    for (const state of [
      { name: 'working', stage: 'proving', forMs: 0 },
      { name: 'confirm', facts },
      { name: 'unknown', identifiers: ['id'], facts, stillWaiting: true, message: 'not known.' },
    ] as SendState[]) {
      fake.emit(state);
      expect(screen.queryByLabelText(/The recipient/u)).toBeNull();
      expect(screen.queryByText('Check this payment')).toBeNull();
    }
  });

  /** The rehearsal picker cannot be changed under a send that is running —
   * the same rule, on the control that decides which chain is being used. */
  it('the scenario picker cannot be changed while a send is in flight', () => {
    const fake = fakeWiring();
    renderSend(fake.wiring);
    typeRecipient(unshieldedRecipient);
    typeAmount('250');
    fireEvent.click(checkButton());
    const picker = (): HTMLFieldSetElement =>
      document.querySelector('fieldset[data-scenarios]') as HTMLFieldSetElement;
    fake.emit({ name: 'confirm', facts });
    expect(picker().disabled).toBe(true);
    fake.emit({
      name: 'unknown', identifiers: ['id'], facts, stillWaiting: true, message: 'not known.',
    });
    expect(picker().disabled).toBe(true);
    /* And it comes back once the send is over and nothing can change. */
    fake.emit({ name: 'cancelled' });
    expect(picker().disabled).toBe(false);
  });
});

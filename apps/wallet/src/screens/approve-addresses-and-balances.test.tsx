// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '../testing/render.js';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, secretFromWords } from 'midnight-identity/keys/derivation';
import { parseAsk, type AddressesAndBalancesRequest } from 'midnight-identity/profile/request';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { NETWORK } from 'midnight-identity/network';
import { readAddressesAndBalancesAnswer } from 'midnight-identity/profile/addresses-and-balances';
import { BalanceEnginesContext, type BalanceEngines } from '../chain/balance-context.js';
import type { BalanceEngine, BalanceState } from '../chain/balance.js';
import { GIVE_UP_AFTER_MS, NIGHT_RAW } from '../chain/balance.js';
import { NIGHT_UNSHIELDED_RAW } from '../chain/unshielded.js';
import { ownedAddressFor } from '../accounts/owned-address.js';
import { recordingChannel } from '../testing/recording-channel.js';
import { watchedStore } from '../testing/settled-store.js';
import { watchedOpener } from '../testing/settled-channel.js';
import { ApproveAddressesAndBalances } from './approve-addresses-and-balances.js';
import { Approve } from './approve.js';

/*
 * The screen a person sees when a page asks where one of their wallets
 * receives and what it holds: both addresses, every amount marked private or
 * public, read by the wallet's own balance engines after the screen opened,
 * and one press that hands over exactly what was listed.
 */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const ORIGIN = 'https://payroll-a.example';
const OTHER = 'ab'.repeat(32);
const wire = {
  schema: 'midnight-identity/disclosure-request/v1', kind: 'addresses-and-balances',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' }, purpose: 'To show your deposit options.',
  nonce: 'ab1', expiresAt: NOW + 600_000,
};
const ask = parseAsk(wire, ORIGIN, NOW) as AddressesAndBalancesRequest;
const owned = ownedAddressFor(identity, 0, {}, NETWORK);

/** An engine a test speaks for: it records each start, each stop, and hands the test the way to report a state. */
const engineWeSpeakFor = () => {
  const said: ((s: BalanceState) => void)[] = [];
  const log = { started: 0, stopped: 0 };
  const engine: BalanceEngine = (_identity, _account, onState) => {
    log.started += 1;
    said.push(onState);
    return () => { log.stopped += 1; };
  };
  return { engine, log, say: (s: BalanceState) => { for (const f of said) f(s); } };
};
const settle = async () => { await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); }); };
const pressButton = (c: HTMLElement) => c.querySelector('[data-show-addresses]') as HTMLButtonElement;

const draw = (consent: { ok: true } | { ok: false; says: string } = { ok: true }) => {
  const shielded = engineWeSpeakFor();
  const unshielded = engineWeSpeakFor();
  const engines: BalanceEngines = { shielded: shielded.engine, unshielded: unshielded.engine, dust: engineWeSpeakFor().engine };
  const answers: unknown[] = [];
  const declined: string[] = [];
  const view = render(
    <BalanceEnginesContext.Provider value={engines}>
      <ApproveAddressesAndBalances request={ask} identity={identity} owned={owned} channel={recordingChannel(answers)}
        consent={consent} whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => declined.push('declined')}
        now={() => NOW} />
    </BalanceEnginesContext.Provider>);
  return { ...view, shielded, unshielded, answers, declined };
};

afterEach(() => { cleanup(); });

describe('A PAGE ASKING WHERE A WALLET RECEIVES AND WHAT IT HOLDS', () => {
  it('NOTHING CAN BE PRESSED UNTIL BOTH SIDES ARE READ AFTER THE SCREEN OPENED, AND NOTHING IS SENT BEFORE THE PRESS', async () => {
    const s = draw();
    await settle();
    /* RED WHEN: either side is read by anything but the wallet's own engines, or is not read at all. */
    expect([s.shielded.log.started, s.unshielded.log.started]).toEqual([1, 1]);
    expect(pressButton(s.container).disabled).toBe(true);
    /* A figure the engine replays from its saved state, true of an earlier moment. */
    await act(async () => { s.shielded.say({ name: 'synced', night: 9n, asOf: NOW - 60_000, others: {} }); });
    await act(async () => { s.unshielded.say({ name: 'synced', night: 3n, asOf: NOW, others: {} }); });
    /* RED WHEN: a figure from before the screen opened is taken as the reading the page is shown. */
    expect(pressButton(s.container).disabled).toBe(true);
    expect(s.container.querySelector('[data-side="private"] [data-side-reading]')).not.toBeNull();
    /* RED WHEN: anything crosses to the page before the person presses. */
    expect(s.answers).toEqual([]);
  });

  it('THE PRESS HANDS OVER EXACTLY WHAT WAS LISTED: BOTH ADDRESSES, EVERY TOKEN, EACH MARKED PRIVATE OR PUBLIC', async () => {
    const s = draw();
    await settle();
    await act(async () => { s.shielded.say({ name: 'synced', night: 5_000_000n, asOf: NOW + 1, others: { [OTHER]: 7n } }); });
    await act(async () => { s.unshielded.say({ name: 'synced', night: 12n, asOf: NOW + 2, others: {} }); });
    /* RED WHEN: an engine keeps reading after its side is settled. */
    expect([s.shielded.log.stopped, s.unshielded.log.stopped]).toEqual([1, 1]);
    const listed = (side: string) => [...s.container.querySelectorAll(`[data-side="${side}"] [data-token]`)].map((li) => li.getAttribute('data-token'));
    expect(listed('private')).toEqual([NIGHT_RAW, OTHER]);
    expect(listed('public')).toEqual([NIGHT_UNSHIELDED_RAW]);
    expect(s.container.querySelector('[data-side="private"] [data-side-address]')?.textContent).toBe(owned.address.bech32);
    expect(s.container.querySelector('[data-side="public"] [data-side-address]')?.textContent).toBe(owned.unshieldedBech32);
    await act(async () => { fireEvent.click(pressButton(s.container)); });
    expect(s.answers).toHaveLength(1);
    const read = readAddressesAndBalancesAnswer(s.answers[0], { atOrigin: ORIGIN, expectingNonce: 'ab1' });
    /* RED WHEN: what crosses is not the wallet's own addresses, or an amount, a token, a side or a moment differs from the screen. */
    expect(read).toEqual({
      ok: true, at: NOW,
      shown: {
        addresses: { private: owned.address.bech32, public: owned.unshieldedBech32 },
        balances: [
          { token: NIGHT_RAW, amount: '5000000', visibility: 'private' },
          { token: OTHER, amount: '7', visibility: 'private' },
          { token: NIGHT_UNSHIELDED_RAW, amount: '12', visibility: 'public' },
        ],
        read: { private: NOW + 1, public: NOW + 2 },
      },
    });
    expect(s.container.querySelector('[data-shown-heading]')).not.toBeNull();
  });

  it('A SIDE THE WALLET COULD NOT READ IS SAID AS NOT KNOWN, AND HANDED OVER AS NOT KNOWN, NEVER AS ZERO', async () => {
    const s = draw();
    await settle();
    await act(async () => { s.shielded.say({ name: 'failed', message: 'the indexer did not answer' }); });
    await act(async () => { s.unshielded.say({ name: 'synced', night: 0n, asOf: NOW + 2, others: {} }); });
    /* RED WHEN: a failed read is shown as a figure, or the press stays shut for ever. */
    expect(s.container.querySelector('[data-side="private"] [data-side-not-read]')?.textContent).toMatch(/told it is not known rather than shown a figure/u);
    expect(s.container.querySelector('[data-side="private"] [data-token]')).toBeNull();
    await act(async () => { fireEvent.click(pressButton(s.container)); });
    const read = readAddressesAndBalancesAnswer(s.answers[0], { atOrigin: ORIGIN, expectingNonce: 'ab1' });
    /* RED WHEN: the page is handed a private figure the wallet never read. */
    expect(read.ok && read.shown.read.private).toBeNull();
    expect(read.ok && read.shown.balances.filter((b) => b.visibility === 'private')).toEqual([]);
  });

  it('A SIDE THAT IS NOT READ AFRESH IN TIME IS NOT KNOWN, EVEN AFTER ITS ENGINE REPLAYED A SAVED FIGURE AND WENT QUIET', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const s = draw();
      await act(async () => { s.shielded.say({ name: 'synced', night: 9n, asOf: NOW - 60_000, others: {} }); });
      await act(async () => { s.unshielded.say({ name: 'synced', night: 3n, asOf: NOW + 1, others: {} }); });
      expect(pressButton(s.container).disabled).toBe(true);
      await act(async () => { vi.advanceTimersByTime(GIVE_UP_AFTER_MS); });
      /* RED WHEN: a side whose engine stopped reporting after a saved figure leaves the screen reading for ever, with the press held. */
      expect(s.container.querySelector('[data-side="private"] [data-side-not-read]')).not.toBeNull();
      expect(pressButton(s.container).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('WHAT THE SCREEN SAYS WENT IS WHAT WENT, AND FOCUS MOVES TO IT', async () => {
    const s = draw();
    await settle();
    await act(async () => { s.shielded.say({ name: 'synced', night: 5n, asOf: NOW + 1, others: {} }); });
    await act(async () => { s.unshielded.say({ name: 'synced', night: 12n, asOf: NOW + 2, others: {} }); });
    await act(async () => { fireEvent.click(pressButton(s.container)); });
    /* RED WHEN: focus is left on a button that is no longer there. */
    expect(document.activeElement).toBe(s.container.querySelector('[data-shown-heading]'));
    /* The screen is drawn again with a new clock, and the engines start reading afresh. */
    s.rerender(
      <BalanceEnginesContext.Provider value={{ shielded: s.shielded.engine, unshielded: s.unshielded.engine, dust: engineWeSpeakFor().engine }}>
        <ApproveAddressesAndBalances request={ask} identity={identity} owned={owned} channel={recordingChannel([])}
          consent={{ ok: true }} whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => {}} now={() => NOW + 5} />
      </BalanceEnginesContext.Provider>);
    await settle();
    /* RED WHEN: the screen that says what was shown lists a later reading the page never received. */
    expect([...s.container.querySelectorAll('[data-token]')].map((li) => li.textContent)).toEqual(['0.000005 tNIGHT', '0.000012 tNIGHT']);
  });

  it('DO NOT SHOW THEM ANSWERS NOTHING BUT NO; WITHOUT CONSENT FROM THE FRAME THE PRESS DOES NOTHING; LEAVING STOPS THE READS', async () => {
    const no = draw();
    await act(async () => { fireEvent.click(no.container.querySelector('[data-decline]')!); });
    /* RED WHEN: declining hands anything over, or does not reach the page. */
    expect(no.declined).toEqual(['declined']);
    expect(no.answers).toEqual([]);
    no.unmount();
    /* RED WHEN: an engine still reading goes on after the screen has gone. */
    expect([no.shielded.log.stopped, no.unshielded.log.stopped]).toEqual([1, 1]);
    const shut = draw({ ok: false, says: 'this window is too small' });
    await act(async () => { shut.shielded.say({ name: 'synced', night: 1n, asOf: NOW + 1, others: {} }); });
    await act(async () => { shut.unshielded.say({ name: 'synced', night: 1n, asOf: NOW + 1, others: {} }); });
    /* RED WHEN: a press the frame's guard refuses still hands the page anything. */
    expect(pressButton(shut.container).disabled).toBe(true);
    await act(async () => { fireEvent.click(pressButton(shut.container)); });
    expect(shut.answers).toEqual([]);
  });

  it('THE WALLET ROUTES THIS ASK TO ITS OWN SCREEN, WITH THE CHOSEN WALLET\'S OWN ADDRESSES', async () => {
    const opener = watchedOpener();
    const handlers: ((event: MessageEvent) => void)[] = [];
    const view: ChannelWindow = {
      opener: opener as ChannelWindow['opener'],
      addEventListener: (_t, h) => { handlers.push(h); },
      removeEventListener: () => {},
    };
    const shielded = engineWeSpeakFor();
    const unshielded = engineWeSpeakFor();
    const { container } = render(
      <BalanceEnginesContext.Provider value={{ shielded: shielded.engine, unshielded: unshielded.engine, dust: engineWeSpeakFor().engine }}>
        <Approve identity={identity} secret={secretFromWords(TEST_MNEMONIC)} port={watchedStore()} view={view} now={() => NOW} />
      </BalanceEnginesContext.Provider>);
    await act(async () => { for (const h of handlers) h({ source: opener, origin: ORIGIN, data: wire } as unknown as MessageEvent); });
    await settle();
    /* RED WHEN: the approval screen does not route this kind here, or shows another wallet's addresses than the one in its picker. */
    expect(container.querySelector('[data-headline]')?.textContent).toBe(`Show ${ORIGIN} your wallet’s addresses and balances`);
    const picked = Number((container.querySelector('#approve-subwallet') as HTMLSelectElement).value);
    expect(container.querySelector('[data-side="public"] [data-side-address]')?.textContent)
      .toBe(ownedAddressFor(identity, picked, {}, NETWORK).unshieldedBech32);
    const before = opener.sent.length;
    /* RED WHEN: anything reaches the page before the press. */
    expect(opener.sent.filter((p) => (p.message as { schema?: string }).schema === 'midnight-identity/addresses-and-balances/v1')).toEqual([]);
    fireEvent.click(container.querySelector('[data-decline]')!);
    await settle();
    expect(opener.sent.length).toBe(before + 1);
  });
});

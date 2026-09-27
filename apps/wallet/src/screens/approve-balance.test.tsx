// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, secretFromWords } from 'midnight-identity/keys/derivation';
import { parseAsk } from 'midnight-identity/profile/request';
import type { BalanceRequest } from 'midnight-identity/profile/request';
import type { Channel, ChannelWindow } from 'midnight-identity/profile/channel';
import type { BalancedAnswer } from 'midnight-identity/profile/balance';
import { watchedStore } from '../testing/settled-store.js';
import { afterTheAnswer, settled, watchedOpener } from '../testing/settled-channel.js';
import { ApproveBalance } from './approve-balance.js';
import { Approve } from './approve.js';
import type { BalanceDoors, FacadeForBalancing, WalletPartForBalancing } from '../chain/balance-for-page.js';

/*
 * The screen a person sees when a company's page asks this wallet to pay for a
 * deposit: what leaves, read from the transaction; one press; and an answer
 * only after the press.
 */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const SECRET = secretFromWords(TEST_MNEMONIC);
const ORIGIN = 'https://payroll-a.example';
const CO = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
const TOKEN = 'ab'.repeat(32);

const wire = (over: Record<string, unknown> = {}) => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'balance',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'Put money into your company vault.',
  nonce: 'b1',
  expiresAt: NOW + 600_000,
  company: CO,
  vault: VAULT,
  transaction: 'AAECAw==',
  ...over,
});
const ask = parseAsk(wire(), ORIGIN, NOW) as BalanceRequest;

/** A part of the wallet that has read the chain, and one whose reading the test drives. */
const read = (): WalletPartForBalancing => ({
  state: { subscribe: (o) => { o.next({ progress: { isConnected: true, isStrictlyComplete: () => true } }); return { unsubscribe: () => {} }; } },
});
const stillReading = () => {
  let observer: Parameters<WalletPartForBalancing['state']['subscribe']>[0] | null = null;
  return {
    state: { subscribe: (o: Parameters<WalletPartForBalancing['state']['subscribe']>[0]) => { observer = o; return { unsubscribe: () => {} }; } },
    says: (isConnected: boolean, complete: boolean) => observer?.next({ progress: { isConnected, isStrictlyComplete: () => complete } }),
    breaks: (e: unknown) => observer?.error(e),
  };
};
/** A balance the test lets finish when it chooses. */
const heldBalance = () => {
  let release: (v: unknown) => void = () => {};
  const held = new Promise((r) => { release = r; });
  return { balanceUnboundTransaction: async () => { await held; return 'recipe'; }, release: () => release('recipe') };
};

const doorsWith = (log: string[], facade: Partial<FacadeForBalancing> = {}, actions: unknown[] = [{ address: VAULT, entryPoint: 'deposit' }]) => (): BalanceDoors => ({
  ledger: async () => ({
    Transaction: {
      deserialize: () => ({
        intents: new Map([[1, { actions }]]),
        guaranteedOffer: { inputs: [], transients: [], outputs: [{ contractAddress: VAULT }] },
        imbalances: (s: number) => new Map(s === 0 ? [[{ tag: 'shielded', raw: TOKEN }, -2500n]] : []),
      }),
    },
  }),
  facade: async () => ({
    balanceUnboundTransaction: async () => { log.push('balance'); return 'recipe'; },
    signRecipe: async () => { log.push('sign'); return 'signed'; },
    finalizeRecipe: async () => { log.push('finish'); return { serialize: () => new Uint8Array([4, 2]) }; },
    revert: async () => { log.push('revert'); },
    shielded: read(),
    unshielded: read(),
    ...facade,
  }) as FacadeForBalancing,
  keys: () => ({ shieldedSecretKeys: 'z', dustSecretKey: 'd' }),
  signSegment: () => async () => ({}) as never,
  now: () => NOW,
});
const channelFor = (answers: unknown[]): Channel => ({
  answer: (a) => { answers.push(a); },
  refuse: (r: string, why?: string) => { answers.push(why === undefined ? { refused: r } : { refused: r, why }); },
  stop: () => {},
} as Channel);
const consented = { ok: true } as never;
const renderWith = (doors: () => BalanceDoors, answers: unknown[], consent = consented, declined: string[] = []) => render(
  <ApproveBalance
    request={ask} identity={identity} account={0} channel={channelFor(answers)} consent={consent}
    whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => declined.push('declined')}
    doorsFor={doors} now={() => NOW} />);

afterEach(() => { cleanup(); });

describe('A PAGE ASKING THIS WALLET TO PAY FOR A DEPOSIT', () => {
  it('shows what leaves, read from the transaction, and the vault whole - and sends nothing before the press', async () => {
    const log: string[] = []; const answers: unknown[] = [];
    renderWith(doorsWith(log), answers);
    expect(await screen.findByText(`2500 base units of the private token below`)).toBeTruthy();
    expect(screen.getByText(`shielded token ${TOKEN}`)).toBeTruthy();
    expect(screen.getByText(VAULT)).toBeTruthy();
    expect(screen.getByText('You pay no network fee. The company pays it.')).toBeTruthy();
    await settled(20);
    expect(answers).toEqual([]);
    expect(log).toEqual([]);
  });

  it('THE PRESS pays, signs, finishes, and answers the origin that asked with the figure that was shown', async () => {
    const log: string[] = []; const answers: unknown[] = [];
    renderWith(doorsWith(log), answers);
    // WAIT FOR THE SCREEN TO BE READY BEFORE PRESSING, BECAUSE THE BUTTON
    // RENDERS IN EVERY STAGE AND IS DISABLED IN ALL BUT ONE. findByText
    // resolves on the FIRST render, while the screen is still reading the
    // transaction and the button is disabled, so a press fired then lands on
    // a dead control and the test waits out its timeout for a confirmation
    // that can never come. On a fast machine the read settles in the same
    // tick and the press works; on a slow runner the press wins the race.
    // This is what turned CI red on 19 Sep with no change to the wallet.
    // The amount below is rendered only once the stage is `ready`.
    expect(await screen.findByText(`2500 base units of the private token below`)).toBeTruthy();
    fireEvent.click(screen.getByText('Pay into the vault'));
    await screen.findByText(`You paid for a deposit for ${ORIGIN}`);
    expect(log).toEqual(['balance', 'sign', 'finish']);
    const answer = answers[0] as BalancedAnswer;
    expect(answer).toMatchObject({
      schema: 'midnight-identity/balanced/v1', origin: ORIGIN, company: CO, vault: VAULT, nonce: 'b1', at: NOW,
      transaction: 'BAI=', leaves: [{ token: TOKEN, amount: '2500', kind: 'shielded' }],
    });
  });

  it('A FAILED PRESS HANDS BACK NOTHING, LETS GO OF WHAT IT BOOKED, AND TELLS THE PAGE IT FAILED', async () => {
    const log: string[] = []; const answers: unknown[] = [];
    renderWith(doorsWith(log, { finalizeRecipe: async () => { throw new Error('the proof would not build.'); } }), answers);
    // THE SAME RACE AS THE TEST ABOVE, AND IT WAS STILL GREEN ONLY BECAUSE
    // THIS RUNNER HAPPENED TO WIN IT. Wait for the ready stage before pressing.
    expect(await screen.findByText(`2500 base units of the private token below`)).toBeTruthy();
    fireEvent.click(screen.getByText('Pay into the vault'));
    expect(await screen.findByText(/the proof would not build\. Anything this wallet set aside/)).toBeTruthy();
    expect(screen.getByText(/Anything this wallet set aside for it has been let go\. The page was given nothing and has been told this payment failed\./)).toBeTruthy();
    expect(log).toEqual(['balance', 'sign', 'revert']);
    /* RED WHEN: a person who approved is reported to the page as having declined, or the page hears nothing. */
    expect(answers).toEqual([{ refused: 'failed', why: 'did-not-finish' }]);
  });

  it('THE WALLET READS THE CHAIN BEFORE IT PAYS, SAYS SO, AND LETS THE PERSON STILL SAY NO', async () => {
    const log: string[] = []; const answers: unknown[] = []; const declined: string[] = [];
    const shielded = stillReading();
    renderWith(doorsWith(log, { shielded }), answers, consented, declined);
    expect(await screen.findByText(`2500 base units of the private token below`)).toBeTruthy();
    fireEvent.click(screen.getByText('Pay into the vault'));
    /* RED WHEN: the screen does not say the wallet is reading, or it balances before the read is done. */
    expect(await screen.findByText(/Your wallet is reading the network to find your private coins/)).toBeTruthy();
    shielded.says(true, false);
    await settled(20);
    expect(log).toEqual([]);
    const no = screen.getByText('Do not pay') as HTMLButtonElement;
    /* RED WHEN: a person waiting on a slow read cannot walk away. */
    expect(no.disabled).toBe(false);
    fireEvent.click(no);
    shielded.says(true, true);
    await settled(20);
    /* RED WHEN: coins are added, or a failure is reported, for a payment the person turned down while it was reading. */
    expect(log).toEqual([]);
    expect(declined).toEqual(['declined']);
    expect(answers).toEqual([]);
  });

  it('ONCE THE COINS ARE BEING ADDED, IT NO LONGER SAYS NOTHING IS PAID, AND "NO" IS NO LONGER OFFERED', async () => {
    const log: string[] = []; const answers: unknown[] = [];
    const shielded = stillReading();
    const held = heldBalance();
    renderWith(doorsWith(log, { shielded, balanceUnboundTransaction: held.balanceUnboundTransaction as never }), answers);
    expect(await screen.findByText(`2500 base units of the private token below`)).toBeTruthy();
    fireEvent.click(screen.getByText('Pay into the vault'));
    await screen.findByText(/Your wallet is reading the network/);
    shielded.says(true, true);
    await settled(20);
    /* RED WHEN: the screen keeps saying nothing is paid and offering "no" after the wallet has begun setting coins aside. */
    expect(document.querySelector('[data-reading-the-chain]')).toBeNull();
    expect(document.querySelector('[data-paying]')).not.toBeNull();
    expect((screen.getByText('Do not pay') as HTMLButtonElement).disabled).toBe(true);
    held.release();
    await screen.findByText(`You paid for a deposit for ${ORIGIN}`);
  });

  it('A PERSON WHO LEAVES OR PICKS ANOTHER WALLET WHILE IT READS IS NOT PAID FOR FROM THE FIRST', async () => {
    for (const how of ['leaves', 'switches'] as const) {
      const log: string[] = []; const answers: unknown[] = [];
      const shielded = stillReading();
      const doors = doorsWith(log, { shielded });
      const view = render(
        <ApproveBalance
          request={ask} identity={identity} account={0} channel={channelFor(answers)} consent={consented}
          whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => {}}
          doorsFor={doors} now={() => NOW} />);
      expect(await screen.findByText(`2500 base units of the private token below`)).toBeTruthy();
      fireEvent.click(screen.getByText('Pay into the vault'));
      await screen.findByText(/Your wallet is reading the network/);
      if (how === 'leaves') view.unmount();
      else {
        view.rerender(
          <ApproveBalance
            request={ask} identity={identity} account={2} channel={channelFor(answers)} consent={consented}
            whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => {}}
            doorsFor={doors} now={() => NOW} />);
      }
      shielded.says(true, true);
      await settled(20);
      /* RED WHEN: the wallet the person pressed with goes on to set coins aside after they left or chose another. */
      expect(log, how).toEqual([]);
      if (how === 'switches') {
        /* RED WHEN: the abandoned press answers the page, or overwrites the screen of the wallet now chosen. */
        expect(answers).toEqual([]);
        expect((screen.getByText('Pay into the vault') as HTMLButtonElement).disabled).toBe(false);
      }
      cleanup();
    }
  });

  it('A WALLET THAT CANNOT REACH THE CHAIN PAYS NOTHING, SAYS WHY, AND THE PAGE IS TOLD WHICH', async () => {
    const log: string[] = []; const answers: unknown[] = [];
    const shielded = stillReading();
    renderWith(doorsWith(log, { shielded }), answers);
    expect(await screen.findByText(`2500 base units of the private token below`)).toBeTruthy();
    fireEvent.click(screen.getByText('Pay into the vault'));
    await screen.findByText(/Your wallet is reading the network/);
    shielded.breaks(new Error('socket closed'));
    /* RED WHEN: a wallet that lost the chain goes on to balance, hides why, or the page is told the person declined. */
    expect(await screen.findByText(/stopped reading the network before it had found your coins/)).toBeTruthy();
    expect(log).toEqual([]);
    expect(answers).toEqual([{ refused: 'failed', why: 'chain-unreadable' }]);
    expect((screen.getByText('Pay into the vault') as HTMLButtonElement).disabled).toBe(true);
  });

  it('A TRANSACTION INTO ANOTHER CONTRACT IS REFUSED ON SIGHT, AND THE BUTTON STAYS DOWN', async () => {
    const log: string[] = []; const answers: unknown[] = [];
    renderWith(doorsWith(log, {}, [{ address: CO, entryPoint: 'deposit' }]), answers);
    expect(await screen.findByText(/calls a contract other than the vault it names/)).toBeTruthy();
    const button = screen.getByText('Pay into the vault') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await settled(20);
    expect(log).toEqual([]);
    expect(answers).toEqual([]);
  });

  it('a press the framing refuses does nothing, and declining is its own button', async () => {
    const log: string[] = []; const answers: unknown[] = []; const declined: string[] = [];
    renderWith(doorsWith(log), answers, { ok: false, says: 'the wallet is shown too small' } as never, declined);
    await screen.findByText(/2500 base units/);
    expect((screen.getByText('Pay into the vault') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Do not pay'));
    expect(declined).toEqual(['declined']);
    expect(log).toEqual([]);
  });
});

describe('THE APPROVAL SURFACE ROUTES A BALANCE ASK TO THIS SCREEN', () => {
  let port: ReturnType<typeof watchedStore>;
  beforeEach(() => { port = watchedStore(); });

  it('and bytes that are not a proven transaction are refused there, with nothing sent', async () => {
    const opener = watchedOpener();
    const handlers: ((event: MessageEvent) => void)[] = [];
    const view: ChannelWindow = {
      opener: opener as ChannelWindow['opener'],
      addEventListener: (_t, h) => { handlers.push(h); },
      removeEventListener: () => {},
    };
    render(<Approve identity={identity} secret={SECRET} port={port} view={view} now={() => NOW} />);
    for (const h of handlers) h({ source: opener, origin: ORIGIN, data: wire() } as unknown as MessageEvent);
    expect(await screen.findByText(`Pay into a company vault for ${ORIGIN}`)).toBeTruthy();
    expect(await screen.findByText(/not a proven transaction this wallet can read/)).toBeTruthy();
    expect((screen.getByText('Pay into the vault') as HTMLButtonElement).disabled).toBe(true);
    await settled(20);
    expect(opener.sent.filter((m) => (m.message as { schema?: string }).schema === 'midnight-identity/balanced/v1')).toEqual([]);
    void afterTheAnswer;
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { LabelReader } from './company-on-chain.js';
import { cleanup, fireEvent, render, screen } from '../testing/render.js';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, secretFromWords } from 'midnight-identity/keys/derivation';
import { parseAsk } from 'midnight-identity/profile/request';
import type { BalanceRequest } from 'midnight-identity/profile/request';
import type { Channel, ChannelWindow } from 'midnight-identity/profile/channel';
import type { BalancedAnswer } from 'midnight-identity/profile/balance';
import { watchedStore } from '../testing/settled-store.js';
import { afterTheAnswer, settled, watchedOpener } from '../testing/settled-channel.js';
import { recordingChannel } from '../testing/recording-channel.js';
import { readAskRecord } from '../lib/ask-record.js';
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
/* The company's label, and the account that carries it on the chain. */
const CO = 'co_1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071' as CompanyLabel;
const ACCOUNT = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
/* The chain, as this wallet reads it: the account carries the company's label. */
/* Answers for the request's own account only: RED WHEN the screen reads any other address, such as the vault's. */
const carries: LabelReader = async (account) => (account === ACCOUNT ? { of: 'carries', label: CO } : { of: 'no-account' });
const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
const TOKEN = 'ab'.repeat(32);

const wire = (over: Record<string, unknown> = {}) => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'balance',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'Put money into your company vault.',
  nonce: 'b1',
  expiresAt: NOW + 600_000,
  company: CO, account: ACCOUNT,
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
    says: (isConnected: boolean, complete: boolean, applied?: bigint) => observer?.next({ progress: {
      isConnected, isStrictlyComplete: () => complete, ...(applied === undefined ? {} : { appliedIndex: applied, highestIndex: 9_000n }),
    } }),
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
const channelFor = (answers: unknown[]): Channel => recordingChannel(answers);
const consented = { ok: true } as never;
const renderWith = (
  doors: () => BalanceDoors, answers: unknown[], consent = consented, declined: string[] = [], readLabel: LabelReader = carries,
) => render(
  <ApproveBalance readLabel={readLabel}
    request={ask} identity={identity} account={0} channel={channelFor(answers)} consent={consent}
    whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={(why) => declined.push(why ?? 'declined')}
    doorsFor={doors} now={() => NOW} />);

afterEach(() => { cleanup(); });

describe('A PAGE ASKING THIS WALLET TO PAY FOR A DEPOSIT', () => {
  it('PAYS NOTHING UNTIL THE ACCOUNT IS READ AND CARRIES THE LABEL THE PAGE NAMES', async () => {
    /*
     * The fingerprint a person pays on must be the fingerprint of the company
     * the page names: its label, on an account that carries it. It says
     * nothing about the vault, which this wallet does not read.
     * RED WHEN: the press is open, or a fingerprint is shown, before the account is found to carry the label.
     */
    const other = 'co_2222222222222222222222222222222222222222222222222222222222222222' as CompanyLabel;
    for (const [reader, shown] of [
      [async () => ({ of: 'carries', label: other }), 'another-company'],
      [async () => ({ of: 'no-label' }), 'no-label'],
      [async () => ({ of: 'no-account' }), 'no-account'],
      [async () => ({ of: 'unreadable', why: 'offline.' }), 'unreadable'],
      [() => new Promise<never>(() => {}), 'checking'],
    ] as [LabelReader, string][]) {
      const log: string[] = []; const answers: unknown[] = [];
      const { container } = renderWith(doorsWith(log), answers, consented, [], reader);
      expect(await screen.findByText(`2500 base units of the private token below`)).toBeTruthy();
      await settled(5);
      expect(container.querySelector(`[data-company-check="${shown}"]`), shown).not.toBeNull();
      expect(container.querySelector('[data-company-fingerprint]'), shown).toBeNull();
      const button = screen.getByText('Pay into the vault') as HTMLButtonElement;
      expect(button.disabled, shown).toBe(true);
      fireEvent.click(button);
      await settled(5);
      expect(log, shown).toEqual([]);
      expect(answers, shown).toEqual([]);
      cleanup();
    }
  });

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
      schema: 'midnight-identity/balanced/v1', origin: ORIGIN, company: CO, account: ACCOUNT, vault: VAULT, nonce: 'b1', at: NOW,
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
        <ApproveBalance readLabel={carries}
          request={ask} identity={identity} account={0} channel={channelFor(answers)} consent={consented}
          whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => {}}
          doorsFor={doors} now={() => NOW} />);
      expect(await screen.findByText(`2500 base units of the private token below`)).toBeTruthy();
      fireEvent.click(screen.getByText('Pay into the vault'));
      await screen.findByText(/Your wallet is reading the network/);
      if (how === 'leaves') view.unmount();
      else {
        view.rerender(
          <ApproveBalance readLabel={carries}
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

  it('A TRANSACTION INTO ANOTHER CONTRACT IS REFUSED ON SIGHT, THE BUTTON STAYS DOWN, AND THE PAGE IS TOLD AT ONCE', async () => {
    const log: string[] = []; const answers: unknown[] = []; const closed: unknown[] = [];
    renderWith(doorsWith(log, {}, [{ address: ACCOUNT, entryPoint: 'deposit' }]), answers, consented, closed as string[]);
    expect(await screen.findByText(/calls a contract other than the vault it names/)).toBeTruthy();
    const button = screen.getByText('Pay into the vault') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await settled(20);
    expect(log).toEqual([]);
    /* RED WHEN: a refusal the wallet shows only to the person leaves the page waiting out its clock - the 28 Sep hang. */
    expect(answers).toEqual([{ refused: 'unreadable' }]);
    /* RED WHEN: the refused screen still offers "Do not pay", which tells the page the person declined something they were never asked. */
    expect(screen.queryByText('Do not pay')).toBeNull();
    fireEvent.click(screen.getByText('Close'));
    /* RED WHEN: Close is sent as a decline. */
    expect(closed).toEqual(['unreadable']);
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

/** Doors the test can tell apart, stop, and watch proofs through. */
const trackedDoors = (log: string[], facade: Partial<FacadeForBalancing> = {}, extra: Partial<BalanceDoors> = {}) => {
  const stopped: number[] = [];
  const proofs = new Set<(e: { op: 'prove' | 'check'; at: 'start' | 'end' }) => void>();
  const make = doorsWith(log, facade);
  const doors = (): BalanceDoors => ({
    ...make(),
    watchProofs: (w) => { proofs.add(w); return () => { proofs.delete(w); }; },
    stop: async () => { stopped.push(1); },
    ...extra,
  });
  return {
    doors, stopped,
    proof: (at: 'start' | 'end') => { for (const w of proofs) w({ op: 'prove', at }); },
    get watching() { return proofs.size; },
  };
};
/** A signature the test lets finish when it chooses: the coins are booked while it waits. */
const heldSign = (log: string[]) => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  return { signRecipe: async () => { await held; log.push('sign'); return 'signed'; }, release: () => release() };
};

describe('ONE ANSWER PER REQUEST, AND A PRESS IN FLIGHT OWNS IT', () => {
  it('while a press runs no second press starts, not even with another wallet, and the one press answers once', async () => {
    const answers: unknown[] = []; const channel = recordingChannel(answers);
    const first: string[] = []; const second: string[] = [];
    const locks: boolean[] = [];
    const hold = heldSign(first);
    const a = trackedDoors(first, { signRecipe: hold.signRecipe as never });
    const b = trackedDoors(second);
    const byAccount = (_i: unknown, account: number) => (account === 0 ? a.doors() : b.doors());
    const ui = (account: number) => (
      <ApproveBalance readLabel={carries}
        request={ask} identity={identity} account={account} channel={channel} consent={consented}
        whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => {}}
        doorsFor={byAccount as never} now={() => NOW} onBusy={(locked) => locks.push(locked)} />);
    const view = render(ui(0));
    expect(await screen.findByText(/2500 base units/)).toBeTruthy();
    expect(locks.at(-1)).toBe(false);
    fireEvent.click(screen.getByText('Pay into the vault'));
    await settled(20);
    expect(first).toEqual(['balance']);
    /* RED WHEN: the wallet that pays can still be changed while its press runs. */
    expect(locks.at(-1)).toBe(true);
    /* RED WHEN: Pay is offered again while a press runs, or "no" once coins are set aside. */
    expect((screen.getByText('Pay into the vault') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Do not pay') as HTMLButtonElement).disabled).toBe(true);
    /* The screen is handed another wallet anyway, and Pay is pressed on it. */
    view.rerender(ui(2));
    expect(await screen.findByText(/2500 base units/)).toBeTruthy();
    /* RED WHEN: "no" is offered on another wallet's screen while the first wallet's coins are set aside, and does nothing. */
    expect((screen.getByText('Do not pay') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Pay into the vault'));
    await settled(20);
    /* RED WHEN: a second press starts while the first is still running, and the two race to the page. */
    expect(second).toEqual([]);
    hold.release();
    await screen.findByText(`You paid for a deposit for ${ORIGIN}`);
    await settled(20);
    expect(first).toEqual(['balance', 'sign', 'finish']);
    /* RED WHEN: the page is handed a second transaction, or told the paid one failed. */
    expect(answers).toHaveLength(1);
    expect(second).toEqual([]);
    /* RED WHEN: the wallet can be changed after the page has its answer. */
    expect(locks.at(-1)).toBe(true);
  });

  it('a wallet on screen that cannot read the request while another press is running sends nothing: that press answers', async () => {
    const answers: unknown[] = []; const channel = recordingChannel(answers);
    const first: string[] = [];
    const hold = heldSign(first);
    const a = trackedDoors(first, { signRecipe: hold.signRecipe as never });
    const broken = trackedDoors([], {}, { ledger: () => Promise.reject(new Error('no ledger')) });
    const byAccount = (_i: unknown, account: number) => (account === 0 ? a.doors() : broken.doors());
    const ui = (account: number) => (
      <ApproveBalance readLabel={carries}
        request={ask} identity={identity} account={account} channel={channel} consent={consented}
        whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => {}}
        doorsFor={byAccount as never} now={() => NOW} />);
    const view = render(ui(0));
    expect(await screen.findByText(/2500 base units/)).toBeTruthy();
    fireEvent.click(screen.getByText('Pay into the vault'));
    await settled(20);
    view.rerender(ui(2));
    expect(await screen.findByText(/could not load what it reads a transaction with/)).toBeTruthy();
    /* RED WHEN: the refusal races the press that is still running, and the page is told nothing was paid before it is handed a paid transaction. */
    expect(answers).toEqual([]);
    hold.release();
    await settled(20);
    expect(answers).toHaveLength(1);
    expect((answers[0] as BalancedAnswer).schema).toBe('midnight-identity/balanced/v1');
  });

  it('a press whose screen went while it set coins aside still answers, and its wallet stops only after it has', async () => {
    const answers: unknown[] = []; const log: string[] = [];
    const hold = heldSign(log);
    const a = trackedDoors(log, { signRecipe: hold.signRecipe as never });
    const view = render(
      <ApproveBalance readLabel={carries}
        request={ask} identity={identity} account={0} channel={recordingChannel(answers)} consent={consented}
        whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => {}}
        doorsFor={a.doors} now={() => NOW} />);
    expect(await screen.findByText(/2500 base units/)).toBeTruthy();
    fireEvent.click(screen.getByText('Pay into the vault'));
    await settled(20);
    view.unmount();
    await settled(5);
    /* RED WHEN: the wallet's parts are stopped under a press that has set coins aside, cutting off a payment the person approved. */
    expect(a.stopped).toEqual([]);
    hold.release();
    await settled(20);
    expect(answers).toHaveLength(1);
    /* RED WHEN: the parts of a wallet whose screen has gone are left running once its press is over. */
    expect(a.stopped).toEqual([1]);
  });

  it('the wallet\'s parts stop when their screen goes with nothing pressed, and when another wallet is picked', async () => {
    const a = trackedDoors([]); const b = trackedDoors([]);
    const byAccount = (_i: unknown, account: number) => (account === 0 ? a.doors() : b.doors());
    const ui = (account: number) => (
      <ApproveBalance readLabel={carries}
        request={ask} identity={identity} account={account} channel={recordingChannel([])} consent={consented}
        whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => {}}
        doorsFor={byAccount as never} now={() => NOW} />);
    const view = render(ui(0));
    expect(await screen.findByText(/2500 base units/)).toBeTruthy();
    view.rerender(ui(2));
    await settled(5);
    /* RED WHEN: a wallet's facade, its DUST read included, runs on after the person picked another. */
    expect(a.stopped).toEqual([1]);
    view.unmount();
    await settled(5);
    /* RED WHEN: the Pay facade is never stopped, and runs until the frame goes. */
    expect(b.stopped).toEqual([1]);
  });
});

describe('THE WALLET SAYS WHAT IT IS DOING, ON EVENTS ONLY', () => {
  it('reading on each report that moved, proving from the moment coins are added and on each proof', async () => {
    const answers: unknown[] = []; const progress: string[] = [];
    const shielded = stillReading();
    const held = heldBalance();
    let clock = NOW;
    const t = trackedDoors([], { shielded, balanceUnboundTransaction: held.balanceUnboundTransaction as never });
    render(
      <ApproveBalance readLabel={carries}
        request={ask} identity={identity} account={0} channel={recordingChannel(answers, progress as never)} consent={consented}
        whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => {}}
        doorsFor={t.doors} now={() => clock} />);
    expect(await screen.findByText(/2500 base units/)).toBeTruthy();
    fireEvent.click(screen.getByText('Pay into the vault'));
    await screen.findByText(/Your wallet is reading the network/);
    shielded.says(false, false);
    clock += 400;
    shielded.says(true, false);
    clock += 2_000;
    shielded.says(true, false, 200n);
    /* RED WHEN: the read's reports are not passed on, so a long read reaches the page as silence; or each is sent without limit. */
    expect(progress).toEqual(['reading', 'reading']);
    clock += 2_000;
    shielded.says(true, false, 200n);
    /* RED WHEN: a report that says nothing new is passed on as if the wallet had moved. */
    expect(progress).toEqual(['reading', 'reading']);
    /* The read finishes: that is movement too. */
    shielded.says(true, true);
    await settled(10);
    /* RED WHEN: nothing is said between the read and the proof, which is the longest silence of a private deposit. */
    expect(progress).toEqual(['reading', 'reading', 'reading', 'proving']);
    clock += 5_000;
    t.proof('start');
    clock += 90_000;
    t.proof('end');
    /* RED WHEN: a proof starting and ending is not said, so a wallet proving for ninety seconds looks like one that has gone. */
    expect(progress).toEqual(['reading', 'reading', 'reading', 'proving', 'proving', 'proving']);
    expect(t.watching).toBe(1);
    held.release();
    await screen.findByText(`You paid for a deposit for ${ORIGIN}`);
    /* RED WHEN: the screen keeps listening to the proofs after its press is over. */
    expect(t.watching).toBe(0);
    t.proof('end');
    expect(progress).toHaveLength(6);
  });
});

describe('THE WALLET NEVER SAYS IT IS AT WORK BECAUSE A CLOCK TICKED', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('a minute of silence on the network, and between proofs, sends the page nothing', async () => {
    /* Every clock this screen could start is one the test moves by hand; the page's own reads still run. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'], shouldAdvanceTime: true });
    const answers: unknown[] = []; const progress: string[] = [];
    const shielded = stillReading();
    const held = heldBalance();
    let clock = NOW;
    const t = trackedDoors([], { shielded, balanceUnboundTransaction: held.balanceUnboundTransaction as never });
    render(
      <ApproveBalance readLabel={carries}
        request={ask} identity={identity} account={0} channel={recordingChannel(answers, progress as never)} consent={consented}
        whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => {}}
        doorsFor={t.doors} now={() => clock} />);
    expect(await screen.findByText(/2500 base units/)).toBeTruthy();
    fireEvent.click(screen.getByText('Pay into the vault'));
    await screen.findByText(/Your wallet is reading the network/);
    shielded.says(true, false, 100n);
    const afterAReport = [...progress];
    clock += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    /* RED WHEN: anything in the wallet says "reading" on a timer, so a read that has stopped looks alive to the page. */
    expect(progress).toEqual(afterAReport);
    shielded.says(true, true);
    await settled(10);
    t.proof('start');
    const afterAProof = [...progress];
    clock += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    /* RED WHEN: anything says "proving" on a timer, so a proof that has died looks alive to the page. */
    expect(progress).toEqual(afterAProof);
    held.release();
    await vi.advanceTimersByTimeAsync(10);
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
    render(<Approve readLabel={carries} identity={identity} secret={SECRET} port={port} view={view} now={() => NOW} />);
    for (const h of handlers) h({ source: opener, origin: ORIGIN, data: wire() } as unknown as MessageEvent);
    expect(await screen.findByText(`Pay into a company vault for ${ORIGIN}`)).toBeTruthy();
    expect(await screen.findByText(/not a proven transaction this wallet can read/)).toBeTruthy();
    expect((screen.getByText('Pay into the vault') as HTMLButtonElement).disabled).toBe(true);
    await settled(20);
    expect(opener.sent.filter((m) => (m.message as { schema?: string }).schema === 'midnight-identity/balanced/v1')).toEqual([]);
    /* RED WHEN: the page that sent them is left waiting for a press that cannot come, rather than told at once. */
    expect(opener.sent.filter((m) => (m.message as { schema?: string }).schema === 'midnight-identity/disclosure-refused/v1'))
      .toEqual([{ message: { schema: 'midnight-identity/disclosure-refused/v1', reason: 'unreadable' }, target: ORIGIN }]);
    /* RED WHEN: the wallet keeps no record of what it showed and sent for a request to pay, so the next wait that never ends cannot be told apart. */
    expect(readAskRecord(port).map((l) => `${l.what} ${l.detail}`)).toEqual(expect.arrayContaining([
      'asked balance', 'shown refused', 'sent refused:unreadable',
    ]));
    void afterTheAnswer;
  });
});

// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://identity.payroll.example/"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '../testing/render.js';
import { IDBFactory } from 'fake-indexeddb';

/*
 * **AN ACTION RUNS WHOLE IN ONE WINDOW, ON ONE PASSKEY.** The whole wallet is mounted - session, routes, the locked
 * window, the runner - over real storage, in a window opened by a page that re-sends its ask whenever the wallet says
 * it is listening and answers each transaction the wallet hands it as the test tells it to. Only the browser's passkey
 * and its verification are stood in for, and the action is one of three steps defined here, each handing over one
 * transaction: it stands in for the actions later added to the list, and runs through exactly the same runner.
 */

vi.hoisted(() => { process.env['VITE_APP_ORIGIN'] = 'https://app.payroll.example'; });

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

vi.mock('midnight-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity')>();
  return { ...actual, verifyRegistration: vi.fn(), verifyAssertion: vi.fn() };
});

vi.mock('midnight-identity/profile/act-intents', () => ({
  ACT_INTENTS: Object.freeze({ 'three-transfers': { fields: { vault: 'vault' } } }),
}));

/* What the second step waits on before it builds, so a press can land between two steps. */
const gate = vi.hoisted(() => ({ open: (): void => {}, wait: Promise.resolve() as Promise<void>, built: [] as number[] }));

vi.mock('./registry.js', () => {
  const step = (n: number) => ({
    title: { key: 'ask.balance.vault', values: { vault: `step ${n}` } },
    run: async (c: { relay(tx: string): Promise<void>; signal: AbortSignal }) => {
      if (n === 2) await gate.wait;
      if (c.signal.aborted) throw new Error('stopped before it was built');
      gate.built.push(n);
      await c.relay(`dHg${n}`);
    },
  });
  const action = {
    headline: 'ask.act.headline',
    shown: async (intent: { fields: Record<string, string> }) => [
      { key: 'ask.balance.vault', values: { vault: intent.fields['vault'] ?? '' }, from: 'page' },
      { key: 'ask.committee.check', from: 'action' },
    ],
    checks: [{ key: 'ask.committee.check' }],
    check: async () => null,
    steps: () => [step(1), step(2), step(3)],
  };
  return { ACTIONS: { 'three-transfers': action }, actionFor: (name: string) => (name === 'three-transfers' ? action : null) };
});

import { Buffer as PolyfillBuffer } from 'buffer/';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import { usePasskey } from 'midnight-identity/browser';
import { verifyAssertion } from 'midnight-identity';
import type { Passkey } from 'midnight-identity/passkey/verify';
import { newSecret } from 'midnight-identity/keys/derivation';
import {
  ACT_ENDED_SCHEMA, ACT_RELAYED_SCHEMA, ACT_RELAY_SCHEMA, ACT_STOPS, PROGRESS_SCHEMA, READY_PING,
} from 'midnight-identity/profile/channel';
import en from '../locales/en.json';
import { App } from '../app.js';
import { SessionProvider, useSession } from '../session.js';
import { forgetApprovalBeforeThePasskey } from '../framing.js';
import { forgetOpenWallet } from '../accounts/wallets-held.js';
import { savePasskey, saveSecret, saveWalletName } from '../accounts/storage.js';
import { forgetTheEnd } from './ended-here.js';
import { ActOver } from '../screens/ask-over.js';

const ASKER = 'https://app.payroll.example';
const VAULT = 'c'.repeat(64);
const mockUsePasskey = vi.mocked(usePasskey);
const mockVerifyAssertion = vi.mocked(verifyAssertion);

const passkeyFixture = (credentialId: string): Passkey => ({
  credentialId, personHandle: 'person-1', publicKeySpki: new Uint8Array([1, 2, 3]), algorithm: -7, signCount: 0,
  provenBySignIn: false, rpId: 'localhost', syncsToACloud: false, backedUpNow: false, transports: [],
});
const passkeyAnswers = (credentialId: string): void => {
  mockUsePasskey.mockResolvedValueOnce({
    credentialId, clientDataJSON: new Uint8Array(), authenticatorData: new Uint8Array(), signature: new Uint8Array(),
    userHandle: 'cGVyc29uLTE',
  } as never);
  mockVerifyAssertion.mockResolvedValueOnce({ passkey: passkeyFixture(credentialId) } as never);
};
const putWallet = async (): Promise<void> => {
  const secret = newSecret();
  const id = await saveSecret(secret);
  saveWalletName(secret, 'Everyday');
  savePasskey(passkeyFixture('cred-a'), id);
};

let asked = 0;
const actAsk = (): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'act',
  requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'To move money between your vaults.',
  nonce: `act-${(asked += 1)}`,
  expiresAt: Date.now() + 20 * 60_000,
  progress: PROGRESS_SCHEMA,
  intent: { name: 'three-transfers', vault: VAULT },
});

/* The page that opened this window. `answer` says what it does with each transaction: send it, refuse it, or hold. */
let posted: Record<string, unknown>[] = [];
let asking: Record<string, unknown> | null = null;
let answer: (n: number) => 'relayed' | 'refused' | 'hold' = () => 'relayed';
const held: Array<() => void> = [];
const send = (data: unknown): void => {
  const event = new Event('message');
  Object.defineProperties(event, { data: { value: data }, origin: { value: ASKER }, source: { value: page } });
  window.dispatchEvent(event);
};
const page = {
  postMessage: (message: unknown) => {
    const m = message as Record<string, unknown>;
    posted.push(m);
    if (m['schema'] === READY_PING && asking !== null) {
      const sending = asking;
      setTimeout(() => send(sending), 0);
    }
    if (m['schema'] === ACT_RELAY_SCHEMA) {
      const n = m['n'] as number;
      const reply = (outcome: 'relayed' | 'refused') => send({ schema: ACT_RELAYED_SCHEMA, nonce: m['nonce'], n, outcome });
      const doing = answer(n);
      if (doing === 'hold') held.push(() => reply('relayed'));
      else setTimeout(() => reply(doing), 0);
    }
  },
};
const of = (schema: string) => posted.filter((m) => m['schema'] === schema);

let phaseNow = '';
function Phase(): null {
  phaseNow = useSession().phase.name;
  return null;
}

const runFromTheWindow = async (): Promise<void> => {
  asking = actAsk();
  render(<SessionProvider><App /><Phase /></SessionProvider>);
  await waitFor(() => expect(document.querySelector('[data-ask-window="act"]')).not.toBeNull());
  await waitFor(() => expect(document.querySelector('[data-act-shown]')).not.toBeNull());
  passkeyAnswers('cred-a');
  fireEvent.click(document.querySelector('[data-approve-window]') as HTMLElement);
};

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  mockUsePasskey.mockReset();
  mockVerifyAssertion.mockReset();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
  forgetApprovalBeforeThePasskey();
  forgetTheEnd();
  posted = [];
  asking = null;
  answer = () => 'relayed';
  held.length = 0;
  gate.built = [];
  gate.wait = Promise.resolve();
  window.location.hash = '#/approve';
  Object.defineProperty(window, 'opener', { configurable: true, value: page });
  await putWallet();
});

describe('an action runs whole in one window, on one passkey', () => {
  it('the window shows what the action does before the passkey, marking the page\'s own words', async () => {
    asking = actAsk();
    render(<SessionProvider><App /></SessionProvider>);
    await waitFor(() => expect(document.querySelector('[data-act-shown]')).not.toBeNull());
    /* RED WHEN: a line only the page says is shown as if this wallet had read it. */
    expect(document.querySelector('[data-shown-from="page"]')?.textContent).toContain('Only the page says this');
    expect(document.querySelector('[data-shown-from="page"]')?.textContent).toContain(VAULT);
    /* RED WHEN: the action's own account of what it does or checks is marked as the page's words or as something this wallet read. */
    const own = document.querySelector('[data-shown-from="action"]')?.textContent ?? '';
    expect(own).not.toBe('');
    expect(own).not.toContain('Only the page says this');
    expect(own).not.toContain('This wallet read this itself');
    /* RED WHEN: the steps or what is checked after the passkey are not listed before Approve. */
    expect(document.querySelectorAll('[data-act-steps] li')).toHaveLength(3);
    expect(document.querySelector('[data-checked-after-the-passkey]')).not.toBeNull();
    expect(mockUsePasskey).not.toHaveBeenCalled();
  });

  it('three steps hand the page three transactions, with each step said, through one window and one passkey', async () => {
    await runFromTheWindow();
    await waitFor(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    /* RED WHEN: the action asks for a passkey per step, or a second press, rather than running on the one Approve. */
    expect(mockUsePasskey).toHaveBeenCalledTimes(1);
    /* RED WHEN: the transactions are not handed over one each, in order, numbered for the page to answer. */
    expect(of(ACT_RELAY_SCHEMA).map((m) => [m['n'], m['step'], m['steps'], m['transaction']])).toEqual([
      [1, 1, 3, 'dHg1'], [2, 2, 3, 'dHg2'], [3, 3, 3, 'dHg3'],
    ]);
    /* RED WHEN: the page is not told which step is running, so it cannot show progress or keep waiting. */
    expect(of(PROGRESS_SCHEMA).map((m) => m['step'])).toEqual([1, 2, 3]);
    expect(of(ACT_ENDED_SCHEMA)[0]).toMatchObject({ ended: 'done', step: 3, steps: 3, relayed: 3, intent: 'three-transfers' });
  });

  it('the opened wallet is locked again when the action ends, and the window says how it ended', async () => {
    await runFromTheWindow();
    await waitFor(() => expect(phaseNow).toBe('unlocked'));
    await waitFor(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    /* RED WHEN: the seed the passkey opened is still held once the action has ended. */
    await waitFor(() => expect(phaseNow).toBe('locked'));
    /* RED WHEN: the locked window forgets the action, and shows the unlock screen or a waiting line instead. */
    await waitFor(() => expect(document.querySelector('[data-act-ended="done"]')).not.toBeNull());
  });

  it('Stop between two steps leaves "step 2 of 3", and nothing more is handed to the page', async () => {
    answer = (n) => (n === 1 ? 'hold' : 'relayed');
    await runFromTheWindow();
    await waitFor(() => expect(of(ACT_RELAY_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    await waitFor(() => expect(document.querySelector('[data-act-stop]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-act-stop]') as HTMLElement);
    /* The page now says what it did with the first transaction: it was handed over before Stop. */
    held.shift()!();
    await waitFor(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    /* RED WHEN: Stop does not stop, or the step after it starts and hands the page another transaction. */
    expect(of(ACT_RELAY_SCHEMA)).toHaveLength(1);
    expect(gate.built).toEqual([1]);
    /* RED WHEN: the page is not told where the action stopped, or the transaction already handed over is not counted. */
    expect(of(ACT_ENDED_SCHEMA)[0]).toMatchObject({ ended: 'stopped', why: 'stopped', step: 2, steps: 3, relayed: 1 });
    await waitFor(() => expect(phaseNow).toBe('locked'));
    await waitFor(() => expect(document.querySelector('[data-act-ended="stopped"]')).not.toBeNull());
    /* RED WHEN: the stopped screen does not say how many transactions had already gone. */
    expect(document.querySelector('[data-act-relayed]')?.textContent).toContain('1');
    expect(document.querySelector('[data-ask-over]')?.textContent).toContain('Stopped at step 2 of 3');
  });

  it('a transaction the page refuses stops the action at that step, and nothing more is handed over', async () => {
    answer = (n) => (n === 2 ? 'refused' : 'relayed');
    await runFromTheWindow();
    await waitFor(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    /* RED WHEN: a refused relay is taken as sent, and the next step is built on it. */
    expect(of(ACT_RELAY_SCHEMA).map((m) => m['n'])).toEqual([1, 2]);
    expect(gate.built).toEqual([1, 2]);
    expect(of(ACT_ENDED_SCHEMA)[0]).toMatchObject({ ended: 'stopped', why: 'relay-refused', step: 2, steps: 3, relayed: 1, unconfirmed: 1 });
    await waitFor(() => expect(phaseNow).toBe('locked'));
    await waitFor(() => expect(document.querySelector('[data-act-ended="stopped"]')).not.toBeNull());
    /* RED WHEN: the window says, as its own fact, that the page did not send what it refused. */
    expect(document.body.textContent).toContain('The page says it did not send');
    /* RED WHEN: the transaction the page was handed and did not confirm is not said, or not with what to do. */
    expect(document.querySelector('[data-act-unconfirmed]')?.textContent).toContain('The page did not confirm sending one transaction');
    expect(document.querySelector('[data-act-unconfirmed]')?.textContent).toContain('Wait a few minutes before you do anything more on the page');
  });

  it('an action that ended with a step still running never says its keys and work are over', () => {
    const end = {
      ended: { schema: ACT_ENDED_SCHEMA, nonce: 'n', intent: 'three-transfers', ended: 'stopped', step: 1, steps: 3, relayed: 0, unconfirmed: 0, why: 'out-of-time' },
      says: null, abandoned: true,
    } as const;
    render(<ActOver end={end} framed={false} />);
    /* RED WHEN: a step left running is described as if the keys it could reach were already gone and its work done. */
    expect(document.querySelector('[data-act-locked]')?.textContent).toContain('may still be finishing');
    expect(document.querySelector('[data-act-locked]')?.textContent).not.toContain('no longer held here');
  });
});

describe('the stopped window says truly what had left the wallet, and what pressing again does', () => {
  const words = en as Record<string, string>;
  const stopped = (intent: string, why: string, relayed: number, unconfirmed: number) => ({
    ended: { schema: ACT_ENDED_SCHEMA, nonce: 'n', intent, ended: 'stopped', step: 3, steps: 4, relayed, unconfirmed, why },
    says: { key: 'act.private-deposit.why.not-yet-seen' }, abandoned: false,
  }) as never;
  const title = (): string => document.querySelector('[data-slot="alert-title"]')?.textContent ?? '';

  it('has words for every way an action can stop', () => {
    for (const why of ACT_STOPS) {
      /* RED WHEN: a way an action can stop has no words, so the stopped window's title is the raw key. */
      expect(words[`act.why.${why}`], why).toBeTypeOf('string');
    }
  });

  it('never titles a refusal after a send as if nothing was built', () => {
    render(<ActOver end={stopped('private-deposit', 'check-failed', 1, 0)} framed={false} />);
    /* RED WHEN: a step that refused after the page handed over its transaction is titled as having built nothing. */
    expect(title()).not.toContain('built nothing');
    expect(title()).toBe(words['act.over.refused-sent']);
    cleanup();
    render(<ActOver end={stopped('private-deposit', 'check-failed', 0, 1)} framed={false} />);
    /* RED WHEN: a refusal after a transaction the page did not confirm is not titled as one that may still be sent. */
    expect(title()).toBe(words['act.over.refused-maybe-sent']);
    cleanup();
    render(<ActOver end={stopped('give-vault-keys', 'check-failed', 0, 0)} framed={false} />);
    /* RED WHEN: a refusal before anything was handed over is not titled as one. */
    expect(title()).toBe(words['act.why.check-failed']);
  });

  it('says per action what pressing again on the page does, and never that it carries on from the step it stopped at', () => {
    render(<ActOver end={stopped('private-deposit', 'out-of-time', 1, 0)} framed={false} />);
    /* RED WHEN: a stopped deposit invites pressing again as if that carried it on, when it makes a new deposit. */
    expect(document.querySelector('[data-act-continue]')?.textContent).toBe(words['act.private-deposit.over.continue']);
    cleanup();
    render(<ActOver end={stopped('create-vault', 'out-of-time', 1, 0)} framed={false} />);
    /* RED WHEN: a stopped vault creation does not say that Create vault starts a new vault. */
    expect(document.querySelector('[data-act-continue]')?.textContent).toBe(words['act.create-vault.over.continue']);
    cleanup();
    render(<ActOver end={stopped('finish-company', 'out-of-time', 1, 0)} framed={false} />);
    /* RED WHEN: the window says the action is taken up from the step it stopped at, when it always starts at the first. */
    expect(document.querySelector('[data-act-continue]')?.textContent).toBe(words['act.over.continue']);
    expect(document.querySelector('[data-act-continue]')?.textContent).not.toMatch(/from step/);
  });
  it('a stopped one-off payment says pressing again proposes a second payment', () => {
    render(<ActOver end={stopped('one-off-payment', 'out-of-time', 1, 0)} framed={false} />);
    /* RED WHEN: a stopped one-off invites pressing Pay again as if that carried this payment on, when it proposes another. */
    expect(document.querySelector('[data-act-continue]')?.textContent).toBe(words['act.one-off-payment.over.continue']);
  });

  it('a one-off payment that ends awaiting approvals is not told as done with every step run', () => {
    const ended = (outcome: Record<string, string | number>) => ({
      ended: { schema: ACT_ENDED_SCHEMA, nonce: 'n', intent: 'one-off-payment', ended: 'done', step: 6, steps: 6, relayed: 2, unconfirmed: 0, outcome },
      says: null, abandoned: false,
    }) as never;
    render(<ActOver end={ended({ state: 'awaiting-approvals', approvals: 1, needed: 2 })} framed={false} />);
    /* RED WHEN: a payment still short of its approvals ends titled Done, saying all its steps ran. */
    expect(document.querySelector('[data-ask-over]')?.textContent).toBe(words['act.one-off-payment.over.awaiting-title']);
    expect(document.querySelector('[data-act-awaiting]')?.textContent).toBe('Proposed. Not paid yet: the payment needs 2 approvals and has 1. Once the others approve, a signer carries it out.');
    expect(document.querySelector('[data-act-relayed]')).toBeNull();
    cleanup();
    render(<ActOver end={ended({ state: 'paid', approvals: 2, needed: 2 })} framed={false} />);
    /* RED WHEN: a payment carried out is not told as done. */
    expect(document.querySelector('[data-ask-over]')?.textContent).toBe(words['act.over.done-title']);
  });
});

describe('the running window lists a passed step that had nothing to do as not needed', () => {
  it('lists passed steps done, or not needed when the step says nothing was owed of it', async () => {
    const { stepStateOf } = await import('./runner-screen.js');
    const step = { title: { key: 'k' }, run: async () => {}, notNeeded: (told: Readonly<Record<string, string | number>>) => told['state'] === 'awaiting-approvals' };
    const at = (n: number, told?: Record<string, string | number>) => ({ step: n, steps: 6, relayed: 0, unconfirmed: 0, ...(told ? { told } : {}) });
    /* RED WHEN: a charge or payment the action never made, the payment awaiting approvals, is listed as done. */
    expect(stepStateOf(step, 4, at(6, { state: 'awaiting-approvals' }))).toBe('not-needed');
    /* RED WHEN: a step that ran is listed as not needed. */
    expect(stepStateOf(step, 4, at(6, { state: 'paid' }))).toBe('done');
    expect(stepStateOf({ title: { key: 'k' }, run: async () => {} }, 4, at(6))).toBe('done');
    expect(stepStateOf(step, 6, at(6))).toBe('running');
    expect(stepStateOf(step, 6, at(5))).toBe('waiting');
  });
});

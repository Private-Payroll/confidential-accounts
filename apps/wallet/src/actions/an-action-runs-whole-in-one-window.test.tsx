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
 * transaction: it stands in for the actions later added to the list, and runs through exactly the same runner. Three
 * more stand in for an action whose approval is about what only the seat's keys open: one reads it and asks for the
 * window's Confirm before it hands anything over, one fails its read, and one asks for the Confirm too late.
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

vi.mock('midnight-identity/profile/act-intents', async (importOriginal) => ({
  ...await importOriginal<typeof import('midnight-identity/profile/act-intents')>(),
  ACT_INTENTS: Object.freeze({
    'three-transfers': { fields: { vault: 'vault' } },
    /* The same action as one whose calls go through the page, so its act may name which way they go. */
    'three-transfers-sent': { fields: { vault: 'vault' }, calls: [{ method: 'POST', path: '/api/transfers', sends: true }] },
    'read-then-sign': { fields: { vault: 'vault' } },
    'read-fails': { fields: { vault: 'vault' } },
    'confirm-after-a-send': { fields: { vault: 'vault' } },
    'confirm-after-a-write': { fields: { vault: 'vault' }, calls: [{ method: 'PUT', path: '/api/notes/:note' }] },
    'confirms-twice': { fields: { vault: 'vault' } },
  }),
}));

/* What the second step waits on before it builds, so a press can land between two steps. */
const gate = vi.hoisted(() => ({ open: (): void => {}, wait: Promise.resolve() as Promise<void>, built: [] as number[] }));

vi.mock('./registry.js', async () => {
  const { StepRefused } = await import('./definition.js');
  const step = (n: number) => ({
    title: { key: 'ask.balance.vault', values: { vault: `step ${n}` } },
    run: async (c: { relay(tx: string): Promise<void>; signal: AbortSignal; show(w: unknown): void }) => {
      if (n === 2) await gate.wait;
      if (c.signal.aborted) throw new Error('stopped before it was built');
      gate.built.push(n);
      await c.relay(`dHg${n}`);
      if (n === 3) c.show({ key: 'act.join-by-code.over.fingerprint', values: { fingerprint: 'K7QM-2XRT-9VBN-4HCD-PW3S', address: 'an address' } });
    },
  });
  const action = {
    headline: 'ask.act.headline',
    shown: async (intent: { fields: Record<string, string> }) => [
      { key: 'ask.balance.vault', values: { vault: intent.fields['vault'] ?? '' }, from: 'page' },
      { key: 'ask.committee.check', from: 'action' },
    ],
    checks: [{ key: 'ask.committee.check' }],
    checksFor: (intent: { fields: Record<string, string> }) => [{ key: 'ask.balance.vault', values: { vault: `checked for ${intent.fields['vault'] ?? ''}` } }],
    check: async () => null,
    steps: () => [step(1), step(2), step(3)],
  };
  type Ctx = { relay(tx: string): Promise<void>; confirm(lines: readonly unknown[]): Promise<void>; call(m: string, p: string, b?: string): Promise<unknown> };
  const READ = [{ key: 'ask.balance.vault', values: { vault: 'read with the seat keys' } }];
  /* Reads with the seat's keys, asks for the Confirm, and only then hands its transaction over. */
  const reads = { title: { key: 'ask.balance.vault', values: { vault: 'read' } }, run: async (c: Ctx) => { gate.built.push(0); await c.confirm(READ); gate.built.push(1); await c.relay('dHg1'); } };
  const fails = { title: { key: 'ask.balance.vault', values: { vault: 'read' } }, run: async () => { throw new StepRefused({ key: 'ask.act.unread' }); } };
  const late = { title: { key: 'ask.balance.vault', values: { vault: 'read' } }, run: async (c: Ctx) => { await c.relay('dHg1'); await c.confirm(READ); gate.built.push(1); } };
  /* Writes to the service, sending nothing to the chain, and only then asks for the Confirm. */
  const wrote = { title: { key: 'ask.balance.vault', values: { vault: 'read' } }, run: async (c: Ctx) => { await c.call('PUT', '/api/notes/1', '{}'); await c.confirm(READ); gate.built.push(1); } };
  const twice = { title: { key: 'ask.balance.vault', values: { vault: 'read' } }, run: async (c: Ctx) => { await c.confirm(READ); gate.built.push(1); await c.confirm(READ); gate.built.push(2); } };
  const withSteps = (steps: readonly unknown[]) => ({ ...action, steps: () => steps });
  const acts: Record<string, unknown> = {
    'three-transfers': action, 'three-transfers-sent': action,
    'read-then-sign': withSteps([reads, step(2)]), 'read-fails': withSteps([fails, step(2)]), 'confirm-after-a-send': withSteps([late, step(2)]),
    'confirm-after-a-write': withSteps([wrote, step(2)]), 'confirms-twice': withSteps([twice, step(2)]),
  };
  return { ACTIONS: acts, actionFor: (name: string) => acts[name] ?? null };
});

import { Buffer as PolyfillBuffer } from 'buffer/';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import { usePasskey } from 'midnight-identity/browser';
import { verifyAssertion } from 'midnight-identity';
import type { Passkey } from 'midnight-identity/passkey/verify';
import { newSecret } from 'midnight-identity/keys/derivation';
import {
  ACT_CALLED_SCHEMA, ACT_CALL_SCHEMA, ACT_ENDED_SCHEMA, ACT_RELAYED_SCHEMA, ACT_RELAY_SCHEMA, ACT_STOPS, PROGRESS_SCHEMA, READY_PING,
} from 'midnight-identity/profile/channel';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { act } from '../testing/render.js';
import { Approve } from '../screens/approve.js';
import { watchedStore } from '../testing/settled-store.js';
import { settled } from '../testing/settled-channel.js';
import { DWELL_MS } from '../framing.js';
import { identityFromSecret } from 'midnight-identity/keys/derivation';
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
    if (m['schema'] === ACT_CALL_SCHEMA) {
      const sending = { schema: ACT_CALLED_SCHEMA, nonce: m['nonce'], n: m['n'], outcome: 'answered', status: 200, body: {} };
      setTimeout(() => send(sending), 0);
    }
  },
};
const of = (schema: string) => posted.filter((m) => m['schema'] === schema);

let phaseNow = '';
function Phase(): null {
  phaseNow = useSession().phase.name;
  return null;
}

const runFromTheWindow = async (name?: string): Promise<void> => {
  asking = name === undefined ? actAsk() : { ...actAsk(), intent: { name, vault: VAULT } };
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
    /* RED WHEN: the window lists an action's fixed checks where the ask it runs names checks of its own. */
    expect(document.querySelector('[data-checked-after-the-passkey]')?.textContent).toContain(`checked for ${VAULT}`);
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
    /* RED WHEN: what a done action gave its window to show, a fingerprint to read out, is not shown there. */
    expect(document.querySelector('[data-act-shown-at-the-end]')?.textContent).toContain('K7QM-2XRT-9VBN-4HCD-PW3S');
    /* RED WHEN: what a done action shows in its window is also sent to the page. */
    expect(JSON.stringify(posted)).not.toContain('K7QM');
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
    expect(document.querySelector('[data-act-unconfirmed]')?.textContent).toBe((en as Record<string, string>)['act.over.unconfirmed_one']);
    expect(document.querySelector('[data-act-unconfirmed]')?.textContent).toContain('Wait a few minutes before you do anything more on the page');
  });

  /*
   * RED WHEN: what a step read with the seat's keys is not shown in the window before anything is handed over; the
   * Confirm is a second passkey or a second unlock; or the step goes on, or hands anything over, before Confirm.
   */
  it('an action that reads what it approves shows it in the same window after the one passkey, and hands nothing over before Confirm', async () => {
    await runFromTheWindow('read-then-sign');
    await waitFor(() => expect(document.querySelector('[data-act-confirm]')).not.toBeNull(), { timeout: 5000 });
    expect(document.querySelector('[data-act-read]')?.textContent).toContain('read with the seat keys');
    expect(of(ACT_RELAY_SCHEMA)).toEqual([]);
    expect(gate.built).toEqual([0]);
    expect(phaseNow).toBe('unlocked');
    fireEvent.click(document.querySelector('[data-act-confirm-button]') as HTMLElement);
    await waitFor(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    expect(of(ACT_ENDED_SCHEMA)[0]).toMatchObject({ ended: 'done', step: 2, steps: 2, relayed: 2, intent: 'read-then-sign' });
    expect(of(ACT_RELAY_SCHEMA).map((m) => m['transaction'])).toEqual(['dHg1', 'dHg2']);
    /* RED WHEN: confirming asks for the passkey again. */
    expect(mockUsePasskey).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(phaseNow).toBe('locked'));
  });

  /* RED WHEN: Stop at the window's Confirm lets the step go on, or anything is handed to the page after it. */
  it('Stop at the Confirm signs nothing and hands nothing to the page', async () => {
    await runFromTheWindow('read-then-sign');
    await waitFor(() => expect(document.querySelector('[data-act-confirm]')).not.toBeNull(), { timeout: 5000 });
    fireEvent.click(document.querySelector('[data-act-stop]') as HTMLElement);
    await waitFor(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    expect(of(ACT_ENDED_SCHEMA)[0]).toMatchObject({ ended: 'stopped', why: 'stopped', step: 1, relayed: 0, unconfirmed: 0 });
    expect(of(ACT_RELAY_SCHEMA)).toEqual([]);
    expect(gate.built).toEqual([0]);
    expect(mockUsePasskey).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(phaseNow).toBe('locked'));
  });

  /* RED WHEN: a read that failed still asks for the Confirm, or anything is handed to the page after it. */
  it('a read that fails signs nothing, asks no Confirm, and says why', async () => {
    await runFromTheWindow('read-fails');
    await waitFor(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    expect(of(ACT_ENDED_SCHEMA)[0]).toMatchObject({ ended: 'stopped', why: 'check-failed', step: 1, relayed: 0 });
    expect(of(ACT_RELAY_SCHEMA)).toEqual([]);
    expect(document.querySelector('[data-act-confirm]')).toBeNull();
    await waitFor(() => expect(document.querySelector('[data-act-ended="stopped"]')).not.toBeNull());
    await waitFor(() => expect(phaseNow).toBe('locked'));
  });

  /* RED WHEN: a step can ask for the Confirm after it has handed something to the page, so the person confirms what has already gone. */
  it('a Confirm asked after anything was handed over stops the action, and nothing more is handed over', async () => {
    await runFromTheWindow('confirm-after-a-send');
    await waitFor(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    expect(of(ACT_ENDED_SCHEMA)[0]).toMatchObject({ ended: 'stopped', why: 'step-failed', step: 1, relayed: 1 });
    expect(of(ACT_RELAY_SCHEMA)).toHaveLength(1);
    expect(gate.built).toEqual([]);
    expect(document.querySelector('[data-act-confirm]')).toBeNull();
    await waitFor(() => expect(phaseNow).toBe('locked'));
  });

  /* RED WHEN: a step can write to the service, sending nothing to the chain, and still ask the person to confirm afterwards. */
  it('a Confirm asked after a write that sends nothing to the chain stops the action too', async () => {
    await runFromTheWindow('confirm-after-a-write');
    await waitFor(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    expect(of(ACT_CALL_SCHEMA).map((m) => [m['method'], m['path']])).toEqual([['PUT', '/api/notes/1']]);
    expect(of(ACT_ENDED_SCHEMA)[0]).toMatchObject({ ended: 'stopped', why: 'step-failed', step: 1 });
    expect(gate.built).toEqual([]);
    expect(document.querySelector('[data-act-confirm]')).toBeNull();
    await waitFor(() => expect(phaseNow).toBe('locked'));
  });

  /* RED WHEN: an action can ask the person to confirm twice, so a second question could follow what the first one showed. */
  it('a second Confirm in one action stops it', async () => {
    await runFromTheWindow('confirms-twice');
    await waitFor(() => expect(document.querySelector('[data-act-confirm-button]')).not.toBeNull(), { timeout: 5000 });
    fireEvent.click(document.querySelector('[data-act-confirm-button]') as HTMLElement);
    await waitFor(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    expect(of(ACT_ENDED_SCHEMA)[0]).toMatchObject({ ended: 'stopped', why: 'step-failed', step: 1, relayed: 0 });
    expect(gate.built).toEqual([1]);
    await waitFor(() => expect(phaseNow).toBe('locked'));
  });

  /*
   * RED WHEN: the Confirm stands where the running window's Stop stood, so a press meant for Stop confirms; focus lands
   * on a button, so a key pressed as the question appears answers it; the question does not say it is the same action
   * and a button, not another passkey; or a long address in what was read cannot wrap.
   */
  it('the Confirm window keeps Stop where it was, puts focus on its heading, and says Confirm is a button, not a passkey', async () => {
    await runFromTheWindow('read-then-sign');
    await waitFor(() => expect(document.querySelector('[data-act-confirm]')).not.toBeNull(), { timeout: 5000 });
    const bar = document.querySelector('[data-ask-actions]')!;
    expect(bar.querySelector('button')?.hasAttribute('data-act-stop')).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[data-act-confirm]'));
    expect(document.querySelector('[data-act-confirm-lede]')?.textContent).toMatch(/^Step 1 of 2 of the same action\..*not another passkey/u);
    expect(document.querySelector('[data-act-confirm-lede]')?.textContent).toContain('Nothing has been approved, signed or sent to the network yet');
    for (const li of document.querySelectorAll('[data-act-read] li')) expect(li.className).toContain('break-all');
    fireEvent.click(document.querySelector('[data-act-stop]') as HTMLElement);
    await waitFor(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    await waitFor(() => expect(phaseNow).toBe('locked'));
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

describe('the window before the passkey shows only what is being approved, never which way the calls go', () => {
  const shownFor = async (path?: string): Promise<string> => {
    asking = { ...actAsk(), intent: { name: 'three-transfers-sent', vault: VAULT, ...(path === undefined ? {} : { path }) } };
    render(<SessionProvider><App /></SessionProvider>);
    await waitFor(() => expect(document.querySelector('[data-act-shown]')).not.toBeNull());
    return document.querySelector('[data-act-shown]')?.textContent ?? '';
  };

  it('whatever way a page names, the lines the passkey approves are the same, and none of them is about the way', async () => {
    const plain = await shownFor();
    const words = en as Record<string, string>;
    for (const path of ['chain', 'service']) {
      cleanup();
      /* RED WHEN: a page naming a way in the act changes what the person approves, or asks them to choose it. */
      expect(await shownFor(path), path).toBe(plain);
    }
    /* RED WHEN: the window before the passkey speaks of a fallback no call has used yet. */
    for (const key of ['act.fell-back.chain', 'act.fell-back.own-dust', 'act.fell-back.chain-own-dust']) expect(plain).not.toContain(words[key]);
    expect(mockUsePasskey).not.toHaveBeenCalled();
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
  it('a stopped removal of a signer says pressing again finds the removal it raised, and raises nothing twice', () => {
    render(<ActOver end={stopped('remove-signer', 'out-of-time', 1, 0)} framed={false} />);
    /* RED WHEN: a stopped removal says pressing again starts from the first step, when it finds the removal already raised. */
    expect(document.querySelector('[data-act-continue]')?.textContent).toBe(words['act.remove-signer.over.continue']);
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

describe('a framed wallet\'s Confirm is held like its Approve, from the moment it appears', () => {
  const identity = identityFromSecret(newSecret());
  const SECRET = newSecret();
  const framedPage = () => {
    const handlers: Array<(e: MessageEvent) => void> = [];
    /* The page around the frame: it hands each transaction on and says so. */
    const parent = {
      postMessage: (message: unknown) => {
        const m = message as Record<string, unknown>;
        posted.push(m);
        if (m['schema'] === ACT_RELAY_SCHEMA) {
          const data = { schema: ACT_RELAYED_SCHEMA, nonce: m['nonce'], n: m['n'], outcome: 'relayed' };
          setTimeout(() => { for (const h of handlers) h({ source: parent, origin: ASKER, data } as unknown as MessageEvent); }, 0);
        }
      },
    };
    const view = {
      opener: null, parent, self: undefined as unknown, location: { ancestorOrigins: [ASKER] },
      addEventListener: (_t: 'message', h: (e: MessageEvent) => void) => { handlers.push(h); }, removeEventListener: () => {},
    };
    view.self = view;
    const ask = (data: unknown) => act(() => { for (const h of handlers) h({ source: parent, origin: ASKER, data } as unknown as MessageEvent); });
    return { view: view as unknown as ChannelWindow, ask };
  };
  const pause = (ms: number) => act(() => new Promise<void>((r) => { setTimeout(r, ms); }));
  const toTheConfirm = async (): Promise<HTMLButtonElement> => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 460 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });
    const { view, ask } = framedPage();
    render(<SessionProvider><Approve identity={identity} secret={SECRET} port={watchedStore()} view={view} now={() => Date.now()} embedder={ASKER} /></SessionProvider>);
    ask({ ...actAsk(), intent: { name: 'read-then-sign', vault: VAULT } });
    await settled();
    await pause(DWELL_MS + 100);
    fireEvent.click(document.querySelector('[data-approve]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-act-confirm-button]')).not.toBeNull(), { timeout: 5000 });
    return document.querySelector<HTMLButtonElement>('[data-act-confirm-button]')!;
  };

  /* RED WHEN: the Confirm can be pressed the moment it appears in a frame, before anybody could read what it confirms. */
  it('the Confirm is held for the wait, counted from when it appears, and then can be pressed', async () => {
    const confirm = await toTheConfirm();
    expect(confirm.disabled).toBe(true);
    expect(document.querySelector('[data-consent-refused]')?.textContent).toContain('only just appeared');
    await pause(DWELL_MS + 100);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(of(ACT_ENDED_SCHEMA)).toHaveLength(1), { timeout: 5000 });
    expect(of(ACT_ENDED_SCHEMA)[0]).toMatchObject({ ended: 'done' });
  });

  /* RED WHEN: a frame shrunk below what can be read still lets the Confirm be pressed. */
  it('a frame shrunk too small to read never lets the Confirm be pressed', async () => {
    const confirm = await toTheConfirm();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 40 });
    act(() => { window.dispatchEvent(new Event('resize')); });
    await pause(DWELL_MS + 100);
    expect(confirm.disabled).toBe(true);
    expect(document.querySelector('[data-consent-refused]')?.textContent).toContain('too small');
    expect(of(ACT_RELAY_SCHEMA)).toEqual([]);
  });
});

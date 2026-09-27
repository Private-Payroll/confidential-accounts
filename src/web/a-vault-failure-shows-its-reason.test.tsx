// @vitest-environment jsdom
/**
 * **WHEN A VAULT ACTION FAILS, THE VAULT'S SCREEN SAYS WHY, ALL THE WAY DOWN.**
 *
 * A failure inside the contract runtime arrives wrapped - "Error executing
 * circuit 'deposit'" - with the reason that matters kept only as its cause.
 * The screen used to show the wrapper and nothing else, and the worker that
 * builds vault transactions sent the page only the wrapper's text, so the
 * reason was lost twice before anybody could read it.
 *
 * §1 is the one line a failure is said in. §2 is the screen: the deposit
 * button is pressed and fails inside the vault's worker (the worker's own
 * handler, behind the page's own client, over a stand-in for the thread
 * between them that passes only what a real one can clone), and on the page
 * itself.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import * as ContractRuntimeError from '@midnight-ntwrk/compact-js/effect/ContractRuntimeError';
import type { Account } from '../core/types.js';
import type { Hex } from '../core/crypto.js';
import { whyItFailed } from './why-it-failed.js';

const INSIDE = "the stand-in circuit reached for something this worker does not have";

const page = vi.hoisted(() => ({ onPage: null as null | (() => never), recorded: [] as string[] }));

vi.mock('./keyring.js', () => ({
  api: async (path: string) => {
    if (path.endsWith('/vaults')) return { rows: [{ vault: '99'.repeat(32), deployedAt: '2026-09-01T00:00:00Z', state: 'held-by-committee', why: null }] };
    if (path.endsWith('/vault-keys')) return { committee: null, why: 'not every signer has given keys' };
    if (path.endsWith('/authority')) return { everySignerNeeded: null };
    return {};
  },
  currentUser: () => null,
  companyKeysForVaults: async () => ({ company: 'c0'.repeat(32), committeeKey: '44'.repeat(32), companyKey: '33'.repeat(32) }),
  payIntoAVaultFromTheWallet: async () => { throw new Error('the wallet is not asked in this test'); },
}));
vi.mock('./Auth.js', () => ({ WALLET_ORIGIN: '' }));
/* The report every shown failure is kept in, caught here instead of sent. */
vi.mock('./error-sink.js', () => ({ recordShownError: (message: string) => { page.recorded.push(message); } }));
vi.mock('../core/account.js', async (original) => ({
  ...(await original<typeof import('../core/account.js')>()),
  openAccount: () => ({}),
}));
vi.mock('../core/vault-keys.js', async (original) => ({
  ...(await original<typeof import('../core/vault-keys.js')>()),
  rosterVaultKeys: () => [],
}));
vi.mock('./vault-page-doors.js', async (original) => ({
  ...(await original<typeof import('./vault-page-doors.js')>()),
  vaultServiceFor: () => ({ chain: async () => ({}) }),
  giveVaultKeys: async () => {},
  rosterOf: () => ({ filers: [], signers: [] }),
  deviceSignerFrom: () => ({}),
  deviceRecordsFor: () => ({}),
  browserDepositsInFlight: () => ({}),
  browserPaymentsInFlight: () => ({}),
  browserTemporaryKeys: () => ({}),
}));

/*
 * **THE VAULT'S WORKER, WITH ITS OWN HANDLER, BEHIND THE PAGE'S OWN CLIENT.**
 * Only the thread is stood in: each message is structurally cloned on its
 * way, as a real one is, so nothing crosses that a real one would not carry.
 * What it builds with fails the way the contract runtime fails: a wrapper,
 * with the reason as its cause.
 */
vi.mock('./vault-worker-client.js', async (original) => {
  const real = await original<typeof import('./vault-worker-client.js')>();
  const { startVaultWorker } = await import('./vault-worker-entry.js');
  const toWorker: Array<(e: { data: unknown }) => void> = [];
  const toPage: Array<(e: { data: unknown }) => void> = [];
  const scope = {
    addEventListener: (_: string, l: (e: { data: unknown }) => void) => { toWorker.push(l); },
    postMessage: (m: unknown) => { const data = structuredClone(m); queueMicrotask(() => toPage.forEach((l) => l({ data }))); },
  };
  const worker = {
    addEventListener: (_: string, l: (e: { data: unknown }) => void) => { toPage.push(l); },
    postMessage: (m: unknown) => { const data = structuredClone(m); queueMicrotask(() => toWorker.forEach((l) => l({ data }))); },
  };
  const deps = async () => ({
    ledger: {
      ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'cpk', encryptionPublicKey: 'epk' }) },
      ZswapChainState: class {},
      LedgerParameters: { deserialize: () => ({}) },
    },
    runtimeState: { deserialize: () => ({}) },
    contracts: {
      createUnprovenDeployTxFromVerifierKeys: async () => { throw new Error('no deploy here'); },
      createUnprovenCallTxFromInitialStates: async () => {
        throw ContractRuntimeError.make("Error executing circuit 'deposit'", new ReferenceError(INSIDE));
      },
    },
    compiled: {},
    zkConfig: {},
    prove: async () => { throw new Error('nothing is proved in this test'); },
  }) as never;
  startVaultWorker(scope, deps);
  return { ...real, startVaultBuilder: async () => real.vaultBuilderOver(worker, 'undeployed') };
});

/* The deposit's own steps are stood in: they go straight to the vault's worker, or fail on the page. */
vi.mock('./deposit-source.js', async (original) => ({
  ...(await original<typeof import('./deposit-source.js')>()),
  depositFromSource: async (doors: { builder: { deposit(i: unknown): Promise<unknown> } }, vault: string) => {
    if (page.onPage !== null) page.onPage();
    return doors.builder.deposit({ vault, coin: { nonce: 'c1'.repeat(32), token: 'ab'.repeat(32), value: '5100000' }, state: 'AQ==', parameters: 'AQ==' });
  },
}));

const { VaultPanel } = await import('./VaultPanel.js');

const account = { id: 'acc_1', name: 'Northwind', signers: [], policy: { threshold: 1 } } as unknown as Account;
const me = { signerId: 'sgn_1', signingSecret: '11'.repeat(32) as Hex, wrappingSecret: '22'.repeat(32) as Hex };

afterEach(() => { cleanup(); page.onPage = null; page.recorded.length = 0; });

describe('§1 the line a failure is said in', () => {
  it('says the wrapper and every reason underneath it, outermost first', () => {
    const e = ContractRuntimeError.make("Error executing circuit 'deposit'", new ReferenceError('Buffer is not defined'));
    /* RED WHEN only the outer message is said, or a JavaScript error loses the kind that says what broke. */
    expect(whyItFailed(e)).toBe("Error executing circuit 'deposit'. Underneath that: ReferenceError: Buffer is not defined");
  });

  it('says a reason repeated down the chain once, and stops on a chain that loops', () => {
    const inner = new Error('the vault is not held by the committee.');
    const lifted = new Error('the vault is not held by the committee', { cause: new Error('wrapper', { cause: inner }) });
    /* RED WHEN a library that lifts its cause's message to the top makes the screen say it twice. */
    expect(whyItFailed(lifted)).toBe('the vault is not held by the committee. Underneath that: wrapper');
    const a: { message: string; cause?: unknown } = { message: 'a' };
    a.cause = { message: 'b', cause: a };
    /* RED WHEN a cause that points back at its own failure hangs the page. */
    expect(whyItFailed(a)).toBe('a. Underneath that: b');
  });

  it('stops a chain that never ends, after eight reasons, even when no reason repeats', () => {
    let n = 0;
    const deeper = (): object => ({ message: `step ${n++}`, get cause() { return deeper(); } });
    /* RED WHEN the depth cap is removed: every step is new, so only the cap stops the walk. */
    expect(whyItFailed(deeper()).split('. Underneath that: ')).toEqual(
      ['step 0', 'step 1', 'step 2', 'step 3', 'step 4', 'step 5', 'step 6', 'step 7']);
  });

  it('says an error\'s kind once, and says the kind alone when the error said nothing else', () => {
    /* RED WHEN the kind is put in front of a message that already starts with it. */
    expect(whyItFailed(new TypeError('TypeError: x is not a function'))).toBe('TypeError: x is not a function');
    /* RED WHEN an error with no message of its own is dropped, and the screen says nothing went wrong specifically. */
    expect(whyItFailed(new ReferenceError())).toBe('ReferenceError');
  });

  it('says something for anything a catch can hold, and never throws', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('no'); } });
    /* RED WHEN a failure with nothing to say, or one that throws when read, leaves the screen blank or breaks it. */
    expect(whyItFailed(undefined)).toBe('something went wrong, and whatever failed did not say what');
    expect(whyItFailed(hostile)).toBe('something went wrong, and whatever failed did not say what');
    expect(whyItFailed('plain words.')).toBe('plain words');
  });
});

describe('§2 the vault\'s screen', () => {
  const shownError = () => document.querySelector('[data-vault-error]')?.textContent ?? '';
  const pressDeposit = async () => {
    render(<VaultPanel account={account} me={me} viewingKey={'aa'.repeat(32) as Hex} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => {
      fireEvent.change(document.querySelector('input:not([type])')!, { target: { value: '5.1' } });
    });
    await act(async () => {
      fireEvent.click(document.querySelector(`[data-vault-row] [data-deposit]`)!);
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };

  it('A FAILURE INSIDE THE VAULT\'S WORKER REACHES THE SCREEN WITH ITS REASON', async () => {
    await pressDeposit();
    /* RED WHEN the worker sends the page only the outer message, so the reason never crosses. */
    expect(shownError()).toBe(`Putting money in did not finish: Error executing circuit 'deposit'. Underneath that: ReferenceError: ${INSIDE}`);
  });

  it('A FAILURE ON THE PAGE ITSELF REACHES THE SCREEN WITH ITS REASON', async () => {
    page.onPage = () => { throw new Error('the service refused the deposit', { cause: new Error('the vault changed on the chain') }); };
    await pressDeposit();
    /* RED WHEN the screen shows only the outer message of a failure raised on the page. */
    expect(shownError()).toBe('Putting money in did not finish: the service refused the deposit. Underneath that: the vault changed on the chain');
  });

  it('A REASON FROM UNDERNEATH IS REDACTED ON THE SCREEN AND KEPT IN THE REPORT', async () => {
    const secret = 'ab'.repeat(32);
    page.onPage = () => { throw new Error('the deposit was not built', { cause: new Error(`a library said ${secret}`) }); };
    await pressDeposit();
    /* RED WHEN the panel shows the chain without the redaction every other shown failure gets. */
    expect(shownError()).toBe('Putting money in did not finish: the deposit was not built. Underneath that: a library said <redacted:hex>');
    /* RED WHEN a vault failure is shown and not kept in the report. */
    expect(page.recorded).toEqual(['Putting money in: Putting money in did not finish: the deposit was not built. Underneath that: a library said <redacted:hex>']);
  });
});

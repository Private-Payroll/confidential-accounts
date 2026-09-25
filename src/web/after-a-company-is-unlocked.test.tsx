// @vitest-environment jsdom
/**
 * **WHAT THE COMPANY PICKER AND THE KEYRING DO ONCE THE SAVED KEYS ARE OPEN.**
 *
 * A person's keys for every company they belong to here are saved together,
 * sealed under one key their wallet works out for them on this site. The
 * picker has two faces and chooses between them by whether this tab has opened
 * those keys. Before, it shows the wallet's face: one *Unlock* per company and
 * a creation form that asks the wallet. After, it shows the other face: company
 * names, *Open*, and a creation form that saves the new company's keys beside
 * the ones already open, with no wallet asked.
 *
 * What these pin:
 *
 *   1. starting a company is open to anybody, however many companies they
 *      already belong to, on either face - and hidden only while a company this
 *      tab started is still waiting for its keys to be saved;
 *   2. a failure on the second face reaches the screen, because a press that
 *      fails in silence is pressed again and again;
 *   3. a company it cannot open says what this tab actually read, not that the
 *      keys are *not on this device*, which sends a person looking for a device
 *      that has them;
 *   4. saved keys that do not open with the key the wallet gave are refused out
 *      loud and never written over, and a second wallet that gives a different
 *      key is refused;
 *   5. a person's first keys are saved only from the tab that signed them in,
 *      because only that tab could make the wallet show which address it is.
 *
 * The wallet at the other end is the wallet's own code answering over the real
 * conversation, so the key this tab holds is a key the wallet really gave.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, newWords } from 'midnight-identity';
import type { Identity } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { READY_PING } from 'midnight-identity/profile/channel';
import { keyringKeyFor, keyringReleaseFor } from 'midnight-identity/profile/unlock';
import { seal, toHex, unseal } from '../core/crypto.js';
import { keyringAsk, KEYRING_PURPOSE } from '../core/wallet-unlock.js';
import type { Openable } from './wallet-sign-in.js';
import * as keyring from './keyring.js';

const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
/** The address the server says the sign-in was for, in a shape the wallet's parser accepts. */
const SIGNED_IN = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const PERSON = 'usr_1';
const identity = identityFromWords(TEST_MNEMONIC);

/**
 * A wallet that gives the keyring key from its own words, and only for an
 * address it holds - which is exactly what the wallet's own screen calls.
 * Anything it refuses is answered with something that is not a key, so the
 * page refuses it rather than waiting for ever.
 */
class WalletAtTheOtherEnd implements Openable {
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };
  constructor(
    private readonly who: Identity = identity,
    private readonly holds: (address: string) => boolean = (address) => address === SIGNED_IN,
  ) {}
  open(): Window | null { return this.tab as unknown as Window; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void {
    this.handler = h;
    queueMicrotask(() => this.deliver({ schema: READY_PING }));
  }
  removeEventListener(): void { this.handler = null; }
  setTimeout(): number { return 0; }
  clearTimeout(): void { /* nothing to clear */ }
  private deliver(data: unknown): void {
    this.handler?.({ origin: WALLET, source: this.tab, data } as unknown as MessageEvent);
  }
  private onAsk(message: unknown): void {
    let answer: unknown;
    try {
      const ask = parseAsk(message, US, Date.now());
      answer = ask.kind === 'keyring'
        ? keyringReleaseFor(this.who, ask as KeyringRequest, Date.now(), this.holds)
        : { schema: 'a-sign-in' };
    } catch {
      answer = { schema: 'nothing-given' };
    }
    queueMicrotask(() => this.deliver(answer));
  }
}

/** A different wallet: different words, so a different key for the same person. */
const anotherWallet = () => new WalletAtTheOtherEnd(identityFromWords(newWords()), () => true);

/** The keyring key the wallet above gives this person, worked out the wallet's way. */
const keyringHex = () => toHex(keyringKeyFor(identity, parseAsk(keyringAsk({
  name: 'n', rdns: 'r', purpose: KEYRING_PURPOSE, nonce: 'n', expiresAt: Date.now() + 60_000,
  person: PERSON, signedInAs: null, company: null,
}), US, Date.now()) as KeyringRequest));

/** Key material this person sealed for a seat before its leaf was published, and has not promoted. */
const PENDING = {
  accountId: 'acc_seated', signingPublicKey: '12'.repeat(32), signingSecret: '34'.repeat(32),
  wrappingSecret: '56'.repeat(32), blinding: '78'.repeat(32), scope: '9a'.repeat(32),
};

const NEW_KEYS = {
  signerId: 'sgn_new', signingSecret: 'dd'.repeat(32), wrappingSecret: 'ee'.repeat(32), blinding: 'ff'.repeat(32),
  scope: 'ab'.repeat(32),
};

const A_COMPANY = { name: 'Acme Ltd', signers: [{ name: 'You', role: 'admin' as const }], threshold: 1 };

/** A company record as the list and the single read serve it: sealed, and this person on it. */
const LOCKED = { id: 'acc_1', signerCount: 1, threshold: 1, wrappedKeys: [], wiring: 'chain' };

interface Deployment {
  /**
   * What `GET /api/me/keys` answers: nothing saved, a bundle that holds other
   * companies, one that holds a pending seat too, or keys sealed under a key
   * this person's wallet does not give.
   */
  keyBundle: 'none' | 'another-company' | 'a-pending-seat' | 'sealed-under-another-key'
    /** Another company's keys, saved before scopes were recorded, so the entry has none. */
    | 'saved-before-scopes';
  /** Whether saving the key bundle is refused, as it is when another tab or device wrote first. */
  bundleWriteRefused?: boolean;
  /** Held until the test lets it through, so something can happen while a write is on its way. */
  bundleWriteHeld?: Promise<void>;
  /** When set, what `GET /api/me/keys` answers instead of what is saved - a server answering from before. */
  keysRead?: { keyBundle: unknown; version: number };
}

const realFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = realFetch; keyring.forgetLocally(); });

/** A server that answers the way the real one does for these routes. */
function aDeployment(d: Deployment) {
  const posted: Array<{ url: string; body: any }> = [];
  const bundle = d.keyBundle === 'none'
    ? null
    : d.keyBundle === 'sealed-under-another-key'
      ? seal(JSON.stringify({ accounts: {} }), 'ab'.repeat(32))
      : seal(JSON.stringify({ accounts: { acc_other: {
        signerId: 'sgn_x', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb'.repeat(32),
        blinding: 'cc'.repeat(32),
        ...(d.keyBundle === 'saved-before-scopes' ? {} : { scope: 'bc'.repeat(32) }),
      } }, ...(d.keyBundle === 'a-pending-seat' ? { pendingSeats: { [PENDING.signingPublicKey]: PENDING } } : {}) }),
      keyringHex());
  /* What is saved, and its version: each accepted write replaces the one and raises the other. */
  let saved: unknown = bundle;
  let version = bundle ? 1 : 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    posted.push({ url: `${method} ${url}`, body });
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    const user = { id: PERSON, email: null, name: '' };
    switch (`${method} ${url}`) {
      case 'POST /api/auth/wallet/challenge':
        return json(200, { nonce: 'nonce', handle: 'h', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      case 'POST /api/auth/wallet':
        return json(200, { user, address: SIGNED_IN, created: false, session: {} });
      case 'GET /api/me': return json(200, { user, accounts: [LOCKED] });
      case 'GET /api/accounts': return json(200, [LOCKED]);
      case 'GET /api/accounts/acc_1': return json(200, LOCKED);
      case 'PUT /api/me/keys':
        if (d.bundleWriteHeld) await d.bundleWriteHeld;
        if (d.bundleWriteRefused) {
          return json(409, { error: 'the keys changed on another device since this tab read them' });
        }
        saved = body.keyBundle;
        version += 1;
        return json(200, { version });
      case 'GET /api/me/keys': return json(200, d.keysRead ?? { keyBundle: saved, version });
      case 'POST /api/accounts': {
        if (!body?.signers?.[0]?.name) {
          return json(400, { error: 'Too small: expected string to have >=1 characters' });
        }
        return json(200, {
          account: { id: 'acc_new' },
          /* As the service answers: every seat's secrets carry the scope it was seated under. */
          secrets: [{ signerId: 'sgn_new', signingSecret: 'dd'.repeat(32), wrappingSecret: 'ee'.repeat(32), blinding: 'ff'.repeat(32), scope: 'ab'.repeat(32) }],
        });
      }
      default: return json(404, { error: `no route for ${method} ${url}` });
    }
  }) as typeof fetch;
  const sent = (route: string) => posted.filter((p) => p.url === route);
  return { posted, sent };
}

/** Sign in, and press *Unlock*: the wallet gives the key for the address this tab signed in as. */
async function signInAndOpenKeys() {
  const view = new WalletAtTheOtherEnd();
  await keyring.signInWithWallet(WALLET, undefined, view);
  await keyring.openKeysWithWallet(WALLET, view, US);
  expect(keyring.canOpenCompanies(), 'the saved keys opened').toBe(true);
}

/**
 * A tab that did not sign anybody in - a reload - opens the saved keys. It
 * picks the sign-in up from the server and does not know the address, so the
 * wallet is asked without one.
 */
async function openKeysInAReloadedTab(view: WalletAtTheOtherEnd = new WalletAtTheOtherEnd()) {
  await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
  keyring.forgetLocally();
  expect(await keyring.resumeSession(), 'the sign-in was picked up').not.toBeNull();
  expect(keyring.signedInWallet(), 'a reloaded tab does not know the address').toBeNull();
  await keyring.openKeysWithWallet(WALLET, view, US);
  expect(keyring.canOpenCompanies(), 'the saved keys opened').toBe(true);
}

async function thePage() {
  const { default: App } = await import('./App.js');
  const { SimulatedCommitments } = await import('../core/ledger.js');
  return render(<App commitments={SimulatedCommitments} />);
}

async function thePicker(onCreateWithWallet: (name: string) => void = () => {}) {
  const { AccountPicker } = await import('./Auth.js');
  return render(
    <AccountPicker
      user={{ id: PERSON, email: null, name: '' }} accounts={[]} busy={false}
      onOpen={() => {}} onUnlock={() => {}} onCreateWithWallet={onCreateWithWallet}
      onFinishSetup={() => {}} awaitingSetup={keyring.companyAwaitingSetup()} onDemo={() => {}} onSignOut={() => {}} />);
}

describe('once your saved keys are open, starting another company', () => {
  it('IS OPEN TO USE, and submitting hands the name to the journey that creates it', async () => {
    aDeployment({ keyBundle: 'another-company' });
    await signInAndOpenKeys();
    const create = vi.fn();
    const { container } = await thePicker(create);
    expect(container.querySelector('h1')?.textContent).toBe('Your accounts');
    const form = container.querySelector('form.acctnew') as HTMLFormElement;
    expect(form).not.toBeNull();
    const input = form.querySelector('input') as HTMLInputElement;
    const button = form.querySelector('button') as HTMLButtonElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'Acme Ltd' } });
    expect(button.disabled).toBe(false);
    expect(container.querySelector('[data-no-company-here]')).toBeNull();
    expect(container.textContent).not.toMatch(/cannot be started/);

    fireEvent.submit(form);
    expect(create).toHaveBeenCalledWith('Acme Ltd');
  });

  it('while a company this tab started is waiting for its keys to be saved, shows no Create form', async () => {
    aDeployment({ keyBundle: 'none', bundleWriteRefused: true });
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(), US))
      .rejects.toThrow(/changed on another device/);
    expect(keyring.canOpenCompanies(), 'the saved keys are open').toBe(true);
    expect(keyring.companyAwaitingSetup()).toBe('acc_new');
    const { container } = await thePicker();
    expect(container.querySelector('h1')?.textContent).toBe('Your accounts');
    expect(container.querySelector('[data-awaiting-setup]')).not.toBeNull();
    expect(container.querySelector('form.acctnew')).toBeNull();
  });
});

describe('before anything is opened, for a person who already has keys saved', () => {
  it('STARTING A COMPANY IS OPEN TO USE, and nothing says it cannot be started', async () => {
    aDeployment({ keyBundle: 'another-company' });
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    const { container } = await thePage();
    const form = await waitFor(() => {
      const found = container.querySelector('form.acctnew');
      expect(found).toBeTruthy();
      return found as HTMLFormElement;
    });
    await waitFor(() => expect(container.textContent).toContain('A company you are a signer on'));
    const input = form.querySelector('input') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'Acme Ltd' } });
    expect((form.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
    expect(container.textContent).not.toMatch(/cannot be started with this wallet address/);
    expect(container.querySelector('[data-no-company-here]')).toBeNull();
  });

  it('and for a person with nothing saved, the form is there to use', async () => {
    aDeployment({ keyBundle: 'none' });
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    const { container } = await thePage();
    const form = await waitFor(() => {
      const found = container.querySelector('form.acctnew');
      expect(found).toBeTruthy();
      return found as HTMLFormElement;
    });
    await waitFor(() => expect(container.textContent).toContain('A company you are a signer on'));
    expect((form.querySelector('input') as HTMLInputElement).disabled).toBe(false);
    expect(container.querySelector('[data-no-company-here]')).toBeNull();
  });
});

describe('what the keyring knows about the keys saved for this person', () => {
  it('nothing is claimed before opening, and a fresh sign-in or a sign-out forgets what an opening read', async () => {
    aDeployment({ keyBundle: 'none' });
    const nothingRead = keyring.lockedCompanyReason('acc_1');
    expect(nothingRead).toMatch(/has not opened the keys saved for you/);
    expect(keyring.lockedCompanyRefusal('acc_1')).toMatch(/cannot be opened until it has/);
    await signInAndOpenKeys();
    expect(keyring.lockedCompanyReason('acc_1')).toMatch(/no keys were saved for you here/);

    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    expect(keyring.lockedCompanyReason('acc_1'), 'a new sign-in has read nothing yet').toBe(nothingRead);

    await keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(), US);
    keyring.forgetLocally();
    expect(keyring.lockedCompanyReason('acc_1'), 'a tab that forgot has read nothing').toBe(nothingRead);
  });

  it('once this tab saves keys for a person who had none, they are no longer described as having none', async () => {
    const { sent } = aDeployment({ keyBundle: 'none' });
    await signInAndOpenKeys();
    await keyring.rememberAccount('acc_new', NEW_KEYS as never);
    expect(sent('PUT /api/me/keys')).toHaveLength(1);
    expect(keyring.lockedCompanyReason('acc_1')).toMatch(/do not include this company/);
  });

  it('a company whose keys ARE here and did not open is not described as missing its keys', async () => {
    aDeployment({ keyBundle: 'another-company' });
    await signInAndOpenKeys();
    expect(keyring.keysFor('acc_other')).not.toBeNull();
    expect(keyring.lockedCompanyReason('acc_other')).toBe('it did not open with the keys saved for you');
    expect(keyring.lockedCompanyRefusal('acc_other')).toContain('you may not have been given access to it yet');
  });
});

describe('KEYS SAVED BEFORE VAULT SCOPES WERE RECORDED', () => {
  it('are refused by name when asked for, and nothing is filled in for the scope they do not have', async () => {
    aDeployment({ keyBundle: 'saved-before-scopes' });
    await signInAndOpenKeys();
    /* RED WHEN: an entry with no scope is handed out - with any scope at all, or with none. */
    expect(() => keyring.keysFor('acc_other')).toThrow(keyring.SeatSavedBeforeScopes);
    expect(() => keyring.keysFor('acc_other')).toThrow(/can no longer act at all/);
    expect(() => keyring.signerMaterialFor('acc_other')).toThrow(keyring.SeatSavedBeforeScopes);
    /* RED WHEN: the list row blames the wrong thing for a company it cannot open. */
    expect(keyring.lockedCompanyReason('acc_other')).toBe('the keys saved for you were written before vault scopes were recorded');
    /* A company with no keys here at all is not affected. */
    expect(keyring.keysFor('acc_1')).toBeNull();
  });

  it('an entry whose scope is there is handed out with it, and so is its material for a raise or an approval', async () => {
    aDeployment({ keyBundle: 'another-company' });
    await signInAndOpenKeys();
    expect(keyring.keysFor('acc_other')?.scope).toBe('bc'.repeat(32));
    expect(keyring.signerMaterialFor('acc_other')).toEqual({
      signingSecret: 'aa'.repeat(32), blinding: 'cc'.repeat(32), scope: 'bc'.repeat(32),
    });
    /* RED WHEN: a scope that is not thirty-two bytes is handed out as though it were one. */
    expect(() => keyring.keysToActWith('acc_x', { signerId: 's', signingSecret: 'a', wrappingSecret: 'b', blinding: 'c', scope: 'bc'.repeat(31) }))
      .toThrow(keyring.SeatSavedBeforeScopes);
    expect(() => keyring.keysToActWith('acc_x', { signerId: 's', signingSecret: 'a', wrappingSecret: 'b', blinding: 'c', scope: 7 }))
      .toThrow(keyring.SeatSavedBeforeScopes);
    expect(keyring.keysToActWith('acc_x', undefined)).toBeNull();
  });
});

describe('a company this tab cannot open, once your saved keys are open', () => {
  it('WITH NOTHING SAVED AT ALL: says what this tab read, and does not send the person to another device', async () => {
    const { posted } = aDeployment({ keyBundle: 'none' });
    await signInAndOpenKeys();
    const { container } = await thePage();
    const row = await waitFor(() => {
      const found = container.querySelector('button.acctrow');
      expect(found).toBeTruthy();
      return found as HTMLButtonElement;
    });
    expect(row.textContent).not.toMatch(/on this device/);
    expect(row.textContent).toMatch(/no keys were saved for you here when this tab last looked/);
    /* The heading names the address signed in with, or says nothing: a wallet
     * person has no email, and the line used to end on a blank. */
    const lines = [...container.querySelectorAll('p.authsub')].map((p) => p.textContent ?? '');
    expect(lines.some((l) => /^Signed in as\s*$/.test(l))).toBe(false);
    expect(lines).toContain(`Signed in as ${SIGNED_IN}`);

    fireEvent.click(row);
    await waitFor(() => expect(posted.map((p) => p.url)).toContain('GET /api/accounts/acc_1'));
    const said = await waitFor(() => {
      const text = container.querySelector('.autherr')?.textContent ?? '';
      expect(text).not.toBe('');
      return text;
    });
    expect(said).not.toMatch(/on this device/);
    expect(said).not.toMatch(/another device can open/);
    expect(said).toMatch(/no keys were saved for you here when this tab last looked/);
    expect(said).toMatch(/It opens here only once keys for it are saved for you - by the tab that created it finishing setting it up/);
    expect(said).toMatch(/opening it reads what is saved again/);
    /* The conditions are conditions: a company whose keys are never saved is said to be unopenable. */
    expect(said).toMatch(/or the company was made by something that kept no keys for you, nothing can open it/);
    expect(said).not.toMatch(/sealed under another company's key/);
    expect(said).not.toMatch(/accepting an invitation/);
  });

  it('WITH OTHER COMPANIES SAVED: says the saved keys, as this tab read them, do not include this one', async () => {
    aDeployment({ keyBundle: 'another-company' });
    await signInAndOpenKeys();
    expect(keyring.keysFor('acc_other'), 'the bundle really opened').not.toBeNull();
    const { container } = await thePage();
    const row = await waitFor(() => {
      const found = [...container.querySelectorAll('button.acctrow')]
        .find((b) => /when this tab last looked/.test(b.textContent ?? ''));
      expect(found).toBeTruthy();
      return found as HTMLButtonElement;
    });
    expect(row.textContent).toMatch(/the keys saved for you here, when this tab last looked, do not include this company/);
    fireEvent.click(row);
    const said = await waitFor(() => {
      const text = container.querySelector('.autherr')?.textContent ?? '';
      expect(text).not.toBe('');
      return text;
    });
    expect(said).toMatch(/do not include this company/);
    expect(said).not.toMatch(/on this device/);
    /* Keys saved beside other companies' keys are saved under the same key, so
     * the tab that created this one finishing it is what would open it. */
    expect(said).toMatch(/It opens here only once keys for it are saved for you - by the tab that created it finishing setting it up/);
    expect(said).not.toMatch(/sealed under another company's key/);
    expect(said).not.toMatch(/cannot be saved beside them/);
  });
});

describe('what the second face says when something it asks for fails', () => {
  it('REACHES THE SCREEN', async () => {
    aDeployment({ keyBundle: 'none' });
    await signInAndOpenKeys();
    const { container } = await thePage();
    const row = await waitFor(() => {
      const found = container.querySelector('button.acctrow');
      expect(found).toBeTruthy();
      return found as HTMLButtonElement;
    });
    expect(container.querySelector('.autherr')).toBeNull();
    fireEvent.click(row);
    await waitFor(() => expect(container.querySelector('.autherr')).not.toBeNull());
  });
});

describe('A REFUSED KEY WRITE LEAVES THE KEY LIST EXACTLY AS IT WAS', () => {
  /*
   * Every writer of the key list used to put the new entry into the list this
   * tab holds and THEN ask the server to save it, and the save kept a copy to
   * put back on refusal - taken after the entry was already in. So a refused
   * save left the tab holding, and offering, keys the server never took.
   */
  /** Everything the keyring would give out about the list, taken as one value. */
  const theList = () => JSON.stringify({
    other: keyring.keysFor('acc_other'), added: keyring.keysFor('acc_new'),
    seated: keyring.keysFor('acc_seated'), pending: keyring.pendingSeatsFor('acc_seated'),
    fresh: keyring.pendingSeatsFor('acc_fresh'),
  });

  it('ADDING A COMPANY\'S KEYS: refused, and the tab does not hold them', async () => {
    aDeployment({ keyBundle: 'another-company', bundleWriteRefused: true });
    await signInAndOpenKeys();
    const before = theList();
    await expect(keyring.rememberAccount('acc_new', NEW_KEYS as never)).rejects.toThrow(/changed on another device/);
    expect(keyring.keysFor('acc_new')).toBeNull();
    expect(theList()).toBe(before);
    expect(keyring.openAccount({ id: 'acc_new', wrappedKeys: [] } as never)).toBeNull();
  });

  it('SEALING A SEAT BEFORE ITS LEAF IS SENT: refused, and nothing is pending', async () => {
    aDeployment({ keyBundle: 'another-company', bundleWriteRefused: true });
    await signInAndOpenKeys();
    const before = theList();
    await expect(keyring.sealPendingSeat({ ...PENDING, accountId: 'acc_fresh', signingPublicKey: '13'.repeat(32) }))
      .rejects.toThrow(/changed on another device/);
    expect(keyring.pendingSeatsFor('acc_fresh')).toEqual([]);
    expect(theList()).toBe(before);
  });

  it('PROMOTING A SEAT: refused, and the seat is still pending and not promoted', async () => {
    aDeployment({ keyBundle: 'a-pending-seat', bundleWriteRefused: true });
    await signInAndOpenKeys();
    expect(keyring.pendingSeatsFor('acc_seated'), 'the pending seat was read').toHaveLength(1);
    const before = theList();
    await expect(keyring.promotePendingSeat(PENDING.signingPublicKey, 'sgn_seated')).rejects.toThrow(/changed on another device/);
    expect(keyring.keysFor('acc_seated')).toBeNull();
    expect(keyring.pendingSeatsFor('acc_seated')).toHaveLength(1);
    expect(theList()).toBe(before);
  });

  it('and the NEXT write the tab makes does not carry what was refused', async () => {
    const d: Deployment = { keyBundle: 'another-company', bundleWriteRefused: true };
    const { sent } = aDeployment(d);
    await signInAndOpenKeys();
    await expect(keyring.rememberAccount('acc_new', NEW_KEYS as never)).rejects.toThrow();
    d.bundleWriteRefused = false;
    await keyring.rememberAccount('acc_later', { ...NEW_KEYS, signerId: 'sgn_later' } as never);
    const writes = sent('PUT /api/me/keys');
    const saved = JSON.parse(unseal(writes[writes.length - 1]!.body.keyBundle, keyringHex()));
    expect(Object.keys(saved.accounts).sort()).toEqual(['acc_later', 'acc_other']);
  });

  it('a write that lands after the tab READ THE KEYS AGAIN is not put over what it read', async () => {
    let letItThrough: () => void = () => {};
    const bundleWriteHeld = new Promise<void>((resolve) => { letItThrough = resolve; });
    aDeployment({ keyBundle: 'another-company', bundleWriteHeld });
    await signInAndOpenKeys();
    const writing = keyring.rememberAccount('acc_new', NEW_KEYS as never);
    await Promise.resolve();
    await keyring.reopenSavedKeys();
    letItThrough();
    await writing;
    expect(keyring.keysFor('acc_other'), 'what the second read found is what this tab holds').not.toBeNull();
    expect(keyring.keysFor('acc_new')).toBeNull();
  });

  it('a write that lands AFTER the tab has signed out does not bring the keys back', async () => {
    let letItThrough: () => void = () => {};
    const bundleWriteHeld = new Promise<void>((resolve) => { letItThrough = resolve; });
    aDeployment({ keyBundle: 'another-company', bundleWriteHeld });
    await signInAndOpenKeys();
    const writing = keyring.rememberAccount('acc_new', NEW_KEYS as never);
    await Promise.resolve();
    keyring.forgetLocally();
    letItThrough();
    await writing;
    expect(keyring.keysFor('acc_new')).toBeNull();
    expect(keyring.keysFor('acc_other')).toBeNull();
    expect(keyring.canOpenCompanies()).toBe(false);
  });
});

describe('a company this tab started whose keys could not be saved', () => {
  const theBlock = async () => {
    const { AccountPicker } = await import('./Auth.js');
    const { container } = render(
      <AccountPicker
        user={{ id: PERSON, email: null, name: '' }} accounts={[]} busy={false}
        onOpen={() => {}} onUnlock={() => {}} onCreateWithWallet={() => {}}
        onFinishSetup={() => {}} awaitingSetup={keyring.companyAwaitingSetup()} onDemo={() => {}} onSignOut={() => {}} />);
    return container.querySelector('[data-awaiting-setup]')!;
  };
  /** From the `from`th read on, GET /api/me/keys answers keys sealed under another key. */
  const keysSavedElsewhereFrom = (from: number) => {
    const real = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(init?.method ?? 'GET') === 'GET' && url === '/api/me/keys' && (reads += 1) >= from) {
        return { ok: true, status: 200, json: async () => ({ keyBundle: seal('{}', 'ab'.repeat(32)), version: 2 }) } as Response;
      }
      return real(url, init);
    }) as typeof fetch;
  };

  /** Start a company whose save is refused, and refused again when it is tried straight away. */
  const aCompanyLeftWaiting = async () => {
    const { sent } = aDeployment({ keyBundle: 'none', bundleWriteRefused: true });
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(), US))
      .rejects.toThrow(/changed on another device/);
    expect(sent('PUT /api/me/keys'), 'the save was tried again straight away').toHaveLength(2);
    expect(keyring.companyAwaitingSetup()).toBe('acc_new');
  };

  it('WHEN THE SAVE WAS REFUSED TWICE: keeps Finish pressable, and says why', async () => {
    await aCompanyLeftWaiting();
    expect(keyring.companyAwaitingSetupProblem()).toBeNull();
    const block = await theBlock();
    expect(block).not.toBeNull();
    expect(block.hasAttribute('data-cannot-finish')).toBe(false);
    expect(block.textContent).toContain(
      'Its keys are not saved yet: saving them was refused, and trying again straight away was refused too');
    expect(block.textContent).toContain('Nothing is lost yet - but the keys are only in this tab');
    expect(block.textContent).not.toMatch(/Sign out, sign in again/);
    const finish = block.querySelector('button') as HTMLButtonElement;
    expect(finish.textContent).toBe('Finish setting up');
    expect(finish.disabled).toBe(false);
  });

  it('and says the keys are lost when the sign-in ends, however it ends', async () => {
    await aCompanyLeftWaiting();
    const block = await theBlock();
    expect(block.textContent).toContain('sign-in ends for any reason');
    expect(block.textContent).toContain('signing out here or on another device');
  });

  it('WHEN FINISHING FINDS KEYS SAVED SINCE THAT DO NOT OPEN: says it cannot be finished, with Finish disabled, and does not say nothing is lost', async () => {
    const { sent } = aDeployment({ keyBundle: 'none', bundleWriteRefused: true });
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    /* The first read is the opening; the second is the save being tried again straight away,
     * which finds keys saved since under a key this tab does not hold. */
    keysSavedElsewhereFrom(2);
    const refused = await keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(), US)
      .then(() => null, (e: unknown) => e as Error);
    expect(refused).toBeInstanceOf(keyring.SavedKeysDidNotOpen);
    expect(refused!.message).toContain('this company\'s keys cannot be saved');
    expect(sent('PUT /api/me/keys'), 'nothing was written over keys this tab cannot open').toHaveLength(1);
    expect(keyring.companyAwaitingSetup(), 'the company is still waiting, with its keys in this tab').toBe('acc_new');
    await expect(keyring.finishCompanyCreation()).rejects.toThrow(refused!.message);

    const block = await theBlock();
    expect(block.hasAttribute('data-cannot-finish')).toBe(true);
    expect(block.querySelector('[data-setup-problem]')?.textContent).toBe(refused!.message);
    expect(block.textContent).toContain('cannot be finished');
    expect(block.textContent).toContain('closing this tab or signing out loses this company for good');
    expect(block.textContent).not.toMatch(/Nothing is lost/);
    expect((block.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('A READ THAT HAS GONE BACKWARDS IS NOT TAKEN IN PLACE OF WHAT THIS TAB HOLDS', () => {
  /** Open the saved keys (one company's), save a second company's beside them, and keep the deployment. */
  const keysOpenAndACompanySaved = async (d: Deployment) => {
    aDeployment(d);
    await signInAndOpenKeys();
    await keyring.rememberAccount('acc_new', NEW_KEYS as never);
    expect(keyring.keysFor('acc_new'), 'the second company\'s keys were saved').not.toBeNull();
  };
  const readAgain = () => keyring.reopenSavedKeys().then(() => null, (e: unknown) => e as Error);

  it('AN OLDER VERSION: refused, and the tab keeps the keys it saved', async () => {
    const d: Deployment = { keyBundle: 'another-company' };
    await keysOpenAndACompanySaved(d);
    /* Version 1 is what was saved before this tab's write made version 2, and it opens. */
    const older = seal(JSON.stringify({ accounts: { acc_other: keyring.keysFor('acc_other') } }), keyringHex());
    d.keysRead = { keyBundle: older, version: 1 };
    const refused = await readAgain();
    expect(refused).toBeInstanceOf(keyring.SavedKeysWentBack);
    expect(refused!.message).toContain('is older than what this tab already read, or is gone');
    expect(keyring.keysFor('acc_new')).not.toBeNull();
    expect(keyring.keysFor('acc_other')).not.toBeNull();
    expect(keyring.canOpenCompanies()).toBe(true);
  });

  it('NO KEYS AT ALL, where this tab had read some: refused, and the tab keeps the keys it saved', async () => {
    const d: Deployment = { keyBundle: 'another-company' };
    await keysOpenAndACompanySaved(d);
    d.keysRead = { keyBundle: null, version: 2 };
    const refused = await readAgain();
    expect(refused).toBeInstanceOf(keyring.SavedKeysWentBack);
    expect(keyring.keysFor('acc_new')).not.toBeNull();
    expect(keyring.canOpenCompanies()).toBe(true);
    expect(keyring.lockedCompanyReason('acc_1'), 'still described as having keys saved').toMatch(/do not include this company/);
  });

  it('a company waiting to be finished that meets one is not marked as never finishable, and keeps its keys waiting', async () => {
    const d: Deployment = { keyBundle: 'another-company', bundleWriteRefused: true };
    aDeployment(d);
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(), US))
      .rejects.toThrow(/changed on another device/);
    expect(keyring.companyAwaitingSetup()).toBe('acc_new');

    d.keysRead = { keyBundle: null, version: 0 };
    await expect(keyring.finishCompanyCreation()).rejects.toBeInstanceOf(keyring.SavedKeysWentBack);
    expect(keyring.companyAwaitingSetupProblem()).toBeNull();
    expect(keyring.companyAwaitingSetup()).toBe('acc_new');

    /* The keys it kept are the ones saved once the server answers as it should. */
    d.keysRead = undefined;
    d.bundleWriteRefused = false;
    await keyring.finishCompanyCreation();
    expect(keyring.keysFor('acc_new')).not.toBeNull();
    expect(keyring.companyAwaitingSetup()).toBeNull();
  });
});

describe('SAVED KEYS THAT DO NOT OPEN ARE REFUSED AND LEFT AS THEY ARE', () => {
  it('opening them is refused out loud, nothing is opened, and nothing is ever written over them', async () => {
    const { sent } = aDeployment({ keyBundle: 'sealed-under-another-key' });
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    const refused = await keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(), US)
      .then(() => null, (e: unknown) => e as Error);
    expect(refused).toBeInstanceOf(keyring.SavedKeysDidNotOpen);
    expect(refused!.message).toContain(
      'did not open with the key your wallet gave, so nothing has been opened, and nothing will be saved over them');
    expect(keyring.canOpenCompanies()).toBe(false);

    await expect(keyring.rememberAccount('acc_new', NEW_KEYS as never)).rejects.toThrow();
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(), US))
      .rejects.toBeInstanceOf(keyring.SavedKeysDidNotOpen);
    expect(sent('POST /api/accounts'), 'no company was made whose keys could not be saved').toEqual([]);
    expect(keyring.companyAwaitingSetup()).toBeNull();
    expect(sent('PUT /api/me/keys')).toEqual([]);
  });

  it('once they are open, a different wallet giving a different key is refused, and the tab keeps the keys it opened', async () => {
    const { sent } = aDeployment({ keyBundle: 'another-company' });
    await openKeysInAReloadedTab();
    const before = JSON.stringify(keyring.keysFor('acc_other'));
    expect(before).not.toBe('null');

    const refused = await keyring.openKeysWithWallet(WALLET, anotherWallet(), US)
      .then(() => null, (e: unknown) => e as Error);
    expect(refused).toBeInstanceOf(keyring.SavedKeysDidNotOpen);
    expect(refused!.message).toContain(
      'gave a different key from the one this tab opened your saved keys with');
    expect(keyring.canOpenCompanies()).toBe(true);
    expect(JSON.stringify(keyring.keysFor('acc_other'))).toBe(before);

    /* What is written next is still sealed under the key the saved keys opened with. */
    await keyring.rememberAccount('acc_new', NEW_KEYS as never);
    const writes = sent('PUT /api/me/keys');
    expect(writes).toHaveLength(1);
    const saved = JSON.parse(unseal(writes[0]!.body.keyBundle, keyringHex()));
    expect(Object.keys(saved.accounts).sort()).toEqual(['acc_new', 'acc_other']);
  });
});

describe('A PERSON\'S FIRST KEYS ARE SAVED ONLY FROM THE TAB THAT SIGNED THEM IN', () => {
  it('in a reloaded tab, for a person with nothing saved, saving keys is refused and nothing is sent', async () => {
    const { sent } = aDeployment({ keyBundle: 'none' });
    await openKeysInAReloadedTab();
    await expect(keyring.rememberAccount('acc_new', NEW_KEYS as never)).rejects.toThrow(/this tab did not sign you in/);
    await expect(keyring.sealPendingSeat({ ...PENDING, accountId: 'acc_fresh', signingPublicKey: '13'.repeat(32) }))
      .rejects.toThrow(/Sign in again in this tab, with the same wallet address/);
    expect(sent('PUT /api/me/keys')).toEqual([]);
    expect(keyring.keysFor('acc_new')).toBeNull();
    expect(keyring.pendingSeatsFor('acc_fresh')).toEqual([]);
  });

  it('and starting a company there is refused before anything is created', async () => {
    const { sent } = aDeployment({ keyBundle: 'none' });
    await openKeysInAReloadedTab();
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(), US))
      .rejects.toThrow(/Nothing has been created or saved/);
    expect(sent('POST /api/accounts')).toEqual([]);
    expect(sent('PUT /api/me/keys')).toEqual([]);
    expect(keyring.companyAwaitingSetup()).toBeNull();
  });

  it('in the tab that signed them in, the same keys are saved', async () => {
    const { sent } = aDeployment({ keyBundle: 'none' });
    await signInAndOpenKeys();
    await keyring.rememberAccount('acc_new', NEW_KEYS as never);
    expect(sent('PUT /api/me/keys')).toHaveLength(1);
    expect(keyring.keysFor('acc_new')).not.toBeNull();
  });

  it('and a reloaded tab adds to keys that are already saved, because they only open with the same wallet', async () => {
    const { sent } = aDeployment({ keyBundle: 'another-company' });
    await openKeysInAReloadedTab();
    await keyring.rememberAccount('acc_new', NEW_KEYS as never);
    expect(sent('PUT /api/me/keys')).toHaveLength(1);
    expect(keyring.keysFor('acc_new')).not.toBeNull();
  });
});

describe('the companies that pay you are kept with you, sealed, and shown to nobody else', () => {
  const ACME = 'ab'.repeat(32);
  const BEFORE_UNLOCK = 'cd'.repeat(32);
  afterEach(() => { localStorage.clear(); });

  it('A COMPANY ADDED ONCE THE SAVED KEYS ARE OPEN IS SAVED INSIDE THEM, BESIDE WHAT WAS THERE', async () => {
    const { sent } = aDeployment({ keyBundle: 'another-company' });
    await signInAndOpenKeys();
    await keyring.rememberCompanyThatPaysYou('0x' + ACME.toUpperCase());
    const writes = sent('PUT /api/me/keys');
    /* RED WHEN the list is not saved with the person. */
    expect(writes).toHaveLength(1);
    /* RED WHEN the address crosses the wire where the service can read it. */
    expect(JSON.stringify(writes[0].body)).not.toContain(ACME);
    const inside = JSON.parse(unseal(writes[0].body.keyBundle, keyringHex()));
    expect(inside.paidBy).toEqual([ACME]);
    /* RED WHEN saving the list drops a company's keys. */
    expect(Object.keys(inside.accounts)).toEqual(['acc_other']);
    expect(keyring.companiesThatPayYou()).toEqual([ACME]);
    /* Nothing is left in this browser: it is in the saved keys. */
    expect(localStorage.length).toBe(0);
    /* Adding it again writes nothing. */
    await keyring.rememberCompanyThatPaysYou(ACME);
    expect(sent('PUT /api/me/keys')).toHaveLength(1);
  });

  it('ONE ADDED BEFORE THEY ARE OPEN IS HELD FOR THIS PERSON AND MOVED INTO THEM AT THE NEXT UNLOCK', async () => {
    const { sent } = aDeployment({ keyBundle: 'another-company' });
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    await keyring.rememberCompanyThatPaysYou(BEFORE_UNLOCK);
    expect(sent('PUT /api/me/keys')).toHaveLength(0);
    expect(keyring.companiesThatPayYou()).toEqual([BEFORE_UNLOCK]);
    await keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(), US);
    await keyring.bringCompaniesThatPayYouAcross();
    const writes = sent('PUT /api/me/keys');
    /* RED WHEN what this browser held is never moved into the saved keys. */
    expect(writes).toHaveLength(1);
    expect(JSON.parse(unseal(writes[0].body.keyBundle, keyringHex())).paidBy).toEqual([BEFORE_UNLOCK]);
    expect(localStorage.length).toBe(0);
    expect(keyring.companiesThatPayYou()).toEqual([BEFORE_UNLOCK]);
  });

  it('SOMEBODY ELSE SIGNED IN IN THIS BROWSER IS NOT SHOWN THEM, AND NOBODY SIGNED IN IS SHOWN NOTHING', async () => {
    aDeployment({ keyBundle: 'another-company' });
    /* Another person's list, held in this browser for them. */
    localStorage.setItem('payslip-companies-of:usr_someone_else', JSON.stringify([ACME]));
    /* And the list from before lists were kept per person. */
    localStorage.setItem('payslip-companies', JSON.stringify([ACME]));
    await signInAndOpenKeys();
    /* RED WHEN a list is shown to whoever signs in next, rather than to the person it is for. */
    expect(keyring.companiesThatPayYou()).toEqual([]);
    /* Their own list is shown to them, and to nobody once they are signed out. */
    await keyring.rememberCompanyThatPaysYou(BEFORE_UNLOCK);
    expect(keyring.companiesThatPayYou()).toEqual([BEFORE_UNLOCK]);
    keyring.forgetLocally();
    /* RED WHEN the list outlives the sign-in in this tab. */
    expect(keyring.companiesThatPayYou()).toEqual([]);
  });

  it('A SAVE REFUSED BECAUSE THE KEYS CHANGED ELSEWHERE IS SAID, AND NOT QUIETLY KEPT IN THIS BROWSER', async () => {
    aDeployment({ keyBundle: 'another-company', bundleWriteRefused: true });
    await signInAndOpenKeys();
    /* RED WHEN every refusal falls back to this browser, leaving this tab writing over newer keys. */
    await expect(keyring.rememberCompanyThatPaysYou(ACME)).rejects.toThrow(/changed on another device/);
    expect(localStorage.length).toBe(0);
  });

  it('ONCE THE SAVED KEYS ARE OPEN, THE COMPANIES THAT PAY YOU ARE STILL LISTED, BESIDE THE ONES YOU SIGN FOR', async () => {
    aDeployment({ keyBundle: 'another-company' });
    await signInAndOpenKeys();
    const { AccountPicker } = await import('./Auth.js');
    const { container } = render(
      <AccountPicker
        user={{ id: PERSON, email: null, name: '' }} busy={false}
        accounts={[{ id: 'acc_other', name: 'Globex', signers: 1, threshold: 1, wiring: 'chain' }]}
        onOpen={() => {}} onUnlock={() => {}} onCreateWithWallet={() => {}}
        onFinishSetup={() => {}} awaitingSetup={null} onDemo={() => {}} onSignOut={() => {}}
        employers={[ACME]} onOpenEmployer={() => {}} onAddEmployer={() => {}} onUnlockEmployers={() => {}} />);
    expect(container.querySelector('h1')?.textContent).toBe('Your accounts');
    /* RED WHEN the unlocked face drops the companies that pay you. */
    const paying = container.querySelectorAll('[data-employer]');
    expect(paying).toHaveLength(1);
    expect(paying[0].textContent).toContain('A company that pays you');
    expect(container.textContent).toContain('Globex');
    /* Nothing to unlock once the keys are open. */
    expect(container.querySelector('[data-unlock-employers]')).toBeNull();
  });
});

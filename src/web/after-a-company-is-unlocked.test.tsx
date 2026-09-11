// @vitest-environment jsdom
/**
 * **WHAT THE COMPANY PICKER DOES ONCE A WALLET HAS RELEASED A KEY.**
 *
 * The picker has two faces and chooses between them by whether this tab holds
 * a released key. Before any unlock it shows the wallet's face: one *Unlock*
 * per company and a creation form that asks the wallet. After an unlock it
 * shows the other face: company names, *Open*, and the ordinary creation form.
 *
 * Every person here signs in with a wallet, and a wallet sign-in stores a
 * person with an empty name. So the other face is reached by exactly the people
 * who have just pressed *Unlock*, and what it sends and says is what they meet:
 *
 *   1. its creation form posted the person's stored name as the signer's name,
 *      which is empty for every wallet sign-in and which the server refuses -
 *      and a company started there would have its only keys saved under the
 *      key of the company just unlocked. So the form is shown disabled, with
 *      its reason, and sends nothing;
 *   2. a failure on it must reach the screen, because a press that fails in
 *      silence is pressed again and again;
 *   3. a company it cannot open must say what this tab actually read, not that
 *      the keys are *not on this device*, which sends a person looking for a
 *      device that has them.
 *
 * The wallet at the other end is the wallet's own code answering over the real
 * conversation, as in `src/core/wallet-unlock.test.ts`, so the key this tab
 * holds is a key the wallet really released.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import type { Ask, UnlockRequest } from 'midnight-identity/profile/request';
import { READY_PING } from 'midnight-identity/profile/channel';
import { releaseFor } from 'midnight-identity/profile/unlock';
import { seal, toHex, unseal } from '../core/crypto.js';
import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import { unlockAsk, UNLOCK_PURPOSE } from '../core/wallet-unlock.js';
import type { Openable } from './wallet-sign-in.js';
import * as keyring from './keyring.js';

const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const ACME = 'a1'.repeat(32);
const AT = 1_756_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);

class WalletAtTheOtherEnd implements Openable {
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };
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
    const ask = parseAsk(message, US, AT);
    queueMicrotask(() => this.deliver(
      ask.kind === 'unlock' ? releaseFor(identity, ask as UnlockRequest, AT) : { schema: 'a-sign-in' }));
  }
}

/** The key the wallet above releases for `ACME`, worked out the wallet's way. */
const releasedHex = () => {
  const ask = parseAsk(unlockAsk({
    name: 'n', rdns: 'r', purpose: UNLOCK_PURPOSE, nonce: 'n', expiresAt: AT + 60_000, company: ACME,
  }), US, AT) as Ask;
  return toHex(unlockKeyFor(identity, ask as UnlockRequest));
};

/** Key material this person sealed for a seat before its leaf was published, and has not promoted. */
const PENDING = {
  accountId: 'acc_seated', signingPublicKey: '12'.repeat(32), signingSecret: '34'.repeat(32),
  wrappingSecret: '56'.repeat(32), blinding: '78'.repeat(32), scope: '9a'.repeat(32),
};

/** A company record as the list and the single read serve it: sealed, and this person on it. */
const LOCKED = { id: 'acc_1', signerCount: 1, threshold: 1, wrappedKeys: [], wiring: 'chain' };

interface Deployment {
  /** What `GET /api/me/keys` answers: nothing saved, or a bundle that holds other companies. */
  keyBundle: 'none' | 'another-company' | 'a-pending-seat';
  /** Whether saving the key bundle is refused, as it is when another tab or device wrote first. */
  bundleWriteRefused?: boolean;
  /** Held until the test lets it through, so something can happen while a write is on its way. */
  bundleWriteHeld?: Promise<void>;
  /** What the sign-in answer says about whether this address was new here. */
  created?: boolean;
}

const realFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = realFetch; keyring.forgetLocally(); });

/**
 * A server that answers the way the real one does for these routes, including
 * the one rule that matters here: `POST /api/accounts` refuses a signer with no
 * name, with the schema's own words.
 */
function aDeployment(d: Deployment) {
  const posted: Array<{ url: string; body: any }> = [];
  let onPost: (b: any) => void = () => {};
  const createPosted = new Promise<any>((resolve) => { onPost = resolve; });
  const bundle = d.keyBundle === 'none'
    ? null
    : seal(JSON.stringify({ accounts: { acc_other: {
      signerId: 'sgn_x', signingSecret: 'aa'.repeat(32), wrappingSecret: 'bb'.repeat(32),
      blinding: 'cc'.repeat(32),
    } }, ...(d.keyBundle === 'a-pending-seat' ? { pendingSeats: { [PENDING.signingPublicKey]: PENDING } } : {}) }),
    releasedHex());
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    posted.push({ url: `${method} ${url}`, body });
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    const user = { id: 'usr_1', email: null, name: '' };
    switch (`${method} ${url}`) {
      case 'POST /api/auth/wallet/challenge':
        return json(200, { nonce: 'nonce', handle: 'h', expiresAt: new Date(AT + 60_000).toISOString() });
      case 'POST /api/auth/wallet':
        return json(200, { user, address: 'mn_shield-addr', created: d.created ?? false, session: {} });
      case 'GET /api/me': return json(200, { user, accounts: [LOCKED] });
      case 'GET /api/accounts': return json(200, [LOCKED]);
      case 'GET /api/accounts/acc_1': return json(200, LOCKED);
      case 'POST /api/accounts/acc_1/unlock': return json(200, { company: ACME });
      case 'POST /api/accounts/acc_new/unlock': return json(200, { company: 'b2'.repeat(32) });
      case 'PUT /api/me/keys':
        if (d.bundleWriteHeld) await d.bundleWriteHeld;
        return d.bundleWriteRefused
          ? json(409, { error: 'the keys changed on another device since this tab read them' })
          : json(200, { version: 1 });
      case 'GET /api/me/keys': return json(200, { keyBundle: bundle, version: bundle ? 1 : 0 });
      case 'POST /api/accounts': {
        onPost(body);
        if (!body?.signers?.[0]?.name) {
          return json(400, { error: 'Too small: expected string to have >=1 characters' });
        }
        return json(200, {
          account: { id: 'acc_new' },
          secrets: [{ signerId: 'sgn_new', signingSecret: 'dd'.repeat(32), wrappingSecret: 'ee'.repeat(32), blinding: 'ff'.repeat(32) }],
        });
      }
      default: return json(404, { error: `no route for ${method} ${url}` });
    }
  }) as typeof fetch;
  return { posted, createPosted };
}

/** Sign in, and press *Unlock* on the one company, the way the picker's wallet face does. */
async function signInAndUnlock() {
  const view = new WalletAtTheOtherEnd();
  await keyring.signInWithWallet(WALLET, undefined, view);
  await keyring.unlockWithWallet('acc_1', WALLET, view, US);
  expect(keyring.canOpenCompanies(), 'the unlock itself worked').toBe(true);
}

async function thePage() {
  const { default: App } = await import('./App.js');
  const { SimulatedCommitments } = await import('../core/ledger.js');
  return render(<App commitments={SimulatedCommitments} />);
}

describe('once a wallet has released a key, starting a company', () => {
  it('IS SHOWN DISABLED WITH ITS REASON, and a submitted form sends nothing to the server', async () => {
    const { posted } = aDeployment({ keyBundle: 'none' });
    await signInAndUnlock();
    const { container } = await thePage();
    const form = await waitFor(() => {
      const found = container.querySelector('form.acctnew');
      expect(found).toBeTruthy();
      return found as HTMLFormElement;
    });
    const input = form.querySelector('input') as HTMLInputElement;
    const button = form.querySelector('button') as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    /* A name long enough to enable the button on any other screen, so the
     * button is disabled here for the reason and not for the length. */
    fireEvent.change(input, { target: { value: 'Acme Ltd' } });
    expect(input.value).toBe('Acme Ltd');
    expect(button.disabled).toBe(true);
    const reason = container.querySelector('[data-no-company-here]')?.textContent ?? '';
    expect(reason).toContain('a new company\'s keys would be saved under that company\'s key');
    expect(reason).toContain('Sign out, sign in again, and start the company before unlocking one.');

    fireEvent.submit(form);
    /* Read at once: a create would have called fetch inside this same turn,
     * before its first await. */
    expect(posted.map((p) => p.url)).not.toContain('POST /api/accounts');
  });

  it('for a person who has keys saved already, says there is no safe way from this tab yet', async () => {
    aDeployment({ keyBundle: 'another-company' });
    await signInAndUnlock();
    const why = keyring.whyNoCompanyCanStartHere() ?? '';
    expect(why).toContain('is not available yet');
    expect(why).not.toContain('Sign out, sign in again');
  });

  it('and a tab that has unlocked nothing is not stopped', async () => {
    aDeployment({ keyBundle: 'none' });
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    expect(keyring.whyNoCompanyCanStartHere()).toBeNull();
  });
});

describe('a company this tab started and could not finish', () => {
  /*
   * Starting a company on the wallet's face unlocks the new company BEFORE its
   * keys are saved, so a refused save leaves this tab holding a released key -
   * which puts the picker on its other face - and holding the company's only
   * keys. That face must keep the way to finish it, and must not tell the
   * person to sign out, which would drop those keys.
   */
  it('KEEPS FINISH ON SCREEN, and does not tell the person to sign out', async () => {
    aDeployment({ keyBundle: 'none', bundleWriteRefused: true });
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    await expect(keyring.createCompanyWithWallet(
      { name: 'Acme Ltd', signers: [{ name: 'You', role: 'admin' }], threshold: 1 },
      WALLET, new WalletAtTheOtherEnd(), US)).rejects.toThrow(/changed on another device/);
    expect(keyring.companyAwaitingSetup()).toBe('acc_new');
    expect(keyring.canOpenCompanies(), 'this tab now holds a released key').toBe(true);

    const why = keyring.whyNoCompanyCanStartHere() ?? '';
    expect(why).toContain('A company this tab started is not finished');
    expect(why).not.toMatch(/Sign out, sign in again/);

    const { AccountPicker } = await import('./Auth.js');
    const { container } = render(
      <AccountPicker
        user={{ id: 'usr_1', email: null, name: '' }} accounts={[]} busy={false}
        onOpen={() => {}} onUnlock={() => {}} onCreate={() => {}} onCreateWithWallet={() => {}}
        onFinishSetup={() => {}} awaitingSetup={keyring.companyAwaitingSetup()} onDemo={() => {}} onSignOut={() => {}} />);
    expect(container.textContent).toContain('Your accounts');
    expect(container.querySelector('[data-awaiting-setup]')).not.toBeNull();
    expect(container.textContent).toContain('Finish setting up');
    expect(container.textContent).toContain('do not close this tab');
  });
});

describe('what the keyring knows about the keys saved for this person', () => {
  it('nothing is claimed before an unlock, and a fresh sign-in or a sign-out forgets what an unlock read', async () => {
    aDeployment({ keyBundle: 'none' });
    const nothingRead = keyring.lockedCompanyReason('acc_1');
    expect(nothingRead).toMatch(/has not opened/);
    await signInAndUnlock();
    expect(keyring.lockedCompanyReason('acc_1')).toMatch(/no keys were saved for you here/);

    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    expect(keyring.lockedCompanyReason('acc_1'), 'a new sign-in has read nothing yet').toBe(nothingRead);

    await keyring.unlockWithWallet('acc_1', WALLET, new WalletAtTheOtherEnd(), US);
    keyring.forgetLocally();
    expect(keyring.lockedCompanyReason('acc_1'), 'a tab that forgot has read nothing').toBe(nothingRead);
  });

  it('once this tab saves keys for a person who had none, they are no longer described as having none', async () => {
    const { posted } = aDeployment({ keyBundle: 'none' });
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(init?.method) === 'PUT' && url === '/api/me/keys') {
        posted.push({ url: 'PUT /api/me/keys', body: undefined });
        return { ok: true, status: 200, json: async () => ({ version: 1 }) } as Response;
      }
      return real(url, init);
    }) as typeof fetch;
    await signInAndUnlock();
    await keyring.rememberAccount('acc_new', {
      signerId: 'sgn_new', signingSecret: 'dd'.repeat(32), wrappingSecret: 'ee'.repeat(32), blinding: 'ff'.repeat(32),
    } as never);
    expect(posted.map((p) => p.url)).toContain('PUT /api/me/keys');
    expect(keyring.lockedCompanyReason('acc_1')).toMatch(/do not include this company/);
  });

  it('a company whose keys ARE here and did not open is not described as missing its keys', async () => {
    aDeployment({ keyBundle: 'another-company' });
    await signInAndUnlock();
    expect(keyring.keysFor('acc_other')).not.toBeNull();
    expect(keyring.lockedCompanyReason('acc_other')).toBe('it did not open with the keys saved for you');
    expect(keyring.lockedCompanyRefusal('acc_other')).toContain('you may not have been given access to it yet');
  });
});

describe('once a wallet has released a key, a company this tab cannot open', () => {
  it('WITH NOTHING SAVED AT ALL: says what this tab read, and does not send the person to another device', async () => {
    const { posted } = aDeployment({ keyBundle: 'none' });
    await signInAndUnlock();
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
    expect(lines).toContain('Signed in as mn_shield-addr');

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
    expect(said).toMatch(/only if keys for it are saved for you - by the tab that created it finishing setting it up/);
    expect(said).toMatch(/this tab has been unlocked again since/);
    /* The conditions are conditions: a company whose keys are never saved is said to be unopenable. */
    expect(said).toMatch(/or the company was made by something that kept no keys for you, nothing can open it/);
    expect(said).not.toMatch(/accepting an invitation/);
  });

  it('WITH OTHER COMPANIES SAVED: says the saved keys, as this tab read them, do not include this one', async () => {
    aDeployment({ keyBundle: 'another-company' });
    await signInAndUnlock();
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
    /* With keys saved under another company's key, no Finish or invitation can add this one's. */
    expect(said).toMatch(/cannot be saved beside them yet, so nothing here can open this one/);
    expect(said).not.toMatch(/finishing setting it up/);
  });
});

describe('what the second face says when something it asks for fails', () => {
  it('REACHES THE SCREEN', async () => {
    aDeployment({ keyBundle: 'none' });
    await signInAndUnlock();
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
  const NEW_KEYS = {
    signerId: 'sgn_new', signingSecret: 'dd'.repeat(32), wrappingSecret: 'ee'.repeat(32), blinding: 'ff'.repeat(32),
  };
  /** Everything the keyring would give out about the list, taken as one value. */
  const theList = () => JSON.stringify({
    other: keyring.keysFor('acc_other'), added: keyring.keysFor('acc_new'),
    seated: keyring.keysFor('acc_seated'), pending: keyring.pendingSeatsFor('acc_seated'),
    fresh: keyring.pendingSeatsFor('acc_fresh'),
  });

  it('ADDING A COMPANY\'S KEYS: refused, and the tab does not hold them', async () => {
    aDeployment({ keyBundle: 'another-company', bundleWriteRefused: true });
    await signInAndUnlock();
    const before = theList();
    await expect(keyring.rememberAccount('acc_new', NEW_KEYS as never)).rejects.toThrow(/changed on another device/);
    expect(keyring.keysFor('acc_new')).toBeNull();
    expect(theList()).toBe(before);
    expect(keyring.openAccount({ id: 'acc_new', wrappedKeys: [] } as never)).toBeNull();
  });

  it('SEALING A SEAT BEFORE ITS LEAF IS SENT: refused, and nothing is pending', async () => {
    aDeployment({ keyBundle: 'another-company', bundleWriteRefused: true });
    await signInAndUnlock();
    const before = theList();
    await expect(keyring.sealPendingSeat({ ...PENDING, accountId: 'acc_fresh', signingPublicKey: '13'.repeat(32) }))
      .rejects.toThrow(/changed on another device/);
    expect(keyring.pendingSeatsFor('acc_fresh')).toEqual([]);
    expect(theList()).toBe(before);
  });

  it('PROMOTING A SEAT: refused, and the seat is still pending and not promoted', async () => {
    aDeployment({ keyBundle: 'a-pending-seat', bundleWriteRefused: true });
    await signInAndUnlock();
    expect(keyring.pendingSeatsFor('acc_seated'), 'the pending seat was read').toHaveLength(1);
    const before = theList();
    await expect(keyring.promotePendingSeat(PENDING.signingPublicKey, 'sgn_seated')).rejects.toThrow(/changed on another device/);
    expect(keyring.keysFor('acc_seated')).toBeNull();
    expect(keyring.pendingSeatsFor('acc_seated')).toHaveLength(1);
    expect(theList()).toBe(before);
  });

  it('and the NEXT write the tab makes does not carry what was refused', async () => {
    const d: Deployment = { keyBundle: 'another-company', bundleWriteRefused: true };
    const { posted } = aDeployment(d);
    await signInAndUnlock();
    await expect(keyring.rememberAccount('acc_new', NEW_KEYS as never)).rejects.toThrow();
    d.bundleWriteRefused = false;
    await keyring.rememberAccount('acc_later', { ...NEW_KEYS, signerId: 'sgn_later' } as never);
    const writes = posted.filter((p) => p.url === 'PUT /api/me/keys');
    const saved = JSON.parse(unseal(writes[writes.length - 1]!.body.keyBundle, releasedHex()));
    expect(Object.keys(saved.accounts).sort()).toEqual(['acc_later', 'acc_other']);
  });

  it('a write that lands after the tab READ THE KEYS AGAIN is not put over what it read', async () => {
    let letItThrough: () => void = () => {};
    const bundleWriteHeld = new Promise<void>((resolve) => { letItThrough = resolve; });
    aDeployment({ keyBundle: 'another-company', bundleWriteHeld });
    await signInAndUnlock();
    const writing = keyring.rememberAccount('acc_new', NEW_KEYS as never);
    await Promise.resolve();
    await keyring.unlockWithWallet('acc_1', WALLET, new WalletAtTheOtherEnd(), US);
    letItThrough();
    await writing;
    expect(keyring.keysFor('acc_other'), 'what the unlock read is what this tab holds').not.toBeNull();
    expect(keyring.keysFor('acc_new')).toBeNull();
  });

  it('a write that lands AFTER the tab has signed out does not bring the keys back', async () => {
    let letItThrough: () => void = () => {};
    const bundleWriteHeld = new Promise<void>((resolve) => { letItThrough = resolve; });
    aDeployment({ keyBundle: 'another-company', bundleWriteHeld });
    await signInAndUnlock();
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
  const picker = async () => {
    const { AccountPicker } = await import('./Auth.js');
    const { container } = render(
      <AccountPicker
        user={{ id: 'usr_1', email: null, name: '' }} accounts={[]} busy={false}
        onOpen={() => {}} onUnlock={() => {}} onCreate={() => {}} onCreateWithWallet={() => {}}
        onFinishSetup={() => {}} awaitingSetup={keyring.companyAwaitingSetup()} onDemo={() => {}} onSignOut={() => {}} />);
    return container.querySelector('[data-awaiting-setup]')!;
  };
  /** From the `from`th read on, GET /api/me/keys answers keys sealed under another key. */
  const keysSavedElsewhereFrom = (from: number) => {
    const real = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(init?.method ?? 'GET') === 'GET' && url === '/api/me/keys' && (reads += 1) >= from) {
        return { ok: true, status: 200, json: async () => ({ keyBundle: seal('{}', 'ab'.repeat(32)), version: 1 }) } as Response;
      }
      return real(url, init);
    }) as typeof fetch;
  };

  it('WHEN A SAVE WAS REFUSED AND THE KEYS SAVED SINCE DO NOT OPEN: says it cannot be finished, with Finish disabled, and does not say nothing is lost', async () => {
    aDeployment({ keyBundle: 'none', bundleWriteRefused: true });
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    keysSavedElsewhereFrom(3);
    await expect(keyring.createCompanyWithWallet(
      { name: 'Acme Ltd', signers: [{ name: 'You', role: 'admin' }], threshold: 1 },
      WALLET, new WalletAtTheOtherEnd(), US)).rejects.toThrow(/changed on another device/);
    const block = await picker();
    expect(block.hasAttribute('data-cannot-finish')).toBe(true);
    expect(block.textContent).toContain('cannot be finished');
    expect(block.textContent).toContain('closing this tab or signing out loses this company for good');
    expect(block.textContent).not.toMatch(/Nothing is lost/);
    expect(block.textContent).not.toMatch(/until it has/);
    expect((block.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('WHEN AN UNLOCK FOUND KEYS THAT DID NOT OPEN: names both causes, and keeps Finish pressable', async () => {
    aDeployment({ keyBundle: 'none' });
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    keysSavedElsewhereFrom(2);
    await expect(keyring.createCompanyWithWallet(
      { name: 'Acme Ltd', signers: [{ name: 'You', role: 'admin' }], threshold: 1 },
      WALLET, new WalletAtTheOtherEnd(), US)).rejects.toThrow(/different company/);
    const block = await picker();
    expect(block.hasAttribute('data-may-not-finish')).toBe(true);
    expect(block.textContent).toContain('it can never be finished');
    expect(block.textContent).toContain('finishing with the wallet you signed in with can still work');
    expect(block.textContent).not.toMatch(/Nothing is lost/);
    expect((block.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('before any unlock, for a person who already has keys saved', () => {
  it('STARTING A COMPANY IS SHOWN DISABLED WITH ITS REASON, and a submitted form sends nothing', async () => {
    const { posted } = aDeployment({ keyBundle: 'another-company' });
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    const { container } = await thePage();
    const reason = await waitFor(() => {
      const found = container.querySelector('[data-no-company-here]');
      expect(found).toBeTruthy();
      return found!.textContent ?? '';
    });
    expect(reason).toContain('a company cannot be started with this wallet address yet');
    expect(reason).toContain('could never be finished');
    const form = container.querySelector('form.acctnew') as HTMLFormElement;
    expect((form.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(form.querySelector('input')!, { target: { value: 'Acme Ltd' } });
    expect((form.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    const sentBefore = posted.length;
    fireEvent.submit(form);
    /* Nothing at all, read at once: a journey starts its first request before its first await,
     * and reports what stopped it on the screen. */
    expect(posted.length).toBe(sentBefore);
    expect(container.querySelector('.autherr')).toBeNull();
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

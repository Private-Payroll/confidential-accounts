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
import { seal, toHex } from '../core/crypto.js';
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

/** A company record as the list and the single read serve it: sealed, and this person on it. */
const LOCKED = { id: 'acc_1', signerCount: 1, threshold: 1, wrappedKeys: [], wiring: 'chain' };

interface Deployment {
  /** What `GET /api/me/keys` answers: nothing saved, or a bundle that holds other companies. */
  keyBundle: 'none' | 'another-company';
  /** Whether saving the key bundle is refused, as it is when another tab or device wrote first. */
  bundleWriteRefused?: boolean;
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
    } } }), releasedHex());
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
    expect(said).toMatch(/by the tab that created it finishing setting it up, or by accepting an invitation to it/);
    expect(said).toMatch(/this tab has been unlocked again since/);
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

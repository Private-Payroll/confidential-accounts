// @vitest-environment jsdom
/**
 * **A SIGNER'S INVITATION IS A LINK TO THIS SITE, AND THE PERSON INVITED
 * ACCEPTS IT ON THEIR OWN DEVICE.**
 *
 * The first half is the inviting signer's screen: the link it shows is this
 * page's own address with the token in the fragment, and the screen has no
 * control that accepts the invitation on the inviter's behalf.
 *
 * The second half is the invited person, standing in for a second browser: a
 * fresh copy of the page's modules, with its own keyring, its own sign-in and
 * its own server, opened at the link the first half showed. They sign in,
 * accept, and their keys are made and saved there. What is checked is every
 * request that page made: the keys' public halves, the leaf and the proof went
 * out, and no secret of theirs - nor the secret in the link - did.
 *
 * The two halves share nothing but the link. It is a copy of the page's
 * modules and not a second browser process, and that is said rather than
 * implied.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { READY_PING } from 'midnight-identity/profile/channel';
import { keyringKeyFor, keyringReleaseFor } from 'midnight-identity/profile/unlock';
import { signingPublicKeyOf, toHex, unseal, type Hex } from '../core/crypto.js';
import { keyringAsk, KEYRING_PURPOSE } from '../core/wallet-unlock.js';
import { refuseASeatKeyNotFromTheInvitee, seatInvitationFromFragment } from '../core/seat-invite-proof.js';
import type { Openable } from './wallet-sign-in.js';

const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const SIGNED_IN = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const INVITEE = 'usr_dora';
const COMPANY = 'acc_1';
const VK = 'aa'.repeat(32) as Hex;
const TOKEN = 'inv_TheRawTokenForDora';
const identity = identityFromWords(TEST_MNEMONIC);

/** A wallet that gives the keyring key from its own words, and only for an address it holds. */
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
    let answer: unknown;
    try {
      const ask = parseAsk(message, US, Date.now());
      answer = ask.kind === 'keyring'
        ? keyringReleaseFor(identity, ask as KeyringRequest, Date.now(), (a) => a === SIGNED_IN)
        : { schema: 'a-sign-in' };
    } catch {
      answer = { schema: 'nothing-given' };
    }
    queueMicrotask(() => this.deliver(answer));
  }
}

vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'https://wallet.example'); });
/* The keyring's asks are answered by the wallet above rather than a window, in every copy of the page. */
vi.mock('./keyring.js', async (original) => {
  const real = await original<typeof import('./keyring.js')>();
  return {
    ...real,
    openKeysWithWallet: (origin: string) => real.openKeysWithWallet(origin, new WalletAtTheOtherEnd(), US),
    signInWithWallet: (origin: string, token?: string) => real.signInWithWallet(origin, token, new WalletAtTheOtherEnd()),
  };
});

/** The keyring key the wallet above gives the invited person. */
const keyringHex = () => toHex(keyringKeyFor(identity, parseAsk(keyringAsk({
  name: 'n', rdns: 'r', purpose: KEYRING_PURPOSE, nonce: 'n', expiresAt: Date.now() + 60_000,
  person: INVITEE, signedInAs: null, company: null,
}), US, Date.now()) as KeyringRequest));

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup(); globalThis.fetch = realFetch; localStorage.clear();
  window.history.replaceState(null, '', '/');
});

type Request = { method: string; url: string; body: string; headers: string };
const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;

/** The inviting signer's server: raises the invitation and lists it. */
function theInvitersServer() {
  const invite = {
    token: TOKEN, accountId: COMPANY, kind: 'signer', name: 'Dora Diaz', email: 'dora@acme.example', role: 'approver',
    createdAt: '2026-09-26T00:00:00.000Z',
  };
  let raised = false;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    if (method === 'POST' && url === `/api/accounts/${COMPANY}/invites/signer`) { raised = true; return json(200, invite); }
    /* Nothing on the inviter's screen may accept the invitation or save anybody's keys; asking is written down. */
    if (url.includes('accept-signer') || url.includes('/api/me/keys')) asked.push(`${method} ${url}`);
    if (method === 'GET' && url === `/api/accounts/${COMPANY}/invites`) {
      const { token: _t, ...listed } = invite;
      return json(200, raised ? [{ ...listed, redeemed: false }] : []);
    }
    return json(404, { error: `no route for ${method} ${url}` });
  }) as typeof fetch;
  return { asked };
}

/** The invited person's server, which writes down every request their page makes. */
function theInviteesServer() {
  const requests: Request[] = [];
  let bundle: unknown = null;
  let version = 0;
  let signedIn = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    const raw = init?.body === undefined ? '' : String(init.body);
    requests.push({ method, url, body: raw, headers: JSON.stringify(init?.headers ?? {}) });
    const body = raw ? JSON.parse(raw) : undefined;
    const user = { id: INVITEE, email: null, name: '' };
    switch (`${method} ${url}`) {
      case 'POST /api/auth/wallet/challenge':
        return json(200, { nonce: 'nonce', handle: 'h', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      case 'POST /api/auth/wallet': signedIn = true; return json(200, { user, address: SIGNED_IN, created: true, session: {} });
      /* Nobody is signed in on this page until the wallet signs them in here. */
      case 'GET /api/me': return signedIn ? json(200, { user, accounts: [] }) : json(401, { error: 'not signed in' });
      case 'GET /api/accounts': return json(200, []);
      case 'GET /api/me/keys': return json(200, { keyBundle: bundle, version });
      case 'PUT /api/me/keys': bundle = body.keyBundle; version += 1; return json(200, { version });
      case `POST /api/invites/${TOKEN}/accept-signer`:
        return json(200, { id: 'sgn_dora', status: 'pending', name: 'Dora Diaz', role: 'approver', ...body });
      default: return json(404, { error: `no route for ${method} ${url}` });
    }
  }) as typeof fetch;
  return { requests, saved: () => JSON.parse(unseal(bundle as never, keyringHex())) };
}

const button = (container: HTMLElement, text: RegExp) => waitFor(() => {
  const b = [...container.querySelectorAll('button')].find(x => text.test(x.textContent ?? ''));
  expect(b, String(text)).toBeTruthy();
  return b as HTMLButtonElement;
});

describe('A SIGNER\'S INVITATION, FROM THE INVITER\'S SCREEN TO THE INVITEE\'S OWN DEVICE', () => {
  it('1, 4 and 2. the inviter\'s screen shows a link to this site and cannot accept it; the invitee accepts on a page of their own, and nothing secret is sent', async () => {
    const inviters = theInvitersServer();
    const { Settings } = await import('./App.js');
    const { SimulatedCommitments } = await import('../core/ledger.js');
    const account = {
      id: COMPANY, name: 'Acme Ltd', policy: { threshold: 1 }, wrappedKeys: [],
      signers: [{ id: 'sgn_ada', name: 'Ada', role: 'admin', status: 'active', signingPublicKey: '12'.repeat(32),
        wrappingPublicKey: '34'.repeat(32), leafCommitment: '56'.repeat(32), userId: 'usr_ada' }],
    };
    const { container } = render(<Settings
      account={account as never} state={{} as never} me={{ signerId: 'sgn_ada' } as never}
      session={{ account, viewingKey: VK, secrets: [], employees: [], seat: {} } as never}
      busy={false} act={async (fn) => { await fn(); }} commitments={SimulatedCommitments} />);
    fireEvent.click(await button(container, /^Invite signer$/));
    const inputs = [...container.querySelectorAll('input')];
    /* Typed untidily: the service records 'Dora Diaz', and the link must be made for what it records. */
    fireEvent.change(inputs.find(i => i.placeholder === 'Rae Solomon')!, { target: { value: '  dora diaz ' } });
    fireEvent.change(inputs.find(i => i.placeholder === 'rae@northwind.co')!, { target: { value: 'dora@acme.example' } });
    fireEvent.click(await button(container, /^Create invite$/));
    const shown = await waitFor(() => {
      const input = container.querySelector('[data-signer-link]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      return input!.value;
    });
    const url = new URL(shown);
    /* RED WHEN: the link names any host but this page's own - the placeholder host, for one. */
    expect(url.origin).toBe(window.location.origin);
    /* RED WHEN: the link opens any page but the join page. */
    expect(url.pathname).toBe('/join');
    /* RED WHEN: the token is in the query, where it reaches every request log on the way. */
    expect(url.search).not.toContain(TOKEN);
    const read = seatInvitationFromFragment(decodeURIComponent(url.hash.replace(/^#/, '')));
    /* RED WHEN: the fragment carries any token but the one the service raised. */
    expect(read?.token).toBe(TOKEN);
    /* RED WHEN: the fragment names another company - the invitee's proof is then made for it and refused. */
    expect(read?.invitation.accountId).toBe(COMPANY);
    /* RED WHEN: the inviter's screen offers to accept the invitation itself, making the invitee's keys in this browser. */
    const card = [...container.querySelectorAll('.card')].find(c => c.querySelector('h3')?.textContent === 'Open invites')!;
    expect(card.textContent).toContain('Dora Diaz');
    expect(card.querySelectorAll('button')).toHaveLength(0);
    /* RED WHEN: raising the invitation also accepts it, or saves keys, from the inviter's own browser. */
    expect(inviters.asked).toEqual([]);
    const theLink = shown;
    cleanup();

    /* ── 2. THE INVITED PERSON, ON A PAGE OF THEIR OWN ── */
    /* The modules are loaded afresh, so nothing the inviter's page held is here. */
    vi.resetModules();
    const { default: App } = await import('./App.js');
    const { SimulatedCommitments: theirScheme } = await import('../core/ledger.js');
    const { requests, saved } = theInviteesServer();
    const opened = new URL(theLink);
    window.history.replaceState(null, '', `/join${opened.hash}`);
    const { container: page } = render(<App commitments={theirScheme} />);
    /* Signed in on the invitation's own page, with the wallet. */
    fireEvent.click(await button(page, /^Sign in with your wallet$/));
    /* RED WHEN: the join page does not take a signer's invitation. */
    fireEvent.click(await waitFor(() => {
      const b = page.querySelector('[data-accept-signer]') as HTMLButtonElement | null;
      expect(b).not.toBeNull();
      return b!;
    }));
    await waitFor(() => expect(page.querySelector('[data-signer-accepted]')).not.toBeNull());

    const accepted = requests.filter(r => r.method === 'POST' && r.url === `/api/invites/${TOKEN}/accept-signer`);
    expect(accepted).toHaveLength(1);
    const sentBody = JSON.parse(accepted[0]!.body);
    /* RED WHEN: anything is sent beside the public halves, the leaf and the proof. */
    expect(Object.keys(sentBody).sort()).toEqual(['leafCommitment', 'seatProof', 'signingPublicKey', 'wrappingPublicKey']);
    expect(Object.keys(sentBody.seatProof).sort()).toEqual(['nonce', 'proof']);

    /* The keys were made here and saved under this person's own key. */
    const mine = saved().accounts[COMPANY];
    expect(mine.signerId).toBe('sgn_dora');
    /* RED WHEN: the key sent is not the one whose secret this page made and kept. */
    expect(sentBody.signingPublicKey).toBe(signingPublicKeyOf(mine.signingSecret));

    /* RED WHEN: any secret of this person's, or the secret in the link, is in any request this page made. */
    const everything = requests.map(r => `${r.url} ${r.headers} ${r.body}`).join('\n').toLowerCase();
    const link = seatInvitationFromFragment(decodeURIComponent(opened.hash.replace(/^#/, '')))!;
    for (const secret of [mine.signingSecret, mine.wrappingSecret, mine.blinding, link.invitation.secret]) {
      expect(everything).not.toContain(String(secret).toLowerCase());
    }

    /* The proof is one every signer's device takes, worked out again from the viewing key. */
    expect(() => refuseASeatKeyNotFromTheInvitee(VK, COMPANY, { ...sentBody, name: 'Dora Diaz', role: 'approver' }))
      .not.toThrow();

    /* ── AND COMING BACK TO THE LINK DOES NOT ACCEPT, OR MAKE KEYS, A SECOND TIME ── */
    cleanup();
    const { container: again } = render(<App commitments={theirScheme} />);
    fireEvent.click(await waitFor(() => {
      const b = again.querySelector('[data-accept-signer]') as HTMLButtonElement | null;
      expect(b).not.toBeNull();
      return b!;
    }));
    /* RED WHEN: a second press makes a second set of keys and sends them, or fails with the keyring's own words. */
    await waitFor(() => expect(again.textContent).toMatch(/already accepted an invitation to this company/u));
    expect(requests.filter(r => r.url.endsWith('/accept-signer'))).toHaveLength(1);
  });
});

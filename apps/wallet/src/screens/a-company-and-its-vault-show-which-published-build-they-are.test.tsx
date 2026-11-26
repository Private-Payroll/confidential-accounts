// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { ComponentProps, ReactNode } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { parseAsk } from 'midnight-identity/profile/request';
import type { BalanceRequest } from 'midnight-identity/profile/request';
import type { ReleasedVersion } from 'midnight-identity/wallet/released-versions';
import { publishedBuildAt, publishedBuildOfState } from '../chain/published-build.js';
import { ADOPT_V2, ADOPT_V3, STRANGER_V2, keyFile, stateHex } from '../chain/registry-entries.test-support.js';
import { act, cleanup, render } from '../testing/render.js';
import EN from '../locales/en.json' with { type: 'json' };
import { BalanceAsk } from './approve-balance-views.js';
import { KeysReaderContext, liveKeysReader } from './build-stamp.js';
import type { KeysReader } from './build-stamp.js';
import { recordingChannel } from '../testing/recording-channel.js';
import { CompanyOnChain, accountCarriesTheLabel } from './company-on-chain.js';
import type { CompanyCheck } from './company-on-chain.js';

/*
 * The line under a company and under a vault says which published build the contract is, and only that. It changes
 * no fingerprint, no check and no press, and a read that did not come back is never read as either answer.
 */
const CO = 'co_7a1e2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8' as CompanyLabel;
const A = 'a1'.repeat(32) as AccountAddress;
const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
const DEPOSIT = keyFile('v3', 19);
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/* Version 7 of the account (both slots of `adopt`) and of the vault (one slot of `deposit`). */
const VERSIONS: readonly ReleasedVersion[] = [{
  version: 7, reachedFrom: [], openRunsFinishFirst: false, withdrawn: false,
  keys: {
    account: { adopt: { v2: hexOf(sha256(ADOPT_V2)), v3: hexOf(sha256(ADOPT_V3)) } },
    vault: { deposit: { v3: hexOf(sha256(DEPOSIT)) } },
    registry: { put: { v3: hexOf(sha256(keyFile('v3', 3))) } },
  },
}];

const THE_BUILD = stateHex({ adopt: [ADOPT_V2, ADOPT_V3] });
const A_HIDDEN_KEY = stateHex({ adopt: [STRANGER_V2, ADOPT_V3] });
const THE_VAULT = stateHex({ deposit: [DEPOSIT] });
const A_HIDDEN_KEY_IN_THE_VAULT = stateHex({ deposit: [STRANGER_V2, DEPOSIT] });

/** A reader as the wallet's own, over a chain that answers with `answer` at every address. */
const reading = (answer: () => Promise<string | null>): KeysReader => (address, contract) =>
  publishedBuildAt(answer, address, contract, VERSIONS);
const answering = (hex: string | null): KeysReader => reading(() => Promise.resolve(hex));

const carries: CompanyCheck = { of: 'carries', label: CO };
/* The only way a screen is handed a reader: the provider above it. */
const under = (readKeys: KeysReader, ui: ReactNode) => <KeysReaderContext.Provider value={readKeys}>{ui}</KeysReaderContext.Provider>;
const words = (key: 'stamp.published' | 'stamp.not-published' | 'stamp.unchecked' | 'stamp.checking', kind: string, version = 7): string =>
  EN[key].replace('{kind}', kind).replace('{version}', String(version));
const company = (readKeys: KeysReader) => under(readKeys, (
  <CompanyOnChain label={CO} account={A} check={carries} doing="signed" compareWith="the person who invited you gave you" />
));
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const stampIn = (c: HTMLElement, contract: string): HTMLElement => c.querySelector(`[data-build-contract="${contract}"]`)!;

afterEach(cleanup);

describe('a company shows which published build its account is', () => {
  it('SHOWS THE VERSION FOR A BUILD\'S KEYS IN EVERY SLOT', async () => {
    const { container } = render(company(answering(THE_BUILD)));
    await settle();
    const stamp = stampIn(container, 'account');
    /* RED WHEN the matcher is not asked, or the version shown is not the released version's id. */
    expect(stamp.getAttribute('data-build-stamp')).toBe('published');
    expect(stamp.textContent).toBe(words('stamp.published', 'account'));
    expect(stamp.textContent).toMatch(/^This account is built from our published code, version 7\./);
  });

  it('SAYS "NOT A PUBLISHED VERSION" WHEN ONE SLOT HOLDS A KEY NO RELEASED VERSION HAS', async () => {
    const { container } = render(company(answering(A_HIDDEN_KEY)));
    await settle();
    const stamp = stampIn(container, 'account');
    /* RED WHEN only the slot the ledger shows is read: the build's own key in the other slot hides the stranger's. */
    expect(stamp.getAttribute('data-build-stamp')).toBe('not-published');
    expect(stamp.textContent).toBe(words('stamp.not-published', 'account'));
    expect(stamp.textContent).not.toMatch(/version \d/);
  });

  it.each([
    ['a read that is refused', () => Promise.reject(new Error('the indexer answered 503.'))],
    ['an indexer that holds nothing there', () => Promise.resolve(null)],
    ['bytes that are not a contract state', () => Promise.resolve('00ff00ff')],
  ] as const)('SAYS IT COULD NOT CHECK, AND NEITHER VERDICT, FOR %s', async (_what, answer) => {
    const { container } = render(company(reading(answer)));
    await settle();
    const stamp = stampIn(container, 'account');
    /* RED WHEN a read that did not come back is shown as either verdict. */
    expect(stamp.getAttribute('data-build-stamp')).toBe('unchecked');
    expect(stamp.textContent).toBe(words('stamp.unchecked', 'account'));
    expect(stamp.textContent).not.toMatch(/built from our|is not a published/);
  });

  it.each([null, {}, { operations: () => 1, operation: () => undefined }])('A STATE WHOSE KEYS CANNOT BE LISTED (%j) IS UNCHECKED, NOT UNPUBLISHED', (state) => {
    /* RED WHEN a state that cannot be read for its keys is shown as "Not a published version". */
    expect(publishedBuildOfState(state, A, 'account', VERSIONS)).toEqual({ of: 'unchecked' });
  });

  it('SAYS IT COULD NOT CHECK WHEN THE READER ITSELF FAILS', async () => {
    const { container } = render(company(() => Promise.reject(new Error('boom'))));
    await settle();
    expect(stampIn(container, 'account').getAttribute('data-build-stamp')).toBe('unchecked');
    expect(container.textContent).not.toContain('boom');
  });

  it('NEVER USES A WORD THAT SAYS THE COMPANY IS REAL', () => {
    for (const key of ['stamp.checking', 'stamp.published', 'stamp.not-published', 'stamp.unchecked'] as const) {
      /* RED WHEN a stamp sentence says verified, genuine, safe, trusted or real of the company. */
      expect(EN[key]).not.toMatch(/verified|genuine|safe|trusted|\breal\b|authentic/i);
    }
  });

  it('CHANGES NEITHER THE FINGERPRINT NOR WHAT THE CHECK LETS THROUGH', async () => {
    const seen: string[] = [];
    for (const readKeys of [answering(THE_BUILD), answering(A_HIDDEN_KEY), answering(null), () => Promise.reject(new Error('x'))] as KeysReader[]) {
      const { container, unmount } = render(company(readKeys));
      await settle();
      const fingerprint = container.querySelector('[data-company-fingerprint]');
      /* RED WHEN the stamp's answer alters, hides or replaces the fingerprint or the sentence under it. */
      expect(fingerprint!.textContent).toBe(companyFingerprint(CO, A));
      expect(container.querySelector('[data-compare-with]')).not.toBeNull();
      seen.push(container.querySelector('[data-company-check]')!.getAttribute('data-company-check')!);
      unmount();
    }
    expect(seen).toEqual(['carries', 'carries', 'carries', 'carries']);
    expect(accountCarriesTheLabel(carries, CO)).toBe(true);
  });

  it('SHOWS NO STAMP WHERE THE CHECK REFUSED THE COMPANY', async () => {
    let asked = 0;
    const counting: KeysReader = async () => { asked += 1; return { of: 'published', version: 7 }; };
    const { container } = render(under(counting, <CompanyOnChain label={CO} account={A} check={{ of: 'no-account' }} doing="signed" compareWith="x" />));
    await settle();
    expect(container.querySelector('[data-build-stamp]')).toBeNull();
    expect(asked).toBe(0);
  });

  it('READS ONCE FOR ONE ADDRESS, AND NEVER SHOWS AN ANSWER READ FOR ANOTHER', async () => {
    let asked = 0;
    const once: KeysReader = (address, contract) => { asked += 1; return publishedBuildAt(() => Promise.resolve(THE_BUILD), address, contract, VERSIONS); };
    const { rerender, container } = render(company(once));
    await settle();
    rerender(company(once));
    await settle();
    expect(asked).toBe(1);
    const other = 'b2'.repeat(32) as AccountAddress;
    rerender(under(() => new Promise(() => {}), <CompanyOnChain label={CO} account={other} check={carries} doing="signed" compareWith="x" />));
    /* RED WHEN the answer is kept without the address it was read for: the new address shows the old answer. */
    expect(stampIn(container, 'account').getAttribute('data-build-stamp')).toBe('checking');
  });
});

const ask = parseAsk({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'balance',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' }, purpose: 'Put money into your company vault.',
  nonce: 'b1', expiresAt: 1_755_000_600_000, company: CO, account: A, vault: VAULT, transaction: 'AAECAw==',
}, 'https://payroll-a.example', 1_755_000_000_000) as BalanceRequest;

const READY: Extract<ComponentProps<typeof BalanceAsk>['stage'], { of: 'ready' }> = {
  of: 'ready', tx: { imbalances: () => new Map(), serialize: () => new Uint8Array() }, leaves: [], pays: 'private',
};
const vaultWindow = (readKeys: KeysReader, o: { onChain?: boolean; ready?: boolean } = {}) => under(readKeys, (
  <BalanceAsk
    stage={o.ready === true ? READY : { of: 'reading' }} request={ask} check={carries} consent={{ ok: true }}
    channel={o.ready === true ? recordingChannel([]) : null} busy={false} held={false}
    onChain={o.onChain ?? true} whoIsAsking={null} whichWallet={null} pay={() => {}} close={() => {}} decline={() => {}}
  />
));

describe('the vault window shows which published build the vault is', () => {
  it('SHOWS THE VERSION FOR THE VAULT AND FOR THE ACCOUNT, EACH READ AS ITS OWN CONTRACT', async () => {
    const byAddress: KeysReader = (address, contract) =>
      publishedBuildAt(() => Promise.resolve(address === VAULT ? THE_VAULT : THE_BUILD), address, contract, VERSIONS);
    const { container } = render(vaultWindow(byAddress));
    await settle();
    /* RED WHEN the vault is matched as an account (or the reverse): one of the two shows "Not a published version". */
    expect(stampIn(container, 'vault').textContent).toBe(words('stamp.published', 'vault'));
    expect(stampIn(container, 'account').textContent).toBe(words('stamp.published', 'account'));
  });

  it('SAYS "NOT A PUBLISHED VERSION" FOR A VAULT WITH A KEY HIDDEN IN THE OTHER SLOT', async () => {
    const { container } = render(vaultWindow(answering(A_HIDDEN_KEY_IN_THE_VAULT)));
    await settle();
    expect(stampIn(container, 'vault').getAttribute('data-build-stamp')).toBe('not-published');
  });

  it('SAYS IT COULD NOT CHECK THE VAULT WHEN THE READ DOES NOT COME BACK', async () => {
    const { container } = render(vaultWindow(reading(() => Promise.reject(new Error('down')))));
    await settle();
    expect(stampIn(container, 'vault').textContent).toBe(words('stamp.unchecked', 'vault'));
  });

  it('LEAVES THE FINGERPRINT AS THE CHECKS LEFT IT, WHATEVER THE STAMP SAYS', async () => {
    const shown: string[] = [];
    for (const readKeys of [answering(THE_VAULT), answering(A_HIDDEN_KEY_IN_THE_VAULT), answering(null)]) {
      const { container, unmount } = render(vaultWindow(readKeys));
      await settle();
      /* RED WHEN the stamp changes the fingerprint. */
      shown.push(container.querySelector('[data-company-fingerprint]')!.textContent!);
      unmount();
    }
    expect(new Set(shown)).toEqual(new Set([companyFingerprint(CO, A)]));
  });

  it('A PAYABLE WINDOW KEEPS ITS PAY BUTTON ENABLED UNDER EVERY STAMP ANSWER, AND AN UNPAYABLE ONE KEEPS IT HELD', async () => {
    const answers: [string, KeysReader][] = [
      ['published', answering(THE_VAULT)], ['not published', answering(A_HIDDEN_KEY_IN_THE_VAULT)], ['could not check', answering(null)],
      ['still reading', () => new Promise(() => {})],
    ];
    for (const [what, readKeys] of answers) {
      const open = render(vaultWindow(readKeys, { ready: true }));
      await settle();
      /* RED WHEN a stamp answer disables a window the old checks let pay. */
      expect((open.container.querySelector('[data-pay]') as HTMLButtonElement).disabled, what).toBe(false);
      open.unmount();
      const held = render(vaultWindow(readKeys, { ready: true, onChain: false }));
      await settle();
      /* RED WHEN a stamp answer enables a window the old checks hold. */
      expect((held.container.querySelector('[data-pay]') as HTMLButtonElement).disabled, what).toBe(true);
      held.unmount();
    }
  });
});

describe('the stamp reads through the context the screen sits in', () => {
  it('USES THE READER OF THE PROVIDER ABOVE IT WHEN IT IS GIVEN NO PROP, ONCE PER ADDRESS AND KIND', async () => {
    const calls: string[] = [];
    const counting: KeysReader = async (address, contract) => { calls.push(`${contract}:${address}`); return { of: 'published', version: 7 }; };
    const { container } = render(vaultWindow(counting));
    await settle();
    /* RED WHEN the screen does not read through the context it sits in. */
    expect(calls.sort()).toEqual([`account:${A}`, `vault:${VAULT}`]);
    expect(stampIn(container, 'vault').getAttribute('data-build-stamp')).toBe('published');
  });

  it('THE LIVE READER ASKS THE INDEXER, JUDGES THE STATE, AND SAYS IT COULD NOT CHECK A REFUSED READ OR A FALSE ADDRESS', async () => {
    const real = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, json: async () => ({ data: { contract: { state: THE_BUILD } } }) };
    }) as unknown as typeof fetch;
    try {
      /* The live reader judges against the released list, which holds no test version: a real state is "not published". */
      expect(await liveKeysReader(A, 'account')).toEqual({ of: 'not-published' });
      expect(JSON.parse(bodies[0]!).variables).toEqual({ address: A });
      expect(await liveKeysReader('not an address', 'account')).toEqual({ of: 'unchecked' });
      expect(bodies).toHaveLength(1);
      globalThis.fetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
      expect(await liveKeysReader(A, 'account')).toEqual({ of: 'unchecked' });
    } finally {
      globalThis.fetch = real;
    }
  });
});

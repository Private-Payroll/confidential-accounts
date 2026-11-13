// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';
import { ENGLISH } from '../english.test-support.js';

/*
 * THE SERVICE SCREEN, DRAWN over the real adapter and the real wallet wrapper, with only the call to the wallet, the seat and the shared
 * reader of the versions stood in for: the choice in force and the one being asked for with who filed it, what a press asks of the
 * wallet, the words after each way the wallet answers, and a choice that cannot be read offered for filing again.
 */
vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180'); });
const kr = vi.hoisted(() => ({
  acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown, seat: null as unknown, filed: null as unknown, reads: 0,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: 'u1' }),
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => ({ companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) }),
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => { kr.acts.push(intent); return kr.ended; },
}));
vi.mock('../adapters/vault-private-money.js', async (real) => ({
  ...(await real<typeof import('../adapters/vault-private-money.js')>()),
  seatAndRecordsHere: async () => kr.seat,
}));
vi.mock('vaults-web-shared/company-service-here.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/company-service-here.js')>()),
  companyServiceFiledHere: async () => { kr.reads += 1; return kr.filed; },
}));
vi.mock('../adapters/create-vault.js', async (real) => ({
  ...(await real<typeof import('../adapters/create-vault.js')>()),
  namedFor: async () => ({ record: 'c-1', company: 'label-1', account: 'c0'.repeat(32) }),
}));
vi.mock('../adapters/keyring-person.js', async (real) => ({ ...(await real<typeof import('../adapters/keyring-person.js')>()), keyringFor: async () => true }));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => ({ of: 'open', id: 'c-1', name: 'Northwind', signers: [], proposals: { of: 'read', value: [] } }),
}));
vi.mock('../adapters/session.js', async (real) => ({ ...(await real<typeof import('../adapters/session.js')>()), companyNamesFor: async () => new Map() }));

const { Service } = await import('./service.js');
const { SessionProvider } = await import('../session.js');
const { CompanyRecordsProvider } = await import('../records/company-records.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const words = (key: string, values: Record<string, string | number> = {}): string =>
  Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), EN[key] ?? key);

const key = (n: number): string => n.toString(16).padStart(64, '0');
const SEATS = [1, 2].map((n) => ({ seat: `0${n}`.padEnd(64, '0'), signingKey: key(n) }));
const HERE = {
  leaf: SEATS[0]!.seat, company: 'label-1', account: 'c0'.repeat(32), viewingKey: {}, opened: { signers: [] }, mine: { signerId: 'x', wrappingSecret: key(9) },
  directory: async () => ({ dir: { seats: SEATS } }),
};
const OWN = { service: 'own', at: 'https://service.example.com' };
const session = () => ({
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true },
  chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
});
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }); };
const draw = async () => {
  render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session()}><CompanyRecordsProvider><Service /></CompanyRecordsProvider></SessionProvider>
    </KitProvider>,
  );
  await settle();
};
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const text = (s: string): string => q(s)?.textContent ?? '';
const press = async (selector: string) => {
  fireEvent.click(q(selector)!);
  await settle();
  await waitFor(() => expect(q('[data-working]')).toBeNull());
  await settle();
};

beforeEach(() => {
  kr.acts = []; kr.reads = 0; kr.seat = HERE; kr.filed = { versions: [], needed: 2, highest: 0 };
  kr.ended = { of: 'done', steps: 4, relayed: 0, outcome: { state: 'waiting-for-signers', filed: 1, needed: 2 } };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the choice shown', () => {
  /* RED WHEN: a company that has chosen nothing is shown with a choice in force, or is not told its calls go through ours. */
  it('says nothing is chosen and that the calls go through ours', async () => {
    await draw();
    expect(q('[data-service-in-force]')!.getAttribute('data-service-in-force')).toBe('ours');
    expect(text('[data-service-unchosen]')).toBe(words('service.inForce.notChosen'));
    expect(q('[data-service-asked]')).toBeNull();
  });

  /* RED WHEN: a choice one signer of two has filed is shown in force, or the page does not say who filed it. */
  it('shows a choice filed by too few as asked, with how many have filed it and which seat, not in force', async () => {
    kr.filed = { versions: [{ version: 1, filer: key(1), choice: OWN }], needed: 2, highest: 1 };
    await draw();
    expect(q('[data-service-in-force]')!.getAttribute('data-service-in-force')).toBe('ours');
    expect(text('[data-service-asked]')).toContain(words('service.choice.own', { at: OWN.at }));
    expect(text('[data-service-count]')).toBe(words('service.asked.count', { filed: 1, needed: 2 }));
    expect(text('[data-service-filers]')).toContain(words('service.asked.you', { seat: SEATS[0]!.seat.slice(0, 8) }));
    expect(text('[data-service-asked]')).toContain(words('service.asked.count', { filed: 1, needed: 2 }));
    expect(text('[data-service-unchosen]')).toBe(words('service.inForce.notAgreed'));
  });

  /* RED WHEN: a choice enough signers filed is not shown in force. */
  it('shows a choice in force once enough signers have filed it', async () => {
    kr.filed = { versions: [{ version: 1, filer: key(1), choice: OWN }, { version: 2, filer: key(2), choice: OWN }], needed: 2, highest: 2 };
    await draw();
    expect(q('[data-service-in-force]')!.getAttribute('data-service-in-force')).toBe('own');
    expect(text('[data-service-in-force]')).toContain(words('service.choice.own', { at: OWN.at }));
    expect(q('[data-service-unchosen]')).toBeNull();
  });

  /* RED WHEN: a choice that cannot be read whole is shown as ours, or is not offered for filing again when the wallet may file over it. */
  it('says a choice that cannot be read is unread and offers filing it again only where that may be done', async () => {
    kr.filed = { unread: 'withheld', fileOver: { versions: [], needed: 2, highest: 2 } };
    await draw();
    expect(q('[data-service-unread]')!.getAttribute('data-service-unread')).toBe('may-file-over');
    expect(q('[data-service-in-force]')).toBeNull();
    expect(q('[data-action=file-again]')).not.toBeNull();
    cleanup();
    kr.filed = { unread: 'withheld' };
    await draw();
    expect(q('[data-service-unread]')!.getAttribute('data-service-unread')).toBe('cannot-file-over');
    expect(q('[data-action=file-again]')).toBeNull();
    expect(q('[data-action=file-choice]')).toBeNull();
  });

  /* RED WHEN: the providers to come are drawn as something that can be chosen, or are not marked coming soon. */
  it('shows the providers as coming soon', async () => {
    await draw();
    expect(text('[data-service-providers]')).toContain(words('service.providers.soon'));
    expect(q('[data-service-providers] input, [data-service-providers] button')).toBeNull();
  });
});

describe('filing the choice', () => {
  /* RED WHEN: the press asks the wallet for another act or another choice, or the shown count is the act's and not the page's own read of the records. */
  it('asks the wallet for the choice, says how it stands, and reads the records again for what it shows', async () => {
    await draw();
    fireEvent.click(q('[data-choice=own]')!);
    await settle();
    fireEvent.change(q('[data-field=service-address]')!, { target: { value: OWN.at } });
    const before = kr.reads;
    kr.filed = { versions: [{ version: 1, filer: key(1), choice: OWN }], needed: 2, highest: 1 };
    await press('[data-action=file-choice]');
    expect(kr.acts).toHaveLength(1);
    expect(kr.acts[0]).toMatchObject({ name: 'choose-company-service', service: 'own', at: OWN.at, record: 'c-1' });
    expect(text('[data-service-done]')).toBe(words('service.done.waiting', { filed: 1, needed: 2 }));
    expect(kr.reads).toBeGreaterThan(before);
    expect(text('[data-service-count]')).toBe(words('service.asked.count', { filed: 1, needed: 2 }));
  });

  /* RED WHEN: a choice that was not asked for in the wallet's words reaches the wallet, or an address that is not one is filed. */
  it('opens no wallet for an address that is not a secure site address', async () => {
    await draw();
    fireEvent.click(q('[data-choice=own]')!);
    await settle();
    fireEvent.change(q('[data-field=service-address]')!, { target: { value: 'http://x.example.com' } });
    await press('[data-action=file-choice]');
    expect(kr.acts).toEqual([]);
    expect(q('[data-service-problem]')!.getAttribute('data-service-problem')).toBe('not-an-address');
    expect(text('[data-service-problem]')).toBe(words('service.problem.not-an-address'));
  });

  /* RED WHEN: a stop of the wallet is shown as done, or in another's words. */
  it('says a stop of the wallet in its own words', async () => {
    await draw();
    kr.ended = { of: 'stopped', step: 3, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.choose-company-service.why.role-may-not-file' };
    await press('[data-action=file-choice]');
    expect(q('[data-service-done]')).toBeNull();
    expect(q('[data-service-stopped]')!.getAttribute('data-service-stopped')).toBe('may-not-file');
    expect(text('[data-service-stopped]')).toContain(words('service.why.may-not-file'));
  });
});

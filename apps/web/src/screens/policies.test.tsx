// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom, privateAmount } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';
import { ENGLISH } from '../english.test-support.js';
import { untilPageShown } from '../page-shown.test-support.js';

/*
 * THE POLICIES PAGE, DRAWN over the real review of what a change costs, with only the policy reads, the asks of the wallet and the
 * company's records stood in for: which vaults are offered, what each warning shows and when, what the change makes public, the
 * confirmation before the wallet is asked, and the words that follow each answer.
 */
const st = vi.hoisted(() => ({
  company: null as unknown, holders: null as unknown, policies: null as unknown, keysOpened: 0,
  readFor: [] as string[][], policyAsks: [] as unknown[], barAsks: [] as unknown[], policyAnswer: null as unknown, barAnswer: null as unknown,
}));
vi.mock('../adapters/policy-acts.js', async (real) => ({
  ...(await real<typeof import('../adapters/policy-acts.js')>()),
  readPolicies: async (_p: string, _c: string, vaults: string[]) => { st.readFor.push(vaults); return st.policies; },
  readHolders: async () => st.holders,
  raisePolicy: async (...ask: unknown[]) => { st.policyAsks.push(ask); return st.policyAnswer; },
  raisePolicyBar: async (...ask: unknown[]) => { st.barAsks.push(ask); return st.barAnswer; },
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => st.company,
  openWithYourAccount: async () => { st.keysOpened += 1; return { of: 'done' }; },
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  companyNamesFor: async () => new Map(),
}));

const { Policies } = await import('./policies.js');
const { policyCurrencies } = await import('../adapters/policy-acts.js');
const { SessionProvider } = await import('../session.js');
const { PanelProvider, RightPanel } = await import('../shell/right-panel.js');
const { CompanyRecordsProvider } = await import('../records/company-records.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const read = (value: unknown) => ({ of: 'read', value });
const A = 'ab'.repeat(32);
const B = 'cd'.repeat(32);
const TOKEN = policyCurrencies()[0]!.code;
const session = () => ({
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true },
  chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
});
const holdersOf = (over: Record<string, unknown> = {}) => read({
  approvals: 2, vaultThresholds: [], policyBar: null, seatBar: 2, seats: [], seated: 4, ...over,
});
const turn = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => { await act(async () => { await turn(); await turn(); }); };
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const press = async (selector: string) => { fireEvent.click(q(selector)!); await settle(); };
const type = async (selector: string, value: string) => { fireEvent.change(q(selector)!, { target: { value } }); await settle(); };
const draw = async () => {
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session()}><PanelProvider><CompanyRecordsProvider><Policies /><RightPanel /></CompanyRecordsProvider></PanelProvider></SessionProvider>
    </KitProvider>,
  );
  await untilPageShown(view.container);
  await settle();
};
const text = (): string => document.body.textContent ?? '';
const held = (vault: string, periodLength: bigint) => ({
  vault, token: TOKEN, of: 'set',
  terms: {
    bands: [1, 2, 3, 4].map((n) => ({ ceiling: privateAmount(BigInt(n) * 1000000n, 6, 'X'), ceilingText: `${n}`, approvals: n })),
    limit: privateAmount(9000000n, 6, 'X'), limitText: '9', periodStart: 5n, periodLength, version: 1,
  },
});
const open = async (approvals: number | undefined, over: Record<string, unknown> = {}) => {
  st.holders = holdersOf(over);
  await draw();
  await press('[data-action="set-policy"]');
  for (const band of [1, 2, 3, 4]) {
    const where = `[data-band-field="${band}"] [data-field="ceiling"]`;
    await type(where, `${band}`);
  }
  await type('[data-field="limit"]', '9');
  if (approvals !== undefined) for (const band of [1, 2, 3, 4]) await press(`[data-approvals-band="${band}"][data-approvals="${approvals}"]`);
};
const asBands = async (approvals: number[]) => { for (const [i, n] of approvals.entries()) await press(`[data-approvals-band="${i + 1}"][data-approvals="${n}"]`); };

beforeEach(() => {
  st.company = {
    of: 'open', id: 'c-1', name: 'Northwind', signers: [], approvalsNeeded: read(2), proposals: read([]),
    vaults: read([{ vault: A, createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee', adopted: true }, { vault: B, createdAt: '2026-09-02T00:00:00.000Z', standing: 'held-by-committee', adopted: false }]),
  };
  st.holders = holdersOf();
  st.policies = { of: 'read', held: [{ vault: A, token: TOKEN, of: 'none' }] };
  st.keysOpened = 0; st.readFor = []; st.policyAsks = []; st.barAsks = [];
  st.policyAnswer = { of: 'done', state: 'waiting-for-approvals', proposal: 'p', approvals: 1, needed: 2 };
  st.barAnswer = st.policyAnswer;
});
afterEach(cleanup);

describe('what the page offers', () => {
  /* RED WHEN: a vault the company has not adopted is read or offered a policy. */
  it('offers only adopted vaults', async () => {
    await draw();
    expect(st.readFor.at(-1)).toEqual([A]);
    expect(document.body.querySelectorAll('[data-vault]').length).toBe(1);
    expect(q(`[data-vault="${A}"]`)).not.toBeNull();
  });

  /* RED WHEN: a wallet that has not opened the company is shown a blank page, or no button to open it. */
  it('says so, with the button, when the wallet has not opened the company', async () => {
    st.policies = { of: 'refused', why: 'no-keys-here' };
    await draw();
    expect(q('[data-policies-no-keys]')?.textContent).toContain(EN['policies.noKeys']);
    await press('[data-action="open-with-your-wallet"]');
    expect(st.keysOpened).toBe(1);
  });

  /* RED WHEN: a period that is not one of the offered lengths is shown as nothing or as seconds. */
  it('shows a period that is not one of the offered lengths in days', async () => {
    st.policies = { of: 'read', held: [held(A, 864000n)] };
    await draw();
    expect(q('[data-period-says]')?.textContent).toBe('Period: 10 days');
  });
});

describe('the warnings', () => {
  /* RED WHEN: a change that needs every seated signer is not warned of, or a change that does not is. */
  it('warns when every seated signer is needed, and only then', async () => {
    await open(1, {});
    await asBands([1, 4, 2, 2]);
    await press('[data-action="review-policy"]');
    expect(q('[data-warning="every-signer"]')).not.toBeNull();
    expect(q('[data-warning="every-signer"]')?.textContent).toContain(EN['policies.warn.every-signer.runs']);
    expect(q('[data-warning="bar-raised"]')).not.toBeNull();
  });

  it('shows no every-signer warning when fewer than all are needed', async () => {
    await open(1);
    await asBands([1, 2, 3, 3]);
    await press('[data-action="review-policy"]');
    expect(q('[data-review="policy"]')).not.toBeNull();
    expect(q('[data-warning="every-signer"]')).toBeNull();
  });

  /* RED WHEN: a bar left raised above the account's approvals after a threshold fell is not said. */
  it('says the bar stays above the approvals when it is left raised', async () => {
    await open(1, { policyBar: 3, approvals: 2, seatBar: 3 });
    await asBands([1, 1, 2, 2]);
    await press('[data-action="review-policy"]');
    expect(q('[data-warning="bar-stays"]')).not.toBeNull();
    expect(q('[data-warning="bar-raised"]')).toBeNull();
  });

})

describe('the review', () => {
  /* RED WHEN: the approvals and what sets them are not shown. */
  it('shows the approvals and what sets them', async () => {
    await open(1);
    await asBands([1, 1, 1, 3]);
    await press('[data-action="review-policy"]');
    expect(q('[data-needs]')?.getAttribute('data-needs')).toBe('2');
    expect(q('[data-because]')?.textContent).toBe(EN['policies.review.because.account']);
    expect(q('[data-warning="bar-raised"]')?.textContent).toContain('3');
  });

  /* RED WHEN: a change shows more or less than it makes public, or calls what it makes public private. */
  it('says what the change makes public, hides the rest and calls nothing private', async () => {
    await open(1);
    await asBands([1, 1, 2, 3]);
    await press('[data-action="review-policy"]');
    const facts = [...document.body.querySelectorAll('[data-public-fact]')].map((e) => e.getAttribute('data-public-fact'));
    expect(facts).toContain('vault-has-a-policy');
    expect(q('[data-hidden]')?.textContent).toBe(EN['policies.review.hidden']);
    expect(q('[data-review]')?.textContent).not.toMatch(/private/iu);
  });

  /* RED WHEN: the wallet is asked before the reset is confirmed, or the reset is not said on a save. */
  it('says the reset on every policy save and asks the wallet only after the confirmation', async () => {
    await open(1);
    await press('[data-action="review-policy"]');
    expect(q('[data-reset-confirmation]')).not.toBeNull();
    expect(st.policyAsks).toEqual([]);
    await press('[data-action="confirm-policy"]');
    expect(st.policyAsks.length).toBe(1);
    expect(q('[data-acted]')?.textContent).toContain('waits for approvals on the Proposals page');
  });

  /* RED WHEN: an edit loses the policy's start, or the ask does not carry what was typed. */
  it('asks the wallet for what was typed, keeping the start of a policy it edits', async () => {
    st.policies = { of: 'read', held: [held(A, 864000n)] };
    await draw();
    await press('[data-action="edit-policy"]');
    await press('[data-action="review-policy"]');
    await press('[data-action="confirm-policy"]');
    const asked = st.policyAsks[0] as unknown[];
    expect(asked[2]).toMatchObject({ vault: A, token: TOKEN, periodLength: 864000n, current: { periodStart: 5n } });
  });

  /* RED WHEN: the wallet's refusal is shown in a word of the wallet's that this page has no key for. */
  it('says what a stop means in this page\'s words', async () => {
    st.policyAnswer = { of: 'stopped', why: 'may-not-set', partial: false, handedOver: false };
    await open(1);
    await press('[data-action="review-policy"]');
    await press('[data-action="confirm-policy"]');
    expect(text()).toContain(EN['policies.why.may-not-set']);
  });
});

describe('the policy bar', () => {
  /* RED WHEN: the bar can be set above the signers seated or below one. */
  it('steps between one and the signers seated', async () => {
    st.holders = holdersOf({ seated: 3, policyBar: 3 });
    await draw();
    expect((q('[data-action="bar-more"]') as HTMLButtonElement).disabled).toBe(true);
    await press('[data-action="bar-fewer"]');
    await press('[data-action="bar-fewer"]');
    expect((q('[data-action="bar-fewer"]') as HTMLButtonElement).disabled).toBe(true);
  });

  /* RED WHEN: a bar lowered is not said. */
  it('says the bar is lowered when it is stepped down', async () => {
    st.holders = holdersOf({ seated: 4, policyBar: 3, seatBar: 3, approvals: 2 });
    await draw();
    await press('[data-action="bar-fewer"]');
    expect(q('[data-warning="bar-lowered"]')).not.toBeNull();
  });

  /* RED WHEN: a bar change is saved without its review, or its review claims a reset or a hidden policy. */
  it('reviews a bar change, with the every-signer warning, and asks the wallet only on confirmation', async () => {
    st.holders = holdersOf({ seated: 3, policyBar: 2 });
    await draw();
    await press('[data-action="bar-more"]');
    expect(q('[data-review="bar"] [data-warning="every-signer"]')).not.toBeNull();
    expect(q('[data-review="bar"] [data-warning="every-signer"]')?.textContent).not.toContain(EN['policies.warn.every-signer.runs']);
    expect(q('[data-review="bar"] [data-reset-confirmation]')).toBeNull();
    expect(st.barAsks).toEqual([]);
    await press('[data-action="confirm-bar"]');
    expect(st.barAsks.length).toBe(1);
    expect((st.barAsks[0] as unknown[])[2]).toBe(3);
  });
});

describe('what cannot be read', () => {
  /* RED WHEN: a policy can be set while what the account holds is unread. */
  it('does not let a policy be reviewed when the account cannot be read', async () => {
    st.holders = { of: 'unreadable' };
    await draw();
    await press('[data-action="set-policy"]');
    expect((q('[data-action="review-policy"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-form-unread]')).not.toBeNull();
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom, publicAmount } from 'vaults-ui';
import type { Company, ProposalRow, VendorRow } from '../adapters/company-records.js';
import { untilPageShown } from '../page-shown.test-support.js';
import { ENGLISH } from '../english.test-support.js';

/*
 * PAYING SOMEONE FROM A VAULT'S PAGE: a one-off payment raised from the page's Pay someone and from a row's Send, to an address typed in
 * or to a vendor chosen from the vendor list, and an open one-off approved and paid from the vault's list. The wallet is the test's
 * stand-in, which records what it is asked; the panel, the page and the adapter are the real ones.
 */
vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180'); });
const kr = vi.hoisted(() => ({
  acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown, hold: null as Promise<void> | null,
  company: null as unknown, reads: 0, user: { id: 'u1' } as { id: string } | null,
  released: new Set<(accountId: string) => void>(),
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => null,
  watchCompanyKeyReleased: (watch: (accountId: string) => void) => { kr.released.add(watch); return () => { kr.released.delete(watch); }; },
  api: async () => ({ companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) }),
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => {
    kr.acts.push(intent);
    if (kr.hold !== null) await kr.hold;
    return kr.ended;
  },
}));
vi.mock('../adapters/creation-standing.js', async (real) => ({
  ...(await real<typeof import('../adapters/creation-standing.js')>()),
  creationOf: async () => ({ company: 'c-1', standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null }),
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => { kr.reads += 1; return kr.company; },
  readVaultPublicMoney: async () => ({ amounts: [publicAmount(4_000_000n, 6, 'NIGHT')], unrecognised: 0 }),
  readVaultName: async () => null,
}));
vi.mock('../adapters/handover-state.js', async (real) => ({ ...(await real<typeof import('../adapters/handover-state.js')>()), readHandover: async () => ({ of: 'held' }) }));
vi.mock('../adapters/vault-private-money.js', async (real) => ({
  ...(await real<typeof import('../adapters/vault-private-money.js')>()),
  readVaultPrivateMoney: async () => ({ of: 'nothing-yet' }),
}));
vi.mock('../adapters/vault-rows.js', async (real) => ({ ...(await real<typeof import('../adapters/vault-rows.js')>()), readVaultRows: async () => [] }));
vi.mock('../adapters/session.js', async (real) => ({ ...(await real<typeof import('../adapters/session.js')>()), companyNamesFor: async () => new Map() }));

const { PageView } = await import('../app.js');
const { Shell } = await import('../shell/shell.js');
const { SessionProvider } = await import('../session.js');
const { DEFAULT_PREFERENCES } = await import('../preferences.js');
const { addressOf } = await import('../router.js');
const { VIEWS } = await import('../pages.js');
const { assets } = await import('../../../../src/core/assets.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const words = (key: string, values: Record<string, string | number> = {}): string =>
  Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), EN[key] ?? key);

const VAULT = 'ab'.repeat(32);
const NIGHT = assets.enabled()[0]!;
const PRIVATE_ADDRESS = 'mn_shield-addr_stagenet1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg37tfmf9tk2uup37w6hww86h3lrlsvrg5rv3zjvph8ez5c566v95x7anasj9e9xdq57htt0qwwj5qx';
const PUBLIC_ADDRESS = 'mn_addr_stagenet1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5z5tpwxqergd3c8g7rusqqmwelz';
const NAMED = { record: 'c-1', company: 'label-1', account: 'c0'.repeat(32) };

const vendor = (over: Partial<VendorRow> = {}): VendorRow => ({
  id: 'ven_aa', name: 'Vee', address: PUBLIC_ADDRESS, standing: 'active', handedOver: false, termsKind: 'one-off', asset: null, monthly: null, paid: 'publicly',
  startedAt: '2026-02-01', endDate: null, admittedAt: null, admitBy: 'fingerprint', notPayable: null, ...over,
});
const oneOffRow = (over: Partial<ProposalRow> = {}): ProposalRow => ({
  id: 'prop_0001', kind: 'transfer', status: 'open', raisedBy: 'Sam', approvals: 1, needed: 2, raisedAt: '2026-10-21T00:00:00.000Z', pays: null,
  asks: { vault: VAULT, token: NIGHT.code, amount: '2500000', payee: PUBLIC_ADDRESS, reason: 'Invoice 118', payeeName: 'Northwind Paper' }, ...over,
});
const company = (over: Partial<Company> = {}): Company => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }], approvalsNeeded: { of: 'read', value: 2 },
  proposals: { of: 'read', value: [] }, runs: { of: 'read', value: [] }, people: { of: 'read', value: [] },
  vaults: { of: 'read', value: [{ vault: VAULT, createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee' }] },
  invitations: { of: 'read', value: [] }, vendorsBelief: { of: 'read', value: { vendors: [vendor()], notBelieved: [], notPayable: [], rows: [vendor()] } },
  ...over,
} as Company);

async function draw(page: 'vault' | 'vendors' = 'vault') {
  const params: Record<string, string> = page === 'vault' ? { vault: VAULT } : {};
  window.history.replaceState(null, '', addressOf(page, params));
  const session = {
    person: { id: 'u1', name: 'Priya' }, companies: [{ id: 'c-1', createdAt: '2026-09-01T00:00:00.000Z', signers: 1 }], company: 'c-1',
    chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
    choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
  };
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session}><Shell current={page}><PageView id={page} params={params} /></Shell></SessionProvider>
    </KitProvider>,
  );
  await untilPageShown(view.container);
  await settle();
  return view.container;
}
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const q = (sel: string): HTMLElement | null => document.body.querySelector(sel);
const panel = (sel: string): HTMLElement | null => q(`[data-panel] ${sel}`);
const press = async (sel: string) => { fireEvent.click(q(sel)!); await settle(); };
const type = async (sel: string, value: string) => { fireEvent.change(panel(sel)!, { target: { value } }); await settle(); };
const openPaySomeone = async () => { await press('[data-screen=vault] [data-action=pay-someone]'); };
const fill = async (over: { payee?: string; amount?: string; reason?: string; name?: string } = {}) => {
  await type('[data-field=payee]', over.payee ?? PRIVATE_ADDRESS);
  await type('[data-field=amount]', over.amount ?? '12.5');
  await type('[data-field=reason]', over.reason ?? 'Office chairs');
  if (over.name !== undefined) await type('[data-field=payee-name]', over.name);
};
const raised = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'raised', approvals: 1, needed: 2 } };
const stopped = (refused?: string, over: Record<string, unknown> = {}) => ({
  of: 'stopped', step: 2, steps: 4, relayed: 0, unconfirmed: 0, why: refused === undefined ? 'declined' : 'check-failed', ...(refused === undefined ? {} : { refused }), ...over,
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  kr.acts = []; kr.hold = null; kr.reads = 0; kr.user = { id: 'u1' }; kr.company = company(); kr.ended = raised;
  window.sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('paying someone from a vault\'s page', () => {
  /* RED WHEN: Pay someone is missing or opens nothing, or the panel asks the wallet anything before the person presses. */
  it('opens the one-off payment in the panel from Pay someone, and asks the wallet nothing until the person presses', async () => {
    await draw();
    await openPaySomeone();
    expect(panel('[data-action=one-off-panel]')).not.toBeNull();
    expect(panel('[data-one-off-from]')!.textContent).toBe(words('oneOff.from', { vault: words('vaults.tile.name', { number: 1 }) }));
    expect(panel('[data-one-off-note]')!.textContent).toBe(EN['oneOff.walletNote']);
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: a payment to a typed address asks the wallet with anything but the intent's fields, as typed, more than once, or while it works. */
  it('asks the wallet once for a payment to a typed address, with exactly the fields the intent takes', async () => {
    let release = (): void => {};
    kr.hold = new Promise<void>((r) => { release = r; });
    await draw();
    await openPaySomeone();
    await fill({ payee: `  ${PRIVATE_ADDRESS}  `, amount: '12.5', reason: ' Office chairs ', name: 'Chair Co' });
    await press('[data-panel] [data-action=raise-one-off]');
    await press('[data-panel] [data-action=raise-one-off]');
    expect(kr.acts).toEqual([{
      name: 'one-off-payment', ...NAMED, vault: VAULT, token: NIGHT.code, amount: '12500000', payee: PRIVATE_ADDRESS, reason: 'Office chairs', payeeName: 'Chair Co',
    }]);
    expect(panel('[data-working]')).not.toBeNull();
    expect((q('[data-panel] [data-action=raise-one-off]') as HTMLButtonElement).disabled).toBe(true);
    release();
    await settle();
    expect(kr.acts).toHaveLength(1);
  });

  /* RED WHEN: a name nobody typed, or a vendor nobody chose, is sent with a typed address. */
  it('sends no name and no vendor when the person typed neither', async () => {
    await draw();
    await openPaySomeone();
    await fill({ payee: PUBLIC_ADDRESS });
    await press('[data-panel] [data-action=raise-one-off]');
    expect(kr.acts).toHaveLength(1);
    for (const field of ['payeeName', 'vendor', 'proposal']) expect(kr.acts[0], field).not.toHaveProperty(field);
  });

  /* RED WHEN: Send on a row does not open a payment in that row's currency from that vault, or asks the wallet before the person presses. */
  it('raises a payment from a row\'s Send, in that row\'s currency', async () => {
    await draw();
    await press(`[data-screen=vault] [data-part=money] [data-row=${NIGHT.symbol}public] [data-action=send]`);
    expect(panel('[data-action=one-off-panel]')).not.toBeNull();
    expect(kr.acts).toEqual([]);
    await fill({ payee: PUBLIC_ADDRESS, amount: '3' });
    await press('[data-panel] [data-action=raise-one-off]');
    expect(kr.acts).toEqual([{ name: 'one-off-payment', ...NAMED, vault: VAULT, token: NIGHT.code, amount: '3000000', payee: PUBLIC_ADDRESS, reason: 'Office chairs' }]);
  });

  /* RED WHEN: a vendor chosen from the vendor list is sent without its entry's id, name and address, or a vendor this device will not pay is offered. */
  it('raises a payment to a vendor chosen from the vendor list, with the vendor\'s entry, name and address, and offers only vendors that can be paid', async () => {
    const rows = [vendor(), vendor({ id: 'ven_bb', name: 'Left', standing: 'leaver' }), vendor({ id: 'ven_cc', name: 'NoAddress', address: null }), vendor({ id: 'ven_dd', name: 'Held', notPayable: 'no keys' })];
    kr.company = company({ vendorsBelief: { of: 'read', value: { vendors: rows, notBelieved: [], notPayable: [], rows } } } as Partial<Company>);
    await draw();
    await openPaySomeone();
    fireEvent.pointerDown(panel('[data-field=payee-choice]')!, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    await settle();
    expect(Array.from(document.body.querySelectorAll('[role=option]')).map((o) => o.textContent)).toEqual([EN['oneOff.payee.typed'], 'Vee']);
    fireEvent.click(document.body.querySelectorAll('[role=option]')[1]!);
    await settle();
    expect(panel('[data-field=payee]')).toBeNull();
    expect(panel('[data-one-off-vendor-address]')!.textContent).toBe(words('oneOff.vendor.address', { address: PUBLIC_ADDRESS }));
    await type('[data-field=amount]', '7');
    await type('[data-field=reason]', 'March invoice');
    await press('[data-panel] [data-action=raise-one-off]');
    expect(kr.acts).toEqual([{
      name: 'one-off-payment', ...NAMED, vault: VAULT, token: NIGHT.code, amount: '7000000', payee: PUBLIC_ADDRESS, reason: 'March invoice', payeeName: 'Vee', vendor: 'ven_aa',
    }]);
  });

  /* RED WHEN: the panel says nothing about what the payment makes public until it can place the address, says a run's words for a single payment, says the wrong thing for the address's kind, or promises a private address what a public one does not have. */
  it('says what the payment makes public by the address\'s own kind, in the payment\'s words, and nothing for an address it cannot read', async () => {
    await draw();
    await openPaySomeone();
    expect(panel('[data-part=public-facts]')).toBeNull();
    await type('[data-field=payee]', 'nonsense');
    await type('[data-field=amount]', '3');
    expect(panel('[data-part=public-facts]')).toBeNull();
    const facts = () => Array.from(document.body.querySelectorAll('[data-panel] [data-part=public-facts] [data-fact]')).map((f) => [f.getAttribute('data-fact'), f.textContent]);
    await type('[data-field=payee]', PRIVATE_ADDRESS);
    expect(panel('[data-public-facts=private]')).not.toBeNull();
    expect(facts()).toEqual([
      ['vault', words('publicFacts.payment.vault', { vault: words('vaults.tile.name', { number: 1 }) })], ['count', EN['publicFacts.payment.count']], ['counter', EN['publicFacts.counter']],
      ['hidden', EN['publicFacts.private.hidden']], ['inference', EN['publicFacts.private.inference']], ['band', EN['publicFacts.payment.band']],
    ]);
    await type('[data-field=payee]', PUBLIC_ADDRESS);
    expect(panel('[data-public-facts=public]')).not.toBeNull();
    expect(facts().map(([k]) => k)).toEqual(['vault', 'count', 'counter', 'public-says', 'names']);
    expect(facts()[3]![1]).toBe(EN['publicFacts.payment.public.says']);
    expect(panel('[data-public-pay] [data-address]')!.textContent).toBe(PUBLIC_ADDRESS);
    expect(panel('[data-part=public-facts]')!.textContent).not.toMatch(/\brun\b/u);
  });

  /* RED WHEN: an address, amount or reason the page cannot use opens the wallet, or is not told to the person in words on the page. */
  it('refuses an unusable address, amount or reason in words before the wallet opens', async () => {
    await draw();
    await openPaySomeone();
    const tries: [Parameters<typeof fill>[0], string, string][] = [
      [{ payee: '' }, 'payee', 'no-address'], [{ payee: 'mn_addr_nowhere' }, 'payee', 'bad-address'], [{ amount: '' }, 'amount', 'no-amount'],
      [{ amount: '-3' }, 'amount', 'bad-amount'], [{ amount: '1,5' }, 'amount', 'bad-amount'], [{ amount: '0' }, 'amount', 'zero-amount'],
      [{ amount: '0.000' }, 'amount', 'zero-amount'], [{ amount: '1.1234567' }, 'amount', 'too-many-decimals'], [{ reason: '   ' }, 'reason', 'no-reason'],
      [{ reason: 'x'.repeat(501) }, 'reason', 'reason-too-long'], [{ name: 'n'.repeat(129) }, 'name', 'name-too-long'],
    ];
    for (const [over, field, problem] of tries) {
      await fill(over);
      await press('[data-panel] [data-action=raise-one-off]');
      expect(panel(`[data-problem=${field}]`)!.textContent, problem).toBe(words(`oneOff.problem.${problem}`, { count: field === 'reason' ? 500 : 128 }));
      expect(kr.acts, problem).toEqual([]);
    }
    await fill({ name: '' });
    expect(panel('[data-problem]')).toBeNull();
  });

  /* RED WHEN: the answer is lost when the company's records are read again after the wallet acts, shows a count the wallet did not give, or leaves the form open to a second press. */
  it('keeps the wallet\'s answer on screen while the records are read again, and locks the form', async () => {
    await draw();
    const before = kr.reads;
    await openPaySomeone();
    await fill();
    await press('[data-panel] [data-action=raise-one-off]');
    expect(kr.reads).toBe(before + 1);
    expect(panel('[data-acted]')!.textContent).toBe(`${EN['oneOff.done.raised']} ${words('proposal.act.counted', { approvals: 1, needed: 2 })}`);
    /* RED WHEN: the raised line says the payment is paid once the vault has its approvals, though a signer must carry it out. */
    expect(EN['oneOff.done.raised']).toMatch(/not paid yet[\s\S]*a signer carries it out/u);
    /* RED WHEN: the refusal to withdraw a held payment names no way forward. */
    expect(EN['proposals.withdraw.why.one-off-held']).toMatch(/Leave it unapproved/u);
    expect((q('[data-panel] [data-action=raise-one-off]') as HTMLButtonElement).disabled).toBe(true);
    expect((panel('[data-field=payee]') as HTMLInputElement).disabled).toBe(true);
  });

  /* RED WHEN: a payment the wallet carried out as well is told as only proposed. */
  it('says the payment was made when the wallet also paid it', async () => {
    kr.ended = { of: 'done', steps: 8, relayed: 3, outcome: { state: 'paid' } };
    await draw();
    await openPaySomeone();
    await fill();
    await press('[data-panel] [data-action=raise-one-off]');
    expect(panel('[data-acted]')!.textContent).toBe(EN['oneOff.done.paid']);
  });

  /* RED WHEN: a stop of the wallet is told in another stop's words, or a wallet that could not be asked leaves no word. */
  it('tells each stop of the wallet in its own words', async () => {
    for (const [code, why] of [['no-seat', 'seat'], ['not-a-payment', 'not-a-proposal'], ['not-raised', 'not-raised'], ['raise-may-be-sent', 'may-be-sent'], ['nobody-knows', 'other']] as const) {
      kr.ended = stopped(`act.one-off-payment.why.${code}`);
      cleanup();
      await draw();
      await openPaySomeone();
      await fill();
      await press('[data-panel] [data-action=raise-one-off]');
      expect(panel(`[data-proposal-stopped=${why}]`)!.textContent, code).toContain(EN[`proposal.act.why.${why}`]);
      expect((q('[data-panel] [data-action=raise-one-off]') as HTMLButtonElement).disabled, code).toBe(false);
    }
    kr.user = null;
    kr.acts = [];
    cleanup();
    await draw();
    await openPaySomeone();
    await fill();
    await press('[data-panel] [data-action=raise-one-off]');
    expect(kr.acts).toEqual([]);
  });
});

describe('a one-off payment waiting for approval on the vault page', () => {
  const waiting = (): Partial<Company> => ({ proposals: { of: 'read', value: [oneOffRow(), oneOffRow({ id: 'prop_0002', asks: { ...oneOffRow().asks!, vault: 'cd'.repeat(32) } }), oneOffRow({ id: 'prop_0003', status: 'approved' }), oneOffRow({ id: 'prop_0004', kind: 'payroll' })] } });

  /* RED WHEN: the list shows a payment of another vault, one the chain no longer holds open, or another kind of proposal, or a row loses what it pays, to whom, why or its approvals. */
  it('lists the open one-off payments of this vault only, with what each pays, to whom, why, and its approvals', async () => {
    kr.company = company(waiting());
    await draw();
    const rows = Array.from(document.body.querySelectorAll('[data-screen=vault] [data-part=one-offs] [data-one-off-row]'));
    expect(rows.map((r) => r.getAttribute('data-one-off-row'))).toEqual(['prop_0001']);
    const row = rows[0] as HTMLElement;
    expect(row.textContent).toContain('Northwind Paper');
    expect(row.textContent).toContain('Invoice 118');
    expect(row.textContent).toContain('2.5');
    expect(row.textContent).toContain(words('oneOff.pay.approvals', { approvals: 1, needed: 2 }));
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: a vault with no waiting payment draws a list or an empty notice, or a payment of a vault that does not wait for approval offers Approve and pay. */
  it('draws nothing when no one-off payment waits', async () => {
    await draw();
    expect(q('[data-screen=vault] [data-part=one-offs]')).toBeNull();
    expect(q('[data-action=approve-one-off]')).toBeNull();
  });

  /* RED WHEN: Approve and pay asks the wallet before the person presses Approve, asks it for anything but the one approve act with the fields the proposal carries, or more than once. */
  it('approves and pays an open one-off through the wallet once, with the fields the proposal carries', async () => {
    kr.company = company(waiting());
    kr.ended = { of: 'done', steps: 9, relayed: 3, outcome: { state: 'paid', approvals: 2, needed: 2 } };
    await draw();
    await press('[data-screen=vault] [data-action=approve-one-off]');
    expect(panel('[data-action=one-off-approve-panel]')).not.toBeNull();
    expect(panel('[data-part=one-off-summary]')!.textContent).toContain('Northwind Paper');
    expect(panel('[data-part=one-off-summary]')!.textContent).toContain('2.5');
    expect(panel('[data-one-off-note]')!.textContent).toBe(EN['oneOff.pay.walletNote']);
    expect(panel('[data-public-facts=public]')).not.toBeNull();
    expect(panel('[data-fact=count]')!.textContent).toBe(EN['publicFacts.payment.count']);
    expect(kr.acts).toEqual([]);
    await press('[data-panel] [data-action=approve]');
    await press('[data-panel] [data-action=approve]');
    expect(kr.acts).toEqual([{
      name: 'approve-proposal', ...NAMED, proposal: 'prop_0001', kind: 'one-off', vault: VAULT, token: NIGHT.code, amount: '2500000', payee: PUBLIC_ADDRESS,
      reason: 'Invoice 118', payeeName: 'Northwind Paper',
    }]);
  });

  /* RED WHEN: the answer to an approval is lost when the records are read again and the payment leaves the list. */
  it('keeps the approval\'s answer on screen after the records are read again and the payment has left the list', async () => {
    kr.company = company(waiting());
    kr.ended = { of: 'done', steps: 9, relayed: 3, outcome: { state: 'paid', approvals: 2, needed: 2 } };
    await draw();
    await press('[data-screen=vault] [data-action=approve-one-off]');
    const before = kr.reads;
    kr.company = company();
    await press('[data-panel] [data-action=approve]');
    expect(kr.reads).toBe(before + 1);
    expect(q('[data-screen=vault] [data-one-off-row]')).toBeNull();
    expect(panel('[data-acted]')!.textContent).toBe(`${EN['proposal.act.approved']} ${words('proposal.act.counted', { approvals: 2, needed: 2 })}`);
    expect((q('[data-panel] [data-action=approve]') as HTMLButtonElement).disabled).toBe(true);
  });

  /*
   * RED WHEN: a one-off the chain holds approved and shows not paid is not listed with Pay, one shown paid or whose payment was not read
   * is, or Pay asks the wallet for anything but the same approve act an open one-off's press asks for, with the fields the proposal carries.
   */
  it('lists an approved one-off the chain shows unpaid apart, with Pay, which opens the same wallet act as approving one', async () => {
    kr.company = company({ proposals: { of: 'read', value: [
      oneOffRow({ status: 'approved', approvals: 2, paidOnChain: false }), oneOffRow({ id: 'prop_0005', status: 'approved', approvals: 2, paidOnChain: true }),
      oneOffRow({ id: 'prop_0006', status: 'approved', approvals: 2 }),
    ] } });
    kr.ended = { of: 'done', steps: 9, relayed: 3, outcome: { state: 'paid', approvals: 2, needed: 2 } };
    await draw();
    expect(q('[data-screen=vault] [data-part=one-offs]')).toBeNull();
    const rows = Array.from(document.body.querySelectorAll('[data-screen=vault] [data-part=one-offs-approved] [data-one-off-row]'));
    expect(rows.map((r) => r.getAttribute('data-one-off-row'))).toEqual(['prop_0001']);
    expect(q('[data-screen=vault] [data-part=one-offs-approved]')!.textContent).toContain(EN['vault.oneOffs.approved']);
    await press('[data-screen=vault] [data-action=pay-one-off]');
    expect(panel('[data-one-off-note]')!.textContent).toBe(EN['oneOff.paying.walletNote']);
    expect(panel('[data-action=approve]')!.textContent).toBe(EN['proposals.pay']);
    expect(kr.acts).toEqual([]);
    await press('[data-panel] [data-action=approve]');
    expect(kr.acts).toEqual([{
      name: 'approve-proposal', ...NAMED, proposal: 'prop_0001', kind: 'one-off', vault: VAULT, token: NIGHT.code, amount: '2500000', payee: PUBLIC_ADDRESS,
      reason: 'Invoice 118', payeeName: 'Northwind Paper',
    }]);
    /* RED WHEN: paying an approved one-off is answered as an approval sent, or as made when the wallet did not say it paid it. */
    expect(panel('[data-acted]')!.textContent).toBe(`${EN['oneOff.done.paid']} ${words('proposal.act.counted', { approvals: 2, needed: 2 })}`);
  });
});

describe('paying a vendor from the vendor list', () => {
  const VAULT_2 = 'cd'.repeat(32);
  const twoVaults = (): Partial<Company> => ({
    vaults: { of: 'read', value: [{ vault: VAULT, createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee' }, { vault: VAULT_2, createdAt: '2026-09-02T00:00:00.000Z', standing: 'held-by-committee' }] },
  });
  const rows = [vendor(), vendor({ id: 'ven_bb', name: 'Left', standing: 'leaver' }), vendor({ id: 'ven_cc', name: 'NoAddress', address: null }), vendor({ id: 'ven_dd', name: 'Held', notPayable: 'no keys' })];
  const withRows = (over: Partial<Company> = {}) => company({ vendorsBelief: { of: 'read', value: { vendors: rows, notBelieved: [], notPayable: [], rows } }, ...over } as Partial<Company>);

  /* RED WHEN: Pay is offered on a vendor this device will not pay (left, no address, held against), or is missing on one it would pay. */
  it('offers Pay on the vendors the device would pay, and on no other', async () => {
    kr.company = withRows();
    await draw('vendors');
    expect(Array.from(document.body.querySelectorAll('[data-screen=vendors] [data-action=pay-vendor]')).map((b) => b.getAttribute('data-vendor'))).toEqual(['ven_aa']);
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: Pay does not open the payment with the vendor chosen and their address in place, offers a vault the company does not have, or asks the wallet for a vendor payment with a field other than the intent's. */
  it('raises a payment to the vendor from the list, from the company\'s only vault, once, with the vendor\'s entry, name and address', async () => {
    kr.company = withRows();
    await draw('vendors');
    await press('[data-screen=vendors] [data-action=pay-vendor]');
    expect(panel('[data-vendor-panel]')).toBeNull();
    expect(panel('[data-one-off-vendor-address]')!.textContent).toBe(words('oneOff.vendor.address', { address: PUBLIC_ADDRESS }));
    expect(panel('[data-field=payee-choice]')!.textContent).toContain('Vee');
    expect(panel('[data-field=vault]')!.textContent).toContain(words('vaults.tile.name', { number: 1 }));
    await type('[data-field=amount]', '7');
    await type('[data-field=reason]', 'March invoice');
    await press('[data-panel] [data-action=raise-one-off]');
    expect(kr.acts).toEqual([{
      name: 'one-off-payment', ...NAMED, vault: VAULT, token: NIGHT.code, amount: '7000000', payee: PUBLIC_ADDRESS, reason: 'March invoice', payeeName: 'Vee', vendor: 'ven_aa',
    }]);
    expect(panel('[data-acted]')).not.toBeNull();
  });

  /* RED WHEN: with several vaults a vault is chosen for the person, or a payment without a vault reaches the wallet, or the vault chosen is not the one paid from. */
  it('asks which vault when the company has several, refuses a payment with none chosen in words, and pays from the one chosen', async () => {
    kr.company = withRows(twoVaults());
    await draw('vendors');
    await press('[data-screen=vendors] [data-action=pay-vendor]');
    await type('[data-field=amount]', '7');
    await type('[data-field=reason]', 'March invoice');
    await press('[data-panel] [data-action=raise-one-off]');
    expect(panel('[data-problem=vault]')!.textContent).toBe(EN['oneOff.problem.no-vault']);
    expect(kr.acts).toEqual([]);
    fireEvent.pointerDown(panel('[data-field=vault]')!, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    await settle();
    expect(Array.from(document.body.querySelectorAll('[role=option]')).map((o) => o.textContent)).toEqual([words('vaults.tile.name', { number: 1 }), words('vaults.tile.name', { number: 2 })]);
    fireEvent.click(document.body.querySelectorAll('[role=option]')[1]!);
    await settle();
    expect(panel('[data-problem=vault]')).toBeNull();
    await press('[data-panel] [data-action=raise-one-off]');
    expect(kr.acts).toHaveLength(1);
    expect(kr.acts[0]).toMatchObject({ vault: VAULT_2, vendor: 'ven_aa' });
  });
});

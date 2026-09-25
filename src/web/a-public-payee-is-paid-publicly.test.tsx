// @vitest-environment jsdom
/**
 * **A PERSON WHOSE ADDRESS IS PUBLIC IS PAID PUBLICLY, AND THE PAGE SAYS SO.**
 *
 * Where a person is set up to be paid publicly, where a run pays anybody
 * publicly, and where a public payment is made from the vault, the page shows
 * what a public payment puts on the record, in the one sentence the product
 * uses for it. The payment itself goes out through the vault's public payout
 * and never through the private one, and the payslips page never asks the
 * chain about a public payment with the value a private one is recorded under.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Account, PayrollRun } from '../core/types.js';
import type { Hex } from '../core/crypto.js';

const built = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('./vault-worker-client.js', async (original) => ({
  ...(await original<typeof import('./vault-worker-client.js')>()),
  startVaultBuilder: async () => ({
    payoutPublicly: async (i: { payment: { payee: string } }) => { built.calls.push(`public to ${i.payment.payee}`); return { tx: 'TX' }; },
    payout: async () => { built.calls.push('private'); throw new Error('a private payout was built'); },
  }),
}));

const { PayoutPanel } = await import('./PayoutPanel.js');
const { People, RunDetail, Dashboard, Approvals } = await import('./App.js');
const { PUBLIC_PAYMENT, paidPublicly, runPaysAnyonePublicly } = await import('./public-payment.js');
const { PUBLIC_PAYMENT_SAYS } = await import('../core/movement.js');
const { paymentsOnTheChain } = await import('./my-payslips.js');

/*
 * Written out rather than encoded here: this runner's page environment holds a
 * second kind of byte array that the address encoder refuses, and a literal
 * cannot drift from what the product's own decode reads.
 */
const PUBLIC = {
  kind: 'unshielded', network: 'undeployed',
  bech32: 'mn_addr_undeployed1c0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pstnru9l',
} as const;
const PRIVATE = {
  kind: 'shielded', network: 'undeployed',
  bech32: 'mn_shield-addr_undeployed15xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xslh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alh7capsjjp',
} as const;
const VAULT = '99'.repeat(32);
const VK = 'aa'.repeat(32) as Hex;
const account = {
  id: 'acc_1', name: 'Northwind', signers: [], policy: { threshold: 1 },
} as unknown as Account;
const me = { signerId: 'sgn_1', signingSecret: '11'.repeat(32) as Hex, wrappingSecret: '22'.repeat(32) as Hex };
const shown = () => [...document.querySelectorAll('[data-public-payment]')].map((e) => e.textContent);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); built.calls.length = 0; });

describe('THE ONE SENTENCE', () => {
  it('is the one a public payment is described by everywhere, word for word', () => {
    /* RED WHEN: the page's sentence is written a second time and drifts from the refusal's. */
    expect(PUBLIC_PAYMENT).toBe(PUBLIC_PAYMENT_SAYS);
    expect(PUBLIC_PAYMENT).toBe('A public payment puts the address and the amount on a record anyone can read.');
  });

  it('reads public or private off the address itself', () => {
    /* RED WHEN: a private address is read as public, or a public one as private. */
    expect(paidPublicly(PUBLIC.bech32)).toBe(true);
    expect(paidPublicly(PRIVATE.bech32)).toBe(false);
    expect(paidPublicly('not an address')).toBe(false);
    expect(paidPublicly(undefined)).toBe(false);
    expect(runPaysAnyonePublicly({ employees: [{ paidTo: PRIVATE.bech32 }, { paidTo: PUBLIC.bech32 }] })).toBe(true);
    expect(runPaysAnyonePublicly({ employees: [{ paidTo: PRIVATE.bech32 }, {}] })).toBe(false);
  });
});

describe('WHERE A PERSON IS SET UP TO BE PAID PUBLICLY', () => {
  it('the roster says it on that person\'s row and on nobody else\'s', () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([]), { status: 200 }));
    const person = (id: string, name: string, address: unknown) => ({
      id, name, email: `${id}@a.co`, title: 'Eng', startDate: '2026-09-01', baseAmount: 100n, asset: 'NIGHT',
      status: 'active', address,
    });
    render(<People
      people={[person('e1', 'Robin', PUBLIC), person('e2', 'Dana', PRIVATE)] as never}
      session={{ account, viewingKey: VK, secrets: [], employees: [], seat: null } as never}
      busy={false} act={async () => {}} />);
    /* RED WHEN: the roster shows a public payee without saying what a public payment puts on the record. */
    expect(shown()).toEqual([PUBLIC_PAYMENT]);
    const rows = [...document.querySelectorAll('tbody tr')];
    const robin = rows.find((r) => r.textContent?.includes('Robin'))!;
    const dana = rows.find((r) => r.textContent?.includes('Dana'))!;
    /* RED WHEN: the sentence is shown against a private payee, or away from the public one. */
    expect(robin.querySelector('[data-public-payment]')).not.toBeNull();
    expect(dana.querySelector('[data-public-payment]')).toBeNull();
  });
});

describe('WHERE A RUN PAYS ANYBODY PUBLICLY', () => {
  const runPaying = (...paidTo: string[]) => ({
    id: 'run_1', accountId: 'acc_1', period: '2026-09', status: 'draft', proposalIds: {}, totals: { NIGHT: 200n },
    employees: paidTo.map((to, i) => ({ id: `e${i}`, name: `Person ${i}`, asset: 'NIGHT', amount: 100n, paidTo: to })),
    payslips: [],
  } as unknown as PayrollRun);
  const renderRun = (run: PayrollRun) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'not here' }), { status: 500 }));
    render(<RunDetail run={run as never} proposals={[]} account={account}
      session={{ account, viewingKey: VK, secrets: [], employees: [], seat: null } as never}
      me={me as never} busy={false} onBack={() => {}} act={async () => {}} />);
  };

  it('the run says it once', () => {
    renderRun(runPaying(PRIVATE.bech32, PUBLIC.bech32));
    /* RED WHEN: a run that pays somebody publicly is shown without the sentence. */
    expect(shown()).toEqual([PUBLIC_PAYMENT]);
  });

  it('and a run that pays everybody privately does not', () => {
    renderRun(runPaying(PRIVATE.bech32, PRIVATE.bech32));
    /* RED WHEN: the sentence is shown on a run that pays nobody publicly. */
    expect(shown()).toEqual([]);
  });
});

describe('PAYING A PUBLIC PAYEE FROM THE VAULT', () => {
  const run = {
    id: 'run_1', period: '2026-09', proposalIds: { NIGHT: 'prp_leg' },
    employees: [{ name: 'Robin', asset: 'NIGHT' }, { name: 'Dana', asset: 'NIGHT' }],
    payout: { NIGHT: { retries: [] } },
  } as unknown as PayrollRun;
  const payment = (index: number, kind: 'shielded' | 'unshielded', payee: string, paid = false) => ({
    index, kind, payee, token: '00'.repeat(32), amount: '100', blinding: '0b'.repeat(32), nonce: '0c'.repeat(32),
    leaf: `${index}d`.repeat(32), path: [], paid,
  });
  const NOW = Math.floor(Date.now() / 1000);
  const orderWith = (robinPaid: boolean) => ({
    asset: 'NIGHT', vault: VAULT, proposal: '0f'.repeat(32), salt: '5a'.repeat(32), root: '9a'.repeat(32), payees: '2',
    opensAt: String(NOW - 600), closesAt: String(NOW + 3_600),
    payments: [payment(0, 'unshielded', PUBLIC.bech32, robinPaid), payment(1, 'shielded', PRIVATE.bech32)],
  });

  it('offers each person the payment their address is, says a public payment is public, and pays Robin through the public door', async () => {
    const calls: string[] = [];
    let orders = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (url === '/api/runs/run_1/private-payments') { orders += 1; return json(orderWith(orders > 1)); }
      if (url === `/api/accounts/acc_1/vaults/${VAULT}/chain`) return json({ vault: VAULT, onChain: true, heldByCommittee: true, fundable: true });
      if (url === `/api/accounts/acc_1/vaults/${VAULT}/payout-state`) {
        return json({ vault: VAULT, account: 'ac'.repeat(32), blockHash: 'b', vaultState: 'V', zswapState: 'Z', parameters: 'P', accountState: 'A' });
      }
      if (url === `/api/accounts/acc_1/vaults/${VAULT}/public-payout`) return json({ txRef: 'tx_pub', transactionHash: null });
      return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 500 });
    });
    render(<PayoutPanel account={account} me={me} viewingKey={VK} runs={[run]}
      proposals={[{ id: 'prp_leg', status: 'approved', raisedAt: 'then' }]} />);
    await act(async () => {
      fireEvent.change(document.querySelector('[data-payout-run]')!, { target: { value: 'run_1:NIGHT' } });
    });
    const rows = [...document.querySelectorAll('[data-payout-people] tbody tr')];
    /* RED WHEN: a person is offered the other form of payment from the one their address is. */
    expect(rows.map((r) => [r.textContent?.includes('Robin') ? 'Robin' : 'Dana',
      r.querySelector('[data-pay-publicly]') ? 'publicly' : r.querySelector('[data-pay-privately]') ? 'privately' : 'none']))
      .toEqual([['Robin', 'publicly'], ['Dana', 'privately']]);
    /* RED WHEN: a leg that pays somebody publicly is shown under words that promise the payment is not public. */
    expect(shown()).toEqual([PUBLIC_PAYMENT]);
    expect(document.body.textContent).not.toMatch(/are not written on the chain in the open/);
    expect(document.querySelector('[data-payout-panel] .sub')?.textContent).toBe('one person at a time, against an approved round');

    await act(async () => { fireEvent.click(document.querySelector('[data-pay-publicly]')!); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    /* RED WHEN: a public payee is paid through the private payout, or the public payment is sent to the private door. */
    expect(built.calls).toEqual([`public to ${PUBLIC.bech32}`]);
    expect(calls).toContain(`/api/accounts/acc_1/vaults/${VAULT}/public-payout`);
    expect(calls).not.toContain(`/api/accounts/acc_1/vaults/${VAULT}/payout`);
    expect(document.querySelector('[data-payout-error]')?.textContent).toBeUndefined();
    /* The leg is read again once the payment is recorded, and Robin reads as paid. */
    expect([...document.querySelectorAll('[data-payout-person]')].map((r) => r.getAttribute('data-payout-person'))).toEqual(['paid', 'owed']);
  });

  it('a leg that pays everybody privately keeps its words and shows no public sentence', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      ...orderWith(false), payments: [payment(0, 'shielded', PRIVATE.bech32)],
    }), { status: 200 }));
    render(<PayoutPanel account={account} me={me} viewingKey={VK} runs={[run]}
      proposals={[{ id: 'prp_leg', status: 'approved', raisedAt: 'then' }]} />);
    await act(async () => {
      fireEvent.change(document.querySelector('[data-payout-run]')!, { target: { value: 'run_1:NIGHT' } });
    });
    /* RED WHEN: the public sentence or the public control appears for a leg that pays nobody publicly. */
    expect(shown()).toEqual([]);
    expect(document.querySelector('[data-pay-publicly]')).toBeNull();
    expect(document.querySelector('[data-payout-panel] .sub')?.textContent).toBe('one person at a time, privately, against an approved round');
  });
});

describe('A PUBLIC PAYMENT ON THE PAYSLIPS PAGE', () => {
  it('reads "cannot tell" when its money has no public form, and is never asked about with the value a private payment is recorded under', async () => {
    const asked: unknown[] = [];
    const reader = { recorded: async (_i: unknown, _c: string, payments: unknown[]) => { asked.push(...payments); return payments.map(() => false); } };
    const slip = (runId: string, paidTo: string) => ({
      runId, issuedBy: 'c0'.repeat(32), status: 'settled', wiring: 'chain',
      payslip: { paidTo, asset: 'TESTUSD', amount: 100n },
      receipt: { company: 'c0'.repeat(32), nonce: '01'.repeat(32), blinding: '02'.repeat(32), until: Math.floor(Date.now() / 1000) + 3_600 },
    });
    /* The wallet is taken as confirming both addresses, so nothing but the address's own kind can keep the public one out. */
    const chain = await paymentsOnTheChain(
      [slip('run_pub', PUBLIC.bech32), slip('run_priv', PRIVATE.bech32)] as never,
      reader as never, { indexer: 'x' } as never, () => true);
    /* RED WHEN: a public payment is asked about as if it were private - it would read "not yet" for a payment that was made.
     * TESTUSD has no public form, so there is no public value to ask with; a public payment in money that has one
     * is asked about in its own form (`a-public-payment-reads-as-the-chain-says.test.ts`). */
    expect(chain.get('run_pub')).toBe('cannot-tell');
    expect(asked.map((p) => (p as { paidTo: string }).paidTo)).toEqual([PRIVATE.bech32]);
    expect(chain.get('run_priv')).toBe('not-yet');
  });
});

describe('WHERE A SCREEN USED TO SAY EVERY SALARY IS KEPT OFF THE RECORD', () => {
  const person = (id: string, name: string, address: unknown) => ({
    id, name, email: `${id}@a.co`, title: 'Eng', startDate: '2026-09-01', baseAmount: 100n, asset: 'NIGHT',
    status: 'active', address,
  });
  const renderDashboard = (people: unknown[]) => render(<Dashboard state={{ entries: [] } as never} runs={[]}
    people={people as never} pending={[]} onGo={() => {}} />);

  it('the dashboard says what a public payment puts on the record once anybody is paid publicly, instead of "shielded"', () => {
    renderDashboard([person('e1', 'Robin', PUBLIC), person('e2', 'Dana', PRIVATE)]);
    /* RED WHEN: the dashboard tells a company whose payroll pays somebody publicly that every salary is shielded. */
    expect(shown()).toEqual([PUBLIC_PAYMENT]);
    expect(document.body.textContent).not.toMatch(/Individual salaries are shielded\./);
  });

  it('and keeps its words for a payroll that pays everybody privately', () => {
    renderDashboard([person('e2', 'Dana', PRIVATE)]);
    /* RED WHEN: the sentence is shown on a payroll that pays nobody publicly. */
    expect(shown()).toEqual([]);
    expect(document.body.textContent).toMatch(/Individual salaries are shielded\./);
  });

  const approving = (...paidTo: string[]) => {
    const run = {
      id: 'run_1', accountId: 'acc_1', period: '2026-09', status: 'proposed', proposalIds: { NIGHT: 'prp_1' },
      totals: { NIGHT: 200n }, payslips: [],
      employees: paidTo.map((to, i) => ({ id: `e${i}`, name: `Person ${i}`, asset: 'NIGHT', amount: 100n, paidTo: to })),
    };
    const proposal = { id: 'prp_1', summary: 'Payroll 2026-09, 2 recipients', status: 'open', approvals: [], proposedBy: 'sgn_1' };
    render(<Approvals pending={[proposal] as never} account={account}
      session={{ account, viewingKey: VK, secrets: [], employees: [], seat: null } as never}
      me={{ ...me, name: 'Ada' } as never} busy={false} runs={[run] as never} act={async () => {}} />);
  };

  it('the approval of a leg that pays anybody publicly does not say its amounts never appear in the clear', () => {
    approving(PRIVATE.bech32, PUBLIC.bech32);
    /* RED WHEN: a signer approving a leg that pays somebody publicly is told its amounts never appear in the clear. */
    expect(shown()).toEqual([PUBLIC_PAYMENT]);
    expect(document.body.textContent).not.toMatch(/never appears in the clear/);
    expect(document.body.textContent).not.toMatch(/Amountshielded/);
  });

  it('and the approval of a leg that pays everybody privately keeps its words', () => {
    approving(PRIVATE.bech32, PRIVATE.bech32);
    /* RED WHEN: the sentence replaces the private words on a leg that pays nobody publicly. */
    expect(shown()).toEqual([]);
    expect(document.body.textContent).toMatch(/never appears in the clear/);
    expect(document.body.textContent).toMatch(/Amountshielded/);
  });

  it('the invitation form offers NIGHT and says it when the money chosen can only be paid publicly', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([]), { status: 200 }));
    render(<People people={[] as never}
      session={{ account, viewingKey: VK, secrets: [], employees: [], seat: null } as never}
      busy={false} act={async () => {}} />);
    await act(async () => { fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Invite employee')!); });
    const paidIn = [...document.querySelectorAll('label')].find((l) => l.textContent === 'Paid in')!.parentElement!.querySelector('select')!;
    const offered = [...paidIn.querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value);
    /* RED WHEN: the invitation offers only money with a private form, which leaves NIGHT out. */
    expect(offered).toContain('NIGHT');
    expect(offered[0]).not.toBe('NIGHT');
    expect(shown()).toEqual([]);
    await act(async () => { fireEvent.change(paidIn, { target: { value: 'NIGHT' } }); });
    /* RED WHEN: a company inviting somebody in money only paid publicly is not told what that puts on the record. */
    expect(shown()).toEqual([PUBLIC_PAYMENT]);
  });

  it('the form where a member adds themselves says it when the money they choose can only be paid publicly', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([]), { status: 200 }));
    render(<People people={[] as never}
      session={{ account, viewingKey: VK, secrets: [], employees: [], seat: null } as never}
      busy={false} act={async () => {}} />);
    await act(async () => { fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Add yourself')!); });
    const paidIn = [...document.querySelectorAll('label')].find((l) => l.textContent === 'Paid in')!.parentElement!.querySelector('select')!;
    const offered = [...paidIn.querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value);
    /* The form opens on money that can be paid privately, which this build has one of. */
    expect(offered).toContain('NIGHT');
    expect(offered[0]).not.toBe('NIGHT');
    /* RED WHEN: the sentence is shown for money that can be paid privately. */
    expect(shown()).toEqual([]);
    await act(async () => { fireEvent.change(paidIn, { target: { value: 'NIGHT' } }); });
    /* RED WHEN: a member choosing money that is only paid publicly is not told what that puts on the record. */
    expect(shown()).toEqual([PUBLIC_PAYMENT]);
  });
});

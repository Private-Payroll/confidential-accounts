// @vitest-environment jsdom
/**
 * **EVERY RETRY CONTROL THE PAGE SHOWS IS ONE THE COMPANY ACCEPTS.**
 *
 * Retry only for people nothing covers; Send for a retry written down and not
 * seen on chain; Withdraw only for a round the company will withdraw; Pay only
 * for an approved retry. The controls are rendered and driven; what they send
 * is written down by a service double, or, for the page's own wiring, by the
 * page's own request function over a network double. The network, the
 * background thread and the vault's pool store are the doubles, and nothing
 * else is.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Account, PayrollRun } from '../core/types.js';
import type { Hex } from '../core/crypto.js';
import type { PoolNote } from './device-vault-holdings.js';

const TOKEN_HEX = vi.hoisted(() => ({ pool: [] as PoolNote[] }));

vi.mock('./keyring.js', async (original) => ({
  ...(await original<typeof import('./keyring.js')>()),
  signerMaterialFor: () => ({ signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) }),
  currentUser: () => ({ id: 'usr_1' }),
}));
const built = vi.hoisted(() => ({ calls: [] as Array<{ order: unknown; material: unknown }> }));
vi.mock('./vault-worker-client.js', async (original) => {
  const { paymentsFitNotes } = await import('./vault-builder.js');
  return {
    ...(await original<typeof import('./vault-worker-client.js')>()),
    startVaultBuilder: async () => ({
      governedCall: async (args: { order: unknown; material: unknown }) => { built.calls.push(args); return { tx: 'TX' }; },
      commitments: async ({ coin }: { coin: { nonce: string } }) => ({ held: `c${coin.nonce.slice(1)}` }),
      paymentsFit: async (args: Parameters<typeof paymentsFitNotes>[0]) => paymentsFitNotes(args),
    }),
  };
});
vi.mock('../midnight/vault-pool.js', async (original) => ({
  ...(await original<typeof import('../midnight/vault-pool.js')>()),
  SealedNotePool: class { async load() { return { notes: TOKEN_HEX.pool }; } },
}));

const { RetryUnpaid, WithdrawRound } = await import('./GovernedCallControls.js');
const { PayoutPanel, isPayableRetry } = await import('./PayoutPanel.js');
const { unpaidToRetry, pendingRetries, mayWithdraw } = await import('./governed-call-on-device.js');
type GovernedCallService = import('./governed-call-on-device.js').GovernedCallService;
type RaiseDoors = import('./governed-call-on-device.js').RaiseDoors;
type RoundOnThePage = import('./governed-call-on-device.js').RoundOnThePage;
const { deviceVaultHoldings } = await import('./device-vault-holdings.js');
const { paymentsFitNotes } = await import('./vault-builder.js');
const { registryWithTestPrivateForms, testPrivateToken } = await import('../testing/assets.js');
const { DEVICE_RAISE_VERSION, paymentsCheckedDigest } = await import('../core/device-raise.js');
const { SEED_ASSETS } = await import('../core/assets.js');
const { opensAs, sealedProposalFor } = await import('../testing/sealed-records.js');
/* The product's own private asset, for the page's own wiring, which checks against the product's own rows. */
const PRIVATE = SEED_ASSETS.find((a) => a.ledger.shielded !== null)!;
const PRIVATE_POOL = [{ ...note0(7, 987_654_321n), token: PRIVATE.ledger.shielded as Hex }];

const TOKEN = testPrivateToken('GBP') as Hex;
function note0(n: number, value: bigint): PoolNote {
  return { nonce: n.toString(16).padStart(64, '0') as Hex, token: '00'.repeat(32) as Hex, value, createdIn: 'ee'.repeat(32) as Hex };
}
const VAULT = '99'.repeat(32);
const OTHER_VAULT = '98'.repeat(32);
/* In the past, so a control that reads this machine's clock instead of the one handed to it is seen. */
const NOW = 1_600_000_000;
const now = () => NOW;
const payee = (index: number, state: 'paid' | 'skipped' | 'failed' | 'unsent') => ({ index, state });
/* Six people: two paid, one a person decided not to pay, and three stranded - #3 refused, #5 and #6 never tried. */
const OWED = [payee(2, 'failed'), payee(4, 'unsent'), payee(5, 'unsent')];
const STOPPED = {
  answered: true as const,
  status: {
    verified: true, phase: 'closed', outstanding: OWED, stranded: OWED,
    paid: [payee(0, 'paid'), payee(3, 'paid')], skipped: [payee(1, 'skipped')],
  },
};
/* A retry of #3 and #5 with its window still open, as the run records it. */
const retryOf = (over: { proposalId?: string; originalIndices?: number[]; opensAt?: number; closesAt?: number } = {}) => ({
  originalIndices: over.originalIndices ?? [2, 4], opensAt: String(over.opensAt ?? NOW + 100),
  closesAt: String(over.closesAt ?? NOW + 3_600), vault: OTHER_VAULT,
  ...('proposalId' in over ? (over.proposalId === undefined ? {} : { proposalId: over.proposalId }) : { proposalId: 'prp_u' }),
});
const roundOf = (over: Partial<{ id: string; status: string; raisedAt: string; txRef: string }> = {}) =>
  ({ id: 'prp_u', status: 'open', ...over });
/*
 * A retry round written down for #3 and #5 whose raise never answered, so the run does not point at it: its
 * people are read out of its sealed payload with the viewing key, as the company reads them.
 */
const { seal, canonical } = await import('../core/crypto.js');
const untoldRoundOf = (over: Partial<{ status: string; people: number[]; runId: string; asset: string }> = {}) => ({
  id: 'prp_t', status: over.status ?? 'open', kind: 'payroll', chainId: 'ce'.repeat(32),
  sealedPayload: seal(canonical({
    runId: over.runId ?? 'run_1', retry: over.people ?? [2, 4], __change: { asset: over.asset ?? 'GBP' },
  }), 'aa'.repeat(32) as Hex),
});

const account = { id: 'acc_1', name: 'Northwind', signers: [] } as unknown as Account;
const me = { signerId: 'sgn_1', signingSecret: '11'.repeat(32) as Hex, wrappingSecret: '22'.repeat(32) as Hex };
const note = (n: number, value: bigint): PoolNote => ({ ...note0(n, value), token: TOKEN });
const POOL = [note(7, 987_654_321n)];
TOKEN_HEX.pool = PRIVATE_POOL;
const committed = (n: PoolNote) => `c${n.nonce.slice(1)}`;
const round = (over: Partial<RoundOnThePage> = {}): RoundOnThePage => ({ id: 'prp_u', chainId: 'cd'.repeat(32), status: 'open', ...over });

/* The digest of what the retry-payments doubles answer for these people: one payment of 1000 each, in `token`. */
const checkedFor = (indices: number[], token: string = TOKEN) =>
  paymentsCheckedDigest(indices.map(() => ({ kind: 'shielded', token, amount: '1000' })));
const orderFor = (
  proposalId: string, indices: number[], w: { vault: string; opensAt: string; closesAt: string }, token: string = TOKEN,
) => ({
  proposalId, chainId: 'cd'.repeat(32), indices, paymentsChecked: checkedFor(indices, token),
  order: {
    circuit: 'propose' as const, proposal: 'cd'.repeat(32),
    run: { root: '88'.repeat(32), payees: String(indices.length), opensAt: w.opensAt, closesAt: w.closesAt, vault: w.vault },
    half: { assetId: '44'.repeat(32), assetBlinding: '55'.repeat(32), proposalSalt: '66'.repeat(32), changeAmount: '1', changeBatchDigest: '77'.repeat(32) },
  },
});

/** A device whose service and worker write down every request, in order. */
const aDevice = () => {
  const requests: Array<{ route: string; body: any }> = [];
  const asked = (route: string, body: unknown) => { requests.push({ route, body }); };
  const service = {
    retryPayments: async (_run: string, body: { indices: number[] }) => {
      asked('retry-payments', body);
      return { asset: 'GBP', payments: body.indices.map(() => ({ kind: 'shielded', token: TOKEN, amount: '1000' })) };
    },
    raiseRetry: async (_run: string, body: { indices: number[]; vault: string; opensAt: string; closesAt: string }) => {
      asked('retry', body);
      return { proposal: round(), order: orderFor('prp_u', body.indices, body) };
    },
    retryOrder: async (_run: string, body: { proposalId: string }) => {
      asked('retry-order', body);
      const r = retryOf();
      return orderFor(body.proposalId, [...r.originalIndices], r);
    },
    sendRetry: async (_run: string, body: unknown) => { asked('retry-send', body); return round({ txRef: 't' }); },
    callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
    standing: async (_id: string, body: unknown) => { asked('standing', body); return round({ raisedAt: 'now' }); },
  } as unknown as GovernedCallService;
  const doors: RaiseDoors = {
    service,
    holdings: deviceVaultHoldings({
      chain: async () => ({ onChain: true, notesFromThisBuild: true, notes: POOL.map(committed) }),
      pool: async () => POOL,
      heldCommitmentOf: async (_v, n) => committed(n),
      paymentsFit: async (notes, payments) => {
        return paymentsFitNotes({
          notes: notes.map((n) => ({ nonce: n.nonce, token: n.token, value: n.value.toString(), createdIn: n.createdIn! })),
          payments: payments.map((p) => ({ token: p.token, amount: p.amount.toString() })),
        });
      },
    }),
    assets: registryWithTestPrivateForms(),
    builder: { governedCall: async () => ({ tx: 'TX' }) },
    material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    accountId: 'acc_1', sleep: async () => {}, waitMs: 3, everyMs: 1,
    /* What the device opens is checked where the call is built, which this test stands in for. */
    opens: opensAs({ prp_u: 'cd'.repeat(32) }),
  };
  return { requests, doors };
};

/** Renders the retry control with an `act` whose work the test can wait for. */
const renderRetry = (over: Partial<Parameters<typeof RetryUnpaid>[0]> = {}) => {
  const d = aDevice();
  const acted: Array<Promise<void>> = [];
  render(<RetryUnpaid account={account} me={me} runId="run_1" asset="GBP" viewingKey={'aa'.repeat(32) as Hex}
    view={STOPPED} busy={false} act={async (fn) => { const p = fn(); acted.push(p); await p; }}
    doors={async () => d.doors} listVaults={async () => [VAULT]} now={now} {...over} />);
  return { ...d, settled: () => act(async () => { await Promise.all(acted); }) };
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); built.calls.length = 0; });

describe('1. PEOPLE AN UNSENT RETRY COVERS ARE NOT OFFERED RETRY, AND THAT RETRY IS SHOWN WITH SEND', () => {
  it('leaves the covered people out of the people offered', () => {
    /* RED WHEN: unpaidToRetry ignores what a retry not yet on chain covers - the company then refuses the retry. */
    expect(unpaidToRetry(STOPPED, [2, 4])).toEqual([5]);
    expect(unpaidToRetry(STOPPED, [2, 4, 5])).toEqual([]);
    expect(unpaidToRetry(STOPPED)).toEqual([2, 4, 5]);
  });

  it('counts a retry as covering exactly while the company would', () => {
    const r = (over: Parameters<typeof retryOf>[0]) => retryOf(over);
    const kinds = (
      retries: ReturnType<typeof retryOf>[], rounds: ReturnType<typeof roundOf>[],
      legRounds: Array<{ id: string; status: string; retry?: number[] }> = [],
    ) => pendingRetries(retries, rounds, NOW, legRounds).map((p) => p.kind);
    /* RED WHEN: any of the three not-yet-on-chain states is not recognised, or is named as another. */
    expect(kinds([r({})], [roundOf()])).toEqual(['unsent']);
    expect(kinds([r({})], [roundOf({ txRef: 'tx_1' })])).toEqual(['sent-unseen']);
    expect(kinds([r({ proposalId: undefined })], [], [{ id: 'prp_t', status: 'open', retry: [2, 4] }])).toEqual(['untold']);
    /* RED WHEN: a retry seen on chain, withdrawn, stopped, or past its window is still shown as waiting to be sent. */
    expect(kinds([r({})], [roundOf({ raisedAt: 'then' })])).toEqual([]);
    expect(kinds([r({})], [roundOf({ status: 'cancelled' })])).toEqual([]);
    expect(kinds([r({})], [roundOf({ status: 'blocked' })])).toEqual([]);
    expect(kinds([r({ closesAt: NOW })], [roundOf()])).toEqual([]);
    expect(kinds([r({ proposalId: undefined, closesAt: NOW - 1 })], [])).toEqual([]);
    /* A retry whose round this page cannot find is not offered to send: nothing here could say how. */
    expect(kinds([r({})], [])).toEqual([]);
  });

  it('shows the unsent retry with Send, offers Retry only for #6, and Send sends that retry as itself', async () => {
    const d = renderRetry({ retries: [retryOf()], rounds: [roundOf()] });
    /* RED WHEN: #3 or #5 is offered for a new retry while their own retry is written down. */
    expect(screen.getByText(/not\s+paid \(#6\)/u)).toBeTruthy();
    expect(document.querySelector('[data-pending-retry="unsent"]')).not.toBeNull();
    await act(async () => { fireEvent.click(document.querySelector('[data-send-retry]')!); });
    await d.settled();
    /* RED WHEN: Send raises a new retry instead of sending the one written down, or skips the vault check before the send. */
    expect(d.requests.map((x) => x.route)).toEqual(['retry-order', 'retry-payments', 'retry-send', 'standing']);
    expect(d.requests[0]!.body.proposalId).toBe('prp_u');
    expect(d.requests[2]!.body.proposalId).toBe('prp_u');
    expect(d.requests[1]!.body.indices).toEqual([2, 4]);
  });

  it('sends a retry whose raise did not answer by raising exactly its people with its own window and vault', async () => {
    const d = renderRetry({ retries: [retryOf({ proposalId: undefined })], rounds: [untoldRoundOf()] });
    expect(document.querySelector('[data-pending-retry="untold"]')).not.toBeNull();
    await act(async () => { fireEvent.click(document.querySelector('[data-send-retry]')!); });
    await d.settled();
    expect(d.requests.map((x) => x.route)).toEqual(['retry-payments', 'retry', 'retry-payments', 'retry-send', 'standing']);
    /* RED WHEN: the resend names other people, another window or another vault - the company refuses those as a second round. */
    const raised = d.requests[1]!.body;
    expect(raised.indices).toEqual([2, 4]);
    expect([raised.vault, raised.opensAt, raised.closesAt]).toEqual([OTHER_VAULT, String(NOW + 100), String(NOW + 3_600)]);
  });

  it('counts nobody on a withdrawn retry or one whose window has closed', () => {
    /* RED WHEN: the control takes its covered people from every retry on the leg rather than those still pending. */
    renderRetry({ retries: [retryOf()], rounds: [roundOf({ status: 'cancelled' })] });
    expect(screen.getByText(/not\s+paid \(#3, #5, #6\)/u)).toBeTruthy();
    cleanup();
    renderRetry({ retries: [retryOf({ closesAt: NOW - 1 })], rounds: [roundOf()] });
    expect(screen.getByText(/not\s+paid \(#3, #5, #6\)/u)).toBeTruthy();
    expect(document.querySelector('[data-pending-retry]')).toBeNull();
  });

  it('offers no new retry at all when every stranded person is covered, and still shows what sends them', () => {
    renderRetry({ retries: [retryOf({ originalIndices: [2, 4, 5] })], rounds: [roundOf()] });
    /* RED WHEN: Retry is offered over nobody, or over people a retry already covers. */
    expect(document.querySelector('[data-retry-open]')).toBeNull();
    expect(document.querySelector('[data-send-retry]')).not.toBeNull();
  });
});

describe('3. WITHDRAW WITHDRAWS A ROUND NOT YET OPEN, AND IS NOT OFFERED FOR ONE THAT IS', () => {
  it('is offered exactly where the company withdraws', () => {
    const on = (over: Partial<{ status: string; raisedAt: string; txRef: string }>, opensAt: number | undefined) =>
      mayWithdraw({ id: 'p', status: 'open', ...over }, opensAt, NOW);
    /* Written down and never sent, on chain before its window opens, or stopped by policy: withdrawn. */
    expect(on({}, NOW - 10)).toBe(true);
    expect(on({ raisedAt: 'then' }, NOW + 1)).toBe(true);
    expect(on({ raisedAt: 'then', status: 'approved' }, NOW + 1)).toBe(true);
    expect(on({ status: 'blocked' }, undefined)).toBe(true);
    /* RED WHEN: a round stopped by policy is judged by a window it never had on chain. */
    expect(on({ status: 'blocked', raisedAt: 'then' }, NOW)).toBe(true);
    /* RED WHEN: Withdraw is offered once the chain holds the round and its window has opened - the chain refuses. */
    expect(on({ raisedAt: 'then' }, NOW)).toBe(false);
    expect(on({ raisedAt: 'then' }, undefined)).toBe(false);
    /* RED WHEN: Withdraw is offered for a round a device sent that the chain does not show - the company refuses it. */
    expect(on({ txRef: 'tx_1' }, NOW + 1)).toBe(false);
    /* RED WHEN: a settled or withdrawn round is offered again. */
    expect(on({ status: 'executed', raisedAt: 'then' }, NOW + 1)).toBe(false);
    expect(on({ status: 'cancelled' }, NOW + 1)).toBe(false);
  });

  it('withdraws through the company\'s own route, with the viewing key in the body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'prp_u', status: 'cancelled' }), { status: 200 });
    });
    const acted: Array<Promise<void>> = [];
    render(<WithdrawRound round={roundOf({ raisedAt: 'then' })} opensAt={NOW + 60} viewingKey={'aa'.repeat(32)}
      busy={false} now={now} act={async (fn) => { const p = fn(); acted.push(p); await p; }} />);
    await act(async () => { fireEvent.click(document.querySelector('[data-withdraw-round="prp_u"]')!); });
    await act(async () => { await Promise.all(acted); });
    /* RED WHEN: Withdraw calls anything but the cancel route, or puts the key in the address. */
    expect(calls.map((c) => [c.url, c.init.method])).toEqual([['/api/proposals/prp_u/cancel', 'POST']]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ viewingKey: 'aa'.repeat(32) });
  });

  it('is not rendered for a round whose window has opened', () => {
    render(<WithdrawRound round={roundOf({ raisedAt: 'then' })} opensAt={NOW} viewingKey="k" busy={false} now={now}
      act={async () => {}} />);
    expect(document.querySelector('[data-withdraw-round]')).toBeNull();
  });

  it('beside a retry the chain holds whose window has not opened, and not once it has', () => {
    renderRetry({ retries: [retryOf({ opensAt: NOW + 10 })], rounds: [roundOf({ raisedAt: 'then' })] });
    /* RED WHEN: a retry on chain before its window opens has no Withdraw anywhere on the page. */
    expect(document.querySelector('[data-unopened-retry] [data-withdraw-round="prp_u"]')).not.toBeNull();
    cleanup();
    renderRetry({ retries: [retryOf({ opensAt: NOW })], rounds: [roundOf({ raisedAt: 'then' })] });
    /* RED WHEN: Withdraw is offered once the window has opened - the chain refuses it - or the row still says it has not. */
    expect(document.querySelector('[data-withdraw-round]')).toBeNull();
    expect(document.querySelector('[data-unopened-retry]')).toBeNull();
  });

  it('beside an unsent retry, and not beside one a device sent that the chain does not show', () => {
    renderRetry({ retries: [retryOf()], rounds: [roundOf()] });
    expect(document.querySelector('[data-withdraw-round="prp_u"]')).not.toBeNull();
    cleanup();
    renderRetry({ retries: [retryOf()], rounds: [roundOf({ txRef: 'tx_1' })] });
    expect(document.querySelector('[data-pending-retry="sent-unseen"]')).not.toBeNull();
    expect(document.querySelector('[data-withdraw-round]')).toBeNull();
  });
});

describe('2. THE PAYOUT PANEL OFFERS AN APPROVED RETRY, AND NOT AN UNSENT OR WITHDRAWN ONE', () => {
  const retry = (proposalId: string, originalIndices: number[]) => ({ ...retryOf({ proposalId, originalIndices }) });
  const run = {
    id: 'run_1', period: '2026-08', proposalIds: { GBP: 'prp_leg' },
    employees: [0, 1, 2].map((i) => ({ id: `emp_${i}`, name: `Person ${i}`, asset: 'GBP', amount: 1000n })),
    payout: { GBP: { retries: [retry('prp_ok', [1]), retry('prp_unsent', [2]), retry('prp_gone', [0]), retry('prp_voting', [0, 2])] } },
  } as unknown as PayrollRun;
  const rounds = [
    { id: 'prp_ok', status: 'approved', raisedAt: 'then' },
    { id: 'prp_unsent', status: 'open' },
    { id: 'prp_gone', status: 'cancelled', raisedAt: 'then' },
    { id: 'prp_voting', status: 'open', raisedAt: 'then' },
  ];

  it('reads a retry as payable only when its round is approved on chain', () => {
    /* RED WHEN: a retry is payable for having a proposal at all - an unsent one then meets a 409, a withdrawn one a refusal. */
    expect(rounds.map((r) => isPayableRetry({ proposalId: r.id }, rounds))).toEqual([true, false, false, false]);
    expect(isPayableRetry({}, rounds)).toBe(false);
    /* RED WHEN: a round marked approved that this service never saw on chain is offered. */
    expect(isPayableRetry({ proposalId: 'prp_x' }, [{ id: 'prp_x', status: 'approved' }])).toBe(false);
    expect(isPayableRetry({ proposalId: 'prp_nowhere' }, rounds)).toBe(false);
  });

  it('lists the leg and the approved retry, and asks for that retry\'s own payments when it is chosen', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
      return new Response(JSON.stringify({ payments: [] }), { status: 200 });
    });
    render(<PayoutPanel account={account} me={me} viewingKey={'aa'.repeat(32) as Hex} runs={[run]} proposals={rounds} />);
    const options = [...document.querySelectorAll('[data-payout-run] option')].map((o) => (o as HTMLOptionElement).value);
    /* RED WHEN: the panel lists an unsent, withdrawn or unapproved retry as payable. */
    expect(options).toEqual(['', 'run_1:GBP', 'run_1:GBP:prp_ok']);
    await act(async () => {
      fireEvent.change(document.querySelector('[data-payout-run]')!, { target: { value: 'run_1:GBP:prp_ok' } });
    });
    /* RED WHEN: choosing a retry asks for the leg's payments - the vault then pays against the wrong approval. */
    expect(calls.map((c) => c.url)).toEqual(['/api/runs/run_1/private-payments']);
    expect(calls[0]!.body).toEqual({ viewingKey: 'aa'.repeat(32), asset: 'GBP', proposalId: 'prp_ok' });
  });
});

describe('6. THE PAGE\'S REAL RETRY CONTROL IS RENDERED AND REACHES THE DEVICE PATH', () => {
  it('with no doors handed in, retries through the page\'s own request function, background thread and pool', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (url === '/api/accounts/acc_1/vaults') return json([{ vault: VAULT }]);
      if (url === `/api/accounts/acc_1/vaults/${VAULT}/chain`) return json({ onChain: true, notesFromThisBuild: true, notes: PRIVATE_POOL.map(committed) });
      if (url.endsWith('/retry-payments')) {
        return json({
          asset: PRIVATE.code, payments: body.indices.map(() => ({ kind: 'shielded', token: PRIVATE.ledger.shielded, amount: '1000' })),
        });
      }
      if (url.endsWith('/retry')) return json({ proposal: round(), order: orderFor('prp_u', body.indices, body, PRIVATE.ledger.shielded!) });
      if (url === '/api/accounts/acc_1/call-state') return json({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' });
      /* The company's own records, sealed, which the device opens itself before it builds. */
      if (url === '/api/accounts/acc_1/proposals') {
        return json([sealedProposalFor('acc_1', 'aa'.repeat(32) as Hex, { id: 'prp_u', chainId: 'cd'.repeat(32), salt: '66'.repeat(32) })]);
      }
      if (url.endsWith('/retry-send')) return json(round({ txRef: 't' }));
      if (url.endsWith('/standing')) return json(round({ raisedAt: 'now' }));
      return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 500 });
    });
    const acted: Array<Promise<void>> = [];
    render(<RetryUnpaid account={account} me={me} runId="run_1" asset={PRIVATE.code} viewingKey={'aa'.repeat(32) as Hex}
      view={STOPPED} busy={false} act={async (fn) => { const p = fn(); acted.push(p); await p; }} now={now} />);
    await act(async () => { fireEvent.click(document.querySelector('[data-retry-open]')!); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    fireEvent.change(document.querySelector('[data-raise-vault]')!, { target: { value: VAULT } });
    await act(async () => { fireEvent.click(document.querySelector('[data-retry-send]')!); });
    await act(async () => { await Promise.all(acted); });
    /* RED WHEN: the control's own doors are not the device path - the vault read here, written down, checked again, built, sent. */
    const routes = calls.map((c) => c.url).filter((u) => u.startsWith('/api/runs/') || u.startsWith('/api/proposals/') || u.endsWith('/call-state'));
    expect(routes).toEqual([
      '/api/runs/run_1/retry-payments', '/api/runs/run_1/retry', '/api/runs/run_1/retry-payments',
      '/api/accounts/acc_1/call-state', '/api/runs/run_1/retry-send', '/api/proposals/prp_u/standing',
    ]);
    /* RED WHEN: the vault check does not read the vault's notes on the chain before anything is written down. */
    expect(calls.findIndex((c) => c.url.endsWith('/chain'))).toBeLessThan(calls.findIndex((c) => c.url.endsWith('/retry')));
    const raised = calls.find((c) => c.url.endsWith('/retry'))!.body;
    expect(raised.indices).toEqual([2, 4, 5]);
    expect(raised.onDevice).toBe(true);
    expect(raised.version).toBe(DEVICE_RAISE_VERSION);
    /* RED WHEN: the proof is built with anything but this signer's own material, in the page's background thread. */
    expect(built.calls).toHaveLength(1);
    expect(built.calls[0]!.material).toEqual({ signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) });
    /* RED WHEN: anything sent carries a note, the pool or a balance. */
    const everything = JSON.stringify(calls.filter((c) => !c.url.endsWith('/chain')));
    expect(everything).not.toContain(PRIVATE_POOL[0]!.nonce);
    expect(everything).not.toContain(PRIVATE_POOL[0]!.value.toString());
  });
});

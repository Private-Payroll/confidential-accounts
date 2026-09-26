// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Account } from '../core/types.js';
import type { Hex } from '../core/crypto.js';
import { RetryUnpaid } from './GovernedCallControls.js';
import { unpaidToRetry, type GovernedCallService, type RaiseDoors, type RoundOnThePage } from './governed-call-on-device.js';
import { deviceVaultHoldings, type PoolNote } from './device-vault-holdings.js';
import { paymentsFitNotes } from './vault-builder.js';
import { registryWithTestPrivateForms, testPrivateToken } from '../testing/assets.js';
import { DEVICE_RAISE_VERSION, paymentsCheckedDigest } from '../core/device-raise.js';
import { opensAs } from '../testing/sealed-records.js';

/*
 * The control a person retries a stopped run with, rendered against a payment
 * view, and what it sends: the page's own device module over a service and a
 * worker that write down what they were asked.
 */
const TOKEN = testPrivateToken('GBP') as Hex;
const VAULT = '99'.repeat(32);
const payee = (index: number, state: 'paid' | 'skipped' | 'failed' | 'unsent') => ({ index, state });
/*
 * Six people: two paid, one a person decided not to pay, one refused, two never tried - and the run's
 * window has closed with nothing left that can pay the three still owed, so all three are stranded.
 */
const OWED = [payee(2, 'failed'), payee(4, 'unsent'), payee(5, 'unsent')];
const STOPPED = {
  answered: true as const,
  status: {
    verified: true,
    phase: 'closed',
    outstanding: OWED,
    stranded: OWED,
    paid: [payee(0, 'paid'), payee(3, 'paid')],
    skipped: [payee(1, 'skipped')],
  },
};

describe('5. A RETRY NAMES ONLY THE PEOPLE THE STOPPED RUN DID NOT PAY', () => {
  it('names the refused and the never-tried, and never a person paid or one a person decided not to pay', () => {
    /* RED WHEN: the retry is chosen from anything but the unpaid - a paid person named again, or a skipped one paid. */
    expect(unpaidToRetry(STOPPED)).toEqual([2, 4, 5]);
    /* The view's order is not trusted: the positions are put in the leg's order. */
    expect(unpaidToRetry({ ...STOPPED, status: { ...STOPPED.status, stranded: [payee(5, 'unsent'), payee(2, 'failed')] } }))
      .toEqual([2, 5]);
    /* RED WHEN: a paid person, or one a person decided not to pay, that has leaked into the outstanding list is named. */
    expect(unpaidToRetry({ ...STOPPED, status: { ...STOPPED.status, stranded: [payee(0, 'paid'), payee(2, 'failed')] } }))
      .toEqual([2]);
    expect(unpaidToRetry({ ...STOPPED, status: { ...STOPPED.status, stranded: [payee(1, 'skipped'), payee(2, 'failed')] } }))
      .toEqual([2]);
  });

  it('offers nothing when nobody could say who was paid, or could not prove the people are this run\'s', () => {
    /* RED WHEN: a retry is offered over a view that did not answer - every person reads unpaid in one. */
    expect(unpaidToRetry({ answered: false })).toEqual([]);
    /* RED WHEN: a retry is offered over people not proved to be this run's. */
    expect(unpaidToRetry({ ...STOPPED, status: { ...STOPPED.status, verified: false } })).toEqual([]);
    expect(unpaidToRetry({ ...STOPPED, status: { ...STOPPED.status, stranded: [] } })).toEqual([]);
  });
});

describe('5a. RETRY IS OFFERED ONLY WHEN IT CAN BE RAISED', () => {
  it('offers nobody while the run\'s window has not closed, and nobody a sent retry can still pay', () => {
    /* RED WHEN: Retry is offered while the run is still paying - the company refuses it as a second round over the same people. */
    expect(unpaidToRetry({ ...STOPPED, status: { ...STOPPED.status, phase: 'open' } })).toEqual([]);
    expect(unpaidToRetry({ ...STOPPED, status: { ...STOPPED.status, phase: 'not started' } })).toEqual([]);
    /* RED WHEN: a view with no phase is read as closed - an older answer is not proof the run has stopped. */
    const { phase: _phase, ...noPhase } = STOPPED.status;
    expect(unpaidToRetry({ ...STOPPED, status: noPhase })).toEqual([]);
    /* #3 is owed but a sent retry can still pay them (outstanding, not stranded): only #5 and #6 are offered. */
    /* RED WHEN: the people offered are the outstanding rather than the stranded - #3 is named twice over two live retries. */
    expect(unpaidToRetry({ ...STOPPED, status: { ...STOPPED.status, stranded: [payee(4, 'unsent'), payee(5, 'unsent')] } }))
      .toEqual([4, 5]);
  });

  it('shows no control while the run is paying, though people on it are unpaid', () => {
    const props = { account, me, runId: 'run_1', asset: 'GBP', viewingKey: 'aa'.repeat(32) as Hex, busy: false,
      act: async () => {}, doors: async () => aDevice().doors, listVaults: async () => [VAULT] };
    render(<RetryUnpaid {...props} view={{ ...STOPPED, status: { ...STOPPED.status, phase: 'open' } }} />);
    /* RED WHEN: the page offers Retry over a run whose own window can still pay those people. */
    expect(document.querySelector('[data-retry-unpaid]')).toBeNull();
  });
});

const account = { id: 'acc_1', name: 'Northwind', signers: [] } as unknown as Account;
const me = { signerId: 'sgn_1', signingSecret: '11'.repeat(32) as Hex, wrappingSecret: '22'.repeat(32) as Hex };
const note = (n: number, value: bigint): PoolNote => ({
  nonce: n.toString(16).padStart(64, '0') as Hex, token: TOKEN, value, createdIn: 'ee'.repeat(32) as Hex,
});
const POOL = [note(7, 987_654_321n)];
const committed = (n: PoolNote) => `c${n.nonce.slice(1)}`;
const round = (over: Partial<RoundOnThePage> = {}): RoundOnThePage => ({ id: 'prp_r', chainId: 'cd'.repeat(32), status: 'open', ...over });

/** A device whose service and worker write down every request, in order. */
const aDevice = () => {
  const requests: Array<{ route: string; body: unknown }> = [];
  const asked = (route: string, body: unknown) => { requests.push({ route, body }); };
  const service = {
    retryPayments: async (_run: string, body: { indices: number[] }) => {
      asked('retry-payments', body);
      return { asset: 'GBP', payments: body.indices.map(() => ({ kind: 'shielded', token: TOKEN, amount: '1000' })) };
    },
    raiseRetry: async (_run: string, body: { indices: number[]; vault: string; opensAt: string; closesAt: string }) => {
      asked('retry', body);
      return {
        proposal: round(),
        order: {
          proposalId: 'prp_r', chainId: 'cd'.repeat(32), indices: body.indices,
          paymentsChecked: paymentsCheckedDigest(body.indices.map(() => ({ kind: 'shielded', token: TOKEN, amount: '1000' }))),
          order: {
            circuit: 'propose' as const, proposal: 'cd'.repeat(32),
            run: { root: '88'.repeat(32), payees: String(body.indices.length), opensAt: body.opensAt, closesAt: body.closesAt, vault: body.vault },
            half: { assetId: '44'.repeat(32), assetBlinding: '55'.repeat(32), proposalSalt: '66'.repeat(32), changeAmount: '1', changeBatchDigest: '77'.repeat(32) },
          },
        },
      };
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
    opens: opensAs({ prp_r: 'cd'.repeat(32) }),
  };
  return { requests, doors };
};

afterEach(() => { cleanup(); });

describe('6. THE PAGE\'S RETRY CONTROL REACHES THE DEVICE PATH, AND SENDS NOTHING ABOUT WHO IS PAID OR WHAT THE VAULT HOLDS', () => {
  it('retries the unpaid, from the vault chosen, through the device check and the device send', async () => {
    const d = aDevice();
    const acted: Array<Promise<void>> = [];
    render(<RetryUnpaid account={account} me={me} runId="run_1" asset="GBP" viewingKey={'aa'.repeat(32) as Hex}
      view={STOPPED} busy={false} act={async (fn) => { const p = fn(); acted.push(p); await p; }}
      doors={async () => d.doors} listVaults={async () => [VAULT]} />);
    /* RED WHEN: a stopped run with unpaid people offers no way to retry them. */
    expect(screen.getByText(/#3, #5, #6/u)).toBeTruthy();
    await act(async () => { fireEvent.click(document.querySelector('[data-retry-open]')!); });
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(document.querySelector('[data-raise-vault]')!, { target: { value: VAULT } });
    await act(async () => { fireEvent.click(document.querySelector('[data-retry-send]')!); });
    await act(async () => { await Promise.all(acted); });
    /* RED WHEN: the control does not go through the device path - the vault checked here, then written down, checked again, sent. */
    expect(d.requests.map((r) => r.route)).toEqual(['retry-payments', 'retry', 'retry-payments', 'retry-send', 'standing']);
    const retry = d.requests[1]!.body as Record<string, unknown>;
    /* RED WHEN: the control names anybody but the unpaid, or its retry is not marked as the device's. */
    expect(retry.indices).toEqual([2, 4, 5]);
    expect(retry.vault).toBe(VAULT);
    expect(retry.onDevice).toBe(true);
    expect(retry.version).toBe(DEVICE_RAISE_VERSION);
    /* RED WHEN: anything the control sends carries a note, the pool or a balance. */
    const everything = JSON.stringify(d.requests);
    expect(everything).not.toContain(POOL[0]!.nonce);
    expect(everything).not.toContain(POOL[0]!.value.toString());
    expect(everything).not.toMatch(/nonce|pool|balance|held|notes|address/u);
  });

  it('is not shown when nobody on the run is left unpaid, or nobody can say', () => {
    const d = aDevice();
    const props = { account, me, runId: 'run_1', asset: 'GBP', viewingKey: 'aa'.repeat(32) as Hex, busy: false,
      act: async () => {}, doors: async () => d.doors, listVaults: async () => [VAULT] };
    render(<RetryUnpaid {...props} view={{ answered: false }} />);
    render(<RetryUnpaid {...props} view={{ ...STOPPED, status: { ...STOPPED.status, outstanding: [], stranded: [] } }} />);
    /* RED WHEN: a Retry control is offered with nobody to retry, or over an unanswered view. */
    expect(document.querySelector('[data-retry-unpaid]')).toBeNull();
  });
});

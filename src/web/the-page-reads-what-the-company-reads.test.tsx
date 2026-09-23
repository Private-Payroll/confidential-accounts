// @vitest-environment jsdom
/**
 * **WHAT THE PAGE OFFERS IS DECIDED FROM THE FACTS THE COMPANY DECIDES FROM.**
 *
 * Which people a retry nobody was told about still covers, which retries the
 * payout panel lists, when Withdraw is taken away, and how the page's own
 * reader checks the vault before anything is written down. The controls are
 * rendered and driven; the network, the background thread and the vault's pool
 * store are the doubles, and nothing else is.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Account, PayrollRun } from '../core/types.js';
import type { Hex } from '../core/crypto.js';
import type { PoolNote } from './device-vault-holdings.js';

const POOL = vi.hoisted(() => ({ notes: [] as PoolNote[] }));
vi.mock('./keyring.js', async (original) => ({
  ...(await original<typeof import('./keyring.js')>()),
  signerMaterialFor: () => ({ signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) }),
  currentUser: () => ({ id: 'usr_1' }),
}));
const built = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./vault-worker-client.js', async (original) => {
  const { paymentsFitNotes } = await import('./vault-builder.js');
  return {
    ...(await original<typeof import('./vault-worker-client.js')>()),
    startVaultBuilder: async () => ({
      governedCall: async () => { built.calls += 1; return { tx: 'TX' }; },
      commitments: async ({ coin }: { coin: { nonce: string } }) => ({ held: `c${coin.nonce.slice(1)}` }),
      paymentsFit: async (args: Parameters<typeof paymentsFitNotes>[0]) => paymentsFitNotes(args),
    }),
  };
});
vi.mock('../midnight/vault-pool.js', async (original) => ({
  ...(await original<typeof import('../midnight/vault-pool.js')>()),
  SealedNotePool: class { async load() { return { notes: POOL.notes }; } },
}));

const { RetryUnpaid, WithdrawRound } = await import('./GovernedCallControls.js');
const { PayoutPanel, isPayableRetry } = await import('./PayoutPanel.js');
const { pendingRetries } = await import('./governed-call-on-device.js');
const { untoldRetryRounds } = await import('../core/retry-cover.js');
const { seal, canonical } = await import('../core/crypto.js');
const { SEED_ASSETS } = await import('../core/assets.js');

const PRIVATE = SEED_ASSETS.find((a) => a.ledger.shielded !== null)!;
const VK = 'aa'.repeat(32) as Hex;
const VAULT = '99'.repeat(32);
const NOW = 1_600_000_000;
const now = () => NOW;
const account = { id: 'acc_1', name: 'Northwind', signers: [] } as unknown as Account;
const me = { signerId: 'sgn_1', signingSecret: '11'.repeat(32) as Hex, wrappingSecret: '22'.repeat(32) as Hex };
const payee = (index: number, state: 'paid' | 'failed' | 'unsent') => ({ index, state });
const OWED = [payee(2, 'failed'), payee(4, 'unsent'), payee(5, 'unsent')];
const STOPPED = { answered: true as const, status: { verified: true, phase: 'closed', outstanding: OWED, stranded: OWED } };

/* A retry of #3 and #5 written onto the leg whose raise never answered: no proposal on the entry. */
const untoldEntry = (over: { originalIndices?: number[]; closesAt?: number } = {}) => ({
  originalIndices: over.originalIndices ?? [2, 4], opensAt: String(NOW + 100), closesAt: String(over.closesAt ?? NOW + 3_600), vault: VAULT,
});
/* A retry round written down for #3 and #5, as the company keeps it: which run, leg and people are in its sealed payload. */
const writtenDown = (over: { status?: string; people?: number[]; runId?: string; asset?: string; id?: string } = {}) => ({
  id: over.id ?? 'prp_t', status: over.status ?? 'open', kind: 'payroll', chainId: 'ce'.repeat(32),
  sealedPayload: seal(canonical({
    runId: over.runId ?? 'run_1', retry: over.people ?? [2, 4], __change: { asset: over.asset ?? PRIVATE.code },
  }), VK),
});
const offered = () => screen.queryByText(/on this\s+run (is|are) not\s+paid \(([^)]*)\)/u)?.textContent?.match(/\((#[^)]*)\)/u)?.[1] ?? null;
const renderRetry = (retries: unknown[], rounds: unknown[]) => render(
  <RetryUnpaid account={account} me={me} runId="run_1" asset={PRIVATE.code} viewingKey={VK} view={STOPPED} busy={false}
    act={async (fn) => { await fn(); }} retries={retries as never} rounds={rounds as never} now={now} />);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); built.calls = 0; POOL.notes = []; });

describe('5. A RETRY NOBODY WAS TOLD ABOUT COVERS ITS PEOPLE ONLY WHILE ITS ROUND CAN STILL REACH THE CHAIN', () => {
  it('covers them while its round is written down and live, and the page shows what sends it', () => {
    renderRetry([untoldEntry()], [writtenDown()]);
    expect(document.querySelector('[data-pending-retry="untold"]')).not.toBeNull();
    /* RED WHEN: people a live round may still pay are offered again - the company refuses that retry. */
    expect(offered()).toBe('#6');
  });

  for (const [why, rounds] of [
    ['its round was withdrawn', [writtenDown({ status: 'cancelled' })]],
    ['its round was stopped by the company\'s policy', [writtenDown({ status: 'blocked' })]],
    ['no round was ever written down for it', []],
    ['the only round written down is another run\'s', [writtenDown({ runId: 'run_2' })]],
    ['the only round written down is for another leg of the run', [writtenDown({ asset: 'ANOTHER' })]],
  ] as const) {
    it(`does not hide its people when ${why}`, () => {
      renderRetry([untoldEntry()], [...rounds]);
      /* RED WHEN: an entry with no proposal covers its people by itself - the page hides people the company would let a retry pay. */
      expect(document.querySelector('[data-pending-retry]')).toBeNull();
      expect(offered()).toBe('#3, #5, #6');
      expect(document.querySelector('[data-retry-open]')).not.toBeNull();
    });
  }

  it('covers the people of a round no entry names exactly, as the company does, and shows what withdraws it', async () => {
    const withdrawn: string[] = [];
    render(<RetryUnpaid account={account} me={me} runId="run_1" asset={PRIVATE.code} viewingKey={VK} view={STOPPED} busy={false}
      act={async (fn) => { await fn(); }} retries={[untoldEntry()] as never} rounds={[writtenDown({ people: [2] })] as never}
      now={now} withdraw={async (id) => { withdrawn.push(id); }} />);
    /* RED WHEN: #3 is offered while a round that may still pay them is written down - the company refuses that retry. */
    expect(offered()).toBe('#5, #6');
    expect(document.querySelector('[data-untold-round="prp_t"]')?.textContent).toMatch(/A retry of #3 is written down/u);
    /* The entry for #3 and #5 is not a retry anything can send: no round is written down for exactly them. */
    expect(document.querySelector('[data-pending-retry]')).toBeNull();
    await act(async () => { fireEvent.click(document.querySelector('[data-untold-round="prp_t"] [data-withdraw-round="prp_t"]')!); });
    /* RED WHEN: the page shows the round and offers no way to release its people. */
    expect(withdrawn).toEqual(['prp_t']);
  });

  it('decides it as the company decides it', () => {
    const e = (people: number[], closesAt: number, proposalId?: string) =>
      ({ originalIndices: people, closesAt: String(closesAt), ...(proposalId ? { proposalId } : {}) });
    const r = (id: string, status: string, retry?: number[]) => ({ id, status, ...(retry ? { retry } : {}) });
    const at = BigInt(NOW);
    const ids = (entries: ReturnType<typeof e>[], rounds: ReturnType<typeof r>[], except?: string) =>
      untoldRetryRounds(entries, rounds, at, except).map((c) => `${c.round.id}:${c.closesAt ?? 'open'}`);
    /* RED WHEN: any clause the company refuses a retry by is read differently here. */
    expect(ids([e([1], NOW + 5)], [r('a', 'open', [1])])).toEqual([`a:${NOW + 5}`]);
    expect(ids([e([1], NOW + 5), e([1], NOW + 9)], [r('a', 'approved', [1])])).toEqual([`a:${NOW + 9}`]);
    expect(ids([], [r('a', 'open', [1])])).toEqual(['a:open']);
    expect(ids([e([1], NOW)], [r('a', 'open', [1])])).toEqual([]);
    expect(ids([e([1], NOW + 5)], [r('a', 'cancelled', [1]), r('b', 'blocked', [1])])).toEqual([]);
    expect(ids([e([1], NOW + 5, 'a')], [r('a', 'open', [1])])).toEqual([]);
    expect(ids([e([1], NOW + 5)], [r('a', 'open', [1])], 'a')).toEqual([]);
    expect(ids([e([1], NOW + 5)], [r('leg', 'open')])).toEqual([]);
    /* RED WHEN: a window is read off an entry that already names its proposal. */
    expect(ids([e([1], NOW + 50, 'b'), e([1], NOW + 5)], [r('a', 'open', [1])])).toEqual([`a:${NOW + 5}`]);
    expect(ids([e([1], NOW - 50, 'b')], [r('a', 'open', [1])])).toEqual(['a:open']);
    /* And the page's own list of what is waiting to be sent reads the same answer. */
    const entry = { originalIndices: [1], opensAt: '0', closesAt: String(NOW + 5), vault: VAULT };
    expect(pendingRetries([entry], [], NOW, [r('a', 'open', [1])]).map((p) => p.kind)).toEqual(['untold']);
    expect(pendingRetries([entry], [], NOW, [r('a', 'cancelled', [1])])).toEqual([]);
  });
});

describe('6. A RETRY THE CHAIN SAYS IS APPROVED IS OFFERED FOR PAYMENT, WHATEVER THE RECORD HERE SAYS', () => {
  const round = (over: Record<string, unknown>) => [{ id: 'prp_r', raisedAt: 'then', status: 'open', ...over }];
  const satisfied = { state: 'satisfied', approvals: 2, threshold: 2 };

  it('reads the chain\'s count when the record still says open', () => {
    /* RED WHEN: a retry the chain holds as approved is hidden because its last approval was not written down here. */
    expect(isPayableRetry({ proposalId: 'prp_r' }, round({ approvalRound: satisfied }))).toBe(true);
    expect(isPayableRetry({ proposalId: 'prp_r' }, round({ status: 'approved' }))).toBe(true);
    /* RED WHEN: a retry is offered on anything short of the chain holding it with its approvals in. */
    expect(isPayableRetry({ proposalId: 'prp_r' }, round({ approvalRound: { state: 'short', approvals: 1, threshold: 2 } }))).toBe(false);
    expect(isPayableRetry({ proposalId: 'prp_r' }, round({}))).toBe(false);
    expect(isPayableRetry({ proposalId: 'prp_r' }, round({ approvalRound: satisfied, raisedAt: undefined }))).toBe(false);
    /* RED WHEN: a withdrawn, stopped or settled round is offered because the chain once counted it. */
    for (const status of ['cancelled', 'blocked', 'executed', 'rejected']) {
      expect(isPayableRetry({ proposalId: 'prp_r' }, round({ status, approvalRound: satisfied })), status).toBe(false);
    }
  });

  it('lists it in the payout panel', () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
    const run = {
      id: 'run_1', period: '2026-08', proposalIds: { GBP: 'prp_leg' }, employees: [],
      payout: { GBP: { retries: [{ originalIndices: [1], opensAt: '1', closesAt: '2', vault: VAULT, proposalId: 'prp_r' }] } },
    } as unknown as PayrollRun;
    render(<PayoutPanel account={account} me={me} viewingKey={VK} runs={[run]} proposals={round({ approvalRound: satisfied })} />);
    const options = [...document.querySelectorAll('[data-payout-run] option')].map((o) => (o as HTMLOptionElement).value);
    /* RED WHEN: the panel decides by the record's status alone. */
    expect(options).toEqual(['', 'run_1:GBP', 'run_1:GBP:prp_r']);
  });
});

describe('7. WITHDRAW IS TAKEN AWAY WHEN ITS WINDOW OPENS, WITHOUT A RELOAD', () => {
  const onChain = { id: 'prp_u', status: 'open', raisedAt: 'then' };
  const clock = () => Math.floor(Date.now() / 1000);

  it('on its own', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    render(<WithdrawRound round={onChain} opensAt={NOW + 60} viewingKey="k" busy={false} now={clock} act={async () => {}} />);
    expect(document.querySelector('[data-withdraw-round]')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(59_000); });
    expect(document.querySelector('[data-withdraw-round]')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(1_000); });
    /* RED WHEN: the window is judged only when the page is drawn - a page left open offers a Withdraw the chain refuses. */
    expect(document.querySelector('[data-withdraw-round]')).toBeNull();
  });

  it('beside a retry on chain, which stops saying its window has not opened', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    render(<RetryUnpaid account={account} me={me} runId="run_1" asset={PRIVATE.code} viewingKey={VK} view={STOPPED} busy={false}
      act={async () => {}} now={clock} rounds={[onChain]}
      retries={[{ originalIndices: [2, 4], opensAt: String(NOW + 30), closesAt: String(NOW + 3_600), vault: VAULT, proposalId: 'prp_u' }]} />);
    expect(document.querySelector('[data-unopened-retry] [data-withdraw-round="prp_u"]')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    /* RED WHEN: the row or its Withdraw outlives the window opening on a page that was not reloaded. */
    expect(document.querySelector('[data-withdraw-round]')).toBeNull();
    expect(document.querySelector('[data-unopened-retry]')).toBeNull();
  });

  it('waits again when its timer fires before the clock it reads has reached the moment', async () => {
    vi.useFakeTimers();
    let clockSays = NOW + 9;
    render(<WithdrawRound round={onChain} opensAt={NOW + 10} viewingKey="k" busy={false} now={() => clockSays} act={async () => {}} />);
    /* The timer runs its second while this machine's clock does not move. */
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(document.querySelector('[data-withdraw-round]')).not.toBeNull();
    clockSays = NOW + 10;
    await act(async () => { vi.advanceTimersByTime(1_000); });
    /* RED WHEN: a timer that fired early is not set again - Withdraw then stays until something else redraws the page. */
    expect(document.querySelector('[data-withdraw-round]')).toBeNull();
  });

  it('waits in steps for a window further off than a browser timer holds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const far = NOW + 40 * 86_400;
    const waits = vi.spyOn(globalThis, 'setTimeout');
    render(<WithdrawRound round={onChain} opensAt={far} viewingKey="k" busy={false} now={clock} act={async () => {}} />);
    /* RED WHEN: a wait longer than a browser's timer holds is asked for - a browser fires that at once. */
    expect(waits.mock.calls.map((c) => Number(c[1]))).toEqual([2 ** 31 - 1]);
    /* RED WHEN: a delay past the timer's limit fires at once, or never. */
    await act(async () => { vi.advanceTimersByTime(30 * 86_400_000); });
    expect(document.querySelector('[data-withdraw-round]')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(10 * 86_400_000); });
    expect(document.querySelector('[data-withdraw-round]')).toBeNull();
  });
});

describe('8. THE PAGE\'S OWN VAULT CHECK REFUSES WHAT THE CHAIN DOES NOT BEAR OUT, BEFORE ANYTHING IS WRITTEN DOWN', () => {
  const note = { nonce: '07'.repeat(32) as Hex, token: PRIVATE.ledger.shielded as Hex, value: 987_654_321n, createdIn: 'ee'.repeat(32) as Hex };
  const committed = (n: { nonce: string }) => `c${n.nonce.slice(1)}`;
  const drive = async (view: Record<string, unknown>) => {
    POOL.notes = [note];
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push(url);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (url === '/api/accounts/acc_1/vaults') return json([{ vault: VAULT }]);
      if (url === `/api/accounts/acc_1/vaults/${VAULT}/chain`) return json(view);
      if (url.endsWith('/retry-payments')) {
        return json({ asset: PRIVATE.code, payments: body.indices.map(() => ({ kind: 'shielded', token: PRIVATE.ledger.shielded, amount: '1000' })) });
      }
      return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 500 });
    });
    const failures: unknown[] = [];
    render(<RetryUnpaid account={account} me={me} runId="run_1" asset={PRIVATE.code} viewingKey={VK} view={STOPPED} busy={false}
      act={async (fn) => { await fn().catch((e) => { failures.push(e); }); }} now={now} />);
    await act(async () => { fireEvent.click(document.querySelector('[data-retry-open]')!); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    fireEvent.change(document.querySelector('[data-raise-vault]')!, { target: { value: VAULT } });
    await act(async () => { fireEvent.click(document.querySelector('[data-retry-send]')!); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return { calls, failures };
  };

  it('a record the chain contradicts', async () => {
    const { calls, failures } = await drive({ onChain: true, notesFromThisBuild: true, notes: [committed({ nonce: '08'.repeat(32) })] });
    /* RED WHEN: the page's own reader does not compare its record with the chain, or reads the drift as a balance. */
    expect(String((failures[0] as Error)?.message)).toMatch(/disagrees with the chain/u);
    expect(calls.some((u) => u.endsWith('/retry'))).toBe(false);
    expect(built.calls).toBe(0);
  });

  it('notes nobody vouched for as this build\'s', async () => {
    const { calls, failures } = await drive({ onChain: true, notes: [committed(note)] });
    /* RED WHEN: the page reads notes off a view that does not say they came from a ledger of this build's shape. */
    expect(String((failures[0] as Error)?.message)).toMatch(/could not be read from the chain \(the company's service did not confirm that this vault is laid out/u);
    expect(calls.some((u) => u.endsWith('/retry'))).toBe(false);
  });
});

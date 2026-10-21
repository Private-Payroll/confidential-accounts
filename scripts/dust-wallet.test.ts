/**
 * The fee payer's DUST view against the network: how the network's newest
 * DUST event is read from the indexer, how a view is waited for strictly, and
 * that the DUST wallet installed in place of the wallet library's own keeps
 * writing to the history the wallet is read from. The indexer and the wallet
 * library are stand-ins here; nothing connects to a network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What the installed DUST wallet was configured with. */
let configured: any = null;

vi.mock('@midnight-ntwrk/testkit-js', () => ({
  FluentWalletBuilder: {
    forEnvironment: () => ({ config: { indexerClientConnection: { indexerWsUrl: 'wss://i/ws' }, txHistoryStorage: 'A NEW, EMPTY STORE' } }),
  },
  DEFAULT_DUST_OPTIONS: { ledgerParams: 'params', feeBlocksMargin: 5 },
  WalletSeeds: { fromMasterSeed: () => ({ dust: 'dust-seed' }) },
}));
vi.mock('@midnightntwrk/wallet-sdk', () => ({
  DustWallet: (config: unknown) => {
    configured = config;
    return { startWithSeed: () => ({ installed: true }), restore: () => null };
  },
}));
vi.mock('@midnight-ntwrk/midnight-js-protocol/ledger', () => ({
  LedgerParameters: { initialParameters: () => ({ dust: 'dust-params' }) },
}));
vi.mock('@midnightntwrk/wallet-sdk/dust/v1', () => { throw new Error('not loaded in this test'); });

import type { TipSocket } from './dust-wallet.js';

const { dustTipAt, waitForDustAtTip, dustAppliedOf, dustNumbers, installDustWallet, describeDustView } = await import('./dust-wallet.js');

beforeEach(() => { configured = null; });

/** An indexer stand-in: answers the handshake, then each question with the frames given. */
function indexer(answer: (question: any) => unknown[] | 'close' | 'error' | 'silent') {
  const asked: any[] = [];
  const open = (url: string): TipSocket => {
    asked.push({ url });
    const s: TipSocket = {
      onopen: null, onmessage: null, onerror: null, onclose: null,
      send: (data: string) => {
        const said = JSON.parse(data);
        asked.push(said);
        queueMicrotask(() => {
          if (said.type === 'connection_init') { s.onmessage?.({ data: JSON.stringify({ type: 'connection_ack' }) }); return; }
          const frames = answer(said);
          if (frames === 'close') s.onclose?.();
          else if (frames === 'error') s.onerror?.({ message: 'refused' });
          else if (frames !== 'silent') for (const f of frames) s.onmessage?.({ data: JSON.stringify(f) });
        });
      },
      close: () => { asked.push('closed'); },
    };
    queueMicrotask(() => s.onopen?.());
    return s;
  };
  return { open, asked };
}

describe('the network\'s newest DUST event, read from the indexer', () => {
  /*
   * RED WHEN: the tip is read from anything but the highest id the indexer sends with an event.
   * RED WHEN: the question starts anywhere but the view's own applied event, which the indexer is sure to hold.
   */
  it('asks from the view\'s own applied event and answers the highest id the indexer holds', async () => {
    const ix = indexer(() => [{ type: 'next', payload: { data: { dustLedgerEvents: { id: 120, maxId: 157159 } } } }]);
    await expect(dustTipAt('wss://i/ws', 120n, 1_000, ix.open)).resolves.toBe(157159n);
    const question = ix.asked.find((a) => a?.type === 'subscribe');
    expect(question.payload.variables).toEqual({ id: 120 });
    expect(question.payload.query).toMatch(/dustLedgerEvents\(id: \$id\) \{ id maxId \}/);
    expect(ix.asked).toContain('closed');
  });

  /*
   * RED WHEN: a tip that was not read (refused, closed, unanswered, or answered without a number) is taken as reached.
   */
  it('refuses when the indexer refuses, closes, does not answer, or answers without a highest id', async () => {
    await expect(dustTipAt('u', 1n, 1_000, indexer(() => [{ type: 'error', payload: [{ message: 'no' }] }]).open)).rejects.toThrow(/refused the question/);
    await expect(dustTipAt('u', 1n, 1_000, indexer(() => 'close').open)).rejects.toThrow(/closed the connection/);
    await expect(dustTipAt('u', 1n, 1_000, indexer(() => 'error').open)).rejects.toThrow(/could not be reached/);
    await expect(dustTipAt('u', 1n, 30, indexer(() => 'silent').open)).rejects.toThrow(/did not say/);
    await expect(dustTipAt('u', 1n, 1_000, indexer(() => [{ type: 'next', payload: { data: { dustLedgerEvents: {} } } }]).open))
      .rejects.toThrow(/without its highest DUST event/);
  });
});

/** A live wallet whose applied index the test moves, and a clock that moves only when the wait sleeps. */
function rig(applied: bigint | null, onSleep: (t: number, live: { applied: bigint | null }) => void = () => {}) {
  const live = { applied };
  let t = 0;
  const notes: string[] = [];
  const opts = {
    now: () => t,
    sleep: async (ms: number) => { t += ms; onSleep(t, live); },
  };
  const wallet = { state: () => ({ dust: { progress: { appliedIndex: live.applied ?? 0n } } }) };
  return { live, notes, opts, wallet, note: (s: string) => notes.push(s), elapsed: () => t };
}

describe('waiting for the view to reach the network, strictly', () => {
  /*
   * RED WHEN: a view short of the network by any number of events counts as reached.
   */
  it('answers ok only when the view has applied every event the indexer held', async () => {
    const r = rig(99n, (t, live) => { if (t >= 4_000) live.applied = 100n; });
    const at = await waitForDustAtTip(r.wallet, async () => 100n, r.note, r.opts);
    expect(at).toEqual({ ok: true, applied: 100n, tip: 100n });
    expect(r.elapsed()).toBe(4_000);
  });

  /*
   * RED WHEN: a stalled view, which reports itself complete, is waited for as long as a moving one, or taken as reached.
   */
  it('refuses a view that has not moved for a minute, and says where it stands', async () => {
    const r = rig(50n);
    const at = await waitForDustAtTip(r.wallet, async () => 100n, r.note, r.opts);
    expect(at).toEqual({ ok: false, why: expect.stringMatching(/has not moved for 60 s \(dust applied 50 of 100\)/) });
    expect(r.elapsed()).toBe(60_000);
  });

  /*
   * RED WHEN: a view that keeps moving is refused as stalled, or is waited for without end.
   */
  it('keeps waiting while the view moves, up to twenty minutes in all', async () => {
    const r = rig(0n, (_t, live) => { live.applied = (live.applied ?? 0n) + 1n; });
    const at = await waitForDustAtTip(r.wallet, async () => 10_000_000n, r.note, r.opts);
    expect(at).toEqual({ ok: false, why: expect.stringMatching(/within 20 minutes/) });
    expect(r.elapsed()).toBe(20 * 60_000);
    /* RED WHEN: the progress line names fields the wallet does not have, and reads as unknown. */
    expect(r.notes[0]).toMatch(/^\s+10s {2}dust applied 10 of 10000000$/);
  });

  /*
   * RED WHEN: a tip the indexer did not give is taken as reached.
   */
  it('refuses when the indexer cannot say where the network is', async () => {
    const r = rig(5n);
    const at = await waitForDustAtTip(r.wallet, async () => { throw new Error('the indexer is away'); }, r.note, r.opts);
    expect(at).toEqual({ ok: false, why: expect.stringMatching(/the indexer is away/) });
  });

  /*
   * RED WHEN: a view with nothing applied yet reads as having applied event zero, and reaches an empty network's tip.
   */
  it('a view that has applied nothing has no applied event', () => {
    expect(dustAppliedOf({ appliedIndex: 0n })).toBeNull();
    expect(dustAppliedOf({ appliedIndex: 7n })).toBe(7n);
    expect(dustAppliedOf(undefined)).toBeNull();
  });
});

describe('the numbers written down when a fee is not paid', () => {
  /*
   * RED WHEN: a refusal is written down without how far the view has got, the coins free, booked and unbooked, or the balance.
   */
  it('reads how far the view has got, the coins and the balance, and never throws', () => {
    const state = {
      dust: {
        progress: { appliedIndex: 40n },
        availableCoins: [1, 2],
        state: { pendingDust: [1], state: { utxos: [1, 2, 3] } },
        balance: () => 25n,
      },
    };
    expect(dustNumbers(state, 41n)).toBe('dust applied 40 of 41; 2 coins free to spend, 1 booked by the wallet, 3 unbooked in the ledger state; balance 25');
    expect(dustNumbers(null, null)).toBe('dust applied ? of ?; ? coins free to spend, ? booked by the wallet, ? unbooked in the ledger state; balance ?');
  });
});

describe('the DUST wallet installed in place of the wallet library\'s own', () => {
  /*
   * RED WHEN: the installed DUST wallet writes its history to a store the wallet is not read from, so a fee payer
   * waiting to see its own last payment never sees it.
   */
  it('writes its history to the store the wallet was built with', async () => {
    const replaced = { constructor: { configuration: { txHistoryStorage: 'THE WALLET\'S OWN STORE' } } };
    const wallet = { wallet: { dust: replaced } };
    await installDustWallet(wallet, {}, 'ab'.repeat(32), 'stagenet', '/nowhere-that-exists');
    expect(configured.txHistoryStorage).toBe('THE WALLET\'S OWN STORE');
    expect(wallet.wallet.dust).toEqual({ installed: true });
  });

  /*
   * RED WHEN: a wallet whose history store cannot be found is given a fresh, empty one in silence, so as a fee payer it
   * would refuse every fee after its first.
   */
  it('refuses the bring-up, saying why, when the wallet\'s history store cannot be found', async () => {
    const wallet = { wallet: { dust: { constructor: { configuration: {} } } } };
    await expect(installDustWallet(wallet, {}, 'ab'.repeat(32), 'stagenet', '/nowhere-that-exists'))
      .rejects.toThrow(/history store/);
    expect(configured).toBeNull();
  });
});

describe('how far a view has got, as an operator reads it', () => {
  /* RED WHEN: a view whose applied event cannot be read is printed as one that has applied none. */
  it('prints ? for an applied event that cannot be read, as it does for an unknown tip', () => {
    expect(describeDustView(null, 5n)).toBe('dust applied ? of 5');
    expect(describeDustView(4n, null)).toBe('dust applied 4 of ?');
  });
});

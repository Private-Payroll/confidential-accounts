/**
 * Wallet bring-up.
 *
 * This exists because the procedure was written twice and the second copy was
 * missing `await wallet.start(false)` — so the wallet was built, never began
 * syncing, and every fee proof it produced was rejected by the node as `170`.
 * Three runs were spent diagnosing a missing line, and the compiler could not
 * help: calling one fewer method is not a type error.
 *
 * So the tests here are about ORDER and PRESENCE of calls rather than return
 * values. Nothing else can catch the failure that actually happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const removed: string[] = [];
const installs: Array<{ how: string }> = [];
let installHow: 'restored' | 'fresh' = 'fresh';

vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  rmSync: (p: string) => { removed.push(String(p)); },
}));

vi.mock('./dust-wallet.js', () => ({
  installDustWallet: async () => {
    installs.push({ how: installHow });
    return { how: installHow, detail: 'stub' };
  },
  dustCachePath: () => '/tmp/stub-dust-cache.state',
}));

/** Every call, in order, so a missing or misordered step is visible. */
let trace: string[] = [];
/** How much DUST each successive wallet reports. One entry per build. */
let dustPerBuild: bigint[] = [];
/** Whether the shielded scan reports itself caught up. `false` makes the wait run out. */
let shieldedCaught = true;
let builds = 0;

vi.mock('@midnight-ntwrk/testkit-js', () => ({
  MidnightWalletProvider: {
    build: async () => {
      const mine = builds++;
      trace.push(`build#${mine}`);
      const dust = dustPerBuild[mine] ?? 0n;
      let started = false;
      return {
        start: async (gate: boolean) => { trace.push(`start(${gate})#${mine}`); started = true; },
        stop: async () => { trace.push(`stop#${mine}`); },
        wallet: {
          state: () => {
            trace.push(`subscribe#${mine}${started ? '' : ' BEFORE-START'}`);
            return {
              subscribe: ({ next }: { next: (s: unknown) => void }) => {
                next({
                  dust: { balance: () => dust },
                  unshielded: { balances: { NIGHT_TOKEN: 5n }, progress: { isCompleteWithin: () => true } },
                  shielded: { progress: { isConnected: shieldedCaught, isCompleteWithin: () => shieldedCaught } },
                });
                return { unsubscribe: () => { trace.push(`unsubscribe#${mine}`); } };
              },
            };
          },
        },
      };
    },
  },
}));

vi.mock('@midnight-ntwrk/midnight-js-protocol/ledger', () => ({
  unshieldedToken: () => ({ raw: 'NIGHT_TOKEN' }),
}));

const { bringUpWallet } = await import('./wallet-bringup.js');

const bring = (opts = {}) =>
  bringUpWallet({}, {}, 'seed', 'stagenet' as never, '/tmp', {
    cachedTimeoutMs: 60, coldTimeoutMs: 60, ...opts,
  });

beforeEach(() => {
  trace = []; builds = 0; dustPerBuild = []; removed.length = 0;
  installs.length = 0; installHow = 'fresh'; shieldedCaught = true;
});

describe('bringUpWallet', () => {
  it('STARTS the wallet — the omission that cost four runs', async () => {
    dustPerBuild = [7n];
    await bring();
    expect(trace).toContain('start(false)#0');
  });

  it('starts with false, never the testkit sync gate', async () => {
    // `start(true)` is M-22 and does not return. A run that hangs forever is
    // worse than one that fails.
    dustPerBuild = [7n];
    await bring();
    expect(trace).not.toContain('start(true)#0');
  });

  it('installs dust BEFORE starting, and subscribes AFTER', async () => {
    /*
     * Both halves matter and both were learned by failing. Starting before the
     * dust wallet is installed begins a sync the restored state then has to be
     * reconciled against; subscribing before `start` delivers a state that
     * never changes, which reads exactly like a slow network.
     */
    dustPerBuild = [7n];
    await bring();
    const start = trace.indexOf('start(false)#0');
    const subscribe = trace.findIndex(t => t.startsWith('subscribe#0'));
    expect(installs).toHaveLength(1);
    expect(start).toBeGreaterThan(-1);
    expect(subscribe).toBeGreaterThan(start);
    expect(trace.some(t => t.includes('BEFORE-START'))).toBe(false);
  });

  it('reads DUST through the method, not a field', async () => {
    // `dust.balance(new Date())`, because dust accrues over time. Reading it as
    // a property returns undefined and every gate downstream passes wrongly.
    dustPerBuild = [42n];
    const live = await bring();
    expect(live.dust()).toBe(42n);
    expect(live.night()).toBe(5n);
  });

  it('skips dust entirely for a wallet that is meant to be empty', async () => {
    // The sponsorship test's customer. Installing a dust wallet it will never
    // use only adds a sync, and waiting for DUST that will never arrive would
    // hang the run.
    const live = await bring({ withDust: false });
    expect(installs).toHaveLength(0);
    expect(live.dust()).toBe(0n);
    expect(trace).toContain('start(false)#0');
  });

  it('discards a stale cache and rebuilds from scratch', async () => {
    /*
     * The cache saves 284 seconds a run and the risk it adds is a cache that no
     * longer matches the chain — the wallet then sits at zero DUST forever,
     * looking like a slow network. The cache is the only thing that changed, so
     * it is the suspect.
     */
    installHow = 'restored';
    dustPerBuild = [0n, 9n];   // restored wallet finds nothing; the cold one does
    const live = await bring();

    expect(removed).toEqual(['/tmp/stub-dust-cache.state']);
    expect(trace).toContain('build#1');
    expect(trace).toContain('start(false)#1');
    expect(live.dust()).toBe(9n);
  });

  it('does not install dust a second time on the retry', async () => {
    // The cache has just been deleted; re-running the installer would restore
    // nothing and only cost time.
    installHow = 'restored';
    dustPerBuild = [0n, 9n];
    await bring();
    expect(installs).toHaveLength(1);
  });

  it('throws when DUST never arrives and the caller said it must', async () => {
    // Returning a wallet that cannot pay means the failure surfaces later as
    // node rejection 170, which names none of this.
    dustPerBuild = [0n];
    await expect(bring({ requireDust: true })).rejects.toThrow(/no DUST/i);
  });

  it('returns a usable wallet without DUST when the caller allows it', async () => {
    dustPerBuild = [0n];
    const live = await bring({ requireDust: false });
    expect(live.dust()).toBe(0n);
    expect(live.wallet).toBeTruthy();
  });

  /*
   * **THE SHIELDED SCAN. `S17`.**
   *
   * The dust catch-up above is unconditional because every submitting door
   * needs it. This one is not, and the asymmetry is the design rather than an
   * oversight: only a door that reads a SHIELDED coin needs it, nothing caches
   * shielded state here, so asking for it costs a replay from genesis. Turning
   * it on for everybody would put that in front of every deploy and every
   * measurement door.
   *
   * **What is NOT the caller's is the implementation.** One wait, in
   * `shielded-wallet.ts`, and the deposit door reaches it through this option.
   */
  it('does NOT wait for the shielded scan unless the caller asks', async () => {
    dustPerBuild = [7n];
    const live = await bring();
    expect(live.shieldedScan()).toBeNull();
  });

  it('waits for the shielded scan when the caller asks, and reports what it concluded', async () => {
    dustPerBuild = [7n];
    const live = await bring({ withShielded: true });
    const scan = live.shieldedScan();
    expect(scan?.reached).toBe('caught-up');
    expect(scan?.caughtUp).toBe(true);
  });

  it('RETURNS A WALLET when the shielded scan runs out, rather than throwing', async () => {
    /*
     * The wait is bounded and non-fatal, like the dust catch-up. The refusal
     * belongs at the door that needs the coin, because that door is the only
     * one that can tell *the scan has not caught up* from *there is no such
     * coin* — and a bring-up that threw would print neither.
     */
    dustPerBuild = [7n];
    shieldedCaught = false;
    const live = await bring({ withShielded: true, shieldedTimeoutMs: 20 });
    expect(live.shieldedScan()?.reached).toBe('deadline');
    expect(live.shieldedScan()?.caughtUp).toBe(false);
    expect(live.wallet).toBeTruthy();
  });

  it('waits for the shielded scan even for a wallet that skips dust entirely', async () => {
    // `withDust: false` returns early. A shielded caller taking that path would
    // otherwise get the un-waited read this round exists to remove.
    const live = await bring({ withDust: false, withShielded: true });
    expect(live.shieldedScan()?.reached).toBe('caught-up');
  });

  it('exposes the wallet from the LAST build, not the discarded one', async () => {
    // `wallet` is a getter for exactly this reason: a caller holding the
    // pre-retry provider would be talking to a wallet that was stopped.
    installHow = 'restored';
    dustPerBuild = [0n, 9n];
    const live = await bring();
    expect(builds).toBe(2);
    expect(live.wallet).toBeTruthy();
    expect(trace).toContain('stop#0');
  });
});

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
let installHow: 'restored' | 'fresh' | 'unchanged' | 'refused' = 'fresh';
/** The reason a 'refused' carries, which is what the gate switches on. */
let installReason: 'not-a-floor' | 'disagrees' | 'not-applied' | 'unreadable' | undefined;

vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  rmSync: (p: string) => { removed.push(String(p)); },
}));

vi.mock('./dust-wallet.js', () => ({
  installDustWallet: async () => {
    installs.push({ how: installHow });
    return {
      how: installHow,
      detail: 'stub',
      ...(installReason ? { reason: installReason } : {}),
    };
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
  installReason = undefined;
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

  it('INSTALLS DUST AGAIN ON THE RETRY, because the retry builds a new wallet', async () => {
    /*
     * TURNS RED IF: the install is gated on the first attempt again.
     *
     * THIS TEST USED TO ASSERT THE OPPOSITE, on the reasoning that the cache
     * had just been deleted so re-running the installer "would restore nothing
     * and only cost time". Restoring the cache is half of what the installer
     * does. The other half is the fee floor, and the retry builds a WHOLE NEW
     * wallet — so skipping the install left the library's own dust wallet in
     * place, with an overhead of nothing, and the run went on to submit with a
     * fee that can come out at zero. That path fires precisely when the cache
     * has already misbehaved, which is the worst time to lose the floor
     * silently.
     */
    installHow = 'restored';
    dustPerBuild = [0n, 9n];
    await bring();
    expect(installs).toHaveLength(2);
  });

  /*
   * THE FEE-FLOOR GATE.
   *
   * These five exist because the gate had none. It decides whether a money door
   * runs, and before they were written it could have been deleted whole and
   * every other test in this repository would still have passed.
   */
  it('STOPS the run when no wallet of ours was installed at all', async () => {
    // TURNS RED IF: 'unchanged' stops stopping the run. It means the library's
    // own dust wallet is in place, whose fee overhead is nothing — the floor's
    // absence known with certainty. This used to pass silently.
    installHow = 'unchanged';
    dustPerBuild = [7n];
    await expect(bring()).rejects.toThrow(/fee floor in force/i);
  });

  it('STOPS the run when the floor is KNOWN to disagree', async () => {
    // TURNS RED IF: the gate stops switching on the reason. A floor that is
    // wrong is a defect no re-run clears, and the door must not submit on it.
    installHow = 'refused'; installReason = 'disagrees';
    dustPerBuild = [7n];
    await expect(bring()).rejects.toThrow(/fee floor in force/i);
  });

  it('STOPS the run when the floor is set to nothing', async () => {
    // TURNS RED IF: 'not-a-floor' is left out of the known-absent set. A floor
    // of zero is reachable from the environment and every other reading agrees
    // with it, so only the reason distinguishes it.
    installHow = 'refused'; installReason = 'not-a-floor';
    dustPerBuild = [7n];
    await expect(bring()).rejects.toThrow(/fee floor in force/i);
  });

  it('DOES NOT stop the run when the floor merely could not be read back', async () => {
    /*
     * TURNS RED IF: the unknown case is folded in with the known-bad ones.
     *
     * The failure a stop would prevent here is free and loud — a refusal at
     * submission with no fee taken. The failure a stop would CREATE is every
     * money door in this project, this one and the payout door alike, refusing
     * to run because a library renamed a field. The unknown case must not stop
     * anything.
     */
    installHow = 'refused'; installReason = 'unreadable';
    dustPerBuild = [7n];
    const live = await bring();
    expect(live.dust()).toBe(7n);
  });

  it('treats a refusal carrying NO reason as unknown, not as known-bad', async () => {
    // TURNS RED IF: the fallback is written so that a missing reason stops the
    // run. `undefined !== null` is true, and the first version of this gate was
    // written that way — which stopped the door on exactly the case the comment
    // above it said must never stop it.
    installHow = 'refused'; installReason = undefined;
    dustPerBuild = [7n];
    const live = await bring();
    expect(live.dust()).toBe(7n);
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

/**
 * The fee payer's DUST view against the network: how the network's newest
 * block is read from the indexer, how a view is waited for strictly, and
 * how the wallet is built with our DUST wallet in it from the start. The indexer and the wallet
 * library are stand-ins here; nothing connects to a network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What our DUST wallet was configured with, and what the testkit was asked to build. */
let configured: any = null;
let built: { shieldedConfig?: any; facadeDust?: any; facadeShielded?: any; facadeUnshielded?: any; withWallet?: any[] } = {};
let historyStore: unknown = 'THE WALLET\'S OWN STORE';
let restoreThrows: string | null = null;

vi.mock('@midnight-ntwrk/testkit-js', () => ({
  FluentWalletBuilder: {
    forEnvironment: () => ({
      config: { indexerClientConnection: { indexerWsUrl: 'wss://i/ws' }, txHistoryStorage: historyStore, forks: { v9: 2000000n } },
      networkId: 'preprod',
    }),
  },
  DEFAULT_DUST_OPTIONS: { ledgerParams: 'params', feeBlocksMargin: 5 },
  WalletSeeds: { fromMasterSeed: () => ({ dust: 'dust-seed', shielded: 'shielded-seed', unshielded: 'unshielded-seed' }) },
  WalletFactory: {
    createShieldedWallet: async (config: unknown) => { built.shieldedConfig = config; return { shielded: true }; },
    createUnshieldedWallet: async () => ({ unshielded: true }),
    createWalletFacade: async (_c: unknown, shielded: unknown, unshielded: unknown, dust: unknown) => {
      built.facadeDust = dust; built.facadeShielded = shielded; built.facadeUnshielded = unshielded;
      return { dust, shielded, unshielded };
    },
  },
  MidnightWalletProvider: {
    withWallet: async (...args: any[]) => { built.withWallet = args; return { wallet: args[2] }; },
  },
}));
/** The two variants the projections wallet was composed from, and every snapshot a wallet was asked to restore. */
let forking: { v1: any; v2: any } | null = null;
let restoredFrom: string[] = [];
const walletClass = () => ({
  startWithSeed: async () => ({ installed: true, serializeState: async () => 'FRESH STATE' }),
  restore: (saved: string) => {
    restoredFrom.push(saved);
    if (restoreThrows) throw new Error(restoreThrows);
    return null;
  },
});
vi.mock('@midnightntwrk/wallet-sdk', () => ({
  DustWallet: (config: unknown) => { configured = config; return walletClass(); },
  CustomForkingDustWallet: (config: unknown, v1: unknown, v2: unknown) => {
    configured = config;
    forking = { v1, v2 };
    return walletClass();
  },
  dustVariantConfigurations: (c: any) => ({ v1: { ...c, side: 'v1' }, v2: { ...c, side: 'v2' }, migration: 'CROSS-LEDGER' }),
  createKeystore: () => ({ keystore: true }),
  ShieldedWallet: (config: unknown) => ({ restore: (saved: string) => {
    restoredFrom.push(`shielded ${saved}`);
    if (shieldedRestoreThrows) throw new Error(shieldedRestoreThrows);
    return { shielded: 'restored', config };
  } }),
  UnshieldedWallet: () => ({ restore: (saved: string) => { restoredFrom.push(`unshielded ${saved}`); return { unshielded: 'restored' }; } }),
  InMemoryTransactionHistoryStorage: class { readonly fresh = true; },
  WalletEntrySchema: 'schema',
  mergeWalletEntries: 'merge',
}));
let shieldedRestoreThrows: string | null = null;
/** A builder that records each step it is given, so the composition can be read back. */
class Recorder {
  constructor(readonly steps: string[] = []) {}
  private with(step: string) { return new Recorder([...this.steps, step]); }
  withDefaults() { return this.with('defaults'); }
  withSync(service: string, capability: string) { return this.with(`sync ${service} ${capability}`); }
  withStartAuxDefaults() { return this.with('start aux'); }
  withMigration(m: string) { return this.with(`migration ${m}`); }
}
vi.mock('@midnightntwrk/wallet-sdk/dust/v2', () => ({
  V2Builder: Recorder,
  SyncService: { makeEventLessSyncService: 'PROJECTIONS', makeEventLessSyncCapability: 'PROJECTIONS-APPLY' },
}));
vi.mock('@midnight-ntwrk/midnight-js-protocol/v9', () => ({
  LedgerParameters: { initialParameters: () => ({ dust: 'dust-params' }) },
}));
vi.mock('@midnightntwrk/wallet-sdk/dust/v1', () => ({ V1Builder: Recorder }));

import { NETWORK } from 'midnight-identity/network';

const {
  networkHeightAt, waitForDustAtTip, dustNumbers, buildWalletWithDust, describeDustView,
  dustCachePath, saveWalletState, walletCachePath, facadeAtLedger9, reportSync, dustCaughtUp, waitForDustCatchUp,
  registrationSidesSynced,
} = await import('./dust-wallet.js');

const build = (root = '/nowhere-that-exists', options: any = {}, seed = 'ab'.repeat(32)) =>
  buildWalletWithDust('LOGGER', { env: true }, seed, NETWORK, root, { note: () => {}, ...options });

beforeEach(() => {
  configured = null; forking = null; restoredFrom = []; built = {};
  historyStore = 'THE WALLET\'S OWN STORE'; restoreThrows = null; shieldedRestoreThrows = null;
});

describe('the network\'s newest block, read from the indexer', () => {
  /*
   * RED WHEN: the fee payer's target is anything but the height of the indexer's newest block, read now from the
   * address it is given; or an answer without a block is taken as reached.
   */
  it('asks the indexer for its newest block\'s height', async () => {
    const asked: any[] = [];
    const post = async (url: string, init: any) => {
      asked.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ data: { block: { height: 3428717 } } }) };
    };
    await expect(networkHeightAt('https://i/api?k=1', post as any)).resolves.toBe(3428717n);
    expect(asked[0].url).toBe('https://i/api?k=1');
    expect(asked[0].body.query).toMatch(/block\s*\{\s*height\s*\}/);
  });

  it('refuses an answer without a block', async () => {
    await expect(networkHeightAt('u', (async () => ({ json: async () => ({ data: { block: null } }) })) as any))
      .rejects.toThrow(/no newest block/);
  });
});

/** A wallet whose DUST view covers `live.applied` (null: part-way through a pass), and a clock the wait runs by. */
function rig(applied: bigint | null, onSleep: (t: number, live: { applied: bigint | null }) => void = () => {}) {
  const live = { applied };
  let t = 0;
  const notes: string[] = [];
  const opts = {
    now: () => t,
    sleep: async (ms: number) => { t += ms; onSleep(t, live); },
  };
  const wallet = { state: () => ({ dust: { progress: {
    highestIndex: live.applied ?? 7n, isStrictlyComplete: () => live.applied !== null,
  } } }) };
  return { live, notes, opts, wallet, note: (s: string) => notes.push(s), elapsed: () => t };
}

describe('waiting for the view to reach the network, strictly', () => {
  /*
   * RED WHEN: a view short of the network's newest block by any number of blocks counts as reached.
   */
  it('answers ok only when the view covers the newest block the indexer held', async () => {
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
    expect(at).toEqual({ ok: false, why: expect.stringMatching(/has not moved for 60 s \(dust view at block 50 of 100\)/) });
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
    expect(r.notes[0]).toMatch(/^\s+10s {2}dust view at block 10 of 10000000$/);
  });

  /*
   * RED WHEN: a tip the indexer did not give is taken as reached.
   */
  it('refuses when the indexer cannot say where the network is', async () => {
    const r = rig(5n);
    const at = await waitForDustAtTip(r.wallet, async () => { throw new Error('the indexer is away'); }, r.note, r.opts);
    expect(at).toEqual({ ok: false, why: expect.stringMatching(/the indexer is away/) });
  });

  /* RED WHEN: a view part-way through a pass, at the block its last pass reached, is taken as reaching it. */
  it('does not count a view part-way through a pass', async () => {
    const r = rig(null, (t, live) => { if (t >= 5_000) live.applied = 100n; });
    const at = await waitForDustAtTip(r.wallet, async () => 100n, r.note, r.opts);
    expect(at).toEqual({ ok: true, applied: 100n, tip: 100n });
    expect(r.elapsed()).toBe(5_000);
  });
});

describe('the numbers written down when a fee is not paid', () => {
  /*
   * RED WHEN: a refusal is written down without how far the view has got, the coins free, booked and unbooked, or the balance.
   */
  it('reads how far the view has got, the coins and the balance, and never throws', () => {
    const state = {
      dust: {
        progress: { highestIndex: 40n, isStrictlyComplete: () => true },
        availableCoins: [1, 2],
        state: { pendingDust: [1], state: { utxos: [1, 2, 3] } },
        balance: () => 25n,
      },
    };
    expect(dustNumbers(state, 41n)).toBe('dust view at block 40 of 41; 2 coins free to spend, 1 booked by the wallet, 3 unbooked in the ledger state; balance 25');
    expect(dustNumbers(null, null)).toBe('dust view at block ? of ?; ? coins free to spend, ? booked by the wallet, ? unbooked in the ledger state; balance ?');
  });
});

describe('the wallet, built with our DUST wallet in it from the start', () => {
  /*
   * RED WHEN: our DUST wallet is swapped into a facade built with another one, which the facade's protocol version
   * goes on reading; or the facade or the provider are built with anything but the wallets made here.
   */
  it('hands our DUST wallet to the facade it builds, and the facade to the provider', async () => {
    const { wallet } = await build();
    expect(built.facadeDust).toMatchObject({ installed: true });
    expect(wallet.wallet.dust).toBe(built.facadeDust);
    expect(built.withWallet!.slice(0, 2)).toEqual(['LOGGER', { env: true }]);
    expect(built.withWallet![4]).toEqual({ keystore: true });
  });

  /* RED WHEN: the shielded wallet applies the network's events in the library's groups of ten. */
  it('builds the shielded wallet applying events a hundred at a time', async () => {
    await build();
    expect(built.shieldedConfig.batchUpdates).toEqual({ size: 100 });
    expect(built.shieldedConfig.txHistoryStorage).toBe('THE WALLET\'S OWN STORE');
  });

  /*
   * RED WHEN: our DUST wallet writes its history to a store the wallet is not read from, so a fee payer waiting to
   * see its own last payment never sees it.
   */
  it('writes its history to the store the wallet was built with', async () => {
    await build();
    expect(configured.txHistoryStorage).toBe('THE WALLET\'S OWN STORE');
  });

  /* RED WHEN: any wallet is built with the library's event-replay DUST wallet, which replays every DUST event since
   * the fork at about seventy a second. */
  it('builds every DUST wallet to sync by projections', async () => {
    await build();
    expect(forking).not.toBeNull();
    expect(configured.skipLedgerV8DustHistory).toBeUndefined();
    expect(configured.batchUpdates).toBeUndefined();
  });

  /* RED WHEN: a wallet whose history store cannot be found is built anyway, with a fresh, empty one. */
  it('refuses to build, saying why, when the wallet\'s history store cannot be found', async () => {
    historyStore = undefined;
    await expect(build()).rejects.toThrow(/history store/);
    expect(configured).toBeNull();
  });

  /* RED WHEN: the network's ledger 9 version is lost on the way to the registration's wait. */
  it('says where ledger 9 begins, as the wallet was configured', async () => {
    expect((await build()).forkV9).toBe(2000000n);
  });
});

describe('how far a view has got, as an operator reads it', () => {
  /* RED WHEN: a view whose applied event cannot be read is printed as one that has applied none. */
  it('prints ? for an applied event that cannot be read, as it does for an unknown tip', () => {
    expect(describeDustView(null, 5n)).toBe('dust view at block ? of 5');
    expect(describeDustView(4n, null)).toBe('dust view at block 4 of ?');
  });
});

describe('the DUST wallet, syncing by projections', () => {
  /*
   * RED WHEN: a new DUST wallet replays the network's DUST events (hours on preprod) instead of reading its own
   * generations, spends and the collapsed trees from the indexer, or loses the fee floor or the history store doing so.
   */
  it('composes the ledger 9 variant with the projections sync, keeping the fee floor and the history store', async () => {
    const { wallet } = await build();
    expect(forking!.v2.builder.steps).toEqual(
      ['defaults', 'sync PROJECTIONS PROJECTIONS-APPLY', 'start aux', 'migration CROSS-LEDGER']);
    expect(forking!.v2.configuration.side).toBe('v2');
    expect(forking!.v1.builder.steps).toEqual(['defaults']);
    expect(configured.txHistoryStorage).toBe('THE WALLET\'S OWN STORE');
    expect(configured.costParameters.additionalFeeOverhead).toBeGreaterThan(0n);
    expect(typeof configured.chainVersionProbe).toBe('function');
    expect(wallet.wallet.dust).toMatchObject({ installed: true });
  });

  /*
   * RED WHEN: a snapshot written by event replay (the old DUST cache file, or a wallet that has not finished its first
   * pass) is restored into the projections wallet or saved where it reads, so it would start as an event-replay wallet.
   */
  it('reads and writes only snapshots that record the projections sync', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dust-cache-'));
    const seed = 'cd'.repeat(32);
    const projections = dustCachePath(root, NETWORK, seed);
    const oldEvents = join(root, '.wallet-state', `dust-${NETWORK}-${seed.slice(0, 16)}.state`);
    expect(projections).not.toBe(oldEvents);
    mkdirSync(join(root, '.wallet-state'), { recursive: true });
    writeFileSync(oldEvents, 'AN EVENT-REPLAY SNAPSHOT');
    await build(root, {}, seed);
    expect(restoredFrom).toEqual([]);
    const saving = (snapshot: string) => ({ wallet: { dust: { serializeState: async () => snapshot } } });
    await saveWalletState(saving('{"syncKind":"projections","n":1}'), seed, NETWORK, root);
    expect(readFileSync(projections, 'utf8')).toBe('{"syncKind":"projections","n":1}');
    await saveWalletState(saving('{"syncKind":"events","n":2}'), seed, NETWORK, root);
    expect(readFileSync(projections, 'utf8')).toBe('{"syncKind":"projections","n":1}');
    expect(readFileSync(oldEvents, 'utf8')).toBe('AN EVENT-REPLAY SNAPSHOT');
  });

  /*
   * RED WHEN: a cache the wallet library refuses stops the run, or is reported as anything but the file being wrong.
   */
  it('names the cache file when the library refuses it, and starts from the seed instead', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dust-cache-'));
    const seed = 'ef'.repeat(32);
    const projections = dustCachePath(root, NETWORK, seed);
    mkdirSync(join(root, '.wallet-state'), { recursive: true });
    writeFileSync(projections, '{"syncKind":"events"}');
    restoreThrows = 'This dust snapshot was written by a wallet that replays events';
    const { installed, wallet } = await build(root, {}, seed);
    expect(installed.detail).toContain(projections);
    expect(installed.detail).toMatch(/the file is what is wrong/);
    expect(installed.detail).not.toMatch(/fee floor (is|was) not/);
    expect(wallet.wallet.dust).toMatchObject({ installed: true });
  });
});

describe('the DUST sync, made visible', () => {
  /*
   * RED WHEN: a run waiting on the DUST wallet prints nothing, so a person cannot tell a slow sync from a stuck one;
   * or it keeps printing after the wallet has caught up.
   */
  it('prints how far it has got every ten seconds, then once that it is synced, then nothing', () => {
    vi.useFakeTimers();
    try {
      let push: (s: unknown) => void = () => {};
      const dust = { state: { subscribe: (o: any) => { push = o.next; return { unsubscribe: () => {} }; } } };
      const notes: string[] = [];
      reportSync(dust, 'dust wallet', (s) => notes.push(s));
      const progress = (applied: bigint, highest: bigint) => ({
        progress: { appliedIndex: applied, highestRelevantWalletIndex: highest, isStrictlyComplete: () => applied === highest },
      });
      push(progress(5n, 9n));
      vi.advanceTimersByTime(9_999);
      expect(notes).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(notes).toEqual([expect.stringMatching(/^\s+10s {2}dust wallet syncing: 5 of 9$/)]);
      push(progress(9n, 9n));
      vi.advanceTimersByTime(10_000);
      expect(notes[1]).toMatch(/dust wallet synced/);
      vi.advanceTimersByTime(60_000);
      expect(notes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a projections DUST wallet counted caught up only after a pass\'s state update', () => {
  const reading = (applied: bigint, highest: bigint, height: bigint) => ({
    appliedIndex: applied, highestRelevantWalletIndex: highest, highestIndex: height,
    isConnected: true, isStrictlyComplete: () => applied === highest, isCompleteWithin: () => true,
  });

  /*
   * RED WHEN: a complete reading taken before a pass's state update (the block height has not moved) counts as
   * caught up, so a restored cache a few tree entries behind is used to pay.
   */
  it('needs a complete reading whose block height has moved since the wait began', () => {
    expect(dustCaughtUp(reading(9n, 9n, 100n), 100n)).toBe(false);
    expect(dustCaughtUp(reading(8n, 9n, 101n), 100n)).toBe(false);
    expect(dustCaughtUp(reading(9n, 9n, 101n), 100n)).toBe(true);
  });

  /* RED WHEN: the wait returns on the reading it started with. */
  it('waits for the next pass, not the reading it began with', async () => {
    let state: any = { dust: { state: { progress: reading(9n, 9n, 100n) } } };
    let t = 0;
    const sleep = async (ms: number) => {
      t += ms;
      if (t >= 3_000) state = { dust: { state: { progress: reading(9n, 9n, 101n) } } };
    };
    await expect(waitForDustCatchUp({ state: () => state }, () => {}, () => '', 60_000, { sleep, now: () => t })).resolves.toBe(true);
    expect(t).toBe(3_000);
  });
});

describe('what a NIGHT registration waits for', () => {
  /*
   * RED WHEN: a registration waits for the shielded wallet's sync, which it reads none of; or does not wait for the
   * facade to write for ledger 9, so a registration written for ledger 8 is refused by the node.
   */
  it('waits for the facade to reach ledger 9, then for the unshielded and DUST sides only, saying where it stands', async () => {
    let version = 1000n;
    let t = 0;
    const asked: string[] = [];
    const facade = {
      currentVersion: () => version,
      shielded: { waitForSyncedState: async () => { asked.push('shielded'); return {}; } },
      unshielded: { waitForSyncedState: async () => { asked.push('unshielded'); return { availableCoins: ['night'] }; } },
      dust: { waitForSyncedState: async () => { asked.push('dust'); return { address: 'dust-address' }; } },
    };
    const notes: string[] = [];
    const sides = await registrationSidesSynced(facade, 2000000n, (l) => notes.push(l), {
      now: () => t,
      sleep: async (ms) => { t += ms; if (t >= 25_000) version = 2001100n; },
    });
    expect(sides).toEqual({ unshielded: { availableCoins: ['night'] }, dust: { address: 'dust-address' } });
    expect(asked.sort()).toEqual(['dust', 'unshielded']);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^\s+10s {2}the wallet writes for protocol version 1000, not yet ledger 9/);
  });
});

describe('the shielded and unshielded wallets, cached beside the DUST wallet', () => {
  const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), 'wallet-cache-'));
    mkdirSync(join(root, '.wallet-state'), { recursive: true });
    return root;
  };

  /*
   * RED WHEN: a run with a young shielded or unshielded cache replays the network from the first event again (the
   * shielded replay took 472 s on preprod), or restores a wallet into anything but the facade it builds.
   */
  it('restores both from young caches into the facade it builds', async () => {
    const root = fresh();
    const seed = '12'.repeat(32);
    writeFileSync(walletCachePath(root, NETWORK, seed, 'shielded'), 'SHIELDED SNAPSHOT');
    writeFileSync(walletCachePath(root, NETWORK, seed, 'unshielded'), 'UNSHIELDED SNAPSHOT');
    const { wallet } = await build(root, {}, seed);
    expect(restoredFrom).toEqual(['shielded SHIELDED SNAPSHOT', 'unshielded UNSHIELDED SNAPSHOT']);
    expect(built.facadeShielded).toMatchObject({ shielded: 'restored' });
    expect(built.facadeShielded.config.batchUpdates).toEqual({ size: 100 });
    expect(built.facadeUnshielded).toEqual({ unshielded: 'restored' });
    expect(wallet.wallet.shielded).toBe(built.facadeShielded);
  });

  /* RED WHEN: a cache older than the DUST cache's limit is restored, or a refused one stops the run or is not named. */
  it('keeps the DUST cache\'s rules: an old cache is not used, a refused one is named and replaced', async () => {
    const root = fresh();
    const seed = '34'.repeat(32);
    const shieldedFile = walletCachePath(root, NETWORK, seed, 'shielded');
    const unshieldedFile = walletCachePath(root, NETWORK, seed, 'unshielded');
    writeFileSync(shieldedFile, 'A REFUSED SNAPSHOT');
    writeFileSync(unshieldedFile, 'AN OLD SNAPSHOT');
    const old = new Date(Date.now() - 4 * 3_600_000);
    utimesSync(unshieldedFile, old, old);
    shieldedRestoreThrows = 'not a snapshot this library reads';
    const notes: string[] = [];
    await build(root, { note: (l: string) => notes.push(l) }, seed);
    /* An unshielded state resumes at any age: only the DUST wallet's cache has an age limit. */
    expect(restoredFrom).toEqual(['shielded A REFUSED SNAPSHOT', 'unshielded AN OLD SNAPSHOT']);
    expect(built.facadeShielded).toEqual({ shielded: true });
    expect(built.facadeUnshielded).toEqual({ unshielded: 'restored' });
    expect(notes.join('\n')).toContain(shieldedFile);
    expect(notes.join('\n')).toMatch(/shielded.*the file is what is wrong/);
    expect(notes.join('\n')).not.toMatch(/unshielded.*4\.0h old and was NOT used/);
  });

  /* RED WHEN: a save writes the DUST wallet alone, so the next run replays the shielded history again. */
  it('saves all three, each to its own file', async () => {
    const root = fresh();
    const seed = '56'.repeat(32);
    const wallet = { wallet: {
      dust: { serializeState: async () => '{"syncKind":"projections"}' },
      shielded: { serializeState: async () => 'SHIELDED NOW' },
      unshielded: { serializeState: async () => 'UNSHIELDED NOW' },
    } };
    const bytes = await saveWalletState(wallet, seed, NETWORK, root);
    expect(readFileSync(walletCachePath(root, NETWORK, seed, 'shielded'), 'utf8')).toBe('SHIELDED NOW');
    expect(readFileSync(walletCachePath(root, NETWORK, seed, 'unshielded'), 'utf8')).toBe('UNSHIELDED NOW');
    expect(readFileSync(dustCachePath(root, NETWORK, seed), 'utf8')).toBe('{"syncKind":"projections"}');
    expect(bytes).toBe('{"syncKind":"projections"}'.length + 'SHIELDED NOW'.length + 'UNSHIELDED NOW'.length);
  });

  /* RED WHEN: a run interrupted after the shielded replay, before any later save, loses the replay. */
  it('saves the shielded wallet the moment it reports synced', async () => {
    vi.useFakeTimers();
    try {
      const root = fresh();
      const seed = '78'.repeat(32);
      let push: (s: unknown) => void = () => {};
      const shielded = {
        state: { subscribe: (o: any) => { push = o.next; return { unsubscribe: () => {} }; } },
        serializeState: async () => 'SHIELDED AT THE TIP',
      };
      const { WalletFactory } = await import('@midnight-ntwrk/testkit-js') as any;
      const original = WalletFactory.createShieldedWallet;
      WalletFactory.createShieldedWallet = async () => shielded;
      try {
        await build(root, {}, seed);
      } finally {
        WalletFactory.createShieldedWallet = original;
      }
      push({ progress: { appliedIndex: 9n, highestRelevantWalletIndex: 9n, isStrictlyComplete: () => true } });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(readFileSync(walletCachePath(root, NETWORK, seed, 'shielded'), 'utf8')).toBe('SHIELDED AT THE TIP');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('nothing is written before the facade writes for ledger 9', () => {
  /* RED WHEN: a wallet whose shielded side is still replaying ledger 8 is handed on to write transactions. */
  it('waits for the facade to reach ledger 9, saying where it is every ten seconds', async () => {
    let version = 1000n;
    let t = 0;
    const notes: string[] = [];
    await facadeAtLedger9({ currentVersion: () => version }, 2000000n, (l) => notes.push(l), {
      now: () => t,
      sleep: async (ms) => { t += ms; if (t >= 12_000) version = 2001100n; },
    });
    expect(t).toBe(12_000);
    expect(notes).toEqual([expect.stringMatching(/10s {2}the wallet writes for protocol version 1000, not yet ledger 9/)]);
  });
});

import { describe, expect, it } from 'vitest';
import { Data, Effect } from 'effect';
import { SyncProgress as PublicProgress } from '@midnightntwrk/wallet-sdk-unshielded-wallet/v1';
import type { PaymentFailure } from 'midnight-identity/profile/channel';
import * as L from '@midnightntwrk/ledger-v9';
import {
  BalanceRefused, CHAIN_SILENCE_GIVE_UP_MS, CHAIN_WENT_QUIET, CHAIN_WOULD_NOT_ANSWER, ChainUnread, NotHandedOver,
  PAGE_TOKEN_KINDS, base64FromBytes, payForThePage, readWhatThePageAsks, whyThePaymentFailed,
} from './balance-for-page.js';
import type {
  BalanceDoors, FacadeForBalancing, LedgerForBalancing, UnboundTransactionLike, WalletPartForBalancing,
} from './balance-for-page.js';

/** A part of the wallet that has already read the chain to the end, and answers so the moment it is asked, as the SDK's replayed state does. */
const aPartThatHasRead = (): WalletPartForBalancing & { readonly unsubscribed: number } => {
  let unsubscribed = 0;
  return {
    state: {
      subscribe: (o) => {
        o.next({ progress: { isConnected: true, isStrictlyComplete: () => true } });
        return { unsubscribe: () => { unsubscribed += 1; } };
      },
    },
    get unsubscribed() { return unsubscribed; },
  };
};

/** A part of the wallet whose reading of the chain the test drives, one report at a time. */
const aPartStillReading = () => {
  let observer: Parameters<WalletPartForBalancing['state']['subscribe']>[0] | null = null;
  let unsubscribed = 0;
  return {
    state: {
      subscribe: (o: Parameters<WalletPartForBalancing['state']['subscribe']>[0]) => {
        observer = o;
        return { unsubscribe: () => { unsubscribed += 1; } };
      },
    },
    says: (isConnected: boolean, complete: boolean, applied?: bigint, highest?: bigint) =>
      observer?.next({ progress: {
        isConnected, isStrictlyComplete: () => complete,
        ...(applied === undefined ? {} : { appliedIndex: applied, highestIndex: highest ?? applied }),
      } }),
    breaks: (e: unknown) => observer?.error(e),
    ends: () => observer?.complete(),
    get unsubscribed() { return unsubscribed; },
  };
};

/** Timers the test fires by hand. */
const handTimers = () => {
  const pending = new Map<number, () => void>();
  const asked: number[] = [];
  let next = 1;
  return {
    asked,
    set: (run: () => void, ms: number) => { const id = next; next += 1; pending.set(id, run); asked.push(ms); return id; },
    clear: (id: unknown) => { pending.delete(id as number); },
    fireAll: () => { for (const [id, run] of [...pending]) { pending.delete(id); run(); } },
    get armed() { return pending.size; },
  };
};

const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
const OTHER = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
const GBP = 'ab'.repeat(32);
const NIGHT = '00'.repeat(32);
const TX = base64FromBytes(new Uint8Array([1, 2, 3]));

/** A transaction as the ledger hands one back, reduced to what the wallet reads. */
const intoTheVault = { inputs: [], outputs: [{ contractAddress: VAULT }], transients: [] };
const txOf = (
  actions: unknown[],
  imbalances: Array<[{ tag: string; raw?: string }, bigint]>,
  segments: number[] = [1],
  shape: Partial<UnboundTransactionLike> = {},
): UnboundTransactionLike => ({
  intents: new Map(segments.map((s) => [s, { actions }])),
  imbalances: (segment: number) => new Map(segment === 0 ? imbalances : []),
  guaranteedOffer: intoTheVault,
  ...shape,
});
const ledgerReturning = (tx: unknown): LedgerForBalancing & { asked: unknown[][] } => {
  const asked: unknown[][] = [];
  return {
    asked,
    Transaction: { deserialize: (...args: unknown[]) => { asked.push(args); return tx; } },
  };
};
const deposit = { address: VAULT, entryPoint: 'deposit' };
const refusal = (fn: () => unknown): string => {
  try { fn(); return 'accepted'; } catch (e) { return e instanceof BalanceRefused ? e.message : `threw ${String(e)}`; }
};

describe('WHAT THE WALLET READS BEFORE A PERSON IS SHOWN ANYTHING', () => {
  it('reads the bytes as a PROVEN, UNBOUND transaction and nothing else', () => {
    const ledger = ledgerReturning(txOf([deposit], [[{ tag: 'shielded', raw: GBP }, -1000n]]));
    readWhatThePageAsks(ledger, TX, VAULT);
    expect(ledger.asked[0]!.slice(0, 3)).toEqual(['signature', 'proof', 'pre-binding']);
    expect(Array.from(ledger.asked[0]![3] as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('what leaves is what the transaction consumes beyond what it supplies, and DUST is never on the list', () => {
    const { leaves } = readWhatThePageAsks(ledgerReturning(txOf([deposit], [
      [{ tag: 'shielded', raw: GBP }, -1000n],
      [{ tag: 'dust' }, -999n],
      [{ tag: 'shielded', raw: 'cd'.repeat(32) }, 0n],
      [{ tag: 'shielded', raw: 'ef'.repeat(32) }, 7n],
    ])), TX, VAULT);
    expect(leaves).toEqual([{ token: GBP, amount: '1000', kind: 'shielded' }]);
  });

  it('A COIN FOR ANYONE BUT THE VAULT IS REFUSED, AND SO IS PUBLIC MONEY, A SPEND OF THE PAGE\'S OWN, OR A SECOND COIN', () => {
    const owes: Array<[{ tag: string; raw?: string }, bigint]> = [[{ tag: 'shielded', raw: GBP }, -1000n]];
    const read = (shape: Partial<UnboundTransactionLike>, imbalances = owes) =>
      refusal(() => readWhatThePageAsks(ledgerReturning(txOf([deposit], imbalances, [1], shape)), TX, VAULT));
    /* A coin for the page itself, beside the deposit, paid for by this wallet. */
    expect(read({ guaranteedOffer: { inputs: [], transients: [], outputs: [{ contractAddress: VAULT }, {}] } }))
      .toMatch(/creates a coin for someone other than the vault/u);
    expect(read({ fallibleOffer: new Map([[1, { inputs: [], transients: [], outputs: [{ contractAddress: OTHER }] }]]) }))
      .toMatch(/creates a coin for someone other than the vault/u);
    expect(read({ guaranteedOffer: { inputs: [], transients: [], outputs: [{ contractAddress: VAULT }, { contractAddress: VAULT }] } }))
      .toMatch(/creates 2 coins/u);
    expect(read({ guaranteedOffer: undefined })).toMatch(/creates 0 coins/u);
    expect(read({ guaranteedOffer: { inputs: [{}], transients: [], outputs: [{ contractAddress: VAULT }] } }))
      .toMatch(/spends coins of its own/u);
    expect(read({ guaranteedOffer: { inputs: [], transients: [{}], outputs: [{ contractAddress: VAULT }] } }))
      .toMatch(/spends coins of its own/u);
    expect(read({ intents: new Map([[1, { actions: [deposit], guaranteedUnshieldedOffer: { inputs: [], outputs: [{}] } }]]) }))
      .toMatch(/moves public money/u);
    expect(read({ intents: new Map([[1, { actions: [deposit], fallibleUnshieldedOffer: { inputs: [{}], outputs: [] } }]]) }))
      .toMatch(/moves public money/u);
    expect(read({}, [[{ tag: 'unshielded', raw: NIGHT }, -5n]])).toMatch(/needs public money/u);
    expect(read({}, [...owes, [{ tag: 'shielded', raw: 'cd'.repeat(32) }, -1n]])).toMatch(/more than one kind of token/u);
    /* The vault's address in another spelling, and empty public offers, are the deposit itself. */
    expect(read({
      guaranteedOffer: { inputs: [], transients: [], outputs: [{ contractAddress: VAULT.toUpperCase() }] },
      intents: new Map([[1, { actions: [deposit], guaranteedUnshieldedOffer: { inputs: [], outputs: [] } }]]),
    })).toBe('accepted');
  });

  it('A CALL INTO ANYTHING BUT THE NAMED VAULT IS REFUSED, AND SO IS A DEPLOY OR A RULES CHANGE', () => {
    const owes: Array<[{ tag: string; raw?: string }, bigint]> = [[{ tag: 'shielded', raw: GBP }, -1n]];
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([{ address: OTHER, entryPoint: 'deposit' }], owes)), TX, VAULT)))
      .toMatch(/calls a contract other than the vault it names/u);
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([deposit, { address: OTHER, entryPoint: 'x' }], owes)), TX, VAULT)))
      .toMatch(/other than the vault/u);
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([{ initialState: {} }], owes)), TX, VAULT)))
      .toMatch(/deploys one or changes one's rules/u);
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([{ address: VAULT, updates: [] }], owes)), TX, VAULT)))
      .toMatch(/deploys one or changes one's rules/u);
    /* The same vault spelled another way is the same vault. */
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([{ address: VAULT.toUpperCase(), entryPoint: 'deposit' }], owes)), TX, VAULT)))
      .toBe('accepted');
  });

  it('a transaction that calls nothing, or needs nothing from this wallet, is refused', () => {
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([], [[{ tag: 'shielded', raw: GBP }, -1n]])), TX, VAULT)))
      .toMatch(/calls nothing/u);
    expect(refusal(() => readWhatThePageAsks(ledgerReturning({ imbalances: () => new Map() }), TX, VAULT)))
      .toMatch(/calls nothing/u);
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([deposit], [[{ tag: 'dust' }, -9n]])), TX, VAULT)))
      .toMatch(/needs nothing from this wallet/u);
  });

  it('with the real ledger: bytes that are not a proven transaction are refused, and so is an unproven deploy', () => {
    const real = L as unknown as LedgerForBalancing;
    expect(refusal(() => readWhatThePageAsks(real, TX, VAULT))).toMatch(/not a proven transaction/u);
    const deploy = L.Transaction.fromParts('undeployed', undefined, undefined,
      L.Intent.new(new Date(Date.now() + 60_000)).addDeploy(new L.ContractDeploy(new L.ContractState())));
    expect(refusal(() => readWhatThePageAsks(real, base64FromBytes(deploy.serialize()), VAULT)))
      .toMatch(/not a proven transaction/u);
  });
});

describe('THE PRESS', () => {
  const tx = txOf([deposit], [[{ tag: 'shielded', raw: GBP }, -1000n]]);
  const doorsWith = (facade: Partial<FacadeForBalancing>, log: string[]): BalanceDoors => ({
    ledger: async () => ledgerReturning(tx),
    facade: async () => ({
      balanceUnboundTransaction: async (_t, _k, options) => { log.push(`balance ${options.tokenKindsToBalance.join(',')} ttl=${options.ttl.getTime()}`); return 'recipe'; },
      signRecipe: async (r) => { log.push(`sign ${String(r)}`); return 'signed'; },
      finalizeRecipe: async (r) => { log.push(`finish ${String(r)}`); return { serialize: () => new Uint8Array([9, 9]) }; },
      revert: async (r) => { log.push(`revert ${String(r)}`); },
      shielded: aPartThatHasRead(),
      unshielded: aPartThatHasRead(),
      ...facade,
    }) as FacadeForBalancing,
    keys: () => ({ shieldedSecretKeys: 'z', dustSecretKey: 'd' }),
    signSegment: () => async () => ({}) as never,
    now: () => 1_000,
  });

  it('balances the shielded leg ONLY, signs, finishes, and hands back the bytes', async () => {
    const log: string[] = [];
    expect(await payForThePage(doorsWith({}, log), tx)).toBe(base64FromBytes(new Uint8Array([9, 9])));
    expect(log).toEqual(['balance shielded ttl=1201000', 'sign recipe', 'finish signed']);
    expect([...PAGE_TOKEN_KINDS]).toEqual(['shielded']);
  });

  it('a signature or a finish that fails lets the booking go, and the failure is the one reported', async () => {
    for (const broken of [
      { signRecipe: async () => { throw new Error('no signature'); } },
      { finalizeRecipe: async () => { throw new Error('no proof'); } },
    ]) {
      const log: string[] = [];
      await expect(payForThePage(doorsWith(broken, log), tx)).rejects.toThrow(/no (signature|proof)/u);
      expect(log.at(-1)).toBe('revert recipe');
    }
    const log: string[] = [];
    await expect(payForThePage(doorsWith({
      finalizeRecipe: async () => { throw new Error('no proof'); },
      revert: async () => { log.push('revert failed'); throw new Error('cannot let go'); },
    }, log), tx)).rejects.toThrow('no proof');
    expect(log).toContain('revert failed');
  });

  it('HANDS THE FINISHED TRANSACTION OVER ONCE, AND ONE THE PAGE WILL NOT TAKE IS LET GO, NOT KEPT AS PAID', async () => {
    const log: string[] = []; const handed: string[] = [];
    expect(await payForThePage(doorsWith({}, log), tx, undefined, { handOver: (f) => { handed.push(f); return true; } }))
      .toBe(base64FromBytes(new Uint8Array([9, 9])));
    /* RED WHEN: a transaction the page took is let go afterwards, or is handed over twice. */
    expect(log).toEqual(['balance shielded ttl=1201000', 'sign recipe', 'finish signed']);
    expect(handed).toEqual([base64FromBytes(new Uint8Array([9, 9]))]);
    const refused: string[] = [];
    const e = await payForThePage(doorsWith({}, refused), tx, undefined, { handOver: () => false }).catch((x: unknown) => x);
    /* RED WHEN: a transaction the page already had an answer for is kept as paid, its coins still set aside. */
    expect(e).toBeInstanceOf(NotHandedOver);
    expect(refused.at(-1)).toBe('revert recipe');
    const broke: string[] = [];
    await expect(payForThePage(doorsWith({}, broke), tx, undefined, { handOver: () => { throw new Error('no asker'); } }))
      .rejects.toThrow('no asker');
    /* RED WHEN: a handing over that could not be made leaves the coins set aside. */
    expect(broke.at(-1)).toBe('revert recipe');
  });

  it('a balance that fails books nothing, so nothing is let go', async () => {
    const log: string[] = [];
    await expect(payForThePage(doorsWith({
      balanceUnboundTransaction: async () => { throw new Error('not enough'); },
    }, log), tx)).rejects.toThrow('not enough');
    expect(log).toEqual([]);
  });
});

describe('THE WALLET READS THE CHAIN BEFORE IT PAYS', () => {
  const tx = txOf([deposit], [[{ tag: 'shielded', raw: GBP }, -1000n]]);
  const doorsOver = (parts: Partial<FacadeForBalancing>, log: string[]): BalanceDoors => ({
    ledger: async () => ledgerReturning(tx),
    facade: async () => ({
      balanceUnboundTransaction: async (_t, _k, o) => { log.push(`balance ${o.tokenKindsToBalance.join(',')}`); return 'recipe'; },
      signRecipe: async () => { log.push('sign'); return 'signed'; },
      finalizeRecipe: async () => { log.push('finish'); return { serialize: () => new Uint8Array([9]) }; },
      revert: async () => { log.push('revert'); },
      ...parts,
    }) as FacadeForBalancing,
    keys: () => ({ shieldedSecretKeys: 'z', dustSecretKey: 'd' }),
    signSegment: () => async () => ({}) as never,
    now: () => 1_000,
  });

  it('A PRIVATE DEPOSIT IS NOT BALANCED UNTIL THE PRIVATE COINS HAVE BEEN READ TO THE END', async () => {
    const log: string[] = []; const said: string[] = [];
    const shielded = aPartStillReading();
    const paid = payForThePage(doorsOver({ shielded, unshielded: aPartThatHasRead() }, log), tx, undefined, {
      onReading: () => said.push('reading'), onBalancing: () => said.push('balancing'), timers: handTimers(),
    });
    await settle();
    shielded.says(false, false);
    shielded.says(true, false);
    await settle();
    /* RED WHEN: the wallet balances on a part that has not read the chain, or on one only connected. */
    expect(log).toEqual([]);
    expect(said).toEqual(['reading']);
    shielded.says(true, true);
    expect(await paid).toBe(base64FromBytes(new Uint8Array([9])));
    expect(log).toEqual(['balance shielded', 'sign', 'finish']);
    expect(said).toEqual(['reading', 'balancing']);
    /* And a part that had already read the chain when asked is let go too. */
    const ready = aPartThatHasRead();
    await payForThePage(doorsOver({ shielded: ready }, []), tx, undefined, { timers: handTimers() });
    /* RED WHEN: the wallet keeps listening to a part that answered while it was still subscribing. */
    expect(ready.unsubscribed).toBe(1);
    /* RED WHEN: the wallet keeps listening after it has what it waited for. */
    expect(shielded.unsubscribed).toBe(1);
  });

  it('A PUBLIC DEPOSIT WAITS FOR THE PUBLIC COINS, AND ONLY FOR THEM', async () => {
    const log: string[] = [];
    const unshielded = aPartStillReading();
    const shielded = aPartStillReading();
    const approved = { pays: 'public' as const, leaves: [{ token: '00'.repeat(32), amount: '700', kind: 'unshielded' as const }] };
    const doors = { ...doorsOver({ shielded, unshielded }, log), ownPublicAddress: () => 'me' };
    const paid = payForThePage(doors, tx, approved, { timers: handTimers() }).catch((e: unknown) => e);
    await settle();
    shielded.says(true, true);
    await settle();
    /* RED WHEN: the public deposit balances before its public coins are read, or waits on the private ones instead. */
    expect(log).toEqual([]);
    unshielded.says(true, true);
    await paid;
    expect(log[0]).toBe('balance unshielded');
    /* And the private part is not waited on at all: it never finishes here, and the public deposit is paid. */
    const again: string[] = [];
    const stillPrivate = aPartStillReading();
    const readPublic = aPartStillReading();
    const second = payForThePage({ ...doorsOver({ shielded: stillPrivate, unshielded: readPublic }, again), ownPublicAddress: () => 'me' },
      tx, approved, { timers: handTimers() }).catch((e: unknown) => e);
    await settle();
    stillPrivate.says(true, false);
    readPublic.says(true, true);
    await second;
    /* RED WHEN: a public deposit also waits for the private coins to be read. */
    expect(again[0]).toBe('balance unshielded');
  });

  it('A WALLET THE CHAIN NEVER ANSWERS PAYS NOTHING, BOOKS NOTHING, AND SAYS WHY', async () => {
    const log: string[] = [];
    const shielded = aPartStillReading();
    const timers = handTimers();
    const paid = payForThePage(doorsOver({ shielded }, log), tx, undefined, { timers }).catch((e: unknown) => e);
    await settle();
    shielded.says(false, false);
    timers.fireAll();
    const e = await paid;
    /* RED WHEN: a wallet that never reached the chain goes on to balance, or fails for a reason nobody can act on. */
    expect(e).toBeInstanceOf(ChainUnread);
    expect((e as Error).message).toBe(CHAIN_WOULD_NOT_ANSWER);
    expect(CHAIN_WOULD_NOT_ANSWER).toMatch(/could not reach the network to find your coins, so it paid nothing\. Check your connection and try again.*Nothing has been paid\.$/u);
    /* RED WHEN: the wait asks for any other delay than the one it names. */
    expect(new Set(timers.asked)).toEqual(new Set([CHAIN_SILENCE_GIVE_UP_MS]));
    expect(log).toEqual([]);
    expect(whyThePaymentFailed(e)).toBe('chain-unreadable');
    /* RED WHEN: the clock is brought back inside the 20 to 30 seconds a new wallet waited for its first answer from stagenet. */
    expect(CHAIN_SILENCE_GIVE_UP_MS).toBeGreaterThanOrEqual(90_000);
  });

  it('A READ THAT KEEPS MOVING IS NEVER CUT SHORT, AND EACH MOVE IS SAID', async () => {
    const log: string[] = []; let moved = 0;
    const shielded = aPartStillReading();
    const timers = handTimers();
    const paid = payForThePage(doorsOver({ shielded }, log), tx, undefined, { timers, onRead: () => { moved += 1; } });
    await settle();
    const first = timers.asked.length;
    for (let applied = 1n; applied <= 50n; applied += 1n) {
      shielded.says(true, false, applied * 100n, 5_000n);
      /* RED WHEN: a move does not start the silence again, so a long read that keeps moving is cut off at the first clock. */
      expect(timers.asked.length).toBe(first + Number(applied));
      /* RED WHEN: the clock a move replaces is left running beside the new one. */
      expect(timers.armed).toBe(1);
    }
    /* RED WHEN: the read's moves are not passed on, so the page hears nothing from a wallet that is reading. */
    expect(moved).toBe(50);
    shielded.says(true, true, 5_000n, 5_000n);
    await paid;
    expect(log[0]).toBe('balance shielded');
  });

  it('A READ THAT STOPS MOVING AFTER IT CONNECTED IS GIVEN UP ON, WITH NOTHING BOOKED, AND SAYS WHERE IT STOPPED', async () => {
    const log: string[] = []; let moved = 0;
    const shielded = aPartStillReading();
    const timers = handTimers();
    const paid = payForThePage(doorsOver({ shielded }, log), tx, undefined, { timers, onRead: () => { moved += 1; } })
      .catch((e: unknown) => e);
    await settle();
    shielded.says(true, false, 700n, 5_000n);
    const armedBefore = timers.asked.length;
    /* The same report again: a wallet that retries a lost connection quietly says nothing new. */
    shielded.says(true, false, 700n, 5_000n);
    shielded.says(true, false, 700n, 5_000n);
    /* RED WHEN: a report that did not move keeps the read looking alive - the dead-socket wait that never ends. */
    expect(timers.asked.length).toBe(armedBefore);
    expect(moved).toBe(1);
    timers.fireAll();
    const e = await paid;
    /* RED WHEN: a read that stopped part of the way through waits for ever, balances anyway, or reads as never having connected. */
    expect(e).toBeInstanceOf(ChainUnread);
    expect((e as Error).message).toBe(CHAIN_WENT_QUIET);
    expect(whyThePaymentFailed(e)).toBe('chain-unreadable');
    expect(log).toEqual([]);
  });

  it('A RESTORED READ THAT STALLS AFTER IT HEARD THE NETWORK IS NOT TOLD IT COULD NOT REACH THE NETWORK', async () => {
    const log: string[] = [];
    const shielded = aPartStillReading();
    const timers = handTimers();
    const paid = payForThePage(doorsOver({ shielded }, log), tx, undefined, { timers }).catch((e: unknown) => e);
    await settle();
    /* A part restored from a snapshot says where its snapshot got to, and that it is not connected. */
    shielded.says(false, false, 51_333n, 0n);
    /* The network hands back the snapshot's last event first, and the part is connected from then on. */
    shielded.says(true, false, 51_333n, 51_400n);
    /* Then the connection drops part of the way through, and the part says so while it tries again. */
    shielded.says(false, false, 51_333n, 51_400n);
    timers.fireAll();
    const e = await paid;
    /* RED WHEN: the choice of words reads the part's connection now rather than whether it ever heard the network, so a
     * restored read that stalls is told the wallet could not reach the network. */
    expect((e as Error).message).toBe(CHAIN_WENT_QUIET);
    expect(log).toEqual([]);
  });

  it('THE PUBLIC PART\'S PROGRESS IS READ IN ITS OWN WORDS: THE SAME REPORT AGAIN IS SILENCE, A NEW ONE IS MOVEMENT', async () => {
    let observer: Parameters<WalletPartForBalancing['state']['subscribe']>[0] | null = null;
    const unshielded: WalletPartForBalancing = { state: { subscribe: (o) => { observer = o; return { unsubscribe: () => {} }; } } };
    /* The SDK's own public progress, which says how far by transaction id and not by index. */
    const says = (applied: bigint) => observer?.next({ progress: PublicProgress.createSyncProgress({ appliedId: applied, highestTransactionId: 9_000n, isConnected: true }) });
    const log: string[] = []; let moved = 0;
    const timers = handTimers();
    const approved = { pays: 'public' as const, leaves: [{ token: '00'.repeat(32), amount: '700', kind: 'unshielded' as const }] };
    const paid = payForThePage({ ...doorsOver({ shielded: aPartStillReading(), unshielded }, log), ownPublicAddress: () => 'me' },
      tx, approved, { timers, onRead: () => { moved += 1; } }).catch((e: unknown) => e);
    await settle();
    says(700n);
    const armedBefore = timers.asked.length;
    /* The network repeats a public part's progress on a timer while nothing moves. */
    says(700n);
    says(700n);
    /* RED WHEN: a public report that did not move keeps the read looking alive and tells the page it is still reading. */
    expect(timers.asked.length).toBe(armedBefore);
    expect(moved).toBe(1);
    says(701n);
    /* RED WHEN: a public report that did move is not heard as movement. */
    expect(timers.asked.length).toBe(armedBefore + 1);
    expect(moved).toBe(2);
    timers.fireAll();
    expect(await paid).toBeInstanceOf(ChainUnread);
    expect(log).toEqual([]);
  });

  it('A WALLET WHOSE READING FAILS OR ENDS BEFORE IT HAS READ TO THE END PAYS NOTHING AND SAYS SO', async () => {
    for (const how of ['fails', 'ends'] as const) {
      const log: string[] = [];
      const shielded = aPartStillReading();
      const paid = payForThePage(doorsOver({ shielded }, log), tx, undefined, { timers: handTimers() }).catch((e: unknown) => e);
      await settle();
      shielded.says(true, false);
      if (how === 'fails') shielded.breaks(new Error('socket closed')); else shielded.ends();
      const e = await paid;
      /* RED WHEN: a read that failed or ended early is treated as a finished one, left waiting for ever, or reaches the person in the SDK's words. */
      expect(e, how).toBeInstanceOf(ChainUnread);
      expect((e as Error).message, how).toMatch(/^this wallet stopped reading the network before it had found your coins, so it paid nothing\..*Nothing has been paid\.$/u);
      expect((e as Error).message, how).not.toMatch(/socket closed/u);
      expect(log, how).toEqual([]);
    }
  });

  it('A WALLET THAT CANNOT SAY WHETHER IT HAS READ THE CHAIN PAYS NOTHING', async () => {
    const log: string[] = [];
    const e = await payForThePage(doorsOver({}, log), tx, undefined, { timers: handTimers() }).catch((x: unknown) => x);
    /* RED WHEN: a wallet with no report of its reading is taken to have read everything. */
    expect(e).toBeInstanceOf(ChainUnread);
    expect(log).toEqual([]);
  });

  it('A PERSON WHO SAID NO WHILE IT WAS READING IS NOT PAID FOR', async () => {
    const log: string[] = [];
    const shielded = aPartStillReading();
    let wanted = true;
    const paid = payForThePage(doorsOver({ shielded }, log), tx, undefined, {
      stillWanted: () => wanted, timers: handTimers(),
    }).catch((e: unknown) => e);
    await settle();
    wanted = false;
    shielded.says(true, true);
    /* RED WHEN: the wallet books coins for a payment the person turned down while it was reading. */
    expect(await paid).toBeInstanceOf(BalanceRefused);
    expect(log).toEqual([]);
  });

  it('WHICH OF FOUR THINGS STOPPED IT, AND ONLY THAT', async () => {
    /* The SDK's own shape: a tagged error, failed through Effect and handed to a promise, as the wallet's parts do. */
    class InsufficientFunds extends Data.TaggedError('Wallet.InsufficientFunds')<{ readonly message: string }> {}
    const asTheWalletThrowsIt = await Effect.runPromise(Effect.fail(new InsufficientFunds({ message: 'Insufficient funds' })))
      .then(() => null, (e: unknown) => e);
    /* The control: what reaches here carries no tag of its own, as measured in a real browser. */
    expect((asTheWalletThrowsIt as { _tag?: unknown })._tag).toBeUndefined();
    expect((asTheWalletThrowsIt as Error).name).toBe('(FiberFailure) Wallet.InsufficientFunds');
    const cases: Array<[unknown, PaymentFailure]> = [
      [asTheWalletThrowsIt, 'not-enough'],
      [{ name: '(FiberFailure) Wallet.InsufficientFunds' }, 'not-enough'],
      [{ name: 'Error', [Symbol.for('effect/Runtime/FiberFailure/Cause')]: { _tag: 'Fail', error: { _tag: 'Wallet.InsufficientFunds' } } }, 'not-enough'],
      [{ name: '(FiberFailure) Wallet.SomethingElse' }, 'did-not-finish'],
      [new ChainUnread('x'), 'chain-unreadable'],
      [{ _tag: 'Wallet.InsufficientFunds', message: 'Insufficient funds' }, 'not-enough'],
      [Object.assign(new Error('Insufficient funds'), { name: 'Wallet.InsufficientFunds' }), 'not-enough'],
      [new Error('wrapped', { cause: { _tag: 'Wallet.InsufficientFunds' } }), 'not-enough'],
      [new Error('Insufficient funds'), 'did-not-finish'],
      [new BalanceRefused('this wallet could not read its own public address'), 'did-not-finish'],
      [new Error('the proof would not build'), 'did-not-finish'],
      ['a string', 'did-not-finish'],
    ];
    for (const [e, why] of cases) {
      /* RED WHEN: a failure is named as another, or the SDK's own not-enough is missed where it arrives wrapped. */
      expect(whyThePaymentFailed(e), String((e as Error)?.message ?? e)).toBe(why);
    }
  });
});

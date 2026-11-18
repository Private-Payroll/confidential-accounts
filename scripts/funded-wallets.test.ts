/**
 * **THE PAIR A SERVER IS HANDED PAYS DUST ONLY AND RECORDS WHAT IT PAID.**
 *
 * `fundedPartiesOver` is the one construction the stagenet launcher uses. These
 * cases drive the fee payer it builds with a wallet double and read what that
 * fee payer asked the wallet for and what it filed.
 */
import { describe, it, expect } from 'vitest';
import { Intent, Transaction } from '@midnightntwrk/ledger-v9';
import { feePayerHeldOver, fundedPartiesOver, feePayerViewOf, indexerHttpOf, sponsorWalletOver, type LiveWalletParts } from './funded-wallets.js';
import type { FeePayerHolder } from './fee-payer-held.js';
import { NETWORK_IDS, endpointsOf, networkRecord } from '../src/core/networks.js';
import type { SponsoredFee } from '../src/midnight/sponsored-fees.js';

type Call = { method: string; args: unknown[] };

/** A finalised transaction with one intent and no DUST spends, as the ledger shapes one. */
const spendsNoDust = () => Transaction.fromParts('undeployed', undefined, undefined, Intent.new(new Date(Date.now() + 60_000))).bind();

/** A transaction as the company's side hands it over: something that writes itself out as bytes. */
const companyTx = { serialize: () => Uint8Array.of(1) };

const live = (calls: Call[], label: string): LiveWalletParts => {
  const rec = (method: string, answer: (...a: any[]) => unknown) =>
    async (...args: unknown[]) => { calls.push({ method: `${label}.${method}`, args }); return answer(...args); };
  return {
    provider: {
      zswapSecretKeys: `${label}-shielded`,
      dustSecretKey: `${label}-dust`,
      submitTx: rec('submitTx', () => 'ref-1'),
      unshieldedKeystore: { signDataAsync: rec('signDataAsync', () => 'sig') },
      getCoinPublicKey: () => `${label}-coin`,
      getEncryptionPublicKey: () => `${label}-enc`,
    },
    facade: {
      adoptTransaction: (bytes: Uint8Array, stage: string) => { calls.push({ method: `${label}.adoptTransaction`, args: [bytes, stage] }); return { adopted: [...bytes] }; },
      submitTransaction: rec('submitTransaction', () => 'ref-1'),
      estimateTransactionFee: rec('estimateTransactionFee', () => 700n),
      balanceFinalizedTransaction: rec('balanceFinalizedTransaction', (tx: unknown) => ({ recipe: tx })),
      balanceUnboundTransaction: rec('balanceUnboundTransaction', (tx: unknown) => ({ recipe: tx })),
      /* A balanced transaction declares what it spends from DUST. */
      finalizeRecipe: rec('finalizeRecipe', () => spendsNoDust()),
      signRecipe: rec('signRecipe', (r: unknown) => r),
      revert: rec('revert', () => undefined),
    },
    dust: () => 1n,
    night: () => 1n,
  };
};

const sink = (records: SponsoredFee[]) => ({ record: (e: SponsoredFee) => { records.push(e); } });

/** Above what the double below estimates, so the cases that are not about the ceiling pass. */
const CEILING = { perTransaction: 1_000n };

describe('the fee payer handed to the server', () => {
  /*
   * RED WHEN: the fee payer's balancing call omits `tokenKindsToBalance`, or
   * widens it past dust - which pays the company's own legs out of ours - or
   * when `fundedPartiesOver` builds a fee payer that is not `WalletFeeSponsor`.
   */
  it('asks the paying wallet to balance dust and nothing else', async () => {
    const calls: Call[] = [];
    const parties = fundedPartiesOver(
      live(calls, 'payer'), live(calls, 'company'), async () => 650n, sink([]), () => {}, CEILING);
    await parties.sponsor.addFeeAndFinalise(companyTx, new Date(Date.now() + 60_000));

    const balance = calls.find(c => c.method === 'payer.balanceFinalizedTransaction');
    expect(balance, 'the paying wallet was never asked to balance').toBeDefined();
    const options = balance!.args[1] as { tokenKindsToBalance?: unknown };
    expect(options.tokenKindsToBalance, 'the argument was left to its default').toBeDefined();
    expect(options.tokenKindsToBalance).toEqual(['dust']);
    expect(calls.some(c => c.method.startsWith('company.')),
      'the company wallet was touched while the fee was paid').toBe(false);
  });

  /*
   * RED WHEN: the record is not passed through to the fee payer, or the
   * company, the estimate or the chain's figure is lost on the way.
   */
  it('files one row per payment with the company, the estimate and the actual', async () => {
    const records: SponsoredFee[] = [];
    const calls: Call[] = [];
    const parties = fundedPartiesOver(
      live(calls, 'payer'), live(calls, 'company'), async () => 650n, sink(records), () => {}, CEILING);
    parties.sponsor.payingFor('acc_demo');
    const finalised = await parties.sponsor.addFeeAndFinalise(companyTx, new Date(Date.now() + 60_000));
    await parties.sponsor.submit(finalised);

    expect(records).toHaveLength(1);
    expect(records[0]!.company).toBe('acc_demo');
    expect(String(records[0]!.estimated)).toBe('700');
    expect(String(records[0]!.actual)).toBe('650');
    expect(records[0]!.ref).toBe('ref-1');
  });

  /* RED WHEN: the refusal for a missing record is removed. */
  it('refuses to build a fee payer with nowhere to record what it pays', () => {
    expect(() => fundedPartiesOver(
      live([], 'payer'), live([], 'company'), async () => null, undefined as never, () => {}, CEILING))
      .toThrow(/nowhere to record what it pays/);
  });

  /*
   * RED WHEN: the two halves are built over the wrong wallets - the company
   * half reporting the paying wallet's keys would put the company's legs in
   * the hands of the only wallet with spend authority.
   */
  it('the company half carries the company wallet\'s keys', () => {
    const parties = fundedPartiesOver(
      live([], 'payer'), live([], 'company'), async () => null, sink([]), () => {}, CEILING);
    expect(parties.customer.coinPublicKey()).toBe('company-coin');
    expect(parties.customer.encryptionPublicKey()).toBe('company-enc');
  });

  /*
   * RED WHEN: `fundedPartiesOver` or `feePayerOver` stops passing the ceiling
   * through, so the pair a server is handed pays whatever it is given.
   */
  it('the fee payer it builds refuses above the ceiling it was given', async () => {
    const calls: Call[] = [];
    const parties = fundedPartiesOver(
      live(calls, 'payer'), live(calls, 'company'), async () => null, sink([]), () => {},
      { perTransaction: 699n });
    await expect(parties.sponsor.addFeeAndFinalise(companyTx, new Date(Date.now() + 60_000)))
      .rejects.toThrow(/expected to cost 700 SPECKs/);
    expect(calls.some(c => c.method === 'payer.balanceFinalizedTransaction'),
      'coins were booked above the ceiling').toBe(false);
  });

  /* RED WHEN: the ceiling argument is dropped on the way to the fee payer. */
  it('and is not built without one', () => {
    expect(() => fundedPartiesOver(
      live([], 'payer'), live([], 'company'), async () => null, sink([]), () => {}, undefined as never))
      .toThrow(/no ceiling/);
  });
});

describe('the fee payer over a held wallet', () => {
  /** A holder over `first` that hands over `next` once a payment has been made, and writes down every rebuild asked for. */
  const holderOf = (first: LiveWalletParts, next: LiveWalletParts) => {
    let current = first;
    let waiting: LiveWalletParts | null = null;
    const recovered: string[] = [];
    const holder: FeePayerHolder = {
      current: () => current,
      recover: (why) => { recovered.push(why); },
      settle: () => {
        if (waiting === null) return null;
        current = waiting;
        waiting = null;
        return current;
      },
      save: async () => undefined,
      watchHeight: () => () => undefined,
    };
    return { holder, recovered, rebuilt: () => { waiting = next; } };
  };

  /* RED WHEN: the fee payer keeps paying, after a payment has been sent, with the wallet the holder has replaced. */
  it('pays with the wallet the holder hands over between two payments', async () => {
    const calls: Call[] = [];
    const { holder, rebuilt } = holderOf(live(calls, 'old'), live(calls, 'new'));
    const sponsor = feePayerHeldOver(holder, async () => null, sink([]), () => {}, CEILING);
    await sponsor.submit(await sponsor.addFeeAndFinalise(companyTx, new Date(Date.now() + 60_000)));
    rebuilt();
    await sponsor.addFeeAndFinalise(companyTx, new Date(Date.now() + 60_000));
    expect(calls.filter(c => c.method.endsWith('.balanceFinalizedTransaction')).map(c => c.method))
      .toEqual(['old.balanceFinalizedTransaction', 'new.balanceFinalizedTransaction']);
  });

  /* RED WHEN: a balancing the wallet cannot date leaves the holder unasked, so nothing builds the wallet again. */
  it('asks the holder to build the wallet again when its DUST cannot date a spend', async () => {
    const calls: Call[] = [];
    const old = live(calls, 'old');
    old.facade.balanceFinalizedTransaction = async () => { throw new Error('Wallet.Sync: No Dust spend can be dated yet'); };
    const { holder, recovered } = holderOf(old, live(calls, 'new'));
    const sponsor = feePayerHeldOver(holder, async () => null, sink([]), () => {}, CEILING);
    await expect(sponsor.addFeeAndFinalise(companyTx, new Date(Date.now() + 60_000))).rejects.toThrow(/can be dated/);
    expect(recovered).toEqual(['its DUST could not date a spend']);
  });
});

describe('the fee payer\'s view of the network\'s DUST', () => {
  /** A running wallet as the fee payer's view reads it: its state, its history, and its DUST wallet's indexer. */
  const running = (history: Record<string, unknown>, complete = true) => ({
    state: () => ({ subscribe: ({ next }: { next: (s: unknown) => void }) => {
      next({ dust: { progress: { highestIndex: 41n, isStrictlyComplete: () => complete } } });
      return { unsubscribe() {} };
    } }),
    queryTxHistoryByHash: async (h: string) => history[h],
    dust: { constructor: { configuration: { indexerClientConnection: { indexerHttpUrl: 'https://indexer/graphql' } } } },
  });

  /*
   * RED WHEN: each fee payer built over a wallet has its own view, so a service that builds one per request forgets
   * the last payment the network accepted.
   */
  it('is one per wallet, shared by every fee payer built over it', () => {
    const facade = running({});
    const parts = { ...live([], 'payer'), facade: { ...live([], 'payer').facade } };
    Object.assign(parts.facade, facade);
    const first = sponsorWalletOver(parts, async () => null).view;
    expect(first).toBeDefined();
    expect(sponsorWalletOver(parts, async () => null).view).toBe(first);
  });

  /*
   * RED WHEN: the view says it shows a payment its own history holds without its DUST side.
   * RED WHEN: the network's newest block is asked of anything but the installed DUST wallet's indexer, or the view is
   * judged by anything but the block a finished pass reached.
   */
  it('shows a payment only when the wallet\'s history holds its DUST side, and asks the wallet\'s own indexer', async () => {
    const asked: string[] = [];
    const view = feePayerViewOf(running({ shown: { dust: { spentUtxos: [] } }, partly: { unshielded: {} } }),
      async (url) => { asked.push(url); return 50n; }, () => {})!;
    expect(await view.shows('shown')).toBe(true);
    expect(await view.shows('partly')).toBe(false);
    expect(await view.shows('unknown')).toBe(false);
    expect(view.applied()).toBe(41n);
    expect(await view.tip()).toBe(50n);
    expect(asked).toEqual(['https://indexer/graphql']);
    expect(view.numbers()).toMatch(/^dust view at block 41 of 50;/);
  });

  /* RED WHEN: a view part-way through a pass is said to cover the block its last pass reached. */
  it('covers no block while the wallet is part-way through catching up', () => {
    const view = feePayerViewOf(running({}, false), async () => 50n, () => {})!;
    expect(view.applied()).toBeNull();
  });

  /* RED WHEN: an object that is not a running wallet is given a view that waits on nothing it can read. */
  it('gives no view for an object that is not a running wallet', () => {
    expect(feePayerViewOf({})).toBeUndefined();
    expect(feePayerViewOf(null)).toBeUndefined();
  });
});

describe('the indexer the fee payer asks for the newest block', () => {
  it('IS THE RECORD\'S OWN QUERY ADDRESS, CARRYING THE SUBSCRIPTION\'S PROJECT TOKEN', () => {
    for (const id of NETWORK_IDS.filter((n) => networkRecord(n).endpoints !== null)) {
      const asking = networkRecord(id).endpoints!.projectToken !== null;
      const e = endpointsOf(id, () => 'aProjectToken42');
      /* RED WHEN the query address is cut out of the subscription address by hand, which loses or garbles
       * the token on a network that asks for one and misses a path that does not end in `/ws`. */
      expect(indexerHttpOf(e.indexerWs), id).toBe(e.indexer);
      if (asking) expect(new URL(indexerHttpOf(e.indexerWs)).searchParams.get('project_id'), id).toBe('aProjectToken42');
    }
  });

  it('an address no record names is the same path over http, without its /ws and with its query kept', () => {
    /* RED WHEN an unrecorded subscription address loses its query or keeps its `/ws`. */
    expect(indexerHttpOf('wss://indexer.example/graphql/ws?key=k')).toBe('https://indexer.example/graphql?key=k');
    expect(indexerHttpOf('ws://localhost:1/graphql/ws')).toBe('http://localhost:1/graphql');
  });
});

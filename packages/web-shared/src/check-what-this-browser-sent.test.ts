import { DEPOSIT_CLOCKS_MAY_DIFFER_MS, DEPOSIT_TIME_TO_LIVE_MS, type DepositInFlight, DepositLandedNotYetRecorded, DepositMayOutliveItsWindow, DepositNotAsBuilt, DepositNotSent, DepositNotYetSeen, DepositStartedElsewhere, DepositStillInFlight, depositIntoCompanyVault, journalledDepositLandsBy, settleDepositInFlight } from './vault-private-deposit.js';
import { type PaymentInFlight } from './vault-payment-in-flight.js';
import { checkWhatThisBrowserDeposited, checkWhatThisBrowserSent, sayWhatTheCheckFound } from './check-what-this-browser-sent.js';
import { openCompanyVaultPool } from './vault-pool-opened.js';
import { type Kept } from './in-flight-on-this-device.js';
import { MemorySealedPoolStore, SealedNotePool, openPool, sealPool } from '../../../src/midnight/vault-pool.js';
import { type WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import { type VaultBuilderClient } from './vault-worker-client.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { describe, expect, it } from 'vitest';
import { ACCOUNT, LABEL, VAULT, builder, inFlightInMemory, indexerOf, nothingToCheck, pacing, serviceFrom, theServiceNeverAsked, view, walletReadsTheVault } from './vault-operation.test-support.js';


describe('WHAT THIS BROWSER LAST SENT, CHECKED ON ITS OWN, AND TWO TABS OR TWO BROWSERS AT ONCE', () => {
  const wrapping = recordsKeypairFrom(new Uint8Array(32).fill(6));
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(6) };
  const MONEY = { token: 'ab'.repeat(32) as never, value: 9n };
  const LANDED_IN = 'e9'.repeat(32);
  type Coin = { nonce: string; token: string; value: string };
  const outputOf = (c: Coin) => `out:${c.nonce}:${c.token}:${c.value}`;
  const heldOf = (c: Coin) => `held:${c.nonce}:${c.token}:${c.value}`;
  const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
  /** One chain and one company's records, shared by every browser a test opens on them. */
  const company = async () => {
    const w = { notes: [] as string[], everCreated: [] as string[], built: [] as Coin[], sent: 0, asked: 0,
      events: new Map<string, Array<{ transactionHash: string; details: { tag: string; commitment?: string; contract?: string; mtIndex?: string } }>>(),
      answer: { txRef: 'p', transactionHash: null as string | null }, sendFails: null as Error | null, paidFor: [] as string[] };
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    const records = (r: WireRecord) => kept.get(r) ?? kept.set(r, new MemorySealedPoolStore()).get(r)!;
    const service = serviceFrom([], [], {
      chain: async () => view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [...w.notes], everCreated: [...w.everCreated] }),
      deposit: async () => { if (w.sendFails) throw w.sendFails; w.sent += 1; return w.answer; },
      events: async (_v, tx) => {
        const e = w.events.get(tx);
        if (e === undefined) throw new Error('the indexer does not hold this transaction yet');
        return { events: e };
      },
      createdBy: async (_v, commitment) => {
        for (const [hash, events] of w.events) {
          if (events.some((e) => e.details.commitment === commitment && e.details.contract === VAULT)) return { transactionHash: hash, events };
        }
        return null;
      },
    });
    const b: VaultBuilderClient = {
      ...builder([]),
      deposit: async (i) => { w.built.push(i.coin); return { tx: `P${w.built.length}` }; },
      commitments: async (i) => ({ output: outputOf(i.coin), held: heldOf(i.coin) }),
      /* A built deposit ends an hour after it is read, as the call is built; it and what the wallet hands back for it call this vault's deposit and create the one coin built. */
      readTransaction: async (i) => {
        const coin = w.built[Number(/^P(\d+)/u.exec(i.transaction)?.[1] ?? 0) - 1];
        return {
          identifiers: [], timeToLive: Date.now() + 60 * 60_000, calls: [{ address: VAULT, entryPoint: 'deposit', segments: [0] }],
          coinsForContracts: coin === undefined ? [] : [{ contract: VAULT, commitment: outputOf(coin) }], publicTakes: [],
        };
      },
    };
    const lands = (coin: Coin, hash = LANDED_IN) => {
      w.notes.push(heldOf(coin));
      w.everCreated.push(outputOf(coin));
      w.events.set(hash, [{ transactionHash: hash, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: '4' } }]);
    };
    /** One browser: its own place for what it has on its way, and the company's records. */
    const browser = (kept = new Map<string, Kept<DepositInFlight>>()) => ({
      kept,
      doors: {
        ...pacing, ...walletReadsTheVault, service, indexer: indexerOf(service), me, myRecordsKey: 'ff'.repeat(32), records, signers, company: LABEL, account: ACCOUNT, builder: b,
        inFlight: inFlightInMemory<DepositInFlight>(kept), payments: inFlightInMemory<PaymentInFlight>(),
        pay: async (ask: { transaction: string }) => {
          w.asked += 1;
          w.paidFor.push(ask.transaction);
          return { transaction: `${ask.transaction}+coins`, leaves: [] };
        },
      },
    });
    const first = browser();
    await openCompanyVaultPool(first.doors, VAULT, nothingToCheck);
    const pool = new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers);
    return { w, records, lands, browser, first, pool };
  };

  it('CHECK MY LAST DEPOSIT SETTLES A DEPOSIT ON ITS WAY WITHOUT A NEW ONE, AND SAYS WHAT IT FOUND', async () => {
    const c = await company();
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    c.w.sendFails = null;
    const [built, asked] = [c.w.built.length, c.w.asked];
    const before = await checkWhatThisBrowserSent(c.first.doors, VAULT);
    expect(before.deposit.state, 'RED WHEN: the check lets go of a deposit that can still arrive').toBe('still-on-its-way');
    expect(sayWhatTheCheckFound(before)).toMatch(/has not reached the vault yet/);
    c.lands(c.w.built[0]!);
    const found = await checkWhatThisBrowserSent(c.first.doors, VAULT);
    /* RED WHEN: the check does not settle the deposit in flight, or settles it without its creating transaction. */
    expect(found.deposit).toMatchObject({ state: 'recorded', note: { createdIn: LANDED_IN } });
    expect((await c.pool.load(VAULT)).notes.map((n) => n.createdIn)).toEqual([LANDED_IN]);
    expect([c.w.built.length, c.w.asked, c.w.sent], 'RED WHEN: checking builds, asks the wallet or sends anything').toEqual([built, asked, 0]);
    expect(c.first.kept.size).toBe(0);
    expect(sayWhatTheCheckFound(found)).toBe('Your last deposit from this browser has reached the vault and is now in its record.');
    expect(sayWhatTheCheckFound(await checkWhatThisBrowserSent(c.first.doors, VAULT)))
      .toBe('This browser has no deposit into this vault waiting to be seen.');
  });

  it('a check of deposits alone records a deposit on its way once it lands, and reads no payment this browser kept', async () => {
    const c = await company();
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    c.w.sendFails = null;
    c.lands(c.w.built[0]!);
    const sent = c.w.sent;
    /* Any payment this browser kept is out of reach: reading one fails the check. */
    const payments = new Proxy({}, { get: () => { throw new Error('a payment kept on its way was read'); } });
    const found = await checkWhatThisBrowserDeposited({ ...c.first.doors, payments } as never, VAULT);
    /* RED WHEN: checking deposits alone does not record a deposit that landed, or reads or settles a payment. */
    expect(found.deposit).toMatchObject({ state: 'recorded', note: { createdIn: LANDED_IN } });
    expect(Object.keys(found).sort()).toEqual(['checked', 'deposit', 'named', 'unnamed']);
    /* RED WHEN: the check does not say which deposit it judged, or says another token or amount than the one this browser kept. */
    expect(found.checked).toEqual({ from: 'this-browser', token: MONEY.token, value: MONEY.value });
    expect(c.w.sent, 'RED WHEN: checking sends anything').toBe(sent);
    /* RED WHEN: what a check of deposits alone found cannot be said, or is said with anything about a payment. */
    expect(sayWhatTheCheckFound(found)).toBe('Your last deposit from this browser has reached the vault and is now in its record.');
  });

  it('a claim whose coin landed and has since left the vault is let go, and the next deposit is built', async () => {
    const c = await company();
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    c.w.sendFails = null;
    const coin = c.w.built[0]!;
    c.lands(coin);
    /* Another signer recorded it and a payment then spent it: the chain made it and no longer holds it, and the pool no longer lists it. */
    const before = await c.pool.load(VAULT);
    await c.pool.save(VAULT, { notes: [...before.notes, { nonce: coin.nonce as never, token: coin.token as never, value: BigInt(coin.value), createdIn: LANDED_IN as never }] }, before.readAt);
    const recorded = await c.pool.load(VAULT);
    await c.pool.save(VAULT, { notes: recorded.notes.filter((n) => n.nonce !== coin.nonce) }, recorded.readAt);
    c.w.notes = c.w.notes.filter((n) => n !== heldOf(coin));
    /* RED WHEN: a claim whose coin the chain made and no longer holds is kept for ever, so this wallet never deposits into the vault again. */
    expect(await settleDepositInFlight(c.first.doors, VAULT)).toEqual({ state: 'landed-and-since-spent' });
    expect(c.first.kept.size).toBe(0);
    await depositIntoCompanyVault(c.first.doors, VAULT, MONEY).catch(() => undefined);
    expect(c.w.built).toHaveLength(2);
  });

  it('a pool page naming the claim\'s coin, with the chain showing no such coin made, never lets the claim go', async () => {
    const c = await company();
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    c.w.sendFails = null;
    const coin = c.w.built[0]!;
    const now = await c.pool.load(VAULT);
    await c.pool.save(VAULT, { notes: [...now.notes, { nonce: coin.nonce as never, token: coin.token as never, value: BigInt(coin.value) }] }, now.readAt);
    /* RED WHEN: a pool record alone, which the page can file, releases a deposit the page may still hold and send (a second deposit is built). */
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositStillInFlight);
    expect(c.first.kept.size).toBe(1);
    expect(c.w.built).toHaveLength(1);
  });

  it('a check that files nothing reports a deposit kept in this browser once, owed its record, files no version, and lets it go', async () => {
    const c = await company();
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    c.w.sendFails = null;
    c.lands(c.w.built[0]!);
    const versions = (await c.records('pool').versions(VAULT)).length;
    const found = await checkWhatThisBrowserDeposited(c.first.doors, VAULT, { files: false });
    /* RED WHEN: a check that files nothing records the landed deposit in the pool, signed on the page. */
    expect((await c.records('pool').versions(VAULT)).length).toBe(versions);
    expect(found.deposit.state).toBe('landed-owed-its-record');
    /* RED WHEN: a deposit this browser kept from before deposits moved into the wallet is reported owed on every check, for ever. */
    expect(c.first.kept.size).toBe(0);
    expect(sayWhatTheCheckFound(found)).toMatch(/is in the vault, and not yet in its record/);
  });

  it('a check that files nothing judges the newest deposit filed for the vault from its journal and the chain, wherever it was kept', async () => {
    const c = await company();
    /* The deposit is made where its claim is kept (the wallet); the page that checks keeps nothing of it. */
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    c.w.sendFails = null;
    const page = c.browser();
    const versions = (await c.records('pool').versions(VAULT)).length;
    /* RED WHEN: a check with nothing kept in this browser says no deposit is waiting while the newest one filed has not reached the vault. */
    expect((await checkWhatThisBrowserDeposited(page.doors, VAULT, { files: false })).deposit.state).toBe('journalled-not-seen');
    c.lands(c.w.built[0]!);
    expect((await checkWhatThisBrowserDeposited(page.doors, VAULT, { files: false })).deposit.state).toBe('landed-owed-its-record');
    expect((await c.records('pool').versions(VAULT)).length, 'RED WHEN: the page\'s check files a version').toBe(versions);
    expect(page.kept.size).toBe(0);
    /* Recorded where it was made, the check says so. */
    expect((await settleDepositInFlight(c.first.doors, VAULT)).state).toBe('recorded');
    const recorded = await checkWhatThisBrowserDeposited(page.doors, VAULT, { files: false });
    expect(recorded.deposit.state).toBe('already-recorded');
    /* RED WHEN: a check that judged the vault's newest journalled deposit does not say what it was, or says it is this browser's. */
    expect(recorded.checked).toEqual({ from: 'the-vaults-journal', token: MONEY.token, value: MONEY.value });
    expect(sayWhatTheCheckFound(recorded)).toBe('The newest deposit filed for this vault is in the vault\'s record.');
    /* Spent after it was recorded, it is said to have landed and left. */
    c.w.notes = c.w.notes.filter((n) => n !== heldOf(c.w.built[0]!));
    const now = await c.pool.load(VAULT);
    await c.pool.save(VAULT, { notes: now.notes.filter((n) => n.nonce !== c.w.built[0]!.nonce) }, now.readAt);
    const spent = await checkWhatThisBrowserDeposited(page.doors, VAULT, { files: false });
    expect(spent.deposit.state).toBe('landed-and-since-spent');
    expect(sayWhatTheCheckFound(spent)).toMatch(/reached the vault/);
    expect(sayWhatTheCheckFound(await checkWhatThisBrowserDeposited(c.browser().doors, VAULT, { files: false }))).not.toMatch(/no deposit into this vault waiting/);
  });

  it('a check that files nothing counts a note it could name and names none', async () => {
    const c = await company();
    const coin = { nonce: 'a1'.repeat(32), token: MONEY.token as string, value: '9' };
    const now = await c.pool.load(VAULT);
    await c.pool.save(VAULT, { notes: [...now.notes, { nonce: coin.nonce as never, token: coin.token as never, value: 9n }] }, now.readAt);
    c.lands(coin);
    const versions = (await c.records('pool').versions(VAULT)).length;
    const found = await checkWhatThisBrowserDeposited(c.first.doors, VAULT, { files: false });
    /* RED WHEN: a check that files nothing names a note's transaction in a new pool version. */
    expect((await c.records('pool').versions(VAULT)).length).toBe(versions);
    expect([found.named, found.unnamed, found.toName]).toEqual([0, 0, 1]);
    expect(sayWhatTheCheckFound(found)).toMatch(/can be used for payments once a signer's wallet next files this vault's records/);
  });

  it('CHECK MY LAST DEPOSIT READS THE VAULT ON THIS DEVICE, AND NEVER ASKS THE SERVICE WHAT IT HOLDS', async () => {
    const c = await company();
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    c.lands(c.w.built[0]!);
    const asked = { n: 0 };
    /* RED WHEN: the check reads the vault through the service's chain route. */
    const found = await checkWhatThisBrowserSent(theServiceNeverAsked(c.first.doors, asked), VAULT);
    expect(found.deposit).toMatchObject({ state: 'recorded' });
    expect(asked.n).toBe(0);
  });

  it('CHECK MY LAST DEPOSIT NAMES A NOTE THE RECORD HOLDS WITHOUT ITS TRANSACTION, ONCE THE VAULT\'S HISTORY SHOWS IT, AND NO OTHER', async () => {
    const c = await company();
    const coin = { nonce: 'a1'.repeat(32), token: MONEY.token as string, value: '9' };
    const other = { nonce: 'a2'.repeat(32), token: MONEY.token as string, value: '4' };
    const now = await c.pool.load(VAULT);
    await c.pool.save(VAULT, { notes: [...now.notes,
      { nonce: coin.nonce as never, token: coin.token as never, value: 9n },
      { nonce: other.nonce as never, token: other.token as never, value: 4n }] }, now.readAt);
    c.lands(coin);
    c.w.notes.push(heldOf(other));
    const found = await checkWhatThisBrowserSent(c.first.doors, VAULT);
    const notes = (await c.pool.load(VAULT)).notes;
    /* RED WHEN: the check does not look for the transaction of a note recorded without one - it stays unspendable with no fix on the page. */
    expect(notes.find((n) => n.nonce === coin.nonce)?.createdIn).toBe(LANDED_IN);
    /* RED WHEN: a note the history does not show is named anyway. */
    expect(notes.find((n) => n.nonce === other.nonce)?.createdIn).toBeUndefined();
    expect([found.named, found.unnamed]).toEqual([1, 1]);
    expect(sayWhatTheCheckFound(found)).toMatch(/One amount in the vault can now be used for payments\. One amount in the vault still cannot be used for a payment/);
  });

  it('CHECK MY LAST DEPOSIT NAMES A NOTE ONLY UNDER A TRANSACTION THE VAULT WORKER HAS JUDGED, WHATEVER THE HISTORY ANSWERS', async () => {
    const c = await company();
    const coin = { nonce: 'a3'.repeat(32), token: MONEY.token as string, value: '9' };
    const now = await c.pool.load(VAULT);
    await c.pool.save(VAULT, { notes: [...now.notes, { nonce: coin.nonce as never, token: coin.token as never, value: 9n }] }, now.readAt);
    c.w.notes.push(heldOf(coin));
    const lying = (events: Array<{ transactionHash: string; details: { tag: string; commitment?: string; contract?: string; mtIndex?: string } }>) =>
      ({ ...c.first.doors, builder: { ...c.first.doors.builder, createdBy: async () => ({ transactionHash: LANDED_IN, events }) } });
    for (const events of [
      /* made for another contract */
      [{ transactionHash: LANDED_IN, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: 'ee'.repeat(32), mtIndex: '1' } }],
      /* made twice */
      [1, 2].map((i) => ({ transactionHash: LANDED_IN, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: String(i) } })),
      /* served under another transaction's hash */
      [{ transactionHash: 'e4'.repeat(32), details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: '1' } }],
    ]) {
      const found = await checkWhatThisBrowserSent(lying(events), VAULT);
      /* RED WHEN: the check records whatever the history's lookup answers, without the vault worker judging it. */
      expect((await c.pool.load(VAULT)).notes.find((n) => n.nonce === coin.nonce)?.createdIn).toBeUndefined();
      expect([found.named, found.unnamed]).toEqual([0, 1]);
    }
  });

  it('TWO TABS OF ONE BROWSER: THE SECOND DEPOSIT STOPS BEFORE THE WALLET, AND THE FIRST ONE\'S RECORD IS NOT OVERWRITTEN', async () => {
    const c = await company();
    const shared = new Map<string, Kept<DepositInFlight>>();
    const [tabA, tabB] = [c.browser(shared), c.browser(shared)];
    const outcomes = await Promise.allSettled([
      depositIntoCompanyVault(tabA.doors, VAULT, MONEY), depositIntoCompanyVault(tabB.doors, VAULT, MONEY),
    ]);
    const stopped = outcomes.filter((o) => o.status === 'rejected' && o.reason instanceof DepositStartedElsewhere);
    /* RED WHEN: the record is written with a plain put - the second tab then overwrites the first and both go ahead. */
    expect(stopped, 'RED WHEN: two tabs both keep a deposit on its way for one vault').toHaveLength(1);
    expect(c.w.asked, 'the wallet is asked once').toBe(1);
    /* The one deposit the wallet was asked for is the one kept: its transaction is `P<n>`, built from the n-th coin. */
    const went = c.w.built[Number(c.w.paidFor[0]!.slice(1)) - 1]!;
    expect(c.w.built, 'both tabs chose and built a coin').toHaveLength(2);
    expect([...shared.values()].map((d) => d.coin.nonce), 'RED WHEN: the second tab\'s record replaces the first\'s')
      .toEqual([went.nonce]);
  });

  it('TWO BROWSERS DEPOSITING THE SAME MONEY AT ONCE MAKE TWO DIFFERENT COINS', async () => {
    const c = await company();
    const [one, two] = [c.browser(), c.browser()];
    await Promise.allSettled([depositIntoCompanyVault(one.doors, VAULT, MONEY), depositIntoCompanyVault(two.doors, VAULT, MONEY)]);
    expect(c.w.built, 'both deposits are built').toHaveLength(2);
    /* RED WHEN: the journal files a second claim on a slot another deposit claimed a moment ago - both then make one coin. */
    expect(c.w.built[0]!.nonce, 'RED WHEN: two deposits of the same money at once make the same coin').not.toBe(c.w.built[1]!.nonce);
    /* And one after the other, while the first has not landed: still two coins. */
    const d = await company();
    await depositIntoCompanyVault(d.browser().doors, VAULT, MONEY).catch(() => undefined);
    await depositIntoCompanyVault(d.browser().doors, VAULT, MONEY).catch(() => undefined);
    expect(d.w.built[0]!.nonce).not.toBe(d.w.built[1]!.nonce);
  });

  /** The vault's deposit journal as filed, each line a coin of this company's money and the time it was filed. */
  const fileJournal = async (c: Awaited<ReturnType<typeof company>>, lines: ReadonlyArray<{ nonce: string; attemptedAt?: string }>) => {
    const store = c.records('deposit-journal');
    const version = ((await store.get(VAULT))?.version ?? 0) + 1;
    const notes = lines.map((l) => ({ nonce: l.nonce, token: MONEY.token, value: MONEY.value, ...(l.attemptedAt === undefined ? {} : { attemptedAt: l.attemptedAt }) }));
    await store.put(VAULT, sealPool(VAULT, { notes } as never, await signers(), version, 'deposit-journal'));
  };
  const coinOfLine = (nonce: string): Coin => ({ nonce, token: MONEY.token as string, value: String(MONEY.value) });
  const NOW = Date.UTC(2026, 10, 4, 12, 0);
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
  /** A browser that keeps nothing, at NOW, that counts which coins it asks the vault worker about. */
  const pageAt = (c: Awaited<ReturnType<typeof company>>) => {
    const page = c.browser();
    const asked: string[] = [];
    const commitments = page.doors.builder.commitments;
    return {
      asked,
      doors: { ...page.doors, clock: () => NOW, builder: { ...page.doors.builder, commitments: async (i: Parameters<typeof commitments>[0]) => { asked.push(i.coin.nonce); return commitments(i); } } },
    };
  };

  it('every deposit filed for the vault that can still land is said, oldest first, with until when; one past its window is not read', async () => {
    const c = await company();
    const [gone, older, old, newest] = ['c1', 'c2', 'c3', 'c4'].map((b) => b.repeat(32));
    await fileJournal(c, [
      { nonce: gone!, attemptedAt: minutesAgo(100) }, { nonce: older!, attemptedAt: minutesAgo(30) },
      { nonce: old!, attemptedAt: minutesAgo(10) }, { nonce: newest!, attemptedAt: minutesAgo(5) },
    ]);
    const page = pageAt(c);
    const found = await checkWhatThisBrowserDeposited(page.doors, VAULT, { files: false });
    const until = (m: number) => NOW - m * 60_000 + DEPOSIT_TIME_TO_LIVE_MS + DEPOSIT_CLOCKS_MAY_DIFFER_MS;
    /* RED WHEN: the newest deposit filed for the vault and not yet seen is said with no time after which it never arrives. */
    expect(found.deposit).toEqual({ state: 'journalled-not-seen', until: until(5) });
    /* RED WHEN: only the newest deposit filed for the vault is judged, so an earlier one still on its way is never said. */
    expect(found.alsoJournalled?.map((e) => [e.state, e.until, e.checked?.value])).toEqual([
      ['journalled-not-seen', until(30), MONEY.value], ['journalled-not-seen', until(10), MONEY.value],
    ]);
    /* RED WHEN: a deposit that can no longer land is read again on every check, for every deposit the vault ever took. */
    expect(page.asked).not.toContain(gone);
    expect(journalledDepositLandsBy(minutesAgo(100))).toBeLessThan(NOW);
    const said = sayWhatTheCheckFound(found);
    expect(said).toMatch(/^The newest deposit filed for this vault has not reached the vault yet\. If it was sent, it can still arrive until /u);
    expect(said.match(/An earlier deposit filed for this vault has not reached the vault yet/gu)).toHaveLength(2);
    expect(said).not.toMatch(/may still arrive/u);
  });

  it('the newest deposit filed for the vault is judged whatever its age: past its window and unseen it never landed, held it is owed its record', async () => {
    const c = await company();
    const [stale, undated] = ['d1', 'd2'].map((b) => b.repeat(32));
    await fileJournal(c, [{ nonce: stale!, attemptedAt: minutesAgo(200) }]);
    const page = pageAt(c);
    /* RED WHEN: a deposit filed long ago that never reached the vault is said to be on its way for ever. */
    expect((await checkWhatThisBrowserDeposited(page.doors, VAULT, { files: false })).deposit).toEqual({ state: 'journalled-never-landed' });
    c.lands(coinOfLine(stale!));
    /* RED WHEN: a deposit that landed long ago and is owed its record is no longer said, because its line is past its window. */
    expect((await checkWhatThisBrowserDeposited(page.doors, VAULT, { files: false })).deposit.state).toBe('landed-owed-its-record');
    /* A line that carries no time says nothing of when it can still land, so it is past its window. */
    await fileJournal(c, [{ nonce: stale!, attemptedAt: minutesAgo(200) }, { nonce: undated! }]);
    const found = await checkWhatThisBrowserDeposited(page.doors, VAULT, { files: false });
    /* RED WHEN: a deposit filed with no time is said to be on its way. */
    expect(found.deposit).toEqual({ state: 'journalled-never-landed' });
    expect(sayWhatTheCheckFound(found)).toBe('The newest deposit filed for this vault never reached the vault, and now it never will. No money moved.');
  });

  it('a deposit whose coin the chain made and no record ever named reads the same kept in this browser and filed in the journal', async () => {
    const c = await company();
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    c.w.sendFails = null;
    const coin = c.w.built[0]!;
    c.w.everCreated.push(outputOf(coin));
    /* Kept in this browser, it is in the vault and not yet in its record. */
    await expect(settleDepositInFlight(c.first.doors, VAULT, undefined, false)).rejects.toBeInstanceOf(DepositLandedNotYetRecorded);
    const found = await checkWhatThisBrowserDeposited(pageAt(c).doors, VAULT, { files: false });
    /* RED WHEN: the same coin is said to have landed and since left the vault from the journal, while this browser says it is not yet recorded. */
    expect(found.deposit).toEqual({ state: 'journalled-not-recorded' });
    expect(sayWhatTheCheckFound(found)).toMatch(/^The newest deposit filed for this vault is in the vault, and not yet in its record\./u);
  });

  it('a deposit kept on its way in this browser is said once, not again as a deposit filed in the journal', async () => {
    const c = await company();
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    c.w.sendFails = null;
    const own = c.w.built[0]!.nonce;
    const other = 'e1'.repeat(32);
    const at = new Date().toISOString();
    await fileJournal(c, [{ nonce: own, attemptedAt: at }, { nonce: other, attemptedAt: at }]);
    const found = await checkWhatThisBrowserDeposited(c.first.doors, VAULT, { files: false });
    expect(found.deposit.state).toBe('still-on-its-way');
    /* RED WHEN: the deposit this browser keeps on its way is said twice, once as this browser's and once as filed in the journal. */
    /* RED WHEN: a newer deposit filed in the journal is left unsaid because this browser kept one of its own. */
    expect(found.alsoJournalled?.map((e) => [e.state, e.checked?.from])).toEqual([['journalled-not-seen', 'the-vaults-journal']]);
    expect(found.alsoJournalled?.[0]?.until).toBe(journalledDepositLandsBy(at));
  });

  it('a deposit whose built transaction could land after every check says it never will is not sent, and the wallet is never asked', async () => {
    const c = await company();
    let now = NOW;
    /** The company's doors at `now`, a build that takes `takes`, and a built transaction that ends at `endsBy` (null: unreadable; undefined: no reader). */
    const built = (takes: number, endsBy: number | null | undefined) => {
      const { readTransaction: _none, ...plain } = c.first.doors.builder;
      return {
        ...c.first.doors, clock: () => now,
        builder: {
          ...plain,
          deposit: async (i: Parameters<VaultBuilderClient['deposit']>[0]) => { now += takes; return c.first.doors.builder.deposit(i); },
          ...(endsBy === undefined ? {} : { readTransaction: async (i: { transaction: string }) => ({ ...(await c.first.doors.builder.readTransaction!(i))!, timeToLive: endsBy }) }),
        },
      };
    };
    /* Each try files its own coin, so each takes an amount of its own: a refused try still holds its slot. */
    let amount = MONEY.value;
    const refused = async (doors: ReturnType<typeof built>, why: string) => {
      now = NOW;
      amount += 1n;
      await expect(depositIntoCompanyVault(doors, VAULT, { ...MONEY, value: amount }), `RED WHEN: ${why}`).rejects.toBeInstanceOf(DepositMayOutliveItsWindow);
      expect([c.w.asked, c.w.sent, c.first.kept.size]).toEqual([0, 0, 0]);
    };
    await refused(built(0, NOW + DEPOSIT_TIME_TO_LIVE_MS + 1), 'a deposit whose transaction ends after its record here says it can no longer land is sent');
    await refused(built(10 * 60_000, NOW + DEPOSIT_TIME_TO_LIVE_MS + DEPOSIT_CLOCKS_MAY_DIFFER_MS + 1),
      'a deposit whose transaction ends after its journal line says it can no longer land is sent');
    await refused(built(0, null), 'a deposit whose transaction\'s own time to live cannot be read is sent');
    await refused(built(0, undefined), 'a deposit is sent by a page that cannot read the transaction it built');
    /* Ending inside both windows, it goes ahead. */
    now = NOW;
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(built(0, NOW + 60 * 60_000), VAULT, { ...MONEY, value: amount + 1n })).rejects.toBeInstanceOf(DepositNotYetSeen);
    expect(c.w.asked).toBe(1);
  });

  it('A DEPOSIT STOPPED BEFORE IT WAS HANDED OVER READS AS NOT SENT ON EVERY CHECK, AND IS NEVER SAID TO BE ON ITS WAY', async () => {
    const c = await company();
    const stopped = { ...c.first.doors, pay: async () => { throw new Error('the deposit was stopped in the wallet'); } };
    await expect(depositIntoCompanyVault(stopped, VAULT, MONEY)).rejects.toThrow(/stopped in the wallet/);
    expect([c.w.sent, c.first.kept.size]).toEqual([0, 0]);
    /* The wallet hands back something other than the deposit built: also never sent. */
    const altered = { ...c.first.doors, pay: async () => ({ transaction: 'another+coins', leaves: [] }) };
    await expect(depositIntoCompanyVault(altered, VAULT, { ...MONEY, value: MONEY.value + 1n })).rejects.toBeInstanceOf(DepositNotAsBuilt);
    expect(c.w.sent).toBe(0);
    const found = await checkWhatThisBrowserDeposited(c.browser().doors, VAULT, { files: false });
    /* RED WHEN: a deposit the wallet stopped, so nothing was sent, is said by the next check to be able to arrive until a time. */
    expect(found.deposit).toEqual({ state: 'none' });
    expect(found.alsoJournalled ?? []).toEqual([]);
    expect(sayWhatTheCheckFound(found)).not.toMatch(/can still arrive/u);
  });

  it('A DEPOSIT SAID NEVER TO HAVE LANDED IS NEVER SAID ON THE NEXT CHECK TO BE ON ITS WAY', async () => {
    const c = await company();
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    const from = Date.now();
    const at = (minutes: number) => ({ ...c.first.doors, clock: () => from + minutes * 60_000 });
    let neverLanded = false;
    for (const minutes of [70, 74, 76, 78, 81]) {
      const first = await checkWhatThisBrowserDeposited(at(minutes), VAULT, { files: false });
      if (first.deposit.state === 'never-landed') neverLanded = true;
      if (!neverLanded) continue;
      const next = await checkWhatThisBrowserDeposited(at(minutes), VAULT, { files: false });
      /* RED WHEN: a deposit settled as never landed from its record here is then said from its journal line to be able to arrive until a time. */
      expect(next.deposit.state, `${minutes} minutes on`).not.toBe('journalled-not-seen');
      expect(next.alsoJournalled ?? [], `${minutes} minutes on`).toEqual([]);
    }
    expect(neverLanded, 'the deposit is settled as never landed once it can no longer land').toBe(true);
  });

  it('a deposit handed to the service, which says nothing was sent, is still said to be on its way with its until', async () => {
    const c = await company();
    c.w.sendFails = Object.assign(new Error('the service says it sent nothing'), { nothingWasSent: true });
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotSent);
    c.w.sendFails = null;
    const rec = await c.records('deposit-journal').get(VAULT);
    const line = (openPool(rec!, 'ada', wrapping.secret, { record: 'deposit-journal' }) as unknown as { notes: Array<{ attemptedAt: string; ended?: true }> }).notes[0]!;
    /* RED WHEN: the service's word that nothing was sent is taken as this device never having handed the deposit over. */
    expect(line.ended).toBeUndefined();
    const found = await checkWhatThisBrowserDeposited(c.browser().doors, VAULT, { files: false });
    expect(found.deposit).toEqual({ state: 'journalled-not-seen', until: journalledDepositLandsBy(line.attemptedAt) });
  });

  it('a deposit handed over and not yet seen is still said to be on its way, with the time its journal line gives', async () => {
    const c = await company();
    c.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(c.first.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    const rec = await c.records('deposit-journal').get(VAULT);
    const line = (openPool(rec!, 'ada', wrapping.secret, { record: 'deposit-journal' }) as unknown as { notes: Array<{ attemptedAt: string; ended?: true }> }).notes[0]!;
    expect(line.ended, 'RED WHEN: a deposit that may have been sent is marked as never handed over').toBeUndefined();
    const found = await checkWhatThisBrowserDeposited(c.browser().doors, VAULT, { files: false });
    /* RED WHEN: a deposit that may have been sent and can still land is not said to be on its way, or is said without its until. */
    expect(found.deposit).toEqual({ state: 'journalled-not-seen', until: journalledDepositLandsBy(line.attemptedAt) });
  });
});

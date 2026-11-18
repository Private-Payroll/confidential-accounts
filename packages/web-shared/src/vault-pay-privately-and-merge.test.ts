import { aPrivatePaymentOut, anUnsetNewerSecret } from './vault-operation.test-support.js';
import { DEPOSIT_CLOCKS_MAY_DIFFER_MS, DEPOSIT_TIME_TO_LIVE_MS, type DepositInFlight } from './vault-private-deposit.js';
import { MergeNotAsBuilt, MergeNotYetSeen, NotesMovedUnderAStep, StepOvertaken, mergeNotesInCompanyVault, payPrivatelyFromCompanyVault } from './vault-pay-privately-and-merge.js';
import { type PaymentInFlight, PaymentLandedUnrecorded, PaymentNotAsBuilt, PaymentNotYetSeen, PaymentRefusedOnChain, PaymentStartedElsewhere, PaymentStillInFlight } from './vault-payment-in-flight.js';
import { type VaultService } from './vault-service.js';
import { checkWhatThisBrowserSent, sayWhatTheCheckFound } from './check-what-this-browser-sent.js';
import { settlePaymentInFlight } from './vault-payment-settled.js';
import { PaymentJournalInStore } from '../../../src/midnight/vault-journal.js';
import type { PrivatePaymentOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import { VaultAskFailed, type VaultBuilderClient } from './vault-worker-client.js';
import { answerVaultAsk } from './vault-worker-entry.js';
import { changeAfterSpending, mergedNoteOf } from '../../../src/midnight/vault-recovery.js';
import { confirmPayment } from './vault-builder.js';
import { openNonceSecrets, recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { describe, expect, it } from 'vitest';
import { nonceCircuitsFrom } from '../../../src/midnight/vault-coin-nonces.js';
import { seatBarOf } from 'midnight-identity/profile/records-key';
import * as vaultModule from '../../../contracts/managed-vault/contract/index.js';
import { vaultNoteCommitment } from '../../../src/midnight/note-index.js';
import { ACCOUNT, type ChainBehind, LABEL, type TestView, VAULT, aServiceThatLies, eventsOfAPayment, inFlightInMemory, ownOnChain, paymentEvents, theServiceNeverAsked, view, walletKey, walletReadsTheVault, wireOfCoin } from './vault-operation.test-support.js';


describe('A PRIVATE PAYMENT OUT', () => {
  const { wrapping, me, signers, TOKEN, PAID_IN, NOTE, CHANGE, NOW, order, setUp, landsWhenSent } = aPrivatePaymentOut();

  it('A PRIVATE PAYMENT IS BUILT ON THE BLOCK AND THE EVENTS THIS DEVICE READ AT THE WALLET\'S INDEXER, AND CONFIRMED BY THEM; THE SERVICE IS NEVER ASKED', async () => {
    const t = await setUp();
    const asked: string[] = [];
    const d = t.doors(landsWhenSent());
    const done = await payPrivatelyFromCompanyVault({ ...d, service: aServiceThatLies(d.service, asked) }, order());
    /* RED WHEN: the block, the note's events or the payment's own events are asked of the service. */
    expect(asked).toEqual([]);
    /* RED WHEN: the payment is built at any block but the one this device read, or on any events but those it read. */
    expect(t.log).toContain('build payout spending 01 with 1 event(s) at B1');
    expect(t.log.filter((l) => l.endsWith(' here'))).toEqual(['read events of 0e here', 'read the block here', 'read events of dd here']);
    /* RED WHEN: the change is recorded under the service's history rather than this payment's own events, read here. */
    expect(done.transactionHash).toBe(PAID_IN);
  });

  it('WRITES THE PAYMENT DOWN ONCE IT IS BUILT AND BEFORE IT IS SENT, AND ADVANCES THE POOL ONLY ON THIS PAYMENT\'S OWN EVENTS, UNDER ITS OWN HASH', async () => {
    /* RED WHEN: the journal line moves below the send (the journal read inside the service stand-in is then empty) or
     * above the build (the read inside the builder stand-in then finds it); the pool is advanced before this payment's
     * own events are read (the log then lacks that read); or the change is saved under anything but this payment's hash. */
    const t = await setUp();
    let journalledAtBuild = -1;
    let journalledWhenSent = -1;
    let builtWith = '';
    const b = t.doors(landsWhenSent());
    const build = b.builder.payout;
    b.builder.payout = async (i) => { journalledAtBuild = (await t.journal()).length; builtWith = i.secret; return build(i); };
    const send = b.service.payout;
    b.service.payout = async (v, tx) => { journalledWhenSent = (await t.journal()).length; return send(v, tx); };
    const done = await payPrivatelyFromCompanyVault(b, order());
    expect([journalledAtBuild, journalledWhenSent]).toEqual([0, 1]);
    /* RED WHEN: the payment is built with anything but the vault's secret as the company's filed record holds it. */
    expect(builtWith).toBe(openNonceSecrets((await b.records('nonce-secret').get(VAULT))!, VAULT, recordsKeypairFrom(me.companyKey)).secrets[0]);
    expect(t.log).toEqual([
      'choose', 'read events of 0e here', 'read the block here', 'build payout spending 01 with 1 event(s) at B1', 'read events of dd here',
    ]);
    expect(done).toEqual({
      txRef: 'o', transactionHash: PAID_IN, spent: NOTE.nonce, change: { ...CHANGE, value: '300' }, seenAs: 'its-own-transaction',
    });
    expect(await t.notesNow()).toEqual([{ ...CHANGE, createdIn: PAID_IN }]);
    const lines = await t.journal();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ spent: { nonce: NOTE.nonce, token: TOKEN, value: 500n }, amount: 200n });
  });

  it('A STEP THAT TOOK THIS VAULT\'S NOTE AND LEFT A COIN NO RECORD ON THIS DEVICE HOLDS: AFTER SETTLING, THE PAYMENT\'S OPEN REBUILDS THE RECORD AND PAYS FROM THAT COIN', async () => {
    /*
     * The pool holds a note a split nobody journalled took; the chain holds the piece it left. The rebuild (the vault
     * worker stood in, naming that piece) runs after anything this browser sent is settled, files the piece, drops the
     * note the chain made and no longer holds, and the payment is planned from the record as filed.
     */
    const PIECE = { nonce: '0a'.repeat(32), token: TOKEN, value: 300n };
    const t = await setUp([NOTE], [`h${PIECE.nonce.slice(1)}`]);
    const views = [view({ heldByCommittee: true, started: true, notes: [`h${PIECE.nonce.slice(1)}`], everCreated: ['aa'.repeat(32)], nonceCommitment: '5c'.repeat(32), splitJournal: [] })];
    const d = t.doors(landsWhenSent({ ...CHANGE, value: 100n }), views);
    const asked: string[] = [];
    d.builder = {
      ...d.builder,
      vaultRebuilt: async (a) => {
        asked.push(`rebuilt over ${a.versions.map((v) => v.notes.map((n) => n.nonce.slice(0, 2)).join('+')).join(',')}`);
        return { held: [{ nonce: PIECE.nonce, token: TOKEN, value: '300', held: `h${PIECE.nonce.slice(1)}`, output: 'aa'.repeat(32) }], unexplained: [], copy: null, said: [] };
      },
      createdBy: async () => ({ transactionHash: '0e'.repeat(32), events: [{} as never] }),
      creatingTransaction: async () => ({ state: 'found', createdIn: '0e'.repeat(32) }),
    };
    const done = await payPrivatelyFromCompanyVault(d, order());
    /* RED WHEN: opening the vault for a payment does not rebuild its record, so the note the chain no longer holds is chosen. */
    expect(asked).toEqual(['rebuilt over 01']);
    expect(t.log).toContain('build payout spending 0a with 1 event(s) at B1');
    expect(done.spent).toBe(PIECE.nonce);

    /* This browser's own payment of that note, kept no change and found gone: settled first, and only then rebuilt. */
    const u = await setUp([NOTE], [`h${PIECE.nonce.slice(1)}`]);
    u.kept.set(VAULT, {
      spent: { nonce: NOTE.nonce, token: TOKEN, value: '500' } as never, amount: '500', change: null, recordedAt: NOW.getTime(),
      txRef: 'o0', transactionHash: null, identifiers: ['O0 named'], timeToLive: NOW.getTime(), transaction: 'O0', claim: 'earlier',
    } as never);
    ownOnChain.set('O0', { of: 'landed', transactionHash: 'd0'.repeat(32) });
    const e = u.doors(landsWhenSent({ ...CHANGE, value: 100n }), views);
    e.builder = { ...d.builder, payout: e.builder.payout };
    asked.length = 0;
    await payPrivatelyFromCompanyVault(e, order());
    /* RED WHEN: the record is rebuilt before what this browser sent is settled (the rebuild would see the settled note still held). */
    expect(asked).toEqual(['rebuilt over ']);
  });

  it('A REBUILD THAT FAILS STOPS NO PAYMENT: THE PAYMENT IS MADE FROM THE RECORD AS FILED', async () => {
    const t = await setUp([NOTE], [`h${NOTE.nonce.slice(1)}`, `h${'5b'.repeat(32).slice(1)}`]);
    const d = t.doors(landsWhenSent());
    d.builder = { ...d.builder, vaultRebuilt: async () => { throw new Error('the vault worker stopped'); } };
    /* RED WHEN: a failure of the rebuild is thrown into the payment, so a service withholding a journal stops a payment the record could make. */
    const done = await payPrivatelyFromCompanyVault(d, order());
    expect(done.spent).toBe(NOTE.nonce);
  });

  it('A PAYMENT THAT DRAWS ON TWO NOTES IS PLANNED, WRITTEN DOWN, BUILT AND RECORDED WITH BOTH, AS THE CHAIN HOLDS IT', async () => {
    /*
     * Two notes of 120 and 100 pay 200 together, and no single note covers it. The planner offers the larger first.
     * RED WHEN: the journal line, the build or the record names only the first note - the rebuild would then propose
     * a change the chain never made, and the pool would keep offering a note the chain has nullified.
     */
    const A = { nonce: '02'.repeat(32), token: TOKEN, value: 120n, createdIn: '0e'.repeat(32) };
    const B = { nonce: '03'.repeat(32), token: TOKEN, value: 100n, createdIn: '0f'.repeat(32) };
    const change = { nonce: 'cc'.repeat(32), token: TOKEN, value: 20n };
    const t = await setUp([B, A], [`h${A.nonce.slice(1)}`, `h${B.nonce.slice(1)}`]);
    const b = t.doors(landsWhenSent(change));
    let inFlightWhileSending: PaymentInFlight | null = null;
    const send = b.service.payout;
    b.service.payout = async (v, tx) => { inFlightWhileSending = await b.inFlight.get(v); return send(v, tx); };
    const done = await payPrivatelyFromCompanyVault(b, order());
    expect(t.log).toEqual([
      'choose', 'read events of 0e here', 'read events of 0f here', 'read the block here', 'build payout spending 02+03 with 1+1 event(s) at B1', 'read events of dd here',
    ]);
    expect(done).toMatchObject({ spent: A.nonce, change: { ...change, value: '20' } });
    const [line] = await t.journal();
    expect(line, 'RED WHEN: the journal names only the note offered first').toMatchObject({
      spent: { nonce: A.nonce, value: 120n }, further: [{ nonce: B.nonce, token: TOKEN, value: 100n }], step: 'payment', amount: 200n,
    });
    expect((inFlightWhileSending as PaymentInFlight | null)?.further, 'RED WHEN: the record kept while the payment is sent forgets the further note')
      .toEqual([{ nonce: B.nonce, token: TOKEN, value: '100' }]);
    expect(await t.notesNow(), 'RED WHEN: the pool keeps the further note the chain has nullified').toEqual([{ ...change, createdIn: PAID_IN }]);
  });

  it('A PAYMENT OUT OF A VAULT THE ACCOUNT HAS NOT ADOPTED, AS THE SIGNER\'S OWN WALLET READS IT, IS REFUSED BEFORE ANYTHING IS WRITTEN DOWN', async () => {
    const t = await setUp();
    const b = { ...t.doors(landsWhenSent()), onChain: async (v: string) => ({ holders: { committee: [], threshold: 1, seats: [], approvals: 1, vaultThresholds: [], policyBar: null, seatBar: seatBarOf(1, null), adoptedVaults: [], founding: '4a'.repeat(32), foundingCommittee: [{ tag: 'schnorr', value: walletKey(0x11) }] } }) };
    const e = await payPrivatelyFromCompanyVault(b, order()).catch((x: Error) => x);
    /* RED WHEN: a payment is made out of a vault the service named and the account never adopted. */
    expect((e as Error).message).toMatch(/not one your company's account has adopted/);
    expect(await t.journal()).toEqual([]);
    expect(t.log.filter((l) => l.startsWith('build') || l === 'choose')).toEqual([]);
  });

  it('A PAYMENT IS BUILT UNDER THE SECRET THE VAULT HOLDS, FOUND IN AN EARLIER VERSION WHEN A NEWER ONE THE VAULT NEVER TOOK IS FILED, AND FILES NOTHING', async () => {
    const t = await setUp();
    const b = t.doors(landsWhenSent());
    const theVaults = await anUnsetNewerSecret(b.records, me.companyKey);
    b.builder.secretIsTheVaults = async (i) => i.secret === theVaults;
    let builtWith = '';
    const build = b.builder.payout;
    b.builder.payout = async (i) => { builtWith = i.secret; return build(i); };
    await payPrivatelyFromCompanyVault(b, order());
    /* RED WHEN: a payment refuses, or builds, under the records' newest secret when the vault holds an earlier one. */
    expect(builtWith).toBe(theVaults);
    /* RED WHEN: a payment files a version again on its way: a re-file can put a record with fewer secrets over a newer one. */
    expect((await b.records('nonce-secret').get(VAULT))!.version).toBe(2);
  });

  /* RED WHEN: a payment is written down or built under a secret the vault's commitment does not name. */
  it('A PAYMENT UNDER A SECRET THE VAULT DOES NOT HOLD IS REFUSED BEFORE ANYTHING IS WRITTEN DOWN OR BUILT', async () => {
    const t = await setUp();
    /* The service's block names the vault's state 'V'; this device read 'DEVICE'. */
    const b = t.doors(landsWhenSent(), [view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`], state: 'DEVICE' })]);
    const asked: string[] = [];
    b.builder.secretIsTheVaults = async (i) => { asked.push(i.state); return false; };
    const e = await payPrivatelyFromCompanyVault(b, order()).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/holds the secret this vault holds now, so nothing was built from it\. Nothing was sent/);
    /* Asked of the state this device read, by the payment's own check. RED WHEN: it is asked of the state the service served. */
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(['DEVICE']));
    expect(await t.journal()).toEqual([]);
    expect(t.log.filter((l) => l.startsWith('build'))).toEqual([]);
  });

  it('A NOTE SPENT EXACTLY LEAVES NO CHANGE, AND THE POOL LOSES THE NOTE ONCE THE CHAIN SHOWS THE PAYMENT\'S OWN TRANSACTION', async () => {
    const t = await setUp();
    const done = await payPrivatelyFromCompanyVault(t.doors(landsWhenSent(null)), order({}, { amount: '500' }));
    expect(done.change).toBeNull();
    expect(await t.notesNow()).toEqual([]);
    /* RED WHEN: a payment found by its own transaction is reported as found by what it left, or under another name. */
    expect([done.seenAs, done.transactionHash]).toEqual(['its-own-transaction', PAID_IN]);
  });

  it('A PAYMENT THAT KEEPS NO CHANGE IS RECORDED ONLY BY ITS OWN TRANSACTION: NEVER BY A HASH THE SERVICE NAMED, NEVER BY ITS NOTE LEAVING', async () => {
    /*
     * The service names a transaction whose events pay a person, and the chain no longer holds the note: neither says
     * this payment landed. Its own transaction, looked for by the identifiers read from it before the send, does.
     */
    const t = await setUp();
    const gone = view({ heldByCommittee: true, started: true, notes: [] });
    const keptAtTheSend: Array<Record<string, unknown> | undefined> = [];
    const d = t.doors({
      payout: async () => {
        keptAtTheSend.push(...[...t.kept.values()] as never[]);
        paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, null));
        return { txRef: 'o', transactionHash: PAID_IN };
      },
    }, [view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`] }), gone]);
    const e = await payPrivatelyFromCompanyVault(d, order({}, { amount: '500' })).catch((x) => x);
    /* RED WHEN: the payment is recorded on the service's hash or on its note leaving the vault. */
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(await t.notesNow()).toEqual([NOTE]);
    /* RED WHEN: the record kept before the send does not name the payment's own transaction. */
    expect(keptAtTheSend).toHaveLength(1);
    expect(keptAtTheSend[0]).toMatchObject({ identifiers: ['O named'], timeToLive: 0, transaction: 'O', change: null });
    /* RED WHEN: settling records it on its note leaving while its own transaction is unseen. */
    await expect(settlePaymentInFlight(t.doors({}, [gone]), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    expect(await t.notesNow()).toEqual([NOTE]);
    ownOnChain.set('O', { of: 'landed', transactionHash: 'a7'.repeat(32) });
    expect(await settlePaymentInFlight(t.doors({}, [gone]), VAULT)).toEqual({ state: 'recorded', createdIn: null });
    expect(await t.notesNow()).toEqual([]);
    expect(t.kept.size).toBe(0);
  });

  it('A PAYMENT THAT KEEPS NO CHANGE WHOSE OWN TRANSACTION CANNOT BE READ IS NOT SENT', async () => {
    for (const [why, read] of [
      ['a transaction that names no identifier', async () => ({ identifiers: [], timeToLive: 0, calls: [{ address: VAULT, entryPoint: 'payout', segments: [1] }] })],
      ['a transaction with no time to live this can read', async () => ({ identifiers: ['O named'], timeToLive: null, calls: [{ address: VAULT, entryPoint: 'payout', segments: [1] }] })],
      ['a transaction that carries no payout of this vault', async () => ({ identifiers: ['O named'], timeToLive: 0, calls: [] })],
      ['bytes that are no transaction', async () => null],
    ] as const) {
      const t = await setUp();
      let sent = 0;
      const d = t.doors({ payout: async () => { sent += 1; return { txRef: 'o', transactionHash: PAID_IN }; } });
      d.builder = { ...d.builder, readTransaction: read as never };
      const e = await payPrivatelyFromCompanyVault(d, order({}, { amount: '500' })).catch((x) => x);
      /* RED WHEN: a payment this device could never find on the chain by its own transaction is sent. */
      expect([sent, t.kept.size], `RED WHEN: ${why} is sent`).toEqual([0, 0]);
      expect(e.message).toMatch(/did not send it\. Nothing was sent/);
    }
  });

  it('A PAYMENT THAT KEEPS NO CHANGE AND THE CHAIN REFUSED IS LET GO AT ONCE AND SAYS NOBODY WAS PAID BY IT; SETTLED LATER, IT NEVER LANDED', async () => {
    const t = await setUp();
    const d = t.doors({
      payout: async () => {
        ownOnChain.set('O', { of: 'refused', transactionHash: 'af'.repeat(32) });
        return { txRef: 'o', transactionHash: PAID_IN };
      },
    });
    const e = await payPrivatelyFromCompanyVault(d, order({}, { amount: '500' })).catch((x) => x);
    /* RED WHEN: a refused payment is recorded, waited on as though it may still land, or kept on its way. */
    expect(e).toBeInstanceOf(PaymentRefusedOnChain);
    expect([await t.notesNow(), t.kept.size]).toEqual([[NOTE], 0]);
    /* The page stopped watching first; the note has since left by a step nobody journalled. */
    const u = await setUp();
    await payPrivatelyFromCompanyVault(u.doors({ payout: async () => { throw new Error('the connection dropped'); } }), order({}, { amount: '500' })).catch(() => undefined);
    ownOnChain.set('O', { of: 'refused', transactionHash: 'af'.repeat(32) });
    /* RED WHEN: a payment whose own transaction the chain refused is recorded as paid on its note leaving. */
    expect(await settlePaymentInFlight(u.doors({}, [view({ heldByCommittee: true, started: true, notes: [] })]), VAULT)).toEqual({ state: 'never-landed' });
    expect([await u.notesNow(), u.kept.size]).toEqual([[NOTE], 0]);
  });

  it('TWO PAYMENTS FROM ONE NOTE FOR ONE AMOUNT: THE ONE WHOSE OWN TRANSACTION THE CHAIN DOES NOT HOLD IS NOT RECORDED AS PAID', async () => {
    /*
     * The other payment landed and made exactly this payment's change coin, so the vault's notes read as though this
     * one had. RED WHEN: the pool is advanced on what the vault holds rather than on this payment's own events - it is
     * then advanced, and its change recorded under a transaction that never landed.
     */
    const t = await setUp();
    const e = await payPrivatelyFromCompanyVault(t.doors({
      payout: async () => {
        paymentEvents.set('a1'.repeat(32), await eventsOfAPayment('a1'.repeat(32), CHANGE));
        return { txRef: 'o', transactionHash: PAID_IN };
      },
    }), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(await t.notesNow()).toEqual([NOTE]);
  });

  it('A PAYMENT WHOSE OWN EVENTS DO NOT CARRY THE CHANGE, OR PAY NOBODY, IS NOT RECORDED, AND SAYS AT ONCE IT IS NOT AS BUILT', async () => {
    /* RED WHEN: the confirmation stops requiring the change among this transaction's own outputs, or a person's output;
     * or the wait reads a transaction that is there and not as built as "not yet". */
    const noChange = await setUp();
    const e1 = await payPrivatelyFromCompanyVault(noChange.doors({
      payout: async () => { paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, null)); return { txRef: 'o', transactionHash: PAID_IN }; },
    }), order()).catch((x) => x);
    expect(e1).toBeInstanceOf(PaymentNotAsBuilt);
    expect(e1.message).toMatch(/did not create this note/);
    expect(noChange.log.filter((l) => l === 'read events of dd here')).toHaveLength(1);
    expect(await noChange.notesNow()).toEqual([NOTE]);
    const nobody = await setUp();
    const e2 = await payPrivatelyFromCompanyVault(nobody.doors({
      payout: async () => {
        paymentEvents.set(PAID_IN, (await eventsOfAPayment(PAID_IN, CHANGE)).filter((ev) => ev.details.commitment !== 'f0'.repeat(32)));
        return { txRef: 'o', transactionHash: PAID_IN };
      },
    }), order()).catch((x) => x);
    expect(e2).toBeInstanceOf(PaymentNotAsBuilt);
    expect(e2.message).toMatch(/paid nobody/);
    expect(await nobody.notesNow()).toEqual([NOTE]);
  });

  it('THE CONFIRMATION READS ONLY THIS TRANSACTION\'S OWN EVENTS, AND NONE IS NOT AN ANSWER', async () => {
    /* RED WHEN: events of another transaction are accepted among these, or an empty answer is read as landed. */
    const own = await eventsOfAPayment(PAID_IN, CHANGE);
    const change = { ...CHANGE, value: '300' };
    await expect(confirmPayment({ vault: VAULT, transactionHash: PAID_IN, change, events: own }))
      .resolves.toEqual({ state: 'landed', createdIn: PAID_IN });
    const mixed = [...own.slice(0, 2), { ...own[2]!, transactionHash: 'a1'.repeat(32) }];
    await expect(confirmPayment({ vault: VAULT, transactionHash: PAID_IN, change, events: mixed }))
      .resolves.toEqual({ state: 'not-as-built', why: expect.stringMatching(/not all its own/) });
    await expect(confirmPayment({ vault: VAULT, transactionHash: PAID_IN, change: null, events: [] }))
      .resolves.toEqual({ state: 'not-yet' });
    /* The change must be this vault's: the same output for another contract is not it. */
    await expect(confirmPayment({ vault: 'ee'.repeat(32), transactionHash: PAID_IN, change, events: own }))
      .resolves.toMatchObject({ state: 'not-as-built' });
  });

  it('A MERGE IS CONFIRMED ONLY BY ITS OWN EVENTS KEEPING ONE COIN FOR THIS VAULT AND PAYING NOBODY', async () => {
    const MERGED_IN = 'dc'.repeat(32);
    const kept = { nonce: 'e7'.repeat(32), token: TOKEN, value: 220n };
    const keptOut = { transactionHash: MERGED_IN, details: { tag: 'zswapOutput', commitment: await vaultNoteCommitment(kept as never, VAULT as never), contract: VAULT, mtIndex: '13' } };
    const keptWire = { ...kept, value: '220' };
    /* RED WHEN: a merge's own events, which pay nobody, are refused as a payment that paid nobody. */
    await expect(confirmPayment({ vault: VAULT, transactionHash: MERGED_IN, change: keptWire, events: [keptOut], merge: true }))
      .resolves.toEqual({ state: 'landed', createdIn: MERGED_IN });
    /* RED WHEN: a transaction under a merge's name that pays a person is accepted as the merge. */
    const toAPerson = { transactionHash: MERGED_IN, details: { tag: 'zswapOutput', commitment: 'f0'.repeat(32), mtIndex: '11' } };
    await expect(confirmPayment({ vault: VAULT, transactionHash: MERGED_IN, change: keptWire, events: [toAPerson, keptOut], merge: true }))
      .resolves.toEqual({ state: 'not-as-built', why: expect.stringMatching(/pays somebody/) });
    /* RED WHEN: a merge with no coin named is taken as landed on any events at all. */
    await expect(confirmPayment({ vault: VAULT, transactionHash: MERGED_IN, change: null, events: [keptOut], merge: true }))
      .resolves.toEqual({ state: 'not-as-built', why: expect.stringMatching(/keeps one coin/) });
    /* And the same events are not a payment: one that pays nobody is refused as one. */
    await expect(confirmPayment({ vault: VAULT, transactionHash: MERGED_IN, change: keptWire, events: [keptOut] }))
      .resolves.toEqual({ state: 'not-as-built', why: expect.stringMatching(/paid nobody/) });
  });

  it('A PERSON THE ACCOUNT ALREADY RECORDS PAID, OR A WINDOW THAT IS NOT OPEN, IS REFUSED BEFORE THE POOL IS OPENED', async () => {
    /* RED WHEN: either early refusal is removed - the log then carries 'choose' and a journal line is written. */
    const paid = await setUp();
    await expect(payPrivatelyFromCompanyVault(paid.doors(), order({}, { paid: true }))).rejects.toThrow(/already records this person paid/);
    const early = await setUp();
    await expect(payPrivatelyFromCompanyVault(early.doors(), order({ opensAt: '1800000001' }))).rejects.toThrow(/not open now/);
    const late = await setUp();
    await expect(payPrivatelyFromCompanyVault(late.doors(), order({ closesAt: '1800000000' }))).rejects.toThrow(/not open now/);
    for (const t of [paid, early, late]) {
      expect(t.log).toEqual([]);
      expect(await t.journal()).toEqual([]);
    }
  });

  it('A PRIVATE PAYMENT OUT OF A VAULT WHOSE COMMITTEE DIFFERS FROM THE ACCOUNT\'S GOES AHEAD WHILE THE VAULT IS PINNED TO THE ACCOUNT', async () => {
    const t = await setUp();
    /* Started and pinned to the company's account, and held by other keys than the account is, as the chain shows both. */
    const otherKeys = view({ heldByCommittee: false, started: true, notes: [`h${NOTE.nonce.slice(1)}`] });
    const done = await payPrivatelyFromCompanyVault(t.doors(landsWhenSent(), [otherKeys]), order());
    /* RED WHEN: a payment out reads who holds the vault - a committee change the service leaves half done would then stop every payment. */
    expect(done.transactionHash).toBe(PAID_IN);
    expect(t.log).toContain('build payout spending 01 with 1 event(s) at B1');
  });

  it('A VAULT NOT STARTED IS NOT OPENED HERE, AND NOTHING IS WRITTEN OR PROVED; ONE HELD BY OTHER KEYS THAN THE ACCOUNT PAYS', async () => {
    /*
     * The committee holds the vault and its first secret is not set, as this
     * device read it. RED WHEN: the fundable answer's check is removed or moved below
     * the journal line - the pool is then opened, a note chosen and a line
     * written for a payment that could never be sent.
     */
    const t = await setUp();
    const notStarted = view({ heldByCommittee: true, started: false, notes: [`h${NOTE.nonce.slice(1)}`] });
    /* RED WHEN: the check moves below opening the pool - this door's records are then read at all. */
    const unopened = { ...t.doors({}, [notStarted]), records: () => { throw new Error('the pool was opened'); } };
    const e = await payPrivatelyFromCompanyVault(unopened as never, order()).catch((x) => x);
    expect(e.message).toMatch(/^No payment can be made out of this vault yet/);
    expect(e.message).toMatch(/this vault has not been started/);
    expect(e.message).toMatch(/Nothing was sent\./);
    expect(t.log).toEqual([]);
    expect(await t.journal()).toEqual([]);
    /*
     * The company's account held by other keys than the vault, as the signer's own wallet reads it. RED WHEN: who
     * holds the vault is compared with who holds the account - the payment is then refused.
     */
    const held = view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`] });
    const temporary = async (v: string) => ({ ...(await walletReadsTheVault.onChain(v)), holders: { ...(await walletReadsTheVault.onChain(v)).holders, committee: [{ tag: 'schnorr', value: walletKey(0x77) }] } });
    const other = await payPrivatelyFromCompanyVault({ ...t.doors(landsWhenSent(), [held]), onChain: temporary }, order());
    expect(other.transactionHash).toBe(PAID_IN);
  });

  it('A NOTE THAT DOES NOT NAME ITS TRANSACTION IS NOT SPENT, AND NOTHING IS WRITTEN OR SENT', async () => {
    /* RED WHEN: the `createdIn` check is removed - the events are then read for `undefined` and a line is journalled. */
    const { createdIn: _none, ...unnamed } = NOTE;
    const t = await setUp(unnamed);
    await expect(payPrivatelyFromCompanyVault(t.doors(), order())).rejects.toThrow(/does not record which transaction created it/);
    expect(t.log).toEqual(['choose']);
    expect(await t.journal()).toEqual([]);
  });

  it('A NOTE THE CHAIN NO LONGER HOLDS IS NOT SPENT AGAIN: A PAYMENT FROM IT LANDED THAT THE RECORD DOES NOT SHOW', async () => {
    /* RED WHEN: the chosen note is not checked against what the chain holds - a line is journalled and a payment built. */
    const t = await setUp(NOTE, [`h${'cc'.repeat(32).slice(1)}`]);
    await expect(payPrivatelyFromCompanyVault(t.doors(landsWhenSent()), order())).rejects.toThrow(/a step that spent it has landed that this record does not show/);
    expect(t.log).toEqual(['choose']);
    expect(await t.journal()).toEqual([]);
  });

  it('A PAYMENT THE BUILD REFUSES, AS ONE SHORT OF ITS APPROVALS IS, WRITES NO LINE IN THE JOURNAL AND SENDS NOTHING', async () => {
    const t = await setUp();
    const b = t.doors(landsWhenSent());
    b.builder.payout = async () => { throw new Error('not enough approvals yet'); };
    await expect(payPrivatelyFromCompanyVault(b, order())).rejects.toThrow(/not enough approvals yet/u);
    /* RED WHEN: the journal line is written before the build, so it names a payment that was never sent. */
    expect(await t.journal()).toEqual([]);
    expect(t.log.filter((l) => l.startsWith('sent'))).toEqual([]);
    expect(await t.notesNow()).toEqual([NOTE]);
  });

  it('A PAYMENT BUILT OVER ANOTHER NOTE THAN THE ONE CHOSEN WRITES NO LINE IN THE JOURNAL AND IS NOT SENT', async () => {
    const t = await setUp();
    const b = t.doors(landsWhenSent());
    const build = b.builder.payout;
    b.builder.payout = async (i) => ({ ...(await build(i)), spent: '09'.repeat(32) });
    await expect(payPrivatelyFromCompanyVault(b, order())).rejects.toThrow(/spends a different note/u);
    /* RED WHEN: the journal line is written before the built payment is checked against the note chosen. */
    expect(await t.journal()).toEqual([]);
    expect(t.log.filter((l) => l.startsWith('sent'))).toEqual([]);
  });

  it('A PAYMENT WHOSE OWN TRANSACTION THE CHAIN HAS NOT SHOWN LEAVES THE POOL AS IT WAS, AND SAYS THE MONEY MAY HAVE MOVED', async () => {
    /* RED WHEN: the wait is removed or accepts anything - the pool then loses the note the chain still holds. */
    const t = await setUp();
    const e = await payPrivatelyFromCompanyVault(t.doors(), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(e.message).toMatch(/Do not pay this person again/);
    expect(await t.notesNow()).toEqual([NOTE]);
    expect(await t.journal()).toHaveLength(1);
  });

  it('A SEND THE SERVICE REFUSED CHANGES NOTHING AND SAYS SO; A SEND THAT MAY HAVE LANDED SAYS THE MONEY MAY HAVE MOVED', async () => {
    /* RED WHEN: a failure the service did not mark as nothing sent is passed through as it came - a screen then says
     * the payment did not finish and offers the person again. */
    const t = await setUp();
    const refused = Object.assign(new Error('this is not a private payment. Nothing was sent.'), { nothingWasSent: true });
    await expect(payPrivatelyFromCompanyVault(t.doors({ payout: async () => { throw refused; } }), order()))
      .rejects.toThrow('this is not a private payment. Nothing was sent.');
    const lost = Object.assign(new Error('the node did not answer'), { nothingWasSent: false });
    const e = await payPrivatelyFromCompanyVault(t.doors({ payout: async () => { throw lost; } }), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(e.message).toMatch(/the node did not answer/);
    expect(await t.notesNow()).toEqual([NOTE]);
  });

  it('A SEND THE SERVICE CANNOT NAME, OR A RECORD THAT CANNOT BE WRITTEN AFTER IT LANDED, SAYS THE MONEY MAY HAVE MOVED', async () => {
    /* RED WHEN: a failure after the send reaches the screen as an ordinary error. */
    const unnamed = await setUp();
    const e1 = await payPrivatelyFromCompanyVault(unnamed.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }), order()).catch((x) => x);
    expect(e1).toBeInstanceOf(PaymentNotYetSeen);
    expect(e1.message).toMatch(/could not name the transaction/);
    expect(await unnamed.notesNow()).toEqual([NOTE]);
    const unwritable = await setUp();
    const b = unwritable.doors(landsWhenSent());
    b.builder.afterPayment = async () => { throw new Error('the pool refused the write'); };
    const e2 = await payPrivatelyFromCompanyVault(b, order()).catch((x) => x);
    /* A part of this page that stops answering after the send is not a payment that did not happen. */
    const stopped = await setUp();
    const c = stopped.doors(landsWhenSent());
    c.builder.confirmPayment = async () => { throw new Error('the part of this page that builds vault transactions stopped'); };
    const e3 = await payPrivatelyFromCompanyVault(c, order()).catch((x) => x);
    expect(e3).toBeInstanceOf(PaymentNotYetSeen);
    expect(e3.message).toMatch(/stopped/);
    /* RED WHEN: a write that fails after the payment was confirmed is reported as a payment not seen. */
    expect(e2).toBeInstanceOf(PaymentLandedUnrecorded);
    expect(e2.message).toMatch(/the pool refused the write/);
    expect(e2.message).toMatch(/The person is paid/);
  });

  it('A PAYMENT SENT IS STILL CONFIRMED WHEN ONE CHECK OF IT FAILS, AND A PAYMENT NOT YET SEEN NEVER SAYS TRY AGAIN', async () => {
    /* RED WHEN: a failed check of the payment's events ends the wait - a payment that landed is reported as not seen. */
    const once = await setUp();
    const d = once.doors(landsWhenSent());
    const confirm = d.builder.confirmPayment;
    let failed = 0;
    d.builder.confirmPayment = async (input) => {
      if (failed === 0) { failed += 1; throw new VaultAskFailed('confirm-payment', 'stopped', 'the part of this page that builds and proves vault transactions stopped before it answered. Try again; if it happens again, reload the page.'); }
      return confirm(input);
    };
    const done = await payPrivatelyFromCompanyVault(d, order());
    expect(failed).toBe(1);
    expect(done.transactionHash).toBe(PAID_IN);
    /* RED WHEN: the worker's own sentence is put inside the notice - a notice whose job is to stop a second payment tells the person to try again. */
    const never = await setUp();
    const n = never.doors(landsWhenSent());
    n.builder.confirmPayment = async () => {
      throw new VaultAskFailed('confirm-payment', 'took-too-long', 'the part of this page that builds and proves vault transactions said nothing for 10 minutes, so this page stopped it. Try again with this page open in front and other heavy work closed.');
    };
    const e = await payPrivatelyFromCompanyVault(n, order()).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(e.message).toMatch(/took-too-long/);
    expect(e.message).not.toMatch(/try again/i);
    expect(await never.notesNow()).toEqual([NOTE]);
    /* RED WHEN: a refusal the worker answered with is not named in the notice - the person cannot tell which check could not be made. */
    const refusing = await setUp();
    const r = refusing.doors(landsWhenSent());
    r.builder.confirmPayment = async () => {
      throw new VaultAskFailed('confirm-payment', 'answered', 'the indexer could not be read. Try again.', { name: 'NoteIndexUnreadable' });
    };
    const refused = await payPrivatelyFromCompanyVault(r, order()).catch((x) => x);
    expect(refused).toBeInstanceOf(PaymentNotYetSeen);
    expect(refused.message).toMatch(/answered, NoteIndexUnreadable/);
    expect(refused.message).not.toMatch(/try again/i);
  });

  /** A builder whose output commitments are the ledger's own, so the vault's history can be searched by them. */
  const withRealOutputs = (b: VaultBuilderClient): VaultBuilderClient => ({
    ...b,
    commitments: async (i) => ({
      output: await vaultNoteCommitment({ nonce: i.coin.nonce, token: i.coin.token, value: BigInt(i.coin.value) } as never, VAULT as never),
      held: `h${i.coin.nonce.slice(1)}`,
    }),
  });
  const heldChange = `h${CHANGE.nonce.slice(1)}`;
  const second = (over: Partial<PrivatePaymentOnTheWire> = {}) => {
    const o = order({}, { index: 1, amount: '100', ...over });
    return { order: { ...o.order, payments: [o.payment] }, payment: o.payment };
  };

  it('A PAYMENT THE ACT SENDS STRAIGHT TO THE CHAIN GOES FROM THE PERSON\'S OWN WALLET, NEVER THE SERVICE, AND IS RECORDED ONCE FOUND BY WHAT IT LEFT', async () => {
    const t = await setUp();
    const b = t.doors({ payout: async () => { throw new Error('the service is asked to relay a payment the act sends straight to the chain'); } });
    const straight: string[] = [];
    const done = await payPrivatelyFromCompanyVault({
      ...b, builder: withRealOutputs(b.builder),
      handOver: {
        path: 'chain',
        toChain: async (_tx, call) => {
          straight.push(`${call.kind} on ${call.contract}`);
          paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, CHANGE));
        },
      },
    }, order());
    /* RED WHEN: a payment the act sends straight to the chain is relayed by the service, or sent as anything but a payout of this vault's coins. */
    expect(straight).toEqual([`payout on ${VAULT}`]);
    /* RED WHEN: a payment sent with no answer from the service is not found by what it left, so it is not recorded as paid. */
    expect(await t.notesNow()).toEqual([{ ...CHANGE, createdIn: PAID_IN }]);
    expect(done.seenAs).toBe('by-what-it-left');
    expect(t.kept.size).toBe(0);
  });

  it('A PAYMENT WHOSE SEND GAVE NO HASH IS RECORDED UNDER ITS CREATING TRANSACTION ONCE IT LANDS, AND THE NEXT PAYMENT OF THE RUN SPENDS ITS CHANGE', async () => {
    const t = await setUp();
    const b = t.doors({
      payout: async () => {
        paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, CHANGE));
        return { txRef: 'o', transactionHash: null };
      },
    });
    const done = await payPrivatelyFromCompanyVault({ ...b, builder: withRealOutputs(b.builder) }, order());
    /* RED WHEN: the page does not look the payment up by its change - it then raises not-yet-seen and records nothing. */
    expect(await t.notesNow(), 'RED WHEN: a payment with no hash from its send is not recorded under its creating transaction')
      .toEqual([{ ...CHANGE, createdIn: PAID_IN }]);
    /* RED WHEN: a payment found by what it left is reported as seen by its own transaction, or named by a transaction that
     * may be another payment's - the screen then says this person was paid. */
    expect(done.seenAs).toBe('by-what-it-left');
    expect(done.transactionHash).toBe('');
    expect(t.kept.size, 'RED WHEN: a recorded payment is left on its way').toBe(0);
    /* The next person on the run is paid out of the change. */
    const next = t.doors({
      payout: async () => {
        paymentEvents.set('d2'.repeat(32), await eventsOfAPayment('d2'.repeat(32), { ...CHANGE, nonce: 'c2'.repeat(32), value: 200n }));
        return { txRef: 'o2', transactionHash: 'd2'.repeat(32) };
      },
    }, [view({ heldByCommittee: true, started: true, notes: [heldChange] })]);
    next.builder.payout = async (i) => ({ tx: 'O2', spent: i.note.nonce, change: { nonce: 'c2'.repeat(32), token: i.note.token, value: '200' } });
    const paid = await payPrivatelyFromCompanyVault(next, second());
    expect(paid.spent, 'the run goes on, spending the change the first payment left').toBe(CHANGE.nonce);
    expect(await t.notesNow()).toEqual([{ nonce: 'c2'.repeat(32), token: TOKEN, value: 200n, createdIn: 'd2'.repeat(32) }]);
  });

  it('A PAYMENT WHOSE SEND WAS LOST IS KEPT ON ITS WAY; WHEN IT LANDS, THE NEXT PAYMENT RECORDS IT FIRST AND THE RUN FINISHES', async () => {
    const t = await setUp();
    const lost = t.doors({ payout: async () => { throw new Error('the connection dropped'); } });
    const e = await payPrivatelyFromCompanyVault({ ...lost, builder: withRealOutputs(lost.builder) }, order()).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(e.message).toMatch(/the connection dropped/);
    expect([...t.kept.values()].map((p) => p.change), 'RED WHEN: a payment that may have landed is not kept with its change')
      .toEqual([{ ...CHANGE, value: '300' }]);
    /* While the chain still holds the note it spent, no other payment is made from here. */
    const early = t.doors();
    await expect(payPrivatelyFromCompanyVault(early, second()), 'RED WHEN: a second payment is built while the record does not say which notes are left')
      .rejects.toBeInstanceOf(PaymentStillInFlight);
    /* It lands: the chain no longer holds the note, and holds the change. */
    paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, CHANGE));
    const next = t.doors(landsWhenSent({ ...CHANGE, nonce: 'c2'.repeat(32), value: 200n }), [view({ heldByCommittee: true, started: true, notes: [heldChange] })]);
    next.builder = withRealOutputs(next.builder);
    next.builder.payout = async (i) => ({ tx: 'O2', spent: i.note.nonce, change: { nonce: 'c2'.repeat(32), token: i.note.token, value: '200' } });
    const paid = await payPrivatelyFromCompanyVault(next, second());
    /* RED WHEN: the earlier payment is not settled first - the next one then refuses the vanished note until a rebuild. */
    expect(paid.spent).toBe(CHANGE.nonce);
    expect(t.log.some((l) => /^found /.test(l)), 'RED WHEN: the earlier payment is not found by its change').toBe(true);
    expect(await t.notesNow()).toEqual([{ nonce: 'c2'.repeat(32), token: TOKEN, value: 200n, createdIn: PAID_IN }]);
  });

  it('A PAYMENT OUT OF A VAULT PINNED TO ANOTHER ACCOUNT IS REFUSED BEFORE ANYTHING IS WRITTEN', async () => {
    const t = await setUp();
    const d = t.doors();
    const elsewhere = { ...d.builder, vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) => ({ ...(await d.builder.vaultOnChain(i)), account: 'dd'.repeat(32) }) as never };
    const e = await payPrivatelyFromCompanyVault({ ...d, builder: elsewhere }, order()).catch((x) => x);
    /* RED WHEN: a payment goes out of a vault pinned to an account other than the company's. */
    expect(e.message).toMatch(/^No payment can be made out of this vault yet.*not pinned to your company's account/);
    expect(t.log).toEqual([]);
    expect(await t.journal()).toEqual([]);
  });

  it('A PAYMENT, ITS WAIT AND ITS SETTLING READ THE VAULT ON THIS DEVICE, AND THE SERVICE IS NEVER ASKED WHAT THE VAULT HOLDS', async () => {
    const asked = { n: 0 };
    const t = await setUp();
    const gone = view({ heldByCommittee: true, started: true, notes: [] });
    const held = view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`] });
    const noHash = { payout: async () => ({ txRef: 'o', transactionHash: null }) };
    const lands = { payout: async () => { ownOnChain.set('O', { of: 'landed', transactionHash: PAID_IN }); return { txRef: 'o', transactionHash: null }; } };
    /* RED WHEN: the payment, or its wait for its own transaction, reads the vault through the service's chain route. */
    const done = await payPrivatelyFromCompanyVault(theServiceNeverAsked(t.doors(lands, [held, held, gone]), asked), order({}, { amount: '500' }));
    expect(done.change).toBeNull();
    const stays = await setUp();
    await expect(payPrivatelyFromCompanyVault(stays.doors(noHash, [held]), order({}, { amount: '500' }))).rejects.toBeInstanceOf(PaymentNotYetSeen);
    ownOnChain.set('O', { of: 'landed', transactionHash: PAID_IN });
    /* RED WHEN: settling on its own reads the vault through the service's chain route. */
    expect(await settlePaymentInFlight(theServiceNeverAsked(stays.doors({}, [gone]), asked), VAULT)).toEqual({ state: 'recorded', createdIn: null });
    expect(asked.n).toBe(0);
  });

  it('A PAYMENT THAT SPENT ITS NOTE EXACTLY, WITH NO HASH FROM ITS SEND, IS RECORDED ONCE ITS OWN TRANSACTION LANDS, AND NOT ON ITS NOTE LEAVING', async () => {
    const t = await setUp();
    const gone = view({ heldByCommittee: true, started: true, notes: [] });
    const held = view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`] });
    const b = t.doors({ payout: async () => { ownOnChain.set('O', { of: 'landed', transactionHash: PAID_IN }); return { txRef: 'o', transactionHash: null }; } }, [held, held, gone]);
    const done = await payPrivatelyFromCompanyVault(b, order({}, { amount: '500' }));
    /* RED WHEN: the note is not taken out once the chain shows this payment's own transaction. */
    expect(done.change).toBeNull();
    expect(await t.notesNow()).toEqual([]);
    expect(done.seenAs).toBe('its-own-transaction');
    /* Its note leaves and its own transaction is not seen: not recorded. */
    const left = await setUp();
    const b2 = left.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [held, gone]);
    /* RED WHEN: a payment that kept no change is recorded on its note leaving the vault. */
    await expect(payPrivatelyFromCompanyVault(b2, order({}, { amount: '500' }))).rejects.toBeInstanceOf(PaymentNotYetSeen);
    expect(await left.notesNow()).toEqual([NOTE]);
    const stays = await setUp();
    const s2 = stays.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [held]);
    await expect(payPrivatelyFromCompanyVault(s2, order({}, { amount: '500' }))).rejects.toBeInstanceOf(PaymentNotYetSeen);
    expect(await stays.notesNow(), 'RED WHEN: a note the chain still holds is taken out of the record').toEqual([NOTE]);
    expect(stays.kept.size, 'the payment is kept on its way').toBe(1);
    /* A view that did not read the vault is not a note that left it. */
    const unreadable = view({ onChain: false, heldByCommittee: true, started: true, notes: undefined });
    const blind = await setUp();
    const b3 = blind.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [held, unreadable]);
    /* RED WHEN: a view with no notes is read as the note having left - a note the chain holds is taken out of the record. */
    await expect(payPrivatelyFromCompanyVault(b3, order({}, { amount: '500' }))).rejects.toBeInstanceOf(PaymentNotYetSeen);
    expect(await blind.notesNow(), 'RED WHEN: an unreadable view takes the note out of the record').toEqual([NOTE]);
    await expect(settlePaymentInFlight(blind.doors({}, [unreadable]), VAULT), 'RED WHEN: settling reads an unreadable view as the note gone')
      .rejects.toBeInstanceOf(PaymentStillInFlight);
    expect(await blind.notesNow()).toEqual([NOTE]);
    /* The page was closed; it lands later, and the next look from this browser records it. */
    ownOnChain.set('O', { of: 'landed', transactionHash: PAID_IN });
    expect(await settlePaymentInFlight(stays.doors({}, [gone]), VAULT), 'RED WHEN: a payment with no change is never settled later')
      .toEqual({ state: 'recorded', createdIn: null });
    expect(await stays.notesNow()).toEqual([]);
    expect(stays.kept.size).toBe(0);
  });

  it('A PAYMENT THAT KEPT NO COIN, WHEN ANOTHER HOLDER\'S MERGE SPENT ITS NOTE FIRST: THE MERGE IS RECORDED, NOT THE PAYMENT, WHETHER IT IS SEEN WHILE WATCHING OR ON THE NEXT LOOK', async () => {
    /*
     * The payment spends the 500 exactly, so it keeps no coin, and its send names no transaction. Another holder of
     * the vault's secret merges the 500 and the 300 into one coin of 800 - written down before it is sent, as every step is - and
     * the merge lands first. The 500 leaves the chain, and not by this payment.
     */
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const MERGED_IN = 'e8'.repeat(32);
    const merged = { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n };
    const both = view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const afterMerge = view({ heldByCommittee: true, started: true, notes: [`h${merged.nonce.slice(1)}`] });
    const theirMergeLands = async (records: ReturnType<Awaited<ReturnType<typeof setUp>>['doors']>['records']) => {
      await new PaymentJournalInStore(records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
        .record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, further: [{ nonce: B.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
      paymentEvents.set(MERGED_IN, await eventsOfAPayment(MERGED_IN, merged));
    };

    /* Seen while this device watches for the payment. */
    const t = await setUp([NOTE, B], both.notes as string[]);
    const d = t.doors({ payout: async () => { await theirMergeLands(d.records); return { txRef: 'o', transactionHash: null }; } }, [both, both, afterMerge]);
    d.builder = withRealOutputs(d.builder);
    const e = await payPrivatelyFromCompanyVault(d, order({}, { amount: '500' })).catch((x) => x);
    /* RED WHEN: the merge that landed is not found while this payment's own transaction is unseen. */
    expect(e).toBeInstanceOf(StepOvertaken);
    /* RED WHEN: the overtaken payment is not something the leg plans again from - it would stop the leg instead of paying from what is left. */
    expect(e).toBeInstanceOf(NotesMovedUnderAStep);
    /* RED WHEN: the merge is recorded as this payment: the record then holds the 300, which the chain does not, and lacks the 800. */
    expect(await t.notesNow()).toEqual([{ ...merged, createdIn: MERGED_IN }]);
    expect(t.kept.size, 'RED WHEN: the payment that can never land is still kept on its way').toBe(0);

    /* The page stopped watching first, and the next look from this browser settles it. */
    const u = await setUp([NOTE, B], both.notes as string[]);
    const firstU = u.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [both]);
    firstU.builder = withRealOutputs(firstU.builder);
    await expect(payPrivatelyFromCompanyVault(firstU, order({}, { amount: '500' }))).rejects.toBeInstanceOf(PaymentNotYetSeen);
    await theirMergeLands(firstU.records);
    /* RED WHEN: settling a payment that kept no coin records it as landed without asking whether another step spent its note. */
    expect(await settlePaymentInFlight({ ...u.doors({}, [afterMerge]), builder: withRealOutputs(u.doors().builder) }, VAULT))
      .toEqual({ state: 'overtaken' });
    expect(await u.notesNow()).toEqual([{ ...merged, createdIn: MERGED_IN }]);
    expect(u.kept.size).toBe(0);
  });

  it('A PAYMENT THAT KEPT NO COIN AND SPENDS TWO NOTES IS NOT RECORDED WHILE THE CHAIN STILL HOLDS ITS SECOND, WATCHING OR ON THE NEXT LOOK', async () => {
    /*
     * 800 paid exactly from the 500 and the 300, the send naming no transaction. The 500 leaves the chain - spent by a
     * step this device's journal does not name - and the 300 is still there: a payment spends all its notes in one
     * transaction, so this one has not landed.
     */
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const both = view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const onlyB = view({ heldByCommittee: true, started: true, notes: [`h${B.nonce.slice(1)}`] });
    const t = await setUp([NOTE, B], both.notes as string[]);
    const d = t.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [both, both, onlyB]);
    const e = await payPrivatelyFromCompanyVault(d, order({}, { amount: '800' })).catch((x) => x);
    /* RED WHEN: the payment is taken as landed once its first note leaves, and the 300 the chain still holds leaves the record. */
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect((await t.notesNow()).map((n) => n.nonce)).toEqual([NOTE.nonce, B.nonce]);
    expect(t.kept.size).toBe(1);
    /* RED WHEN: settling on the next look records it on its first note alone. */
    await expect(settlePaymentInFlight(t.doors({}, [onlyB]), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    expect((await t.notesNow()).map((n) => n.nonce)).toEqual([NOTE.nonce, B.nonce]);
    /* Both gone, and its own transaction seen: it landed, and both leave the record. */
    ownOnChain.set('O', { of: 'landed', transactionHash: PAID_IN });
    expect(await settlePaymentInFlight(t.doors({}, [view({ heldByCommittee: true, started: true, notes: [] })]), VAULT))
      .toEqual({ state: 'recorded', createdIn: null });
    expect(await t.notesNow()).toEqual([]);
  });

  it('A PAYMENT THAT KEPT NO COIN AND A LANDED LINE THAT SPENT ITS NOTE ONLY BESIDE ANOTHER: IN FLIGHT INSIDE ITS WINDOW, THE LINE RECORDED ONCE THE PAYMENT IS UNSEEN PAST IT', async () => {
    /*
     * A merge of the 300 and the 500, the 300 first, and a coin of 800 made from the 300 on the chain. That coin names
     * the 300, and another step that began with the 300 may have made it, so it cannot say the 500 did not leave by
     * this payment while this payment can still land. Once its own transaction is unseen past its window, or refused,
     * it never landed, and the merge is what spent the 500.
     */
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const merged = { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n };
    const both = view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const afterMerge = view({ heldByCommittee: true, started: true, notes: [`h${merged.nonce.slice(1)}`] });
    const sentAndMerged = async () => {
      const t = await setUp([NOTE, B], both.notes as string[]);
      const first = t.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [both]);
      await expect(payPrivatelyFromCompanyVault(first, order({}, { amount: '500' }))).rejects.toBeInstanceOf(PaymentNotYetSeen);
      await new PaymentJournalInStore(first.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
        .record(VAULT, { spent: { nonce: B.nonce as never, token: TOKEN as never, value: 300n }, further: [{ nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
      paymentEvents.set('e8'.repeat(32), await eventsOfAPayment('e8'.repeat(32), merged));
      const at = (ms: number) => ({ ...t.doors({}, [afterMerge]), builder: withRealOutputs(t.doors().builder), now: () => new Date(NOW.getTime() + ms) });
      return { t, at };
    };
    const { t, at } = await sentAndMerged();
    /* RED WHEN: a line whose coin names another note is believed while this payment can still land. */
    await expect(settlePaymentInFlight(at(1), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    expect((await t.notesNow()).map((n) => n.nonce)).toEqual([NOTE.nonce, B.nonce]);
    /* RED WHEN: a payment unseen past its window is left on its way, or its note left in the record for a merge that landed. */
    expect(await settlePaymentInFlight(at(DEPOSIT_TIME_TO_LIVE_MS + 1), VAULT)).toEqual({ state: 'overtaken' });
    expect(await t.notesNow()).toEqual([{ ...merged, createdIn: 'e8'.repeat(32) }]);
    expect(t.kept.size).toBe(0);
    /* Refused inside its window: the same. */
    const r = await sentAndMerged();
    ownOnChain.set('O', { of: 'refused', transactionHash: 'af'.repeat(32) });
    expect(await settlePaymentInFlight(r.at(1), VAULT)).toEqual({ state: 'overtaken' });
    /* Its own transaction landed: it is recorded, and the line is not believed. */
    const l = await sentAndMerged();
    ownOnChain.set('O', { of: 'landed', transactionHash: PAID_IN });
    /* RED WHEN: a payment that paid reads as payable again because a line named its note beside another. */
    expect(await settlePaymentInFlight(l.at(DEPOSIT_TIME_TO_LIVE_MS + 1), VAULT)).toEqual({ state: 'recorded', createdIn: null });
  });

  it('A PAYMENT THAT KEPT NO COIN WHOSE NOTE A SPLIT NOBODY JOURNALLED TOOK: IN FLIGHT INSIDE ITS WINDOW, NOT PAID PAST IT, AND NEVER LET GO ON AN INDEXER ERROR', async () => {
    const t = await setUp();
    await payPrivatelyFromCompanyVault(t.doors({ payout: async () => { throw new Error('the connection dropped'); } }), order({}, { amount: '500' })).catch(() => undefined);
    const PIECE = `h${'0a'.repeat(32).slice(1)}`;
    const at = (ms: number, over: Partial<VaultBuilderClient> = {}) =>
      ({ ...t.doors({}, [view({ heldByCommittee: true, started: true, notes: [PIECE] })]), now: () => new Date(NOW.getTime() + ms), builder: { ...t.doors().builder, ...over } });
    /* RED WHEN: the note leaving by a split is taken as this payment landing. */
    await expect(settlePaymentInFlight(at(1), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    expect(await t.notesNow()).toEqual([NOTE]);
    /* RED WHEN: a look that failed is taken for a payment that never landed. */
    const down = { vaultCallOnChain: async () => { throw new Error('the indexer is down'); } };
    const held = await settlePaymentInFlight(at(DEPOSIT_TIME_TO_LIVE_MS + 1, down), VAULT).catch((x) => x);
    expect(held).toBeInstanceOf(PaymentStillInFlight);
    /* RED WHEN: a payment held because the chain could not be read promises that payments go ahead after a time already past. */
    expect(held.message).toMatch(/The chain could not be read just now\. This payment stays held, and no other payment leaves this vault from here, until it can be\./);
    expect(held.message).not.toMatch(/it never will/);
    expect(t.kept.size).toBe(1);
    /* RED WHEN: a payment unseen on a clean look past its window is still kept on its way, or recorded as paid. */
    expect(await settlePaymentInFlight(at(DEPOSIT_TIME_TO_LIVE_MS + 1), VAULT)).toEqual({ state: 'never-landed' });
    expect([await t.notesNow(), t.kept.size]).toEqual([[NOTE], 0]);
  });

  it('A PAYMENT THAT KEPT NO COIN, RECORDED WITHOUT ITS OWN TRANSACTION, IS NEVER RECORDED PAID ON ITS NOTE LEAVING: IN FLIGHT, THEN NOT MATCHED', async () => {
    const t = await setUp();
    t.kept.set(VAULT, {
      spent: { nonce: NOTE.nonce, token: TOKEN, value: '500' } as never, amount: '500', change: null, recordedAt: NOW.getTime(),
      txRef: 'o0', transactionHash: null, claim: 'earlier',
    } as never);
    const at = (ms: number) => ({ ...t.doors({}, [view({ heldByCommittee: true, started: true, notes: [] })]), now: () => new Date(NOW.getTime() + ms) });
    /* RED WHEN: a record that cannot name its own transaction is recorded as paid on its note leaving. */
    await expect(settlePaymentInFlight(at(1), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    expect(await settlePaymentInFlight(at(DEPOSIT_TIME_TO_LIVE_MS + 1), VAULT)).toEqual({ state: 'not-matched' });
    expect([await t.notesNow(), t.kept.size]).toEqual([[NOTE], 0]);
    /* An answer about its own transaction this cannot read: the same. */
    const u = await setUp();
    await payPrivatelyFromCompanyVault(u.doors({ payout: async () => { throw new Error('the connection dropped'); } }), order({}, { amount: '500' })).catch(() => undefined);
    ownOnChain.set('O', { of: 'not-known', why: 'the call runs in two parts and only one of them took effect' });
    const atU = (ms: number) => ({ ...u.doors({}, [view({ heldByCommittee: true, started: true, notes: [] })]), now: () => new Date(NOW.getTime() + ms) });
    await expect(settlePaymentInFlight(atU(1), VAULT)).rejects.toThrow(/only one of them took effect/);
    expect(await settlePaymentInFlight(atU(DEPOSIT_TIME_TO_LIVE_MS + 1), VAULT)).toEqual({ state: 'not-matched' });
    expect(await u.notesNow()).toEqual([NOTE]);
  });

  it('A PAYMENT THAT KEPT NO COIN IS KEPT ON ITS WAY UNTIL ITS OWN TIME TO LIVE AND THE MARGIN HAVE PASSED, WHEN THAT ENDS AFTER THE PAYMENT WINDOW', async () => {
    const t = await setUp();
    const ends = NOW.getTime() + DEPOSIT_TIME_TO_LIVE_MS + 10 * 60_000;
    const d = t.doors({ payout: async () => { throw new Error('the connection dropped'); } });
    d.builder = { ...d.builder, readTransaction: async (i) => ({ identifiers: [`${i.transaction} named`], timeToLive: ends, calls: [{ address: VAULT, entryPoint: 'payout', segments: [1] }] }) };
    await payPrivatelyFromCompanyVault(d, order({}, { amount: '500' })).catch(() => undefined);
    const at = (ms: number) => ({ ...t.doors({}, [view({ heldByCommittee: true, started: true, notes: [] })]), now: () => new Date(NOW.getTime() + ms) });
    /* RED WHEN: a payment whose own transaction can still land is let go as never landed. */
    await expect(settlePaymentInFlight(at(DEPOSIT_TIME_TO_LIVE_MS + 10 * 60_000 + DEPOSIT_CLOCKS_MAY_DIFFER_MS), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    expect(await settlePaymentInFlight(at(DEPOSIT_TIME_TO_LIVE_MS + 10 * 60_000 + DEPOSIT_CLOCKS_MAY_DIFFER_MS + 1), VAULT)).toEqual({ state: 'never-landed' });
  });

  it('A MERGE THAT LANDS UNDER A PAYMENT ON ITS WAY: THE PAYMENT FAILS CLEANLY AT ONCE, THE RECORD FOLLOWS THE CHAIN, AND THE PERSON IS PAID FROM WHAT IS LEFT', async () => {
    /*
     * The payment spends the 500 and its send drops. Before it lands, another holder of the vault's secret merges the
     * 500 and the 300 into one coin of 800 - no approval needed - and the merge lands. The payment can never land now.
     * RED WHEN: this browser waits out the payment's time to live before paying anyone again (a stall); the record keeps
     * the merged notes or lacks the merged coin (a record that disagrees with the chain); or the person is not paid
     * again from the merged coin.
     */
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const both = view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const t = await setUp([NOTE, B], both.notes as string[]);
    const first = t.doors({ payout: async () => { throw new Error('the connection dropped'); } }, [both]);
    first.builder = withRealOutputs(first.builder);
    await expect(payPrivatelyFromCompanyVault(first, order())).rejects.toBeInstanceOf(PaymentNotYetSeen);
    expect(t.kept.size, 'the payment is kept on its way').toBe(1);

    /* Another signer's device writes its merge down before its call, as every step out of the vault is, and it lands. */
    const MERGED_IN = 'e8'.repeat(32);
    const merged = { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n };
    await new PaymentJournalInStore(first.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, further: [{ nonce: B.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    paymentEvents.set(MERGED_IN, await eventsOfAPayment(MERGED_IN, merged));
    const afterMerge = view({ heldByCommittee: true, started: true, notes: [`h${merged.nonce.slice(1)}`] });

    /* Paying the person again, within the payment's time to live. */
    const again = t.doors(landsWhenSent({ nonce: 'cc'.repeat(32), token: TOKEN, value: 600n }), [afterMerge]);
    again.builder = withRealOutputs(again.builder);
    const paid = await payPrivatelyFromCompanyVault(again, order());
    expect(paid.spent, 'RED WHEN: the payment is not made again from the merged coin').toBe(merged.nonce);
    expect(t.kept.size, 'RED WHEN: the payment that can never land is still kept on its way').toBe(0);
    /* The record is the chain's: neither merged note, the merged coin spent, and the new change under its own payment. */
    expect(await t.notesNow()).toEqual([{ nonce: 'cc'.repeat(32), token: TOKEN, value: 600n, createdIn: PAID_IN }]);
  });

  it('THE WORKER NAMES A JOURNALLED STEP\'S COIN WITH THE VAULT\'S OWN FUNCTIONS: a merge\'s coin, a payment\'s change', async () => {
    const secret = '5a'.repeat(32);
    const n = (b: string, value: string) => ({ nonce: b.repeat(32), token: TOKEN, value });
    const ask = (step: Record<string, unknown>) => answerVaultAsk(async () => ({ vault: vaultModule }) as never,
      { id: 1, network: 'undeployed', ask: 'step-kept', vault: VAULT, secret, step } as never);
    const under = { circuits: nonceCircuitsFrom(vaultModule.pureCircuits as never), vault: VAULT as never, secret: secret as never };
    const coin = (c: ReturnType<typeof n>) => ({ nonce: c.nonce as never, token: c.token as never, value: BigInt(c.value) });
    const merge = await ask({ spent: n('11', '500'), further: [n('12', '300')], amount: '0', merge: true });
    /* RED WHEN: the worker names a merge's coin other than the vault's merged note - the overtaking step would never be seen. */
    expect(merge).toMatchObject({ ok: true, kept: { ...wireOfCoin(mergedNoteOf([coin(n('11', '500')), coin(n('12', '300'))], under)) } });
    const pay = await ask({ spent: n('11', '500'), further: [n('12', '300')], amount: '650' });
    expect(pay).toMatchObject({ ok: true, kept: { ...wireOfCoin(changeAfterSpending(coin(n('11', '500')), 800n, 650n, under)!) } });
    expect(await ask({ spent: n('11', '500'), amount: '500' })).toMatchObject({ ok: true, kept: null });
  });

  it('ANOTHER DEVICE\'S PAYMENT THAT LANDED FROM THE SAME NOTE OVERTAKES THIS ONE: RECORDED WITH ITS OWN AMOUNT, AND THIS ONE LET GO', async () => {
    /*
     * Another signer's device paid 150 out of the 500 and its change of 350 landed; its pool write has not happened.
     * RED WHEN: the overtaking payment is recorded as if it sent nothing out (the record refuses, and this browser stalls),
     * or this payment is kept on its way.
     */
    const t = await setUp();
    const first = t.doors({ payout: async () => { throw new Error('the connection dropped'); } });
    first.builder = withRealOutputs(first.builder);
    await expect(payPrivatelyFromCompanyVault(first, order())).rejects.toBeInstanceOf(PaymentNotYetSeen);
    await new PaymentJournalInStore(first.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, step: 'payment', amount: 150n, attemptedAt: 'o' });
    const theirs = { nonce: 'e6'.repeat(32), token: TOKEN, value: 350n };
    paymentEvents.set('e9'.repeat(32), await eventsOfAPayment('e9'.repeat(32), theirs));
    const after = view({ heldByCommittee: true, started: true, notes: [`h${theirs.nonce.slice(1)}`] });
    expect(await settlePaymentInFlight({ ...t.doors({}, [after]), builder: withRealOutputs(t.doors().builder) }, VAULT)).toEqual({ state: 'overtaken' });
    expect(t.kept.size).toBe(0);
    expect(await t.notesNow()).toEqual([{ ...theirs, createdIn: 'e9'.repeat(32) }]);
  });

  it('NO OTHER LINE OVERTAKES A PAYMENT WHOSE OWN CHANGE IS ON THE CHAIN, OR ONE NAMING NONE OF ITS NOTES, OR ITS OWN LINE', async () => {
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const both = view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const t = await setUp([NOTE, B], both.notes as string[]);
    const first = t.doors({ payout: async () => { throw new Error('the connection dropped'); } }, [both]);
    first.builder = withRealOutputs(first.builder);
    await expect(payPrivatelyFromCompanyVault(first, order())).rejects.toBeInstanceOf(PaymentNotYetSeen);
    const journal = new PaymentJournalInStore(first.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers);
    /* A merge of the 500 and the 300 whose coin is on the chain - and this payment's own change of 300 is too. */
    await journal.record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, further: [{ nonce: B.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    paymentEvents.set('e8'.repeat(32), await eventsOfAPayment('e8'.repeat(32), { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n }));
    paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, CHANGE));
    const landed = view({ heldByCommittee: true, started: true, notes: [`h${'e7'.repeat(32).slice(1)}`, `h${CHANGE.nonce.slice(1)}`] });
    /* RED WHEN: another step's coin is believed while this payment's own change shows it landed. */
    expect(await settlePaymentInFlight({ ...t.doors({}, [landed]), builder: withRealOutputs(t.doors().builder) }, VAULT))
      .toMatchObject({ state: 'recorded' });

    /* A landed merge of two notes this payment does not spend is no reason to let it go. */
    const u = await setUp([NOTE, B], both.notes as string[]);
    const firstU = u.doors({ payout: async () => { throw new Error('the connection dropped'); } }, [both]);
    firstU.builder = withRealOutputs(firstU.builder);
    await expect(payPrivatelyFromCompanyVault(firstU, order())).rejects.toBeInstanceOf(PaymentNotYetSeen);
    const C = { nonce: '05'.repeat(32), token: TOKEN, value: 300n };
    await new PaymentJournalInStore(firstU.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: B.nonce as never, token: TOKEN as never, value: 300n }, further: [{ nonce: C.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    paymentEvents.clear();
    paymentEvents.set('e8'.repeat(32), await eventsOfAPayment('e8'.repeat(32), { nonce: 'e7'.repeat(32), token: TOKEN, value: 600n }));
    const elsewhere = view({ heldByCommittee: true, started: true, notes: [`h${'e7'.repeat(32).slice(1)}`] });
    /* RED WHEN: a line naming none of this payment's notes is taken as having spent one of them. */
    await expect(settlePaymentInFlight({ ...u.doors({}, [elsewhere]), builder: withRealOutputs(u.doors().builder) }, VAULT))
      .rejects.toBeInstanceOf(PaymentStillInFlight);
    expect(u.kept.size).toBe(1);

    /*
     * A merge line naming this payment's note and one the chain still holds is not the step that landed, whatever coin
     * of its value is on the chain: a coin names its first note and its worth, not every note beside it.
     */
    const w = await setUp([NOTE, B], both.notes as string[]);
    const firstW = w.doors({ payout: async () => { throw new Error('the connection dropped'); } }, [both]);
    firstW.builder = withRealOutputs(firstW.builder);
    await expect(payPrivatelyFromCompanyVault(firstW, order())).rejects.toBeInstanceOf(PaymentNotYetSeen);
    await new PaymentJournalInStore(firstW.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, further: [{ nonce: B.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    paymentEvents.clear();
    paymentEvents.set('e8'.repeat(32), await eventsOfAPayment('e8'.repeat(32), { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n }));
    const stillB = view({ heldByCommittee: true, started: true, notes: [`h${'e7'.repeat(32).slice(1)}`, `h${B.nonce.slice(1)}`] });
    /* RED WHEN: a line one of whose notes the chain still holds is believed to have landed. */
    await expect(settlePaymentInFlight({ ...w.doors({}, [stillB]), builder: withRealOutputs(w.doors().builder) }, VAULT))
      .rejects.toBeInstanceOf(PaymentStillInFlight);
    expect((await w.notesNow()).map((n) => n.nonce)).toEqual([NOTE.nonce, B.nonce]);
  });

  it('A MERGE THE CHAIN DOES NOT HOLD YET OVERTAKES NOTHING: THE PAYMENT ON ITS WAY STILL HOLDS THE VAULT', async () => {
    /* RED WHEN: a merge only written down, never landed, is taken as having spent the payment's note. */
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const both = view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const t = await setUp([NOTE, B], both.notes as string[]);
    const first = t.doors({ payout: async () => { throw new Error('the connection dropped'); } }, [both]);
    await expect(payPrivatelyFromCompanyVault(first, order())).rejects.toBeInstanceOf(PaymentNotYetSeen);
    await new PaymentJournalInStore(first.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, further: [{ nonce: B.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    /*
     * Both notes the merge names have left the chain - by this payment or by something else - and the merged coin is
     * not there, though a transfer naming it can be read. A coin the chain does not hold is no proof that the merge
     * spent the note: with every note of the line gone, only the coin's absence stops it being believed.
     */
    paymentEvents.set('e8'.repeat(32), await eventsOfAPayment('e8'.repeat(32), { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n }));
    const gone = view({ heldByCommittee: true, started: true, notes: [] });
    const s = await settlePaymentInFlight({ ...t.doors({}, [gone]), builder: withRealOutputs(t.doors().builder) }, VAULT).catch((e) => e);
    expect(s).toBeInstanceOf(PaymentStillInFlight);
    expect(t.kept.size).toBe(1);
    /* RED WHEN: the record takes in a merged coin the chain does not hold. */
    expect((await t.notesNow()).map((n) => n.nonce)).toEqual([NOTE.nonce, B.nonce]);
  });

  it('A TWO-NOTE PAYMENT THAT LANDED WHILE THE PAGE WAS NOT WATCHING IS SETTLED WITH BOTH NOTES TAKEN OUT', async () => {
    const A = { nonce: '02'.repeat(32), token: TOKEN, value: 120n, createdIn: '0e'.repeat(32) };
    const B = { nonce: '03'.repeat(32), token: TOKEN, value: 100n, createdIn: '0f'.repeat(32) };
    const both = view({ heldByCommittee: true, started: true, notes: [`h${A.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const gone = view({ heldByCommittee: true, started: true, notes: [] });
    const t = await setUp([A, B], both.notes as string[]);
    /* Spent exactly, and the send names nothing and then drops: the payment is kept on its way. */
    await expect(payPrivatelyFromCompanyVault(t.doors({ payout: async () => { throw new Error('the connection dropped'); } }, [both]), order({}, { amount: '220' })))
      .rejects.toBeInstanceOf(PaymentNotYetSeen);
    expect([...t.kept.values()].map((p) => p.further)).toEqual([[{ nonce: B.nonce, token: TOKEN, value: '100' }]]);
    ownOnChain.set('O', { of: 'landed', transactionHash: PAID_IN });
    /* RED WHEN: settling records only the first note - the record would then be refused, or keep a nullified note. */
    expect(await settlePaymentInFlight(t.doors({}, [gone]), VAULT)).toEqual({ state: 'recorded', createdIn: null });
    expect(await t.notesNow()).toEqual([]);
  });

  it('A PAYMENT ON ITS WAY THAT CAN NO LONGER LAND IS LET GO; ONE WHOSE NOTE SOMETHING ELSE SPENT IS LET GO ONLY ONCE THE WHOLE HISTORY SAYS SO', async () => {
    const t = await setUp();
    const lost = t.doors({ payout: async () => { throw new Error('the connection dropped'); } });
    await payPrivatelyFromCompanyVault(lost, order()).catch(() => undefined);
    const later = (ms: number, views: TestView[], over: Partial<VaultService> & Partial<ChainBehind> = {}) =>
      ({ ...t.doors(over, views), builder: withRealOutputs(t.doors().builder), now: () => new Date(NOW.getTime() + ms) });
    const held = view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`] });
    const gone = view({ heldByCommittee: true, started: true, notes: [] });
    await expect(settlePaymentInFlight(later(DEPOSIT_TIME_TO_LIVE_MS - 1, [held]), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    /* RED WHEN: a payment whose note the chain still holds is forgotten before its time to live has passed, or never. */
    expect(await settlePaymentInFlight(later(DEPOSIT_TIME_TO_LIVE_MS + 1, [held]), VAULT)).toEqual({ state: 'never-landed' });
    expect(await t.notesNow()).toEqual([NOTE]);

    const u = await setUp();
    await payPrivatelyFromCompanyVault(u.doors({ payout: async () => { throw new Error('the connection dropped'); } }), order()).catch(() => undefined);
    const at = (ms: number, over: Partial<VaultService> & Partial<ChainBehind> = {}) =>
      ({ ...u.doors(over, [gone]), builder: withRealOutputs(u.doors().builder), now: () => new Date(NOW.getTime() + ms) });
    /* The note is gone and the change is nowhere: kept until its time to live has passed and the history was read in full. */
    await expect(settlePaymentInFlight(at(DEPOSIT_TIME_TO_LIVE_MS + 1, { createdBy: async () => { throw new Error('the indexer is down'); } }), VAULT),
      'RED WHEN: a payment is let go on a history that could not be read').rejects.toBeInstanceOf(PaymentStillInFlight);
    await expect(settlePaymentInFlight(at(1), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    /* The history lists no transaction for the change, and this device's own read of the chain holds it: not let go. */
    const real = withRealOutputs(u.doors().builder);
    const change = await real.commitments({ vault: VAULT, coin: wireOfCoin(CHANGE) });
    for (const shows of [
      view({ heldByCommittee: true, started: true, notes: [change.held] }),
      view({ heldByCommittee: true, started: true, notes: [], everCreated: [change.output] }),
    ]) {
      const d = { ...u.doors({ createdBy: async () => null }, [shows]), builder: real, now: () => new Date(NOW.getTime() + DEPOSIT_TIME_TO_LIVE_MS + 1) };
      /* RED WHEN: the service's listing of no transaction is believed over the change this device read on the chain - a paid person then reads as unpaid. */
      await expect(settlePaymentInFlight(d, VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    }
    expect(u.kept.size, 'the payment is still kept on its way').toBe(1);
    expect(await settlePaymentInFlight(at(DEPOSIT_TIME_TO_LIVE_MS + 1), VAULT)).toEqual({ state: 'spent-elsewhere' });
    expect(await u.notesNow(), 'RED WHEN: the record is changed for a payment that never landed').toEqual([NOTE]);
    expect(u.kept.size).toBe(0);
  });

  it('A PAYMENT WHOSE CHANGE THE CHAIN SHOWS AND THE VAULT WORKER WILL NOT NAME IS KEPT UNTIL ITS TIME TO LIVE, THEN LET GO AS NOT MATCHED', async () => {
    const t = await setUp();
    await payPrivatelyFromCompanyVault(t.doors({ payout: async () => { throw new Error('the connection dropped'); } }), order()).catch(() => undefined);
    paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, CHANGE));
    const gone = view({ heldByCommittee: true, started: true, notes: [heldChange] });
    const at = (ms: number) => {
      const d = t.doors({}, [gone]);
      return { ...d, builder: { ...withRealOutputs(d.builder), creatingTransaction: async () => ({ state: 'refused' as const }) }, now: () => new Date(NOW.getTime() + ms) };
    };
    await expect(settlePaymentInFlight(at(1), VAULT)).rejects.toBeInstanceOf(PaymentStillInFlight);
    /* RED WHEN: a change the worker will not name blocks every payment from this browser for ever. */
    expect(await settlePaymentInFlight(at(DEPOSIT_TIME_TO_LIVE_MS + 1), VAULT)).toEqual({ state: 'not-matched' });
    expect(await t.notesNow(), 'RED WHEN: a change nothing established is recorded').toEqual([NOTE]);
    expect(t.kept.size).toBe(0);
  });

  it('CHECK MY LAST DEPOSIT ALSO SETTLES A PAYMENT THIS BROWSER SENT, AND SAYS SO WITHOUT SAYING WHO WAS PAID', async () => {
    const t = await setUp();
    const lost = t.doors({ payout: async () => { throw new Error('the connection dropped'); } });
    await payPrivatelyFromCompanyVault({ ...lost, builder: withRealOutputs(lost.builder) }, order()).catch(() => undefined);
    paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, CHANGE));
    const d = t.doors({}, [view({ heldByCommittee: true, started: true, notes: [heldChange] })]);
    const found = await checkWhatThisBrowserSent({
      ...d, builder: withRealOutputs(d.builder), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory<DepositInFlight>(), payments: d.inFlight,
      pay: async () => { throw new Error('a check asks no wallet'); }, clock: () => NOW.getTime(),
    }, VAULT);
    /* RED WHEN: the check does not settle a payment on its way - the payment messages send people to it for nothing. */
    expect(found.payment).toEqual({ state: 'recorded', createdIn: PAID_IN });
    expect(await t.notesNow()).toEqual([{ ...CHANGE, createdIn: PAID_IN }]);
    expect(t.log.filter((l) => l === 'sent payout'), 'a check sends nothing').toHaveLength(0);
    expect(sayWhatTheCheckFound(found)).toMatch(/^This browser has no deposit .* Money from a payment this browser sent has left the vault, and the vault's record now shows it\. Open the run to see who was paid\.$/);
  });

  it('A PAYMENT HELD BECAUSE THE CHAIN COULD NOT BE READ NAMES NO TIME AFTER WHICH IT IS LET GO, HERE OR IN THE CHECK; ONE THE TIME SETTLES STILL NAMES IT', async () => {
    const unreadWords = /The chain could not be read just now\. This payment stays held, and no other payment leaves this vault from here, until it can be\./;
    const heldBy = async (p: Promise<unknown>): Promise<PaymentStillInFlight> => {
      const e = await p.catch((x) => x);
      expect(e).toBeInstanceOf(PaymentStillInFlight);
      return e as PaymentStillInFlight;
    };
    const gone = view({ heldByCommittee: true, started: true, notes: [] });
    const down = { createdBy: async () => { throw new Error('the indexer is down'); } };
    const t = await setUp();
    await payPrivatelyFromCompanyVault(t.doors({ payout: async () => { throw new Error('the connection dropped'); } }), order()).catch(() => undefined);
    const doors = (views: TestView[], over: Partial<ChainBehind> = {}) => ({ ...t.doors(over, views), builder: withRealOutputs(t.doors().builder) });

    /* The vault's notes could not be read. RED WHEN: that hold promises payments go ahead after a time. */
    const notes = await heldBy(settlePaymentInFlight(doors([view({ onChain: false, heldByCommittee: true, started: true, notes: undefined })]), VAULT));
    expect(notes.unread).toBe(true);
    expect(notes.message).toMatch(unreadWords);
    expect(notes.message).not.toMatch(/never will/);
    /* The transfer that made its change could not be read. RED WHEN: that hold promises payments go ahead after a time. */
    const change = await heldBy(settlePaymentInFlight(doors([gone], down), VAULT));
    expect([change.unread, unreadWords.test(change.message), /never will/.test(change.message)]).toEqual([true, true, false]);
    /* The history lists nothing for its change: the time settles it, and the words name the time. */
    const timed = await heldBy(settlePaymentInFlight(doors([gone]), VAULT));
    expect([timed.unread, /never will/.test(timed.message)], 'RED WHEN: a hold the time settles stops naming the time').toEqual([false, true]);

    /* The check carries why it is held, and its sentence follows. */
    const check = async (over: Partial<ChainBehind>) => {
      const d = doors([gone], over);
      return checkWhatThisBrowserSent({
        ...d, company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory<DepositInFlight>(), payments: d.inFlight,
        pay: async () => { throw new Error('a check asks no wallet'); }, clock: () => NOW.getTime(),
      }, VAULT);
    };
    const unread = await check(down);
    expect(unread.payment, 'RED WHEN: the check drops why the payment is held').toEqual({ state: 'still-on-its-way', until: expect.any(Number), unread: true });
    /* RED WHEN: the check tells a person a payment held on an unread chain will never land after a time. */
    expect(sayWhatTheCheckFound(unread)).toMatch(/The chain could not be read just now\. This payment stays held, and no other payment leaves this vault from this browser, until it can be\./);
    expect(sayWhatTheCheckFound(unread)).not.toMatch(/never will/);
    const settles = await check({});
    expect(settles.payment).toEqual({ state: 'still-on-its-way', until: expect.any(Number) });
    expect(sayWhatTheCheckFound(settles)).toMatch(/If the chain has not shown it by .*, it never will\./);
  });

  it('A PAYMENT THAT KEPT NO COIN, WHOSE NOTE A JOURNALLED MERGE SPENT, IS HELD WITHOUT A TIME WHILE THE TRANSFER THAT MADE THE MERGE\'S COIN CANNOT BE READ', async () => {
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const merged = { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n };
    const both = view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const afterMerge = view({ heldByCommittee: true, started: true, notes: [`h${merged.nonce.slice(1)}`] });
    const t = await setUp([NOTE, B], both.notes as string[]);
    await expect(payPrivatelyFromCompanyVault(t.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [both]), order({}, { amount: '500' })))
      .rejects.toBeInstanceOf(PaymentNotYetSeen);
    await new PaymentJournalInStore(t.doors().records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, further: [{ nonce: B.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    const d = { ...t.doors({ createdBy: async () => { throw new Error('the indexer is down'); } }, [afterMerge]), builder: withRealOutputs(t.doors().builder) };
    const e = await settlePaymentInFlight(d, VAULT).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentStillInFlight);
    /* RED WHEN: a hold waiting on a transfer that cannot be read promises payments go ahead after a time. */
    expect([e.unread, /could not be read just now/.test(e.message), /never will/.test(e.message)]).toEqual([true, true, false]);
  });

  it('TWO TABS: A SECOND PAYMENT STOPS BEFORE IT IS SENT WHILE ANOTHER TAB\'S IS BEING SENT', async () => {
    const t = await setUp();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const slow = t.doors({ payout: async () => { await held; throw Object.assign(new Error('refused. Nothing was sent.'), { nothingWasSent: true }); } });
    const first = payPrivatelyFromCompanyVault(slow, order()).catch((x) => x);
    await new Promise((r) => setTimeout(r, 5));
    /* The second tab read this browser's records before the first tab kept its payment, so it went on to build one. */
    const tabB = t.doors();
    const e = await payPrivatelyFromCompanyVault({ ...tabB, inFlight: { ...tabB.inFlight, get: async () => null } }, second()).catch((x) => x);
    /* RED WHEN: the payment's record is kept with a plain put - the second tab then replaces it and sends from the same note. */
    expect(e).toBeInstanceOf(PaymentStartedElsewhere);
    expect(t.log.filter((l) => l === 'sent payout')).toHaveLength(0);
    expect([...t.kept.values()].map((p) => p.amount), 'the first tab\'s record stands').toEqual(['200']);
    release();
    await first;
    expect(t.kept.size, 'the first tab forgets its own record once nothing was sent').toBe(0);
  });

  it('A NOTE ANOTHER WRITER ADDED WHILE THE PAYMENT PROVED IS KEPT: THE CHANGE IS APPLIED TO THE POOL AS IT STANDS', async () => {
    /* RED WHEN: the save is built on the copy loaded before the payment - it is then refused as a lost race five
     * times over, or, without the version check, the other writer's note is dropped. */
    const t = await setUp();
    const b = t.doors(landsWhenSent());
    const send = b.service.payout;
    b.service.payout = async (v, tx) => {
      const now = await t.pool().load(VAULT);
      await t.pool().save(VAULT, { notes: [...now.notes, { nonce: '02'.repeat(32), token: TOKEN, value: 9n }] }, now.readAt);
      return send(v, tx);
    };
    await payPrivatelyFromCompanyVault(b, order());
    expect((await t.notesNow()).map((n) => n.nonce).sort()).toEqual(['02'.repeat(32), 'cc'.repeat(32)]);
  });

  /* ---------------------------------------------------------------- a merge of the vault's own notes */
  const A = { nonce: '02'.repeat(32), token: TOKEN, value: 120n, createdIn: '0e'.repeat(32) };
  const B = { nonce: '03'.repeat(32), token: TOKEN, value: 100n, createdIn: '0f'.repeat(32) };
  const MERGED = { nonce: 'e7'.repeat(32), token: TOKEN, value: 220n };
  const MERGED_IN = 'dc'.repeat(32);
  const wireNote = (n: { nonce: string; token: string; value: bigint }) => ({ nonce: n.nonce, token: n.token, value: n.value.toString() });
  /** A merge's own events: its notes in, and one coin out, kept by the vault; nobody paid. */
  const eventsOfAMerge = async (hash: string, kept = MERGED, payingSomebody = false) => [
    { transactionHash: hash, details: { tag: 'zswapInput' } },
    ...(payingSomebody ? [{ transactionHash: hash, details: { tag: 'zswapOutput', commitment: 'f0'.repeat(32), mtIndex: '11' } }] : []),
    { transactionHash: hash, details: { tag: 'zswapOutput', commitment: await vaultNoteCommitment(kept as never, VAULT as never), contract: VAULT, mtIndex: '13' } },
  ];
  const mergeLandsWhenSent = (payingSomebody = false): Partial<VaultService> => ({
    merge: async () => { paymentEvents.set(MERGED_IN, await eventsOfAMerge(MERGED_IN, MERGED, payingSomebody)); return { txRef: 'm', transactionHash: MERGED_IN }; },
  });
  const twoNotes = () => setUp([B, A], [`h${A.nonce.slice(1)}`, `h${B.nonce.slice(1)}`]);

  it('A MERGE IS WRITTEN DOWN AS A MERGE ONCE IT IS BUILT AND BEFORE IT IS SENT, SPENDS EXACTLY THE NOTES NAMED, AND THE POOL KEEPS ONE NOTE WORTH THEM UNDER ITS OWN TRANSACTION', async () => {
    const t = await twoNotes();
    const b = t.doors(mergeLandsWhenSent());
    let journalledAtBuild = -1;
    let journalledWhenSent = -1;
    let keptWhileSending: PaymentInFlight | null = null;
    const build = b.builder.mergeNotes;
    b.builder.mergeNotes = async (i) => { journalledAtBuild = (await t.journal()).length; return build(i); };
    const send = b.service.merge;
    b.service.merge = async (v, tx) => { journalledWhenSent = (await t.journal()).length; keptWhileSending = await b.inFlight.get(v); return send(v, tx); };
    const done = await mergeNotesInCompanyVault(b, { vault: VAULT as never, notes: [wireNote(A), wireNote(B)] });
    /* RED WHEN: the journal line moves below the send or above the build, or the merge is not kept on this device before it is sent. */
    expect([journalledAtBuild, journalledWhenSent]).toEqual([0, 1]);
    expect(keptWhileSending).toMatchObject({ spent: { nonce: A.nonce }, further: [{ nonce: B.nonce }], amount: '0', change: { ...wireNote(MERGED) }, merge: true });
    /* RED WHEN: a note is chosen again rather than the ones named, any fact is read anywhere but here, or the pool is
     * advanced before the merge's own events are read. */
    expect(t.log).toEqual([
      'read events of 0e here', 'read events of 0f here', 'read the block here', 'build merge spending 02+03 with 1+1 event(s) at B1', 'read events of dc here',
    ]);
    expect(done).toEqual({ txRef: 'm', transactionHash: MERGED_IN, spent: [A.nonce, B.nonce], kept: wireNote(MERGED), seenAs: 'its-own-transaction' });
    /* RED WHEN: the merged note is recorded under anything but the merge's own transaction - the next payment could not read its place. */
    expect(await t.notesNow()).toEqual([{ ...MERGED, createdIn: MERGED_IN }]);
    const lines = await t.journal();
    expect(lines).toEqual([expect.objectContaining({
      spent: { nonce: A.nonce, token: TOKEN, value: 120n }, further: [{ nonce: B.nonce, token: TOKEN, value: 100n }], step: 'merge', amount: 0n,
    })]);
    /* RED WHEN: a merge that landed is left kept on this device, so every later step from this browser waits on it. */
    expect(t.kept.size).toBe(0);
  });

  it('A MERGE REFUSES NOTES THE RECORD DOES NOT HOLD AS NAMED, FEWER THAN TWO OR MORE THAN FOUR, ONE NAMED TWICE, OR TWO TOKENS: NOTHING IS WRITTEN, BUILT OR SENT', async () => {
    const OTHER = { nonce: '04'.repeat(32), token: 'cd'.repeat(32), value: 50n, createdIn: '0d'.repeat(32) };
    const t = await setUp([B, A, OTHER], [`h${A.nonce.slice(1)}`, `h${B.nonce.slice(1)}`, `h${OTHER.nonce.slice(1)}`]);
    const b = t.doors(mergeLandsWhenSent());
    for (const [why, notes, refusal] of [
      ['a note the record does not hold', [wireNote(A), wireNote({ ...B, nonce: '09'.repeat(32) })], /does not hold as named/],
      ['a note named at another value', [wireNote(A), wireNote({ ...B, value: 99n })], /does not hold as named/],
      ['one note', [wireNote(A)], /two to 4 notes/],
      ['five notes', [A, B, A, B, A].map(wireNote), /two to 4 notes/],
      ['one note twice', [wireNote(A), wireNote(A)], /names one note twice/],
      ['two tokens', [wireNote(A), wireNote(OTHER)], /notes of one token/],
    ] as const) {
      /* RED WHEN: any of these reaches the journal, the builder or the service. */
      await expect(mergeNotesInCompanyVault(b, { vault: VAULT as never, notes }), why).rejects.toThrow(refusal);
    }
    expect(t.log.filter((l) => l.startsWith('build') || l.startsWith('sent'))).toEqual([]);
    expect(await t.journal()).toEqual([]);
  });

  it('A MERGE WHOSE TRANSACTION PAYS SOMEBODY IS NOT A MERGE: NOTHING IS RECORDED FROM IT', async () => {
    const t = await twoNotes();
    const e = await mergeNotesInCompanyVault(t.doors(mergeLandsWhenSent(true)), { vault: VAULT as never, notes: [wireNote(A), wireNote(B)] }).catch((x) => x);
    /* RED WHEN: a transaction under the merge's name that pays a person is judged as the merge - money out read as money kept. */
    expect(e).toBeInstanceOf(MergeNotAsBuilt);
    expect((e as Error).message).toMatch(/pays somebody, and a merge pays nobody/);
    expect(await t.notesNow()).toEqual([B, A]);
  });

  it('A MERGE SENT WITHOUT A NAME, ON A PAGE THAT STOPPED WATCHING, IS RECORDED BY THE NEXT STEP ONCE ITS COIN IS ON THE CHAIN', async () => {
    const t = await twoNotes();
    const lost = t.doors({ merge: async () => { throw new Error('the connection dropped'); } });
    const e = await mergeNotesInCompanyVault(lost, { vault: VAULT as never, notes: [wireNote(A), wireNote(B)] }).catch((x) => x);
    /* RED WHEN: a merge that may have been sent is reported as one that was not, or worded as a person's payment. */
    expect(e).toBeInstanceOf(MergeNotYetSeen);
    expect((e as Error).message).not.toMatch(/pay this person/);
    expect(t.kept.size).toBe(1);
    /* It landed after all: its coin is on the chain, under its own transaction. */
    paymentEvents.set(MERGED_IN, await eventsOfAMerge(MERGED_IN));
    const real = withRealOutputs(t.doors().builder);
    const { held } = await real.commitments({ vault: VAULT, coin: wireNote(MERGED) });
    const shows = view({ heldByCommittee: true, started: true, notes: [held] });
    const d = { ...t.doors({}, [shows]), builder: { ...t.doors().builder, commitments: real.commitments } };
    /* RED WHEN: a merge kept on this device is not settled as one - its two notes stay in the record after the chain spent them. */
    expect(await settlePaymentInFlight(d, VAULT as never)).toEqual({ state: 'recorded', createdIn: MERGED_IN });
    expect(await t.notesNow()).toEqual([{ ...MERGED, createdIn: MERGED_IN }]);
  });

  it('A MERGE BUILT OVER OTHER NOTES THAN THE ONES NAMED IS NOT SENT', async () => {
    const t = await twoNotes();
    const b = t.doors(mergeLandsWhenSent());
    const build = b.builder.mergeNotes;
    for (const spent of [[B.nonce, A.nonce], [A.nonce, '09'.repeat(32)], [A.nonce]]) {
      b.builder.mergeNotes = async (i) => ({ ...(await build(i)), spent });
      /* RED WHEN: the page sends whatever the worker built, without checking it spends exactly the notes named, in order. */
      await expect(mergeNotesInCompanyVault(b, { vault: VAULT as never, notes: [wireNote(A), wireNote(B)] })).rejects.toThrow(/spends other notes than the ones named/);
    }
    expect(t.log.filter((l) => l.startsWith('sent'))).toEqual([]);
    expect(t.kept.size).toBe(0);
    /* RED WHEN: a line is written in the journal before the built merge is checked, so it names a merge never sent. */
    expect(await t.journal()).toEqual([]);
  });

  it('A MERGE THAT FAILS AFTER IT WAS SENT SAYS IT MAY HAVE LANDED, IN A MERGE\'S WORDS', async () => {
    const t = await twoNotes();
    const b = t.doors({ merge: async () => ({ txRef: 'm', transactionHash: null }) });
    const commitments = b.builder.commitments;
    let sent = false;
    b.service.merge = async () => { sent = true; return { txRef: 'm', transactionHash: null }; };
    b.builder.commitments = async (i) => { if (sent) throw new Error('the worker stopped'); return commitments(i); };
    const e = await mergeNotesInCompanyVault(b, { vault: VAULT as never, notes: [wireNote(A), wireNote(B)] }).catch((x) => x);
    /* RED WHEN: a failure after the send is reported with a payment's words, or as anything but a merge that may have landed. */
    expect(e).toBeInstanceOf(MergeNotYetSeen);
    expect((e as Error).message).toMatch(/the worker stopped/);
    expect((e as Error).message).not.toMatch(/pay this person/);
  });

  it('A PAYMENT GIVEN THE PLAN\'S NOTES SPENDS EXACTLY THOSE AND CHOOSES NONE, AND REFUSES ONE THE RECORD DOES NOT HOLD AS NAMED', async () => {
    const t = await twoNotes();
    const change = { nonce: 'cc'.repeat(32), token: TOKEN, value: 20n };
    /* B alone does not cover 200; the plan named A and B. RED WHEN: the payment chooses its notes again. */
    const done = await payPrivatelyFromCompanyVault(t.doors(landsWhenSent(change)), { ...order(), notes: [wireNote(A), wireNote(B)] });
    expect(done.spent).toBe(A.nonce);
    expect(t.log.includes('choose')).toBe(false);
    expect(t.log).toContain('build payout spending 02+03 with 1+1 event(s) at B1');
    const u = await twoNotes();
    await expect(payPrivatelyFromCompanyVault(u.doors(landsWhenSent(change)), { ...order(), notes: [wireNote({ ...A, value: 121n }), wireNote(B)] }))
      .rejects.toThrow(/does not hold as named/);
    expect(u.log.filter((l) => l.startsWith('build') || l === 'choose')).toEqual([]);
    expect(await u.journal()).toEqual([]);
  });
});
